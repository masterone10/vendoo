import { db, getCairoDateInterval, saveCoverageRecord, type HistoricalCoverageRecord } from './db.ts';
import { vendoorClient } from './vendoorClient.ts';
import { persistLogEntries, repairRawWithoutCanonical } from './historicalLogsService.ts';
import { importBatchLogFiles } from './batchLogsImporter.ts';
import {
  isSupabaseConfigured,
  syncDayLogsToSupabase,
  fetchDayLogsFromSupabase,
} from './supabaseClient.ts';

export type HistoricalDayDecision =
  | 'USE_SUPABASE_ARCHIVE'   // Case A: Restored or read from remote verified Supabase
  | 'USE_EXTERNAL_IMPORT'    // Case B: Registered from Excel/CSV; strictly prevent auto-pull
  | 'USE_LOCAL_STORAGE'      // Case C: Exists in local SQLite; ready to use
  | 'JOB_IN_PROGRESS'        // Case D: Another job is currently running for this period
  | 'FETCH_FROM_VENDOOR'     // Case E: Day is completely absent; auto-fetch triggered
  | 'USE_PARTIAL_LOCAL'      // Case F: Partial data used as-is; manual completion available
  | 'EMPTY_VERIFIED';        // Case H: Verified zero-movement day

export interface ResolveDayOptions {
  forceRefetch?: boolean;        // Explicit user request to re-fetch/complete from Vendoor
  autoFetchMissing?: boolean;    // Auto-fetch if completely absent (default: true)
  batchId?: string;
  onProgress?: (stage: string, labelAr: string, pagesFetched: number, pagesTotal: number, recordsSaved: number) => void;
}

export interface ResolvedDayResult {
  date: string;
  decision: HistoricalDayDecision;
  dataSource: 'EXCEL_IMPORT' | 'CSV_IMPORT' | 'VENDOOR_FETCH' | 'SUPABASE_ARCHIVE' | 'MIXED' | 'NONE';
  completionStatus: 'COMPLETE' | 'PARTIAL' | 'UNVERIFIED_SOURCE' | 'FAILED' | 'EMPTY_VERIFIED' | 'NOT_SYNCED';
  localStorageStatus: 'LOCAL_SAVED' | 'LOCAL_PARTIAL' | 'NONE';
  remoteArchiveStatus: 'REMOTE_VERIFIED' | 'REMOTE_SYNCED' | 'PENDING_REMOTE' | 'REMOTE_FAILED' | 'NONE';
  rawRecordsCount: number;
  canonicalEventsCount: number;
  loadedFromCache: boolean;
  messageAr: string;
  error?: string | null;
}

// In-memory active resolver jobs to prevent parallel duplicate pulls
const activeDayResolutions = new Map<string, Promise<ResolvedDayResult>>();

/**
 * Central Decision Policy Engine: resolveHistoricalDay()
 * Evaluates whether a requested date has historical data in any recorded source.
 * Strict Rule: Existing historical records PREVENT automatic full day re-downloads.
 * Automatically restores missing logs from Supabase and repairs raw-to-canonical gaps.
 */
export async function resolveHistoricalDay(
  dateStr: string,
  options: ResolveDayOptions = {}
): Promise<ResolvedDayResult> {
  const cleanDate = dateStr.trim().slice(0, 10);
  const forceRefetch = Boolean(options.forceRefetch);
  const autoFetchMissing = options.autoFetchMissing !== false;

  // Case D: If already in progress, avoid launching a duplicate parallel execution
  if (!forceRefetch && activeDayResolutions.has(cleanDate)) {
    return activeDayResolutions.get(cleanDate)!;
  }

  const promise = (async (): Promise<ResolvedDayResult> => {
    const interval = getCairoDateInterval(cleanDate);

    // 0. Only repair raw-to-canonical gaps if uncanonical records exist locally
    const uncanonicalCount = (db.prepare(`
      SELECT COUNT(*) as c FROM raw_activity_events r
      WHERE r.event_timestamp >= ? AND r.event_timestamp < ?
        AND NOT EXISTS (SELECT 1 FROM canonical_activity_events c WHERE c.raw_event_id = r.id)
    `).get(interval.startCairo, interval.endCairo) as any)?.c || 0;

    if (uncanonicalCount > 0) {
      try {
        repairRawWithoutCanonical(cleanDate);
      } catch {}
    }

    // 1. Inspect local coverage registry
    const cov: any = db.prepare(`
      SELECT * FROM historical_coverage
      WHERE period_date = ? AND source_domain = 'logs'
    `).get(cleanDate);

    // 2. Count existing records in local SQLite
    let rawCount = (db.prepare(`
      SELECT COUNT(*) as c FROM raw_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ?
    `).get(interval.startCairo, interval.endCairo) as any)?.c || 0;

    let canonCount = (db.prepare(`
      SELECT COUNT(*) as c FROM canonical_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ?
    `).get(interval.startCairo, interval.endCairo) as any)?.c || 0;

    let hasLocalData = rawCount > 0 || canonCount > 0;

    // -------------------------------------------------------------------------
    // Case H: Day verified complete with zero movements
    // -------------------------------------------------------------------------
    if (!forceRefetch && cov?.completion_status === 'EMPTY_VERIFIED') {
      return {
        date: cleanDate,
        decision: 'EMPTY_VERIFIED',
        dataSource: (cov.data_source as any) || 'VENDOOR_FETCH',
        completionStatus: 'EMPTY_VERIFIED',
        localStorageStatus: 'LOCAL_SAVED',
        remoteArchiveStatus: (cov.remote_archive_status as any) || 'NONE',
        rawRecordsCount: 0,
        canonicalEventsCount: 0,
        loadedFromCache: true,
        messageAr: 'يوم تم التحقق من خلوه من أي حركات في النظام',
      };
    }

    // -------------------------------------------------------------------------
    // Case A & B: Check Supabase PostgreSQL Archive
    // CLOUD ARCHIVE POLICY: Remote archive begins from 2026-10-23.
    // Days prior to 2026-10-23 are stored locally in SQLite and not queried from remote.
    // -------------------------------------------------------------------------
    if (!forceRefetch && cleanDate >= '2026-10-23' && isSupabaseConfigured() && (!hasLocalData || cov?.completion_status === 'PARTIAL' || !cov)) {
      options.onProgress?.('CHECKING_STORAGE', 'جاري فحص أرشيف Supabase البعيد...', 0, 1, 0);
      try {
        const restoreRes = await fetchDayLogsFromSupabase(cleanDate);
        if (restoreRes.success && (restoreRes.rawRestored > 0 || restoreRes.canonicalRestored > 0)) {
          // Re-query local counts after restoration
          canonCount = (db.prepare(`
            SELECT COUNT(*) as c FROM canonical_activity_events
            WHERE event_timestamp >= ? AND event_timestamp < ?
          `).get(interval.startCairo, interval.endCairo) as any)?.c || 0;

          rawCount = (db.prepare(`
            SELECT COUNT(*) as c FROM raw_activity_events
            WHERE event_timestamp >= ? AND event_timestamp < ?
          `).get(interval.startCairo, interval.endCairo) as any)?.c || 0;

          hasLocalData = rawCount > 0 || canonCount > 0;

          let remoteCovStatus: 'COMPLETE' | 'PARTIAL' = 'COMPLETE';
          try {
            const { pgQuery } = await import('./supabaseClient.ts');
            const covRes = await pgQuery<{ completion_status: string }>(
              `SELECT completion_status FROM historical_coverage WHERE period_date = $1 LIMIT 1`,
              [cleanDate]
            );
            if (covRes.rows[0]?.completion_status === 'PARTIAL') {
              remoteCovStatus = 'PARTIAL';
            }
          } catch {}

          // Update day registry
          const nowIso = new Date().toISOString();
          saveCoverageRecord({
            accountId: 'primary',
            sourceDomain: 'logs',
            periodDate: cleanDate,
            storageTier: 'HOT',
            pagesDiscovered: 1,
            pagesRead: 1,
            recordsExtracted: rawCount,
            recordsSaved: rawCount,
            completionStatus: remoteCovStatus,
            dataSource: 'SUPABASE_ARCHIVE',
            canonicalEventsCount: canonCount,
            localStorageStatus: 'LOCAL_SAVED',
            remoteArchiveStatus: 'REMOTE_VERIFIED',
            lastAttemptedAt: nowIso,
            completedAt: nowIso,
            verifiedAt: nowIso,
            lastSupabaseVerifiedAt: nowIso,
            notes: `Restored cleanly from Supabase PostgreSQL Archive (${remoteCovStatus})`,
          });

          return {
            date: cleanDate,
            decision: 'USE_SUPABASE_ARCHIVE',
            dataSource: 'SUPABASE_ARCHIVE',
            completionStatus: remoteCovStatus,
            localStorageStatus: 'LOCAL_SAVED',
            remoteArchiveStatus: 'REMOTE_VERIFIED',
            rawRecordsCount: rawCount,
            canonicalEventsCount: canonCount,
            loadedFromCache: true,
            messageAr: remoteCovStatus === 'COMPLETE'
              ? 'تم استرجاع ومطابقة بيانات اليوم من أرشيف Supabase السحابي بنجاح'
              : 'تم استرجاع سجلات اليوم المتاحة من أرشيف Supabase (تغطية جزئية)',
          };
        }
      } catch (supaErr: any) {
        console.warn(`[HistoricalDayResolver] Remote Supabase restore check skipped for ${cleanDate}:`, supaErr.message);
      }
    }

    // -------------------------------------------------------------------------
    // Case B: Day exists from Excel / CSV Import
    // Rule: Existence in external import STRICTLY blocks automatic full Vendoor download.
    // -------------------------------------------------------------------------
    const isImported =
      cov?.data_source === 'EXCEL_IMPORT' ||
      cov?.data_source === 'CSV_IMPORT' ||
      (cov?.completion_status === 'UNVERIFIED_SOURCE');

    if (!forceRefetch && (isImported || (hasLocalData && cov?.data_source?.includes('IMPORT')))) {
      // If not yet verified on Supabase, trigger background sync (only for dates >= 2026-10-23)
      if (cleanDate >= '2026-10-23' && isSupabaseConfigured() && cov?.remote_archive_status !== 'REMOTE_VERIFIED') {
        syncDayLogsToSupabase(cleanDate).catch(() => {});
      }

      return {
        date: cleanDate,
        decision: 'USE_EXTERNAL_IMPORT',
        dataSource: (cov?.data_source as any) || 'EXCEL_IMPORT',
        completionStatus: cov?.completion_status || 'UNVERIFIED_SOURCE',
        localStorageStatus: 'LOCAL_SAVED',
        remoteArchiveStatus: (cov?.remote_archive_status as any) || 'PENDING_REMOTE',
        rawRecordsCount: rawCount,
        canonicalEventsCount: canonCount,
        loadedFromCache: true,
        messageAr: 'البيانات مستوردة من ملف خارجي (يمنع السحب التلقائي، متاح للاستعراض والتقرير)',
      };
    }

    // -------------------------------------------------------------------------
    // Case C: Day already exists locally in SQLite and is complete
    // Strict Rule: Must have completion_status === 'COMPLETE' and not have pages_read < pages_discovered
    // -------------------------------------------------------------------------
    const isStrictlyComplete =
      cov?.completion_status === 'COMPLETE' &&
      !(cov.pages_discovered > 1 && cov.pages_read < cov.pages_discovered);

    if (!forceRefetch && hasLocalData && isStrictlyComplete) {
      // Sync to Supabase in background if missing remote verification (only for dates >= 2026-10-23)
      if (cleanDate >= '2026-10-23' && isSupabaseConfigured() && cov?.remote_archive_status !== 'REMOTE_VERIFIED') {
        syncDayLogsToSupabase(cleanDate).catch(() => {});
      }

      return {
        date: cleanDate,
        decision: cov?.data_source === 'SUPABASE_ARCHIVE' ? 'USE_SUPABASE_ARCHIVE' : 'USE_LOCAL_STORAGE',
        dataSource: (cov?.data_source as any) || 'VENDOOR_FETCH',
        completionStatus: 'COMPLETE',
        localStorageStatus: 'LOCAL_SAVED',
        remoteArchiveStatus: (cov?.remote_archive_status as any) || (isSupabaseConfigured() ? 'PENDING_REMOTE' : 'NONE'),
        rawRecordsCount: rawCount,
        canonicalEventsCount: canonCount,
        loadedFromCache: true,
        messageAr: cov?.data_source === 'SUPABASE_ARCHIVE'
          ? 'تم استرجاع ومطابقة بيانات اليوم من أرشيف Supabase السحابي بنجاح'
          : 'البيانات محفوظة ومكتملة محلياً',
      };
    }

    // -------------------------------------------------------------------------
    // Case F: Partial data exists locally (PARTIAL status or pages_read < pages_discovered)
    // Rule: If autoFetchMissing is enabled (default: true), automatically complete missing pages from Vendoor!
    // Only if autoFetchMissing is explicitly false do we return USE_PARTIAL_LOCAL.
    // -------------------------------------------------------------------------
    const isPartialCoverage =
      hasLocalData &&
      (cov?.completion_status === 'PARTIAL' ||
        !cov ||
        (cov?.pages_discovered > 1 && cov?.pages_read < cov?.pages_discovered));

    if (!forceRefetch && isPartialCoverage) {
      if (!autoFetchMissing) {
        return {
          date: cleanDate,
          decision: 'USE_PARTIAL_LOCAL',
          dataSource: (cov?.data_source as any) || 'VENDOOR_FETCH',
          completionStatus: 'PARTIAL',
          localStorageStatus: 'LOCAL_PARTIAL',
          remoteArchiveStatus: (cov?.remote_archive_status as any) || 'PENDING_REMOTE',
          rawRecordsCount: rawCount,
          canonicalEventsCount: canonCount,
          loadedFromCache: true,
          messageAr: 'البيانات جزئية مسجلة محلياً (السحب التلقائي غير مفعّل)',
        };
      }
      // If autoFetchMissing is true, proceed to fetch/complete from Vendoor below!
    }

    // -------------------------------------------------------------------------
    // Case E: Day is completely absent OR has partial data needing completion OR explicit forceRefetch
    // Action: Auto-fetch from Vendoor, complete missing pages or re-pull, save, sync to Supabase, verify.
    // -------------------------------------------------------------------------
    if (!autoFetchMissing && !forceRefetch) {
      return {
        date: cleanDate,
        decision: 'FETCH_FROM_VENDOOR',
        dataSource: 'NONE',
        completionStatus: 'NOT_SYNCED',
        localStorageStatus: 'NONE',
        remoteArchiveStatus: 'NONE',
        rawRecordsCount: 0,
        canonicalEventsCount: 0,
        loadedFromCache: false,
        messageAr: 'اليوم غير موجود ضمن البيانات التاريخية المسجلة',
      };
    }

    // Begin Auto-fetch from Vendoor
    options.onProgress?.('FETCHING_VENDOOR', `جاري جلب لوجز ${cleanDate} من Vendoor...`, 0, 1, 0);

    if (!vendoorClient.isConfigured()) {
      return {
        date: cleanDate,
        decision: 'FETCH_FROM_VENDOOR',
        dataSource: 'VENDOOR_FETCH',
        completionStatus: 'FAILED',
        localStorageStatus: 'NONE',
        remoteArchiveStatus: 'NONE',
        rawRecordsCount: 0,
        canonicalEventsCount: 0,
        loadedFromCache: false,
        messageAr: 'تعذر الجلب: بيانات دخول Vendoor غير مهيأة في بيئة التشغيل',
        error: 'VENDOOR_EMAIL / VENDOOR_PASSWORD not configured',
      };
    }

    let pagesDiscovered = 1;
    let pagesRead = 0;
    let recordsSavedThisPass = 0;
    let isPartial = false;
    let fetchError: string | null = null;

    try {
      const canResumePagination = Boolean(
        !forceRefetch &&
        hasLocalData &&
        cov &&
        cov.data_source === 'VENDOOR_FETCH' &&
        cov.pages_read > 0 &&
        cov.pages_discovered > cov.pages_read
      );

      let resumedSuccessfully = false;

      if (canResumePagination) {
        try {
          const fromPage = cov.pages_read + 1;
          let toPage = cov.pages_discovered;
          pagesDiscovered = toPage;
          pagesRead = cov.pages_read;

          options.onProgress?.(
            'FETCHING_VENDOOR',
            `جاري استكمال الصفحات الناقصة (${fromPage} إلى ${toPage}) ليوم ${cleanDate}...`,
            pagesRead,
            pagesDiscovered,
            recordsSavedThisPass
          );

          let allPagesSucceeded = true;
          for (let p = fromPage; p <= toPage; p++) {
            let pageFetched = false;
            let lastPageErr: any = null;

            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                if (attempt === 1) await new Promise(r => setTimeout(r, 50));
                options.onProgress?.(
                  'FETCHING_VENDOOR',
                  `جاري استكمال صفحة ${p} من ${toPage}${attempt > 1 ? ` (محاولة ${attempt}/3)` : ''}...`,
                  p,
                  toPage,
                  recordsSavedThisPass
                );

                const nextP = await vendoorClient.fetchSystemLogs(p, cleanDate, cleanDate);
                pagesRead = p;
                if (nextP.totalPages > toPage) {
                  toPage = nextP.totalPages;
                  pagesDiscovered = toPage;
                }

                options.onProgress?.('SAVING_RECORDS', `جاري حفظ السجلات المستكملة (صفحة ${p}/${toPage})...`, p, toPage, recordsSavedThisPass);
                const nextRes = persistLogEntries(nextP.entries, interval, {
                  dataSource: 'VENDOOR_FETCH',
                  strictInterval: true,
                });
                recordsSavedThisPass += nextRes.saved;
                pageFetched = true;
                break;
              } catch (pageErr: any) {
                lastPageErr = pageErr;
                if (attempt < 3) {
                  await new Promise(r => setTimeout(r, 600 * attempt));
                }
              }
            }

            if (!pageFetched) {
              allPagesSucceeded = false;
              break;
            }
          }

          if (allPagesSucceeded) {
            resumedSuccessfully = true;
          } else {
            console.warn(`[HistoricalDayResolver] Smart resume incomplete for ${cleanDate}, falling back to full verified re-pull`);
          }
        } catch (resumeErr: any) {
          console.warn(`[HistoricalDayResolver] Smart resume failed for ${cleanDate}: ${resumeErr.message}, falling back to full verified re-pull`);
        }
      }

      if (!resumedSuccessfully) {
        // 1. Fetch Page 1
        const p1 = await vendoorClient.fetchSystemLogs(1, cleanDate, cleanDate);
        pagesDiscovered = Math.max(1, p1.totalPages);
        pagesRead = 1;
        options.onProgress?.('SAVING_RECORDS', `جاري حفظ السجلات (صفحة 1/${pagesDiscovered})...`, 1, pagesDiscovered, p1.entries.length);

        // Check for Case H: Empty Day Verified
        if (p1.entries.length === 0 && pagesDiscovered <= 1) {
          const nowIso = new Date().toISOString();
          saveCoverageRecord({
            accountId: 'primary',
            sourceDomain: 'logs',
            periodDate: cleanDate,
            storageTier: 'HOT',
            pagesDiscovered: 1,
            pagesRead: 1,
            recordsExtracted: 0,
            recordsSaved: 0,
            completionStatus: 'EMPTY_VERIFIED',
            dataSource: 'VENDOOR_FETCH',
            canonicalEventsCount: 0,
            localStorageStatus: 'LOCAL_SAVED',
            remoteArchiveStatus: isSupabaseConfigured() ? 'REMOTE_VERIFIED' : 'NONE',
            lastAttemptedAt: nowIso,
            completedAt: nowIso,
            verifiedAt: nowIso,
            notes: 'Verified from Vendoor: zero movements on this date',
          });

          return {
            date: cleanDate,
            decision: 'EMPTY_VERIFIED',
            dataSource: 'VENDOOR_FETCH',
            completionStatus: 'EMPTY_VERIFIED',
            localStorageStatus: 'LOCAL_SAVED',
            remoteArchiveStatus: isSupabaseConfigured() ? 'REMOTE_VERIFIED' : 'NONE',
            rawRecordsCount: 0,
            canonicalEventsCount: 0,
            loadedFromCache: false,
            messageAr: 'تم التحقق من المصدر: لا توجد أي حركات مسجلة لهذا اليوم',
          };
        }

        // Persist page 1
        const p1Res = persistLogEntries(p1.entries, interval, {
          dataSource: 'VENDOOR_FETCH',
          strictInterval: true,
        });
        recordsSavedThisPass += p1Res.saved;

        // 2. Fast-path: If day has multiple pages, attempt bulk Excel export to ingest full day in 1 call
        let bulkLoaded = false;
        if (pagesDiscovered > 3) {
          try {
            options.onProgress?.('FETCHING_VENDOOR', `جاري محاولة التنزيل المباشر ليوم ${cleanDate}...`, 1, pagesDiscovered, recordsSavedThisPass);
            const excelBuf = await vendoorClient.exportSystemLogsExcel(cleanDate, cleanDate);
            if (excelBuf && excelBuf.length > 500) {
              const batchRes = await importBatchLogFiles([
                { fileName: `vendoor_logs_${cleanDate}.xlsx`, buffer: excelBuf }
              ]);
              if (batchRes && batchRes.discoveredDates.some(d => d.date === cleanDate && (d.savedCount > 0 || d.rowsCount > 0))) {
                bulkLoaded = true;
                pagesRead = pagesDiscovered;
              }
            }
          } catch (excelErr: any) {
            console.warn(`[HistoricalResolver] Bulk export skipped for ${cleanDate}, falling back to pagination:`, excelErr.message);
          }
        }

        // 3. Fetch remaining pages with retry and pacing if not bulk loaded
        if (!bulkLoaded) {
          for (let p = 2; p <= pagesDiscovered; p++) {
            let pageFetched = false;
            let lastPageErr: any = null;

            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                if (p > 2 && attempt === 1) {
                  await new Promise(r => setTimeout(r, 50));
                }
                options.onProgress?.(
                  'FETCHING_VENDOOR',
                  `جاري جلب صفحة ${p} من ${pagesDiscovered}${attempt > 1 ? ` (محاولة ${attempt}/3)` : ''}...`,
                  p,
                  pagesDiscovered,
                  recordsSavedThisPass
                );
                const nextP = await vendoorClient.fetchSystemLogs(p, cleanDate, cleanDate);
                pagesRead = p;
                if (nextP.totalPages > pagesDiscovered) {
                  pagesDiscovered = nextP.totalPages;
                }

                options.onProgress?.('SAVING_RECORDS', `جاري حفظ السجلات (صفحة ${p}/${pagesDiscovered})...`, p, pagesDiscovered, recordsSavedThisPass);
                const nextRes = persistLogEntries(nextP.entries, interval, {
                  dataSource: 'VENDOOR_FETCH',
                  strictInterval: true,
                });
                recordsSavedThisPass += nextRes.saved;
                pageFetched = true;
                break;
              } catch (pageErr: any) {
                lastPageErr = pageErr;
                if (attempt < 3) {
                  console.warn(`[HistoricalDayResolver] Retrying page ${p} (${attempt}/3) for ${cleanDate}: ${pageErr.message}`);
                  await new Promise(r => setTimeout(r, 600 * attempt));
                }
              }
            }

            if (!pageFetched) {
              isPartial = true;
              fetchError = `تعذر قراءة الصفحة ${p}: ${lastPageErr?.message}`;
              break;
            }
          }
        }
      }
    } catch (err: any) {
      isPartial = true;
      fetchError = err.message;
    }

    // Determine final status: Strictly complete only if !isPartial and all pages were read
    const isTrulyComplete = !isPartial && pagesRead >= pagesDiscovered;
    const finalStatus: 'COMPLETE' | 'PARTIAL' | 'FAILED' = isTrulyComplete
      ? 'COMPLETE'
      : (recordsSavedThisPass > 0) ? 'PARTIAL' : 'FAILED';

    // Query updated totals
    const finalRawCount = (db.prepare(`
      SELECT COUNT(*) as c FROM raw_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ?
    `).get(interval.startCairo, interval.endCairo) as any)?.c || 0;

    const finalCanonCount = (db.prepare(`
      SELECT COUNT(*) as c FROM canonical_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ?
    `).get(interval.startCairo, interval.endCairo) as any)?.c || 0;

    const nowIso = new Date().toISOString();

    // Sync to Supabase & verify (enforce cloud archive start date 2026-10-23)
    let remoteStatus: 'REMOTE_VERIFIED' | 'REMOTE_SYNCED' | 'PENDING_REMOTE' | 'REMOTE_FAILED' | 'NONE' = 'NONE';
    if (cleanDate >= '2026-10-23' && isSupabaseConfigured() && finalStatus !== 'FAILED') {
      options.onProgress?.('SAVING_RECORDS', 'جاري المزامنة والتحقق من Supabase...', pagesRead, pagesDiscovered, finalRawCount);
      try {
        const supaSync = await syncDayLogsToSupabase(cleanDate);
        if (supaSync.verified) {
          remoteStatus = 'REMOTE_VERIFIED';
        } else if (supaSync.success) {
          remoteStatus = 'REMOTE_SYNCED';
        } else {
          remoteStatus = 'REMOTE_FAILED';
        }
      } catch {
        remoteStatus = 'REMOTE_FAILED';
      }
    }

    saveCoverageRecord({
      accountId: 'primary',
      sourceDomain: 'logs',
      periodDate: cleanDate,
      storageTier: 'HOT',
      pagesDiscovered,
      pagesRead,
      recordsExtracted: finalRawCount,
      recordsSaved: finalRawCount,
      completionStatus: finalStatus,
      dataSource: 'VENDOOR_FETCH',
      canonicalEventsCount: finalCanonCount,
      localStorageStatus: finalStatus === 'FAILED' ? 'NONE' : finalStatus === 'PARTIAL' ? 'LOCAL_PARTIAL' : 'LOCAL_SAVED',
      remoteArchiveStatus: remoteStatus,
      lastAttemptedAt: nowIso,
      completedAt: finalStatus !== 'FAILED' ? nowIso : null,
      verifiedAt: remoteStatus === 'REMOTE_VERIFIED' ? nowIso : null,
      lastVendoorFetchAt: nowIso,
      lastSupabaseVerifiedAt: remoteStatus === 'REMOTE_VERIFIED' ? nowIso : null,
      errorMessage: fetchError,
      notes: `Fetched from Vendoor: ${pagesRead}/${pagesDiscovered} pages read`,
    });

    return {
      date: cleanDate,
      decision: 'FETCH_FROM_VENDOOR',
      dataSource: 'VENDOOR_FETCH',
      completionStatus: finalStatus,
      localStorageStatus: finalStatus === 'FAILED' ? 'NONE' : finalStatus === 'PARTIAL' ? 'LOCAL_PARTIAL' : 'LOCAL_SAVED',
      remoteArchiveStatus: remoteStatus,
      rawRecordsCount: finalRawCount,
      canonicalEventsCount: finalCanonCount,
      loadedFromCache: false,
      messageAr: finalStatus === 'COMPLETE'
        ? 'تم جلب جميع صفحات اليوم وحفظها وتوثيقها بنجاح'
        : finalStatus === 'PARTIAL'
        ? `تم جلب بعض الصفحات (${pagesRead}/${pagesDiscovered}) — التغطية جزئية`
        : `فشل جلب اليوم: ${fetchError || 'خطأ غير محدد'}`,
      error: fetchError,
    };
  })();

  activeDayResolutions.set(cleanDate, promise);
  try {
    const res = await promise;
    return res;
  } finally {
    activeDayResolutions.delete(cleanDate);
  }
}

/**
 * Resolves an entire date range day-by-day using the central resolveHistoricalDay policy.
 */
export async function resolveHistoricalRange(
  startDateStr: string,
  endDateStr: string,
  options: ResolveDayOptions = {}
): Promise<{
  startDate: string;
  endDate: string;
  isFullyComplete: boolean;
  days: ResolvedDayResult[];
  fetchedDaysCount: number;
  cachedDaysCount: number;
}> {
  const start = startDateStr.slice(0, 10);
  const end = endDateStr.slice(0, 10);

  const dates: string[] = [];
  const curr = new Date(`${start}T00:00:00Z`);
  const stop = new Date(`${end}T00:00:00Z`);
  while (curr <= stop) {
    dates.push(curr.toISOString().slice(0, 10));
    curr.setUTCDate(curr.getUTCDate() + 1);
  }

  const results: ResolvedDayResult[] = [];
  let fetchedDaysCount = 0;
  let cachedDaysCount = 0;

  for (const d of dates) {
    const res = await resolveHistoricalDay(d, options);
    results.push(res);
    if (res.decision === 'FETCH_FROM_VENDOOR') {
      fetchedDaysCount++;
    } else {
      cachedDaysCount++;
    }
  }

  const isFullyComplete = results.every(
    r => r.completionStatus === 'COMPLETE' || r.completionStatus === 'EMPTY_VERIFIED'
  );

  return {
    startDate: start,
    endDate: end,
    isFullyComplete,
    days: results,
    fetchedDaysCount,
    cachedDaysCount,
  };
}
