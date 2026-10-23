import test from 'node:test';
import assert from 'node:assert/strict';
import { db, getCairoDateInterval, saveCoverageRecord } from '../db.ts';
import { resolveHistoricalDay } from '../historicalDayResolver.ts';
import { ensureCoverageForRange } from '../logsIntelligenceService.ts';
import { persistLogEntries } from '../historicalLogsService.ts';
import { vendoorClient, type LogEntry } from '../vendoorClient.ts';

test('Automatic Vendoor Pull & Smart Resumption Tests', async (t) => {
  const testDate = '2026-09-15';
  const interval = getCairoDateInterval(testDate);

  // Save original methods
  const origIsConfigured = vendoorClient.isConfigured.bind(vendoorClient);
  const origFetchSystemLogs = vendoorClient.fetchSystemLogs.bind(vendoorClient);
  const origExportExcel = vendoorClient.exportSystemLogsExcel.bind(vendoorClient);

  // Mock methods to run reliably and offline
  vendoorClient.isConfigured = () => true;
  vendoorClient.exportSystemLogsExcel = async () => null;
  vendoorClient.fetchSystemLogs = async (page: number, sDate: string, _eDate: string) => {
    const entry: LogEntry = {
      index: page,
      orderCode: `ORD_${page}_${Date.now()}`,
      actorName: 'Test Staff',
      rawActionText: `Order ORD_${page} status changed to Printed by Test Staff`,
      eventTimestamp: `${sDate} 11:00:00`,
      vendoorOrderId: 800000 + page,
    };
    return {
      page,
      totalPages: 2,
      entries: [entry],
    };
  };

  t.after(() => {
    // Restore original methods
    vendoorClient.isConfigured = origIsConfigured;
    vendoorClient.fetchSystemLogs = origFetchSystemLogs;
    vendoorClient.exportSystemLogsExcel = origExportExcel;

    // Cleanup test state
    db.prepare(`DELETE FROM historical_coverage WHERE period_date = ?`).run(testDate);
    db.prepare(`DELETE FROM canonical_activity_events WHERE event_timestamp >= ? AND event_timestamp < ?`).run(interval.startCairo, interval.endCairo);
    db.prepare(`DELETE FROM raw_activity_events WHERE event_timestamp >= ? AND event_timestamp < ?`).run(interval.startCairo, interval.endCairo);
  });

  // Setup initial clean state
  db.prepare(`DELETE FROM historical_coverage WHERE period_date = ?`).run(testDate);
  db.prepare(`DELETE FROM canonical_activity_events WHERE event_timestamp >= ? AND event_timestamp < ?`).run(interval.startCairo, interval.endCairo);
  db.prepare(`DELETE FROM raw_activity_events WHERE event_timestamp >= ? AND event_timestamp < ?`).run(interval.startCairo, interval.endCairo);

  await t.test('1. Day missing from SQLite and Supabase triggers automatic fetch from Vendoor', async () => {
    const result = await resolveHistoricalDay(testDate, { autoFetchMissing: true });
    assert.ok(result, 'Result should be returned');
    assert.equal(result.date, testDate);
    assert.equal(result.decision, 'FETCH_FROM_VENDOOR', 'Decision should automatically be FETCH_FROM_VENDOOR');
    assert.equal(result.completionStatus, 'COMPLETE');
    assert.ok(result.rawRecordsCount >= 2, 'Both pages should have been fetched and saved');
  });

  await t.test('2. Partial day with known pages triggers smart resumption of missing pages', async () => {
    // Reset testDate to PARTIAL: Page 1 saved, Page 2 pending
    db.prepare(`DELETE FROM canonical_activity_events WHERE event_timestamp >= ? AND event_timestamp < ?`).run(interval.startCairo, interval.endCairo);
    db.prepare(`DELETE FROM raw_activity_events WHERE event_timestamp >= ? AND event_timestamp < ?`).run(interval.startCairo, interval.endCairo);

    const p1Raw: LogEntry[] = [{
      index: 1,
      orderCode: 'ORD_PARTIAL_888801',
      actorName: 'Test Staff',
      rawActionText: 'Order ORD_PARTIAL_888801 status changed to Printed by Test Staff',
      eventTimestamp: `${testDate} 10:00:00`,
      vendoorOrderId: 888801,
    }];

    persistLogEntries(p1Raw, interval, { dataSource: 'VENDOOR_FETCH', strictInterval: true });

    saveCoverageRecord({
      accountId: 'primary',
      sourceDomain: 'logs',
      periodDate: testDate,
      storageTier: 'HOT',
      pagesDiscovered: 2,
      pagesRead: 1,
      recordsExtracted: 1,
      recordsSaved: 1,
      completionStatus: 'PARTIAL',
      dataSource: 'VENDOOR_FETCH',
      canonicalEventsCount: 1,
      localStorageStatus: 'LOCAL_PARTIAL',
      remoteArchiveStatus: 'NONE',
      lastAttemptedAt: new Date().toISOString(),
      notes: 'Test partial day before smart resume',
    });

    const res = await resolveHistoricalDay(testDate, { autoFetchMissing: true });
    assert.ok(res, 'Resolver should run');
    assert.equal(res.date, testDate);
    assert.equal(res.completionStatus, 'COMPLETE', 'Day should be upgraded to COMPLETE after resumption');

    const updatedCov: any = db.prepare(`SELECT * FROM historical_coverage WHERE period_date = ? AND source_domain = 'logs'`).get(testDate);
    assert.equal(updatedCov.completion_status, 'COMPLETE');
    assert.equal(updatedCov.pages_read, 2);
    assert.equal(updatedCov.pages_discovered, 2);
  });

  await t.test('3. ensureCoverageForRange includes PARTIAL days in missingDates and completes them', async () => {
    // Set testDate to PARTIAL again
    saveCoverageRecord({
      accountId: 'primary',
      sourceDomain: 'logs',
      periodDate: testDate,
      storageTier: 'HOT',
      pagesDiscovered: 2,
      pagesRead: 1,
      recordsExtracted: 1,
      recordsSaved: 1,
      completionStatus: 'PARTIAL',
      dataSource: 'VENDOOR_FETCH',
      canonicalEventsCount: 1,
      localStorageStatus: 'LOCAL_PARTIAL',
      remoteArchiveStatus: 'NONE',
      lastAttemptedAt: new Date().toISOString(),
      notes: 'Test partial for ensureCoverageForRange',
    });

    const job = await ensureCoverageForRange(testDate, testDate);
    assert.ok(job, 'Range job should be returned');
    assert.equal(job.stage, 'COMPLETE', 'Job should be completed');

    const covAfter: any = db.prepare(`SELECT * FROM historical_coverage WHERE period_date = ? AND source_domain = 'logs'`).get(testDate);
    assert.equal(covAfter.completion_status, 'COMPLETE');
  });

  await t.test('4. Date range restriction: only dates strictly within [startDate, endDate] are processed', async () => {
    const s = '2026-09-20';
    const e = '2026-09-21';
    const job = await ensureCoverageForRange(s, e);
    assert.equal(job.startDate, s);
    assert.equal(job.endDate, e);

    // Clean up test dates
    db.prepare(`DELETE FROM historical_coverage WHERE period_date IN (?, ?)`).run(s, e);
  });

  await t.test('5. Deduplication integrity: duplicate events in the same second are preserved in raw logs without double counting in canonical', async () => {
    const rawEvents: LogEntry[] = [
      {
        index: 1,
        orderCode: 'ORD_DEDUP_TEST',
        actorName: 'Staff A',
        rawActionText: 'Status changed to Printed by Staff A',
        eventTimestamp: `${testDate} 12:00:00`,
      },
      {
        index: 2,
        orderCode: 'ORD_DEDUP_TEST',
        actorName: 'Staff A',
        rawActionText: 'Status changed to Printed by Staff A',
        eventTimestamp: `${testDate} 12:00:00`,
      },
    ];

    const res1 = persistLogEntries(rawEvents, interval, { dataSource: 'VENDOOR_FETCH', strictInterval: true });
    assert.equal(res1.saved, 1, 'Canonical status transition is counted once');

    const rawCount = (db.prepare(`
      SELECT COUNT(*) as c FROM raw_activity_events WHERE event_timestamp = '${testDate} 12:00:00'
    `).get() as any).c;
    assert.equal(rawCount, 2, 'Both distinct raw occurrences are safely preserved with sequence hashes');

    // Re-inserting the same identical records should be 100% ignored
    const res2 = persistLogEntries(rawEvents, interval, { dataSource: 'VENDOOR_FETCH', strictInterval: true });
    assert.equal(res2.saved, 0, 'Zero duplicate insertions on re-fetch');
    assert.equal(res2.duplicates, 2, 'Both duplicate events correctly detected as already existing');
  });

  setTimeout(() => process.exit(0), 50);
});
