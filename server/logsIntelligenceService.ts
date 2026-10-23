import crypto from 'node:crypto';
import { db, getCairoDateInterval, getCairoDateString, isDateInHot } from './db.ts';
import { vendoorClient } from './vendoorClient.ts';
import { parseLogActionDetails } from './logDetailsParser.ts';
import { persistLogEntries, repairRawWithoutCanonical } from './historicalLogsService.ts';
import { importBatchLogFiles } from './batchLogsImporter.ts';
import { isSupabaseConfigured, fetchDayLogsFromSupabase, syncDayLogsToSupabase } from './supabaseClient.ts';
import { processAndDeduplicateTeamEvents } from './teamDeduplication.ts';

export type FetchStage =
  | 'IDLE'
  | 'CHECKING_STORAGE'
  | 'FETCHING_VENDOOR'
  | 'SAVING_RECORDS'
  | 'ANALYZING_ACTIONS'
  | 'COMPUTING_METRICS'
  | 'PREPARING_REPORT'
  | 'COMPLETE'
  | 'PARTIAL'
  | 'FAILED';

export interface RangeJobState {
  startDate: string;
  endDate: string;
  stage: FetchStage;
  stageLabelAr: string;
  pagesFetched: number;
  pagesTotal: number;
  eventsSaved: number;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  loadedFromCache: boolean;
}

const rangeJobs = new Map<string, RangeJobState>();

export function getRangeJobKey(start: string, end: string): string {
  return `${start.trim().slice(0, 10)}_${end.trim().slice(0, 10)}`;
}

export function getRangeJobStatus(start: string, end: string): RangeJobState | null {
  const key = getRangeJobKey(start, end);
  return rangeJobs.get(key) || null;
}

const ARABIC_DAYS: Record<number, string> = {
  0: 'الأحد',
  1: 'الاثنين',
  2: 'الثلاثاء',
  3: 'الأربعاء',
  4: 'الخميس',
  5: 'الجمعة',
  6: 'السبت',
};

/**
 * Ensures coverage for each date in [startDate, endDate].
 * If already COMPLETE in historical_coverage, skips fetch.
 * Otherwise fetches missing pages from Vendoor, saves raw and canonical logs,
 * updates coverage record, and advances the stage indicator.
 */
export async function ensureCoverageForRange(
  startDateStr: string,
  endDateStr: string,
  onProgress?: (state: RangeJobState) => void,
  forceRefetch: boolean = false
): Promise<RangeJobState> {
  const start = startDateStr.slice(0, 10);
  const end = endDateStr.slice(0, 10);
  const key = getRangeJobKey(start, end);

  // Check if an existing job is currently RUNNING to prevent concurrent overlapping executions
  const existingJob = rangeJobs.get(key);
  if (
    !forceRefetch &&
    existingJob &&
    (existingJob.stage === 'CHECKING_STORAGE' ||
      existingJob.stage === 'FETCHING_VENDOOR' ||
      existingJob.stage === 'SAVING_RECORDS' ||
      existingJob.stage === 'ANALYZING_ACTIONS' ||
      existingJob.stage === 'COMPUTING_METRICS' ||
      existingJob.stage === 'PREPARING_REPORT')
  ) {
    return existingJob;
  }

  const job: RangeJobState = {
    startDate: start,
    endDate: end,
    stage: 'CHECKING_STORAGE',
    stageLabelAr: 'جاري فحص اللوجز المخزنة',
    pagesFetched: 0,
    pagesTotal: 1,
    eventsSaved: 0,
    errorMessage: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    loadedFromCache: true,
  };
  rangeJobs.set(key, job);
  onProgress?.(job);

  // Generate list of dates in period
  const dates: string[] = [];
  const curr = new Date(`${start}T00:00:00Z`);
  const stop = new Date(`${end}T00:00:00Z`);
  while (curr <= stop) {
    dates.push(curr.toISOString().slice(0, 10));
    curr.setUTCDate(curr.getUTCDate() + 1);
  }

  // Step 1: Check coverage for all dates
  // Strict Policy: Existence of historical data in local storage (Excel/CSV import, Supabase archive,
  // or prior Vendoor fetch) strictly blocks automatic full Vendoor download.
  // Only completely unrecorded days trigger automatic Vendoor fetching.
  const missingDates: string[] = [];
  for (const date of dates) {
    if (forceRefetch) {
      missingDates.push(date);
      continue;
    }

    const interval = getCairoDateInterval(date);

    const cov: any = db.prepare(`
      SELECT completion_status, data_source, pages_read, pages_discovered FROM historical_coverage
      WHERE period_date = ? AND source_domain = 'logs'
    `).get(date);

    const hasLocalRaw = Boolean(
      (db.prepare(`
        SELECT 1 FROM raw_activity_events
        WHERE event_timestamp >= ? AND event_timestamp < ?
        LIMIT 1
      `).get(interval.startCairo, interval.endCairo) as any)
    );

    const hasLocalCanon = Boolean(
      (db.prepare(`
        SELECT 1 FROM canonical_activity_events
        WHERE event_timestamp >= ? AND event_timestamp < ?
        LIMIT 1
      `).get(interval.startCairo, interval.endCairo) as any)
    );

    const isDayVerifiedComplete = Boolean(
      cov && (
        (cov.completion_status === 'COMPLETE' && !(cov.pages_discovered > 1 && cov.pages_read < cov.pages_discovered)) ||
        cov.completion_status === 'EMPTY_VERIFIED' ||
        ((cov.data_source === 'EXCEL_IMPORT' || cov.data_source === 'CSV_IMPORT') && cov.completion_status === 'UNVERIFIED_SOURCE')
      )
    );

    // If day is missing entirely, has PARTIAL coverage, or has unverified raw records without completion:
    if (!isDayVerifiedComplete) {
      missingDates.push(date);
    }
  }

  let totalSaved = 0;

  // Step 1b: Check Supabase archive for any missing dates before attempting Vendoor fetch
  if (missingDates.length > 0 && isSupabaseConfigured()) {
    for (let i = missingDates.length - 1; i >= 0; i--) {
      const d = missingDates[i];
      if (d < '2026-10-23') continue; // Remote archive strictly begins from 2026-10-23

      job.stage = 'CHECKING_STORAGE';
      job.stageLabelAr = `جاري استرجاع اللوجز من Supabase (${d})`;
      onProgress?.(job);

      try {
        const restoreRes = await fetchDayLogsFromSupabase(d);
        if (restoreRes.success && (restoreRes.rawRestored > 0 || restoreRes.canonicalRestored > 0)) {
          totalSaved += restoreRes.rawRestored;
          job.eventsSaved = totalSaved;
          missingDates.splice(i, 1);
        }
      } catch (supaErr: any) {
        console.warn(`[ensureCoverageForRange] Supabase restore check skipped for ${d}:`, supaErr.message);
      }
    }
  }

  // Ensure any raw records without canonical records are converted
  try {
    repairRawWithoutCanonical();
  } catch {}

  // If all dates are complete or were restored from Supabase/cache, finish immediately
  if (missingDates.length === 0) {
    job.stage = 'COMPLETE';
    job.stageLabelAr = 'مكتمل باستخدام البيانات المخزنة والأرشيف';
    job.completedAt = new Date().toISOString();
    job.loadedFromCache = true;
    onProgress?.(job);
    return job;
  }

  job.loadedFromCache = false;

  // Step 2: Fetch any remaining missing dates from Vendoor
  let hasFailedPage = false;
  let totalPagesDiscovered = 0;
  let totalPagesRead = 0;
  let lastError: string | null = null;

  for (const date of missingDates) {
    const interval = getCairoDateInterval(date);

    job.stage = 'FETCHING_VENDOOR';
    job.stageLabelAr = `جاري جلب لوجز الفترة من Vendoor (${date})`;
    onProgress?.(job);

    let dayPagesTotal = 1;
    let dayPagesFetched = 0;
    let dayEventsSaved = 0;
    let dayStatus: 'COMPLETE' | 'PARTIAL' | 'FAILED' | 'EMPTY_VERIFIED' = 'COMPLETE';
    let dayError: string | null = null;

    try {
      if (!vendoorClient.isConfigured()) {
        throw new Error('بيانات دخول Vendoor غير مهيأة في بيئة التشغيل');
      }

      let bulkLoaded = false;

      // Smart resumption check for partial days with verified page tracking
      const existingCov: any = db.prepare(`
        SELECT completion_status, data_source, pages_read, pages_discovered
        FROM historical_coverage
        WHERE period_date = ? AND source_domain = 'logs'
      `).get(date);

      const hasLocalRaw = Boolean(
        (db.prepare(`
          SELECT 1 FROM raw_activity_events
          WHERE event_timestamp >= ? AND event_timestamp < ?
          LIMIT 1
        `).get(interval.startCairo, interval.endCairo) as any)
      );

      const canResume = Boolean(
        !forceRefetch &&
        hasLocalRaw &&
        existingCov &&
        existingCov.data_source === 'VENDOOR_FETCH' &&
        existingCov.pages_read > 0 &&
        existingCov.pages_discovered > existingCov.pages_read
      );

      if (canResume) {
        try {
          const fromPage = existingCov.pages_read + 1;
          let toPage = existingCov.pages_discovered;
          let allResumeSucceeded = true;

          for (let p = fromPage; p <= toPage; p++) {
            let pageFetched = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                if (attempt === 1) await new Promise(r => setTimeout(r, 50));
                job.stage = 'FETCHING_VENDOOR';
                job.stageLabelAr = `جاري استكمال صفحة ${p} من ${toPage} لليوم (${date})${attempt > 1 ? ` (محاولة ${attempt}/3)` : ''}`;
                onProgress?.(job);

                const nextP = await vendoorClient.fetchSystemLogs(p, date, date);
                if (nextP.totalPages > toPage) {
                  toPage = nextP.totalPages;
                }
                const nextRes = persistLogEntries(nextP.entries, interval);
                dayEventsSaved += nextRes.saved;
                totalSaved += nextRes.saved;
                job.eventsSaved = totalSaved;
                pageFetched = true;
                break;
              } catch {
                if (attempt < 3) await new Promise(r => setTimeout(r, 600 * attempt));
              }
            }
            if (!pageFetched) {
              allResumeSucceeded = false;
              break;
            }
          }

          if (allResumeSucceeded) {
            dayPagesTotal = toPage;
            dayPagesFetched = toPage;
            totalPagesDiscovered += (toPage - existingCov.pages_read);
            totalPagesRead += (toPage - existingCov.pages_read);
            job.pagesTotal = Math.max(job.pagesTotal, totalPagesDiscovered);
            job.pagesFetched = totalPagesRead;
            bulkLoaded = true;
            dayStatus = 'COMPLETE';
          }
        } catch {
          bulkLoaded = false;
        }
      }

      if (!bulkLoaded) {
        try {
          job.stage = 'FETCHING_VENDOOR';
          job.stageLabelAr = `جاري استخراج لوجز ${date} عبر تصدير Vendoor السريع`;
          onProgress?.(job);

          const excelBuf = await vendoorClient.exportSystemLogsExcel(date, date);
          if (excelBuf && excelBuf.length > 500) {
            const importRes = await importBatchLogFiles([
              { fileName: `vendoor_logs_${date}.xlsx`, buffer: excelBuf },
            ]);
            if (importRes.success && importRes.totalSaved >= 0) {
              dayEventsSaved = importRes.totalSaved;
              totalSaved += importRes.totalSaved;
              job.eventsSaved = totalSaved;
              dayPagesTotal = 1;
              dayPagesFetched = 1;
              totalPagesDiscovered += 1;
              totalPagesRead += 1;
              job.pagesTotal = Math.max(job.pagesTotal, totalPagesDiscovered);
              job.pagesFetched = totalPagesRead;
              bulkLoaded = true;
              dayStatus = 'COMPLETE';
            }
          }
        } catch {
          // Fall back gracefully to paginated fetch
          bulkLoaded = false;
        }
      }

      if (!bulkLoaded) {
        // Fetch page 1
        const p1 = await vendoorClient.fetchSystemLogs(1, date, date);
        dayPagesTotal = Math.max(1, p1.totalPages);
        dayPagesFetched = 1;
        totalPagesDiscovered += dayPagesTotal;
        totalPagesRead += 1;
        job.pagesTotal = Math.max(job.pagesTotal, totalPagesDiscovered);
        job.pagesFetched = totalPagesRead;

        job.stage = 'SAVING_RECORDS';
        job.stageLabelAr = `جاري حفظ السجلات (${dayPagesFetched}/${dayPagesTotal})`;
        onProgress?.(job);

        // Check for Case H: Empty Day Verified
        if (p1.entries.length === 0 && dayPagesTotal <= 1) {
          dayStatus = 'EMPTY_VERIFIED';
          db.prepare(`
            INSERT INTO historical_coverage (
              period_date, source_domain, storage_tier, pages_discovered, pages_read,
              records_saved, completion_status, last_attempted_at, completed_at, verified_at
            ) VALUES (?, 'logs', 'HOT', 1, 1, 0, 'EMPTY_VERIFIED', ?, ?, ?)
            ON CONFLICT(source_domain, period_date) DO UPDATE SET
              pages_discovered = 1,
              pages_read = 1,
              records_saved = 0,
              completion_status = 'EMPTY_VERIFIED',
              last_attempted_at = excluded.last_attempted_at,
              completed_at = excluded.completed_at,
              verified_at = excluded.verified_at
          `).run(date, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
          continue;
        }

        const p1Res = persistLogEntries(p1.entries, interval);
        dayEventsSaved += p1Res.saved;
        totalSaved += p1Res.saved;
        job.eventsSaved = totalSaved;

        // Fetch remaining pages with retry and pacing
        for (let p = 2; p <= dayPagesTotal; p++) {
          let pageFetched = false;
          let lastPageErr: any = null;

          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              if (p > 2 && attempt === 1) {
                await new Promise(r => setTimeout(r, 50));
              }

              job.stage = 'FETCHING_VENDOOR';
              job.stageLabelAr = `جاري جلب صفحة ${p} من ${dayPagesTotal} لليوم (${date})${attempt > 1 ? ` (محاولة ${attempt}/3)` : ''}`;
              onProgress?.(job);

              const nextP = await vendoorClient.fetchSystemLogs(p, date, date);
              dayPagesFetched = p;
              totalPagesRead += 1;
              job.pagesFetched = totalPagesRead;

              // Dynamic discovery: expand dayPagesTotal if Vendoor pagination reveals higher page numbers
              if (nextP.totalPages > dayPagesTotal) {
                const diff = nextP.totalPages - dayPagesTotal;
                dayPagesTotal = nextP.totalPages;
                totalPagesDiscovered += diff;
                job.pagesTotal = Math.max(job.pagesTotal, totalPagesDiscovered);
              }

              job.stage = 'SAVING_RECORDS';
              job.stageLabelAr = `جاري حفظ السجلات (صفحة ${p}/${dayPagesTotal})`;
              onProgress?.(job);

              const nextRes = persistLogEntries(nextP.entries, interval);
              dayEventsSaved += nextRes.saved;
              totalSaved += nextRes.saved;
              job.eventsSaved = totalSaved;

              pageFetched = true;
              break;
            } catch (pageErr: any) {
              lastPageErr = pageErr;
              if (attempt < 3) {
                console.warn(`[LogsIntelligence] Retrying page ${p} (${attempt}/3) for ${date}: ${pageErr.message}`);
                await new Promise(r => setTimeout(r, 600 * attempt));
              }
            }
          }

          if (!pageFetched) {
            console.warn(`[LogsIntelligence] Page ${p} failed for ${date}:`, lastPageErr?.message);
            hasFailedPage = true;
            dayStatus = 'PARTIAL';
            dayError = `فشل في الصفحة ${p}: ${lastPageErr?.message}`;
            break;
          }
        }
      }

      // Update coverage for this day
      db.prepare(`
        INSERT INTO historical_coverage (
          period_date, source_domain, storage_tier, pages_discovered, pages_read,
          records_saved, completion_status, last_attempted_at, completed_at, verified_at
        ) VALUES (?, 'logs', 'HOT', ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_domain, period_date) DO UPDATE SET
          pages_discovered = excluded.pages_discovered,
          pages_read = excluded.pages_read,
          records_saved = excluded.records_saved,
          completion_status = excluded.completion_status,
          last_attempted_at = excluded.last_attempted_at,
          completed_at = excluded.completed_at,
          verified_at = CASE WHEN excluded.completion_status = 'COMPLETE' THEN excluded.last_attempted_at ELSE historical_coverage.verified_at END
      `).run(
        date,
        dayPagesTotal,
        dayPagesFetched,
        dayEventsSaved,
        dayStatus,
        new Date().toISOString(),
        dayStatus === 'COMPLETE' ? new Date().toISOString() : null,
        dayStatus === 'COMPLETE' ? new Date().toISOString() : null
      );

      if (date >= '2026-10-23' && isSupabaseConfigured() && dayStatus === 'COMPLETE') {
        syncDayLogsToSupabase(date).catch(() => {});
      }
    } catch (dayErr: any) {
      console.error(`[LogsIntelligence] Error fetching date ${date}:`, dayErr.message);
      dayStatus = 'FAILED';
      dayError = dayErr.message;
      hasFailedPage = true;

      db.prepare(`
        INSERT INTO historical_coverage (
          period_date, source_domain, storage_tier, pages_discovered, pages_read,
          records_saved, completion_status, last_attempted_at, error_message
        ) VALUES (?, 'logs', 'HOT', ?, ?, ?, 'FAILED', ?, ?)
        ON CONFLICT(source_domain, period_date) DO UPDATE SET
          completion_status = 'FAILED',
          error_message = excluded.error_message,
          last_attempted_at = excluded.last_attempted_at
      `).run(date, dayPagesTotal, dayPagesFetched, dayEventsSaved, new Date().toISOString(), dayErr.message);
    }
  }

  // Step 3: Analysis & Metric Computation Stages
  job.stage = 'ANALYZING_ACTIONS';
  job.stageLabelAr = 'جاري تحليل الحركات';
  onProgress?.(job);

  job.stage = 'COMPUTING_METRICS';
  job.stageLabelAr = 'جاري حساب مؤشرات الموظفين والطلبات';
  onProgress?.(job);

  job.stage = 'PREPARING_REPORT';
  job.stageLabelAr = 'جاري تجهيز التقرير النهائي';
  onProgress?.(job);

  const verifiedCovCount = (db.prepare(`
    SELECT COUNT(*) as c FROM historical_coverage
    WHERE period_date >= ? AND period_date <= ? AND source_domain = 'logs'
      AND (completion_status = 'COMPLETE' OR completion_status = 'EMPTY_VERIFIED')
      AND NOT (pages_discovered > 1 AND pages_read < pages_discovered)
  `).get(start, end) as any)?.c || 0;

  const isAllStrictlyComplete = !hasFailedPage && verifiedCovCount === dates.length;
  const finalStatus: FetchStage = isAllStrictlyComplete
    ? 'COMPLETE'
    : (totalSaved > 0 || verifiedCovCount > 0)
    ? 'PARTIAL'
    : 'FAILED';

  job.stage = finalStatus;
  job.stageLabelAr =
    finalStatus === 'COMPLETE'
      ? 'مكتمل'
      : finalStatus === 'PARTIAL'
      ? 'جزئي بسبب نقص أو تعذر بعض الصفحات'
      : 'فشل في الجلب من المصدر';
  job.completedAt = new Date().toISOString();
  onProgress?.(job);

  return job;
}

export interface LogsIntelligenceReport {
  startDate: string;
  endDate: string;
  periodType: 'day' | 'week' | 'custom';
  periodLabel: string;
  cairoInterval: {
    startCairo: string;
    endExclusiveCairo: string;
  };
  status: 'COMPLETE' | 'PARTIAL' | 'FAILED' | 'FETCHING';
  loadedFromCache: boolean;
  lastVerifiedAt: string | null;
  coverage: {
    totalDays: number;
    completeDays: number;
    partialDays: number;
    failedDays: number;
    missingDays: number;
    pagesRead: number;
    recordsSaved: number;
    isFullyComplete: boolean;
    dataSource?: string;
    sourceSummary?: string;
  };
  metrics: {
    totalLogs: number;
    uniqueOrdersTouched: number;
    confirmedOrdersCount: number; // Unique Printed Orders
    printedEventsCount: number;   // Total Printed Events
    canceledOrdersCount: number;  // Strictly Unique Canceled Orders
    canceledEventsCount: number;  // Total Canceled Events
    cancelingOrdersCount: number; // Strictly Unique Canceling Orders
    cancelingEventsCount: number; // Total Canceling Events
    createdOrdersCount: number;   // Unique Created Orders
    createdEventsCount: number;   // Total Created Events
    extraPhonesAddedUniqueOrders: number;
    extraPhonesAddedEvents: number;
    extraPhonesReplacedCount: number;
    extraPhonesDeletedCount: number;
    statusChangeEventsCount: number;
    adminEditsCount: number;
    unresolvedCount: number;
  };
  days: Array<{
    date: string;
    dayNameAr: string;
    totalLogs: number;
    uniqueOrdersTouched: number;
    createdOrdersCount: number;
    createdEventsCount: number;
    confirmedOrdersCount: number;
    printedEventsCount: number;
    canceledOrdersCount: number;
    canceledEventsCount: number;
    cancelingOrdersCount: number;
    cancelingEventsCount: number;
    extraPhonesAddedCount: number;
    activeEmployeesCount: number;
    coverageStatus: string;
    dataSource?: string;
    localStorageStatus?: string;
    remoteArchiveStatus?: string;
  }>;
  employees: Array<{
    actor_name: string;
    is_system: number;
    actor_type: 'STAFF' | 'SYSTEM' | 'UNKNOWN';
    action_count: number;
    raw_events_count: number;
    duplicate_events_count: number;
    unique_orders: number;
    confirmed_orders_count: number;
    printed_events_count: number;
    canceled_orders_count: number;
    canceled_events_count: number;
    extra_phones_added_count: number;
    status_changes_count: number;
    actions_breakdown: Record<string, number>;
  }>;
  transitions: Array<{
    from_status: string;
    to_status: string;
    events_count: number;
    unique_orders: number;
  }>;
  administrativeEdits: Array<{
    action_type: string;
    action_label_ar: string;
    field_name: string;
    events_count: number;
    unique_orders: number;
  }>;
  unresolvedActions: Array<{
    id: number;
    order_code: string | null;
    actor_name: string;
    raw_action_text: string;
    event_timestamp: string;
    action_type: string;
  }>;
  recentEvents: Array<{
    id: number;
    order_code: string | null;
    actor_name: string;
    action_type: string;
    from_status: string | null;
    to_status: string | null;
    raw_action_text: string;
    event_timestamp: string;
    field_name: string | null;
    old_value: string | null;
    new_value: string | null;
    is_system_actor: number;
  }>;
}

/**
 * Pure calculation of Intelligence Report exclusively from canonical_activity_events and raw_activity_events
 */
export function generateLogsIntelligenceReport(startDateStr: string, endDateStr: string): LogsIntelligenceReport {
  const start = startDateStr.slice(0, 10);
  const end = endDateStr.slice(0, 10);

  const startInterval = getCairoDateInterval(start);
  const endInterval = getCairoDateInterval(end);
  const startTime = startInterval.startCairo;
  const endTime = endInterval.endCairo;

  const isSingleDay = start === end;
  const periodType: 'day' | 'week' | 'custom' = isSingleDay ? 'day' : 'week';
  const periodLabel = isSingleDay ? `يوم ${start}` : `الفترة من ${start} إلى ${end}`;

  // 1. Coverage Information
  const covRows: any[] = db.prepare(`
    SELECT period_date, completion_status, pages_read, pages_discovered, records_saved, verified_at, completed_at
    FROM historical_coverage
    WHERE period_date >= ? AND period_date <= ? AND source_domain = 'logs'
  `).all(start, end);

  const covMap = new Map<string, any>(covRows.map(r => [r.period_date, r]));

  // Generate list of days
  const dayDates: string[] = [];
  const curr = new Date(`${start}T00:00:00Z`);
  const stop = new Date(`${end}T00:00:00Z`);
  while (curr <= stop) {
    dayDates.push(curr.toISOString().slice(0, 10));
    curr.setUTCDate(curr.getUTCDate() + 1);
  }

  let completeDays = 0;
  let partialDays = 0;
  let failedDays = 0;
  let missingDays = 0;
  let pagesRead = 0;
  let recordsSaved = 0;
  let latestVerifiedAt: string | null = null;

  for (const d of dayDates) {
    const cov = covMap.get(d);
    if (!cov) {
      const dInterval = getCairoDateInterval(d);
      const hasEvents = Boolean(
        db.prepare(`
          SELECT 1 FROM canonical_activity_events
          WHERE event_timestamp >= ? AND event_timestamp < ?
          LIMIT 1
        `).get(dInterval.startCairo, dInterval.endCairo)
      );
      if (hasEvents) {
        partialDays++;
      } else {
        missingDays++;
      }
    } else {
      const isCompleteVerified =
        (cov.completion_status === 'COMPLETE' || cov.completion_status === 'EMPTY_VERIFIED') &&
        !(cov.pages_discovered > 1 && cov.pages_read < cov.pages_discovered);

      if (isCompleteVerified) {
        completeDays++;
      } else if (
        cov.completion_status === 'PARTIAL' ||
        cov.completion_status === 'UNVERIFIED_SOURCE' ||
        (cov.pages_discovered > 1 && cov.pages_read < cov.pages_discovered)
      ) {
        partialDays++;
      } else if (cov.completion_status === 'FAILED') {
        failedDays++;
      } else {
        missingDays++;
      }

      pagesRead += cov.pages_read || 0;
      recordsSaved += cov.records_saved || 0;
      if (cov.verified_at && (!latestVerifiedAt || cov.verified_at > latestVerifiedAt)) {
        latestVerifiedAt = cov.verified_at;
      }
    }
  }

  const isFullyComplete = dayDates.length > 0 && completeDays === dayDates.length;
  const coverageStatus: 'COMPLETE' | 'PARTIAL' | 'FAILED' = isFullyComplete
    ? 'COMPLETE'
    : (partialDays > 0 || completeDays > 0)
    ? 'PARTIAL'
    : 'FAILED';

  // 2. Base Counts from canonical_activity_events using permanent order identity
  const orderIdentitySql = `COALESCE(
    CASE WHEN c.order_id IS NOT NULL THEN 'ORD_ID_' || c.order_id END,
    CASE WHEN r.vendoor_order_id IS NOT NULL AND r.vendoor_order_id > 0 THEN 'VEND_ID_' || r.vendoor_order_id END,
    CASE WHEN c.order_code IS NOT NULL AND TRIM(c.order_code) != '' THEN 'CODE_' || LOWER(TRIM(c.order_code)) END
  )`;

  const orderHasIdentitySql = `((c.order_code IS NOT NULL AND TRIM(c.order_code) != '') OR c.order_id IS NOT NULL OR (r.vendoor_order_id IS NOT NULL AND r.vendoor_order_id > 0))`;

  const totalLogs = (db.prepare(`
    SELECT COUNT(*) as c FROM canonical_activity_events
    WHERE event_timestamp >= ? AND event_timestamp < ?
  `).get(startTime, endTime) as any)?.c || 0;

  const uniqueOrdersTouched = (db.prepare(`
    SELECT COUNT(DISTINCT ${orderIdentitySql}) as c
    FROM canonical_activity_events c
    LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
    WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
      AND ${orderHasIdentitySql}
  `).get(startTime, endTime) as any)?.c || 0;

  // Confirmed Orders (Rule: Printed = Confirmation)
  const confirmedData: any = db.prepare(`
    SELECT 
      COUNT(DISTINCT ${orderIdentitySql}) as unique_orders,
      COUNT(*) as events_count
    FROM canonical_activity_events c
    LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
    WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
      AND ${orderHasIdentitySql}
      AND c.to_status = 'Printed'
  `).get(startTime, endTime);

  const confirmedOrdersCount = confirmedData?.unique_orders || 0;
  const printedEventsCount = confirmedData?.events_count || 0;

  // Canceled Orders (Strictly Canceled - separated from Canceling)
  const canceledData: any = db.prepare(`
    SELECT 
      COUNT(DISTINCT ${orderIdentitySql}) as unique_orders,
      COUNT(*) as events_count
    FROM canonical_activity_events c
    LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
    WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
      AND ${orderHasIdentitySql}
      AND c.to_status = 'Canceled'
  `).get(startTime, endTime);

  const canceledOrdersCount = canceledData?.unique_orders || 0;
  const canceledEventsCount = canceledData?.events_count || 0;

  // Canceling Orders (Strictly Canceling - separated from Canceled)
  const cancelingData: any = db.prepare(`
    SELECT 
      COUNT(DISTINCT ${orderIdentitySql}) as unique_orders,
      COUNT(*) as events_count
    FROM canonical_activity_events c
    LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
    WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
      AND ${orderHasIdentitySql}
      AND c.to_status = 'Canceling'
  `).get(startTime, endTime);

  const cancelingOrdersCount = cancelingData?.unique_orders || 0;
  const cancelingEventsCount = cancelingData?.events_count || 0;

  // Created Orders
  const createdData: any = db.prepare(`
    SELECT 
      COUNT(DISTINCT ${orderIdentitySql}) as unique_orders,
      COUNT(*) as events_count
    FROM canonical_activity_events c
    LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
    WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
      AND ${orderHasIdentitySql}
      AND c.action_type = 'order_created'
  `).get(startTime, endTime);

  const createdOrdersCount = createdData?.unique_orders || 0;
  const createdEventsCount = createdData?.events_count || 0;

  // Extra Phone Numbers Analysis
  const extraPhonesAddedData: any = db.prepare(`
    SELECT 
      COUNT(DISTINCT ${orderIdentitySql}) as unique_orders,
      COUNT(*) as events_count
    FROM canonical_activity_events c
    LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
    WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
      AND ${orderHasIdentitySql}
      AND (
        c.action_type = 'extra_phone_added'
        OR c.details_json LIKE '%"extraPhoneOperation":"ADDITION"%'
        OR (
          c.field_name = 'الهاتف الإضافي' 
          AND (c.old_value IS NULL OR TRIM(REPLACE(REPLACE(c.old_value, '''', ''), '"', '')) = '')
          AND (c.new_value IS NOT NULL AND TRIM(REPLACE(REPLACE(c.new_value, '''', ''), '"', '')) != '')
        )
      )
  `).get(startTime, endTime);

  const extraPhonesAddedUniqueOrders = extraPhonesAddedData?.unique_orders || 0;
  const extraPhonesAddedEvents = extraPhonesAddedData?.events_count || 0;

  const extraPhonesReplacedCount = (db.prepare(`
    SELECT COUNT(*) as c FROM canonical_activity_events
    WHERE event_timestamp >= ? AND event_timestamp < ?
      AND (
        details_json LIKE '%"extraPhoneOperation":"REPLACEMENT"%'
        OR (
          field_name = 'الهاتف الإضافي'
          AND TRIM(REPLACE(REPLACE(COALESCE(old_value, ''), '''', ''), '"', '')) != ''
          AND TRIM(REPLACE(REPLACE(COALESCE(new_value, ''), '''', ''), '"', '')) != ''
          AND old_value != new_value
        )
      )
  `).get(startTime, endTime) as any)?.c || 0;

  const extraPhonesDeletedCount = (db.prepare(`
    SELECT COUNT(*) as c FROM canonical_activity_events
    WHERE event_timestamp >= ? AND event_timestamp < ?
      AND (
        details_json LIKE '%"extraPhoneOperation":"DELETION"%'
        OR (
          field_name = 'الهاتف الإضافي'
          AND TRIM(REPLACE(REPLACE(COALESCE(old_value, ''), '''', ''), '"', '')) != ''
          AND (new_value IS NULL OR TRIM(REPLACE(REPLACE(new_value, '''', ''), '"', '')) = '')
        )
      )
  `).get(startTime, endTime) as any)?.c || 0;

  // Status changes count
  const statusChangeEventsCount = (db.prepare(`
    SELECT COUNT(*) as c FROM canonical_activity_events
    WHERE event_timestamp >= ? AND event_timestamp < ?
      AND action_type = 'status_change'
  `).get(startTime, endTime) as any)?.c || 0;

  // Admin edits count
  const adminEditsCount = (db.prepare(`
    SELECT COUNT(*) as c FROM canonical_activity_events
    WHERE event_timestamp >= ? AND event_timestamp < ?
      AND is_administrative = 1
  `).get(startTime, endTime) as any)?.c || 0;

  // Unresolved count
  const unresolvedCount = (db.prepare(`
    SELECT COUNT(*) as c FROM canonical_activity_events
    WHERE event_timestamp >= ? AND event_timestamp < ?
      AND (order_match_status = 'UNRESOLVED' OR action_type = 'other')
  `).get(startTime, endTime) as any)?.c || 0;

  // 3. Day-by-Day Breakdown (for Weekly and custom range views)
  const daysBreakdown: LogsIntelligenceReport['days'] = [];
  for (const d of dayDates) {
    const dayInterval = getCairoDateInterval(d);
    const dayDateObj = new Date(`${d}T12:00:00Z`);
    const dayNameAr = ARABIC_DAYS[dayDateObj.getDay()] || d;

    const dTotalLogs = (db.prepare(`
      SELECT COUNT(*) as c FROM canonical_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ?
    `).get(dayInterval.startCairo, dayInterval.endCairo) as any)?.c || 0;

    const dUniqueOrders = (db.prepare(`
      SELECT COUNT(DISTINCT ${orderIdentitySql}) as c
      FROM canonical_activity_events c
      LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
      WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
        AND (c.order_code IS NOT NULL AND TRIM(c.order_code) != '' OR c.order_id IS NOT NULL)
    `).get(dayInterval.startCairo, dayInterval.endCairo) as any)?.c || 0;

    const dCreatedData: any = db.prepare(`
      SELECT 
        COUNT(DISTINCT ${orderIdentitySql}) as unique_orders,
        COUNT(*) as events_count
      FROM canonical_activity_events c
      LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
      WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
        AND (c.order_code IS NOT NULL AND TRIM(c.order_code) != '' OR c.order_id IS NOT NULL)
        AND c.action_type = 'order_created'
    `).get(dayInterval.startCairo, dayInterval.endCairo);

    const dConfirmedData: any = db.prepare(`
      SELECT 
        COUNT(DISTINCT ${orderIdentitySql}) as unique_orders,
        COUNT(*) as events_count
      FROM canonical_activity_events c
      LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
      WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
        AND (c.order_code IS NOT NULL AND TRIM(c.order_code) != '' OR c.order_id IS NOT NULL)
        AND c.to_status = 'Printed'
    `).get(dayInterval.startCairo, dayInterval.endCairo);

    const dCanceledData: any = db.prepare(`
      SELECT 
        COUNT(DISTINCT ${orderIdentitySql}) as unique_orders,
        COUNT(*) as events_count
      FROM canonical_activity_events c
      LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
      WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
        AND (c.order_code IS NOT NULL AND TRIM(c.order_code) != '' OR c.order_id IS NOT NULL)
        AND c.to_status = 'Canceled'
    `).get(dayInterval.startCairo, dayInterval.endCairo);

    const dCancelingData: any = db.prepare(`
      SELECT 
        COUNT(DISTINCT ${orderIdentitySql}) as unique_orders,
        COUNT(*) as events_count
      FROM canonical_activity_events c
      LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
      WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
        AND (c.order_code IS NOT NULL AND TRIM(c.order_code) != '' OR c.order_id IS NOT NULL)
        AND c.to_status = 'Canceling'
    `).get(dayInterval.startCairo, dayInterval.endCairo);

    const dExtraPhones = (db.prepare(`
      SELECT COUNT(DISTINCT ${orderIdentitySql}) as c
      FROM canonical_activity_events c
      LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
      WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
        AND (c.order_code IS NOT NULL AND TRIM(c.order_code) != '' OR c.order_id IS NOT NULL)
        AND (
          c.action_type = 'extra_phone_added'
          OR c.details_json LIKE '%"extraPhoneOperation":"ADDITION"%'
          OR (
            c.field_name = 'الهاتف الإضافي' 
            AND (c.old_value IS NULL OR TRIM(REPLACE(REPLACE(c.old_value, '''', ''), '"', '')) = '')
            AND (c.new_value IS NOT NULL AND TRIM(REPLACE(REPLACE(c.new_value, '''', ''), '"', '')) != '')
          )
        )
    `).get(dayInterval.startCairo, dayInterval.endCairo) as any)?.c || 0;

    const dActiveEmployees = (db.prepare(`
      SELECT COUNT(DISTINCT actor_name) as c FROM canonical_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ?
        AND is_system_actor = 0
    `).get(dayInterval.startCairo, dayInterval.endCairo) as any)?.c || 0;

    const cov = covMap.get(d);
    const dayCovStatus = cov?.completion_status || (dTotalLogs > 0 ? 'COMPLETE' : 'NOT_SYNCED');
    const dayDataSource = cov?.data_source || (dTotalLogs > 0 ? 'LOCAL_STORAGE' : 'NONE');

    daysBreakdown.push({
      date: d,
      dayNameAr,
      totalLogs: dTotalLogs,
      uniqueOrdersTouched: dUniqueOrders,
      createdOrdersCount: dCreatedData?.unique_orders || 0,
      createdEventsCount: dCreatedData?.events_count || 0,
      confirmedOrdersCount: dConfirmedData?.unique_orders || 0,
      printedEventsCount: dConfirmedData?.events_count || 0,
      canceledOrdersCount: dCanceledData?.unique_orders || 0,
      canceledEventsCount: dCanceledData?.events_count || 0,
      cancelingOrdersCount: dCancelingData?.unique_orders || 0,
      cancelingEventsCount: dCancelingData?.events_count || 0,
      extraPhonesAddedCount: dExtraPhones,
      activeEmployeesCount: dActiveEmployees,
      coverageStatus: dayCovStatus,
      dataSource: dayDataSource,
      localStorageStatus: cov?.local_storage_status || (dTotalLogs > 0 ? 'LOCAL_SAVED' : 'NONE'),
      remoteArchiveStatus: cov?.remote_archive_status || 'NONE',
    });
  }

  // 4. Employee Activity Table with conservative deduplication
  const employeeEvents: any[] = db.prepare(`
    SELECT
      c.id,
      c.actor_name,
      c.action_type,
      c.from_status,
      c.to_status,
      c.order_code,
      c.event_timestamp,
      c.is_system_actor,
      c.raw_event_id,
      COALESCE(r.source_hash, '') as source_hash,
      COALESCE(r.raw_action_text, '') as raw_action_text,
      c.order_id,
      r.vendoor_order_id,
      c.field_name,
      c.old_value,
      c.new_value,
      c.details_json
    FROM canonical_activity_events c
    LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
    WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
    ORDER BY c.event_timestamp ASC, c.id ASC
  `).all(startTime, endTime);

  const deduplicatedEvents = processAndDeduplicateTeamEvents(employeeEvents);

  const empStatsMap = new Map<string, {
    actor_name: string;
    is_system: number;
    action_count: number;
    raw_events_count: number;
    duplicate_events_count: number;
    unique_orders_set: Set<string>;
    confirmed_orders_set: Set<string>;
    printed_events_count: number;
    canceled_orders_set: Set<string>;
    canceled_events_count: number;
    extra_phones_added_set: Set<string>;
    status_changes_count: number;
    actions_breakdown: Record<string, number>;
  }>();

  for (const ev of deduplicatedEvents) {
    const actor = ev.actor_name || 'غير محدد';
    let stat = empStatsMap.get(actor);
    if (!stat) {
      stat = {
        actor_name: actor,
        is_system: ev.is_system_actor === 1 || ev.is_system_actor === true ? 1 : 0,
        action_count: 0,
        raw_events_count: 0,
        duplicate_events_count: 0,
        unique_orders_set: new Set<string>(),
        confirmed_orders_set: new Set<string>(),
        printed_events_count: 0,
        canceled_orders_set: new Set<string>(),
        canceled_events_count: 0,
        extra_phones_added_set: new Set<string>(),
        status_changes_count: 0,
        actions_breakdown: {},
      };
      empStatsMap.set(actor, stat);
    }

    stat.raw_events_count++;
    const orderKey = ev.order_id
      ? `ORD_ID_${ev.order_id}`
      : ev.vendoor_order_id
      ? `VEND_ID_${ev.vendoor_order_id}`
      : ev.order_code && ev.order_code.trim()
      ? `CODE_${ev.order_code.trim().toLowerCase()}`
      : null;

    if (orderKey) {
      stat.unique_orders_set.add(orderKey);
    }

    if (!ev.is_counted) {
      stat.duplicate_events_count++;
      continue;
    }

    // Real, counted operational action
    stat.action_count++;
    stat.actions_breakdown[ev.action_type] = (stat.actions_breakdown[ev.action_type] || 0) + 1;

    if (ev.to_status === 'Printed') {
      stat.printed_events_count++;
      if (orderKey) stat.confirmed_orders_set.add(orderKey);
    } else if (ev.to_status === 'Canceled') {
      stat.canceled_events_count++;
      if (orderKey) stat.canceled_orders_set.add(orderKey);
    }

    if (ev.action_type === 'status_change') {
      stat.status_changes_count++;
    }

    const isExtraPhoneAdd = Boolean(
      ev.action_type === 'extra_phone_added' ||
      (ev.details_json && ev.details_json.includes('"extraPhoneOperation":"ADDITION"')) ||
      (ev.field_name === 'الهاتف الإضافي' && (!ev.old_value || !ev.old_value.trim()) && ev.new_value && ev.new_value.trim())
    );
    if (isExtraPhoneAdd && orderKey) {
      stat.extra_phones_added_set.add(orderKey);
    }
  }

  const employees: LogsIntelligenceReport['employees'] = Array.from(empStatsMap.values())
    .map(st => {
      const isSys = st.is_system === 1;
      let actorType: 'STAFF' | 'SYSTEM' | 'UNKNOWN' = isSys ? 'SYSTEM' : 'STAFF';
      if (!st.actor_name || st.actor_name === 'غير محدد' || st.actor_name === 'Unknown') {
        actorType = 'UNKNOWN';
      }
      return {
        actor_name: st.actor_name,
        is_system: st.is_system,
        actor_type: actorType,
        action_count: st.action_count,
        raw_events_count: st.raw_events_count,
        duplicate_events_count: st.duplicate_events_count,
        unique_orders: st.unique_orders_set.size,
        confirmed_orders_count: st.confirmed_orders_set.size,
        printed_events_count: st.printed_events_count,
        canceled_orders_count: st.canceled_orders_set.size,
        canceled_events_count: st.canceled_events_count,
        extra_phones_added_count: st.extra_phones_added_set.size,
        status_changes_count: st.status_changes_count,
        actions_breakdown: st.actions_breakdown,
      };
    })
    .sort((a, b) => b.action_count - a.action_count);

  // 5. Status Transitions Matrix
  const transitions: any[] = db.prepare(`
    SELECT 
      COALESCE(from_status, 'غير محدد') as from_status, 
      to_status, 
      COUNT(*) as events_count,
      COUNT(DISTINCT order_code) as unique_orders
    FROM canonical_activity_events
    WHERE event_timestamp >= ? AND event_timestamp < ?
      AND action_type = 'status_change'
      AND to_status IS NOT NULL
    GROUP BY from_status, to_status
    ORDER BY events_count DESC
  `).all(startTime, endTime);

  // 6. Administrative Edits Breakdown
  const administrativeEdits: any[] = db.prepare(`
    SELECT 
      action_type,
      COALESCE(field_name, action_type) as field_name,
      COUNT(*) as events_count,
      COUNT(DISTINCT order_code) as unique_orders
    FROM canonical_activity_events
    WHERE event_timestamp >= ? AND event_timestamp < ?
      AND (is_administrative = 1 OR action_type IN ('address_edit', 'phone_edit', 'extra_phone_edit', 'extra_phone_added', 'customer_edit', 'note_added', 'financial_edit', 'assign_staff'))
    GROUP BY action_type, field_name
    ORDER BY events_count DESC
  `).all(startTime, endTime).map((row: any) => {
    let label = 'تعديل إداري';
    if (row.action_type === 'address_edit') label = 'تعديل العنوان';
    else if (row.action_type === 'phone_edit') label = 'تعديل رقم الهاتف';
    else if (row.action_type === 'extra_phone_edit' || row.action_type === 'extra_phone_added') label = 'إضافة/تعديل هاتف إضافي';
    else if (row.action_type === 'customer_edit') label = 'تعديل اسم العميل';
    else if (row.action_type === 'note_added') label = 'إضافة ملاحظة';
    else if (row.action_type === 'financial_edit') label = 'تعديل مالي / شحن';
    else if (row.action_type === 'assign_staff') label = 'تعيين موظف مسؤول';
    return {
      action_type: row.action_type,
      action_label_ar: label,
      field_name: row.field_name,
      events_count: row.events_count,
      unique_orders: row.unique_orders,
    };
  });

  // 7. Unresolved / Needs Review Actions
  const unresolvedActions: any[] = db.prepare(`
    SELECT 
      c.id, c.order_code, c.actor_name, c.action_type, c.event_timestamp,
      COALESCE(r.raw_action_text, '') as raw_action_text
    FROM canonical_activity_events c
    LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
    WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
      AND (c.order_match_status = 'UNRESOLVED' OR c.action_type = 'other')
    ORDER BY c.event_timestamp DESC
    LIMIT 50
  `).all(startTime, endTime);

  // 8. Recent Events Preview (up to 50)
  const recentEvents: any[] = db.prepare(`
    SELECT 
      c.id, c.order_code, c.actor_name, c.action_type, c.from_status, c.to_status,
      COALESCE(r.raw_action_text, '') as raw_action_text,
      c.event_timestamp, c.field_name, c.old_value, c.new_value, c.is_system_actor
    FROM canonical_activity_events c
    LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
    WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
    ORDER BY c.event_timestamp DESC, c.id DESC
    LIMIT 50
  `).all(startTime, endTime);

  return {
    startDate: start,
    endDate: end,
    periodType,
    periodLabel,
    cairoInterval: {
      startCairo: startTime,
      endExclusiveCairo: endTime,
    },
    status: coverageStatus,
    loadedFromCache: false,
    lastVerifiedAt: latestVerifiedAt,
    coverage: {
      totalDays: dayDates.length,
      completeDays,
      partialDays,
      failedDays,
      missingDays,
      pagesRead,
      recordsSaved,
      isFullyComplete,
      dataSource: dayDates.length === 1 && covMap.get(dayDates[0])?.data_source ? covMap.get(dayDates[0])?.data_source : undefined,
    },
    metrics: {
      totalLogs,
      uniqueOrdersTouched,
      confirmedOrdersCount,
      printedEventsCount,
      canceledOrdersCount,
      canceledEventsCount,
      cancelingOrdersCount,
      cancelingEventsCount,
      createdOrdersCount,
      createdEventsCount,
      extraPhonesAddedUniqueOrders,
      extraPhonesAddedEvents,
      extraPhonesReplacedCount,
      extraPhonesDeletedCount,
      statusChangeEventsCount,
      adminEditsCount,
      unresolvedCount,
    },
    days: daysBreakdown,
    employees,
    transitions,
    administrativeEdits,
    unresolvedActions,
    recentEvents,
  };
}

/**
 * Filtered Drilldown for individual KPI cards and employees
 */
export function getDrilldownLogs(params: {
  pillar: string;
  startDate: string;
  endDate: string;
  actor?: string;
  search?: string;
  page?: number;
  limit?: number;
  viewType?: 'orders' | 'events';
}) {
  const {
    pillar,
    startDate,
    endDate,
    actor,
    search,
    page = 1,
    limit = 25,
    viewType,
  } = params;

  const isOrderPillar = ['confirmed', 'printed', 'canceled', 'canceling', 'created'].includes(pillar);
  const effectiveViewType: 'orders' | 'events' = viewType || (isOrderPillar ? 'orders' : 'events');

  const startInterval = getCairoDateInterval(startDate.slice(0, 10));
  const endInterval = getCairoDateInterval(endDate.slice(0, 10));
  const startTime = startInterval.startCairo;
  const endTime = endInterval.endCairo;

  const conditions = ['c.event_timestamp >= ? AND c.event_timestamp < ?'];
  const sqlParams: any[] = [startTime, endTime];

  if (actor && actor !== 'all') {
    conditions.push('c.actor_name = ?');
    sqlParams.push(actor);
  }

  // Pillar filtering
  if (pillar === 'confirmed' || pillar === 'printed') {
    conditions.push("c.to_status = 'Printed'");
  } else if (pillar === 'canceled') {
    conditions.push("c.to_status = 'Canceled'");
  } else if (pillar === 'canceling') {
    conditions.push("c.to_status = 'Canceling'");
  } else if (pillar === 'created') {
    conditions.push("c.action_type = 'order_created'");
  } else if (pillar === 'extra_phone') {
    conditions.push(`(
      c.action_type = 'extra_phone_added'
      OR c.details_json LIKE '%"extraPhoneOperation":"ADDITION"%'
      OR (
        c.field_name = 'الهاتف الإضافي' 
        AND (c.old_value IS NULL OR TRIM(REPLACE(REPLACE(c.old_value, '''', ''), '"', '')) = '')
        AND (c.new_value IS NOT NULL AND TRIM(REPLACE(REPLACE(c.new_value, '''', ''), '"', '')) != '')
      )
    )`);
  } else if (pillar === 'transitions') {
    conditions.push("c.action_type = 'status_change'");
  } else if (pillar === 'admin_edits') {
    conditions.push("(c.is_administrative = 1 OR c.action_type IN ('address_edit', 'phone_edit', 'extra_phone_edit', 'extra_phone_added', 'customer_edit', 'note_added', 'financial_edit', 'assign_staff'))");
  } else if (pillar === 'unresolved') {
    conditions.push("(c.order_match_status = 'UNRESOLVED' OR c.action_type = 'other')");
  }

  if (effectiveViewType === 'orders') {
    conditions.push("((c.order_code IS NOT NULL AND TRIM(c.order_code) != '') OR c.order_id IS NOT NULL OR (r.vendoor_order_id IS NOT NULL AND r.vendoor_order_id > 0))");
  }

  if (search && search.trim()) {
    const s = `%${search.trim()}%`;
    conditions.push('(c.order_code LIKE ? OR r.raw_action_text LIKE ? OR c.actor_name LIKE ? OR c.field_name LIKE ? OR c.new_value LIKE ?)');
    sqlParams.push(s, s, s, s, s);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const orderIdentitySql = `COALESCE(
    CASE WHEN c.order_id IS NOT NULL THEN 'ORD_ID_' || c.order_id END,
    CASE WHEN r.vendoor_order_id IS NOT NULL AND r.vendoor_order_id > 0 THEN 'VEND_ID_' || r.vendoor_order_id END,
    CASE WHEN c.order_code IS NOT NULL AND TRIM(c.order_code) != '' THEN 'CODE_' || LOWER(TRIM(c.order_code)) END
  )`;

  let total = 0;
  let events: any[] = [];
  const offset = (page - 1) * limit;

  if (effectiveViewType === 'orders') {
    total = (db.prepare(`
      SELECT COUNT(DISTINCT ${orderIdentitySql}) as c
      FROM canonical_activity_events c
      LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
      ${whereClause}
        AND ${orderIdentitySql} IS NOT NULL
    `).get(...sqlParams) as any)?.c || 0;

    events = db.prepare(`
      SELECT 
        MAX(c.id) as id,
        COALESCE(MAX(c.order_code), MAX(r.order_code), '') as order_code,
        MAX(c.actor_name) as actor_name,
        MAX(c.action_type) as action_type,
        MAX(c.from_status) as from_status,
        MAX(c.to_status) as to_status,
        MAX(c.field_name) as field_name,
        MAX(c.old_value) as old_value,
        MAX(c.new_value) as new_value,
        MAX(c.event_timestamp) as event_timestamp,
        MAX(c.is_system_actor) as is_system_actor,
        COALESCE(MAX(r.raw_action_text), '') as raw_action_text,
        MAX(c.details_json) as details_json,
        COUNT(*) as events_count_for_order
      FROM canonical_activity_events c
      LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
      ${whereClause}
        AND ${orderIdentitySql} IS NOT NULL
      GROUP BY ${orderIdentitySql}
      ORDER BY MAX(c.event_timestamp) DESC
      LIMIT ? OFFSET ?
    `).all(...sqlParams, limit, offset);
  } else {
    total = (db.prepare(`
      SELECT COUNT(*) as c
      FROM canonical_activity_events c
      LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
      ${whereClause}
    `).get(...sqlParams) as any)?.c || 0;

    events = db.prepare(`
      SELECT 
        c.id, c.order_code, c.actor_name, c.action_type, c.from_status, c.to_status,
        c.field_name, c.old_value, c.new_value, c.event_timestamp, c.is_system_actor,
        COALESCE(r.raw_action_text, '') as raw_action_text,
        c.details_json,
        1 as events_count_for_order
      FROM canonical_activity_events c
      LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
      ${whereClause}
      ORDER BY c.event_timestamp DESC, c.id DESC
      LIMIT ? OFFSET ?
    `).all(...sqlParams, limit, offset);
  }

  return {
    events,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
    viewType: effectiveViewType,
  };
}
