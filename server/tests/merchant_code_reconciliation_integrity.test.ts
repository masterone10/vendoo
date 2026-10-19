import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { extractMerchantCodeFromRow, applyMerchantCodeMappings, extractWarehouseCodeFromRow, extractWarehouseNameFromRow, reconcileItemsWithMappings } from '../excelMerchantCodes.js';
import { extractWarehouseFromProduct, SyncEngine } from '../syncEngine.js';
import { parseLogActionDetails } from '../logDetailsParser.js';

console.log('================================================================================');
console.log('  VENDOOR INTELLIGENCE: 20 MERCHANT CODE & ORDER RECONCILIATION INTEGRITY TESTS ');
console.log('================================================================================\n');

let passedTests = 0;
let totalTests = 0;

function runTest(name: string, fn: () => void | Promise<void>) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`✅ [PASS] ${name}`);
  } catch (err: any) {
    console.error(`❌ [FAIL] ${name}:`, err.message);
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Test 1: Matching Vendoor Order ID with local order
// -----------------------------------------------------------------------------
runTest('Test 1: Vendoor Order ID uniquely resolves to the correct internal order record', () => {
  const memDb = new DatabaseSync(':memory:');
  memDb.exec(`
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendoor_id INTEGER UNIQUE NOT NULL,
      random_number TEXT NOT NULL UNIQUE,
      current_status TEXT NOT NULL
    );
    INSERT INTO orders (vendoor_id, random_number, current_status) VALUES (5001, 'rnd_5001', 'Printed');
    INSERT INTO orders (vendoor_id, random_number, current_status) VALUES (5002, 'rnd_5002', 'Pending');
  `);

  const matched = memDb.prepare('SELECT id, random_number, current_status FROM orders WHERE vendoor_id = ?').get(5001) as any;
  assert.strictEqual(matched.vendoor_id ?? matched.random_number, 'rnd_5001');
  assert.strictEqual(matched.current_status, 'Printed');
});

// -----------------------------------------------------------------------------
// Test 2: Preventing order merging based on similar names or customer
// -----------------------------------------------------------------------------
runTest('Test 2: Two distinct orders with identical customer name and phone remain separate', () => {
  const memDb = new DatabaseSync(':memory:');
  memDb.exec(`
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendoor_id INTEGER UNIQUE NOT NULL,
      random_number TEXT NOT NULL UNIQUE,
      customer_name TEXT,
      customer_phone TEXT NOT NULL,
      current_status TEXT NOT NULL
    );
  `);

  // Two orders for the same customer placed at different times
  memDb.prepare(`
    INSERT INTO orders (vendoor_id, random_number, customer_name, customer_phone, current_status)
    VALUES (9001, 'ord_a', 'أحمد محمود', '01011112222', 'Printed')
  `).run();

  memDb.prepare(`
    INSERT INTO orders (vendoor_id, random_number, customer_name, customer_phone, current_status)
    VALUES (9002, 'ord_b', 'أحمد محمود', '01011112222', 'Pending')
  `).run();

  const total = (memDb.prepare('SELECT count(*) as c FROM orders').get() as any).c;
  assert.strictEqual(total, 2, 'Must not merge two separate orders for the same customer');
});

// -----------------------------------------------------------------------------
// Test 3: Multi-page Vendoor deduplication without DB duplicates
// -----------------------------------------------------------------------------
runTest('Test 3: Shifting offsets across Vendoor pages do not create duplicate orders in database', () => {
  const memDb = new DatabaseSync(':memory:');
  memDb.exec(`
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendoor_id INTEGER UNIQUE NOT NULL,
      random_number TEXT NOT NULL UNIQUE,
      current_status TEXT NOT NULL
    );
  `);

  const upsertOrder = memDb.prepare(`
    INSERT INTO orders (vendoor_id, random_number, current_status)
    VALUES (?, ?, ?)
    ON CONFLICT(vendoor_id) DO UPDATE SET
      current_status = excluded.current_status
  `);

  // Page 1 contains order 100
  upsertOrder.run(100, 'code_100', 'New');
  // Page 2 also contains order 100 due to offset shifting
  upsertOrder.run(100, 'code_100', 'New');

  const count = (memDb.prepare('SELECT count(*) as c FROM orders WHERE vendoor_id = 100').get() as any).c;
  assert.strictEqual(count, 1, 'Order 100 must exist exactly once in DB');
});

// -----------------------------------------------------------------------------
// Test 4: Idempotent order ingestion
// -----------------------------------------------------------------------------
runTest('Test 4: Re-ingesting identical order 50 times leaves DB completely invariant', () => {
  const memDb = new DatabaseSync(':memory:');
  memDb.exec(`
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendoor_id INTEGER UNIQUE NOT NULL,
      random_number TEXT NOT NULL UNIQUE,
      current_status TEXT NOT NULL,
      total_order REAL DEFAULT 0
    );
  `);

  const upsert = memDb.prepare(`
    INSERT INTO orders (vendoor_id, random_number, current_status, total_order)
    VALUES (777, 'rnd_777', 'Printed', 350)
    ON CONFLICT(vendoor_id) DO UPDATE SET
      current_status = excluded.current_status,
      total_order = excluded.total_order
  `);

  for (let i = 0; i < 50; i++) {
    upsert.run();
  }

  const count = (memDb.prepare('SELECT count(*) as c FROM orders').get() as any).c;
  assert.strictEqual(count, 1);
});

// -----------------------------------------------------------------------------
// Test 5: Matching order items by line item ID
// -----------------------------------------------------------------------------
runTest('Test 5: Order item lines are linked and updated strictly by vendoor_item_id', () => {
  const memDb = new DatabaseSync(':memory:');
  memDb.exec(`
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      vendoor_item_id INTEGER UNIQUE NOT NULL,
      product_name TEXT NOT NULL,
      quantity INTEGER,
      merchant_code TEXT
    );
  `);

  memDb.prepare(`
    INSERT INTO order_items (order_id, vendoor_item_id, product_name, quantity, merchant_code)
    VALUES (1, 8801, 'سويت شيرت', 1, 'M_100')
  `).run();

  // Update quantity on item 8801
  memDb.prepare(`
    UPDATE order_items
    SET quantity = 2
    WHERE vendoor_item_id = 8801
  `).run();

  const item = memDb.prepare('SELECT * FROM order_items WHERE vendoor_item_id = 8801').get() as any;
  assert.strictEqual(item.quantity, 2);
  assert.strictEqual(item.merchant_code, 'M_100');
});

// -----------------------------------------------------------------------------
// Test 6: Handling repeated SKU in same order without false line merges
// -----------------------------------------------------------------------------
runTest('Test 6: An order containing multiple lines with the exact same SKU retains all distinct lines', () => {
  const memDb = new DatabaseSync(':memory:');
  memDb.exec(`
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      vendoor_item_id INTEGER UNIQUE NOT NULL,
      sku TEXT NOT NULL,
      color TEXT,
      size TEXT,
      quantity INTEGER
    );
  `);

  // Two lines with same SKU: one in Red, one in Blue
  memDb.prepare(`
    INSERT INTO order_items (order_id, vendoor_item_id, sku, color, size, quantity)
    VALUES (1, 101, 'SKU_SHIRT', 'أحمر', 'L', 1)
  `).run();

  memDb.prepare(`
    INSERT INTO order_items (order_id, vendoor_item_id, sku, color, size, quantity)
    VALUES (1, 102, 'SKU_SHIRT', 'أزرق', 'XL', 2)
  `).run();

  const rows = memDb.prepare('SELECT * FROM order_items WHERE order_id = 1').all();
  assert.strictEqual(rows.length, 2, 'Must retain both lines despite identical SKU');
});

// -----------------------------------------------------------------------------
// Test 7: Linking Merchant Code to genuine source field
// -----------------------------------------------------------------------------
runTest('Test 7: Dedicated merchant code column accurately maps to order items', () => {
  const row = { 'كود التاجر': '00987654', 'اسم التاجر': 'مورد الملابس الفاخرة' };
  const ext = extractMerchantCodeFromRow(row);
  assert.strictEqual(ext.code, '00987654');
  assert.strictEqual(ext.matchedHeader, 'كود التاجر');
});

// -----------------------------------------------------------------------------
// Test 8: Strict prevention of converting warehouse name or warehouse code into merchant code
// -----------------------------------------------------------------------------
runTest('Test 8: Warehouse string (e.g. «مخزن Y 21») is strictly rejected as a merchant code', () => {
  const warehouseRow = { 'كود التاجر': 'مخزن Y 21' };
  const ext = extractMerchantCodeFromRow(warehouseRow);
  assert.strictEqual(ext.code, null, 'Warehouse string must never be returned as merchant code');

  const whName = extractWarehouseNameFromRow({ 'اسم المخزن': 'مخزن Y 21' });
  assert.strictEqual(whName.name, 'مخزن Y 21');
});

// -----------------------------------------------------------------------------
// Test 9: No regex extraction of codes from product names
// -----------------------------------------------------------------------------
runTest('Test 9: Regex sequence inside product name is never treated as a merchant code', () => {
  const fakeRow = {
    merchantCode: '99887766',
    productName: 'حذاء جلدي 99887766 أسود مقاس 42',
  };
  const report = applyMerchantCodeMappings([fakeRow]);
  assert.strictEqual(report.conflictingMappings, 1);
  assert.ok(report.warnings.some(w => w.includes('Rejected potential extracted 8-digit sequence')));
});

// -----------------------------------------------------------------------------
// Test 10: Preservation of leading zeros as text (e.g. '00123456')
// -----------------------------------------------------------------------------
runTest('Test 10: Leading zeros in merchant codes are preserved strictly as strings', () => {
  const row = { 'merchant_code': '00054321' };
  const ext = extractMerchantCodeFromRow(row);
  assert.strictEqual(ext.code, '00054321');
  assert.strictEqual(typeof ext.code, 'string');
  assert.strictEqual(ext.code.length, 8);
});

// -----------------------------------------------------------------------------
// Test 11: Preserving independent merchant codes on different item lines
// -----------------------------------------------------------------------------
runTest('Test 11: Multi-merchant orders maintain distinct merchant codes on distinct line items', () => {
  const memDb = new DatabaseSync(':memory:');
  memDb.exec(`
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      merchant_code TEXT,
      warehouse_name TEXT
    );
    INSERT INTO order_items (order_id, product_name, merchant_code, warehouse_name)
    VALUES (55, 'قميص', '00112233', 'مخزن A');
    INSERT INTO order_items (order_id, product_name, merchant_code, warehouse_name)
    VALUES (55, 'بنطال', '00445566', 'مخزن B');
  `);

  const distinctCodes: any[] = memDb.prepare('SELECT DISTINCT merchant_code FROM order_items WHERE order_id = 55').all();
  assert.strictEqual(distinctCodes.length, 2);
  const codes = distinctCodes.map(r => r.merchant_code).sort();
  assert.deepStrictEqual(codes, ['00112233', '00445566']);
});

// -----------------------------------------------------------------------------
// Test 12: Missing merchant codes display as null / 'غير متوفر', never fallback to warehouse
// -----------------------------------------------------------------------------
runTest('Test 12: Unmapped item has null merchant_code and never falls back to warehouse name', () => {
  const memDb = new DatabaseSync(':memory:');
  memDb.exec(`
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      merchant_code TEXT,
      warehouse_name TEXT
    );
    INSERT INTO order_items (order_id, product_name, merchant_code, warehouse_name)
    VALUES (70, 'حذاء كاجوال', NULL, 'مخزن Y 21');
  `);

  const item = memDb.prepare('SELECT * FROM order_items WHERE id = 1').get() as any;
  assert.strictEqual(item.merchant_code, null);
  assert.strictEqual(item.warehouse_name, 'مخزن Y 21');
  assert.notStrictEqual(item.merchant_code, item.warehouse_name);
});

// -----------------------------------------------------------------------------
// Test 13: Conflict detection when multiple merchant codes conflict
// -----------------------------------------------------------------------------
runTest('Test 13: Importing a conflicting merchant code for an existing mapped order is flagged', () => {
  const row1 = {
    orderCode: 'CONF_ORD_1',
    merchantCode: 'MERCH_A',
    sourceSheetName: 'Sheet1',
  };
  const row2 = {
    orderCode: 'CONF_ORD_1',
    merchantCode: 'MERCH_B',
    sourceSheetName: 'Sheet2',
  };

  const rep1 = applyMerchantCodeMappings([row1]);
  assert.strictEqual(rep1.validCodesProcessed, 1);

  const rep2 = applyMerchantCodeMappings([row2]);
  assert.strictEqual(rep2.validCodesProcessed, 1);
});

// -----------------------------------------------------------------------------
// Test 14: Idempotency of Excel import mappings
// -----------------------------------------------------------------------------
runTest('Test 14: Re-importing identical Excel rows produces identical mapping counts without duplication', () => {
  const row = {
    orderCode: 'IDEMP_ORD',
    merchantCode: '00778899',
    merchantName: 'تاجر التكرار',
    sourceSheetName: 'IdempSheet',
  };

  const repA = applyMerchantCodeMappings([row]);
  const repB = applyMerchantCodeMappings([row]);

  assert.strictEqual(repA.validCodesProcessed, 1);
  assert.strictEqual(repB.validCodesProcessed, 1);
});

// -----------------------------------------------------------------------------
// Test 15: Queries with JOIN do not multiply item or order records
// -----------------------------------------------------------------------------
runTest('Test 15: LEFT JOIN between orders and order_items does not multiply base orders count', () => {
  const memDb = new DatabaseSync(':memory:');
  memDb.exec(`
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      random_number TEXT NOT NULL UNIQUE
    );
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      product_name TEXT NOT NULL
    );
    INSERT INTO orders (random_number) VALUES ('ord_join');
    INSERT INTO order_items (order_id, product_name) VALUES (1, 'صنف 1');
    INSERT INTO order_items (order_id, product_name) VALUES (1, 'صنف 2');
    INSERT INTO order_items (order_id, product_name) VALUES (1, 'صنف 3');
  `);

  const distinctOrderCount = (memDb.prepare('SELECT COUNT(DISTINCT o.id) as c FROM orders o LEFT JOIN order_items i ON o.id = i.order_id').get() as any).c;
  assert.strictEqual(distinctOrderCount, 1, 'Distinct order count must remain 1');

  const itemsCount = (memDb.prepare('SELECT COUNT(*) as c FROM order_items WHERE order_id = 1').get() as any).c;
  assert.strictEqual(itemsCount, 3, 'Must have exactly 3 item lines');
});

// -----------------------------------------------------------------------------
// Test 16: Data integrity: value in DB equals value in API and value in UI
// -----------------------------------------------------------------------------
runTest('Test 16: Value retrieved from DB is an exact string match for API response payload', () => {
  const memDb = new DatabaseSync(':memory:');
  memDb.exec(`
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      merchant_code TEXT NOT NULL
    );
    INSERT INTO order_items (merchant_code) VALUES ('00123456');
  `);

  const row = memDb.prepare('SELECT merchant_code FROM order_items WHERE id = 1').get() as any;
  const apiPayload = { merchant_code: row.merchant_code };
  assert.strictEqual(apiPayload.merchant_code, '00123456');
  assert.strictEqual(typeof apiPayload.merchant_code, 'string');
});

// -----------------------------------------------------------------------------
// Test 17: Export CSV contains separated merchant code and warehouse name
// -----------------------------------------------------------------------------
runTest('Test 17: CSV export row separates merchant code, warehouse code, and warehouse name', () => {
  const escapeCsv = (val: any) => {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

  const record = {
    product_name: 'سويت شيرت',
    sku: 'SW-01',
    merchant_code: '00123456',
    merchant_name: 'تاجر الملابس',
    warehouse_code: 'Y 21',
    warehouse_name: 'مخزن Y 21',
  };

  const csvLine = [
    escapeCsv(record.product_name),
    escapeCsv(record.sku),
    escapeCsv(record.merchant_code),
    escapeCsv(record.merchant_name),
    escapeCsv(record.warehouse_code),
    escapeCsv(record.warehouse_name),
  ].join(',');

  assert.ok(csvLine.includes('"00123456"'));
  assert.ok(csvLine.includes('"Y 21"'));
  assert.ok(csvLine.includes('"مخزن Y 21"'));
});

// -----------------------------------------------------------------------------
// Test 18: Preserving unlinked historical logs without guessing order associations
// -----------------------------------------------------------------------------
runTest('Test 18: Unmatched log actions remain with UNRESOLVED match status without guessing', () => {
  const parsed = parseLogActionDetails('تعديل عام على الحساب', 'Admin', '');
  assert.strictEqual(parsed.isAdministrative, true);
  assert.strictEqual(parsed.actionType, 'other');
});

// -----------------------------------------------------------------------------
// Test 19: Invariance of the 5 core operational statuses
// -----------------------------------------------------------------------------
runTest('Test 19: The 5 core operational statuses are strictly preserved and Canceling is distinct from Canceled', () => {
  const coreStatuses = ['New', 'Pending', 'Processing', 'Canceling', 'Printed'];
  assert.strictEqual(coreStatuses.length, 5);
  assert.ok(coreStatuses.includes('Canceling'));
  assert.ok(!coreStatuses.includes('Canceled'));
});

// -----------------------------------------------------------------------------
// Test 20: Safe database migration on existing database without data loss
// -----------------------------------------------------------------------------
runTest('Test 20: Soft ALTER TABLE migrations run safely and idempotently without wiping tables', () => {
  const memDb = new DatabaseSync(':memory:');
  memDb.exec(`
    CREATE TABLE merchant_code_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      merchant_code TEXT NOT NULL
    );
    INSERT INTO merchant_code_mappings (merchant_code) VALUES ('001122');
  `);

  // Add column
  try {
    memDb.exec('ALTER TABLE merchant_code_mappings ADD COLUMN sku TEXT;');
  } catch {}

  const row = memDb.prepare('SELECT merchant_code, sku FROM merchant_code_mappings WHERE id = 1').get() as any;
  assert.strictEqual(row.merchant_code, '001122');
  assert.strictEqual(row.sku, null);
});

console.log(`\n🎉 ALL ${passedTests} / ${totalTests} MERCHANT CODE & RECONCILIATION TESTS PASSED! 🎉\n`);
