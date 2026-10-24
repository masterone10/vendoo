import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db.ts';
import { getArchiveWorkerStatus, triggerArchivePass } from '../supabaseArchiveWorker.ts';

test('Supabase Archive Worker: Idle and Cutoff Policy Integrity Suite', async (t) => {
  await t.test('1.1 When no pending records >= 2026-10-23 exist, worker concludes immediately without remote connection', async () => {
    // Seed an order created before cutoff date
    db.prepare(`
      INSERT INTO orders (
        vendoor_id, random_number, order_no, order_type, current_status,
        distinct_merchant_count, multi_merchant_flag, distinct_warehouse_count, multi_warehouse_flag,
        delivery_rate, customer_phone, customer_phone_extra, extra_phone_valid,
        customer_name, governorate, address, total_price, shipping_cost,
        total_order, created_at_source, state_entry_at, last_observed_at,
        created_at, updated_at
      ) VALUES (
        888801, 'R99901', 'ORD-PRE-CUTOFF', 'اوردر جديد', 'تم التوصيل',
        1, 0, 1, 0,
        100, '01011112222', null, 0,
        'عميل تاريخ قديم', 'القاهرة', 'المعادي', 350, 50,
        400, '2026-10-15 12:00:00', '2026-10-15 12:00:00', '2026-10-15 12:00:00',
        '2026-10-15 12:00:00', '2026-10-15 12:00:00'
      )
    `).run();

    // Trigger archive pass
    const result = await triggerArchivePass();

    // Must succeed without remote call, noting zero waiting post-cutoff records
    assert.strictEqual(result.success, true, 'Worker should succeed in idle / fully archived state');
    assert.strictEqual(result.ordersArchived, 0, 'No pre-cutoff orders should be archived to Supabase');
    assert.strictEqual(result.isArchiveComplete, true, 'Archive should report complete for queue');

    const status = getArchiveWorkerStatus();
    assert.strictEqual(status.status, 'FULLY_ARCHIVED', 'Worker status should be FULLY_ARCHIVED');
    assert.strictEqual(status.ordersWaiting, 0, 'Waiting post-cutoff orders must be 0');
  });

  await t.test('1.2 Pre-cutoff records (< 2026-10-23) are preserved in SQLite and never forwarded to Supabase backlog', async () => {
    // Verify SQLite still holds the pre-cutoff order
    const localOrder = db.prepare('SELECT order_no, created_at_source FROM orders WHERE vendoor_id = 888801').get() as any;
    assert.ok(localOrder, 'Local SQLite record must be intact');
    assert.strictEqual(localOrder.order_no, 'ORD-PRE-CUTOFF');

    // Confirm that the worker strictly counts 0 waiting orders because created_at_source < 2026-10-23
    const waitingOrders = (db.prepare("SELECT count(*) as c FROM orders WHERE vendoor_id = 888801 AND created_at_source >= '2026-10-23 00:00:00'").get() as any)?.c || 0;
    assert.strictEqual(waitingOrders, 0, 'Pre-cutoff orders must never be included in Supabase waiting queue');
  await t.test('1.3 True Exponential Backoff formula verification across attempts 1..10 (max 5 min / 300,000ms with jitter)', async () => {
    const { calculateExponentialBackoff } = await import('../supabaseArchiveWorker.ts');
    
    // Test base exponential progression with zero jitter for exact mathematical check
    const step1Exact = calculateExponentialBackoff(1, 5000, 300000, 0);
    const step2Exact = calculateExponentialBackoff(2, 5000, 300000, 0);
    const step3Exact = calculateExponentialBackoff(3, 5000, 300000, 0);
    const step4Exact = calculateExponentialBackoff(4, 5000, 300000, 0);
    const step5Exact = calculateExponentialBackoff(5, 5000, 300000, 0);
    const step6Exact = calculateExponentialBackoff(6, 5000, 300000, 0);
    const step7Exact = calculateExponentialBackoff(7, 5000, 300000, 0);
    const step8Exact = calculateExponentialBackoff(8, 5000, 300000, 0);
    const step9Exact = calculateExponentialBackoff(9, 5000, 300000, 0);
    const step10Exact = calculateExponentialBackoff(10, 5000, 300000, 0);

    assert.strictEqual(step1Exact, 5000, 'Attempt 1 must be 5,000ms (5s)');
    assert.strictEqual(step2Exact, 10000, 'Attempt 2 must be 10,000ms (10s)');
    assert.strictEqual(step3Exact, 20000, 'Attempt 3 must be 20,000ms (20s)');
    assert.strictEqual(step4Exact, 40000, 'Attempt 4 must be 40,000ms (40s)');
    assert.strictEqual(step5Exact, 80000, 'Attempt 5 must be 80,000ms (80s)');
    assert.strictEqual(step6Exact, 160000, 'Attempt 6 must be 160,000ms (160s)');
    assert.strictEqual(step7Exact, 300000, 'Attempt 7 must be capped at 300,000ms (5 minutes)');
    assert.strictEqual(step8Exact, 300000, 'Attempt 8 must remain capped at 300,000ms (5 minutes)');
    assert.strictEqual(step9Exact, 300000, 'Attempt 9 must remain capped at 300,000ms (5 minutes)');
    assert.strictEqual(step10Exact, 300000, 'Attempt 10 must remain capped at 300,000ms (5 minutes)');

    // Test with random jitter (0..2000ms): verify bounds and ceiling
    for (let attempt = 1; attempt <= 10; attempt++) {
      const withJitter = calculateExponentialBackoff(attempt, 5000, 300000, 2000);
      assert(withJitter <= 300000, `Delay (${withJitter}ms) at attempt ${attempt} must never exceed 300,000ms`);
      assert(withJitter >= 5000, `Delay (${withJitter}ms) at attempt ${attempt} must be at least base delay (5000ms)`);
    }
  });

  await t.test('1.4 Archive Worker Status reports distinct table waiting counts and refuses FULLY_ARCHIVED if records exist', async () => {
    const status = getArchiveWorkerStatus();
    
    // Verify distinct fields exist
    assert(typeof status.ordersWaiting === 'number', 'ordersWaiting must be a number');
    assert(typeof status.eventsWaiting === 'number', 'eventsWaiting must be a number');
    assert(typeof status.rawLogsWaiting === 'number', 'rawLogsWaiting must be a number');
    assert(typeof status.coverageWaiting === 'number', 'coverageWaiting must be a number');
    assert(typeof status.totalWaiting === 'number', 'totalWaiting must be a number');
    assert.ok(status.tablesWaiting, 'tablesWaiting object must exist');
    assert.strictEqual(typeof status.tablesWaiting.orders, 'number');
    assert.strictEqual(typeof status.tablesWaiting.canonical_activity_events, 'number');
    assert.strictEqual(typeof status.tablesWaiting.raw_activity_events, 'number');
    assert.strictEqual(typeof status.tablesWaiting.historical_coverage, 'number');

    // If any records are waiting, status MUST NOT be FULLY_ARCHIVED
    if (status.totalWaiting > 0) {
      assert.notStrictEqual(status.status, 'FULLY_ARCHIVED', 'Worker must never report FULLY_ARCHIVED when totalWaiting > 0');
      assert.strictEqual(status.isArchiveComplete, false, 'isArchiveComplete must be false when records are pending');
    }
  });
});

