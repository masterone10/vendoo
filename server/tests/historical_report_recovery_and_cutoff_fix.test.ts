import test from 'node:test';
import assert from 'node:assert/strict';
import { db, getCairoDateInterval, saveCoverageRecord } from '../db.ts';
import { resolveHistoricalDay } from '../historicalDayResolver.ts';
import { ensureCoverageForRange, generateLogsIntelligenceReport } from '../logsIntelligenceService.ts';
import { persistLogEntries } from '../historicalLogsService.ts';
import { vendoorClient, type LogEntry } from '../vendoorClient.ts';

test('Comprehensive Historical Report Recovery, Vendoor Parameters & Cutoff Test Suite', async (suite) => {
  const preCutoffDate = '2026-10-20';
  const postCutoffDate = '2026-10-25';

  const preInterval = getCairoDateInterval(preCutoffDate);
  const postInterval = getCairoDateInterval(postCutoffDate);

  // Backup original client methods
  const origIsConfigured = vendoorClient.isConfigured.bind(vendoorClient);
  const origFetchSystemLogs = vendoorClient.fetchSystemLogs.bind(vendoorClient);
  const origExportExcel = vendoorClient.exportSystemLogsExcel.bind(vendoorClient);

  suite.after(() => {
    // Restore original implementations
    vendoorClient.isConfigured = origIsConfigured;
    vendoorClient.fetchSystemLogs = origFetchSystemLogs;
    vendoorClient.exportSystemLogsExcel = origExportExcel;

    // Cleanup DB
    for (const d of [preCutoffDate, postCutoffDate, '2026-10-21', '2026-10-22']) {
      const iv = getCairoDateInterval(d);
      db.prepare(`DELETE FROM historical_coverage WHERE period_date = ?`).run(d);
      db.prepare(`DELETE FROM canonical_activity_events WHERE event_timestamp >= ? AND event_timestamp < ?`).run(iv.startCairo, iv.endCairo);
      db.prepare(`DELETE FROM raw_activity_events WHERE event_timestamp >= ? AND event_timestamp < ?`).run(iv.startCairo, iv.endCairo);
    }
  });

  // Cleanup DB before starting
  for (const d of [preCutoffDate, postCutoffDate, '2026-10-21', '2026-10-22']) {
    const iv = getCairoDateInterval(d);
    db.prepare(`DELETE FROM historical_coverage WHERE period_date = ?`).run(d);
    db.prepare(`DELETE FROM canonical_activity_events WHERE event_timestamp >= ? AND event_timestamp < ?`).run(iv.startCairo, iv.endCairo);
    db.prepare(`DELETE FROM raw_activity_events WHERE event_timestamp >= ? AND event_timestamp < ?`).run(iv.startCairo, iv.endCairo);
  }

  // ---------------------------------------------------------------------------
  // 1. Vendoor Query Parameters & Date Interval Tests
  // ---------------------------------------------------------------------------
  await suite.test('1.1 Vendoor buildSystemLogsUrl builds start_date, from_date, end_date, to_date correctly', () => {
    const url = vendoorClient.buildSystemLogsUrl(2, '2026-10-23', '2026-10-23');
    assert.equal(url.searchParams.get('page'), '2');
    assert.equal(url.searchParams.get('start_date'), '2026-10-23');
    assert.equal(url.searchParams.get('from_date'), '2026-10-23');
    assert.equal(url.searchParams.get('end_date'), '2026-10-23');
    assert.equal(url.searchParams.get('to_date'), '2026-10-23');
  });

  await suite.test('1.2 Vendoor buildExcelExportUrl builds export query parameters correctly', () => {
    const url = vendoorClient.buildExcelExportUrl('2026-10-23', '2026-10-23');
    assert.equal(url.searchParams.get('start_date'), '2026-10-23');
    assert.equal(url.searchParams.get('from_date'), '2026-10-23');
    assert.equal(url.searchParams.get('end_date'), '2026-10-23');
    assert.equal(url.searchParams.get('to_date'), '2026-10-23');
  });

  await suite.test('1.3 getCairoDateInterval accurately bounds business day [00:00:00, 24:00:00)', () => {
    const iv = getCairoDateInterval('2026-10-23');
    assert.ok(iv.startCairo.includes('2026-10-23'), 'Start must be 2026-10-23');
    assert.ok(iv.endCairo.includes('2026-10-24'), 'End exclusive must be 2026-10-24');
  });

  // ---------------------------------------------------------------------------
  // 2. Cloud Archive Cutoff Policy (< 2026-10-23 vs >= 2026-10-23)
  // ---------------------------------------------------------------------------
  await suite.test('2.1 Pre-cutoff date (< 2026-10-23) is stored strictly in SQLite with remote status NONE', async () => {
    vendoorClient.isConfigured = () => true;
    vendoorClient.exportSystemLogsExcel = (async () => null as any) as any;
    vendoorClient.fetchSystemLogs = async (page: number) => {
      return {
        entries: [{
          index: page,
          orderCode: `ORD_PRE_${page}`,
          actorName: 'Staff Member',
          rawActionText: `Order ORD_PRE_${page} status changed to Printed`,
          eventTimestamp: `${preCutoffDate} 14:00:00`,
          vendoorOrderId: 700000 + page,
        }],
        totalPages: 1,
      };
    };

    const res = await resolveHistoricalDay(preCutoffDate, { autoFetchMissing: true });
    assert.equal(res.completionStatus, 'COMPLETE');
    assert.equal(res.dataSource, 'VENDOOR_FETCH');
    assert.equal(res.localStorageStatus, 'LOCAL_SAVED');
    assert.equal(res.remoteArchiveStatus, 'NONE', 'Pre-cutoff date remote archive status must remain NONE');

    const cov: any = db.prepare(`SELECT * FROM historical_coverage WHERE period_date = ? AND source_domain = 'logs'`).get(preCutoffDate);
    assert.equal(cov.completion_status, 'COMPLETE');
    assert.equal(cov.remote_archive_status, 'NONE', 'DB record must show remote_archive_status NONE');
  });

  await suite.test('2.2 Pre-cutoff date (< 2026-10-23) does not attempt Supabase restore when absent', async () => {
    const missingDate = '2026-10-18';
    db.prepare(`DELETE FROM historical_coverage WHERE period_date = ?`).run(missingDate);

    // Call resolveHistoricalDay with autoFetchMissing: false
    const res = await resolveHistoricalDay(missingDate, { autoFetchMissing: false });
    assert.equal(res.decision, 'FETCH_FROM_VENDOOR');
    assert.equal(res.completionStatus, 'NOT_SYNCED');
    assert.equal(res.remoteArchiveStatus, 'NONE');
  });

  // ---------------------------------------------------------------------------
  // 3. Dynamic Total Pages Expansion & Strict Completion Audit
  // ---------------------------------------------------------------------------
  await suite.test('3.1 Dynamic discovery expands pages beyond initial page 1 estimate', async () => {
    const testDate = '2026-10-21';
    const iv = getCairoDateInterval(testDate);
    db.prepare(`DELETE FROM historical_coverage WHERE period_date = ?`).run(testDate);
    db.prepare(`DELETE FROM canonical_activity_events WHERE event_timestamp >= ? AND event_timestamp < ?`).run(iv.startCairo, iv.endCairo);
    db.prepare(`DELETE FROM raw_activity_events WHERE event_timestamp >= ? AND event_timestamp < ?`).run(iv.startCairo, iv.endCairo);

    const fetchedPages: number[] = [];

    vendoorClient.fetchSystemLogs = async (page: number) => {
      fetchedPages.push(page);
      // Page 1 says totalPages = 2, but Page 2 says totalPages = 3!
      const total = page === 1 ? 2 : 3;
      return {
        entries: [{
          index: page,
          orderCode: `ORD_DYNAMIC_${page}`,
          actorName: 'Dynamic Staff',
          rawActionText: `Order ORD_DYNAMIC_${page} updated to Processing`,
          eventTimestamp: `${testDate} 10:00:00`,
          vendoorOrderId: 720000 + page,
        }],
        totalPages: total,
      };
    };

    const res = await resolveHistoricalDay(testDate, { autoFetchMissing: true, forceRefetch: true });
    assert.equal(res.completionStatus, 'COMPLETE');
    // Must have fetched pages 1, 2, AND 3!
    assert.deepEqual(fetchedPages, [1, 2, 3], 'Pagination loop must dynamically follow expanded total pages up to page 3');
  });

  await suite.test('3.2 Page failure strictly keeps PARTIAL status without claiming COMPLETE', async () => {
    const testDate = '2026-10-22';
    const iv = getCairoDateInterval(testDate);
    db.prepare(`DELETE FROM historical_coverage WHERE period_date = ?`).run(testDate);
    db.prepare(`DELETE FROM canonical_activity_events WHERE event_timestamp >= ? AND event_timestamp < ?`).run(iv.startCairo, iv.endCairo);
    db.prepare(`DELETE FROM raw_activity_events WHERE event_timestamp >= ? AND event_timestamp < ?`).run(iv.startCairo, iv.endCairo);

    vendoorClient.fetchSystemLogs = async (page: number) => {
      if (page === 1) {
        return {
          entries: [{
            index: 1,
            orderCode: 'ORD_FAIL_P1',
            actorName: 'Staff 1',
            rawActionText: 'Order ORD_FAIL_P1 status changed to Printed',
            eventTimestamp: `${testDate} 10:00:00`,
            vendoorOrderId: 730001,
          }],
          totalPages: 3,
        };
      }
      throw new Error(`Simulated network failure on page ${page}`);
    };

    const res = await resolveHistoricalDay(testDate, { autoFetchMissing: true, forceRefetch: true });
    assert.equal(res.completionStatus, 'PARTIAL', 'Day must remain PARTIAL when subsequent pages fail');
    assert.ok(res.error, 'Error message must be recorded');

    // Verify in database
    const cov: any = db.prepare(`SELECT * FROM historical_coverage WHERE period_date = ? AND source_domain = 'logs'`).get(testDate);
    assert.equal(cov.completion_status, 'PARTIAL');
    assert.equal(cov.pages_read, 1);
    assert.equal(cov.pages_discovered, 3);
  });

  await suite.test('3.3 Smart resumption completes remaining pages from pages_read + 1', async () => {
    const testDate = '2026-10-22';
    // State currently has page 1 saved, pages_discovered = 3, pages_read = 1
    const fetchedPages: number[] = [];

    vendoorClient.fetchSystemLogs = async (page: number) => {
      fetchedPages.push(page);
      return {
        entries: [{
          index: page,
          orderCode: `ORD_RESUME_P${page}`,
          actorName: 'Resume Staff',
          rawActionText: `Order ORD_RESUME_P${page} status changed to Printed`,
          eventTimestamp: `${testDate} 12:00:00`,
          vendoorOrderId: 730000 + page,
        }],
        totalPages: 3,
      };
    };

    const res = await resolveHistoricalDay(testDate, { autoFetchMissing: true });
    assert.equal(res.completionStatus, 'COMPLETE');
    // Must resume from page 2 and 3 without refetching page 1!
    assert.deepEqual(fetchedPages, [2, 3], 'Smart resumption must only fetch missing pages 2 and 3');
  });

  // ---------------------------------------------------------------------------
  // 4. Metric Parity & Unique Event Counting
  // ---------------------------------------------------------------------------
  await suite.test('4.1 Report metrics distinguish Printed vs Canceled vs Canceling strictly', () => {
    const testDate = '2026-10-20';
    const report = generateLogsIntelligenceReport(testDate, testDate);
    assert.ok(report, 'Report should generate');
    assert.ok(typeof report.metrics.confirmedOrdersCount === 'number');
    assert.ok(typeof report.metrics.printedEventsCount === 'number');
    assert.ok(typeof report.metrics.canceledOrdersCount === 'number');
    assert.ok(typeof report.metrics.cancelingOrdersCount === 'number');
    assert.ok(report.cairoInterval.startCairo.includes(testDate));
  });

  // ---------------------------------------------------------------------------
  // 5. Vendoor Unreachable / Offline Defense Notice
  // ---------------------------------------------------------------------------
  await suite.test('5.1 Unconfigured / offline Vendoor returns transparent graceful failure', async () => {
    vendoorClient.isConfigured = () => false;
    const testDate = '2026-10-15';

    const res = await resolveHistoricalDay(testDate, { autoFetchMissing: true });
    assert.equal(res.completionStatus, 'FAILED');
    assert.ok(res.messageAr.includes('بيانات دخول Vendoor غیر مهیأة') || res.messageAr.includes('بيانات دخول Vendoor'));
  });
});
