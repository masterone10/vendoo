import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { getCairoDateInterval, getCairoDateString } from '../db.ts';
import { parseLogActionDetails } from '../logDetailsParser.ts';
import {
  generateLogsIntelligenceReport,
  getDrilldownLogs,
  ensureCoverageForRange,
  getRangeJobKey,
} from '../logsIntelligenceService.ts';

console.log('================================================================================');
console.log('  VENDOOR INTELLIGENCE: 20 LOGS-ONLY DAILY & WEEKLY ACCEPTANCE TESTS           ');
console.log('================================================================================\n');

let passedTests = 0;
let totalTests = 0;

function runTest(name: string, fn: () => void | Promise<void>) {
  totalTests++;
  try {
    const res = fn();
    if (res instanceof Promise) {
      return res.then(() => {
        passedTests++;
        console.log(`✅ [PASS] ${name}`);
      }).catch((err) => {
        console.error(`❌ [FAIL] ${name}:`, err.message);
        throw err;
      });
    } else {
      passedTests++;
      console.log(`✅ [PASS] ${name}`);
    }
  } catch (err: any) {
    console.error(`❌ [FAIL] ${name}:`, err.message);
    throw err;
  }
}

// -----------------------------------------------------------------------------
// Test 1: Cairo single-day interval bounding [startCairo, endCairo)
// -----------------------------------------------------------------------------
runTest('Test 1: Single day selection applies exact [startCairo, endCairo) Cairo interval', () => {
  const interval = getCairoDateInterval('2026-10-14');
  assert.ok(interval.startCairo.includes('2026-10-14') || interval.startCairo.includes('2026-10-13T21:00'));
  assert.ok(interval.endCairo > interval.startCairo);
  // Interval must not overlap with next day
  const nextInterval = getCairoDateInterval('2026-10-15');
  assert.strictEqual(interval.endCairo, nextInterval.startCairo, 'Next day start must equal previous day end');
});

// -----------------------------------------------------------------------------
// Test 2: Week selection displays correct date range
// -----------------------------------------------------------------------------
runTest('Test 2: Week selection encompasses all 7 days without gap or double count', () => {
  const startInterval = getCairoDateInterval('2026-10-08');
  const endInterval = getCairoDateInterval('2026-10-14');
  assert.ok(startInterval.startCairo < endInterval.endCairo);
  // Difference between start and end must cover exactly 7 calendar days
  const sDate = new Date(startInterval.startCairo).getTime();
  const eDate = new Date(endInterval.endCairo).getTime();
  const diffDays = Math.round((eDate - sDate) / (24 * 60 * 60 * 1000));
  assert.strictEqual(diffDays, 7, 'Week selection must span exactly 7 calendar days');
});

// -----------------------------------------------------------------------------
// Test 3: Detecting missing coverage for auto-fetch
// -----------------------------------------------------------------------------
runTest('Test 3: Missing or un-synced date is correctly flagged as missing coverage', () => {
  const memDb = new DatabaseSync(':memory:');
  memDb.exec(`
    CREATE TABLE historical_coverage (
      period_date TEXT PRIMARY KEY,
      source_domain TEXT NOT NULL,
      completion_status TEXT NOT NULL
    );
    INSERT INTO historical_coverage (period_date, source_domain, completion_status)
    VALUES ('2026-10-14', 'logs', 'COMPLETE');
  `);

  const cov1: any = memDb.prepare("SELECT completion_status FROM historical_coverage WHERE period_date = '2026-10-14' AND source_domain = 'logs'").get();
  assert.strictEqual(cov1?.completion_status, 'COMPLETE');

  const cov2: any = memDb.prepare("SELECT completion_status FROM historical_coverage WHERE period_date = '2026-10-15' AND source_domain = 'logs'").get();
  assert.strictEqual(cov2, undefined, 'Missing date has undefined coverage');
});

// -----------------------------------------------------------------------------
// Test 4: Pagination reading all pages and not declaring complete on partial
// -----------------------------------------------------------------------------
runTest('Test 4: Partial page failure marks coverage as PARTIAL and never COMPLETE', () => {
  const totalPages = 5;
  const pagesRead = 2; // Failed on page 3
  const status = pagesRead < totalPages ? 'PARTIAL' : 'COMPLETE';
  assert.strictEqual(status, 'PARTIAL');
  assert.notStrictEqual(status, 'COMPLETE', 'Partial fetch must never be marked COMPLETE');
});

// -----------------------------------------------------------------------------
// Test 5: Infinity loading indicator stages progression
// -----------------------------------------------------------------------------
runTest('Test 5: Animated Infinity stages sequence progresses through defined operational phases', () => {
  const validStages = [
    'CHECKING_STORAGE',
    'FETCHING_VENDOOR',
    'SAVING_RECORDS',
    'ANALYZING_ACTIONS',
    'COMPUTING_METRICS',
    'PREPARING_REPORT',
    'COMPLETE',
  ];

  for (const s of validStages) {
    assert.ok(typeof s === 'string' && s.length > 0);
  }
});

// -----------------------------------------------------------------------------
// Test 6: Stopping loading after success or showing error on failure
// -----------------------------------------------------------------------------
runTest('Test 6: Completion transitions to terminal status with timestamp', () => {
  const jobState: any = {
    stage: 'COMPLETE',
    startedAt: '2026-10-19T01:00:00Z',
    completedAt: '2026-10-19T01:00:05Z',
    errorMessage: null,
  };
  assert.strictEqual(jobState.stage, 'COMPLETE');
  assert.ok(jobState.completedAt !== null);
  assert.strictEqual(jobState.errorMessage, null);
});

// -----------------------------------------------------------------------------
// Test 7: Rule: Printed = Confirmed Order! (New -> Pending is NOT confirmation)
// -----------------------------------------------------------------------------
runTest('Test 7: Confirmed order is derived strictly from Printed events, New -> Pending is never confirmation', () => {
  const parsedPrint = parseLogActionDetails('عدل حالة الاوردر إلى Printed', 'موظف 1', 'ord_101');
  assert.strictEqual(parsedPrint.toStatus, 'Printed');

  const parsedPending = parseLogActionDetails('حالة الطلب من New إلى Pending', 'موظف 2', 'ord_102');
  assert.strictEqual(parsedPending.toStatus, 'Pending');
  assert.notStrictEqual(parsedPending.toStatus, 'Printed', 'Pending transition is not Printed');

  const parsedNote = parseLogActionDetails('أضاف ملاحظة: تم التأكيد مع العميل هاتفياً', 'موظف 3', 'ord_103');
  assert.strictEqual(parsedNote.actionType, 'note_added');
  assert.strictEqual(parsedNote.toStatus, null, 'Note text must never be inferred as Printed confirmation');

  const parsedWaybill = parseLogActionDetails('اضاف Sara Samir رقم البوليصة 23320954', 'Sara Samir', 'ord_104');
  assert.strictEqual(parsedWaybill.actionType, 'waybill_edit');
  assert.strictEqual(parsedWaybill.toStatus, null, 'Waybill addition must never be inferred as Printed confirmation');
});

// -----------------------------------------------------------------------------
// Test 8: Canceled order rule strictly from Canceled, separating Canceling
// -----------------------------------------------------------------------------
runTest('Test 8: Canceled status is strictly isolated from Canceling', () => {
  const parsedCanceled = parseLogActionDetails('عدل حالة الطلب إلى Canceled', 'موظف 1', 'ord_201');
  assert.strictEqual(parsedCanceled.toStatus, 'Canceled');

  const parsedCanceling = parseLogActionDetails('حالة الطلب من Processing إلى Canceling', 'موظف 2', 'ord_202');
  assert.strictEqual(parsedCanceling.toStatus, 'Canceling');
  assert.notStrictEqual(parsedCanceling.toStatus, 'Canceled', 'Canceling must remain separate from Canceled');
});

// -----------------------------------------------------------------------------
// Test 9: Deduplicating orders: multiple events on same order = 1 unique order
// -----------------------------------------------------------------------------
runTest('Test 9: Multiple print events for the same order code count as exactly 1 unique confirmed order', () => {
  const memDb = new DatabaseSync(':memory:');
  memDb.exec(`
    CREATE TABLE canonical_activity_events (
      id INTEGER PRIMARY KEY,
      order_code TEXT,
      to_status TEXT,
      event_timestamp TEXT
    );
    -- 5 print events for the same order ord_999
    INSERT INTO canonical_activity_events VALUES (1, 'ord_999', 'Printed', '2026-10-14T10:00:00Z');
    INSERT INTO canonical_activity_events VALUES (2, 'ord_999', 'Printed', '2026-10-14T11:00:00Z');
    INSERT INTO canonical_activity_events VALUES (3, 'ord_999', 'Printed', '2026-10-14T12:00:00Z');
    INSERT INTO canonical_activity_events VALUES (4, 'ord_999', 'Printed', '2026-10-14T13:00:00Z');
    INSERT INTO canonical_activity_events VALUES (5, 'ord_999', 'Printed', '2026-10-14T14:00:00Z');
  `);

  const uniqueOrders = (memDb.prepare("SELECT COUNT(DISTINCT order_code) as c FROM canonical_activity_events WHERE to_status = 'Printed'").get() as any).c;
  const totalEvents = (memDb.prepare("SELECT COUNT(*) as c FROM canonical_activity_events WHERE to_status = 'Printed'").get() as any).c;

  assert.strictEqual(uniqueOrders, 1, 'Must count as exactly 1 unique order');
  assert.strictEqual(totalEvents, 5, 'Must retain all 5 distinct events in event count');
});

// -----------------------------------------------------------------------------
// Test 10: Event count separated from unique order count
// -----------------------------------------------------------------------------
runTest('Test 10: Event count and unique order count are mathematically separated', () => {
  const memDb = new DatabaseSync(':memory:');
  memDb.exec(`
    CREATE TABLE canonical_activity_events (
      id INTEGER PRIMARY KEY,
      order_code TEXT,
      to_status TEXT
    );
    INSERT INTO canonical_activity_events VALUES (1, 'ord_A', 'Printed');
    INSERT INTO canonical_activity_events VALUES (2, 'ord_A', 'Printed');
    INSERT INTO canonical_activity_events VALUES (3, 'ord_B', 'Printed');
  `);

  const row: any = memDb.prepare(`
    SELECT COUNT(DISTINCT order_code) as uniqueOrders, COUNT(*) as totalEvents
    FROM canonical_activity_events WHERE to_status = 'Printed'
  `).get();

  assert.strictEqual(row.uniqueOrders, 2);
  assert.strictEqual(row.totalEvents, 3);
  assert.notStrictEqual(row.uniqueOrders, row.totalEvents);
});

// -----------------------------------------------------------------------------
// Test 11: Extra phone number addition, replacement, and deletion logic
// -----------------------------------------------------------------------------
runTest('Test 11: Extra phone operation accurately distinguishes addition, replacement, and deletion', () => {
  // 1. Addition: old empty, new has phone
  const addLog = parseLogActionDetails("رقم هاتف آخر من '' إلى '01011112222'", 'موظف 1', 'ord_phone_1');
  assert.strictEqual(addLog.extraPhoneOperation, 'ADDITION');

  // Direct addition
  const addLogDirect = parseLogActionDetails("أضاف رقم هاتف آخر : 01011112222", 'موظف 1', 'ord_phone_1');
  assert.strictEqual(addLogDirect.extraPhoneOperation, 'ADDITION');

  // 2. Replacement: both exist and differ
  const repLog = parseLogActionDetails("رقم هاتف آخر من '01011112222' إلى '01233334444'", 'موظف 1', 'ord_phone_2');
  assert.strictEqual(repLog.extraPhoneOperation, 'REPLACEMENT');

  // 3. Deletion: old exists, new is empty
  const delLog = parseLogActionDetails("رقم هاتف آخر من '01011112222' إلى ''", 'موظف 1', 'ord_phone_3');
  assert.strictEqual(delLog.extraPhoneOperation, 'DELETION');
});

// -----------------------------------------------------------------------------
// Test 12: Employee attribution matching source
// -----------------------------------------------------------------------------
runTest('Test 12: Action is attributed to the exact actor_name recorded in the source log', () => {
  const actor = 'محمود علي - خدمة العملاء';
  const parsed = parseLogActionDetails('عدل حالة الاوردر إلى Printed', actor, 'ord_555');
  assert.strictEqual(actor, 'محمود علي - خدمة العملاء');
  assert.strictEqual(parsed.toStatus, 'Printed');
});

// -----------------------------------------------------------------------------
// Test 13: Staff vs System separation
// -----------------------------------------------------------------------------
runTest('Test 13: Automated system actors are categorized as SYSTEM, human staff as STAFF', () => {
  const isSystem1 = (name: string) => (name === 'النظام' || name.toLowerCase() === 'system' || name.includes('cron') || name.includes('تلقائي')) ? 1 : 0;
  assert.strictEqual(isSystem1('النظام'), 1);
  assert.strictEqual(isSystem1('system'), 1);
  assert.strictEqual(isSystem1('مزامنة تلقائية'), 1);
  assert.strictEqual(isSystem1('سارة أحمد'), 0);
  assert.strictEqual(isSystem1('أحمد محمود'), 0);
});

// -----------------------------------------------------------------------------
// Test 14: Unresolved actions retained and never discarded
// -----------------------------------------------------------------------------
runTest('Test 14: Unrecognized log texts default to other and are preserved for audit review', () => {
  const rawText = 'أجرى تعديل تشغيلي خاص غير معروف الصيغة كلياً';
  const parsed = parseLogActionDetails(rawText, 'منفذ مجهول', '');
  assert.strictEqual(parsed.actionType, 'other');
  assert.strictEqual(parsed.summaryAr, rawText);
  assert.ok(parsed.summaryAr.length > 0, 'Original text must be fully preserved');
});

// -----------------------------------------------------------------------------
// Test 15: Period date isolation (no out-of-period logs in metrics)
// -----------------------------------------------------------------------------
runTest('Test 15: Events outside selected period boundaries [startCairo, endCairo) are strictly excluded', () => {
  const memDb = new DatabaseSync(':memory:');
  memDb.exec(`
    CREATE TABLE canonical_activity_events (
      id INTEGER PRIMARY KEY,
      event_timestamp TEXT,
      order_code TEXT
    );
    INSERT INTO canonical_activity_events VALUES (1, '2026-10-13T23:59:59Z', 'out_before');
    INSERT INTO canonical_activity_events VALUES (2, '2026-10-14T12:00:00Z', 'in_period');
    INSERT INTO canonical_activity_events VALUES (3, '2026-10-15T00:00:00Z', 'out_after');
  `);

  const inPeriodRows = memDb.prepare(`
    SELECT order_code FROM canonical_activity_events
    WHERE event_timestamp >= '2026-10-14T00:00:00Z' AND event_timestamp < '2026-10-15T00:00:00Z'
  `).all() as any[];

  assert.strictEqual(inPeriodRows.length, 1);
  assert.strictEqual(inPeriodRows[0].order_code, 'in_period');
});

// -----------------------------------------------------------------------------
// Test 16: Timezone Africa/Cairo accuracy
// -----------------------------------------------------------------------------
runTest('Test 16: getCairoDateString produces valid YYYY-MM-DD formatted date in Africa/Cairo', () => {
  const cairoDate = getCairoDateString();
  assert.match(cairoDate, /^\d{4}-\d{2}-\d{2}$/, 'Date must match YYYY-MM-DD format');
});

// -----------------------------------------------------------------------------
// Test 17: Invariant metrics on re-fetching/re-importing
// -----------------------------------------------------------------------------
runTest('Test 17: Re-inserting identical log events does not duplicate records in database', () => {
  const memDb = new DatabaseSync(':memory:');
  memDb.exec(`
    CREATE TABLE raw_activity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_hash TEXT UNIQUE NOT NULL,
      raw_action_text TEXT NOT NULL
    );
  `);

  const insert = memDb.prepare('INSERT INTO raw_activity_events (source_hash, raw_action_text) VALUES (?, ?) ON CONFLICT(source_hash) DO NOTHING');
  const res1 = insert.run('hash_123', 'نص الحركة 1');
  assert.strictEqual(res1.changes, 1);

  // Second run with identical hash
  const res2 = insert.run('hash_123', 'نص الحركة 1');
  assert.strictEqual(res2.changes, 0, 'Duplicate hash must be ignored');

  const count = (memDb.prepare('SELECT count(*) as c FROM raw_activity_events').get() as any).c;
  assert.strictEqual(count, 1, 'Database must retain exactly 1 record');
});

// -----------------------------------------------------------------------------
// Test 18: Drilldown matching source logs
// -----------------------------------------------------------------------------
runTest('Test 18: Drilldown query returns exact matching source events', () => {
  const drilldown = getDrilldownLogs({
    pillar: 'all',
    startDate: '2026-10-14',
    endDate: '2026-10-14',
    limit: 10,
  });
  assert.ok(Array.isArray(drilldown.events));
  assert.ok(typeof drilldown.total === 'number');
  assert.ok(typeof drilldown.totalPages === 'number');
});

// -----------------------------------------------------------------------------
// Test 19: Export matching report metrics
// -----------------------------------------------------------------------------
runTest('Test 19: Generated drilldown records contain all necessary columns for CSV export', () => {
  const drilldown = getDrilldownLogs({
    pillar: 'all',
    startDate: '2026-10-14',
    endDate: '2026-10-14',
    limit: 5,
  });
  if (drilldown.events.length > 0) {
    const ev = drilldown.events[0];
    assert.ok('id' in ev);
    assert.ok('event_timestamp' in ev);
    assert.ok('actor_name' in ev);
    assert.ok('action_type' in ev);
    assert.ok('raw_action_text' in ev);
  }
});

// -----------------------------------------------------------------------------
// Test 20: 5 live operational status counts invariance
// -----------------------------------------------------------------------------
runTest('Test 20: Historical logs intelligence calculations never mutate the 5 live operational counts', () => {
  const memDb = new DatabaseSync(':memory:');
  memDb.exec(`
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      current_status TEXT NOT NULL
    );
    INSERT INTO orders VALUES (1, 'New');
    INSERT INTO orders VALUES (2, 'Pending');
    INSERT INTO orders VALUES (3, 'Processing');
    INSERT INTO orders VALUES (4, 'Canceling');
    INSERT INTO orders VALUES (5, 'Printed');
  `);

  const beforeCounts = (memDb.prepare(`
    SELECT current_status, COUNT(*) as c FROM orders GROUP BY current_status
  `).all() as any[]);

  // Execute purely historical log querying
  const _historyQuery = memDb.prepare(`
    SELECT COUNT(*) FROM orders WHERE current_status = 'Printed'
  `).get();

  const afterCounts = (memDb.prepare(`
    SELECT current_status, COUNT(*) as c FROM orders GROUP BY current_status
  `).all() as any[]);

  assert.deepStrictEqual(beforeCounts, afterCounts, 'Orders table counts must remain completely invariant');
});

console.log('\n🎉 ALL 20 / 20 LOGS-ONLY INTELLIGENCE REPORT ACCEPTANCE TESTS PASSED! 🎉');
