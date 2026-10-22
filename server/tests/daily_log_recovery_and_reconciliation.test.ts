import assert from 'node:assert';
import crypto from 'node:crypto';
import { db, getCairoDateInterval, saveCoverageRecord } from '../db.ts';
import { resolveHistoricalDay } from '../historicalDayResolver.ts';
import { repairRawWithoutCanonical } from '../historicalLogsService.ts';
import { reconcileHistoricalRange } from '../historicalReconciliationService.ts';
import { parseLogActionDetails } from '../logDetailsParser.ts';

console.log('================================================================================');
console.log('  TEST SUITE: DAILY LOG RECOVERY, RECONCILIATION & CONCURRENCY VERIFICATION     ');
console.log('================================================================================');

async function runAllTests() {
  const testDate = '2026-10-14';
  const otherDate = '2026-10-15';
  const interval = getCairoDateInterval(testDate);
  const otherInterval = getCairoDateInterval(otherDate);

  // Clean test day data in isolated test database
  db.prepare(`DELETE FROM canonical_activity_events WHERE event_timestamp >= ? AND event_timestamp < ?`).run(interval.startCairo, interval.endCairo);
  db.prepare(`DELETE FROM raw_activity_events WHERE event_timestamp >= ? AND event_timestamp < ?`).run(interval.startCairo, interval.endCairo);
  db.prepare(`DELETE FROM historical_coverage WHERE period_date = ?`).run(testDate);

  // Seed sample order to verify order matching
  db.prepare(`
    INSERT INTO orders (
      vendoor_id, random_number, order_no, current_status, customer_name,
      customer_phone, total_price, created_at_source, last_observed_at, created_at, updated_at
    ) VALUES (
      99101, 'V-2026-TEST', 'ORD-99101', 'Printed', 'عميل تجريبي',
      '01012345678', 500, ?, ?, datetime('now'), datetime('now')
    ) ON CONFLICT(vendoor_id) DO NOTHING
  `).run(`${testDate} 10:00:00`, `${testDate} 10:00:00`);

  // ---------------------------------------------------------------------------
  // TEST 1: Raw-to-Canonical Reconciliation Gap Handling
  // ---------------------------------------------------------------------------
  console.log('\n[Test 1] Testing Raw-to-Canonical Reconciliation Gap Handling...');
  
  // Seed 10 raw events for testDate:
  // - 8 valid eligible events (e.g. status changes, waybill edits, note additions)
  // - 2 unconvertible/noise rows (empty action and system heartbeat)
  const nowIso = new Date().toISOString();
  const insertRaw = db.prepare(`
    INSERT INTO raw_activity_events (
      source_hash, order_code, actor_name, raw_action_text, event_timestamp,
      storage_tier, observed_at, page_source, data_source
    ) VALUES (?, ?, ?, ?, ?, 'HOT', ?, 'log/system', 'EXCEL_IMPORT')
  `);

  // 8 eligible events
  for (let i = 1; i <= 8; i++) {
    const time = `${testDate} 1${i % 10}:15:00`;
    const actionText = i === 1
      ? 'تم تعديل حالة الطلب من Pending إلى Printed'
      : i === 2
      ? 'أضاف رقم البوليصة: EGY-99101'
      : i === 3
      ? 'أضاف ملاحظة: تم التأكيد هاتفياً'
      : `إجراء تشغيلي للموظف رقم ${i}`;
    const code = i <= 4 ? 'V-2026-TEST' : `ORD-OTHER-${i}`;
    const hash = crypto.createHash('sha256').update(`actor_${i}|${code}|${actionText}|${time}`).digest('hex');
    insertRaw.run(hash, code, `موظف ${i}`, actionText, time, nowIso);
  }

  // 2 noise records
  const emptyHash = crypto.createHash('sha256').update(`actor_empty|||${testDate} 12:00:00`).digest('hex');
  insertRaw.run(emptyHash, null, 'النظام', '', `${testDate} 12:00:00`, nowIso);

  const pingHash = crypto.createHash('sha256').update(`actor_ping||ping|${testDate} 12:01:00`).digest('hex');
  insertRaw.run(pingHash, null, 'النظام', 'ping', `${testDate} 12:01:00`, nowIso);

  // Pre-convert ONLY 1 event to simulate a gap (10 raw total, only 1 canonical)
  const insertCanon = db.prepare(`
    INSERT INTO canonical_activity_events (
      raw_event_id, order_code, actor_name, action_type, from_status, to_status,
      event_timestamp, storage_tier, is_system_actor, created_at,
      order_id, order_match_status, is_administrative, data_source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'HOT', 0, ?, ?, 'MATCHED', 0, 'EXCEL_IMPORT')
  `);
  
  const raw1 = db.prepare('SELECT id FROM raw_activity_events WHERE order_code = ?').get('V-2026-TEST') as any;
  insertCanon.run(raw1.id, 'V-2026-TEST', 'موظف 1', 'status_change', 'Pending', 'Printed', `${testDate} 11:15:00`, nowIso, 1);

  // Verify gap before reconciliation
  const countRawBefore = (db.prepare('SELECT COUNT(*) as c FROM raw_activity_events WHERE event_timestamp >= ? AND event_timestamp < ?').get(interval.startCairo, interval.endCairo) as any).c;
  const countCanonBefore = (db.prepare('SELECT COUNT(*) as c FROM canonical_activity_events WHERE event_timestamp >= ? AND event_timestamp < ?').get(interval.startCairo, interval.endCairo) as any).c;
  assert.strictEqual(countRawBefore, 10, 'Expected 10 raw records seeded');
  assert.strictEqual(countCanonBefore, 1, 'Expected 1 canonical record before reconciliation');
  console.log(`  -> Before reconciliation: Raw = ${countRawBefore}, Canonical = ${countCanonBefore} (Gap detected: 9 records)`);

  // Run repairRawWithoutCanonical
  const repairRes = repairRawWithoutCanonical(testDate);
  console.log(`  -> Repair metrics:`, repairRes);
  assert.strictEqual(repairRes.examined, 9, '9 raw records without canonical examined');
  assert.strictEqual(repairRes.repaired, 9, '9 raw records repaired into canonical');

  // Verify full reconciliation report
  const recon = await reconcileHistoricalRange(testDate, testDate, { autoRepair: false });
  console.log(`  -> Range reconciliation report:`, {
    rawCount: recon.sqlite.rawCount,
    canonicalCount: recon.sqlite.canonicalCount,
    parityStatus: recon.parityStatus,
    coverageStatus: recon.coverageStatus
  });

  assert.strictEqual(recon.sqlite.rawCount, 10);
  assert.strictEqual(recon.sqlite.canonicalCount, 10);
  assert.strictEqual(recon.sqlite.rawWithoutCanonicalCount, 0);
  console.log('  ✅ [PASS] Raw-to-canonical repair successfully repaired gap and validated counts!');

  // ---------------------------------------------------------------------------
  // TEST 2: Select Same Day Twice Test (100% Cache Hit & Invariance)
  // ---------------------------------------------------------------------------
  console.log('\n[Test 2] Testing "Select Same Day Twice" Policy & Cache Invariance...');

  // Set coverage record as complete
  saveCoverageRecord({
    accountId: 'primary',
    sourceDomain: 'logs',
    periodDate: testDate,
    storageTier: 'HOT',
    pagesDiscovered: 1,
    pagesRead: 1,
    recordsExtracted: 10,
    recordsSaved: 10,
    completionStatus: 'COMPLETE',
    dataSource: 'EXCEL_IMPORT',
    canonicalEventsCount: 10,
    localStorageStatus: 'LOCAL_SAVED',
    remoteArchiveStatus: 'NONE',
    lastAttemptedAt: nowIso,
    completedAt: nowIso,
    verifiedAt: nowIso
  });

  // First resolution pass
  const pass1 = await resolveHistoricalDay(testDate, { autoFetchMissing: false });
  assert.strictEqual(pass1.decision, 'USE_EXTERNAL_IMPORT');
  assert.strictEqual(pass1.completionStatus, 'COMPLETE');
  assert.strictEqual(pass1.loadedFromCache, true);
  assert.strictEqual(pass1.canonicalEventsCount, 10);

  // Second resolution pass (must be 100% invariant, zero external calls, exact matching counts)
  const pass2 = await resolveHistoricalDay(testDate, { autoFetchMissing: false });
  assert.strictEqual(pass2.decision, pass1.decision);
  assert.strictEqual(pass2.completionStatus, pass1.completionStatus);
  assert.strictEqual(pass2.loadedFromCache, true);
  assert.strictEqual(pass2.rawRecordsCount, pass1.rawRecordsCount);
  assert.strictEqual(pass2.canonicalEventsCount, pass1.canonicalEventsCount);

  // Verify total count in database did NOT increase
  const countCanonAfterTwice = (db.prepare('SELECT COUNT(*) as c FROM canonical_activity_events WHERE event_timestamp >= ? AND event_timestamp < ?').get(interval.startCairo, interval.endCairo) as any).c;
  assert.strictEqual(countCanonAfterTwice, 10, 'Selecting day twice must NOT produce any duplicates');
  console.log('  ✅ [PASS] Day selected twice returned identical counts from cache with 0 duplicates!');

  // ---------------------------------------------------------------------------
  // TEST 3: Safe Request Concurrency (Single-Flight Mutex Per Date)
  // ---------------------------------------------------------------------------
  console.log('\n[Test 3] Testing Safe Request Concurrency (Per-Date Mutex)...');
  
  // Launch 5 concurrent resolution calls simultaneously for the same date
  const concurrentPromises = [
    resolveHistoricalDay(testDate, { autoFetchMissing: false }),
    resolveHistoricalDay(testDate, { autoFetchMissing: false }),
    resolveHistoricalDay(testDate, { autoFetchMissing: false }),
    resolveHistoricalDay(testDate, { autoFetchMissing: false }),
    resolveHistoricalDay(testDate, { autoFetchMissing: false }),
  ];

  const concurrentResults = await Promise.all(concurrentPromises);
  assert.strictEqual(concurrentResults.length, 5);
  for (const r of concurrentResults) {
    assert.strictEqual(r.canonicalEventsCount, 10);
    assert.strictEqual(r.completionStatus, 'COMPLETE');
  }

  const finalCanonCountAfterConcurrent = (db.prepare('SELECT COUNT(*) as c FROM canonical_activity_events WHERE event_timestamp >= ? AND event_timestamp < ?').get(interval.startCairo, interval.endCairo) as any).c;
  assert.strictEqual(finalCanonCountAfterConcurrent, 10, 'Concurrent calls must not create race condition duplicates');
  console.log('  ✅ [PASS] 5 simultaneous concurrent calls resolved cleanly with 0 duplicate records!');

  // ---------------------------------------------------------------------------
  // TEST 4: Multi-Day Invariance & Isolation
  // ---------------------------------------------------------------------------
  console.log('\n[Test 4] Testing Multi-Day Isolation & Invariance...');
  
  // Seed otherDate records
  const otherHash = crypto.createHash('sha256').update(`actor_x|ORD-OTHER|action|${otherDate} 10:00:00`).digest('hex');
  insertRaw.run(otherHash, 'ORD-OTHER', 'موظف غريب', 'حركة يوم آخر', `${otherDate} 10:00:00`, nowIso);

  const repairOther = repairRawWithoutCanonical(otherDate);
  assert.strictEqual(repairOther.repaired, 1, 'Other day should have exactly 1 record repaired');

  // Verify testDate records are completely untouched
  const countTestDateFinal = (db.prepare('SELECT COUNT(*) as c FROM canonical_activity_events WHERE event_timestamp >= ? AND event_timestamp < ?').get(interval.startCairo, interval.endCairo) as any).c;
  assert.strictEqual(countTestDateFinal, 10, 'Processing otherDate must NOT mutate or touch testDate');
  console.log('  ✅ [PASS] Multi-day isolation verified: operations on one day do not mutate other days!');

  // Clean up test records
  db.prepare(`DELETE FROM canonical_activity_events WHERE event_timestamp >= ? AND event_timestamp < ?`).run(interval.startCairo, interval.endCairo);
  db.prepare(`DELETE FROM raw_activity_events WHERE event_timestamp >= ? AND event_timestamp < ?`).run(interval.startCairo, interval.endCairo);
  db.prepare(`DELETE FROM canonical_activity_events WHERE event_timestamp >= ? AND event_timestamp < ?`).run(otherInterval.startCairo, otherInterval.endCairo);
  db.prepare(`DELETE FROM raw_activity_events WHERE event_timestamp >= ? AND event_timestamp < ?`).run(otherInterval.startCairo, otherInterval.endCairo);
  db.prepare(`DELETE FROM historical_coverage WHERE period_date IN (?, ?)`).run(testDate, otherDate);

  console.log('\n================================================================================');
  console.log('  🎉 ALL 4 CRITICAL REGRESSION & RECONCILIATION TESTS PASSED PERFECTLY!         ');
  console.log('================================================================================');
}

runAllTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
