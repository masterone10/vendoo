import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as XLSX from 'xlsx';
import { db, DB_PATH, initDatabase } from '../db.ts';
import { importBatchLogFiles, parseRFC4180Csv, detectCsvDelimiter, normalizeDateStringToCairo } from '../batchLogsImporter.ts';

console.log('================================================================================');
console.log('  TEST: LARGE MULTI-MONTH LOGS IMPORT (15,000+ ROWS & SEMICOLON CSV)           ');
console.log('  Testing on isolated SQLite database: ' + DB_PATH);
console.log('================================================================================\n');

async function runLargePeriodLogsImportTest() {
  assert(DB_PATH.includes('test_isolated_'), 'Database must be an isolated temporary database for tests');

  // Step 1: Unit tests on normalizeDateStringToCairo for Date & Time correctness (Requirement 2)
  console.log('[Test 1] Testing Date & Time correctness in normalizeDateStringToCairo...');

  // 1a. Integer date + separate numeric time fraction (45620 = 2024-11-24, 0.6041666666666666 = 14:30:00)
  const dt1 = normalizeDateStringToCairo(45620, 0.6041666666666666);
  assert.strictEqual(dt1.dateStr, '2024-11-24', 'Date string should be 2024-11-24');
  assert.strictEqual(dt1.timestampStr, '2024-11-24 14:30:00', 'Timestamp should be 2024-11-24 14:30:00');

  // 1b. Date already contains fractional time (45620.604166666666 = 2024-11-24 14:30:00):
  // Even if a separate timeVal is passed, it MUST NOT duplicate time!
  const dt2 = normalizeDateStringToCairo(45620.604166666666, 0.6041666666666666);
  assert.strictEqual(dt2.dateStr, '2024-11-24');
  assert.strictEqual(dt2.timestampStr, '2024-11-24 14:30:00', 'Time must not be added twice if date has fractional time');

  // 1c. String date + numeric time fraction
  const dt3 = normalizeDateStringToCairo('2024-11-24', 0.5);
  assert.strictEqual(dt3.dateStr, '2024-11-24');
  assert.strictEqual(dt3.timestampStr, '2024-11-24 12:00:00', 'Numeric time 0.5 should combine with string date as 12:00:00');

  // 1d. Arabic localized AM/PM
  const dt4 = normalizeDateStringToCairo('15/10/2024 04:15 م');
  assert.strictEqual(dt4.dateStr, '2024-10-15');
  assert.strictEqual(dt4.timestampStr, '2024-10-15 16:15:00');

  const dt5 = normalizeDateStringToCairo('15/10/2024 09:30 ص');
  assert.strictEqual(dt5.dateStr, '2024-10-15');
  assert.strictEqual(dt5.timestampStr, '2024-10-15 09:30:00');

  console.log('✓ Test 1 Passed: Date & Time normalization handles fractional checks, combined time, and Arabic AM/PM.');

  // Step 2: Unit test RFC 4180 CSV parser with Semicolon, Quotes, and Embedded Delimiters (Requirement 4)
  console.log('\n[Test 2] Testing RFC 4180 CSV parser with semicolon delimiter and quoted commas/semicolons...');
  const csvRaw = [
    'كود الطلب;اسم المنفذ;البيان;تاريخ الحركة;الوقت',
    'ORD_101;أحمد CS;"عدل أحمد CS حالة الطلب من ""Pending; قيد الانتظار"" إلى ""Printed; تم الطباعة""";2024-10-10;11:20:00',
    'ORD_102;سارة CS;"إضافة عنوان جديد، محافظة القاهرة، مدينة نصر";2024-10-10;11:25:00',
    'ORD_103;النظام;"انشاء أوردر\nبسطرين جديدين";2024-10-11;09:00:00',
  ].join('\r\n');

  const detectedDelim = detectCsvDelimiter(csvRaw);
  assert.strictEqual(detectedDelim, ';', 'Delimiter must be detected as semicolon');

  const parsedCsvAoa = parseRFC4180Csv(csvRaw, detectedDelim);
  assert.strictEqual(parsedCsvAoa.length, 4, 'Should parse 4 rows (1 header + 3 data rows)');
  assert.strictEqual(parsedCsvAoa[0].length, 5, 'Header row should have 5 columns');
  assert.strictEqual(parsedCsvAoa[1].length, 5, 'Row 1 should maintain 5 columns despite semicolon inside quotes');
  assert.strictEqual(parsedCsvAoa[1][0], 'ORD_101');
  assert.strictEqual(parsedCsvAoa[1][1], 'أحمد CS');
  assert(parsedCsvAoa[1][2].includes('Pending; قيد الانتظار'), 'Quoted text with semicolon must be preserved');
  assert.strictEqual(parsedCsvAoa[1][3], '2024-10-10');
  assert.strictEqual(parsedCsvAoa[1][4], '11:20:00');
  console.log('✓ Test 2 Passed: RFC 4180 CSV parser correctly handles semicolons, quotes, and multiline content.');

  // Step 3: Construct a massive 15,000-row multi-sheet Excel workbook covering 6 months (Requirement 3 & 8)
  console.log('\n[Test 3] Generating 15,000-row Excel workbook across 6 months with Summary cover sheet...');
  const wb = XLSX.utils.book_new();

  // Sheet 1: Summary Sheet (Invalid log structure, should be skipped gracefully)
  const summaryAoa = [
    ['تقرير الملخص التنفيذي لحركات النظام'],
    ['تاريخ التوليد', '2025-04-01'],
    ['إجمالي العمليات', 15000],
    ['ملاحظة', 'هذه ورقة معلومات عامة وملخص إحصائي لا تحتوي على أعمدة اللوجز'],
  ];
  const summaryWs = XLSX.utils.aoa_to_sheet(summaryAoa);
  XLSX.utils.book_append_sheet(wb, summaryWs, 'ملخص_تنفيذي');

  // Month configurations across 6 months
  // Month 1: Oct 2024 (2024-10-01 to 2024-10-30) - 3,000 rows
  // Month 2: Nov 2024 (2024-11-01 to 2024-11-30) - 3,000 rows (Fractional datetime)
  // Month 3: Dec 2024 (2024-12-01 to 2024-12-30) - 3,000 rows (Arabic strings)
  // Month 4: Jan 2025 (2025-01-01 to 2025-01-30) - 3,000 rows (Subheaders and spacers)
  // Month 5: Feb 2025 (2025-02-01 to 2025-02-28) - 3,000 rows (Contains 500 duplicates)
  const monthsData = [
    { name: 'أكتوبر_2024', baseDate: '2024-10', count: 3000, type: 'separate_num' },
    { name: 'نوفمبر_2024', baseDate: '2024-11', count: 3000, type: 'frac_date' },
    { name: 'ديسمبر_2024', baseDate: '2024-12', count: 3000, type: 'arabic_text' },
    { name: 'يناير_2025', baseDate: '2025-01', count: 3000, type: 'with_spacers' },
    { name: 'فبراير_2025', baseDate: '2025-02', count: 3000, type: 'with_duplicates' },
  ];

  let totalExpectedRows = 0;
  let totalIntentionallyInvalid = 5;

  for (const m of monthsData) {
    const sheetAoa: any[][] = [];

    // Header row within top 5 rows (simulating report header on row 0, 1)
    sheetAoa.push([`تقرير حركة اللوجز - ${m.name}`, '', '', '', '']);
    sheetAoa.push(['كود الطلب', 'الموظف', 'نص الحركة', 'التاريخ', 'الوقت']);

    for (let i = 0; i < m.count; i++) {
      const dayNum = (i % 28) + 1;
      const dayStr = String(dayNum).padStart(2, '0');
      const orderCode = `ORD_${m.baseDate.replace('-', '')}_${i + 1}`;
      const actor = (i % 3 === 0) ? 'Hayam CS' : (i % 3 === 1) ? 'Ali CS' : 'Sara CS';
      const action = (i % 2 === 0)
        ? `عدل ${actor} حالة الطلب من Pending إلى Printed`
        : `أضاف ${actor} ملاحظة على الطلب: تم التأكيد مع العميل`;

      if (m.type === 'separate_num') {
        // Serial date for 2024-10-XX (Oct 1 2024 = 45566)
        const serialDate = 45566 + (dayNum - 1);
        const timeFraction = 0.45; // ~10:48 AM
        sheetAoa.push([orderCode, actor, action, serialDate, timeFraction]);
        totalExpectedRows++;
      } else if (m.type === 'frac_date') {
        // Serial date with fractional time built-in (45597 + dayNum + 0.6041666666666666)
        const serialWithFrac = 45597 + (dayNum - 1) + 0.6041666666666666;
        sheetAoa.push([orderCode, actor, action, serialWithFrac, '']);
        totalExpectedRows++;
      } else if (m.type === 'arabic_text') {
        const timeStr = (i % 2 === 0) ? '02:30 م' : '10:15 ص';
        const dateStr = `${dayStr}/12/2024 ${timeStr}`;
        sheetAoa.push([orderCode, actor, action, dateStr, '']);
        totalExpectedRows++;
      } else if (m.type === 'with_spacers') {
        // Add occasional blank rows or subheaders every 500 rows
        if (i > 0 && i % 500 === 0) {
          sheetAoa.push(['', '', '', '', '']); // blank row
          sheetAoa.push([`--- ملخص الأسبوع ${Math.floor(i / 500)} ---`, '', '', '', '']); // subheader
        }
        const dateStr = `2025-01-${dayStr} 14:00:00`;
        sheetAoa.push([orderCode, actor, action, dateStr, '']);
        totalExpectedRows++;
      } else if (m.type === 'with_duplicates') {
        // Every 6th row repeats the exact previous row to test deduplication
        if (i > 0 && i % 6 === 0 && sheetAoa.length > 0) {
          sheetAoa.push([...sheetAoa[sheetAoa.length - 1]]);
        } else {
          sheetAoa.push([orderCode, actor, action, `2025-02-${dayStr} 15:30:00`, '']);
        }
        totalExpectedRows++;
      }
    }

    // Add intentionally invalid rows in Month 1 for reviewRows verification
    if (m.baseDate === '2024-10') {
      sheetAoa.push(['ORD_INVALID_1', 'Hayam CS', 'نص بدون تاريخ', '', '']); // missing date
      sheetAoa.push(['ORD_INVALID_2', 'Ali CS', 'نص بتاريخ تالف', 'not-a-date-xyz', '']); // corrupt date
      sheetAoa.push(['ORD_INVALID_3', 'Sara CS', '', '2024-10-15 10:00:00', '']); // empty action
      sheetAoa.push(['ORD_INVALID_4', 'Ali CS', 'تاريخ مستقبلي خارج النطاق', '9999-99-99', '']); // out of range
      sheetAoa.push(['ORD_INVALID_5', 'Sara CS', 'تاريخ صفر', 0, 0]); // zero date
      totalExpectedRows += totalIntentionallyInvalid;
    }

    const ws = XLSX.utils.aoa_to_sheet(sheetAoa);
    XLSX.utils.book_append_sheet(wb, ws, m.name);
  }

  // Write workbook to a temporary file on disk (simulating chunk assembly of a large file)
  const tempExcelPath = path.join(os.tmpdir(), `test_large_import_${Date.now()}.xlsx`);
  XLSX.writeFile(wb, tempExcelPath);
  console.log(`✓ Workbook created on disk: ${tempExcelPath} with ${totalExpectedRows} total rows.`);

  // Step 4: Run importBatchLogFiles on the 15,000-row file
  console.log('\n[Test 4] Executing importBatchLogFiles with progress reporting...');
  let lastProgressMsg = '';
  const progressCalls: any[] = [];

  const importResult = await importBatchLogFiles(
    [
      {
        fileName: 'historical_logs_6_months.xlsx',
        filePath: tempExcelPath,
      },
    ],
    'test_batch',
    (p) => {
      progressCalls.push(p);
      lastProgressMsg = p.stageLabelAr;
    }
  );

  console.log('\n--- Import Results Summary ---');
  console.log(`Success: ${importResult.success}`);
  console.log(`Status: ${importResult.status} (${importResult.statusMessageAr})`);
  console.log(`Total Rows Read: ${importResult.totalRowsRead.toLocaleString()}`);
  console.log(`Valid Records: ${importResult.validRecordsCount.toLocaleString()}`);
  console.log(`New Records Saved: ${importResult.totalSaved.toLocaleString()}`);
  console.log(`Duplicate Records: ${importResult.totalDuplicates.toLocaleString()}`);
  console.log(`Unparseable Rows: ${importResult.unparseableRows}`);
  console.log(`Discovered Dates Count: ${importResult.discoveredDates.length}`);
  console.log(`Sheets Processed: ${importResult.sheetsProcessed.length}`);
  console.log(`Warnings Count: ${importResult.warnings.length}`);
  console.log('Warnings Details:', importResult.warnings);
  console.log(`Review Rows Count: ${importResult.reviewRows.length}`);

  // Assertions on Excel Import (Requirement 3, 6, 8)
  assert.strictEqual(importResult.success, true, 'Import must succeed');
  assert(importResult.totalRowsRead >= 15000, `Expected >= 15,000 rows read, got ${importResult.totalRowsRead}`);
  assert(importResult.totalSaved > 14000, `Expected > 14,000 saved, got ${importResult.totalSaved}`);
  assert(importResult.totalDuplicates >= 0, `Expected duplicate records count >= 0, got ${importResult.totalDuplicates}`);
  assert(importResult.unparseableRows >= 3, `Expected >= 3 unparseable rows, got ${importResult.unparseableRows}`);
  assert(importResult.discoveredDates.length >= 100, `Expected >= 100 discovered distinct dates across 6 months, got ${importResult.discoveredDates.length}`);
  assert(importResult.warnings.some(w => w.includes('ملخص_تنفيذي')), 'Summary sheet must be listed in warnings as skipped');
  assert(importResult.reviewRows.length >= 3, 'Review rows must contain the invalid sample rows');

  // Verify DB state
  const rawDbCount = (db.prepare('SELECT COUNT(*) as c FROM raw_activity_events').get() as any)?.c || 0;
  const canonDbCount = (db.prepare('SELECT COUNT(*) as c FROM canonical_activity_events').get() as any)?.c || 0;
  const coverageCount = (db.prepare('SELECT COUNT(*) as c FROM historical_coverage').get() as any)?.c || 0;

  console.log(`\nDatabase State: Raw Events=${rawDbCount.toLocaleString()}, Canonical Events=${canonDbCount.toLocaleString()}, Coverage Days=${coverageCount}`);
  assert.strictEqual(rawDbCount, importResult.totalSaved, 'Raw events count in DB must equal totalSaved');
  assert(coverageCount >= 100, 'Coverage records must be recorded for all discovered days');

  // Step 5: Test Idempotency (Re-importing the same file must result in ALL_DUPLICATES and 0 saved)
  console.log('\n[Test 5] Testing Idempotency: Re-importing same file must yield ALL_DUPLICATES with 0 new saves...');
  const reimportResult = await importBatchLogFiles([
    {
      fileName: 'historical_logs_6_months.xlsx',
      filePath: tempExcelPath,
    },
  ]);

  console.log(`Re-import status: ${reimportResult.status} (${reimportResult.statusMessageAr})`);
  console.log(`Re-import saved: ${reimportResult.totalSaved}, duplicates: ${reimportResult.totalDuplicates}`);
  assert.strictEqual(reimportResult.totalSaved, 0, 'Re-import must save 0 new records');
  assert(reimportResult.totalDuplicates > 14000, 'Re-import must detect all previous records as duplicates');
  assert.strictEqual(reimportResult.status, 'ALL_DUPLICATES', 'Status must be ALL_DUPLICATES');
  assert.strictEqual(reimportResult.success, true, 'Idempotent re-import must be marked success');

  // Step 6: Test Large Multi-Month CSV with Semicolon (Requirement 4 & 8)
  console.log('\n[Test 6] Testing Multi-Month Semicolon-Separated CSV (2,000 rows)...');
  const csvLines: string[] = ['كود الطلب;الموظف;البيان;تاريخ ووقت الحركة'];
  for (let i = 0; i < 2000; i++) {
    const day = (i % 28) + 1;
    const dayStr = String(day).padStart(2, '0');
    const orderCode = `CSV_ORD_${i + 1}`;
    const actor = (i % 2 === 0) ? 'Eman CS' : 'Mohamed CS';
    // Action with embedded quotes, commas and semicolons
    const action = `تعديل الحالة من "Pending; قيد المراجعة" إلى "Processing; قيد التجهيز", مع ملاحظة العميل رقم #${i}`;
    csvLines.push(`${orderCode};${actor};"${action}";2024-09-${dayStr} 12:30:00`);
  }

  const tempCsvPath = path.join(os.tmpdir(), `test_large_csv_${Date.now()}.csv`);
  fs.writeFileSync(tempCsvPath, csvLines.join('\r\n'), 'utf-8');

  const csvImportResult = await importBatchLogFiles([
    {
      fileName: 'large_september_logs.csv',
      filePath: tempCsvPath,
    },
  ]);

  console.log(`CSV Import Success: ${csvImportResult.success}, Status: ${csvImportResult.status}`);
  console.log(`CSV Rows Read: ${csvImportResult.totalRowsRead}, Saved: ${csvImportResult.totalSaved}, Unparseable: ${csvImportResult.unparseableRows}`);
  assert.strictEqual(csvImportResult.success, true, 'CSV import must succeed');
  assert.strictEqual(csvImportResult.totalRowsRead, 2000, 'Should read 2,000 rows');
  assert.strictEqual(csvImportResult.totalSaved, 2000, 'Should save 2,000 new rows');
  assert.strictEqual(csvImportResult.unparseableRows, 0, 'Should have 0 unparseable rows');
  assert.strictEqual(csvImportResult.discoveredDates.length, 28, 'Should discover 28 days in September 2024');

  // Clean up temp files
  try {
    fs.unlinkSync(tempExcelPath);
    fs.unlinkSync(tempCsvPath);
  } catch {}

  console.log('\n================================================================================');
  console.log('  ALL LARGE PERIOD LOGS IMPORT TESTS PASSED SUCCESSFULLY!                       ');
  console.log('================================================================================\n');
}

runLargePeriodLogsImportTest().catch((err) => {
  console.error('\n❌ Test failed with error:', err);
  process.exit(1);
});
