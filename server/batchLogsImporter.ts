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

// Comprehensive aliases for column matching
const HEADER_ALIASES = {
  orderCode: [
    'كود الطلب', 'رقم الطلب', 'كود الاوردر', 'رقم الاوردر', 'كود', 'الطلب', 'الاوردر',
    'رقم البوليصة', 'البوليصة', 'رقم الشحنة', 'كود الشحنة',
    'order_code', 'order_no', 'random_number', 'order_id_code', 'order', 'code', 'ordercode',
  ],
  actorName: [
    'اسم الموظف', 'الموظف', 'المنفذ', 'بواسطة', 'المستخدم', 'اسم المستخدم',
    'القائم بالحركة', 'المسؤول', 'المسئول', 'منفذ الحركة',
    'actor_name', 'actor', 'employee', 'user_name', 'user', 'staff', 'created_by', 'actorname',
  ],
  rawActionText: [
    'نص الحركة', 'تفاصيل الحركة', 'نص الحدث', 'تفاصيل الحدث', 'الإجراء', 'الاجراء',
    'الحدث', 'الحركة', 'التفاصيل', 'الوصف', 'بيان الحركة', 'نوع الحركة', 'العملية', 'نص العملية',
    'action_text', 'raw_action_text', 'action', 'details', 'description', 'activity', 'event', 'operation',
  ],
  eventTimestamp: [
    'تاريخ ووقت الحركة', 'تاريخ ووقت', 'تاريخ و وقت الحركة', 'تاريخ و وقت', 'تاريخ و الوقت',
    'التاريخ والوقت', 'التاريخ و الوقت', 'تاريخ الحركة', 'وقت الحركة', 'تاريخ الحدث', 'وقت الحدث',
    'تاريخ الإجراء', 'تاريخ الاجراء', 'تاريخ العملية', 'وقت العملية', 'تاريخ الاضافة', 'تاريخ الإضافة',
    'تاريخ التسجيل', 'وقت التسجيل', 'تاريخ الإنشاء', 'تاريخ الانشاء', 'وقت الإنشاء',
    'التاريخ', 'الوقت', 'تاريخ', 'وقت',
    'timestamp', 'event_timestamp', 'action_timestamp', 'created_at', 'date', 'time',
    'datetime', 'date_time', 'logged_at', 'action_date', 'action_time', 'operation_date',
    'date & time', 'date time', 'event_time',
  ],
  vendoorOrderId: [
    'معرف الطلب', 'معرف الاوردر', 'معرف النظام', 'معرف الحركة',
    'vendoor_order_id', 'order_id', 'id', 'system_id', 'orderid',
  ],
};

function normalizeArabicText(str: string): string {
  return (str || '')
    .toString()
    .trim()
    .replace(/[\uFEFF\u200B\u00A0]/g, '') // Strip BOM and zero-width spaces
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[\u064B-\u065F]/g, '') // Strip tashkeel
    .toLowerCase()
    .replace(/[\s_\-\/\\]+/g, '_');
}

function findMatchingField(headers: string[], aliases: string[]): string | null {
  // Pass 1: Exact normalized match
  for (const h of headers) {
    const normH = normalizeArabicText(h);
    if (!normH) continue;
    for (const a of aliases) {
      const normA = normalizeArabicText(a);
      if (normH === normA) return h;
    }
  }

  // Pass 2: Word boundary or prefix match
  for (const h of headers) {
    const normH = normalizeArabicText(h);
    if (!normH) continue;
    for (const a of aliases) {
      const normA = normalizeArabicText(a);
      if (normA.length >= 3 && (normH.includes(normA) || normA.includes(normH))) {
        return h;
      }
    }
  }

  return null;
}

function toAsciiDigits(str: string): string {
  return str.replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

/**
 * Normalizes different date representations:
 * - Native JavaScript Date instances
 * - Numeric Excel date codes (e.g. 45579.5 or '45579.5') via direct epoch calculation
 * - Arabic-Indic numbers (١٤/١٠/٢٠٢٦)
 * - 12-hour AM/PM formats in Arabic (م / ص / مساءً / صباحاً) and English (PM / AM)
 * - DD/MM/YYYY and MM/DD/YYYY disambiguation
 * - ISO formats: YYYY-MM-DD HH:mm:ss
 * Output: standard Africa/Cairo datetime string: YYYY-MM-DD HH:mm:ss and YYYY-MM-DD
 */
export function normalizeDateStringToCairo(val: any): { timestampStr: string | null; dateStr: string | null } {
  if (val === null || val === undefined || val === '') {
    return { timestampStr: null, dateStr: null };
  }

  // 1. JavaScript Date instance (e.g. from XLSX cellDates: true)
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return { timestampStr: null, dateStr: null };
    const cairoDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Cairo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(val);
    const cairoTime = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Cairo',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(val);
    return {
      timestampStr: `${cairoDate} ${cairoTime}`,
      dateStr: cairoDate,
    };
  }

  // 2. Excel numeric serial date (e.g. 45579.5 or string number '45579.5')
  if (typeof val === 'number' || (typeof val === 'string' && /^\d{4,6}(?:\.\d+)?$/.test(val.trim()))) {
    const num = typeof val === 'number' ? val : parseFloat(val);
    // Excel date range: 25000 (~1968) to 80000 (~2119)
    if (!isNaN(num) && num >= 25000 && num <= 80000) {
      const ms = Math.round((num - 25569) * 86400 * 1000);
      const d = new Date(ms);
      if (!isNaN(d.getTime())) {
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
    }
  }

  // 3. String date
  if (typeof val === 'string') {
    let s = toAsciiDigits(val.trim());
    if (!s) return { timestampStr: null, dateStr: null };

    // Check for AM / PM in English or Arabic
    let isPM = false;
    let isAM = false;
    if (/[\s,]*(?:pm|مساءً|م)\b/i.test(s) || /[\s,]+م$/i.test(s)) {
      isPM = true;
    } else if (/[\s,]*(?:am|صباحاً|ص)\b/i.test(s) || /[\s,]+ص$/i.test(s)) {
      isAM = true;
    }

    const cleanTime = s.replace(/(?:pm|am|مساءً|صباحاً|م|ص)/gi, '').trim();

    // Standard YYYY-MM-DD or YYYY/MM/DD
    const isoMatch = cleanTime.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
    if (isoMatch) {
      const y = isoMatch[1];
      const m = String(parseInt(isoMatch[2], 10)).padStart(2, '0');
      const day = String(parseInt(isoMatch[3], 10)).padStart(2, '0');
      let h = parseInt(isoMatch[4] || '0', 10);
      const min = String(parseInt(isoMatch[5] || '0', 10)).padStart(2, '0');
      const sec = String(parseInt(isoMatch[6] || '0', 10)).padStart(2, '0');
      if (isPM && h < 12) h += 12;
      if (isAM && h === 12) h = 0;
      const hStr = String(h).padStart(2, '0');
      const dateStr = `${y}-${m}-${day}`;
      return {
        timestampStr: `${dateStr} ${hStr}:${min}:${sec}`,
        dateStr,
      };
    }

    // Localized DD/MM/YYYY or MM/DD/YYYY
    const localMatch = cleanTime.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
    if (localMatch) {
      const p1 = parseInt(localMatch[1], 10);
      const p2 = parseInt(localMatch[2], 10);
      const y = localMatch[3];
      let h = parseInt(localMatch[4] || '0', 10);
      const min = String(parseInt(localMatch[5] || '0', 10)).padStart(2, '0');
      const sec = String(parseInt(localMatch[6] || '0', 10)).padStart(2, '0');
      if (isPM && h < 12) h += 12;
      if (isAM && h === 12) h = 0;
      const hStr = String(h).padStart(2, '0');

      let day: number;
      let m: number;
      if (p1 > 12) {
        day = p1;
        m = p2;
      } else if (p2 > 12) {
        m = p1;
        day = p2;
      } else {
        // Default Egyptian / Middle Eastern standard: DD/MM/YYYY
        day = p1;
        m = p2;
      }

      const dayStr = String(day).padStart(2, '0');
      const mStr = String(m).padStart(2, '0');
      const dateStr = `${y}-${mStr}-${dayStr}`;
      return {
        timestampStr: `${dateStr} ${hStr}:${min}:${sec}`,
        dateStr,
      };
    }

    // Fallback general Date parsing
    const parsed = new Date(cleanTime);
    if (!isNaN(parsed.getTime()) && parsed.getFullYear() > 1990 && parsed.getFullYear() < 2100) {
      const cairoDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Africa/Cairo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(parsed);
      const cairoTime = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Africa/Cairo',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(parsed);
      return {
        timestampStr: `${cairoDate} ${cairoTime}`,
        dateStr: cairoDate,
      };
    }
  }

  return { timestampStr: null, dateStr: null };
}

/**
 * Dynamically detects column names by sampling row content if header aliases fail
 */
function autoDetectColumnsFromSample(
  rows: Record<string, any>[],
  headers: string[]
): {
  colOrderCode: string | null;
  colActor: string | null;
  colAction: string | null;
  colTimestamp: string | null;
  colOrderId: string | null;
} {
  const sample = rows.slice(0, 30);
  let bestDateCol: string | null = null;
  let maxDateMatches = 0;

  let bestActionCol: string | null = null;
  let maxActionMatches = 0;

  let bestOrderCol: string | null = null;
  let maxOrderMatches = 0;

  let bestActorCol: string | null = null;
  let maxActorMatches = 0;

  for (const h of headers) {
    let dateMatches = 0;
    let actionMatches = 0;
    let orderMatches = 0;
    let actorMatches = 0;

    for (const r of sample) {
      const val = r[h];
      if (val === undefined || val === null || val === '') continue;

      // 1. Date check
      const norm = normalizeDateStringToCairo(val);
      if (norm.dateStr && norm.timestampStr) {
        dateMatches++;
      }

      const strVal = String(val).trim();
      // 2. Action check: characteristic Arabic log phrases
      if (
        strVal.includes('حالة') || strVal.includes('طلب') || strVal.includes('أضاف') ||
        strVal.includes('عدل') || strVal.includes('انشاء') || strVal.includes('تم') ||
        strVal.includes('غير') || strVal.includes('شحن') || strVal.includes('طباعة') ||
        strVal.includes('إلغاء') || strVal.includes('الغاء') || strVal.includes('هاتف') ||
        strVal.includes('Pending') || strVal.includes('Printed') || strVal.includes('Processing')
      ) {
        actionMatches++;
      }

      // 3. Order code check
      if (/^(?:ORD_|\d{4,12}|[A-Za-z0-9_\-]{5,20})$/i.test(strVal)) {
        orderMatches++;
      }

      // 4. Actor check: short staff names
      if (
        strVal === 'النظام' || strVal.toLowerCase() === 'system' ||
        (strVal.length > 2 && strVal.length < 30 && !strVal.includes('حالة') && !norm.dateStr)
      ) {
        actorMatches++;
      }
    }

    if (dateMatches > maxDateMatches && dateMatches >= Math.min(2, sample.length)) {
      maxDateMatches = dateMatches;
      bestDateCol = h;
    }
    if (actionMatches > maxActionMatches && actionMatches >= Math.min(2, sample.length)) {
      maxActionMatches = actionMatches;
      bestActionCol = h;
    }
    if (orderMatches > maxOrderMatches && orderMatches >= Math.min(2, sample.length)) {
      maxOrderMatches = orderMatches;
      bestOrderCol = h;
    }
    if (actorMatches > maxActorMatches && actorMatches >= Math.min(2, sample.length)) {
      maxActorMatches = actorMatches;
      bestActorCol = h;
    }
  }

  return {
    colTimestamp: bestDateCol,
    colAction: bestActionCol,
    colOrderCode: bestOrderCol,
    colActor: bestActorCol,
    colOrderId: null,
  };
}

/**
 * Ingests one or more Excel/CSV log files covering multiple historical days.
 * - Robustly handles all Excel date formats (native Date, Excel serials, Arabic, PM/AM, DD/MM/YYYY).
 * - Identifies header row across title and metadata rows.
 * - Dynamically auto-detects column names if headers differ.
 * - Extracts and partitions rows by Cairo business date.
 * - Persists raw and canonical logs idempotently with chunked transactions.
 * - Updates unified historical coverage registry.
 * - Syncs to Supabase and verifies remote persistence when configured.
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
      // Read with cellDates: true for automatic date parsing + raw: true for numeric preserving
      workbook = XLSX.read(buffer, {
        type: 'buffer',
        cellDates: true,
        raw: true,
        codepage: 65001,
      });
    } catch (parseErr: any) {
      warnings.push(`Could not parse workbook ${fileName}: ${parseErr.message}`);
      continue;
    }

    for (const sheetName of workbook.SheetNames) {
      sheetsProcessed.push(`${fileName}::${sheetName}`);
      const worksheet = workbook.Sheets[sheetName];
      if (!worksheet) continue;

      // First check if worksheet has data
      const rawRows: Record<string, any>[] = XLSX.utils.sheet_to_json(worksheet, {
        defval: '',
        raw: true,
      });

      if (rawRows.length === 0) continue;

      // Locate header row: scan first 10 rows if row 0 does not contain valid headers
      let candidateHeaders = Object.keys(rawRows[0] || {});
      let colOrderCode = findMatchingField(candidateHeaders, HEADER_ALIASES.orderCode);
      let colActor = findMatchingField(candidateHeaders, HEADER_ALIASES.actorName);
      let colAction = findMatchingField(candidateHeaders, HEADER_ALIASES.rawActionText);
      let colTimestamp = findMatchingField(candidateHeaders, HEADER_ALIASES.eventTimestamp);
      let colOrderId = findMatchingField(candidateHeaders, HEADER_ALIASES.vendoorOrderId);

      let effectiveRows = rawRows;

      // If neither action nor timestamp header found, check if row 0 was a title or metadata row
      if (!colAction || !colTimestamp) {
        // Read as 2D array to inspect top rows for true header line
        const sheetAoa: any[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '', raw: true });
        for (let rIdx = 0; rIdx < Math.min(10, sheetAoa.length); rIdx++) {
          const rowArray = (sheetAoa[rIdx] || []).map(cell => String(cell || '').trim());
          const testAction = findMatchingField(rowArray, HEADER_ALIASES.rawActionText);
          const testTimestamp = findMatchingField(rowArray, HEADER_ALIASES.eventTimestamp);
          if (testAction || testTimestamp) {
            // Found actual header row at rIdx!
            const headerRow = rowArray;
            colAction = testAction;
            colTimestamp = testTimestamp;
            colOrderCode = findMatchingField(headerRow, HEADER_ALIASES.orderCode);
            colActor = findMatchingField(headerRow, HEADER_ALIASES.actorName);
            colOrderId = findMatchingField(headerRow, HEADER_ALIASES.vendoorOrderId);

            // Convert remaining rows into objects with these headers
            effectiveRows = [];
            for (let dataIdx = rIdx + 1; dataIdx < sheetAoa.length; dataIdx++) {
              const dataRow = sheetAoa[dataIdx];
              if (!dataRow || dataRow.length === 0) continue;
              const obj: Record<string, any> = {};
              let hasAnyData = false;
              for (let c = 0; c < headerRow.length; c++) {
                const hName = headerRow[c] || `col_${c}`;
                obj[hName] = dataRow[c] !== undefined ? dataRow[c] : '';
                if (dataRow[c] !== undefined && dataRow[c] !== '') hasAnyData = true;
              }
              if (hasAnyData) {
                effectiveRows.push(obj);
              }
            }
            break;
          }
        }
      }

      // If still missing colTimestamp or colAction, use content-based heuristic auto-detection
      if (!colTimestamp || !colAction) {
        const availableHeaders = Object.keys(effectiveRows[0] || {});
        const detected = autoDetectColumnsFromSample(effectiveRows, availableHeaders);
        if (!colTimestamp && detected.colTimestamp) colTimestamp = detected.colTimestamp;
        if (!colAction && detected.colAction) colAction = detected.colAction;
        if (!colOrderCode && detected.colOrderCode) colOrderCode = detected.colOrderCode;
        if (!colActor && detected.colActor) colActor = detected.colActor;
      }

      if (!colAction && !colTimestamp) {
        warnings.push(`Sheet ${sheetName} in ${fileName} does not contain recognizable log action or date columns; skipped.`);
        continue;
      }

      for (let idx = 0; idx < effectiveRows.length; idx++) {
        totalRowsRead++;
        const row = effectiveRows[idx];

        const rawTimestampVal = colTimestamp ? row[colTimestamp] : null;
        const normalized = normalizeDateStringToCairo(rawTimestampVal);

        if (!normalized.dateStr || !normalized.timestampStr) {
          unparseableRows++;
          if (reviewRows.length < 50) {
            reviewRows.push({
              fileName,
              sheetName,
              rowIndex: idx + 2,
              reason: 'تاريخ الحدث مفقود أو غير قابل للتحليل',
              sampleData: row,
            });
          }
          continue;
        }

        const dateStr = normalized.dateStr;
        const actionText = colAction ? String(row[colAction] || '').trim() : '';
        if (!actionText) {
          unparseableRows++;
          if (reviewRows.length < 50) {
            reviewRows.push({
              fileName,
              sheetName,
              rowIndex: idx + 2,
              reason: 'نص حركة اللوج فارغ',
              sampleData: row,
            });
          }
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

    // Attempt direct Supabase sync and verification if configured
    let remoteStatus = 'NONE';
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
    reviewRows: reviewRows.slice(0, 100),
    warnings,
  };
}
