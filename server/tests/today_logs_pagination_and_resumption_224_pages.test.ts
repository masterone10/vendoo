import test from 'node:test';
import assert from 'node:assert/strict';
import { db, getCairoDateInterval, saveCoverageRecord, getCoverageRecord, getCairoDateString } from '../db.ts';
import { syncEngine } from '../syncEngine.ts';
import { vendoorClient, type LogEntry } from '../vendoorClient.ts';
import { persistLogEntries } from '../historicalLogsService.ts';
import { resolveHistoricalDay } from '../historicalDayResolver.ts';

test('Today Logs 224 Pages Pagination & Resumption Master Suite', async (t) => {
  const testDate = '2026-10-25';
  const interval = getCairoDateInterval(testDate);

  // Helper to generate mock system log entries (2 per page for swift test execution while maintaining full 224-page loop)
  const generatePageEntries = (page: number, entriesPerPage = 2): LogEntry[] => {
    const entries: LogEntry[] = [];
    for (let i = 1; i <= entriesPerPage; i++) {
      const idx = (page - 1) * entriesPerPage + i;
      const orderCode = `ORD-224-${idx}`;
      const hour = 8 + Math.floor(idx / 100);
      const min = (idx % 60);
      const sec = (idx * 7) % 60;
      const hh = String(hour).padStart(2, '0');
      const mm = String(min).padStart(2, '0');
      const ss = String(sec).padStart(2, '0');
      const eventTimestamp = `${testDate} ${hh}:${mm}:${ss}`;

      entries.push({
        index: idx,
        orderCode,
        actorName: i % 2 === 0 ? 'سارة خدمة عملاء (CS)' : 'أحمد تشغيل',
        rawActionText: i === 1 ? 'تم تأكيد الطلب وطباعة البوليصة' : 'تعديل حالة الطلب إلى ملغي نهائي',
        eventTimestamp,
        vendoorOrderId: 900000 + idx,
        orderHref: `/dashboard/orders/${900000 + idx}`,
        rawHtml: `<tr><td>${idx}</td><td>${orderCode}</td><td>أحمد</td><td>تعديل</td><td>${eventTimestamp}</td></tr>`,
      });
    }
    return entries;
  };

  // Clean test tables for testDate
  db.prepare(`
    DELETE FROM canonical_activity_events
    WHERE event_timestamp >= ? AND event_timestamp < ?
  `).run(interval.startCairo, interval.endCairo);

  db.prepare(`
    DELETE FROM raw_activity_events
    WHERE event_timestamp >= ? AND event_timestamp < ?
  `).run(interval.startCairo, interval.endCairo);

  db.prepare(`
    DELETE FROM historical_coverage
    WHERE period_date = ? AND source_domain = 'logs'
  `).run(testDate);

  await t.test('1. Initial Crawl of 224 pages with simulated interruption at page 100', async () => {
    let pagesRequested: number[] = [];
    const originalFetch = vendoorClient.fetchSystemLogs.bind(vendoorClient);

    // Mock vendoorClient to simulate 224 total pages, but throwing an error on page 101
    (vendoorClient as any).fetchSystemLogs = async (page: number, _start?: string, _end?: string) => {
      pagesRequested.push(page);
      if (page > 100) {
        throw new Error(`Simulated Network Timeout on page ${page} (Testing partial stop)`);
      }
      return {
        entries: generatePageEntries(page, 2),
        totalPages: 224,
      };
    };

    try {
      const nowIso = new Date().toISOString();
      const res = await syncEngine.syncSystemLogs(nowIso, testDate);

      // Verify syncEngine recognized the error on page 101 and stopped safely
      assert.strictEqual(res.hasErrors, true, 'Sync should record hasErrors=true due to interruption on page 101');
      assert.strictEqual(pagesRequested.includes(100), true, 'Page 100 must have been requested');
      assert.strictEqual(pagesRequested.includes(101), true, 'Page 101 must have been attempted');
      assert.strictEqual(pagesRequested.includes(102), false, 'Page 102 must not be requested after page 101 failure');

      // Verify historical coverage record
      const cov = getCoverageRecord('logs', testDate);
      assert.ok(cov, 'historical_coverage record must exist');
      assert.strictEqual(cov.pages_read, 100, 'pages_read must be exactly 100');
      assert.strictEqual(cov.pages_discovered, 224, 'pages_discovered must be 224');
      assert.strictEqual(cov.completion_status, 'PARTIAL', 'completion_status must be PARTIAL');
      assert.strictEqual(cov.completed_at, null, 'completed_at must be null while partial');

      // Verify events saved so far: 100 pages * 2 = 200 events
      const savedCount = (db.prepare(`
        SELECT COUNT(*) as c FROM canonical_activity_events
        WHERE event_timestamp >= ? AND event_timestamp < ?
      `).get(interval.startCairo, interval.endCairo) as any)?.c || 0;
      assert.strictEqual(savedCount, 200, 'Exactly 200 events must be saved after 100 pages');

      // Verify getTodayLogsCoverage reports PARTIAL
      const todayCov = syncEngine.getTodayLogsCoverage();
      assert.notStrictEqual(todayCov.completionStatus, 'COMPLETE', 'Worker must never report COMPLETE when pages_read < pages_discovered');
    } finally {
      (vendoorClient as any).fetchSystemLogs = originalFetch;
    }
  });

  await t.test('2. Resumption of Remaining 124 Pages (101 to 224) without re-fetching pages 2..100', async () => {
    let pagesRequested: number[] = [];
    const originalFetch = vendoorClient.fetchSystemLogs.bind(vendoorClient);

    // Mock vendoorClient to succeed across all 224 pages
    (vendoorClient as any).fetchSystemLogs = async (page: number, _start?: string, _end?: string) => {
      pagesRequested.push(page);
      return {
        entries: generatePageEntries(page, 2),
        totalPages: 224,
      };
    };

    try {
      const nowIso = new Date().toISOString();
      const res = await syncEngine.syncSystemLogs(nowIso, testDate);

      // Verify that page 1 was checked (for real-time newest incoming logs)
      assert.strictEqual(pagesRequested.includes(1), true, 'Page 1 must be checked for incoming real-time logs');

      // Verify that crawl resumed directly from page 101!
      assert.strictEqual(pagesRequested.includes(2), false, 'Page 2 should NOT be re-requested on resumption');
      assert.strictEqual(pagesRequested.includes(50), false, 'Page 50 should NOT be re-requested on resumption');
      assert.strictEqual(pagesRequested.includes(100), false, 'Page 100 should NOT be re-requested on resumption');
      assert.strictEqual(pagesRequested.includes(101), true, 'Page 101 must be the resumption start point');
      assert.strictEqual(pagesRequested.includes(224), true, 'Page 224 must be requested and completed');

      // Exactly 124 remaining pages (101..224) plus page 1 = 125 page calls
      const remainingPages = pagesRequested.filter(p => p >= 101 && p <= 224);
      assert.strictEqual(remainingPages.length, 124, 'Exactly 124 remaining pages must be crawled');

      // Verify historical coverage is now COMPLETE
      const cov = getCoverageRecord('logs', testDate);
      assert.ok(cov, 'historical_coverage record must exist');
      assert.strictEqual(cov.pages_read, 224, 'pages_read must reach 224');
      assert.strictEqual(cov.pages_discovered, 224, 'pages_discovered must be 224');
      assert.strictEqual(cov.completion_status, 'COMPLETE', 'completion_status must now be COMPLETE');
      assert.ok(cov.completed_at, 'completed_at must be populated');

      // Verify all 224 * 2 = 448 events exist with ZERO duplicates
      const finalCount = (db.prepare(`
        SELECT COUNT(*) as c FROM canonical_activity_events
        WHERE event_timestamp >= ? AND event_timestamp < ?
      `).get(interval.startCairo, interval.endCairo) as any)?.c || 0;
      assert.strictEqual(finalCount, 448, 'Total canonical events must be exactly 448');

      const rawCount = (db.prepare(`
        SELECT COUNT(*) as c FROM raw_activity_events
        WHERE event_timestamp >= ? AND event_timestamp < ?
      `).get(interval.startCairo, interval.endCairo) as any)?.c || 0;
      assert.strictEqual(rawCount, 448, 'Total raw events must be exactly 448 without duplication');
    } finally {
      (vendoorClient as any).fetchSystemLogs = originalFetch;
    }
  });

  await t.test('3. Cache Reload: Completed day does not re-crawl all 224 pages from network', async () => {
    let pagesRequested: number[] = [];
    const originalFetch = vendoorClient.fetchSystemLogs.bind(vendoorClient);

    (vendoorClient as any).fetchSystemLogs = async (page: number) => {
      pagesRequested.push(page);
      return {
        entries: generatePageEntries(page, 2),
        totalPages: 224,
      };
    };

    try {
      // Mark remoteArchiveStatus to avoid remote Supabase sync during test
      saveCoverageRecord({
        periodDate: testDate,
        sourceDomain: 'logs',
        storageTier: 'HOT',
        pagesDiscovered: 224,
        pagesRead: 224,
        recordsExtracted: 448,
        recordsSaved: 448,
        completionStatus: 'COMPLETE',
        remoteArchiveStatus: 'REMOTE_VERIFIED',
      });

      const resolved = await resolveHistoricalDay(testDate, { autoFetchMissing: true, forceRefetch: false });

      assert.strictEqual(resolved.completionStatus, 'COMPLETE');
      assert.strictEqual(resolved.loadedFromCache, true, 'Must load from local storage cache when complete');
      assert.strictEqual(pagesRequested.length, 0, 'No pages should be fetched when day is already complete in cache');
    } finally {
      (vendoorClient as any).fetchSystemLogs = originalFetch;
    }
  });

  await t.test('4. Arbitrary Mid-Crawl Interruption & Progressive Checkpointing (e.g. at page 25 of 35)', async () => {
    const freshDate = '2026-10-24';
    const freshInterval = getCairoDateInterval(freshDate);

    db.prepare(`
      DELETE FROM historical_coverage WHERE period_date = ? AND source_domain = 'logs'
    `).run(freshDate);
    db.prepare(`
      DELETE FROM canonical_activity_events WHERE event_timestamp >= ? AND event_timestamp < ?
    `).run(freshInterval.startCairo, freshInterval.endCairo);

    let pagesCalled: number[] = [];
    const originalFetch = vendoorClient.fetchSystemLogs.bind(vendoorClient);

    // Pass A: Fail on page 25
    (vendoorClient as any).fetchSystemLogs = async (page: number) => {
      pagesCalled.push(page);
      if (page === 25) {
        throw new Error('Timeout on page 25');
      }
      return {
        entries: generatePageEntries(page, 2),
        totalPages: 35,
      };
    };

    try {
      await syncEngine.syncSystemLogs(new Date().toISOString(), freshDate);
      const covA = getCoverageRecord('logs', freshDate);
      assert.ok(covA);
      assert.strictEqual(covA.pages_read, 24, 'Should checkpoint at last successful page 24');
      assert.strictEqual(covA.pages_discovered, 35);
      assert.strictEqual(covA.completion_status, 'PARTIAL');

      // Pass B: Network restored, completes remaining pages 25..35
      pagesCalled = [];
      (vendoorClient as any).fetchSystemLogs = async (page: number) => {
        pagesCalled.push(page);
        return {
          entries: generatePageEntries(page, 2),
          totalPages: 35,
        };
      };

      await syncEngine.syncSystemLogs(new Date().toISOString(), freshDate);
      assert.strictEqual(pagesCalled.includes(2), false, 'Must not re-crawl page 2');
      assert.strictEqual(pagesCalled.includes(24), false, 'Must not re-crawl page 24');
      assert.strictEqual(pagesCalled.includes(25), true, 'Must resume at page 25');
      assert.strictEqual(pagesCalled.includes(35), true, 'Must reach page 35');

      const covB = getCoverageRecord('logs', freshDate);
      assert.strictEqual(covB.pages_read, 35);
      assert.strictEqual(covB.completion_status, 'COMPLETE');
    } finally {
      (vendoorClient as any).fetchSystemLogs = originalFetch;
    }
  });

  await t.test('5. Date Boundary Isolation: Strict Africa/Cairo boundaries prevent cross-day leakage', async () => {
    const dayTarget = '2026-10-25';
    const dayTargetInterval = getCairoDateInterval(dayTarget);

    const testEntries: LogEntry[] = [
      {
        index: 1,
        orderCode: 'ORD-BOUND-1',
        actorName: 'CS 1',
        rawActionText: 'تم تأكيد الطلب وطباعة البوليصة',
        eventTimestamp: '2026-10-24 23:59:59',
      },
      {
        index: 2,
        orderCode: 'ORD-BOUND-2',
        actorName: 'CS 2',
        rawActionText: 'تم تأكيد الطلب وطباعة البوليصة',
        eventTimestamp: '2026-10-25 00:00:00',
      },
      {
        index: 3,
        orderCode: 'ORD-BOUND-3',
        actorName: 'CS 3',
        rawActionText: 'تم تأكيد الطلب وطباعة البوليصة',
        eventTimestamp: '2026-10-26 00:00:00',
      },
    ];

    const persistRes = persistLogEntries(testEntries, dayTargetInterval, {
      dataSource: 'VENDOOR_FETCH',
      strictInterval: true,
    });

    // Exactly 1 entry (ORD-BOUND-2) should be saved for 2026-10-25!
    assert.strictEqual(persistRes.saved, 1, 'Only the entry within [startCairo, endCairo) must be saved');

    const inDay = (db.prepare(`
      SELECT order_code FROM canonical_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ?
        AND order_code IN ('ORD-BOUND-1', 'ORD-BOUND-2', 'ORD-BOUND-3')
    `).all(dayTargetInterval.startCairo, dayTargetInterval.endCairo) as any[]);

    assert.strictEqual(inDay.length, 1);
    assert.strictEqual(inDay[0].order_code, 'ORD-BOUND-2');
  });

  await t.test('6. Movement Parity: Distinguishes unique orders from total events without using current_status as proxy', async () => {
    const dayTarget = '2026-10-25';
    const dayTargetInterval = getCairoDateInterval(dayTarget);

    // Two distinct confirmation movements on the SAME order code
    const duplicateMovements: LogEntry[] = [
      {
        index: 991,
        orderCode: 'ORD-PARITY-MULTI',
        actorName: 'CS Reconfirm 1',
        rawActionText: 'تم تأكيد الطلب وطباعة البوليصة',
        eventTimestamp: '2026-10-25 10:00:00',
      },
      {
        index: 992,
        orderCode: 'ORD-PARITY-MULTI',
        actorName: 'CS Reconfirm 2',
        rawActionText: 'تم تأكيد الطلب وطباعة البوليصة',
        eventTimestamp: '2026-10-25 11:30:00',
      },
    ];

    persistLogEntries(duplicateMovements, dayTargetInterval, {
      dataSource: 'VENDOOR_FETCH',
      strictInterval: true,
    });

    const uniqueCount = (db.prepare(`
      SELECT COUNT(DISTINCT order_code) as c FROM canonical_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ?
        AND (to_status = 'Printed' OR action_type = 'confirmation')
        AND order_code = 'ORD-PARITY-MULTI'
    `).get(dayTargetInterval.startCairo, dayTargetInterval.endCairo) as any)?.c || 0;

    const totalEvents = (db.prepare(`
      SELECT COUNT(*) as c FROM canonical_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ?
        AND (to_status = 'Printed' OR action_type = 'confirmation')
        AND order_code = 'ORD-PARITY-MULTI'
    `).get(dayTargetInterval.startCairo, dayTargetInterval.endCairo) as any)?.c || 0;

    assert.strictEqual(uniqueCount, 1, 'Unique orders must remain 1');
    assert.strictEqual(totalEvents, 2, 'Total events must be 2');
  });
});
