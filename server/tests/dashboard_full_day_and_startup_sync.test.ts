import assert from 'node:assert';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { getCairoDateString, getCairoDateInterval } from '../db.ts';

const TEST_DB_PATH = `/tmp/test_dashboard_full_day_${Date.now()}.sqlite`;

async function runTests() {
  console.log('===================================================================');
  console.log('  TEST SUITE: DASHBOARD FULL DAY SYNC & LIVE NEW ISOLATION         ');
  console.log(`  Isolated Test DB: ${TEST_DB_PATH}`);
  console.log('===================================================================');

  const testDb = new DatabaseSync(TEST_DB_PATH);

  try {
    testDb.exec(`
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vendoor_id INTEGER,
        order_no TEXT,
        random_number TEXT UNIQUE,
        current_status TEXT,
        created_at_source TEXT,
        printed_date TEXT,
        canceling_date TEXT,
        multi_merchant_flag INTEGER DEFAULT 0,
        extra_phone_status TEXT,
        delivery_rate REAL,
        delivery_rate_denom INTEGER,
        total_customer_orders INTEGER,
        cancel_rate REAL,
        confirmation_age_category TEXT
      );

      CREATE TABLE canonical_activity_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        raw_event_id INTEGER,
        order_code TEXT,
        actor_name TEXT,
        action_type TEXT,
        from_status TEXT,
        to_status TEXT,
        event_timestamp TEXT,
        storage_tier TEXT,
        is_system_actor INTEGER,
        created_at TEXT
      );

      CREATE TABLE order_status_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER,
        random_number TEXT,
        from_status TEXT,
        to_status TEXT,
        actor_name TEXT,
        event_time_source TEXT,
        storage_tier TEXT,
        observed_at TEXT,
        source_channel TEXT
      );

      CREATE TABLE alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT
      );
    `);

    const cairoToday = getCairoDateString();
    const interval = getCairoDateInterval(cairoToday);

    // Morning timestamp (03:30 AM Cairo)
    const morningTime = `${cairoToday} 03:30:00`;
    // Afternoon timestamp (14:15 PM Cairo)
    const afternoonTime = `${cairoToday} 14:15:00`;
    // Previous day timestamp (Yesterday 23:50 Cairo)
    const yesterdayDate = new Date(new Date().getTime() - 24 * 3600 * 1000).toISOString().slice(0, 10);
    const yesterdayTime = `${yesterdayDate} 23:50:00`;

    // 1. Seed Orders:
    // Order 1: Currently 'New' (created in morning)
    testDb.prepare(`
      INSERT INTO orders (random_number, order_no, current_status, created_at_source)
      VALUES ('ORD_NEW_1', 'NO_101', 'New', ?)
    `).run(morningTime);

    // Order 2: Currently 'New' (created in afternoon)
    testDb.prepare(`
      INSERT INTO orders (random_number, order_no, current_status, created_at_source)
      VALUES ('ORD_NEW_2', 'NO_102', 'New', ?)
    `).run(afternoonTime);

    // Order 3: Started in morning as 'New', transitioned to 'Pending' at 04:00 AM, then confirmed to 'Printed' at 14:15 PM!
    // Current status is 'Printed' -> MUST NOT appear in current live New/Pending, but MUST appear in today movements!
    testDb.prepare(`
      INSERT INTO orders (random_number, order_no, current_status, created_at_source, printed_date)
      VALUES ('ORD_FLOW_3', 'NO_103', 'Printed', ?, ?)
    `).run(morningTime, afternoonTime);

    // Order 4: Currently in 'Pending' (active queue)
    testDb.prepare(`
      INSERT INTO orders (random_number, order_no, current_status, created_at_source)
      VALUES ('ORD_PEND_4', 'NO_104', 'Pending', ?)
    `).run(morningTime);

    // Order 5: Currently in 'Processing' (active queue)
    testDb.prepare(`
      INSERT INTO orders (random_number, order_no, current_status, created_at_source)
      VALUES ('ORD_PROC_5', 'NO_105', 'Processing', ?)
    `).run(morningTime);

    // Order 6: Canceled in morning from canonical logs
    testDb.prepare(`
      INSERT INTO orders (random_number, order_no, current_status, created_at_source, canceling_date)
      VALUES ('ORD_CANC_6', 'NO_106', 'Canceled', ?, ?)
    `).run(morningTime, morningTime);

    // 2. Seed Canonical Activity Events:
    // Order 3 morning transition: New -> Pending (04:00 AM)
    testDb.prepare(`
      INSERT INTO canonical_activity_events (order_code, actor_name, action_type, from_status, to_status, event_timestamp)
      VALUES ('ORD_FLOW_3', 'أحمد كمال', 'status_change', 'New', 'Pending', ?)
    `).run(`${cairoToday} 04:00:00`);

    // Order 3 afternoon transition: Pending -> Printed (14:15 PM)
    testDb.prepare(`
      INSERT INTO canonical_activity_events (order_code, actor_name, action_type, from_status, to_status, event_timestamp)
      VALUES ('ORD_FLOW_3', 'أحمد كمال', 'confirmation', 'Pending', 'Printed', ?)
    `).run(afternoonTime);

    // Order 3 DUPLICATE confirmation event (re-printed) -> Total events = 2, Unique orders = 1
    testDb.prepare(`
      INSERT INTO canonical_activity_events (order_code, actor_name, action_type, from_status, to_status, event_timestamp)
      VALUES ('ORD_FLOW_3', 'أحمد كمال', 'confirmation', 'Printed', 'Printed', ?)
    `).run(`${cairoToday} 14:35:00`);

    // Order 4 morning transition: entered Pending (08:00 AM)
    testDb.prepare(`
      INSERT INTO canonical_activity_events (order_code, actor_name, action_type, from_status, to_status, event_timestamp)
      VALUES ('ORD_PEND_4', 'منى فؤاد', 'status_change', 'New', 'Pending', ?)
    `).run(`${cairoToday} 08:00:00`);

    // Order 5 afternoon transition: entered Processing (13:00 PM)
    testDb.prepare(`
      INSERT INTO canonical_activity_events (order_code, actor_name, action_type, from_status, to_status, event_timestamp)
      VALUES ('ORD_PROC_5', 'سارة علي', 'status_change', 'Pending', 'Processing', ?)
    `).run(`${cairoToday} 13:00:00`);

    // Order 6 morning cancellation: entered Canceled (09:15 AM)
    testDb.prepare(`
      INSERT INTO canonical_activity_events (order_code, actor_name, action_type, from_status, to_status, event_timestamp)
      VALUES ('ORD_CANC_6', 'محمد محمود', 'order_canceled', 'Pending', 'Canceled', ?)
    `).run(`${cairoToday} 09:15:00`);

    // Yesterday event (MUST NOT leak into today)
    testDb.prepare(`
      INSERT INTO canonical_activity_events (order_code, actor_name, action_type, from_status, to_status, event_timestamp)
      VALUES ('ORD_YEST_99', 'النظام', 'confirmation', 'Pending', 'Printed', ?)
    `).run(yesterdayTime);

    // 3. Compute Metrics following the new dashboard logic:

    // A. Active workflow live states
    const activeStatesRaw: any[] = testDb.prepare(`
      SELECT current_status, COUNT(*) as count
      FROM orders
      WHERE current_status IN ('New', 'Pending', 'Processing', 'Canceling')
      GROUP BY current_status
    `).all();

    const currentCounts: any = { New: 0, Pending: 0, Processing: 0, Canceling: 0, Printed: 0, Canceled: 0 };
    for (const r of activeStatesRaw) {
      currentCounts[r.current_status] = r.count;
    }

    // B. Authoritative Printed & Canceled
    const printedForDateCount = (testDb.prepare(`
      SELECT COUNT(DISTINCT o_id) as count FROM (
        SELECT c.order_code as o_id
        FROM canonical_activity_events c
        WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
          AND (c.to_status = 'Printed' OR c.action_type = 'confirmation')
          AND c.order_code IS NOT NULL AND c.order_code != ''
        UNION
        SELECT o.random_number as o_id
        FROM orders o
        WHERE o.printed_date >= ? AND o.printed_date < ?
          AND o.current_status = 'Printed'
      )
    `).get(interval.startCairo, interval.endCairo, interval.startCairo, interval.endCairo) as any)?.count || 0;

    const printedEventsCount = (testDb.prepare(`
      SELECT COUNT(*) as count
      FROM canonical_activity_events c
      WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
        AND (c.to_status = 'Printed' OR c.action_type = 'confirmation')
        AND c.order_code IS NOT NULL AND c.order_code != ''
    `).get(interval.startCairo, interval.endCairo) as any)?.count || 0;

    const canceledForDateCount = (testDb.prepare(`
      SELECT COUNT(DISTINCT c.order_code) as count
      FROM canonical_activity_events c
      WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
        AND (c.to_status = 'Canceled' OR c.action_type = 'order_canceled')
        AND c.order_code IS NOT NULL AND c.order_code != ''
    `).get(interval.startCairo, interval.endCairo) as any)?.count || 0;

    const cancelEventsCount = (testDb.prepare(`
      SELECT COUNT(*) as count
      FROM canonical_activity_events c
      WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
        AND (c.to_status = 'Canceled' OR c.action_type = 'order_canceled')
        AND c.order_code IS NOT NULL AND c.order_code != ''
    `).get(interval.startCairo, interval.endCairo) as any)?.count || 0;

    currentCounts.Printed = printedForDateCount;
    currentCounts.Canceled = canceledForDateCount;

    // C. Pending Day Movement
    const pendingStats = (testDb.prepare(`
      SELECT 
        COUNT(DISTINCT o_id) as unique_orders,
        COUNT(*) as total_events
      FROM (
        SELECT order_code as o_id FROM canonical_activity_events
        WHERE event_timestamp >= ? AND event_timestamp < ?
          AND to_status = 'Pending'
          AND order_code IS NOT NULL AND order_code != ''
        UNION ALL
        SELECT random_number as o_id FROM order_status_events
        WHERE observed_at >= ? AND observed_at < ?
          AND to_status = 'Pending'
          AND random_number IS NOT NULL AND random_number != ''
          AND NOT EXISTS (
            SELECT 1 FROM canonical_activity_events c
            WHERE c.order_code = order_status_events.random_number
              AND c.event_timestamp >= ? AND c.event_timestamp < ?
              AND c.to_status = 'Pending'
          )
      )
    `).get(
      interval.startCairo, interval.endCairo,
      interval.startCairo, interval.endCairo,
      interval.startCairo, interval.endCairo
    ) as any);

    // D. Processing Day Movement
    const processingStats = (testDb.prepare(`
      SELECT 
        COUNT(DISTINCT o_id) as unique_orders,
        COUNT(*) as total_events
      FROM (
        SELECT order_code as o_id FROM canonical_activity_events
        WHERE event_timestamp >= ? AND event_timestamp < ?
          AND to_status = 'Processing'
          AND order_code IS NOT NULL AND order_code != ''
        UNION ALL
        SELECT random_number as o_id FROM order_status_events
        WHERE observed_at >= ? AND observed_at < ?
          AND to_status = 'Processing'
          AND random_number IS NOT NULL AND random_number != ''
          AND NOT EXISTS (
            SELECT 1 FROM canonical_activity_events c
            WHERE c.order_code = order_status_events.random_number
              AND c.event_timestamp >= ? AND c.event_timestamp < ?
              AND c.to_status = 'Processing'
          )
      )
    `).get(
      interval.startCairo, interval.endCairo,
      interval.startCairo, interval.endCairo,
      interval.startCairo, interval.endCairo
    ) as any);

    console.log('1. Checking Live New Count...');
    assert.strictEqual(currentCounts.New, 2, 'Live New snapshot must be exactly 2 (ORD_NEW_1 and ORD_NEW_2)');
    console.log('   PASSED: New = 2 (Live Snapshot)');

    console.log('2. Checking Live Pending vs Day Movement...');
    assert.strictEqual(currentCounts.Pending, 1, 'Current live Pending queue balance must be 1 (ORD_PEND_4)');
    assert.strictEqual(pendingStats.unique_orders, 2, 'Cumulative orders entering Pending today must be 2 (ORD_FLOW_3 and ORD_PEND_4)');
    console.log('   PASSED: Live Pending = 1, Day Cumulative Pending Unique Orders = 2');

    console.log('3. Checking Live Processing vs Day Movement...');
    assert.strictEqual(currentCounts.Processing, 1, 'Current live Processing queue balance must be 1 (ORD_PROC_5)');
    assert.strictEqual(processingStats.unique_orders, 1, 'Cumulative orders entering Processing today must be 1 (ORD_PROC_5)');
    console.log('   PASSED: Live Processing = 1, Day Cumulative Processing Unique Orders = 1');

    console.log('4. Checking Printed Unique Orders vs Events (Deduplication)...');
    assert.strictEqual(printedForDateCount, 1, 'Printed unique orders today must be exactly 1 despite multiple confirmation events');
    assert.strictEqual(printedEventsCount, 2, 'Printed events count must accurately record all 2 events');
    console.log('   PASSED: Printed Unique Orders = 1, Printed Events = 2');

    console.log('5. Checking Canceled Unique Orders vs Events...');
    assert.strictEqual(canceledForDateCount, 1, 'Canceled unique orders today must be exactly 1');
    assert.strictEqual(cancelEventsCount, 1, 'Canceled events count must be exactly 1');
    console.log('   PASSED: Canceled Unique Orders = 1, Canceled Events = 1');

    console.log('6. Checking Cairo Day Boundary Isolation (Yesterday Exclusion)...');
    const yesterdayCheck = (testDb.prepare(`
      SELECT COUNT(*) as count FROM canonical_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ?
        AND order_code = 'ORD_YEST_99'
    `).get(interval.startCairo, interval.endCairo) as any)?.count || 0;
    assert.strictEqual(yesterdayCheck, 0, 'Yesterday events must be strictly excluded from today [00:00:00, 24:00:00)');
    console.log('   PASSED: Yesterday events isolated completely');

    console.log('===================================================================');
    console.log('  ALL DASHBOARD FULL DAY & LIVE SNAPSHOT TESTS PASSED!             ');
    console.log('===================================================================');
  } finally {
    testDb.close();
    try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  }
}

runTests().catch(err => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
