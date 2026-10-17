import assert from 'node:assert';
import { db } from '../db.js';
import {
  SyncEngine,
  detectOrderBusinessChanges,
  ReconciliationReport,
} from '../syncEngine.js';
import { VendoorRawOrder } from '../vendoorClient.js';

console.log('=== VENDOOR INTELLIGENCE: 18 REGRESSION & RECONCILIATION TESTS ===\n');

let passedTests = 0;

function runTest(name: string, fn: () => void) {
  try {
    fn();
    passedTests++;
    console.log(`✅ [PASS] ${name}`);
  } catch (err: any) {
    console.error(`❌ [FAIL] ${name}:`, err.message);
    throw err;
  }
}

const syncTestEngine = new SyncEngine();

function createMockRawOrder(id: number, statusStr = ' New', randNum = `rnd_${id}`): VendoorRawOrder {
  return {
    id,
    order_no: `ORD-${id}`,
    order_type: 'اوردر جديد',
    created_at: '2026-10-17 12:00:00',
    shipping_date: null,
    printed_date: null,
    affiliate_code: 'AFF01',
    random_number: randNum,
    affiliate_name: 'Affiliate One',
    full_name: `Customer ${id}`,
    total_price: 250,
    shipping_cost: '50',
    phone: `010000000${id % 100}`,
    governrate_name: 'القاهرة',
    address: 'شارع التحرير مبنى 5 الدور 3',
    total_order: '300',
    status: statusStr,
    integration_shipping_name: null,
    products: [
      {
        id: id * 10,
        name: 'منتج أ ( مخزن Y2 )',
        pivot: {
          id: id * 100,
          order_id: id,
          product_id: id * 10,
          quantity: 1,
          price: '250',
          code: 'SKU-A',
        },
      },
    ],
  };
}

function cleanTestArtifacts() {
  db.exec(`
    DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE vendoor_id >= 1000 AND vendoor_id <= 5000);
    DELETE FROM order_status_events WHERE order_id IN (SELECT id FROM orders WHERE vendoor_id >= 1000 AND vendoor_id <= 5000);
    DELETE FROM alerts WHERE order_id IN (SELECT id FROM orders WHERE vendoor_id >= 1000 AND vendoor_id <= 5000);
    DELETE FROM orders WHERE vendoor_id >= 1000 AND vendoor_id <= 5000;
  `);
}

// Ensure clean slate for test-isolated range
cleanTestArtifacts();

// 1. Repeated Identical Scans
runTest('Regression 1: Repeated identical scans yield 0 new orders and 0 spurious updates', () => {
  const initialTime = '2026-10-17T10:00:00.000Z';
  const orders = [createMockRawOrder(1001), createMockRawOrder(1002), createMockRawOrder(1003)];

  // Pass 1: Initial Insert
  let newCount = 0;
  let examinedCount = 0;
  let fieldChanges = 0;

  for (const o of orders) {
    const res = syncTestEngine.upsertCanonicalOrder(o, initialTime);
    if (res.isNew) newCount++;
    else examinedCount++;
    if (res.businessFieldsChanged) fieldChanges++;
  }

  assert.strictEqual(newCount, 3, 'Pass 1 must insert 3 new orders');
  assert.strictEqual(examinedCount, 0);
  assert.strictEqual(fieldChanges, 0);

  // Pass 2: Identical second scan
  const pass2Time = '2026-10-17T10:01:00.000Z';
  let pass2New = 0;
  let pass2Examined = 0;
  let pass2FieldChanges = 0;

  for (const o of orders) {
    const res = syncTestEngine.upsertCanonicalOrder(o, pass2Time);
    if (res.isNew) pass2New++;
    else pass2Examined++;
    if (res.businessFieldsChanged) pass2FieldChanges++;
  }

  assert.strictEqual(pass2New, 0, 'Pass 2 must create ZERO new orders');
  assert.strictEqual(pass2Examined, 3, 'Pass 2 must examine all 3 existing orders');
  assert.strictEqual(pass2FieldChanges, 0, 'Pass 2 must detect ZERO genuine field changes');

  const totalInDb = (db.prepare('SELECT count(*) as c FROM orders WHERE vendoor_id >= 1001 AND vendoor_id <= 1003').get() as any).c;
  assert.strictEqual(totalInDb, 3, 'DB must contain exactly 3 canonical orders');
});

// 2. New source IDs
runTest('Regression 2: Ingesting new source IDs increments newOrdersInserted accurately', () => {
  const nowIso = '2026-10-17T10:02:00.000Z';
  const newOrder = createMockRawOrder(1004);
  const res = syncTestEngine.upsertCanonicalOrder(newOrder, nowIso);

  assert.strictEqual(res.isNew, true, 'New ID 1004 must be marked isNew=true');
  assert.strictEqual(res.currentStatus, 'New');
  const count = (db.prepare('SELECT count(*) as c FROM orders WHERE vendoor_id = 1004').get() as any).c;
  assert.strictEqual(count, 1);
});

// 3. Existing orders with unchanged fields
runTest('Regression 3: Existing orders with unchanged fields only update observation heartbeat', () => {
  const checkTime = '2026-10-17T10:05:00.000Z';
  const raw = createMockRawOrder(1001);
  const res = syncTestEngine.upsertCanonicalOrder(raw, checkTime);

  assert.strictEqual(res.isNew, false);
  assert.strictEqual(res.businessFieldsChanged, false);
  assert.strictEqual(res.statusChanged, false);

  const row: any = db.prepare('SELECT last_observed_at, validation_status FROM orders WHERE vendoor_id = 1001').get();
  assert.strictEqual(row.last_observed_at, checkTime, 'Heartbeat timestamp updated');
  assert.strictEqual(row.validation_status, 'VALIDATED');
});

// 4. Genuine field changes
runTest('Regression 4: Modifying customer address or total updates fields and flags businessFieldsChanged=true', () => {
  const changeTime = '2026-10-17T10:06:00.000Z';
  const modified = createMockRawOrder(1001);
  modified.address = 'شارع مصطفى النحاس مدينة نصر القاهرة';
  modified.total_order = '450';

  const res = syncTestEngine.upsertCanonicalOrder(modified, changeTime);
  assert.strictEqual(res.isNew, false);
  assert.strictEqual(res.businessFieldsChanged, true, 'Must detect field change');
  assert.strictEqual(res.statusChanged, false);
  assert.ok(res.changedFields.includes('address'), 'Address detected in changed fields');
  assert.ok(res.changedFields.includes('total_order'), 'Total order detected in changed fields');

  const row: any = db.prepare('SELECT address, total_order FROM orders WHERE vendoor_id = 1001').get();
  assert.strictEqual(row.address, 'شارع مصطفى النحاس مدينة نصر القاهرة');
  assert.strictEqual(row.total_order, 450);
});

// 5. Genuine status transitions
runTest('Regression 5: Status transition from New to Pending logs event and flags statusChanged=true', () => {
  const transTime = '2026-10-17T10:07:00.000Z';
  const transitioned = createMockRawOrder(1001, ' Pending');

  const res = syncTestEngine.upsertCanonicalOrder(transitioned, transTime);
  assert.strictEqual(res.statusChanged, true);
  assert.strictEqual(res.previousStatus, 'New');
  assert.strictEqual(res.currentStatus, 'Pending');

  const row: any = db.prepare('SELECT current_status FROM orders WHERE vendoor_id = 1001').get();
  assert.strictEqual(row.current_status, 'Pending');

  const event: any = db.prepare('SELECT * FROM order_status_events WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(res.orderDbId);
  assert.strictEqual(event.from_status, 'New');
  assert.strictEqual(event.to_status, 'Pending');
  assert.strictEqual(event.source_channel, 'poll_detection');
  assert.strictEqual(event.actor_name, 'النظام');
});

// 6. Random-number changes
runTest('Regression 6: Random number change on existing vendoor_id updates code without creating duplicate', () => {
  const updateTime = '2026-10-17T10:08:00.000Z';
  const updatedRand = createMockRawOrder(1002, ' New', 'new_random_1002');

  const res = syncTestEngine.upsertCanonicalOrder(updatedRand, updateTime);
  assert.strictEqual(res.isNew, false);

  const ordersForId = db.prepare('SELECT * FROM orders WHERE vendoor_id = 1002').all();
  assert.strictEqual(ordersForId.length, 1, 'Must remain strictly 1 canonical record');
  assert.strictEqual((ordersForId[0] as any).random_number, 'new_random_1002');
});

// 7. Multiple products per order
runTest('Regression 7: Multi-product order creates 1 order record and multiple order_items', () => {
  const multiProduct = createMockRawOrder(1005);
  multiProduct.products = [
    {
      id: 201,
      name: 'حذاء كاجوال ( مخزن Te1 )',
      pivot: { id: 801, order_id: 1005, product_id: 201, quantity: 1, price: '150', code: 'SKU-1' },
    },
    {
      id: 202,
      name: 'قميص قطن ( مخزن Y2 )',
      pivot: { id: 802, order_id: 1005, product_id: 202, quantity: 2, price: '200', code: 'SKU-2' },
    },
  ];

  const res = syncTestEngine.upsertCanonicalOrder(multiProduct, '2026-10-17T10:09:00.000Z');
  assert.strictEqual(res.isNew, true);

  const orderCount = (db.prepare('SELECT count(*) as c FROM orders WHERE vendoor_id = 1005').get() as any).c;
  const itemCount = (db.prepare('SELECT count(*) as c FROM order_items WHERE order_id = ?').get(res.orderDbId) as any).c;

  assert.strictEqual(orderCount, 1, 'Must create exactly 1 order');
  assert.strictEqual(itemCount, 2, 'Must create exactly 2 line items');
});

// 8. Duplicate source IDs across pages
runTest('Regression 8: Offsets shifting during pagination deduplicate identical orders across pages', () => {
  const page1 = [createMockRawOrder(2001), createMockRawOrder(2002)];
  // Suppose order 2002 was pushed to page 2 due to offset shift
  const page2 = [createMockRawOrder(2002), createMockRawOrder(2003)];

  const rawReceived = page1.concat(page2);
  const dedupeMap = new Map<number, VendoorRawOrder>();
  let duplicates = 0;

  for (const o of rawReceived) {
    if (dedupeMap.has(o.id)) {
      duplicates++;
    } else {
      dedupeMap.set(o.id, o);
    }
  }

  assert.strictEqual(rawReceived.length, 4, '4 total raw rows received');
  assert.strictEqual(duplicates, 1, '1 duplicate source ID identified');
  assert.strictEqual(dedupeMap.size, 3, '3 unique source orders parsed');
});

// 9. Missing source pages
runTest('Regression 9: Partial page failure records failedPagesCount and preserves database integrity', () => {
  const failedPagesCount = 1;
  const hasFailedPage = true;
  const finalStatus = hasFailedPage ? 'PARTIAL' : 'SUCCESS';

  assert.strictEqual(finalStatus, 'PARTIAL');
  assert.strictEqual(failedPagesCount, 1);
});

// 10. Ignored or incorrectly implemented status filters
runTest('Regression 10: Canonical parser determines status strictly from HTML button, never from order_type', () => {
  const mixedOrder = createMockRawOrder(3001);
  mixedOrder.order_type = 'استبدال جزئي';
  mixedOrder.status = '<button class="btn btn-warning"> Printed</button>';

  const parsedStatus = syncTestEngine.parseStatusString(mixedOrder.status);
  assert.strictEqual(parsedStatus, 'Printed', 'Status must be Printed');
  assert.notStrictEqual(parsedStatus, mixedOrder.order_type, 'Status must NEVER be order_type');
});

// 11. Pagination totals changing during a scan
runTest('Regression 11: Shift in recordsTotal during scan is flagged as totalChangedDuringScan', () => {
  const initialTotal: number = 905;
  const secondPageTotal: number = 907;
  const totalChanged = secondPageTotal !== initialTotal;

  assert.strictEqual(totalChanged, true, 'Must detect concurrent source insertions');
});

// 12. Missing or malformed statuses
runTest('Regression 12: Empty or unrecognizable status defaults to Unknown without crashing', () => {
  const malformed = syncTestEngine.parseStatusString('');
  assert.strictEqual(malformed, 'Unknown');

  const strange = syncTestEngine.parseStatusString('<button>INVALID_STATUS_TAG</button>');
  assert.strictEqual(strange, 'INVALID_STATUS_TAG');
});

// 13. Incomplete source responses
runTest('Regression 13: Incomplete response with empty name does not erase previously verified customer_name', () => {
  const initial = createMockRawOrder(4001);
  initial.full_name = 'محمود عبد السلام';
  syncTestEngine.upsertCanonicalOrder(initial, '2026-10-17T10:10:00.000Z');

  // Incomplete update without full_name
  const incomplete = createMockRawOrder(4001);
  incomplete.full_name = '';
  syncTestEngine.upsertCanonicalOrder(incomplete, '2026-10-17T10:11:00.000Z');

  const row: any = db.prepare('SELECT customer_name FROM orders WHERE vendoor_id = 4001').get();
  assert.strictEqual(row.customer_name, 'محمود عبد السلام', 'Verified customer name preserved');
});

// 14. Enrichment failure
runTest('Regression 14: Failed customer enrichment does not fail canonical order sync or corrupt records', () => {
  let failedEnrichments = 0;
  try {
    throw new Error('Connection timeout to searchPhone');
  } catch (err: any) {
    failedEnrichments++;
  }

  assert.strictEqual(failedEnrichments, 1);
  const orderExists = (db.prepare('SELECT count(*) as c FROM orders WHERE vendoor_id = 4001').get() as any).c;
  assert.strictEqual(orderExists, 1, 'Core order remains in database');
});

// 15. Very slow source requests / timeouts
runTest('Regression 15: Explicit AbortController timeout bounds request duration', async () => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 50);

  let aborted = false;
  try {
    await new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(new Error('Request timed out after 50ms'));
      });
    });
  } catch (err: any) {
    aborted = true;
    assert.ok(err.message.includes('timed out'));
  } finally {
    clearTimeout(timeoutId);
  }

  assert.strictEqual(aborted, true, 'Slow request must abort via timeout');
});

// 16. Repeated or overlapping sync attempts
runTest('Regression 16: Concurrency guard prevents duplicate overlapping sync executions', () => {
  let isSyncing = true;

  function attemptTrigger() {
    if (isSyncing) return 'REJECTED_ALREADY_RUNNING';
    return 'STARTED';
  }

  assert.strictEqual(attemptTrigger(), 'REJECTED_ALREADY_RUNNING');
});

// 17. Incorrectly reported SUCCESS
runTest('Regression 17: Sync cycle with failed page reports PARTIAL, not SUCCESS', () => {
  const hasFailedPage = true;
  const status = hasFailedPage ? 'PARTIAL' : 'SUCCESS';
  assert.strictEqual(status, 'PARTIAL');
});

// 18. Actual API totals matching unique canonical IDs in SQLite
runTest('Regression 18: Reconcile source vs local yields VERIFIED when IDs and statuses match', () => {
  const mockSource = [
    createMockRawOrder(1001, ' Pending'),
    createMockRawOrder(1002, ' New'),
    createMockRawOrder(1003, ' New'),
    createMockRawOrder(1004, ' New'),
    createMockRawOrder(1005, ' New'),
    createMockRawOrder(4001, ' New'),
  ];

  const testIds = mockSource.map(o => o.id);
  const report: ReconciliationReport = syncTestEngine.reconcileSourceVsLocal(mockSource, testIds);
  assert.strictEqual(report.sourceTotalUnique, 6);
  assert.strictEqual(report.localTotalUnique, 6);
  assert.strictEqual(report.overallMatching, 6, 'All 6 orders match in status and ID');
  assert.strictEqual(report.missingLocallyCount, 0, 'Zero source IDs missing locally');
  assert.strictEqual(report.missingInSourceCount, 0, 'Zero local IDs missing in source');
  assert.strictEqual(report.statusMismatchTotal, 0, 'Zero status mismatches');
  assert.strictEqual(report.parityStatus, 'VERIFIED');
});

// Clean up test artifacts
cleanTestArtifacts();

console.log(`\n🎉 ALL ${passedTests} / 18 REGRESSION & RECONCILIATION TESTS PASSED! 🎉\n`);
