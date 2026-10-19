import crypto from 'node:crypto';
import { db, getCairoDateInterval, getCairoDateString, isDateInHot } from './db.ts';
import { vendoorClient } from './vendoorClient.ts';
import { parseLogActionDetails } from './logDetailsParser.ts';
import { persistLogEntries } from './historicalLogsService.ts';

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
  const missingDates: string[] = [];
  for (const date of dates) {
    if (forceRefetch) {
      missingDates.push(date);
      continue;
    }

    const cov: any = db.prepare(`
      SELECT completion_status FROM historical_coverage
      WHERE period_date = ? AND source_domain = 'logs'
    `).get(date);

    if (cov?.completion_status !== 'COMPLETE') {
      missingDates.push(date);
    }
  }

  // If all dates are complete, finish immediately with cache indication
  if (missingDates.length === 0) {
    job.stage = 'COMPLETE';
    job.stageLabelAr = 'مكتمل باستخدام البيانات المخزنة';
    job.completedAt = new Date().toISOString();
    job.loadedFromCache = true;
    onProgress?.(job);
    return job;
  }

  job.loadedFromCache = false;

  // Step 2: Fetch missing dates from Vendoor
  let hasFailedPage = false;
  let totalSaved = 0;
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
    let dayStatus: 'COMPLETE' | 'PARTIAL' | 'FAILED' = 'COMPLETE';
    let dayError: string | null = null;

    try {
      if (!vendoorClient.isConfigured()) {
        throw new Error('بيانات دخول Vendoor غير مهيأة في بيئة التشغيل');
      }

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

      const p1Res = persistLogEntries(p1.entries, interval);
      dayEventsSaved += p1Res.saved;
      totalSaved += p1Res.saved;
      job.eventsSaved = totalSaved;

      // Fetch remaining pages
      for (let p = 2; p <= dayPagesTotal; p++) {
        try {
          job.stage = 'FETCHING_VENDOOR';
          job.stageLabelAr = `جاري جلب صفحة ${p} من ${dayPagesTotal} لليوم (${date})`;
          onProgress?.(job);

          const nextP = await vendoorClient.fetchSystemLogs(p, date, date);
          dayPagesFetched = p;
          totalPagesRead += 1;
          job.pagesFetched = totalPagesRead;

          job.stage = 'SAVING_RECORDS';
          job.stageLabelAr = `جاري حفظ السجلات (صفحة ${p}/${dayPagesTotal})`;
          onProgress?.(job);

          const nextRes = persistLogEntries(nextP.entries, interval);
          dayEventsSaved += nextRes.saved;
          totalSaved += nextRes.saved;
          job.eventsSaved = totalSaved;
        } catch (pageErr: any) {
          console.warn(`[LogsIntelligence] Page ${p} failed for ${date}:`, pageErr.message);
          hasFailedPage = true;
          dayStatus = 'PARTIAL';
          dayError = `فشل في الصفحة ${p}: ${pageErr.message}`;
          break;
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

  const finalStatus: FetchStage = hasFailedPage ? (totalSaved > 0 ? 'PARTIAL' : 'FAILED') : 'COMPLETE';
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
  };
  metrics: {
    totalLogs: number;
    uniqueOrdersTouched: number;
    confirmedOrdersCount: number; // Rule: Printed = Confirmed
    printedEventsCount: number;
    canceledOrdersCount: number;  // Strictly Canceled
    canceledEventsCount: number;
    cancelingEventsCount: number; // Strictly Canceling
    createdOrdersCount: number;
    createdEventsCount: number;
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
    confirmedOrdersCount: number;
    canceledOrdersCount: number;
    extraPhonesAddedCount: number;
    activeEmployeesCount: number;
    coverageStatus: string;
  }>;
  employees: Array<{
    actor_name: string;
    is_system: number;
    actor_type: 'STAFF' | 'SYSTEM' | 'UNKNOWN';
    action_count: number;
    unique_orders: number;
    confirmed_orders_count: number;
    canceled_orders_count: number;
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
    SELECT period_date, completion_status, pages_read, records_saved, verified_at, completed_at
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
      missingDays++;
    } else {
      if (cov.completion_status === 'COMPLETE') completeDays++;
      else if (cov.completion_status === 'PARTIAL') partialDays++;
      else if (cov.completion_status === 'FAILED') failedDays++;
      else missingDays++;

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

  // 2. Base Counts from canonical_activity_events
  const totalLogs = (db.prepare(`
    SELECT COUNT(*) as c FROM canonical_activity_events
    WHERE event_timestamp >= ? AND event_timestamp < ?
  `).get(startTime, endTime) as any)?.c || 0;

  const uniqueOrdersTouched = (db.prepare(`
    SELECT COUNT(DISTINCT order_code) as c FROM canonical_activity_events
    WHERE event_timestamp >= ? AND event_timestamp < ?
      AND order_code IS NOT NULL AND order_code != ''
  `).get(startTime, endTime) as any)?.c || 0;

  // Confirmed Orders (Rule: Printed = Confirmation)
  const confirmedData: any = db.prepare(`
    SELECT 
      COUNT(DISTINCT order_code) as unique_orders,
      COUNT(*) as events_count
    FROM canonical_activity_events
    WHERE event_timestamp >= ? AND event_timestamp < ?
      AND order_code IS NOT NULL AND order_code != ''
      AND to_status = 'Printed'
  `).get(startTime, endTime);

  const confirmedOrdersCount = confirmedData?.unique_orders || 0;
  const printedEventsCount = confirmedData?.events_count || 0;

  // Canceled Orders (Strictly Canceled - separated from Canceling)
  const canceledData: any = db.prepare(`
    SELECT 
      COUNT(DISTINCT order_code) as unique_orders,
      COUNT(*) as events_count
    FROM canonical_activity_events
    WHERE event_timestamp >= ? AND event_timestamp < ?
      AND order_code IS NOT NULL AND order_code != ''
      AND to_status = 'Canceled'
  `).get(startTime, endTime);

  const canceledOrdersCount = canceledData?.unique_orders || 0;
  const canceledEventsCount = canceledData?.events_count || 0;

  const cancelingEventsCount = (db.prepare(`
    SELECT COUNT(*) as c FROM canonical_activity_events
    WHERE event_timestamp >= ? AND event_timestamp < ?
      AND to_status = 'Canceling'
  `).get(startTime, endTime) as any)?.c || 0;

  // Created Orders
  const createdData: any = db.prepare(`
    SELECT 
      COUNT(DISTINCT order_code) as unique_orders,
      COUNT(*) as events_count
    FROM canonical_activity_events
    WHERE event_timestamp >= ? AND event_timestamp < ?
      AND order_code IS NOT NULL AND order_code != ''
      AND action_type = 'order_created'
  `).get(startTime, endTime);

  const createdOrdersCount = createdData?.unique_orders || 0;
  const createdEventsCount = createdData?.events_count || 0;

  // Extra Phone Numbers Analysis
  const extraPhonesAddedData: any = db.prepare(`
    SELECT 
      COUNT(DISTINCT order_code) as unique_orders,
      COUNT(*) as events_count
    FROM canonical_activity_events
    WHERE event_timestamp >= ? AND event_timestamp < ?
      AND order_code IS NOT NULL AND order_code != ''
      AND (
        action_type = 'extra_phone_added'
        OR details_json LIKE '%"extraPhoneOperation":"ADDITION"%'
        OR (
          field_name = 'الهاتف الإضافي' 
          AND (old_value IS NULL OR TRIM(REPLACE(REPLACE(old_value, '''', ''), '"', '')) = '')
          AND (new_value IS NOT NULL AND TRIM(REPLACE(REPLACE(new_value, '''', ''), '"', '')) != '')
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
      SELECT COUNT(DISTINCT order_code) as c FROM canonical_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ?
        AND order_code IS NOT NULL AND order_code != ''
    `).get(dayInterval.startCairo, dayInterval.endCairo) as any)?.c || 0;

    const dCreatedOrders = (db.prepare(`
      SELECT COUNT(DISTINCT order_code) as c FROM canonical_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ?
        AND order_code IS NOT NULL AND order_code != ''
        AND action_type = 'order_created'
    `).get(dayInterval.startCairo, dayInterval.endCairo) as any)?.c || 0;

    const dConfirmedOrders = (db.prepare(`
      SELECT COUNT(DISTINCT order_code) as c FROM canonical_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ?
        AND order_code IS NOT NULL AND order_code != ''
        AND to_status = 'Printed'
    `).get(dayInterval.startCairo, dayInterval.endCairo) as any)?.c || 0;

    const dCanceledOrders = (db.prepare(`
      SELECT COUNT(DISTINCT order_code) as c FROM canonical_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ?
        AND order_code IS NOT NULL AND order_code != ''
        AND to_status = 'Canceled'
    `).get(dayInterval.startCairo, dayInterval.endCairo) as any)?.c || 0;

    const dExtraPhones = (db.prepare(`
      SELECT COUNT(DISTINCT order_code) as c FROM canonical_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ?
        AND order_code IS NOT NULL AND order_code != ''
        AND (
          action_type = 'extra_phone_added'
          OR details_json LIKE '%"extraPhoneOperation":"ADDITION"%'
          OR (
            field_name = 'الهاتف الإضافي' 
            AND (old_value IS NULL OR TRIM(REPLACE(REPLACE(old_value, '''', ''), '"', '')) = '')
            AND (new_value IS NOT NULL AND TRIM(REPLACE(REPLACE(new_value, '''', ''), '"', '')) != '')
          )
        )
    `).get(dayInterval.startCairo, dayInterval.endCairo) as any)?.c || 0;

    const dActiveEmployees = (db.prepare(`
      SELECT COUNT(DISTINCT actor_name) as c FROM canonical_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ?
        AND is_system_actor = 0
    `).get(dayInterval.startCairo, dayInterval.endCairo) as any)?.c || 0;

    const cov = covMap.get(d);
    const dayCovStatus = cov?.completion_status || 'NOT_SYNCED';

    daysBreakdown.push({
      date: d,
      dayNameAr,
      totalLogs: dTotalLogs,
      uniqueOrdersTouched: dUniqueOrders,
      createdOrdersCount: dCreatedOrders,
      confirmedOrdersCount: dConfirmedOrders,
      canceledOrdersCount: dCanceledOrders,
      extraPhonesAddedCount: dExtraPhones,
      activeEmployeesCount: dActiveEmployees,
      coverageStatus: dayCovStatus,
    });
  }

  // 4. Employee Activity Table
  const rawEmployees: any[] = db.prepare(`
    SELECT 
      actor_name,
      is_system_actor,
      COUNT(*) as action_count,
      COUNT(DISTINCT order_code) as unique_orders,
      COUNT(DISTINCT CASE WHEN to_status = 'Printed' THEN order_code END) as confirmed_orders_count,
      COUNT(DISTINCT CASE WHEN to_status = 'Canceled' THEN order_code END) as canceled_orders_count,
      COUNT(DISTINCT CASE 
        WHEN action_type = 'extra_phone_added' 
             OR details_json LIKE '%"extraPhoneOperation":"ADDITION"%'
             OR (field_name = 'الهاتف الإضافي' AND (old_value IS NULL OR TRIM(REPLACE(REPLACE(old_value, '''', ''), '"', '')) = '') AND (new_value IS NOT NULL AND TRIM(REPLACE(REPLACE(new_value, '''', ''), '"', '')) != ''))
        THEN order_code 
      END) as extra_phones_added_count,
      SUM(CASE WHEN action_type = 'status_change' THEN 1 ELSE 0 END) as status_changes_count
    FROM canonical_activity_events
    WHERE event_timestamp >= ? AND event_timestamp < ?
    GROUP BY actor_name, is_system_actor
    ORDER BY action_count DESC
  `).all(startTime, endTime);

  // Group actions breakdown per employee
  const employeeBreakdownRows: any[] = db.prepare(`
    SELECT actor_name, action_type, COUNT(*) as c
    FROM canonical_activity_events
    WHERE event_timestamp >= ? AND event_timestamp < ?
    GROUP BY actor_name, action_type
  `).all(startTime, endTime);

  const empBreakdownMap = new Map<string, Record<string, number>>();
  for (const r of employeeBreakdownRows) {
    if (!empBreakdownMap.has(r.actor_name)) {
      empBreakdownMap.set(r.actor_name, {});
    }
    empBreakdownMap.get(r.actor_name)![r.action_type] = r.c;
  }

  const employees: LogsIntelligenceReport['employees'] = rawEmployees.map((emp) => {
    const isSys = emp.is_system_actor === 1;
    let actorType: 'STAFF' | 'SYSTEM' | 'UNKNOWN' = isSys ? 'SYSTEM' : 'STAFF';
    if (!emp.actor_name || emp.actor_name === 'غير محدد' || emp.actor_name === 'Unknown') {
      actorType = 'UNKNOWN';
    }

    return {
      actor_name: emp.actor_name || 'غير محدد',
      is_system: emp.is_system_actor,
      actor_type: actorType,
      action_count: emp.action_count || 0,
      unique_orders: emp.unique_orders || 0,
      confirmed_orders_count: emp.confirmed_orders_count || 0,
      canceled_orders_count: emp.canceled_orders_count || 0,
      extra_phones_added_count: emp.extra_phones_added_count || 0,
      status_changes_count: emp.status_changes_count || 0,
      actions_breakdown: empBreakdownMap.get(emp.actor_name) || {},
    };
  });

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
    },
    metrics: {
      totalLogs,
      uniqueOrdersTouched,
      confirmedOrdersCount,
      printedEventsCount,
      canceledOrdersCount,
      canceledEventsCount,
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
}) {
  const {
    pillar,
    startDate,
    endDate,
    actor,
    search,
    page = 1,
    limit = 25,
  } = params;

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

  if (search && search.trim()) {
    const s = `%${search.trim()}%`;
    conditions.push('(c.order_code LIKE ? OR r.raw_action_text LIKE ? OR c.actor_name LIKE ? OR c.field_name LIKE ? OR c.new_value LIKE ?)');
    sqlParams.push(s, s, s, s, s);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const total = (db.prepare(`
    SELECT COUNT(*) as c
    FROM canonical_activity_events c
    LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
    ${whereClause}
  `).get(...sqlParams) as any)?.c || 0;

  const offset = (page - 1) * limit;
  const events = db.prepare(`
    SELECT 
      c.id, c.order_code, c.actor_name, c.action_type, c.from_status, c.to_status,
      c.field_name, c.old_value, c.new_value, c.event_timestamp, c.is_system_actor,
      COALESCE(r.raw_action_text, '') as raw_action_text,
      c.details_json
    FROM canonical_activity_events c
    LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
    ${whereClause}
    ORDER BY c.event_timestamp DESC, c.id DESC
    LIMIT ? OFFSET ?
  `).all(...sqlParams, limit, offset);

  return {
    events,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
  };
}
