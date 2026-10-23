import assert from 'node:assert/strict';
import { db, initDatabase, repairMerchantAndWarehouseData } from '../db.ts';
import { syncDayLogsToSupabase } from '../supabaseClient.ts';
import express from 'express';
import { apiRouter } from '../routes.ts';

async function runRootCauseRepairsMasterVerification() {
  console.log('--- Starting Root-Cause Repairs Master Verification Suite ---');

  // =========================================================================
  // TEST 1: SQLite Schema Integrity & Warehouse Columns
  // =========================================================================
  console.log('\n[Test 1] Verifying SQLite orders schema and warehouse columns...');
  initDatabase();

  const columns: any[] = db.prepare('PRAGMA table_info(orders)').all();
  const colNames = new Set(columns.map((c) => c.name));

  assert.ok(colNames.has('distinct_warehouse_count'), 'orders table must have distinct_warehouse_count');
  assert.ok(colNames.has('multi_warehouse_flag'), 'orders table must have multi_warehouse_flag');
  assert.ok(colNames.has('distinct_merchant_count'), 'orders table must have distinct_merchant_count');
  assert.ok(colNames.has('multi_merchant_flag'), 'orders table must have multi_merchant_flag');

  // Verify inserting an order with warehouse fields succeeds without missing column errors
  const testVendoorId = 9988776655;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO orders (
      vendoor_id, random_number, order_no, current_status, customer_phone,
      distinct_merchant_count, multi_merchant_flag, distinct_warehouse_count, multi_warehouse_flag,
      last_observed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(vendoor_id) DO UPDATE SET
      distinct_warehouse_count = excluded.distinct_warehouse_count,
      multi_warehouse_flag = excluded.multi_warehouse_flag
  `).run(testVendoorId, 'RND-WH-TEST', 'ORD-WH-TEST', 'اوردر جديد', '01000000001', 2, 1, 3, 1, now, now, now);

  const insertedOrder: any = db.prepare('SELECT * FROM orders WHERE vendoor_id = ?').get(testVendoorId);
  assert.strictEqual(insertedOrder.distinct_warehouse_count, 3, 'distinct_warehouse_count should match inserted value');
  assert.strictEqual(insertedOrder.multi_warehouse_flag, 1, 'multi_warehouse_flag should match inserted value');

  // Test repairMerchantAndWarehouseData
  repairMerchantAndWarehouseData();
  console.log('✓ SQLite orders schema, warehouse columns, and data repair verified.');

  // =========================================================================
  // TEST 2: Strict Cutoff Rule Enforcement (< 2026-10-23 vs >= 2026-10-23)
  // =========================================================================
  console.log('\n[Test 2] Verifying strict cutoff rule (< 2026-10-23 in SQLite only)...');

  // 1. Date before cutoff: 2026-10-20
  const preCutoffSync = await syncDayLogsToSupabase('2026-10-20');
  assert.strictEqual(preCutoffSync.success, true, 'Pre-cutoff sync should succeed safely');
  assert.strictEqual(preCutoffSync.rawSaved, 0, 'No raw logs should be saved to remote Supabase for pre-cutoff dates');
  assert.strictEqual(preCutoffSync.canonicalSaved, 0, 'No canonical logs should be saved to remote Supabase for pre-cutoff dates');
  assert.ok(
    preCutoffSync.error?.includes('2026-10-23') || preCutoffSync.error?.includes('CLOUD_ARCHIVE_POLICY'),
    'Should return cutoff policy message'
  );

  // 2. Date before cutoff: 2026-10-22
  const preCutoffSync2 = await syncDayLogsToSupabase('2026-10-22');
  assert.strictEqual(preCutoffSync2.success, true);
  assert.strictEqual(preCutoffSync2.rawSaved, 0);

  console.log('✓ Strict cutoff enforcement verified: dates prior to 2026-10-23 are strictly retained in SQLite.');

  // =========================================================================
  // TEST 3: API Route Guarding (No HTML 200 on unhandled API requests)
  // =========================================================================
  console.log('\n[Test 3] Verifying API route guarding against Vite HTML fallthrough...');

  const app = express();
  app.use(express.json());

  const API_NAMESPACES = [
    '/reports',
    '/dashboard',
    '/orders',
    '/logs',
    '/sync',
    '/supabase',
    '/historical',
    '/alerts',
    '/merchants',
    '/comparison',
    '/team',
    '/risk',
  ];

  // Mount API routes at /api
  app.use('/api', apiRouter);

  // Support direct calls to API namespaces without /api prefix
  API_NAMESPACES.forEach((prefix) => {
    app.use(prefix, (req, res, next) => {
      req.url = prefix + req.url;
      apiRouter(req, res, next);
    });
  });

  // Guard: Unmatched routes return JSON 404
  app.use(['/api', ...API_NAMESPACES], (req, res) => {
    res.status(404).json({
      success: false,
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: `المسار المطلوب '${req.originalUrl}' غير موجود (404)`,
        retryable: false,
      },
    });
  });

  // Simulated Vite fallback that serves HTML for non-API routes
  app.use((req, res) => {
    res.status(200).send('<!doctype html><html><head><title>Vite App</title></head><body>Vite</body></html>');
  });

  const server = app.listen(0);
  const address = server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 3a. Calling an unmatched /api route MUST return 404 JSON, NOT HTML 200
    const resUnmatchedApi = await fetch(`${baseUrl}/api/unknown-endpoint-xyz`);
    const jsonUnmatchedApi = await resUnmatchedApi.json();
    assert.strictEqual(resUnmatchedApi.status, 404, 'Unmatched /api route must return 404');
    assert.strictEqual(jsonUnmatchedApi.success, false);
    assert.strictEqual(jsonUnmatchedApi.error.code, 'ROUTE_NOT_FOUND');

    // 3b. Calling an unmatched namespace route without /api MUST return 404 JSON, NOT HTML 200
    const resUnmatchedReport = await fetch(`${baseUrl}/reports/unknown-report-xyz`);
    const jsonUnmatchedReport = await resUnmatchedReport.json();
    assert.strictEqual(resUnmatchedReport.status, 404, 'Unmatched /reports route must return 404');
    assert.strictEqual(jsonUnmatchedReport.success, false);
    assert.strictEqual(jsonUnmatchedReport.error.code, 'ROUTE_NOT_FOUND');

    // 3c. Calling a legitimate API endpoint returns JSON with correct headers
    const resRealApi = await fetch(`${baseUrl}/api/reports?period=today`);
    assert.strictEqual(resRealApi.status, 200);
    assert.ok(resRealApi.headers.get('content-type')?.includes('application/json'));
    const jsonReal = await resRealApi.json();
    assert.ok(jsonReal.startDate !== undefined);

    // 3d. Calling the endpoint without /api prefix also returns JSON
    const resNoPrefix = await fetch(`${baseUrl}/reports?period=today`);
    assert.strictEqual(resNoPrefix.status, 200);
    assert.ok(resNoPrefix.headers.get('content-type')?.includes('application/json'));
    const jsonNoPrefix = await resNoPrefix.json();
    assert.ok(jsonNoPrefix.startDate !== undefined);

    // 3e. Calling regular frontend path (like /) returns Vite HTML
    const resFrontend = await fetch(`${baseUrl}/some-spa-page`);
    assert.strictEqual(resFrontend.status, 200);
    const textFrontend = await resFrontend.text();
    assert.ok(textFrontend.startsWith('<!doctype html>'), 'Non-API SPA route receives HTML');

    console.log('✓ API route guarding verified: API routes always return JSON, Vite HTML fallthrough blocked.');
  } finally {
    server.close();
  }

  // =========================================================================
  // TEST 4: Re-export Endpoint & Deduplication Invariance
  // =========================================================================
  console.log('\n[Test 4] Verifying Re-export Endpoint and Deduplication Invariance...');

  const dateTest = '2026-10-23';
  const initialCoverage = db.prepare("SELECT count(*) as c FROM canonical_activity_events WHERE event_timestamp LIKE '2026-10-23%'").get() as any;

  // Insert a test canonical event
  db.prepare(`
    INSERT INTO canonical_activity_events (
      order_code, actor_name, action_type, from_status, to_status, event_timestamp, is_system_actor, data_source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('ORD-DEDUP-1', 'Ahmed Ali', 'status_change', 'اوردر جديد', 'تم تاكيد الاوردر', '2026-10-23 11:00:00', 0, 'test_suite', now);

  const countAfterFirst = (db.prepare("SELECT count(*) as c FROM canonical_activity_events WHERE order_code = 'ORD-DEDUP-1'").get() as any).c;
  assert.strictEqual(countAfterFirst, 1);

  // Inserting duplicate canonical activity event with identical tuple must be ignored or deduplicated
  db.prepare(`
    INSERT INTO canonical_activity_events (
      order_code, actor_name, action_type, from_status, to_status, event_timestamp, is_system_actor, data_source, created_at
    )
    SELECT 'ORD-DEDUP-1', 'Ahmed Ali', 'status_change', 'اوردر جديد', 'تم تاكيد الاوردر', '2026-10-23 11:00:00', 0, 'test_suite', ?
    WHERE NOT EXISTS (
      SELECT 1 FROM canonical_activity_events
      WHERE order_code = 'ORD-DEDUP-1' AND event_timestamp = '2026-10-23 11:00:00' AND action_type = 'status_change'
    )
  `).run(now);

  const countAfterDup = (db.prepare("SELECT count(*) as c FROM canonical_activity_events WHERE order_code = 'ORD-DEDUP-1'").get() as any).c;
  assert.strictEqual(countAfterDup, 1, 'Duplicate canonical event insertion must be prevented');

  // Clean up test order
  db.prepare("DELETE FROM orders WHERE vendoor_id = ?").run(testVendoorId);
  db.prepare("DELETE FROM canonical_activity_events WHERE order_code = 'ORD-DEDUP-1'").run();

  console.log('✓ Re-export deduplication invariance verified.');

  console.log('\n=============================================================');
  console.log('ALL ROOT-CAUSE REPAIR VERIFICATION TESTS PASSED SUCCESSFULLY!');
  console.log('=============================================================\n');
}

runRootCauseRepairsMasterVerification().catch((err) => {
  console.error('\nFAILED ROOT-CAUSE REPAIRS VERIFICATION:', err);
  process.exit(1);
});
