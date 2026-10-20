import assert from 'node:assert';
import { db, getCairoDateInterval, saveCoverageRecord } from '../db.ts';
import { importBatchLogFiles } from '../batchLogsImporter.ts';
import { resolveHistoricalDay } from '../historicalDayResolver.ts';
import { generateLogsIntelligenceReport } from '../logsIntelligenceService.ts';

console.log('================================================================================');
console.log('  TEST: UNIFIED HISTORICAL LOGS INGESTION, DAY REGISTRY & SMART FETCH POLICY    ');
console.log('================================================================================\n');

async function runTests() {
  const testDay1 = '2025-06-10';
  const testDay2 = '2025-06-11';
  const testDay3 = '2025-06-12';
  const unrecordedDay = '2025-06-20';

  // Step 0: Clean test dates in database
  db.exec(`
    DELETE FROM canonical_activity_events WHERE event_timestamp >= '2025-06-01' AND event_timestamp < '2025-07-01';
    DELETE FROM raw_activity_events WHERE event_timestamp >= '2025-06-01' AND event_timestamp < '2025-07-01';
    DELETE FROM historical_coverage WHERE period_date >= '2025-06-01' AND period_date < '2025-07-01';
  `);

  const initialOrdersCount = (db.prepare('SELECT count(*) as c FROM orders').get() as any).c;

  // ---------------------------------------------------------------------------
  // Test 1: Multi-day CSV Import with automatic day discovery
  // ---------------------------------------------------------------------------
  console.log('[Test 1] Importing Multi-Day CSV with 2 distinct dates (2025-06-10 & 2025-06-11)...');

  const csvContent = [
    'order_code,actor_name,raw_action_text,event_timestamp',
    `ORD_201,Hayam CS,عدل Hayam CS حالة الطلب من 'Pending' إلى 'Printed',${testDay1} 09:30:00`,
    `ORD_202,Ali CS,انشاء اوردر جديد بواسطة النظام,${testDay1} 10:15:00`,
    `ORD_201,Hayam CS,أضاف Hayam CS رقم هاتف آخر : 01055556666,${testDay1} 11:00:00`,
    `ORD_203,Sara CS,عدل Sara CS حالة الطلب من 'Pending' إلى 'Canceled',${testDay2} 14:00:00`,
    `ORD_204,Ali CS,عدل Ali CS حالة الطلب من 'Processing' إلى 'Printed',${testDay2} 16:30:00`,
  ].join('\n');

  const csvBase64 = Buffer.from(csvContent, 'utf-8').toString('base64');

  const importResult = await importBatchLogFiles([
    { fileName: 'multi_day_logs.csv', base64: csvBase64 },
  ]);

  assert.strictEqual(importResult.success, true, 'Import must succeed');
  assert.strictEqual(importResult.totalRowsRead, 5, 'Should read 5 rows');
  assert.strictEqual(importResult.totalSaved, 5, 'Should save 5 rows');
  assert.strictEqual(importResult.discoveredDates.length, 2, 'Should discover exactly 2 days');

  const day1Summary = importResult.discoveredDates.find(d => d.date === testDay1);
  const day2Summary = importResult.discoveredDates.find(d => d.date === testDay2);
  assert(day1Summary, 'Day 1 must be discovered');
  assert(day2Summary, 'Day 2 must be discovered');
  assert.strictEqual(day1Summary.savedCount, 3, 'Day 1 must have 3 saved records');
  assert.strictEqual(day2Summary.savedCount, 2, 'Day 2 must have 2 saved records');
  assert.strictEqual(day1Summary.coverageStatus, 'UNVERIFIED_SOURCE', 'Day 1 coverage must be UNVERIFIED_SOURCE');

  console.log('  ✅ Discovered 2 days accurately with UNVERIFIED_SOURCE coverage');

  // ---------------------------------------------------------------------------
  // Test 2: Ingestion Deduplication (100% duplicate protection)
  // ---------------------------------------------------------------------------
  console.log('[Test 2] Re-importing identical CSV to verify 100% deduplication...');
  const reimportResult = await importBatchLogFiles([
    { fileName: 'multi_day_logs.csv', base64: csvBase64 },
  ]);

  assert.strictEqual(reimportResult.totalSaved, 0, 'Re-imported rows must be 0 (all duplicates)');
  assert.strictEqual(reimportResult.totalDuplicates, 5, 'All 5 rows must be identified as duplicates');
  console.log('  ✅ 100% deduplication verified (0 saved, 5 duplicates)');

  // ---------------------------------------------------------------------------
  // Test 3: Central Day Resolver Policy - Case B (External Import blocks auto-pull)
  // ---------------------------------------------------------------------------
  console.log('[Test 3] Testing resolveHistoricalDay on imported day (Case B)...');
  const resDay1 = await resolveHistoricalDay(testDay1, { autoFetchMissing: true });

  assert.strictEqual(resDay1.decision, 'USE_EXTERNAL_IMPORT', 'Must decide USE_EXTERNAL_IMPORT');
  assert.strictEqual(resDay1.loadedFromCache, true, 'Must load from cache');
  assert.strictEqual(resDay1.dataSource, 'CSV_IMPORT', 'Data source must be CSV_IMPORT');
  assert.strictEqual(resDay1.completionStatus, 'UNVERIFIED_SOURCE', 'Must not falsely declare COMPLETE');
  assert.strictEqual(resDay1.rawRecordsCount, 3, 'Must have 3 raw records');
  assert.strictEqual(resDay1.canonicalEventsCount, 3, 'Must have 3 canonical events');
  console.log('  ✅ Case B verified: Imported day prevents automatic Vendoor fetching');

  // ---------------------------------------------------------------------------
  // Test 4: Central Day Resolver Policy - Case E (Completely absent day)
  // ---------------------------------------------------------------------------
  console.log('[Test 4] Testing resolveHistoricalDay on completely unrecorded day...');
  // Without autoFetchMissing, indicates day is absent
  const resAbsent = await resolveHistoricalDay(unrecordedDay, { autoFetchMissing: false });
  assert.strictEqual(resAbsent.decision, 'FETCH_FROM_VENDOOR');
  assert.strictEqual(resAbsent.dataSource, 'NONE');
  assert.strictEqual(resAbsent.completionStatus, 'NOT_SYNCED');
  assert.strictEqual(resAbsent.rawRecordsCount, 0);
  console.log('  ✅ Case E verified: Completely unrecorded day correctly identified');

  // ---------------------------------------------------------------------------
  // Test 5: Central Day Resolver Policy - Case H (Empty Day Verified)
  // ---------------------------------------------------------------------------
  console.log('[Test 5] Testing resolveHistoricalDay on verified empty day (Case H)...');
  saveCoverageRecord({
    accountId: 'primary',
    sourceDomain: 'logs',
    periodDate: testDay3,
    storageTier: 'HOT',
    pagesDiscovered: 1,
    pagesRead: 1,
    recordsExtracted: 0,
    recordsSaved: 0,
    completionStatus: 'EMPTY_VERIFIED',
    dataSource: 'VENDOOR_FETCH',
    canonicalEventsCount: 0,
    localStorageStatus: 'LOCAL_SAVED',
    notes: 'Verified empty day test',
  });

  const resEmpty = await resolveHistoricalDay(testDay3, { autoFetchMissing: true });
  assert.strictEqual(resEmpty.decision, 'EMPTY_VERIFIED');
  assert.strictEqual(resEmpty.completionStatus, 'EMPTY_VERIFIED');
  assert.strictEqual(resEmpty.loadedFromCache, true);
  console.log('  ✅ Case H verified: Empty verified day is cached and does not auto-pull');

  // ---------------------------------------------------------------------------
  // Test 6: Report Generation from Imported Logs
  // ---------------------------------------------------------------------------
  console.log('[Test 6] Generating Logs Intelligence Report for imported period...');
  const rep = generateLogsIntelligenceReport(testDay1, testDay2);

  assert.strictEqual(rep.metrics.totalLogs, 5, 'Report should contain 5 total logs');
  assert.strictEqual(rep.metrics.confirmedOrdersCount, 2, 'ORD_201 & ORD_204 reached Printed');
  assert.strictEqual(rep.metrics.canceledOrdersCount, 1, 'ORD_203 was canceled');
  assert.strictEqual(rep.metrics.createdOrdersCount, 1, 'ORD_202 was created');
  assert.strictEqual(rep.metrics.extraPhonesAddedUniqueOrders, 1, 'ORD_201 had phone added');
  assert.strictEqual(rep.status, 'PARTIAL', 'Overall status reflects UNVERIFIED_SOURCE without claiming false complete');
  console.log('  ✅ Report correctly computes all KPI pillars directly from imported logs');

  // ---------------------------------------------------------------------------
  // Test 7: Live Orders Invariance
  // ---------------------------------------------------------------------------
  console.log('[Test 7] Verifying live operational orders invariance...');
  const currentOrdersCount = (db.prepare('SELECT count(*) as c FROM orders').get() as any).c;
  assert.strictEqual(currentOrdersCount, initialOrdersCount, 'Live orders table must NOT be modified');
  console.log('  ✅ Invariance verified: 0 changes to live orders table');

  console.log('\n🎉 ALL UNIFIED HISTORICAL LOGS INGESTION TESTS PASSED! 🎉\n');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
