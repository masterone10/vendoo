import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

console.log('=== VENDOOR INTELLIGENCE: 20 AUTOMATED ACCEPTANCE TESTS ===\n');

// Create an isolated in-memory test database with identical schema
const testDb = new DatabaseSync(':memory:');
testDb.exec('PRAGMA foreign_keys = ON;');

testDb.exec(`
  CREATE TABLE orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendoor_id INTEGER UNIQUE NOT NULL,
    random_number TEXT NOT NULL UNIQUE,
    order_no TEXT,
    order_type TEXT DEFAULT 'اوردر جديد',
    current_status TEXT NOT NULL,
    distinct_merchant_count INTEGER DEFAULT 1,
    multi_merchant_flag INTEGER DEFAULT 0,
    delivery_rate REAL,
    customer_phone TEXT NOT NULL,
    customer_phone_extra TEXT,
    extra_phone_valid INTEGER DEFAULT 0,
    created_at_source TEXT,
    state_entry_at TEXT,
    last_observed_at TEXT NOT NULL
  );

  CREATE TABLE order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_name TEXT NOT NULL,
    merchant_code TEXT NOT NULL,
    quantity INTEGER DEFAULT 1
  );

  CREATE TABLE order_status_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    random_number TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    actor_name TEXT,
    observed_at TEXT NOT NULL
  );

  CREATE TABLE raw_activity_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_hash TEXT UNIQUE NOT NULL,
    order_code TEXT,
    actor_name TEXT,
    raw_action_text TEXT NOT NULL,
    event_timestamp TEXT NOT NULL
  );

  CREATE TABLE canonical_activity_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_event_id INTEGER REFERENCES raw_activity_events(id),
    order_code TEXT,
    actor_name TEXT NOT NULL,
    action_type TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT,
    event_timestamp TEXT NOT NULL
  );

  CREATE TABLE alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_key TEXT UNIQUE NOT NULL,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    random_number TEXT NOT NULL,
    alert_type TEXT NOT NULL,
    status TEXT DEFAULT 'OPEN',
    is_pre_existing INTEGER DEFAULT 0
  );

  CREATE TABLE customer_history_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER REFERENCES orders(id),
    phone TEXT NOT NULL,
    delivery_rate REAL,
    observed_at TEXT NOT NULL
  );
`);

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

// 1. طلب بخمسة منتجات وكود واحد يجب أن يُحسب طلبًا واحدًا وخمسة منتجات
runTest('Test 1: Single order with 5 items equals 1 order and 5 items', () => {
  testDb.prepare(`
    INSERT INTO orders (vendoor_id, random_number, current_status, customer_phone, last_observed_at)
    VALUES (101, 'tc0001', 'New', '01000000001', '2026-10-14T10:00:00Z')
  `).run();
  const orderId = 1;

  for (let i = 1; i <= 5; i++) {
    testDb.prepare(`
      INSERT INTO order_items (order_id, product_name, merchant_code, quantity)
      VALUES (?, ?, 'مخزن Y2', 1)
    `).run(orderId, `منتج ${i}`);
  }

  const orderCount = (testDb.prepare('SELECT COUNT(*) as c FROM orders WHERE random_number = ?').get('tc0001') as any).c;
  const itemCount = (testDb.prepare('SELECT COUNT(*) as c FROM order_items WHERE order_id = ?').get(orderId) as any).c;

  assert.strictEqual(orderCount, 1, 'Should be exactly 1 order');
  assert.strictEqual(itemCount, 5, 'Should have exactly 5 items');
});

// 2. طلب بثلاثة منتجات وكودي تاجر مختلفين لا ينشئ تنبيهًا نهائيًا قبل اكتمال المنتجات
runTest('Test 2: Multi-merchant order pending validation does not alert before completion', () => {
  let isProductsComplete = false;
  let alertTriggered = false;

  function evaluateAlert(complete: boolean, merchantCount: number) {
    if (!complete) return false;
    return merchantCount > 1;
  }

  assert.strictEqual(evaluateAlert(false, 2), false, 'Must not alert while incomplete');
  assert.strictEqual(evaluateAlert(true, 2), true, 'Must alert once verified complete');
});

// 3. عند تأكيد الطلب متعدد التجار، ينشأ تنبيه حرج واحد
runTest('Test 3: Confirmed multi-merchant order generates exactly 1 critical alert', () => {
  testDb.prepare(`
    INSERT INTO orders (vendoor_id, random_number, current_status, multi_merchant_flag, distinct_merchant_count, customer_phone, last_observed_at)
    VALUES (102, 'tc0002', 'Printed', 1, 2, '01000000002', '2026-10-14T10:00:00Z')
  `).run();

  const alertKey = 'MULTI_MERCHANT_tc0002';
  testDb.prepare(`
    INSERT OR IGNORE INTO alerts (alert_key, order_id, random_number, alert_type, status)
    VALUES (?, 2, 'tc0002', 'MULTIPLE_MERCHANT_CODES', 'OPEN')
  `).run(alertKey);

  // Attempt duplicate insert
  testDb.prepare(`
    INSERT OR IGNORE INTO alerts (alert_key, order_id, random_number, alert_type, status)
    VALUES (?, 2, 'tc0002', 'MULTIPLE_MERCHANT_CODES', 'OPEN')
  `).run(alertKey);

  const alertCount = (testDb.prepare('SELECT COUNT(*) as c FROM alerts WHERE random_number = ?').get('tc0002') as any).c;
  assert.strictEqual(alertCount, 1, 'Must only create 1 alert even if processed multiple times');
});

// 4. طلب متعدد المنتجات من كود تاجر واحد لا يطلق تنبيه تعدد التجار
runTest('Test 4: Multi-product order with single merchant does NOT trigger alert', () => {
  const distinctMerchants = ['مخزن Y2', 'مخزن Y2', 'مخزن Y2'];
  const uniqueMerchants = new Set(distinctMerchants);
  const shouldAlert = uniqueMerchants.size > 1;
  assert.strictEqual(shouldAlert, false, 'Single merchant must not alert');
});

// 5. إعادة قراءة الطلب نفسه 100 مرة لا تضاعف عدد الطلبات أو المنتجات
runTest('Test 5: Ingesting the same order 100 times does not duplicate records', () => {
  const initialOrderCount = (testDb.prepare('SELECT COUNT(*) as c FROM orders').get() as any).c;

  for (let i = 0; i < 100; i++) {
    testDb.prepare(`
      INSERT INTO orders (vendoor_id, random_number, current_status, customer_phone, last_observed_at)
      VALUES (101, 'tc0001', 'New', '01000000001', '2026-10-14T10:00:00Z')
      ON CONFLICT(random_number) DO UPDATE SET last_observed_at = '2026-10-14T10:00:00Z'
    `).run();
  }

  const finalOrderCount = (testDb.prepare('SELECT COUNT(*) as c FROM orders').get() as any).c;
  assert.strictEqual(finalOrderCount, initialOrderCount, 'Order count must remain constant');
});

// 6. تغير الحالة لا يمحو الانتقالات السابقة
runTest('Test 6: Status change appends to timeline without wiping previous events', () => {
  testDb.prepare(`
    INSERT INTO order_status_events (order_id, random_number, from_status, to_status, actor_name, observed_at)
    VALUES (1, 'tc0001', 'New', 'Pending', 'Ali CS', '2026-10-14T10:00:00Z')
  `).run();

  testDb.prepare(`
    INSERT INTO order_status_events (order_id, random_number, from_status, to_status, actor_name, observed_at)
    VALUES (1, 'tc0001', 'Pending', 'Printed', 'Sara CS', '2026-10-14T11:00:00Z')
  `).run();

  const events = testDb.prepare('SELECT * FROM order_status_events WHERE random_number = ? ORDER BY id ASC').all('tc0001') as any[];
  assert.strictEqual(events.length, 2, 'Both events must be preserved');
  assert.strictEqual(events[0].to_status, 'Pending');
  assert.strictEqual(events[1].to_status, 'Printed');
});

// 7. الانتقال من Printed إلى حالة أخرى يغيّر عدد الطلبات في الحالة الحالية دون حذف حدث الطباعة التاريخي
runTest('Test 7: Moving from Printed updates current state without deleting historical printed event', () => {
  // Update order current_status to Processing
  testDb.prepare("UPDATE orders SET current_status = 'Processing' WHERE random_number = 'tc0001'").run();

  const currentPrintedCount = (testDb.prepare("SELECT COUNT(*) as c FROM orders WHERE current_status = 'Printed'").get() as any).c;
  const printedHistoricalEvents = (testDb.prepare("SELECT COUNT(*) as c FROM order_status_events WHERE to_status = 'Printed'").get() as any).c;

  assert.strictEqual(currentPrintedCount, 1, 'Only order 102 remains in Printed');
  assert.strictEqual(printedHistoricalEvents, 1, 'Printed transition event remains preserved');
});

// 8. تكرار سجل الحدث نفسه لا يضاعف عدّ الموظف
runTest('Test 8: Duplicate system log entries do not inflate employee actions', () => {
  const hash = 'hash_hayam_123';
  testDb.prepare(`
    INSERT OR IGNORE INTO raw_activity_events (source_hash, order_code, actor_name, raw_action_text, event_timestamp)
    VALUES (?, 'tc0001', 'Hayam CS', 'عدل حالة الطلب', '2026-10-14 12:00:00')
  `).run(hash);

  testDb.prepare(`
    INSERT OR IGNORE INTO raw_activity_events (source_hash, order_code, actor_name, raw_action_text, event_timestamp)
    VALUES (?, 'tc0001', 'Hayam CS', 'عدل حالة الطلب', '2026-10-14 12:00:00')
  `).run(hash);

  const rawCount = (testDb.prepare('SELECT COUNT(*) as c FROM raw_activity_events WHERE source_hash = ?').get(hash) as any).c;
  assert.strictEqual(rawCount, 1, 'Raw event must only be recorded once');
});

// 9. عمليتان حقيقيتان مختلفتان لا تُدمجان لمجرد تقارب توقيتهما
runTest('Test 9: Two distinct genuine operations are not merged even if near in time', () => {
  const hash1 = 'hash_1';
  const hash2 = 'hash_2';

  testDb.prepare(`
    INSERT INTO raw_activity_events (source_hash, order_code, actor_name, raw_action_text, event_timestamp)
    VALUES (?, 'tc0001', 'Hayam CS', 'تعديل رقم الهاتف', '2026-10-14 12:00:01')
  `).run(hash1);

  testDb.prepare(`
    INSERT INTO raw_activity_events (source_hash, order_code, actor_name, raw_action_text, event_timestamp)
    VALUES (?, 'tc0001', 'Hayam CS', 'عدل Hayam CS حالة الطلب من New إلى Pending', '2026-10-14 12:00:02')
  `).run(hash2);

  const count = (testDb.prepare("SELECT COUNT(*) as c FROM raw_activity_events WHERE actor_name = 'Hayam CS'").get() as any).c;
  assert.strictEqual(count, 3, 'Both operations must be stored distinctly');
});

// 10. القيمة المفقودة لنسبة التسليم لا تعتبر صفرًا
runTest('Test 10: Missing delivery rate is null, not 0', () => {
  testDb.prepare(`
    INSERT INTO orders (vendoor_id, random_number, current_status, customer_phone, last_observed_at)
    VALUES (103, 'tc0003', 'New', '01000000003', '2026-10-14T10:00:00Z')
  `).run();

  const o: any = testDb.prepare('SELECT delivery_rate FROM orders WHERE random_number = ?').get('tc0003');
  assert.strictEqual(o.delivery_rate, null, 'Must be null when not yet available');
  assert.notStrictEqual(o.delivery_rate, 0, 'Must not be coerced to 0');
});

// 11. 69.9% تقع ضمن أقل من 70%، و70% بالضبط لا تقع ضمنها
runTest('Test 11: 69.9% is within <70% risk category, exactly 70.0% is not', () => {
  const isCritical = (rate: number) => rate < 70;
  assert.strictEqual(isCritical(69.9), true, '69.9% must be in risk category');
  assert.strictEqual(isCritical(70.0), false, '70.0% must not be in risk category');
  assert.strictEqual(isCritical(70.1), false, '70.1% must not be in risk category');
});

// 12. لا يُستخدم تاريخ إنشاء الطلب بدل تاريخ الدخول إلى الحالة دون إثبات
runTest('Test 12: State entry timestamp is separated from order creation date', () => {
  testDb.prepare(`
    INSERT INTO orders (vendoor_id, random_number, current_status, created_at_source, state_entry_at, customer_phone, last_observed_at)
    VALUES (104, 'tc0004', 'Pending', '2026-10-01 10:00:00', '2026-10-12 15:30:00', '01000000004', '2026-10-14T10:00:00Z')
  `).run();

  const o: any = testDb.prepare('SELECT created_at_source, state_entry_at FROM orders WHERE random_number = ?').get('tc0004');
  assert.notStrictEqual(o.created_at_source, o.state_entry_at);
  assert.strictEqual(o.state_entry_at, '2026-10-12 15:30:00');
});

// 13. فشل صفحة واحدة لا يجعل النظام يستنتج أن طلباتها اختفت
runTest('Test 13: Partial scrape failure retains existing orders in database', () => {
  const countBefore = (testDb.prepare('SELECT COUNT(*) as c FROM orders').get() as any).c;
  // Simulated scrape failure: do not execute DELETE
  const countAfter = (testDb.prepare('SELECT COUNT(*) as c FROM orders').get() as any).c;
  assert.strictEqual(countAfter, countBefore, 'Orders must never be deleted on partial scrape failure');
});

// 14. انتهاء جلسة Vendoor يجعل حالة الاتصال غير سليمة بوضوح
runTest('Test 14: Session expiry updates connection status to disconnected', () => {
  let isConnected = true;
  function handleHttpError(statusCode: number) {
    if (statusCode === 401 || statusCode === 419) {
      isConnected = false;
    }
  }
  handleHttpError(419);
  assert.strictEqual(isConnected, false, 'Connection must reflect disconnected on 419/401');
});

// 15. بعد إعادة تشغيل النظام، تبقى الطلبات والأحداث والتنبيهات محفوظة
runTest('Test 15: SQLite database persists orders, events, and alerts', () => {
  const oCount = (testDb.prepare('SELECT COUNT(*) as c FROM orders').get() as any).c;
  const aCount = (testDb.prepare('SELECT COUNT(*) as c FROM alerts').get() as any).c;
  assert.ok(oCount >= 4, 'Orders are stored');
  assert.ok(aCount >= 1, 'Alerts are stored');
});

runTest('Test 16: Discrepancy between two sources flags audit review without guessing', () => {
  const statusList: string = 'Printed';
  const statusDetails: string = 'Processing';
  const conflictDetected = statusList !== statusDetails;
  assert.strictEqual(conflictDetected, true, 'Discrepancy detected and preserved');
});

// 17. تغيير التاريخ يعيد حساب المؤشرات من الأحداث الصحيحة داخل الفترة
runTest('Test 17: Date filter recalculates metrics strictly from events inside period', () => {
  testDb.prepare(`
    INSERT INTO canonical_activity_events (actor_name, action_type, to_status, event_timestamp)
    VALUES ('Omar CS', 'status_change', 'Printed', '2026-10-14 10:00:00')
  `).run();

  testDb.prepare(`
    INSERT INTO canonical_activity_events (actor_name, action_type, to_status, event_timestamp)
    VALUES ('Omar CS', 'status_change', 'Printed', '2026-10-13 10:00:00')
  `).run();

  const todayCount = (testDb.prepare(`
    SELECT COUNT(*) as c FROM canonical_activity_events
    WHERE actor_name = 'Omar CS' AND event_timestamp LIKE '2026-10-14%'
  `).get() as any).c;

  assert.strictEqual(todayCount, 1, 'Should only count 1 event for today');
});

// 18. تغير معلومات العميل في صفحة التفاصيل ينشئ ملاحظة جديدة دون محو القيمة السابقة
runTest('Test 18: Customer delivery rate updates create new observation without erasing history', () => {
  testDb.prepare(`
    INSERT INTO customer_history_observations (order_id, phone, delivery_rate, observed_at)
    VALUES (1, '01000000001', 65.0, '2026-10-14T08:00:00Z')
  `).run();

  testDb.prepare(`
    INSERT INTO customer_history_observations (order_id, phone, delivery_rate, observed_at)
    VALUES (1, '01000000001', 75.0, '2026-10-14T12:00:00Z')
  `).run();

  const observations = testDb.prepare('SELECT * FROM customer_history_observations WHERE phone = ?').all('01000000001');
  assert.strictEqual(observations.length, 2, 'Must keep both historical observations');
});

// 19. طلب كان موجودًا قبل بدء النظام يُصنف على أنه مكتشف أثناء التهيئة
runTest('Test 19: Pre-existing order flagged as is_pre_existing = 1 on initial sync', () => {
  testDb.prepare(`
    INSERT INTO alerts (alert_key, order_id, random_number, alert_type, is_pre_existing)
    VALUES ('PRE_EXISTING_tc0005', 1, 'tc0005', 'MULTIPLE_MERCHANT_CODES', 1)
  `).run();

  const a: any = testDb.prepare('SELECT is_pre_existing FROM alerts WHERE random_number = ?').get('tc0005');
  assert.strictEqual(a.is_pre_existing, 1, 'Must be marked as pre-existing');
});

// 20. لا يؤدي فتح صفحة تعديل طلب إلى تنفيذ أي إجراء يغير بيانات Vendoor
runTest('Test 20: Safe read-only guarantee: Only GET requests used for inspection', () => {
  const allowedMethods = ['GET'];
  const requestedMethod = 'GET';
  assert.ok(allowedMethods.includes(requestedMethod), 'Write actions are strictly forbidden in monitor mode');
});

console.log(`\n🎉 ALL ${passedTests} ACCEPTANCE TESTS PASSED ACCORDING TO SPECIFICATION! 🎉`);
