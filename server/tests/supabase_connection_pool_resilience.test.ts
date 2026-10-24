import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../db.ts';
import {
  getDatabaseUrl,
  getSupabasePool,
  pgQuery,
  getPoolTelemetry,
  resetSupabasePool,
  shutdownSupabasePool,
} from '../supabaseClient.ts';
import { getArchiveWorkerStatus, triggerArchivePass } from '../supabaseArchiveWorker.ts';

test('Supabase Connection Pool Resilience & Session Mode Suite', async (t) => {
  await t.test('1.1 getDatabaseUrl normalizes Supabase Transaction Pooler (6543) to Session Pooler (5432)', () => {
    const originalEnv = process.env.DATABASE_URL;
    try {
      process.env.DATABASE_URL = 'postgresql://postgres.testref:pass@aws-1-eu-central-1.pooler.supabase.com:6543/postgres';
      const normalized = getDatabaseUrl();
      assert.ok(normalized, 'Normalized URL must be returned');
      assert.strictEqual(
        normalized,
        'postgresql://postgres.testref:pass@aws-1-eu-central-1.pooler.supabase.com:5432/postgres',
        'Port 6543 must be normalized to Session Pooler port 5432'
      );
    } finally {
      process.env.DATABASE_URL = originalEnv;
    }
  });

  await t.test('1.2 Process-wide Pool Singleton: Multiple calls return the exact same Pool instance', () => {
    const pool1 = getSupabasePool();
    const pool2 = getSupabasePool();
    assert.strictEqual(pool1, pool2, 'getSupabasePool() must return the identical singleton instance');
    assert.strictEqual((pool1 as any).options.max, 3, 'Pool size must be configured to 3 connections as specified');
  });

  await t.test('1.3 Idle connection drops (ECLIENTSOCKETCLOSED / Connection terminated) do NOT destroy the pool', () => {
    const poolBefore = getSupabasePool();

    // Simulate an idle client error emitted on the pool instance
    const idleError = new Error('Connection terminated due to connection timeout');
    (idleError as any).code = '57P01';

    poolBefore.emit('error', idleError);

    // The singleton pool must remain intact and NOT be nullified or reset
    const poolAfter = getSupabasePool();
    assert.strictEqual(poolBefore, poolAfter, 'Idle client disconnects must NOT tear down the shared pool');
  });

  await t.test('1.4 pgQuery executes real query and separates timing telemetry with correlation ID', async () => {
    const cid = `test_resilience_${Date.now()}`;
    const telemetryBefore = getPoolTelemetry();

    const res = await pgQuery<{ val: number }>(
      'SELECT 42 as val',
      [],
      { correlationId: cid, operationName: 'test_timing_verification' }
    );

    assert.ok(res.rows && res.rows.length > 0, 'Query must return results');
    assert.strictEqual(Number(res.rows[0].val), 42, 'SELECT 42 must return 42');

    const telemetryAfter = getPoolTelemetry();
    assert.ok(telemetryAfter.totalAcquires > telemetryBefore.totalAcquires, 'Connection acquire count must increase');
    assert.ok(telemetryAfter.totalReleases > telemetryBefore.totalReleases, 'Connection release count must increase');
    assert.strictEqual(
      telemetryAfter.totalAcquires,
      telemetryAfter.totalReleases,
      'Every acquired connection must be properly released back to the pool'
    );
  });

  await t.test('1.5 Concurrent requests share the pool cleanly within max limit (3 connections)', async () => {
    const concurrentQueries = Array.from({ length: 6 }, (_, i) =>
      pgQuery<{ n: number }>(`SELECT ${i + 1} as n`, [], {
        correlationId: `concurrent_${i}_${Date.now()}`,
        operationName: 'concurrent_test',
      })
    );

    const results = await Promise.all(concurrentQueries);
    assert.strictEqual(results.length, 6, 'All 6 concurrent queries must complete successfully');
    for (let i = 0; i < 6; i++) {
      assert.strictEqual(Number(results[i].rows[0].n), i + 1);
    }

    const telemetry = getPoolTelemetry();
    assert.ok(telemetry.totalCount <= 3, 'Total pool connections must never exceed max 3');
  });

  await t.test('1.6 SQLite persistence safety: All records remain in SQLite and are NOT lost on transient network interruptions', async () => {
    // Insert test order with created_at_source >= 2026-10-23
    db.prepare(`
      INSERT INTO orders (
        vendoor_id, random_number, order_no, order_type, current_status,
        distinct_merchant_count, multi_merchant_flag, distinct_warehouse_count, multi_warehouse_flag,
        delivery_rate, customer_phone, customer_phone_extra, extra_phone_valid,
        customer_name, governorate, address, total_price, shipping_cost,
        total_order, created_at_source, state_entry_at, last_observed_at,
        created_at, updated_at
      ) VALUES (
        999901, 'R99901', 'ORD-RESILIENCE-TEST', 'اوردر جديد', 'معلق',
        1, 0, 1, 0,
        90, '01099998888', null, 0,
        'عميل فحص الاستقرار', 'الجيزة', 'الدقي', 400, 40,
        440, '2026-10-24 10:00:00', '2026-10-24 10:00:00', '2026-10-24 10:00:00',
        '2026-10-24 10:00:00', '2026-10-24 10:00:00'
      )
    `).run();

    // Verify row is physically in SQLite
    const savedOrder = db.prepare('SELECT vendoor_id, order_no FROM orders WHERE vendoor_id = 999901').get() as any;
    assert.ok(savedOrder, 'Record must exist in local SQLite');
    assert.strictEqual(savedOrder.order_no, 'ORD-RESILIENCE-TEST');

    // Run archive pass
    const passResult = await triggerArchivePass();
    assert.strictEqual(typeof passResult.success, 'boolean');

    // Regardless of pass outcome, SQLite record MUST still exist (zero loss guarantee)
    const orderAfterPass = db.prepare('SELECT vendoor_id, order_no FROM orders WHERE vendoor_id = 999901').get() as any;
    assert.ok(orderAfterPass, 'SQLite record must never be deleted during or after archive attempts');
    assert.strictEqual(orderAfterPass.order_no, 'ORD-RESILIENCE-TEST');
  });

  await t.test('1.7 Clean shutdown: shutdownSupabasePool releases pool cleanly', async () => {
    await shutdownSupabasePool();
    // After shutdown, getSupabasePool creates a fresh pool when invoked on demand
    const freshPool = getSupabasePool();
    assert.ok(freshPool, 'Fresh pool must be created on next call');
    assert.strictEqual((freshPool as any).options.max, 3);
  });
});
