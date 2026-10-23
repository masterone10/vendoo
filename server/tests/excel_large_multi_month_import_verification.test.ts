import assert from 'node:assert';
import * as XLSX from 'xlsx';
import { db, getCairoDateInterval } from '../db.ts';
import { importBatchLogFiles } from '../batchLogsImporter.ts';
import { isSupabaseConfigured, pgQuery } from '../supabaseClient.ts';

console.log('================================================================================');
console.log('  TEST: EXCEL MULTI-MONTH IMPORT, DATE DISCOVERY & IDEMPOTENCE VERIFICATION     ');
console.log('================================================================================\n');

async function runMultiMonthImportVerification() {
  const testPrefix = 'MM_TEST_';

  // Step 0: Ensure clean test state for test prefix
  db.exec(`
    DELETE FROM canonical_activity_events WHERE order_code LIKE '${testPrefix}%';
    DELETE FROM raw_activity_events WHERE order_code LIKE '${testPrefix}%';
  `);

  if (isSupabaseConfigured()) {
    try {
      await pgQuery(`DELETE FROM canonical_activity_events WHERE order_code LIKE '${testPrefix}%'`);
      await pgQuery(`DELETE FROM raw_activity_events WHERE order_code LIKE '${testPrefix}%'`);
    } catch {}
  }

  // ---------------------------------------------------------------------------
  // Build realistic multi-month Excel spreadsheet with diverse date formats:
  // Month 1: 2025-01-10, 2025-01-15 (Excel serial numbers & ISO)
  // Month 2: 2025-02-05, 2025-02-20 (Arabic AM/PM & Arabic numerals)
  // Month 3: 2025-03-01, 2025-03-18 (US MM/DD/YYYY & standard DD/MM/YYYY)
  // Month 4: 2025-04-12, 2025-04-25 (Mixed datetime formats)
  // Plus 3 deliberately invalid rows (missing timestamp, invalid string, empty action)
  // ---------------------------------------------------------------------------
  console.log('[Step 1] Constructing realistic multi-month Excel workbook with title row...');

  const rows: any[][] = [
    // Row 1: Title / Report metadata (common in Vendoor and ERP exports)
    ['تقرير حركات وسجلات النظام الموحد - فيندور', '', '', '', ''],
    // Row 2: Authoritative headers
    ['كود الطلب', 'الموظف', 'نص الحركة', 'تاريخ ووقت الحركة', 'رقم الطلب'],
  ];

  // 2025-01-10: Excel serial number 45667.45 (2025-01-10 10:48:00)
  rows.push([`${testPrefix}001`, 'Hayam CS', 'عدل Hayam CS حالة الطلب من Pending إلى Printed', 45667.45, 9001]);
  rows.push([`${testPrefix}002`, 'Ali CS', 'أضاف Ali CS رقم هاتف آخر : 01012345678', 45667.55, 9002]);

  // 2025-01-15: Standard ISO
  rows.push([`${testPrefix}003`, 'Sara CS', 'عدل Sara CS حالة الطلب من Processing إلى Printed', '2025-01-15 14:20:00', 9003]);

  // 2025-02-05: Arabic PM
  rows.push([`${testPrefix}004`, 'Hayam CS', 'عدل Hayam CS حالة الطلب من Pending إلى Printed', '05/02/2025 04:30 م', 9004]);
  rows.push([`${testPrefix}005`, 'System', 'انشاء اوردر جديد بواسطة النظام', '05/02/2025 09:15 ص', 9005]);

  // 2025-02-20: Arabic-Indic numerals
  rows.push([`${testPrefix}006`, 'Ali CS', 'عدل Ali CS حالة الطلب من Processing إلى Canceled', '٢٠/٠٢/٢٠٢٥ ١٥:٠٠:٠٠', 9006]);

  // 2025-03-01: Localized DD/MM/YYYY
  rows.push([`${testPrefix}007`, 'Sara CS', 'عدل Sara CS حالة الطلب من Pending إلى Printed', '01/03/2025 11:45 AM', 9007]);

  // 2025-03-18: Localized DD-MM-YYYY
  rows.push([`${testPrefix}008`, 'Hayam CS', 'أضاف Hayam CS رقم هاتف آخر : 01198765432', '18-03-2025 16:30:00', 9008]);

  // 2025-03-24: US format MM/DD/YYYY with day > 12
  rows.push([`${testPrefix}008b`, 'Hayam CS', 'عدل Hayam CS حالة الطلب من Pending إلى Processing', '03/24/2025 10:00 AM', 90082]);

  // 2025-04-12: Standard string
  rows.push([`${testPrefix}009`, 'Ali CS', 'عدل Ali CS حالة الطلب من Pending إلى Printed', '2025-04-12 12:00:00', 9009]);

  // 2025-04-25: Excel serial number 45772.35 (2025-04-25 08:24:00)
  rows.push([`${testPrefix}010`, 'Sara CS', 'عدل Sara CS حالة الطلب من Processing إلى Printed', 45772.35, 9010]);

  // 3 Deliberately invalid rows:
  // Invalid 1: completely unparseable date
  rows.push([`${testPrefix}991`, 'Ali CS', 'حركة ذات تاريخ غير معروف', 'تاريخ_غير_صالح', 9991]);
  // Invalid 2: empty date
  rows.push([`${testPrefix}992`, 'Hayam CS', 'حركة بدون تاريخ', '', 9992]);
  // Invalid 3: valid date but empty action text
  rows.push([`${testPrefix}993`, 'Sara CS', '', '2025-04-25 12:00:00', 9993]);

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'System Logs');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  console.log(`  -> Generated workbook buffer: ${buffer.length} bytes with ${rows.length - 2} data rows across 4 months.\n`);

  // ---------------------------------------------------------------------------
  // Step 2: First-time Import
  // ---------------------------------------------------------------------------
  console.log('[Step 2] Executing importBatchLogFiles on multi-month workbook...');
  const importRes = await importBatchLogFiles([
    { fileName: 'vendoor_system_logs_multi_month.xlsx', buffer }
  ], 'test_mm');

  console.log('\n--- FIRST IMPORT ACTUAL METRICS ---');
  console.log(`  - Total Rows Read:            ${importRes.totalRowsRead}`);
  console.log(`  - Valid Rows Processed:       ${importRes.totalSaved}`);
  console.log(`  - Discovered Days Count:      ${importRes.discoveredDates.length}`);
  console.log(`  - Duplicates Detected:        ${importRes.totalDuplicates}`);
  console.log(`  - Unparseable / Rejected:     ${importRes.unparseableRows}`);
  console.log(`  - Batch ID:                   ${importRes.batchId}`);

  console.log('\n--- DISCOVERED DATES BREAKDOWN ---');
  for (const d of importRes.discoveredDates) {
    console.log(`    Date: ${d.date} | Rows: ${d.rowsCount} | Saved: ${d.savedCount} | Dupes: ${d.duplicatesCount} | Remote: ${d.remoteArchiveStatus}`);
  }

  // Strict Assertions
  assert.strictEqual(importRes.success, true, 'Import must succeed');
  assert.strictEqual(importRes.totalRowsRead, 14, 'Must read exactly 14 data rows');
  assert.strictEqual(importRes.unparseableRows, 3, 'Must reject exactly 3 invalid rows');
  assert.strictEqual(importRes.totalSaved, 11, 'Must save exactly 11 valid records');
  assert.strictEqual(importRes.totalDuplicates, 0, 'First run must have 0 duplicates');
  assert.strictEqual(importRes.discoveredDates.length, 9, 'Must discover all 9 distinct calendar days across 4 months');

  const expectedDates = [
    '2025-01-10',
    '2025-01-15',
    '2025-02-05',
    '2025-02-20',
    '2025-03-01',
    '2025-03-18',
    '2025-03-24',
    '2025-04-12',
    '2025-04-25',
  ];

  for (const exp of expectedDates) {
    const found = importRes.discoveredDates.find(d => d.date === exp);
    assert(found, `Expected day ${exp} to be discovered in import result`);
    assert(found.savedCount > 0, `Expected day ${exp} to have saved records`);
  }

  console.log('\n  ✅ All 9 distinct dates across 4 months successfully discovered with authentic timestamps!');

  // ---------------------------------------------------------------------------
  // Step 3: Local SQLite & Remote Supabase Verification
  // ---------------------------------------------------------------------------
  console.log('\n[Step 3] Verifying persistence in SQLite database...');
  const localRawCount = (db.prepare(`
    SELECT count(*) as c FROM raw_activity_events WHERE order_code LIKE '${testPrefix}%'
  `).get() as any).c;
  const localCanonCount = (db.prepare(`
    SELECT count(*) as c FROM canonical_activity_events WHERE order_code LIKE '${testPrefix}%'
  `).get() as any).c;

  assert.strictEqual(localRawCount, 11, 'Local SQLite raw_activity_events must contain 11 rows');
  assert.strictEqual(localCanonCount, 11, 'Local SQLite canonical_activity_events must contain 11 rows');
  console.log(`  ✅ SQLite local persistence verified: ${localRawCount} raw rows, ${localCanonCount} canonical rows.`);

  if (isSupabaseConfigured()) {
    console.log('\n[Step 3b] Verifying remote Supabase cloud persistence under cutoff rule (< 2026-10-23)...');
    const remoteRawRes = await pgQuery(`
      SELECT count(*)::int as c FROM raw_activity_events WHERE order_code LIKE '${testPrefix}%'
    `);
    const remoteRawCount = Number(remoteRawRes.rows[0]?.c || 0);
    assert.strictEqual(remoteRawCount, 0, 'Under cutoff policy (< 2026-10-23), 2025 logs must remain in SQLite only');
    console.log(`  ✅ Cutoff policy confirmed: ${remoteRawCount} rows in remote postgres (stored strictly in local SQLite).`);
  }

  // ---------------------------------------------------------------------------
  // Step 4: Idempotency & Zero Inflation Check (Re-importing identical workbook)
  // ---------------------------------------------------------------------------
  console.log('\n[Step 4] Re-importing identical workbook to verify 100% duplicate protection...');
  const reimportRes = await importBatchLogFiles([
    { fileName: 'vendoor_system_logs_multi_month.xlsx', buffer }
  ], 'test_mm_reimport');

  console.log('\n--- RE-IMPORT AUDIT METRICS ---');
  console.log(`  - Total Rows Read:            ${reimportRes.totalRowsRead}`);
  console.log(`  - New Rows Saved:             ${reimportRes.totalSaved} (Must be 0)`);
  console.log(`  - Duplicates Identified:      ${reimportRes.totalDuplicates} (Must be 11)`);
  console.log(`  - Unparseable / Rejected:     ${reimportRes.unparseableRows}`);

  assert.strictEqual(reimportRes.totalSaved, 0, 'Re-imported valid rows saved MUST be 0 (zero inflation)');
  assert.strictEqual(reimportRes.totalDuplicates, 11, 'All 11 valid records MUST be detected as duplicates');

  const finalLocalRawCount = (db.prepare(`
    SELECT count(*) as c FROM raw_activity_events WHERE order_code LIKE '${testPrefix}%'
  `).get() as any).c;
  assert.strictEqual(finalLocalRawCount, 11, 'Database row count must remain invariant at exactly 11 after re-import');

  console.log('  ✅ Invariance verified: 0 new rows inserted, 100% duplicate suppression.');

  // ---------------------------------------------------------------------------
  // Step 5: Clean up test records
  // ---------------------------------------------------------------------------
  console.log('\n[Step 5] Cleaning up verification records...');
  db.exec(`
    DELETE FROM canonical_activity_events WHERE order_code LIKE '${testPrefix}%';
    DELETE FROM raw_activity_events WHERE order_code LIKE '${testPrefix}%';
    DELETE FROM historical_coverage WHERE period_date IN (${expectedDates.map(d => `'${d}'`).join(',')});
  `);

  if (isSupabaseConfigured()) {
    try {
      await pgQuery(`DELETE FROM canonical_activity_events WHERE order_code LIKE '${testPrefix}%'`);
      await pgQuery(`DELETE FROM raw_activity_events WHERE order_code LIKE '${testPrefix}%'`);
    } catch {}
  }

  console.log('  ✅ Cleanup complete.');
  console.log('\n🎉 ALL EXCEL MULTI-MONTH IMPORT VERIFICATION CHECKS PASSED PERFECTLY! 🎉\n');
}

runMultiMonthImportVerification().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
