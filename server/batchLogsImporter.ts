import crypto from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline';
import * as XLSX from 'xlsx';
import { db, getCairoDateInterval, saveCoverageRecord } from './db.ts';
import { persistLogEntries } from './historicalLogsService.ts';
import { isSupabaseConfigured, syncDayLogsToSupabase } from './supabaseClient.ts';

export interface BatchFilePayload {
  fileName: string;
  filePath?: string;
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

export type BatchImportStatus =
  | 'SUCCESS'
  | 'ALL_DUPLICATES'
  | 'PARTIAL'
  | 'NO_VALID_RECORDS'
  | 'UNRECOGNIZED_COLUMNS'
  | 'INVALID_DATES'
  | 'EMPTY_FILE'
  | 'FAILED';

export interface BatchImportResult {
  success: boolean;
  status: BatchImportStatus;
  statusMessageAr: string;
  batchId: string;
  filesProcessed: string[];
  sheetsProcessed: string[];
  totalRowsRead: number;
  validRecordsCount: number;
  totalSaved: number;
  totalDuplicates: number;
  unparseableRows: number;
  unmatchedOrdersCount: number;
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

// Aliases for header detection
export const HEADER_ALIASES = {
  orderCode: [
    'كود الطلب', 'رقم الطلب', 'كود الاوردر', 'رقم الاوردر', 'كود', 'الطلب', 'الاوردر',
    'رقم البوليصة', 'البوليصة', 'رقم الشحنة', 'كود الشحنة', 'رقم الفاتورة', 'الفاتورة',
    'كود الشحنه', 'رقم الشحنه', 'كود طلب', 'رقم طلب', 'معرف الطلب', 'معرف الاوردر',
    'الرقم العشوائي', 'رقم المرجع', 'كود المرجع',
    'order_code', 'order_no', 'random_number', 'order_id_code', 'order', 'code', 'ordercode',
    'order_number', 'order id', 'order_id', 'tracking_number', 'tracking', 'order_reference',
  ],
  actorName: [
    'اسم الموظف', 'الموظف', 'المنفذ', 'اسم المنفذ', 'المستخدم المنفذ', 'بواسطة',
    'المستخدم', 'اسم المستخدم', 'القائم بالحركة', 'المسؤول', 'المسئول', 'المسئول عن الحركة',
    'مسؤول الحركة', 'منفذ الحركة', 'منفذ العملية', 'الادمن', 'المشرف',
    'اسم المسؤول', 'اسم المسئول', 'خدمة العملاء', 'خدمه العملاء',
    'actor_name', 'actor', 'employee', 'user_name', 'user', 'staff', 'created_by', 'actorname',
    'operator', 'admin', 'username',
  ],
  rawActionText: [
    'نص الحركة', 'تفاصيل الحركة', 'نص الحدث', 'تفاصيل الحدث', 'الإجراء', 'الاجراء',
    'الحدث', 'الحركة', 'التفاصيل', 'الوصف', 'بيان الحركة', 'نوع الحركة', 'العملية', 'نص العملية',
    'بيانات الحركة', 'تفاصيل العملية', 'بيان', 'البيان', 'النشاط', 'نوع النشاط', 'نص النشاط',
    'ملاحظات', 'تفاصيل الإجراء', 'تفاصيل الاجراء', 'شرح الحركة', 'بيان الإجراء', 'الحالة', 'تغيير الحالة',
    'action_text', 'raw_action_text', 'action', 'details', 'description', 'activity', 'event', 'operation',
    'text', 'statement', 'log', 'message', 'action_name', 'action_type', 'action_details', 'notes', 'status_change',
    'action_description', 'log_action',
  ],
  eventTimestamp: [
    'تاريخ ووقت الحركة', 'تاريخ ووقت', 'تاريخ و وقت الحركة', 'تاريخ و وقت', 'تاريخ و الوقت',
    'التاريخ والوقت', 'التاريخ و الوقت', 'تاريخ الحركة', 'وقت الحركة', 'تاريخ الحدث', 'وقت الحدث',
    'تاريخ الإجراء', 'تاريخ الاجراء', 'تاريخ العملية', 'وقت العملية', 'تاريخ الاضافة', 'تاريخ الإضافة',
    'تاريخ التسجيل', 'وقت التسجيل', 'تاريخ الإنشاء', 'تاريخ الانشاء', 'وقت الإنشاء',
    'تاريخ التحديث', 'وقت التحديث', 'تاريخ ووقت التحديث', 'تاريخ التعديل', 'وقت التعديل',
    'وقت وتاريخ', 'وقت و تاريخ', 'الوقت والتاريخ', 'تاريخ الطلب', 'تاريخ الاوردر',
    'timestamp', 'event_timestamp', 'action_timestamp', 'created_at',
    'datetime', 'date_time', 'logged_at', 'action_date_time', 'date & time', 'date time', 'event_time',
    'date_and_time', 'date/time', 'date_time_cairo',
  ],
  dateOnly: [
    'التاريخ', 'تاريخ', 'تاريخ اليوم', 'اليوم', 'تاريخ العملية', 'تاريخ الحركة', 'تاريخ الإنشاء',
    'تاريخ الطلب', 'تاريخ الاوردر',
    'date', 'action_date', 'event_date', 'day', 'creation_date', 'order_date',
  ],
  timeOnly: [
    'الوقت', 'وقت', 'الساعة', 'توقيت', 'وقت الحركة', 'وقت العملية', 'وقت الإنشاء', 'وقت التسجيل',
    'time', 'action_time', 'event_time', 'hour',
  ],
  vendoorOrderId: [
    'معرف الطلب', 'معرف الاوردر', 'معرف النظام', 'معرف الحركة', 'id', 'معرف',
    'vendoor_order_id', 'order_id', 'system_id', 'orderid',
  ],
};

export function normalizeArabicHeader(str: string): string {
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

export function findMatchingField(headers: string[], aliases: string[]): string | null {
  if (!headers || headers.length === 0) return null;

  // Pass 1: Exact normalized match
  for (const h of headers) {
    const normH = normalizeArabicHeader(h);
    if (!normH) continue;
    for (const a of aliases) {
      const normA = normalizeArabicHeader(a);
      if (normH === normA) return h;
    }
  }

  // Pass 2: Word boundary or prefix/suffix match (minimum 3 chars)
  for (const h of headers) {
    const normH = normalizeArabicHeader(h);
    if (!normH) continue;
    for (const a of aliases) {
      const normA = normalizeArabicHeader(a);
      if (normA.length >= 3 && (normH === normA || normH.startsWith(normA + '_') || normH.endsWith('_' + normA))) {
        return h;
      }
    }
  }

  // Pass 3: Header contains multi-word alias (minimum 4 chars)
  for (const h of headers) {
    const normH = normalizeArabicHeader(h);
    if (!normH) continue;
    for (const a of aliases) {
      const normA = normalizeArabicHeader(a);
      if (normA.length >= 4 && normH.includes(normA)) {
        return h;
      }
    }
  }

  return null;
}

export function toAsciiDigits(str: string): string {
  return (str || '').replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

/**
 * Converts a numeric day fraction or seconds from midnight to HH:mm:ss string.
 */
export function formatNumericTime(timeVal: number): string {
  const totalSeconds = Math.round((timeVal < 1 ? timeVal * 86400 : timeVal) % 86400);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Fully RFC 4180 compliant CSV parser supporting:
 * - Arbitrary delimiters (comma, semicolon, tab)
 * - Quotes ("") with embedded delimiters, newlines, and escaped quotes ("" or \")
 * - BOM stripping
 * - Accurate field boundary extraction
 */
export function parseRFC4180Csv(text: string, delimiter: string = ','): string[][] {
  const clean = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;
  const len = clean.length;

  for (let i = 0; i < len; i++) {
    const ch = clean[i];

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < len && clean[i + 1] === '"') {
          currentField += '"';
          i++; // CSV doubled quote ""
        } else {
          inQuotes = false;
        }
      } else if (ch === '\\' && i + 1 < len && clean[i + 1] === '"') {
        currentField += '"';
        i++; // C-style escaped quote \"
      } else {
        currentField += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        currentRow.push(currentField.trim());
        currentField = '';
      } else if (ch === '\r') {
        if (i + 1 < len && clean[i + 1] === '\n') {
          i++;
        }
        currentRow.push(currentField.trim());
        currentField = '';
        if (currentRow.some(c => c !== '')) {
          rows.push(currentRow);
        }
        currentRow = [];
      } else if (ch === '\n') {
        currentRow.push(currentField.trim());
        currentField = '';
        if (currentRow.some(c => c !== '')) {
          rows.push(currentRow);
        }
        currentRow = [];
      } else {
        currentField += ch;
      }
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    if (currentRow.some(c => c !== '')) {
      rows.push(currentRow);
    }
  }

  return rows;
}

/**
 * Detects CSV delimiter automatically from raw text sample.
 */
export function detectCsvDelimiter(sampleText: string): string {
  const lines = sampleText.split(/\r?\n/).slice(0, 20);
  let commas = 0;
  let semicolons = 0;
  let tabs = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (!inQuotes) {
        if (ch === ',') commas++;
        else if (ch === ';') semicolons++;
        else if (ch === '\t') tabs++;
      }
    }
  }

  if (semicolons > commas && semicolons >= tabs && semicolons > 0) return ';';
  if (tabs > commas && tabs > semicolons && tabs > 0) return '\t';
  return ',';
}

/**
 * Normalizes different date representations into standard Africa/Cairo datetime string:
 * - Excel numeric serial date via XLSX.SSF.parse_date_code
 * - Condition 2: Checks if numeric date already has fractional time part. If so, DOES NOT add time twice!
 *   If integer date, combines with separate numeric or string timeVal.
 * - JavaScript Date objects
 * - Arabic-Indic numbers (١٤/١٠/٢٠٢٦)
 * - 12-hour AM/PM formats in Arabic (م / ص / مساءً / صباحاً) and English (PM / AM)
 * - DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD, YYYY/MM/DD, DD-MM-YYYY
 */
export function normalizeDateStringToCairo(val: any, timeVal?: any): { timestampStr: string | null; dateStr: string | null } {
  if (val === null || val === undefined || val === '') {
    return { timestampStr: null, dateStr: null };
  }

  // 1. Excel numeric serial date (number or numeric string between 25000 and 80000)
  if (typeof val === 'number' || (typeof val === 'string' && /^\d{4,6}(?:\.\d+)?$/.test(val.trim()))) {
    let num = typeof val === 'number' ? val : parseFloat(val);
    if (!isNaN(num) && num >= 25000 && num <= 80000) {
      // Condition 2: Check if num already includes fractional time part
      const frac = num % 1;
      const hasFractionalTime = frac > 0.00005 && frac < 0.99995;

      if (!hasFractionalTime && timeVal !== undefined && timeVal !== null && timeVal !== '') {
        // Separate time provided: add it without duplicating
        if (typeof timeVal === 'number' || /^\d+(?:\.\d+)?$/.test(String(timeVal).trim())) {
          const tNum = typeof timeVal === 'number' ? timeVal : parseFloat(timeVal);
          if (!isNaN(tNum)) {
            if (tNum < 1) {
              num += tNum; // day fraction
            } else if (tNum <= 86400) {
              num += tNum / 86400; // seconds from midnight
            }
          }
        } else if (typeof timeVal === 'string') {
          // Time string like "14:30:22" or "02:30 م"
          const asciiTime = toAsciiDigits(timeVal.trim());
          const timeMatch = asciiTime.match(/(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\s*(ص|م|am|pm|صباحاً|مساءً)?/i);
          if (timeMatch) {
            let h = parseInt(timeMatch[1], 10);
            const m = parseInt(timeMatch[2], 10);
            const s = parseInt(timeMatch[3] || '0', 10);
            const ampm = (timeMatch[4] || '').toLowerCase();
            if ((ampm === 'م' || ampm === 'pm' || ampm === 'مساءً') && h < 12) h += 12;
            if ((ampm === 'ص' || ampm === 'am' || ampm === 'صباحاً') && h === 12) h = 0;
            num += (h * 3600 + m * 60 + s) / 86400;
          }
        }
      }

      try {
        const parsedCode = (XLSX.SSF || (XLSX as any).default?.SSF)?.parse_date_code?.(num) || (XLSX as any).parse_date_code?.(num);
        if (parsedCode && parsedCode.y >= 1990 && parsedCode.y <= 2100) {
          const yStr = String(parsedCode.y);
          const mStr = String(parsedCode.m).padStart(2, '0');
          const dStr = String(parsedCode.d).padStart(2, '0');
          const hStr = String(parsedCode.H || 0).padStart(2, '0');
          const minStr = String(parsedCode.M || 0).padStart(2, '0');
          const sStr = String(Math.floor(parsedCode.S || 0)).padStart(2, '0');

          const dateStr = `${yStr}-${mStr}-${dStr}`;
          const timestampStr = `${dateStr} ${hStr}:${minStr}:${sStr}`;
          return { timestampStr, dateStr };
        }
      } catch {}
    }
  }

  // 2. JavaScript Date instance
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return { timestampStr: null, dateStr: null };
    const yStr = String(val.getUTCFullYear());
    const mStr = String(val.getUTCMonth() + 1).padStart(2, '0');
    const dStr = String(val.getUTCDate()).padStart(2, '0');
    let hStr = String(val.getUTCHours()).padStart(2, '0');
    let minStr = String(val.getUTCMinutes()).padStart(2, '0');
    let sStr = String(val.getUTCSeconds()).padStart(2, '0');

    // If time is 00:00:00 and separate timeVal is provided
    if (hStr === '00' && minStr === '00' && sStr === '00' && timeVal) {
      const asciiTime = toAsciiDigits(String(timeVal).trim());
      const timeMatch = asciiTime.match(/(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\s*(ص|م|am|pm|صباحاً|مساءً)?/i);
      if (timeMatch) {
        let h = parseInt(timeMatch[1], 10);
        const m = parseInt(timeMatch[2], 10);
        const s = parseInt(timeMatch[3] || '0', 10);
        const ampm = (timeMatch[4] || '').toLowerCase();
        if ((ampm === 'م' || ampm === 'pm' || ampm === 'مساءً') && h < 12) h += 12;
        if ((ampm === 'ص' || ampm === 'am' || ampm === 'صباحاً') && h === 12) h = 0;
        hStr = String(h).padStart(2, '0');
        minStr = String(m).padStart(2, '0');
        sStr = String(s).padStart(2, '0');
      }
    }

    const dateStr = `${yStr}-${mStr}-${dStr}`;
    const timestampStr = `${dateStr} ${hStr}:${minStr}:${sStr}`;
    return { timestampStr, dateStr };
  }

  // 3. String date handling
  let rawDateVal = String(val).trim();
  if (!rawDateVal) return { timestampStr: null, dateStr: null };

  // If timeVal is provided and date string does not contain time
  if (timeVal !== undefined && timeVal !== null && String(timeVal).trim() !== '') {
    const hasColonInDate = rawDateVal.includes(':');
    if (!hasColonInDate) {
      let timeStr = String(timeVal).trim();
      if (typeof timeVal === 'number' || /^\d+(?:\.\d+)?$/.test(timeStr)) {
        const tNum = typeof timeVal === 'number' ? timeVal : parseFloat(timeStr);
        if (!isNaN(tNum) && (tNum < 1 || tNum <= 86400)) {
          timeStr = formatNumericTime(tNum);
        }
      }
      rawDateVal = `${rawDateVal} ${timeStr}`;
    }
  }

  let s = toAsciiDigits(rawDateVal);
  if (!s) return { timestampStr: null, dateStr: null };

  let isPM = false;
  let isAM = false;
  if (/[\s,]*(?:pm|مساءً|مساء|م)\b/i.test(s) || /[\s,]+م$/i.test(s)) {
    isPM = true;
  } else if (/[\s,]*(?:am|صباحاً|صباحا|صباح|ص)\b/i.test(s) || /[\s,]+ص$/i.test(s)) {
    isAM = true;
  }

  const cleanTime = s.replace(/(?:pm|am|مساءً|مساء|صباحاً|صباحا|صباح|م|ص)/gi, '').trim();

  // Format A: ISO: YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = cleanTime.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
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

  // Format B: Localized DD/MM/YYYY or MM/DD/YYYY or DD-MM-YYYY
  const localMatch = cleanTime.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
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
      // Standard Middle East / Egyptian format is DD/MM/YYYY
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

  // Fallback: general Date.parse
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

  return { timestampStr: null, dateStr: null };
}

/**
 * Heuristically detects columns by inspecting actual cell content if header aliases fail
 */
export function autoDetectColumnsFromSample(
  rows: Record<string, any>[],
  headers: string[]
): {
  colOrderCode: string | null;
  colActor: string | null;
  colAction: string | null;
  colTimestamp: string | null;
  colDate: string | null;
  colTime: string | null;
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
      // 2. Action text characteristics
      if (
        strVal.includes('حالة') || strVal.includes('طلب') || strVal.includes('أضاف') ||
        strVal.includes('عدل') || strVal.includes('انشاء') || strVal.includes('تم') ||
        strVal.includes('غير') || strVal.includes('شحن') || strVal.includes('طباعة') ||
        strVal.includes('إلغاء') || strVal.includes('الغاء') || strVal.includes('هاتف') ||
        strVal.includes('Pending') || strVal.includes('Printed') || strVal.includes('Processing') ||
        strVal.includes('Canceled') || strVal.includes('New')
      ) {
        actionMatches++;
      }

      // 3. Order code patterns (VND_123, ORD_123, 8-12 digits, alphanumeric codes)
      if (/^(?:VND_|ORD_|\d{4,12}|[A-Za-z0-9_\-]{5,20})$/i.test(strVal)) {
        orderMatches++;
      }

      // 4. Actor name
      if (
        strVal === 'النظام' || strVal.toLowerCase() === 'system' ||
        (strVal.length >= 2 && strVal.length < 35 && !strVal.includes('حالة') && !norm.dateStr)
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
    colDate: null,
    colTime: null,
    colOrderId: null,
  };
}

export interface ProgressCallback {
  (progress: {
    stage: 'UPLOADING' | 'PARSING' | 'EXTRACTING_DATES' | 'SAVING_RECORDS' | 'COMPLETED' | 'FAILED';
    stageLabelAr: string;
    rowsRead: number;
    rowsTotal: number;
    datesDiscovered: number;
    savedCount: number;
    duplicatesCount: number;
    unparseableRows: number;
  }): void;
}

/**
 * High-performance, streaming-capable ingestion for large Excel & CSV log files.
 * - Deep header discovery scanning top 15 rows.
 * - Robust column aliasing with separate date and time column support.
 * - Precision date parsing via XLSX.SSF (no timezone shifting past midnight).
 * - Honest status reporting: guarantees success=false if 0 records saved and 0 duplicates found.
 * - Idempotent, deduplicated chunked persistence in local SQLite & Supabase.
 */
export async function importBatchLogFiles(
  files: BatchFilePayload[],
  batchIdPrefix = 'batch',
  onProgress?: ProgressCallback
): Promise<BatchImportResult> {
  const batchId = `${batchIdPrefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const filesProcessed: string[] = [];
  const sheetsProcessed: string[] = [];
  const warnings: string[] = [];
  const reviewRows: BatchImportResult['reviewRows'] = [];

  let totalRowsRead = 0;
  let unparseableRows = 0;
  let validRecordsCount = 0;
  let totalSaved = 0;
  let totalDuplicates = 0;
  let unmatchedOrdersCount = 0;
  let totalValidSheets = 0;

  // Cairo date (YYYY-MM-DD) -> Array of log items
  const dateGroups = new Map<string, Array<{
    orderCode: string | null;
    actorName: string;
    rawActionText: string;
    eventTimestamp: string;
    vendoorOrderId?: number | null;
    rawHtml?: string | null;
  }>>();

  const dateSourceFiles = new Map<string, Set<string>>();

  for (const f of files) {
    const fileName = f.fileName || 'unknown.xlsx';
    filesProcessed.push(fileName);

    const isCsvFile = fileName.toLowerCase().endsWith('.csv') || (f.filePath && f.filePath.toLowerCase().endsWith('.csv'));
    const sheetsToProcess: Array<{ sheetName: string; sheetAoa: any[][] }> = [];

    if (isCsvFile) {
      // Robust RFC 4180 CSV parsing
      let csvText = '';
      if (f.filePath && fs.existsSync(f.filePath)) {
        try {
          csvText = fs.readFileSync(f.filePath, 'utf-8');
        } catch (e: any) {
          warnings.push(`Could not read CSV file ${fileName}: ${e.message}`);
        }
      } else if (f.content) {
        csvText = f.content;
      } else if (f.buffer && Buffer.isBuffer(f.buffer)) {
        csvText = f.buffer.toString('utf-8');
      } else if (f.base64) {
        try {
          csvText = Buffer.from(f.base64, 'base64').toString('utf-8');
        } catch (e: any) {
          warnings.push(`Could not decode Base64 CSV ${fileName}: ${e.message}`);
        }
      }

      if (!csvText || csvText.trim().length === 0) {
        warnings.push(`File ${fileName} was empty.`);
        continue;
      }

      const delimiter = detectCsvDelimiter(csvText.slice(0, 4096));
      const parsedAoa = parseRFC4180Csv(csvText, delimiter);
      sheetsToProcess.push({ sheetName: fileName, sheetAoa: parsedAoa });
    } else {
      // Excel workbook parsing
      let workbook: XLSX.WorkBook | null = null;
      if (f.filePath && fs.existsSync(f.filePath)) {
        try {
          workbook = XLSX.readFile(f.filePath, {
            cellDates: false,
            raw: true,
            codepage: 65001,
          } as any);
        } catch (fileErr: any) {
          warnings.push(`Could not read file ${fileName} from path: ${fileErr.message}`);
        }
      }

      if (!workbook) {
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

        try {
          workbook = XLSX.read(buffer, {
            type: 'buffer',
            cellDates: false,
            raw: true,
            codepage: 65001,
          } as any);
        } catch (parseErr: any) {
          warnings.push(`Could not parse workbook ${fileName}: ${parseErr.message}`);
          continue;
        }
      }

      if (!workbook || !workbook.SheetNames || workbook.SheetNames.length === 0) {
        warnings.push(`Workbook ${fileName} has no sheets.`);
        continue;
      }

      for (const sName of workbook.SheetNames) {
        const worksheet = workbook.Sheets[sName];
        if (!worksheet) continue;
        const sheetAoa: any[][] = XLSX.utils.sheet_to_json(worksheet, {
          header: 1,
          defval: '',
          raw: true,
        });
        sheetsToProcess.push({ sheetName: sName, sheetAoa });
      }
    }

    for (const { sheetName, sheetAoa } of sheetsToProcess) {
      sheetsProcessed.push(`${fileName}::${sheetName}`);

      if (!sheetAoa || sheetAoa.length === 0) {
        warnings.push(`Sheet "${sheetName}" in "${fileName}" is completely empty.`);
        continue;
      }

      // 1. Locate the true header row across the first 35 rows
      let headerRowIndex = -1;
      let colOrderCode: string | null = null;
      let colActor: string | null = null;
      let colAction: string | null = null;
      let colTimestamp: string | null = null;
      let colDate: string | null = null;
      let colTime: string | null = null;
      let colOrderId: string | null = null;
      let headerRowArray: string[] = [];

      for (let rIdx = 0; rIdx < Math.min(35, sheetAoa.length); rIdx++) {
        const rowArray = (sheetAoa[rIdx] || []).map(cell => String(cell || '').trim());
        const testAction = findMatchingField(rowArray, HEADER_ALIASES.rawActionText);
        const testTimestamp = findMatchingField(rowArray, HEADER_ALIASES.eventTimestamp);
        const testDate = findMatchingField(rowArray, HEADER_ALIASES.dateOnly);

        // Header row identified if it has an action column AND (a timestamp column OR a date column)
        if (testAction && (testTimestamp || testDate)) {
          headerRowIndex = rIdx;
          headerRowArray = rowArray;
          colAction = testAction;
          colTimestamp = testTimestamp;
          colDate = testDate;
          colTime = findMatchingField(rowArray, HEADER_ALIASES.timeOnly);
          colOrderCode = findMatchingField(rowArray, HEADER_ALIASES.orderCode);
          colActor = findMatchingField(rowArray, HEADER_ALIASES.actorName);
          colOrderId = findMatchingField(rowArray, HEADER_ALIASES.vendoorOrderId);
          break;
        }
      }

      // Fallback: heuristic auto-detection from row objects if header aliases not met in top 35
      if (headerRowIndex === -1 && sheetAoa.length > 1) {
        const candidateHeaders = (sheetAoa[0] || []).map((c, i) => String(c || '').trim() || `col_${i}`);
        const sampleRows: Record<string, any>[] = [];
        for (let r = 1; r < Math.min(30, sheetAoa.length); r++) {
          const rowObj: Record<string, any> = {};
          for (let c = 0; c < candidateHeaders.length; c++) {
            rowObj[candidateHeaders[c]] = sheetAoa[r]?.[c] ?? '';
          }
          sampleRows.push(rowObj);
        }

        const detected = autoDetectColumnsFromSample(sampleRows, candidateHeaders);
        if (detected.colAction && (detected.colTimestamp || detected.colDate)) {
          headerRowIndex = 0;
          headerRowArray = candidateHeaders;
          colAction = detected.colAction;
          colTimestamp = detected.colTimestamp;
          colDate = detected.colDate;
          colTime = detected.colTime;
          colOrderCode = detected.colOrderCode;
          colActor = detected.colActor;
          colOrderId = detected.colOrderId;
        }
      }

      // Condition 3: If this sheet does not contain required columns (e.g. Summary / Cover Sheet),
      // skip it gracefully without failing the entire multi-sheet workbook!
      if (!colAction || (!colTimestamp && !colDate) || headerRowIndex === -1) {
        warnings.push(`تم تخطي ورقة "${sheetName}" في "${fileName}" (ورقة ملخص أو لا تحتوي على بنية أعمدة اللوجز المطلوبة: نص الحركة والتاريخ).`);
        continue;
      }

      totalValidSheets++;

      // Pre-resolve column indices for direct, high-speed array access without allocating row objects
      const actionColIdx = colAction ? headerRowArray.indexOf(colAction) : -1;
      const timestampColIdx = colTimestamp ? headerRowArray.indexOf(colTimestamp) : -1;
      const dateColIdx = colDate ? headerRowArray.indexOf(colDate) : -1;
      const timeColIdx = colTime ? headerRowArray.indexOf(colTime) : -1;
      const orderCodeColIdx = colOrderCode ? headerRowArray.indexOf(colOrderCode) : -1;
      const actorColIdx = colActor ? headerRowArray.indexOf(colActor) : -1;
      const orderIdColIdx = colOrderId ? headerRowArray.indexOf(colOrderId) : -1;

      // Process data rows starting immediately after the discovered header row
      const dataStartIdx = headerRowIndex + 1;
      for (let rIdx = dataStartIdx; rIdx < sheetAoa.length; rIdx++) {
        const row = sheetAoa[rIdx];
        if (!row || row.length === 0) continue;

        const actionRaw = actionColIdx >= 0 ? row[actionColIdx] : '';
        const actionText = actionRaw !== undefined && actionRaw !== null ? String(actionRaw).trim() : '';
        const rawTimestampVal = timestampColIdx >= 0 ? row[timestampColIdx] : null;
        const rawDateVal = dateColIdx >= 0 ? row[dateColIdx] : null;
        const rawTimeVal = timeColIdx >= 0 ? row[timeColIdx] : null;

        // Skip completely blank rows or intermediate subheaders between months without logging as unparseable
        if (!actionText && (rawTimestampVal === null || rawTimestampVal === undefined || rawTimestampVal === '') &&
            (rawDateVal === null || rawDateVal === undefined || rawDateVal === '')) {
          continue;
        }

        totalRowsRead++;

        const normalized = normalizeDateStringToCairo(
          rawTimestampVal !== undefined && rawTimestampVal !== null && rawTimestampVal !== ''
            ? rawTimestampVal
            : rawDateVal,
          rawTimeVal
        );

        if (!normalized.dateStr || !normalized.timestampStr) {
          unparseableRows++;
          if (reviewRows.length < 50) {
            reviewRows.push({
              fileName,
              sheetName,
              rowIndex: rIdx + 1,
              reason: 'تاريخ ووقت الحركة غير صالح أو مفقود في السطر',
              sampleData: {
                rowIndex: rIdx + 1,
                date: rawDateVal,
                time: rawTimeVal,
                timestamp: rawTimestampVal,
                action: actionText,
              },
            });
          }
          continue;
        }

        if (!actionText) {
          unparseableRows++;
          if (reviewRows.length < 50) {
            reviewRows.push({
              fileName,
              sheetName,
              rowIndex: rIdx + 1,
              reason: 'نص حركة اللوج فارغ',
              sampleData: {
                rowIndex: rIdx + 1,
                date: rawDateVal,
                timestamp: rawTimestampVal,
              },
            });
          }
          continue;
        }

        validRecordsCount++;
        const dateStr = normalized.dateStr;
        const rawActor = actorColIdx >= 0 ? row[actorColIdx] : null;
        const actorName = rawActor ? String(rawActor).trim() : 'النظام';
        const rawOrderCode = orderCodeColIdx >= 0 ? row[orderCodeColIdx] : null;
        const orderCode = rawOrderCode ? String(rawOrderCode).trim() : null;
        const rawOrderId = orderIdColIdx >= 0 ? parseInt(String(row[orderIdColIdx]), 10) : null;
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

        // Progress notification every 2,500 rows
        if (onProgress && totalRowsRead % 2500 === 0) {
          onProgress({
            stage: 'PARSING',
            stageLabelAr: `جاري قراءة وتحليل الحركات (${totalRowsRead.toLocaleString()} حركة)...`,
            rowsRead: totalRowsRead,
            rowsTotal: totalRowsRead,
            datesDiscovered: dateGroups.size,
            savedCount: totalSaved,
            duplicatesCount: totalDuplicates,
            unparseableRows,
          });
        }
      }
    }
  }

  // Condition 3 & 6: Evaluate outcomes honestly
  if (totalValidSheets === 0) {
    return {
      success: false,
      status: 'UNRECOGNIZED_COLUMNS',
      statusMessageAr: 'لم يتم العثور على أي ورقة عمل تحتوي على أعمدة اللوجز المطلوبة (نص الحركة وعمود التاريخ/الوقت)',
      batchId,
      filesProcessed,
      sheetsProcessed,
      totalRowsRead: 0,
      validRecordsCount: 0,
      totalSaved: 0,
      totalDuplicates: 0,
      unparseableRows: 0,
      unmatchedOrdersCount: 0,
      discoveredDates: [],
      reviewRows: [],
      warnings,
    };
  }

  if (totalRowsRead > 0 && validRecordsCount === 0) {
    return {
      success: false,
      status: 'INVALID_DATES',
      statusMessageAr: 'تمت قراءة الصفوف لكن جميع التواريخ غير قابلة للتحليل',
      batchId,
      filesProcessed,
      sheetsProcessed,
      totalRowsRead,
      validRecordsCount: 0,
      totalSaved: 0,
      totalDuplicates: 0,
      unparseableRows,
      unmatchedOrdersCount: 0,
      discoveredDates: [],
      reviewRows: reviewRows.slice(0, 50),
      warnings,
    };
  }

  if (totalRowsRead === 0) {
    return {
      success: false,
      status: 'EMPTY_FILE',
      statusMessageAr: 'الملفات المرفوعة فارغة أو لا تحتوي على صفوف بيانات صالحة',
      batchId,
      filesProcessed,
      sheetsProcessed,
      totalRowsRead: 0,
      validRecordsCount: 0,
      totalSaved: 0,
      totalDuplicates: 0,
      unparseableRows: 0,
      unmatchedOrdersCount: 0,
      discoveredDates: [],
      reviewRows: [],
      warnings,
    };
  }

  // Ingest grouped records by date into SQLite
  const discoveredDates: DiscoveredDaySummary[] = [];
  const sortedDates = Array.from(dateGroups.keys()).sort();

  for (let dIdx = 0; dIdx < sortedDates.length; dIdx++) {
    const dateStr = sortedDates[dIdx];
    const entries = dateGroups.get(dateStr)!;
    const interval = getCairoDateInterval(dateStr);
    const filesList = Array.from(dateSourceFiles.get(dateStr) || []);
    const isCsv = filesList.some(f => f.toLowerCase().endsWith('.csv'));
    const dataSource = isCsv ? 'CSV_IMPORT' : 'EXCEL_IMPORT';

    if (onProgress) {
      onProgress({
        stage: 'SAVING_RECORDS',
        stageLabelAr: `جاري حفظ حركات يوم ${dateStr} (${dIdx + 1}/${sortedDates.length})...`,
        rowsRead: totalRowsRead,
        rowsTotal: totalRowsRead,
        datesDiscovered: dateGroups.size,
        savedCount: totalSaved,
        duplicatesCount: totalDuplicates,
        unparseableRows,
      });
    }

    const persistResult = persistLogEntries(entries, interval, {
      dataSource,
      batchId,
      strictInterval: true,
    });

    totalSaved += persistResult.saved;
    totalDuplicates += persistResult.duplicates;

    // Check unmatched count in this date
    const unmatchedForDay = (db.prepare(`
      SELECT COUNT(*) as c FROM canonical_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ? AND order_match_status = 'UNRESOLVED'
    `).get(interval.startCairo, interval.endCairo) as any)?.c || 0;
    unmatchedOrdersCount += unmatchedForDay;

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

    // Update historical coverage registry
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

    // Remote Supabase verification if configured
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

  // Determine final status
  let finalStatus: BatchImportStatus = 'SUCCESS';
  let statusMessageAr = '';

  if (totalSaved > 0 && unparseableRows === 0) {
    finalStatus = 'SUCCESS';
    statusMessageAr = `تم استيراد ${totalSaved} حركة جديدة بنجاح عبر ${discoveredDates.length} يوماً.`;
  } else if (totalSaved > 0 && unparseableRows > 0) {
    finalStatus = 'PARTIAL';
    statusMessageAr = `تم استيراد ${totalSaved} حركة جديدة جزئياً مع استبعاد ${unparseableRows} صفاً غير قابل للتحليل.`;
  } else if (totalSaved === 0 && totalDuplicates > 0) {
    finalStatus = 'ALL_DUPLICATES';
    statusMessageAr = `جميع الحركات في الملف (${totalDuplicates} حركة) مسجلة ومحفوظة مسبقاً في قاعدة البيانات.`;
  } else {
    finalStatus = 'NO_VALID_RECORDS';
    statusMessageAr = 'لم يتم حفظ أي حركات جديدة ولم توجد حركات مكررة صالحة في الملف.';
  }

  const isOverallSuccess = (finalStatus === 'SUCCESS' || finalStatus === 'ALL_DUPLICATES' || (finalStatus === 'PARTIAL' && totalSaved > 0));

  return {
    success: isOverallSuccess,
    status: finalStatus,
    statusMessageAr,
    batchId,
    filesProcessed,
    sheetsProcessed,
    totalRowsRead,
    validRecordsCount,
    totalSaved,
    totalDuplicates,
    unparseableRows,
    unmatchedOrdersCount,
    discoveredDates,
    reviewRows: reviewRows.slice(0, 50),
    warnings,
  };
}
