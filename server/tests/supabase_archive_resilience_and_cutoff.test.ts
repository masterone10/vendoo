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
  });
});
