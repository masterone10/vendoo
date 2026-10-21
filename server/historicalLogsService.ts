import crypto from 'node:crypto';
import { db, getCairoDateInterval, isDateInHot } from './db.ts';
import { vendoorClient } from './vendoorClient.ts';
import { syncEngine } from './syncEngine.ts';
import { parseLogActionDetails } from './logDetailsParser.ts';

export interface LogBackfillState {
  date: string;
  status: 'IDLE' | 'RUNNING' | 'COMPLETE' | 'PARTIAL' | 'FAILED';
  pagesFetched: number;
  pagesTotal: number;
  eventsSaved: number;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface PeriodLogsFetchReport {
  success: boolean;
  startDate: string;
  endDate: string;
  totalDays: number;
  totalFetched: number;
  totalSaved: number;
  totalDuplicates: number;
  failedPages: number;
  coverageStatus: 'COMPLETE' | 'PARTIAL' | 'FAILED';
  days: Array<{
    date: string;
    pagesTotal: number;
    pagesFetched: number;
    eventsFetched: number;
    eventsSaved: number;
    status: 'COMPLETE' | 'PARTIAL' | 'FAILED';
    error?: string | null;
  }>;
  errorMessage?: string | null;
}

const activeJobs = new Map<string, LogBackfillState>();

/**
 * Persist log entries with deterministic SHA256 deduplication and Cairo business-date bounding.
 * Preserves raw log entry, parses canonical action, and avoids inserting raw_action_text into canonical table.
 */
export interface PersistLogOptions {
  dataSource?: 'EXCEL_IMPORT' | 'CSV_IMPORT' | 'VENDOOR_FETCH' | 'SUPABASE_ARCHIVE' | string;
  batchId?: string;
  strictInterval?: boolean;
}

export function persistLogEntries(
  entries: any[],
  interval: { startCairo: string; endCairo: string },
  options?: PersistLogOptions
): { saved: number; duplicates: number } {
  let saved = 0;
  let duplicates = 0;
  const nowIso = new Date().toISOString();
  const dataSource = options?.dataSource || 'VENDOOR_FETCH';
  const importId = options?.batchId || null;
  const strictInterval = options?.strictInterval !== false;

  const insertRawStmt = db.prepare(`
    INSERT INTO raw_activity_events (
      source_hash, order_code, actor_name, raw_action_text,
      event_timestamp, storage_tier, observed_at, page_source,
      vendoor_order_id, raw_html, details_json, data_source, import_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'log/system', ?, ?, ?, ?, ?)
    ON CONFLICT(source_hash) DO NOTHING
  `);

  const insertCanonStmt = db.prepare(`
    INSERT INTO canonical_activity_events (
      raw_event_id, order_code, actor_name, action_type, from_status, to_status,
      event_timestamp, storage_tier, is_system_actor, created_at,
      order_id, order_match_status, is_administrative, field_name, old_value, new_value, details_json,
      data_source, import_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const findOrderStmt = db.prepare(`
    SELECT id, random_number, current_status
    FROM orders
    WHERE random_number = ? OR order_no = ? OR CAST(vendoor_id AS TEXT) = ?
    LIMIT 1
  `);

  const findRawByHashStmt = db.prepare('SELECT id FROM raw_activity_events WHERE source_hash = ?');
  const checkCanonStmt = db.prepare(`
    SELECT id FROM canonical_activity_events
    WHERE (raw_event_id IS NOT NULL AND raw_event_id = ?)
       OR (order_code IS ? AND actor_name = ? AND action_type = ? AND event_timestamp = ?)
    LIMIT 1
  `);
  const insertStatusEventStmt = db.prepare(`
    INSERT INTO order_status_events (
      order_id, random_number, from_status, to_status, actor_name,
      event_time_source, storage_tier, observed_at, source_channel
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'system_log_audit')
  `);
  const updateOrderStatusStmt = db.prepare(`
    UPDATE orders
    SET current_status = ?,
        validation_status = 'RESOLVED_VIA_AUDIT_LOGS',
        printed_date = CASE WHEN ? = 'Printed' THEN COALESCE(printed_date, ?) ELSE printed_date END,
        canceling_date = CASE WHEN ? = 'Canceled' THEN COALESCE(canceling_date, ?) ELSE canceling_date END,
        state_entry_at = ?,
        last_observed_at = ?
    WHERE id = ? AND (state_entry_at IS NULL OR state_entry_at <= ?)
  `);

  const TX_BATCH_SIZE = 1000;
  let inTx = false;
  try {
    db.exec('BEGIN TRANSACTION;');
    inTx = true;

    for (let i = 0; i < entries.length; i++) {
      if (i > 0 && i % TX_BATCH_SIZE === 0) {
        db.exec('COMMIT; BEGIN TRANSACTION;');
      }
      const entry = entries[i];
      const rawActionText = (entry.rawActionText || '').trim();
      const eventTime = entry.eventTimestamp || nowIso;
      const actorName = (entry.actorName || 'النظام').trim();
      const orderCode = (entry.orderCode || '').trim() || null;

      // Check Cairo date isolation bounds [startCairo, endCairo) if strictInterval is true
      if (strictInterval && (eventTime < interval.startCairo || eventTime >= interval.endCairo)) {
        continue;
      }

      const sourceHash = crypto
        .createHash('sha256')
        .update(`${actorName}|${orderCode || ''}|${rawActionText}|${eventTime}`)
        .digest('hex');

      const logTier = isDateInHot(eventTime) ? 'HOT' : 'COLD';

      const parsed = parseLogActionDetails(rawActionText, actorName, orderCode || '');
      const detailsJson = JSON.stringify(parsed);

      // 1. Insert into raw_activity_events
      let rawEventId: number | null = null;
      let isNewRaw = false;
      try {
        const res = insertRawStmt.run(
          sourceHash,
          orderCode,
          actorName,
          rawActionText,
          eventTime,
          logTier,
          nowIso,
          entry.vendoorOrderId || null,
          entry.rawHtml || null,
          detailsJson,
          dataSource,
          importId
        );
        if (res.changes > 0) {
          rawEventId = Number(res.lastInsertRowid);
          isNewRaw = true;
        } else {
          // Event hash already exists - retrieve existing rawEventId
          const existingRow: any = findRawByHashStmt.get(sourceHash);
          rawEventId = existingRow?.id ? Number(existingRow.id) : null;
          duplicates++;
        }
      } catch {
        duplicates++;
      }

      const isSystem = (
        actorName === 'النظام' ||
        actorName.toLowerCase() === 'system' ||
        actorName.toLowerCase().includes('cron') ||
        actorName.includes('تلقائي')
      ) ? 1 : 0;

      // Check if canonical event already exists for this exact raw_event_id or order, actor, action, timestamp
      const existingCanon: any = checkCanonStmt.get(rawEventId, orderCode, actorName, parsed.actionType, eventTime);

      if (!existingCanon && isNewRaw) {
        try {
          let matchedOrderId: number | null = null;
          let matchStatus = 'UNRESOLVED';
          let ord: any = null;
          if (!orderCode) {
            matchStatus = 'GENERAL_LOG';
          } else {
            ord = findOrderStmt.get(orderCode, orderCode, orderCode);
            if (ord) {
              matchedOrderId = ord.id;
              matchStatus = 'MATCHED';
            }
          }

          const insRes = insertCanonStmt.run(
            rawEventId,
            orderCode,
            actorName,
            parsed.actionType,
            parsed.fromStatus,
            parsed.toStatus,
            eventTime,
            logTier,
            isSystem,
            nowIso,
            matchedOrderId,
            matchStatus,
            parsed.isAdministrative ? 1 : 0,
            parsed.fieldName,
            parsed.oldValue,
            parsed.newValue,
            detailsJson,
            dataSource,
            importId
          );

          if (insRes.changes > 0) {
            saved++;

            // 3. If event provides verified status change and matches an existing order, link timeline
            if (orderCode && parsed.actionType === 'status_change' && parsed.toStatus && ord) {
              insertStatusEventStmt.run(
                ord.id,
                ord.random_number,
                parsed.fromStatus || ord.current_status,
                parsed.toStatus,
                actorName,
                eventTime,
                logTier,
                nowIso
              );

              // Update order current status and transition timestamps if event is newer than state_entry_at
              updateOrderStatusStmt.run(parsed.toStatus, parsed.toStatus, eventTime, parsed.toStatus, eventTime, eventTime, nowIso, ord.id, eventTime);
            }
          }
        } catch {
          // Safe duplicate or constraint handling
        }
      }
    }

    db.exec('COMMIT;');
    inTx = false;
  } catch (err) {
    if (inTx) {
      try { db.exec('ROLLBACK;'); } catch {}
    }
    throw err;
  }

  return { saved, duplicates };
}

/**
 * Check coverage and return cached logs if COMPLETE,
 * or initiate background fetch-on-missing if incomplete.
 */
export async function getOrFetchHistoricalLogs(targetDate: string): Promise<{
  date: string;
  isComplete: boolean;
  isFetching: boolean;
  coverageStatus: string;
  logs: any[];
  progress?: { pagesFetched: number; pagesTotal: number; eventsSaved: number };
  error?: string | null;
}> {
  const cleanDate = targetDate.trim().slice(0, 10);
  const interval = getCairoDateInterval(cleanDate);

  // 1. Check existing coverage in database
  const covRow: any = db.prepare(`
    SELECT completion_status, pages_read, pages_discovered, records_saved
    FROM historical_coverage
    WHERE period_date = ? AND source_domain = 'logs'
  `).get(cleanDate);

  const isComplete = covRow?.completion_status === 'COMPLETE';

  // 2. If coverage is COMPLETE, return cached logs immediately (zero Vendoor calls!)
  if (isComplete) {
    const logs = db.prepare(`
      SELECT 
        c.id, c.order_code, c.actor_name, c.action_type, c.from_status, c.to_status,
        COALESCE(r.raw_action_text, '') as raw_action_text,
        c.event_timestamp, c.storage_tier, c.is_system_actor, c.created_at
      FROM canonical_activity_events c
      LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
      WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
      ORDER BY c.event_timestamp DESC
    `).all(interval.startCairo, interval.endCairo);

    return {
      date: cleanDate,
      isComplete: true,
      isFetching: false,
      coverageStatus: 'COMPLETE',
      logs,
    };
  }

  // 3. Coverage is absent or incomplete - start/check background job
  let job = activeJobs.get(cleanDate);

  if (!job || job.status === 'FAILED' || job.status === 'PARTIAL') {
    job = {
      date: cleanDate,
      status: 'RUNNING',
      pagesFetched: 0,
      pagesTotal: 1,
      eventsSaved: 0,
      errorMessage: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    activeJobs.set(cleanDate, job);

    runHistoricalLogJob(cleanDate).catch((err) => {
      console.error(`[HistoricalLogs] Background job failed for ${cleanDate}:`, err.message);
    });
  }

  // Return currently available records with fetching status
  const currentLogs = db.prepare(`
    SELECT 
      c.id, c.order_code, c.actor_name, c.action_type, c.from_status, c.to_status,
      COALESCE(r.raw_action_text, '') as raw_action_text,
      c.event_timestamp, c.storage_tier, c.is_system_actor, c.created_at
    FROM canonical_activity_events c
    LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
    WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
    ORDER BY c.event_timestamp DESC
  `).all(interval.startCairo, interval.endCairo);

  return {
    date: cleanDate,
    isComplete: false,
    isFetching: job.status === 'RUNNING',
    coverageStatus: covRow?.completion_status || 'NOT_SYNCED',
    logs: currentLogs,
    progress: {
      pagesFetched: job.pagesFetched,
      pagesTotal: job.pagesTotal,
      eventsSaved: job.eventsSaved,
    },
    error: job.errorMessage,
  };
}

/**
 * Worker that paginates through Vendoor system logs for a specific Cairo business date.
 */
export async function runHistoricalLogJob(targetDate: string): Promise<void> {
  const job = activeJobs.get(targetDate) || {
    date: targetDate,
    status: 'RUNNING',
    pagesFetched: 0,
    pagesTotal: 1,
    eventsSaved: 0,
    errorMessage: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
  activeJobs.set(targetDate, job);

  const interval = getCairoDateInterval(targetDate);
  let hasFailedPage = false;
  let totalSaved = 0;
  let pagesDiscovered = 1;

  try {
    console.log(`[HistoricalLogs] Starting log retrieval for date ${targetDate}...`);

    if (!vendoorClient.isConfigured()) {
      throw new Error('Vendoor credentials are not configured in environment or secrets.');
    }

    // Fetch page 1 with date filter
    const page1 = await vendoorClient.fetchSystemLogs(1, targetDate, targetDate);
    pagesDiscovered = Math.max(1, page1.totalPages);
    job.pagesTotal = pagesDiscovered;

    const p1Result = persistLogEntries(page1.entries, interval);
    totalSaved += p1Result.saved;
    job.pagesFetched = 1;
    job.eventsSaved = totalSaved;

    // Paginate through remaining pages
    for (let p = 2; p <= pagesDiscovered; p++) {
      try {
        const nextBatch = await vendoorClient.fetchSystemLogs(p, targetDate, targetDate);
        const batchRes = persistLogEntries(nextBatch.entries, interval);
        totalSaved += batchRes.saved;
        job.pagesFetched = p;
        job.eventsSaved = totalSaved;
      } catch (pageErr: any) {
        console.warn(`[HistoricalLogs] Page ${p} failed for ${targetDate}:`, pageErr.message);
        hasFailedPage = true;
        job.errorMessage = `Failed on page ${p}: ${pageErr.message}`;
        break;
      }
    }

    const finalStatus = hasFailedPage ? 'PARTIAL' : 'COMPLETE';
    job.status = finalStatus;
    job.completedAt = new Date().toISOString();

    // Update historical coverage table
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
      targetDate,
      pagesDiscovered,
      job.pagesFetched,
      totalSaved,
      finalStatus,
      new Date().toISOString(),
      finalStatus === 'COMPLETE' ? new Date().toISOString() : null,
      finalStatus === 'COMPLETE' ? new Date().toISOString() : null
    );

    console.log(`[HistoricalLogs] Completed log retrieval for ${targetDate}: Status=${finalStatus}, Saved=${totalSaved}`);
  } catch (err: any) {
    job.status = 'FAILED';
    job.errorMessage = err.message;
    console.error(`[HistoricalLogs] Failure for ${targetDate}:`, err.message);

    db.prepare(`
      INSERT INTO historical_coverage (
        period_date, source_domain, storage_tier, pages_discovered, pages_read,
        records_saved, completion_status, last_attempted_at, error_message
      ) VALUES (?, 'logs', 'HOT', ?, ?, ?, 'FAILED', ?, ?)
      ON CONFLICT(source_domain, period_date) DO UPDATE SET
        completion_status = 'FAILED',
        error_message = excluded.error_message,
        last_attempted_at = excluded.last_attempted_at
    `).run(targetDate, pagesDiscovered, job.pagesFetched, totalSaved, new Date().toISOString(), err.message);
  }
}

/**
 * Fetch and persist logs for a custom period (range of dates) on user demand:
 * «جلب وحفظ لوجز الفترة»
 */
export async function fetchAndPersistLogsForPeriod(
  startDateStr: string,
  endDateStr: string
): Promise<PeriodLogsFetchReport> {
  const start = startDateStr.slice(0, 10);
  const end = endDateStr.slice(0, 10);

  if (start > end) {
    throw new Error('تاريخ البداية يجب أن يكون قبل أو يساوي تاريخ النهاية');
  }

  // Generate list of dates in period
  const dates: string[] = [];
  const curr = new Date(`${start}T00:00:00Z`);
  const stop = new Date(`${end}T00:00:00Z`);

  while (curr <= stop) {
    dates.push(curr.toISOString().slice(0, 10));
    curr.setUTCDate(curr.getUTCDate() + 1);
  }

  let totalFetched = 0;
  let totalSaved = 0;
  let totalDuplicates = 0;
  let failedPages = 0;
  const daysReport: PeriodLogsFetchReport['days'] = [];

  for (const date of dates) {
    const interval = getCairoDateInterval(date);
    let dayPagesTotal = 1;
    let dayPagesFetched = 0;
    let dayEventsFetched = 0;
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
      dayEventsFetched += p1.entries.length;

      const p1Res = persistLogEntries(p1.entries, interval);
      dayEventsSaved += p1Res.saved;
      totalDuplicates += p1Res.duplicates;

      // Remaining pages
      for (let p = 2; p <= dayPagesTotal; p++) {
        try {
          const nextP = await vendoorClient.fetchSystemLogs(p, date, date);
          dayPagesFetched = p;
          dayEventsFetched += nextP.entries.length;
          const nextRes = persistLogEntries(nextP.entries, interval);
          dayEventsSaved += nextRes.saved;
          totalDuplicates += nextRes.duplicates;
        } catch (pageErr: any) {
          failedPages++;
          dayStatus = 'PARTIAL';
          dayError = `فشل في الصفحة ${p}: ${pageErr.message}`;
          break;
        }
      }

      // Update coverage record for this day
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
      dayStatus = 'FAILED';
      dayError = dayErr.message;
      failedPages++;

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

    totalFetched += dayEventsFetched;
    totalSaved += dayEventsSaved;

    daysReport.push({
      date,
      pagesTotal: dayPagesTotal,
      pagesFetched: dayPagesFetched,
      eventsFetched: dayEventsFetched,
      eventsSaved: dayEventsSaved,
      status: dayStatus,
      error: dayError,
    });
  }

  const overallStatus: 'COMPLETE' | 'PARTIAL' | 'FAILED' =
    failedPages === 0
      ? 'COMPLETE'
      : totalSaved > 0
      ? 'PARTIAL'
      : 'FAILED';

  return {
    success: overallStatus !== 'FAILED',
    startDate: start,
    endDate: end,
    totalDays: dates.length,
    totalFetched,
    totalSaved,
    totalDuplicates,
    failedPages,
    coverageStatus: overallStatus,
    days: daysReport,
  };
}

export function getActiveJobStatus(targetDate: string): LogBackfillState | null {
  return activeJobs.get(targetDate) || null;
}
