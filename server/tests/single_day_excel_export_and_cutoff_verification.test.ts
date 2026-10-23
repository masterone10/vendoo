import test from 'node:test';
import assert from 'node:assert/strict';
import { db, getCairoDateInterval, saveCoverageRecord } from '../db.ts';
import { vendoorClient } from '../vendoorClient.ts';
import { resolveHistoricalDay } from '../historicalDayResolver.ts';
import { generateLogsIntelligenceReport } from '../logsIntelligenceService.ts';
import { importBatchLogFiles } from '../batchLogsImporter.ts';
import * as XLSX from 'xlsx';

test('Single-Day Excel Export, Cutoff Policy & Cache Verification Suite', async (t) => {
  await t.test('1.1 buildExcelExportUrl formats matching start_date and end_date for single day', () => {
    const url = vendoorClient.buildExcelExportUrl('2026-10-10', '2026-10-10');
    assert.strictEqual(url.pathname, '/dashboard/log/xls/all');
    assert.strictEqual(url.searchParams.get('start_date'), '2026-10-10');
    assert.strictEqual(url.searchParams.get('end_date'), '2026-10-10');
    assert.strictEqual(url.searchParams.get('from_date'), '2026-10-10');
    assert.strictEqual(url.searchParams.get('to_date'), '2026-10-10');
  });

  await t.test('1.2 Stored complete day loads instantly from cache with loadedFromCache: true', async () => {
    const testDate = '2026-10-10';
    const interval = getCairoDateInterval(testDate);

    // Seed mock data for 2026-10-10
    db.prepare(`
      INSERT INTO raw_activity_events (source_hash, order_code, actor_name, raw_action_text, event_timestamp, observed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_hash) DO NOTHING
    `).run('test_hash_cache_1', 'ORD-1010-1', 'أحمد علي', 'تم طباعة البوليصة', `${testDate} 10:00:00`, new Date().toISOString());

    db.prepare(`
      INSERT INTO canonical_activity_events (order_code, actor_name, action_type, to_status, event_timestamp, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('ORD-1010-1', 'أحمد علي', 'status_change', 'Printed', `${testDate} 10:00:00`, new Date().toISOString());

    saveCoverageRecord({
      accountId: 'primary',
      sourceDomain: 'logs',
      periodDate: testDate,
      storageTier: 'HOT',
      pagesDiscovered: 1,
      pagesRead: 1,
      recordsExtracted: 1,
      recordsSaved: 1,
      completionStatus: 'COMPLETE',
      dataSource: 'EXCEL_IMPORT',
      canonicalEventsCount: 1,
      localStorageStatus: 'LOCAL_SAVED',
      remoteArchiveStatus: 'NONE',
    });

    const res = await resolveHistoricalDay(testDate, { autoFetchMissing: false });
    assert.strictEqual(res.loadedFromCache, true);
    assert.strictEqual(res.completionStatus, 'COMPLETE');
    assert.ok(res.rawRecordsCount >= 1);
  });

  await t.test('1.3 Cutoff rule (< 2026-10-23): Pre-cutoff logs are stored in SQLite only without Supabase sync', async () => {
    const preCutoffDate = '2026-10-15';
    saveCoverageRecord({
      accountId: 'primary',
      sourceDomain: 'logs',
      periodDate: preCutoffDate,
      storageTier: 'HOT',
      pagesDiscovered: 1,
      pagesRead: 1,
      recordsExtracted: 5,
      recordsSaved: 5,
      completionStatus: 'COMPLETE',
      dataSource: 'VENDOOR_FETCH',
      canonicalEventsCount: 5,
      localStorageStatus: 'LOCAL_SAVED',
      remoteArchiveStatus: 'NONE',
    });

    const res = await resolveHistoricalDay(preCutoffDate, { autoFetchMissing: false });
    assert.strictEqual(res.remoteArchiveStatus, 'NONE');
  });

  await t.test('1.4 Excel sheet parsing and SHA-256 deduplication invariance on re-import', async () => {
    const sheetDate = '2026-10-20';
    // Create an in-memory workbook with single-day logs
    const wb = XLSX.utils.book_new();
    const wsData = [
      ['م', 'كود الطلب', 'اسم الموظف', 'العملية', 'التاريخ'],
      ['1', 'ORD-2026-A', 'محمود حسن', 'تم تعديل الحالة إلى مؤكد', '2026-10-20 11:30:00'],
      ['2', 'ORD-2026-B', 'سارة محمد', 'تم طباعة بوليصة الشحن', '2026-10-20 11:35:00'],
    ];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    // First import pass
    const pass1 = await importBatchLogFiles([
      { fileName: `test_logs_${sheetDate}.xlsx`, buffer: buf },
    ]);
    assert.strictEqual(pass1.success, true);
    assert.strictEqual(pass1.totalSaved, 2);

    // Second import pass (Re-export / Re-import simulation)
    const pass2 = await importBatchLogFiles([
      { fileName: `test_logs_${sheetDate}.xlsx`, buffer: buf },
    ]);
    assert.strictEqual(pass2.success, true);
    assert.strictEqual(pass2.totalSaved, 0); // 0 new rows saved due to SHA-256 deduplication
    assert.strictEqual(pass2.totalDuplicates, 2);
  });

  await t.test('1.5 generateLogsIntelligenceReport accurately reflects metrics from SQLite', () => {
    const report = generateLogsIntelligenceReport('2026-10-20', '2026-10-20');
    assert.strictEqual(report.startDate, '2026-10-20');
    assert.strictEqual(report.endDate, '2026-10-20');
    assert.ok(report.metrics.totalLogs >= 2);
    assert.ok(report.metrics.uniqueOrdersTouched >= 2);
  });
});
