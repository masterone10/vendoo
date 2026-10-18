import crypto from 'node:crypto';
import { db, getCairoDateInterval } from './db.js';
import { vendoorClient } from './vendoorClient.js';

interface LogBackfillState {
  date: string;
  status: 'IDLE' | 'RUNNING' | 'COMPLETE' | 'PARTIAL' | 'FAILED';
  pagesFetched: number;
  pagesTotal: number;
  eventsSaved: number;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

const activeJobs = new Map<string, LogBackfillState>();

/**
 * Normalizes log action and determines action_type, from_status, to_status
 */
function parseCanonicalLogAction(actionText: string) {
  let actionType = 'other';
  let fromStatus: string | null = null;
  let toStatus: string | null = null;

  if (actionText.includes('تغيير حالة') || actionText.includes('حالة الطلب')) {
    actionType = 'status_change';
    const statusMatches = actionText.match(/من\s+([^\s]+)\s+إلى\s+([^\s]+)/i);
    if (statusMatches) {
      fromStatus = statusMatches[1].trim();
      toStatus = statusMatches[2].trim();
    }
  } else if (actionText.includes('طباعة') || actionText.includes('بوليصة')) {
    actionType = 'print';
    toStatus = 'Printed';
  } else if (actionText.includes('تأكيد')) {
    actionType = 'confirm';
  } else if (actionText.includes('إلغاء') || actionText.includes('الغاء')) {
    actionType = 'cancel';
    toStatus = 'Canceled';
  } else if (actionText.includes('تعديل')) {
    actionType = 'edit';
  }

  return { actionType, fromStatus, toStatus };
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
        id, order_code, actor_name, action_type, from_status, to_status,
        raw_action_text, event_timestamp, is_system_actor, created_at
      FROM canonical_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ?
      ORDER BY event_timestamp DESC
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
    // Start background job asynchronously
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

    // Launch background worker without awaiting
    runHistoricalLogJob(cleanDate).catch((err) => {
      console.error(`[HistoricalLogs] Background job failed for ${cleanDate}:`, err.message);
    });
  }

  // Return currently available records with fetching status
  const currentLogs = db.prepare(`
    SELECT 
      id, order_code, actor_name, action_type, from_status, to_status,
      raw_action_text, event_timestamp, is_system_actor, created_at
    FROM canonical_activity_events
    WHERE event_timestamp >= ? AND event_timestamp < ?
    ORDER BY event_timestamp DESC
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
async function runHistoricalLogJob(targetDate: string): Promise<void> {
  const job = activeJobs.get(targetDate);
  if (!job) return;

  const interval = getCairoDateInterval(targetDate);
  let hasFailedPage = false;
  let totalSaved = 0;
  let pagesDiscovered = 1;

  try {
    console.log(`[HistoricalLogs] Starting log retrieval for date ${targetDate}...`);

    // Fetch page 1 with date filter
    const page1 = await vendoorClient.fetchSystemLogs(1, targetDate, targetDate);
    pagesDiscovered = Math.max(1, page1.totalPages);
    job.pagesTotal = pagesDiscovered;

    // Process page 1 entries
    totalSaved += persistLogEntries(page1.entries, interval);
    job.pagesFetched = 1;
    job.eventsSaved = totalSaved;

    // Paginate through remaining pages
    for (let p = 2; p <= pagesDiscovered; p++) {
      try {
        const nextBatch = await vendoorClient.fetchSystemLogs(p, targetDate, targetDate);
        totalSaved += persistLogEntries(nextBatch.entries, interval);
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
        records_saved, completion_status, last_attempted_at, verified_at
      ) VALUES (?, 'logs', 'HOT', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(period_date, source_domain) DO UPDATE SET
        pages_discovered = EXCLUDED.pages_discovered,
        pages_read = EXCLUDED.pages_read,
        records_saved = EXCLUDED.records_saved,
        completion_status = EXCLUDED.completion_status,
        last_attempted_at = EXCLUDED.last_attempted_at,
        verified_at = CASE WHEN EXCLUDED.completion_status = 'COMPLETE' THEN EXCLUDED.last_attempted_at ELSE historical_coverage.verified_at END
    `).run(
      targetDate,
      pagesDiscovered,
      job.pagesFetched,
      totalSaved,
      finalStatus,
      new Date().toISOString(),
      finalStatus === 'COMPLETE' ? new Date().toISOString() : null
    );

    console.log(`[HistoricalLogs] Completed log retrieval for ${targetDate}: Status=${finalStatus}, Saved=${totalSaved}`);
  } catch (err: any) {
    job.status = 'FAILED';
    job.errorMessage = err.message;
    console.error(`[HistoricalLogs] Fatal failure for ${targetDate}:`, err.message);

    db.prepare(`
      INSERT INTO historical_coverage (
        period_date, source_domain, storage_tier, pages_discovered, pages_read,
        records_saved, completion_status, last_attempted_at
      ) VALUES (?, 'logs', 'HOT', ?, ?, ?, 'FAILED', ?)
      ON CONFLICT(period_date, source_domain) DO UPDATE SET
        completion_status = 'FAILED',
        last_attempted_at = EXCLUDED.last_attempted_at
    `).run(targetDate, pagesDiscovered, job.pagesFetched, totalSaved, new Date().toISOString());
  }
}

/**
 * Persist log entries with deduplication and Cairo business-date bounding
 */
function persistLogEntries(
  entries: any[],
  interval: { startCairo: string; endCairo: string }
): number {
  let saved = 0;

  for (const entry of entries) {
    const rawActionText = (entry.rawActionText || '').trim();
    const eventTime = entry.eventTimestamp || new Date().toISOString();
    const actorName = (entry.actorName || 'النظام').trim();
    const orderCode = (entry.orderCode || '').trim() || null;

    // Check Cairo date isolation bounds [startCairo, endCairo)
    if (eventTime < interval.startCairo || eventTime >= interval.endCairo) {
      continue;
    }

    const sourceHash = crypto
      .createHash('sha256')
      .update(`${actorName}|${orderCode || ''}|${rawActionText}|${eventTime}`)
      .digest('hex');

    // 1. Insert into raw_activity_events
    let rawEventId: number | null = null;
    try {
      const res = db.prepare(`
        INSERT INTO raw_activity_events (source_hash, order_code, actor_name, raw_action_text, event_timestamp)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(source_hash) DO NOTHING
      `).run(sourceHash, orderCode, actorName, rawActionText, eventTime);

      if (res.changes > 0) {
        rawEventId = Number(res.lastInsertRowid);
      }
    } catch {
      // Already exists
    }

    // 2. Parse canonical details
    const parsed = parseCanonicalLogAction(rawActionText);
    const isSystem = (actorName === 'النظام' || actorName.toLowerCase() === 'system' || actorName === 'cron') ? 1 : 0;

    try {
      const insRes = db.prepare(`
        INSERT INTO canonical_activity_events (
          raw_event_id, order_code, actor_name, action_type, from_status, to_status,
          raw_action_text, event_timestamp, is_system_actor, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        rawEventId,
        orderCode,
        actorName,
        parsed.actionType,
        parsed.fromStatus,
        parsed.toStatus,
        rawActionText,
        eventTime,
        isSystem,
        new Date().toISOString()
      );

      if (insRes.changes > 0) {
        saved++;
      }
    } catch {
      // Duplicate
    }
  }

  return saved;
}
