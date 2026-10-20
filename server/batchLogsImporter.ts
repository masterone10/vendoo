import crypto from 'node:crypto';
import * as XLSX from 'xlsx';
import { db, getCairoDateInterval, saveCoverageRecord } from './db.ts';
import { persistLogEntries } from './historicalLogsService.ts';
import { isSupabaseConfigured, syncDayLogsToSupabase } from './supabaseClient.ts';

export interface BatchFilePayload {
  fileName: string;
  buffer?: Buffer;
  base64?: string;
  content?: string;
}

export interface DiscoveredDaySummary {
  date: string;
  rowsCount: number;
  savedCount: number;
  duplicatesCount: number;
  canonicalCount: number;
  coverageStatus: string;
  dataSource: string;
  remoteArchiveStatus: string;
}

export interface BatchImportResult {
  success: boolean;
  batchId: string;
  filesProcessed: string[];
  sheetsProcessed: string[];
  totalRowsRead: number;
  totalSaved: number;
  totalDuplicates: number;
  unparseableRows: number;
  discoveredDates: DiscoveredDaySummary[];
  reviewRows: Array<{
    fileName: string;
    sheetName: string;
    rowIndex: number;
    reason: string;
    sampleData: Record<string, any>;
  }>;
  warnings: string[];
}

// Column header aliases for automatic discovery
const HEADER_ALIASES = {
  orderCode: [
    'كود الطلب', 'رقم الطلب', 'كود الاوردر', 'رقم الاوردر', 'كود', 'الطلب', 'الاوردر',
    'order_code', 'order_no', 'random_number', 'order_id_code', 'order', 'code',
  ],
  actorName: [
    'اسم الموظف', 'الموظف', 'المنفذ', 'بواسطة', 'المستخدم', 'اسم المستخدم',
    'actor_name', 'actor', 'employee', 'user_name', 'user', 'staff', 'created_by',
  ],
  rawActionText: [
    'نص الحركة', 'الإجراء', 'الحدث', 'الحركة', 'التفاصيل', 'الوصف', 'تفاصيل الحركة',
    'action_text', 'raw_action_text', 'action', 'details', 'description', 'activity',
  ],
  eventTimestamp: [
    'وقت الحدث', 'التاريخ والوقت', 'تاريخ الحركة', 'تاريخ ووقت', 'التاريخ', 'الوقت',
    'timestamp', 'event_timestamp', 'created_at', 'date', 'time', 'datetime', 'logged_at',
  ],
  vendoorOrderId: [
    'معرف الطلب', 'معرف الاوردر', 'vendoor_order_id', 'order_id', 'id', 'system_id',
  ],
};

function normalizeHeader(h: string): string {
  return (h || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[\s_\-]+/g, '_');
}

function findMatchingField(headers: string[], aliases: string[]): string | null {
  for (const a of aliases) {
    const normA = normalizeHeader(a);
    for (const h of headers) {
      const normH = normalizeHeader(h);
      if (normH === normA || normH.includes(normA) || normA.includes(normH)) {
        return h;
      }
    }
  }
  return null;
}

/**
 * Normalizes different date representations (Excel serial date, ISO, localized strings)
 * into a standard Africa/Cairo datetime string: YYYY-MM-DD HH:mm:ss
 */
export function normalizeDateStringToCairo(val: any): { timestampStr: string | null; dateStr: string | null } {
  if (val === null || val === undefined || val === '') {
    return { timestampStr: null, dateStr: null };
  }

  let d: Date | null = null;

  // 1. JavaScript Date instance
  if (val instanceof Date) {
    d = isNaN(val.getTime()) ? null : val;
  }
  // 2. Excel numeric serial date (e.g. 45579.5)
  else if (typeof val === 'number') {
    try {
      const parsed = XLSX.SSF.parse_date_code(val);
      if (parsed) {
        const y = parsed.y;
        const m = String(parsed.m).padStart(2, '0');
        const day = String(parsed.d).padStart(2, '0');
        const h = String(parsed.H || 0).padStart(2, '0');
        const min = String(parsed.M || 0).padStart(2, '0');
        const s = String(Math.floor(parsed.S || 0)).padStart(2, '0');
        const dateStr = `${y}-${m}-${day}`;
        return {
          timestampStr: `${dateStr} ${h}:${min}:${s}`,
          dateStr,
        };
      }
    } catch {}
  }
  // 3. String date
  else if (typeof val === 'string') {
    const s = val.trim();
    if (!s) return { timestampStr: null, dateStr: null };

    // Standard YYYY-MM-DD format
    const isoMatch = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
    if (isoMatch) {
      const y = isoMatch[1];
      const m = String(parseInt(isoMatch[2], 10)).padStart(2, '0');
      const day = String(parseInt(isoMatch[3], 10)).padStart(2, '0');
      const h = String(parseInt(isoMatch[4] || '0', 10)).padStart(2, '0');
      const min = String(parseInt(isoMatch[5] || '0', 10)).padStart(2, '0');
      const sec = String(parseInt(isoMatch[6] || '0', 10)).padStart(2, '0');
      const dateStr = `${y}-${m}-${day}`;
      return {
        timestampStr: `${dateStr} ${h}:${min}:${sec}`,
        dateStr,
      };
    }

    // Localized DD/MM/YYYY or DD-MM-YYYY format
    const dmMatch = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
    if (dmMatch) {
      const day = String(parseInt(dmMatch[1], 10)).padStart(2, '0');
      const m = String(parseInt(dmMatch[2], 10)).padStart(2, '0');
      const y = dmMatch[3];
      const h = String(parseInt(dmMatch[4] || '0', 10)).padStart(2, '0');
      const min = String(parseInt(dmMatch[5] || '0', 10)).padStart(2, '0');
      const sec = String(parseInt(dmMatch[6] || '0', 10)).padStart(2, '0');
      const dateStr = `${y}-${m}-${day}`;
      return {
        timestampStr: `${dateStr} ${h}:${min}:${sec}`,
        dateStr,
      };
    }

    // General Date parsing fallback
    const parsed = new Date(s);
    if (!isNaN(parsed.getTime())) {
      d = parsed;
    }
  }

  if (d) {
    const cairoDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Cairo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);

    const cairoTime = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Cairo',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(d);

    return {
      timestampStr: `${cairoDate} ${cairoTime}`,
      dateStr: cairoDate,
    };
  }

  return { timestampStr: null, dateStr: null };
}

/**
 * Ingests one or more Excel/CSV log files covering multiple historical days.
 * - Extracts and partitions rows by Cairo business date.
 * - Persists raw and canonical logs idempotently.
 * - Updates the unified historical coverage day registry.
 * - Syncs to Supabase and verifies remote persistence when connected.
 */
export async function importBatchLogFiles(
  files: BatchFilePayload[],
  batchIdPrefix = 'batch'
): Promise<BatchImportResult> {
  const batchId = `${batchIdPrefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const filesProcessed: string[] = [];
  const sheetsProcessed: string[] = [];
  const warnings: string[] = [];
  const reviewRows: BatchImportResult['reviewRows'] = [];

  let totalRowsRead = 0;
  let unparseableRows = 0;

  // Date -> Entries mapping
  const dateGroups = new Map<string, Array<{
    orderCode: string | null;
    actorName: string;
    rawActionText: string;
    eventTimestamp: string;
    vendoorOrderId?: number | null;
    rawHtml?: string | null;
  }>>();

  // Source files for each date
  const dateSourceFiles = new Map<string, Set<string>>();

  for (const f of files) {
    const fileName = f.fileName || 'unknown.xlsx';
    filesProcessed.push(fileName);

    let buffer: Buffer | null = null;
    if (f.buffer && Buffer.isBuffer(f.buffer)) {
      buffer = f.buffer;
    } else if (f.base64) {
      buffer = Buffer.from(f.base64, 'base64');
    } else if (f.content) {
      buffer = Buffer.from(f.content, 'utf-8');
    }

    if (!buffer || buffer.length === 0) {
      warnings.push(`File ${fileName} was empty or could not be buffered.`);
      continue;
    }

    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(buffer, { type: 'buffer', raw: true, codepage: 65001 });
    } catch (parseErr: any) {
      warnings.push(`Could not parse workbook ${fileName}: ${parseErr.message}`);
      continue;
    }

    for (const sheetName of workbook.SheetNames) {
      sheetsProcessed.push(`${fileName}::${sheetName}`);
      const worksheet = workbook.Sheets[sheetName];
      if (!worksheet) continue;

      const rawRows: Record<string, any>[] = XLSX.utils.sheet_to_json(worksheet, {
        defval: '',
        raw: true,
      });

      if (rawRows.length === 0) continue;

      // Detect column headers
      const sampleHeaders = Object.keys(rawRows[0] || {});
      const colOrderCode = findMatchingField(sampleHeaders, HEADER_ALIASES.orderCode);
      const colActor = findMatchingField(sampleHeaders, HEADER_ALIASES.actorName);
      const colAction = findMatchingField(sampleHeaders, HEADER_ALIASES.rawActionText);
      const colTimestamp = findMatchingField(sampleHeaders, HEADER_ALIASES.eventTimestamp);
      const colOrderId = findMatchingField(sampleHeaders, HEADER_ALIASES.vendoorOrderId);

      if (!colAction && !colTimestamp) {
        warnings.push(`Sheet ${sheetName} in ${fileName} does not appear to contain log actions or timestamps; skipped.`);
        continue;
      }

      for (let idx = 0; idx < rawRows.length; idx++) {
        totalRowsRead++;
        const row = rawRows[idx];

        const rawTimestampVal = colTimestamp ? row[colTimestamp] : null;
        const normalized = normalizeDateStringToCairo(rawTimestampVal);

        if (!normalized.dateStr || !normalized.timestampStr) {
          unparseableRows++;
          reviewRows.push({
            fileName,
            sheetName,
            rowIndex: idx + 2,
            reason: 'تاريخ الحدث مفقود أو غير قابل للتحليل',
            sampleData: row,
          });
          continue;
        }

        const dateStr = normalized.dateStr;
        const actionText = colAction ? String(row[colAction] || '').trim() : '';
        if (!actionText) {
          unparseableRows++;
          reviewRows.push({
            fileName,
            sheetName,
            rowIndex: idx + 2,
            reason: 'نص حركة اللوج فارغ',
            sampleData: row,
          });
          continue;
        }

        const actorName = colActor && row[colActor] ? String(row[colActor]).trim() : 'النظام';
        const orderCode = colOrderCode && row[colOrderCode] ? String(row[colOrderCode]).trim() : null;
        const rawOrderId = colOrderId && row[colOrderId] ? parseInt(String(row[colOrderId]), 10) : null;
        const vendoorOrderId = isNaN(rawOrderId as any) ? null : rawOrderId;

        if (!dateGroups.has(dateStr)) {
          dateGroups.set(dateStr, []);
          dateSourceFiles.set(dateStr, new Set());
        }

        dateGroups.get(dateStr)!.push({
          orderCode,
          actorName,
          rawActionText: actionText,
          eventTimestamp: normalized.timestampStr,
          vendoorOrderId,
        });

        dateSourceFiles.get(dateStr)!.add(fileName);
      }
    }
  }

  // Ingest grouped records by date into SQLite & Supabase
  let totalSaved = 0;
  let totalDuplicates = 0;
  const discoveredDates: DiscoveredDaySummary[] = [];

  for (const [dateStr, entries] of dateGroups.entries()) {
    const interval = getCairoDateInterval(dateStr);
    const filesList = Array.from(dateSourceFiles.get(dateStr) || []);
    const isCsv = filesList.some(f => f.toLowerCase().endsWith('.csv'));
    const dataSource = isCsv ? 'CSV_IMPORT' : 'EXCEL_IMPORT';

    // Persist logs with explicit dataSource and batchId
    const persistResult = persistLogEntries(entries, interval, {
      dataSource,
      batchId,
      strictInterval: true,
    });

    totalSaved += persistResult.saved;
    totalDuplicates += persistResult.duplicates;

    // Count total canonical records for this day
    const canonicalCount = (db.prepare(`
      SELECT COUNT(*) as c FROM canonical_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ?
    `).get(interval.startCairo, interval.endCairo) as any)?.c || 0;

    const rawRecordsCount = (db.prepare(`
      SELECT COUNT(*) as c FROM raw_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ?
    `).get(interval.startCairo, interval.endCairo) as any)?.c || 0;

    const nowIso = new Date().toISOString();
    const filesString = filesList.join(', ');

    // Update the Day Registry (historical_coverage)
    // Rule: External imported files are registered historical data with UNVERIFIED_SOURCE
    // (Available for reports, but preserves distinction that source completeness is unverified).
    saveCoverageRecord({
      accountId: 'primary',
      sourceDomain: 'logs',
      periodDate: dateStr,
      storageTier: 'HOT',
      pagesDiscovered: 1,
      pagesRead: 1,
      recordsExtracted: entries.length,
      recordsSaved: rawRecordsCount,
      completionStatus: 'UNVERIFIED_SOURCE',
      timezone: 'Africa/Cairo',
      dataSource,
      canonicalEventsCount: canonicalCount,
      duplicatesCount: persistResult.duplicates,
      reviewRowsCount: 0,
      batchId,
      localStorageStatus: 'LOCAL_SAVED',
      remoteArchiveStatus: isSupabaseConfigured() ? 'PENDING_REMOTE' : 'NONE',
      lastAttemptedAt: nowIso,
      completedAt: nowIso,
      lastImportAt: nowIso,
      sourceFileNames: filesString,
      notes: `Batch import: ${entries.length} rows processed from [${filesString}]`,
    });

    // Attempt direct / asynchronous Supabase sync and verification if configured
    let remoteStatus = 'PENDING_REMOTE';
    if (isSupabaseConfigured()) {
      try {
        const syncRes = await syncDayLogsToSupabase(dateStr);
        if (syncRes.verified) {
          remoteStatus = 'REMOTE_VERIFIED';
        } else if (syncRes.success) {
          remoteStatus = 'REMOTE_SYNCED';
        } else {
          remoteStatus = 'REMOTE_FAILED';
        }
      } catch {
        remoteStatus = 'REMOTE_FAILED';
      }
    } else {
      remoteStatus = 'NONE';
    }

    discoveredDates.push({
      date: dateStr,
      rowsCount: entries.length,
      savedCount: persistResult.saved,
      duplicatesCount: persistResult.duplicates,
      canonicalCount,
      coverageStatus: 'UNVERIFIED_SOURCE',
      dataSource,
      remoteArchiveStatus: remoteStatus,
    });
  }

  // Sort discovered dates chronologically
  discoveredDates.sort((a, b) => a.date.localeCompare(b.date));

  return {
    success: true,
    batchId,
    filesProcessed,
    sheetsProcessed,
    totalRowsRead,
    totalSaved,
    totalDuplicates,
    unparseableRows,
    discoveredDates,
    reviewRows: reviewRows.slice(0, 100), // Limit returned review sample
    warnings,
  };
}
