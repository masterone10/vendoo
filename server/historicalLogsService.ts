import crypto from 'node:crypto';
import * as XLSX from 'xlsx';
import { db, getCairoDateInterval, isDateInHot, saveCoverageRecord } from './db.ts';
import { vendoorClient, type LogEntry } from './vendoorClient.ts';
import { parseLogActionDetails } from './logDetailsParser.ts';
import { normalizeDateStringToCairo, findMatchingField, HEADER_ALIASES } from './batchLogsImporter.ts';
import { isSupabaseConfigured, syncDayLogsToSupabase } from './supabaseClient.ts';

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
  const tupleSeqMap = new Map<string, number>();

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

      const naturalKey = `${actorName}|${orderCode || ''}|${rawActionText}|${eventTime}`;
      const occurrenceSeq = (tupleSeqMap.get(naturalKey) || 0) + 1;
      tupleSeqMap.set(naturalKey, occurrenceSeq);

      // Occurrence 1 maintains exact compatibility with existing single-instance hashes;
      // occurrence >= 2 gets a sequence suffix so multiple distinct events in the same second are not merged!
      const sourceHash = crypto
        .createHash('sha256')
        .update(occurrenceSeq === 1 ? naturalKey : `${naturalKey}|#${occurrenceSeq}`)
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
      } catch (insertErr: any) {
        if (insertErr?.code === 'SQLITE_CONSTRAINT' || insertErr?.message?.includes('UNIQUE')) {
          const existingRow: any = findRawByHashStmt.get(sourceHash);
          rawEventId = existingRow?.id ? Number(existingRow.id) : null;
          duplicates++;
        } else {
          console.warn('[HistoricalLogs] Write error on raw event:', insertErr.message);
        }
      }

      const isSystem = (
        actorName === 'النظام' ||
        actorName.toLowerCase() === 'system' ||
        actorName.toLowerCase().includes('cron') ||
        actorName.includes('تلقائي')
      ) ? 1 : 0;

      // Check if canonical event already exists for this exact raw_event_id or order, actor, action, timestamp
      const existingCanon: any = checkCanonStmt.get(rawEventId, orderCode, actorName, parsed.actionType, eventTime);

      // CRITICAL FIX: Convert and create canonical event whenever it is missing,
      // regardless of whether raw was just inserted or was already present from a previous pass!
      if (!existingCanon) {
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
 * Attempts to download and parse the native Vendoor System Logs Excel export (/dashboard/log/xls/all).
 * Verifies that the file contains genuine rows for the specified Cairo business date.
 */
export async function tryVendoorNativeExcelExport(
  targetDate: string,
  interval: { startCairo: string; endCairo: string }
): Promise<{ success: boolean; entries: LogEntry[]; reason?: string; rawBufferLength?: number }> {
  try {
    if (!vendoorClient.isConfigured()) {
      return { success: false, entries: [], reason: 'بيانات دخول Vendoor غير مهيأة في بيئة التشغيل' };
    }

    const buffer = await vendoorClient.exportSystemLogsExcel(targetDate, targetDate);
    if (!buffer || buffer.length === 0) {
      return { success: false, entries: [], reason: 'الملف المستلم من خادم Vendoor فارغ' };
    }

    // Check if response is an HTML error/login page instead of binary spreadsheet
    const peek = buffer.slice(0, 300).toString('utf-8');
    if (peek.includes('<html') || peek.includes('<!DOCTYPE html') || peek.includes('/login')) {
      return { success: false, entries: [], reason: 'أعاد الخادم صفحة تسجيل دخول أو خطأ HTML بدل ملف Excel' };
    }

    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(buffer, { type: 'buffer', raw: true });
    } catch (parseErr: any) {
      return { success: false, entries: [], reason: `فشل فك تشفير جدول البيانات: ${parseErr.message}` };
    }

    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      return { success: false, entries: [], reason: 'ملف Excel لا يحتوي على أي صفحات عمل' };
    }

    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) {
      return { success: false, entries: [], reason: 'صفحة العمل الأساسية فارغة' };
    }

    const sheetAoa: any[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '', raw: true });
    if (!sheetAoa || sheetAoa.length < 2) {
      return { success: false, entries: [], reason: 'ملف Excel يحتوي على أقل من صفين (لا توجد بيانات حركات)' };
    }

    // Header detection across first 15 rows
    let headerRowIdx = -1;
    let colOrderCode = -1;
    let colActor = -1;
    let colAction = -1;
    let colTimestamp = -1;
    let colOrderId = -1;

    for (let r = 0; r < Math.min(15, sheetAoa.length); r++) {
      const row = (sheetAoa[r] || []).map(c => String(c || '').trim());
      const fOrder = findMatchingField(row, HEADER_ALIASES.orderCode);
      const fActor = findMatchingField(row, HEADER_ALIASES.actorName);
      const fAction = findMatchingField(row, HEADER_ALIASES.rawActionText);
      const fTime = findMatchingField(row, HEADER_ALIASES.eventTimestamp);
      const fOid = findMatchingField(row, HEADER_ALIASES.vendoorOrderId);

      if (fAction || fTime) {
        headerRowIdx = r;
        colOrderCode = fOrder ? row.indexOf(fOrder) : -1;
        colActor = fActor ? row.indexOf(fActor) : -1;
        colAction = fAction ? row.indexOf(fAction) : -1;
        colTimestamp = fTime ? row.indexOf(fTime) : -1;
        colOrderId = fOid ? row.indexOf(fOid) : -1;
        break;
      }
    }

    if (headerRowIdx === -1 || colAction === -1 || colTimestamp === -1) {
      return { success: false, entries: [], reason: 'تعذر العثور على أعمدة الإجراء ووقت الحدث في ملف Excel' };
    }

    const entries: LogEntry[] = [];
    for (let rIdx = headerRowIdx + 1; rIdx < sheetAoa.length; rIdx++) {
      const row = sheetAoa[rIdx];
      if (!row || row.length === 0) continue;

      const actionText = String(row[colAction] || '').trim();
      const rawTimestamp = row[colTimestamp];
      if (!actionText && !rawTimestamp) continue;

      const normalized = normalizeDateStringToCairo(rawTimestamp);
      if (!normalized.timestampStr) continue;

      // Ensure Cairo date interval bounds [startCairo, endCairo)
      if (normalized.timestampStr < interval.startCairo || normalized.timestampStr >= interval.endCairo) {
        continue;
      }

      const orderCode = colOrderCode >= 0 ? String(row[colOrderCode] || '').trim() || null : null;
      const actorName = colActor >= 0 ? String(row[colActor] || '').trim() || 'النظام' : 'النظام';
      const rawOrderId = colOrderId >= 0 ? parseInt(String(row[colOrderId]), 10) : null;
      const vendoorOrderId = isNaN(rawOrderId as any) ? null : rawOrderId;

      entries.push({
        index: rIdx,
        orderCode: orderCode || '',
        actorName,
        rawActionText: actionText,
        eventTimestamp: normalized.timestampStr,
        vendoorOrderId,
      });
    }

    return {
      success: true,
      entries,
      rawBufferLength: buffer.length,
    };
  } catch (err: any) {
    return { success: false, entries: [], reason: err.message };
  }
}

/**
 * Worker that retrieves Vendoor system logs for a specific Cairo business date.
 * Primary Path: Native Vendoor Excel export (/dashboard/log/xls/all) with date boundaries.
 * Fallback Path: Robust paginated extraction (/dashboard/log/system) page-by-page.
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
    console.log(`[HistoricalLogs] Starting unified log retrieval for date ${targetDate}...`);

    if (!vendoorClient.isConfigured()) {
      throw new Error('بيانات دخول Vendoor غير مهيأة في بيئة التشغيل');
    }

    // -------------------------------------------------------------------------
    // Phase 1: Attempt Native Vendoor Excel Export
    // -------------------------------------------------------------------------
    console.log(`[HistoricalLogs] Attempting native Excel export for ${targetDate}...`);
    const excelRes = await tryVendoorNativeExcelExport(targetDate, interval);

    if (excelRes.success && excelRes.entries.length > 0) {
      console.log(`[HistoricalLogs] Native Excel export succeeded for ${targetDate}: ${excelRes.entries.length} entries verified`);
      const pRes = persistLogEntries(excelRes.entries, interval, {
        dataSource: 'VENDOOR_FETCH',
        strictInterval: true,
      });

      totalSaved = pRes.saved;
      job.pagesFetched = 1;
      job.pagesTotal = 1;
      job.eventsSaved = totalSaved;
      job.status = 'COMPLETE';
      job.completedAt = new Date().toISOString();

      saveCoverageRecord({
        periodDate: targetDate,
        sourceDomain: 'logs',
        storageTier: 'HOT',
        pagesDiscovered: 1,
        pagesRead: 1,
        recordsExtracted: excelRes.entries.length,
        recordsSaved: totalSaved,
        completionStatus: 'COMPLETE',
        lastAttemptedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        verifiedAt: new Date().toISOString(),
        dataSource: 'VENDOOR_FETCH',
        canonicalEventsCount: totalSaved,
        duplicatesCount: pRes.duplicates,
        notes: `تصدير Excel أصلي مباشر من Vendoor: تم التحقق من ${excelRes.entries.length} حركة بنجاح`,
      });

      if (isSupabaseConfigured()) {
        syncDayLogsToSupabase(targetDate).catch(e => console.warn('[HistoricalLogs] Supabase background sync error:', e.message));
      }

      return;
    }

    // -------------------------------------------------------------------------
    // Phase 2: Fallback to Paginated Extraction
    // -------------------------------------------------------------------------
    console.warn(`[HistoricalLogs] Native Excel export not available for ${targetDate} (${excelRes.reason || 'لا توجد حركات'}); انتقال إلى السحب المرقّم بالصفحات...`);

    // Fetch page 1 with date filter
    const page1 = await vendoorClient.fetchSystemLogs(1, targetDate, targetDate);
    pagesDiscovered = Math.max(1, page1.totalPages);
    job.pagesTotal = pagesDiscovered;

    // Check if this is an empty verified day
    if (page1.entries.length === 0 && pagesDiscovered <= 1) {
      console.log(`[HistoricalLogs] Date ${targetDate} confirmed EMPTY_VERIFIED (0 logs in Vendoor System Logs)`);
      job.status = 'COMPLETE';
      job.completedAt = new Date().toISOString();

      saveCoverageRecord({
        periodDate: targetDate,
        sourceDomain: 'logs',
        storageTier: 'HOT',
        pagesDiscovered: 1,
        pagesRead: 1,
        recordsExtracted: 0,
        recordsSaved: 0,
        completionStatus: 'EMPTY_VERIFIED',
        lastAttemptedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        verifiedAt: new Date().toISOString(),
        dataSource: 'VENDOOR_FETCH',
        canonicalEventsCount: 0,
        duplicatesCount: 0,
        notes: 'يوم تم التحقق من خلوه من أي حركات في Vendoor',
      });
      return;
    }

    const p1Result = persistLogEntries(page1.entries, interval, {
      dataSource: 'VENDOOR_FETCH',
      strictInterval: true,
    });
    totalSaved += p1Result.saved;
    job.pagesFetched = 1;
    job.eventsSaved = totalSaved;

    // Check existing coverage to support smart resumption
    const existingCov: any = db.prepare(`
      SELECT pages_read, pages_discovered, records_saved FROM historical_coverage
      WHERE period_date = ? AND source_domain = 'logs'
    `).get(targetDate);

    const startPage = (existingCov && existingCov.pages_read > 1 && existingCov.pages_discovered > existingCov.pages_read)
      ? existingCov.pages_read + 1
      : 2;

    job.pagesFetched = Math.max(1, existingCov?.pages_read || 1);

    // Paginate through remaining pages
    for (let p = startPage; p <= pagesDiscovered; p++) {
      let pageSuccess = false;
      let lastErr: any = null;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          if (p > 2 && attempt === 1) {
            await new Promise(r => setTimeout(r, 60));
          }
          const nextBatch = await vendoorClient.fetchSystemLogs(p, targetDate, targetDate);
          
          if (nextBatch.totalPages > pagesDiscovered) {
            pagesDiscovered = nextBatch.totalPages;
            job.pagesTotal = pagesDiscovered;
          }

          if (nextBatch.entries && nextBatch.entries.length > 0) {
            const batchRes = persistLogEntries(nextBatch.entries, interval, {
              dataSource: 'VENDOOR_FETCH',
              strictInterval: true,
            });
            totalSaved += batchRes.saved;
          }

          job.pagesFetched = p;
          job.eventsSaved = totalSaved;
          pageSuccess = true;
          break;
        } catch (pageErr: any) {
          lastErr = pageErr;
          if (attempt < 3) {
            await new Promise(r => setTimeout(r, 500 * attempt));
          }
        }
      }

      if (!pageSuccess) {
        console.warn(`[HistoricalLogs] Page ${p} failed for ${targetDate} after 3 attempts:`, lastErr?.message);
        hasFailedPage = true;
        job.errorMessage = `فشل في الصفحة ${p}: ${lastErr?.message}`;
        break;
      }

      // Checkpoint every 10 pages
      if (p % 10 === 0 || p === pagesDiscovered) {
        saveCoverageRecord({
          periodDate: targetDate,
          sourceDomain: 'logs',
          storageTier: 'HOT',
          pagesDiscovered: pagesDiscovered,
          pagesRead: job.pagesFetched,
          recordsExtracted: totalSaved,
          recordsSaved: totalSaved,
          completionStatus: job.pagesFetched >= pagesDiscovered && !hasFailedPage ? 'COMPLETE' : 'PARTIAL',
          lastAttemptedAt: new Date().toISOString(),
          notes: `سحب جاري: تم استيفاء صفحة ${job.pagesFetched}/${pagesDiscovered}`,
        });
      }
    }

    const finalStatus = hasFailedPage ? 'PARTIAL' : 'COMPLETE';
    job.status = finalStatus;
    job.completedAt = new Date().toISOString();

    saveCoverageRecord({
      periodDate: targetDate,
      sourceDomain: 'logs',
      storageTier: 'HOT',
      pagesDiscovered: pagesDiscovered,
      pagesRead: job.pagesFetched,
      recordsExtracted: totalSaved,
      recordsSaved: totalSaved,
      completionStatus: finalStatus,
      lastAttemptedAt: new Date().toISOString(),
      completedAt: finalStatus === 'COMPLETE' ? new Date().toISOString() : null,
      verifiedAt: finalStatus === 'COMPLETE' ? new Date().toISOString() : null,
      dataSource: 'VENDOOR_FETCH',
      canonicalEventsCount: totalSaved,
      notes: hasFailedPage ? `سحب جزئي: توقف عند الصفحة ${job.pagesFetched}/${pagesDiscovered}` : `سحب مرقّم مكتمل: ${job.pagesFetched} صفحة`,
    });

    if (finalStatus === 'COMPLETE' && isSupabaseConfigured()) {
      syncDayLogsToSupabase(targetDate).catch(e => console.warn('[HistoricalLogs] Supabase background sync error:', e.message));
    }

    console.log(`[HistoricalLogs] Completed log retrieval for ${targetDate}: Status=${finalStatus}, Saved=${totalSaved}`);
  } catch (err: any) {
    job.status = 'FAILED';
    job.errorMessage = err.message;
    console.error(`[HistoricalLogs] Failure for ${targetDate}:`, err.message);

    saveCoverageRecord({
      periodDate: targetDate,
      sourceDomain: 'logs',
      storageTier: 'HOT',
      pagesDiscovered: pagesDiscovered,
      pagesRead: job.pagesFetched,
      recordsExtracted: totalSaved,
      recordsSaved: totalSaved,
      completionStatus: 'FAILED',
      errorMessage: err.message,
      lastAttemptedAt: new Date().toISOString(),
      dataSource: 'VENDOOR_FETCH',
    });
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

      // 1. Try native Excel export first
      const excelRes = await tryVendoorNativeExcelExport(date, interval);
      if (excelRes.success && excelRes.entries.length > 0) {
        dayPagesTotal = 1;
        dayPagesFetched = 1;
        dayEventsFetched = excelRes.entries.length;
        const pRes = persistLogEntries(excelRes.entries, interval, {
          dataSource: 'VENDOOR_FETCH',
          strictInterval: true,
        });
        dayEventsSaved = pRes.saved;
        totalDuplicates += pRes.duplicates;
        dayStatus = 'COMPLETE';
      } else {
        // 2. Fallback to paginated logs
        const p1 = await vendoorClient.fetchSystemLogs(1, date, date);
        dayPagesTotal = Math.max(1, p1.totalPages);
        dayPagesFetched = 1;
        dayEventsFetched += p1.entries.length;

        if (p1.entries.length === 0 && dayPagesTotal <= 1) {
          dayStatus = 'COMPLETE';
        } else {
          const p1Res = persistLogEntries(p1.entries, interval, {
            dataSource: 'VENDOOR_FETCH',
            strictInterval: true,
          });
          dayEventsSaved += p1Res.saved;
          totalDuplicates += p1Res.duplicates;

          // Remaining pages
          for (let p = 2; p <= dayPagesTotal; p++) {
            try {
              const nextP = await vendoorClient.fetchSystemLogs(p, date, date);
              dayPagesFetched = p;
              dayEventsFetched += nextP.entries.length;
              const nextRes = persistLogEntries(nextP.entries, interval, {
                dataSource: 'VENDOOR_FETCH',
                strictInterval: true,
              });
              dayEventsSaved += nextRes.saved;
              totalDuplicates += nextRes.duplicates;
            } catch (pageErr: any) {
              failedPages++;
              dayStatus = 'PARTIAL';
              dayError = `فشل في الصفحة ${p}: ${pageErr.message}`;
              break;
            }
          }
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

/**
 * Detects raw activity logs that lack a corresponding canonical activity event
 * and repairs them idempotently without needing to re-download from Vendoor.
 */
export function repairRawWithoutCanonical(dateStr?: string): {
  examined: number;
  repaired: number;
  alreadyMatched: number;
  errors: number;
} {
  const nowIso = new Date().toISOString();
  let dateClause = '';
  const params: any[] = [];

  if (dateStr && typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr.trim())) {
    const interval = getCairoDateInterval(dateStr.trim());
    dateClause = 'AND r.event_timestamp >= ? AND r.event_timestamp < ?';
    params.push(interval.startCairo, interval.endCairo);
  }

  // Find raw events that have no canonical event linked by raw_event_id or natural key
  const uncanonicalRows: any[] = db.prepare(`
    SELECT r.id, r.order_code, r.actor_name, r.raw_action_text, r.event_timestamp,
           r.storage_tier, r.page_source, r.data_source, r.import_id
    FROM raw_activity_events r
    WHERE NOT EXISTS (
      SELECT 1 FROM canonical_activity_events c WHERE c.raw_event_id = r.id
    ) ${dateClause}
    ORDER BY r.id ASC
    LIMIT 20000
  `).all(...params);

  if (uncanonicalRows.length === 0) {
    return { examined: 0, repaired: 0, alreadyMatched: 0, errors: 0 };
  }

  const orderMap = new Map<string, number>();
  const allOrders = db.prepare('SELECT id, random_number, order_no, vendoor_id FROM orders').all() as any[];
  for (const o of allOrders) {
    if (o.random_number) orderMap.set(o.random_number.trim(), o.id);
    if (o.order_no) orderMap.set(o.order_no.trim(), o.id);
    if (o.vendoor_id) orderMap.set(String(o.vendoor_id).trim(), o.id);
  }

  const checkCanon = db.prepare(`
    SELECT id, raw_event_id FROM canonical_activity_events
    WHERE raw_event_id = ?
       OR (raw_event_id IS NULL AND order_code IS ? AND actor_name = ? AND action_type = ? AND event_timestamp = ?)
    LIMIT 1
  `);

  const updateCanonRawId = db.prepare(`
    UPDATE canonical_activity_events SET raw_event_id = ? WHERE id = ? AND raw_event_id IS NULL
  `);

  const insertCanon = db.prepare(`
    INSERT INTO canonical_activity_events (
      raw_event_id, order_code, actor_name, action_type, from_status, to_status,
      event_timestamp, storage_tier, is_system_actor, created_at,
      order_id, order_match_status, is_administrative, field_name, old_value, new_value, details_json,
      data_source, import_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let repaired = 0;
  let alreadyMatched = 0;
  let errors = 0;

  db.exec('BEGIN TRANSACTION;');
  try {
    for (const r of uncanonicalRows) {
      const parsed = parseLogActionDetails(r.raw_action_text || '', r.actor_name || '', r.order_code || '');
      const detailsJson = JSON.stringify(parsed);

      const exists: any = checkCanon.get(r.id, r.order_code, r.actor_name, parsed.actionType, r.event_timestamp);
      if (exists) {
        alreadyMatched++;
        if (exists.raw_event_id === null || exists.raw_event_id === undefined) {
          updateCanonRawId.run(r.id, exists.id);
          repaired++;
        }
        continue;
      }

      const isSystem = (
        (r.actor_name || '').toLowerCase().includes('system') ||
        (r.actor_name || '').includes('النظام')
      ) ? 1 : 0;

      let matchedOrderId: number | null = null;
      let matchStatus = 'UNRESOLVED';
      if (!r.order_code) {
        matchStatus = 'GENERAL_LOG';
      } else {
        const foundId = orderMap.get((r.order_code || '').trim());
        if (foundId) {
          matchedOrderId = foundId;
          matchStatus = 'MATCHED';
        }
      }

      try {
        insertCanon.run(
          r.id,
          r.order_code,
          r.actor_name || 'النظام',
          parsed.actionType,
          parsed.fromStatus,
          parsed.toStatus,
          r.event_timestamp,
          r.storage_tier || 'HOT',
          isSystem,
          nowIso,
          matchedOrderId,
          matchStatus,
          parsed.isAdministrative ? 1 : 0,
          parsed.fieldName,
          parsed.oldValue,
          parsed.newValue,
          detailsJson,
          r.data_source || 'REPAIR_SERVICE',
          r.import_id || null
        );
        repaired++;
      } catch (err: any) {
        errors++;
      }
    }
    db.exec('COMMIT;');
  } catch (txErr) {
    try { db.exec('ROLLBACK;'); } catch {}
    throw txErr;
  }

  return { examined: uncanonicalRows.length, repaired, alreadyMatched, errors };
}
