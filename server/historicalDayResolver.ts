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
    // If local has 0 records, OR if Supabase is known/checked to have more records
    // -------------------------------------------------------------------------
    if (!forceRefetch && isSupabaseConfigured() && (!hasLocalData || cov?.completion_status === 'PARTIAL' || !cov)) {
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
      // If not yet verified on Supabase, trigger background sync
      if (isSupabaseConfigured() && cov?.remote_archive_status !== 'REMOTE_VERIFIED') {
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
    // -------------------------------------------------------------------------
    if (!forceRefetch && hasLocalData && cov?.completion_status === 'COMPLETE') {
      // Sync to Supabase in background if missing remote verification
      if (isSupabaseConfigured() && cov?.remote_archive_status !== 'REMOTE_VERIFIED') {
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
    // Case F: Partial data exists locally
    // Rule: Without explicit forceRefetch, use existing partial data; do NOT auto-pull.
    // -------------------------------------------------------------------------
    if (!forceRefetch && hasLocalData && (cov?.completion_status === 'PARTIAL' || !cov)) {
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
        messageAr: 'البيانات جزئية مسجلة محلياً — يمكن استخدام زر "استكمال اليوم من Vendoor" عند الحاجة',
      };
    }

    // -------------------------------------------------------------------------
    // Case E: Day is completely absent OR explicit forceRefetch was requested
    // Action: Auto-fetch from Vendoor, read all pages, save, sync to Supabase, verify.
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
      // 2. Fast-path: If day has multiple pages, attempt bulk Excel export to ingest full day in 1 call
      if (pagesDiscovered > 3) {
        try {
          options.onProgress?.('FETCHING_VENDOOR', `جاري محاولة التنزيل المباشر ليوم ${cleanDate}...`, 1, pagesDiscovered, recordsSavedThisPass);
          const excelBuf = await vendoorClient.exportSystemLogsExcel(cleanDate, cleanDate);
          if (excelBuf && excelBuf.length > 500) {
            const batchRes = await importBatchLogFiles([
              { fileName: `vendoor_logs_${cleanDate}.xlsx`, buffer: excelBuf }
            ]);
            if (batchRes && batchRes.discoveredDates.some(d => d.date === cleanDate && d.savedCount > 0)) {
              const totalRaw = (db.prepare(`
                SELECT COUNT(*) as c FROM raw_activity_events
                WHERE event_timestamp >= ? AND event_timestamp < ?
              `).get(interval.startCairo, interval.endCairo) as any)?.c || batchRes.totalSaved;
              const totalEvents = (db.prepare(`
                SELECT COUNT(*) as c FROM canonical_activity_events
                WHERE event_timestamp >= ? AND event_timestamp < ?
              `).get(interval.startCairo, interval.endCairo) as any)?.c || 0;
              return {
                date: cleanDate,
                decision: 'FETCH_FROM_VENDOOR',
                dataSource: 'VENDOOR_FETCH',
                completionStatus: 'COMPLETE',
                localStorageStatus: 'LOCAL_SAVED',
                remoteArchiveStatus: isSupabaseConfigured() ? 'REMOTE_SYNCED' : 'NONE',
                rawRecordsCount: totalRaw,
                canonicalEventsCount: totalEvents,
                loadedFromCache: false,
                messageAr: `تم جلب وتحديث اليوم بالكامل (${totalRaw} حركة مسجلة)`,
              };
            }
          }
        } catch (excelErr: any) {
          console.warn(`[HistoricalResolver] Bulk export skipped for ${cleanDate}, falling back to pagination:`, excelErr.message);
        }
      }

      // 3. Fetch remaining pages with retry and pacing
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
    } catch (err: any) {
      isPartial = true;
      fetchError = err.message;
    }

    // Determine final status
    const finalStatus: 'COMPLETE' | 'PARTIAL' | 'FAILED' = isPartial
      ? recordsSavedThisPass > 0 ? 'PARTIAL' : 'FAILED'
      : 'COMPLETE';

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

    // Sync to Supabase & verify
    let remoteStatus: 'REMOTE_VERIFIED' | 'REMOTE_SYNCED' | 'PENDING_REMOTE' | 'REMOTE_FAILED' | 'NONE' = 'NONE';
    if (isSupabaseConfigured() && finalStatus !== 'FAILED') {
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
