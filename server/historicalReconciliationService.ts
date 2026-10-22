import { db, getCairoDateInterval, saveCoverageRecord, getCoverageRecord, type HistoricalCoverageRecord } from './db.ts';
import { isSupabaseConfigured, pgQuery, fetchDayLogsFromSupabase, restoreMissingOrdersFromSupabase } from './supabaseClient.ts';
import { repairRawWithoutCanonical, fetchAndPersistLogsForPeriod } from './historicalLogsService.ts';
import { backfillOrderLinksForEvents } from './db.ts';
import { vendoorClient } from './vendoorClient.ts';

export interface SourceMetricCounts {
  rawCount: number;
  canonicalCount: number;
  uniqueOrdersCount: number;
  uniqueEventsCount: number;
  rawWithoutCanonicalCount: number;
  unlinkedOrdersCount: number;
}

export interface SupabaseMetricCounts {
  isConfigured: boolean;
  isConnected: boolean;
  rawCount: number;
  canonicalCount: number;
  coverageStatus: string;
  error?: string | null;
}

export interface ReconciliationReport {
  startDate: string;
  endDate: string;
  isSingleDay: boolean;
  sqlite: SourceMetricCounts;
  supabase: SupabaseMetricCounts;
  delta: {
    rawDifference: number; // positive means Supabase has more, negative means SQLite has more
    canonicalDifference: number;
    restoredFromRemote: number;
    convertedFromRaw: number;
    duplicatesIgnored: number;
    failedWrites: number;
    unlinkedCount: number;
  };
  parityStatus: 'VERIFIED_PARITY' | 'LOCAL_AHEAD' | 'REMOTE_AHEAD' | 'RECONCILED' | 'EMPTY_VERIFIED' | 'PARTIAL' | 'ERROR';
  primarySource: 'SQLITE_LOCAL' | 'SUPABASE_ARCHIVE' | 'VENDOOR_FETCH' | 'MIXED' | 'NONE';
  coverageStatus: 'COMPLETE' | 'PARTIAL' | 'EMPTY_VERIFIED' | 'NOT_SYNCED' | 'FAILED';
  summaryMessageAr: string;
  diagnosticNotes: string[];
}

export interface ReconcileOptions {
  autoRepair?: boolean;              // Auto-restore missing from Supabase & auto-convert raw->canonical (default: true)
  fetchFromVendoorIfMissing?: boolean; // If both SQLite and Supabase are missing data, attempt Vendoor fetch (default: false)
  onProgress?: (stage: string, message: string, progress: number, total: number) => void;
}

/**
 * Reconciles historical logs between SQLite and Supabase for a given date range.
 * Fully timezone-aware (Africa/Cairo), key-based, idempotent, and non-destructive.
 */
export async function reconcileHistoricalRange(
  startDateStr: string,
  endDateStr: string,
  options: ReconcileOptions = {}
): Promise<ReconciliationReport> {
  const autoRepair = options.autoRepair !== false;
  const fetchFromVendoor = Boolean(options.fetchFromVendoorIfMissing);

  const cleanStart = startDateStr.trim().slice(0, 10);
  const cleanEnd = endDateStr.trim().slice(0, 10);
  const isSingleDay = cleanStart === cleanEnd;

  const startInt = getCairoDateInterval(cleanStart);
  const endInt = getCairoDateInterval(cleanEnd);
  const startTime = startInt.startCairo;
  const endTime = endInt.endCairo;

  const diagnosticNotes: string[] = [];

  // 1. Gather local SQLite metrics
  const sqliteRawCount = (db.prepare(`
    SELECT COUNT(*) as c FROM raw_activity_events
    WHERE event_timestamp >= ? AND event_timestamp < ?
  `).get(startTime, endTime) as any)?.c || 0;

  const sqliteCanonCount = (db.prepare(`
    SELECT COUNT(*) as c FROM canonical_activity_events
    WHERE event_timestamp >= ? AND event_timestamp < ?
  `).get(startTime, endTime) as any)?.c || 0;

  const rawWithoutCanonCount = (db.prepare(`
    SELECT COUNT(*) as c FROM raw_activity_events r
    WHERE r.event_timestamp >= ? AND r.event_timestamp < ?
      AND NOT EXISTS (SELECT 1 FROM canonical_activity_events c WHERE c.raw_event_id = r.id)
  `).get(startTime, endTime) as any)?.c || 0;

  const unlinkedOrdersCount = (db.prepare(`
    SELECT COUNT(*) as c FROM canonical_activity_events c
    WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
      AND (c.order_id IS NULL OR c.order_match_status = 'UNRESOLVED')
      AND c.order_code IS NOT NULL AND c.order_code != ''
  `).get(startTime, endTime) as any)?.c || 0;

  const uniqueOrdersCount = (db.prepare(`
    SELECT COUNT(DISTINCT order_code) as c FROM canonical_activity_events
    WHERE event_timestamp >= ? AND event_timestamp < ? AND order_code IS NOT NULL AND order_code != ''
  `).get(startTime, endTime) as any)?.c || 0;

  const uniqueEventsCount = sqliteRawCount;

  const sqliteMetrics: SourceMetricCounts = {
    rawCount: sqliteRawCount,
    canonicalCount: sqliteCanonCount,
    uniqueOrdersCount,
    uniqueEventsCount,
    rawWithoutCanonicalCount: rawWithoutCanonCount,
    unlinkedOrdersCount,
  };

  // 2. Gather remote Supabase metrics
  const supaMetrics: SupabaseMetricCounts = {
    isConfigured: isSupabaseConfigured(),
    isConnected: false,
    rawCount: 0,
    canonicalCount: 0,
    coverageStatus: 'UNKNOWN',
    error: null,
  };

  if (supaMetrics.isConfigured) {
    try {
      options.onProgress?.('CHECKING_SUPABASE', 'فحص السجلات في Supabase عبر التوقيت الرسمي...', 0, 1);

      const startTz = `${cleanStart} 00:00:00+03`;
      const endTz = `${endInt.nextDateStr} 00:00:00+03`;

      // Query raw count in Supabase strictly in Africa/Cairo business timezone using timestamptz index
      const rawRes = await pgQuery<{ count: string }>(`
        SELECT COUNT(*) as count
        FROM raw_activity_events
        WHERE event_timestamp >= $1::timestamptz AND event_timestamp < $2::timestamptz
      `, [startTz, endTz]);
      supaMetrics.rawCount = parseInt(rawRes.rows[0]?.count || '0', 10);

      // Query canonical count in Supabase using timestamptz index
      const canonRes = await pgQuery<{ count: string }>(`
        SELECT COUNT(*) as count
        FROM canonical_activity_events
        WHERE event_timestamp >= $1::timestamptz AND event_timestamp < $2::timestamptz
      `, [startTz, endTz]);
      supaMetrics.canonicalCount = parseInt(canonRes.rows[0]?.count || '0', 10);

      // Query historical_coverage in Supabase
      const covRes = await pgQuery<{ completion_status: string }>(`
        SELECT completion_status
        FROM historical_coverage
        WHERE period_date >= $1 AND period_date <= $2
        ORDER BY id DESC LIMIT 1
      `, [cleanStart, cleanEnd]);
      supaMetrics.coverageStatus = covRes.rows[0]?.completion_status || 'NOT_RECORDED';

      supaMetrics.isConnected = true;
    } catch (supaErr: any) {
      supaMetrics.error = supaErr.message;
      diagnosticNotes.push(`تعذر الاتصال بـ Supabase: ${supaErr.message}`);
    }
  } else {
    diagnosticNotes.push('أرشيف Supabase غير مهيأ (يعمل النظام في الوضع المحلي SQLite)');
  }

  let restoredFromRemote = 0;
  let convertedFromRaw = 0;
  let duplicatesIgnored = 0;
  let failedWrites = 0;

  // 3. Auto-Repair / Sync when gaps are detected
  if (autoRepair) {
    // Case B & Case C: If Supabase has raw records that SQLite is missing, stream them into SQLite!
    if (supaMetrics.isConnected && supaMetrics.rawCount > sqliteMetrics.rawCount) {
      options.onProgress?.('RESTORING_FROM_SUPABASE', `جاري استرجاع السجلات الناقصة من Supabase (${supaMetrics.rawCount - sqliteMetrics.rawCount} سجل)...`, 0, 1);

      // Iterate day by day between cleanStart and cleanEnd
      const curDate = new Date(`${cleanStart}T00:00:00Z`);
      const targetEndDate = new Date(`${cleanEnd}T00:00:00Z`);

      while (curDate <= targetEndDate) {
        const dStr = curDate.toISOString().slice(0, 10);
        const restoreRes = await fetchDayLogsFromSupabase(dStr, {
          onProgress: (restored, total) => {
            options.onProgress?.('RESTORING_BATCH', `استرجاع لوجز ${dStr}: ${restored}/${total}`, restored, total);
          },
        });
        if (restoreRes.success) {
          restoredFromRemote += restoreRes.rawRestored;
          convertedFromRaw += restoreRes.canonicalRestored;
          duplicatesIgnored += restoreRes.duplicates;
          failedWrites += restoreRes.failedWrites;
        } else if (restoreRes.error) {
          diagnosticNotes.push(`فشل استرجاع ${dStr} من Supabase: ${restoreRes.error}`);
        }
        curDate.setUTCDate(curDate.getUTCDate() + 1);
      }
    }

    // Convert any raw records that lack a canonical representation in SQLite
    const rawToConvertCheck = (db.prepare(`
      SELECT COUNT(*) as c FROM raw_activity_events r
      WHERE r.event_timestamp >= ? AND r.event_timestamp < ?
        AND NOT EXISTS (SELECT 1 FROM canonical_activity_events c WHERE c.raw_event_id = r.id)
    `).get(startTime, endTime) as any)?.c || 0;

    if (rawToConvertCheck > 0) {
      options.onProgress?.('CONVERTING_CANONICAL', `تحويل اللوجز الخام إلى معيارية (${rawToConvertCheck} حركة)...`, 0, rawToConvertCheck);
      const repairRes = repairRawWithoutCanonical(isSingleDay ? cleanStart : undefined);
      convertedFromRaw += repairRes.repaired;
      diagnosticNotes.push(`تم تحويل ${repairRes.repaired} سجل خام إلى معياري محلياً`);
    }

    // Resolve unlinked orders against SQLite orders table & backfill missing orders from Supabase
    if (sqliteMetrics.unlinkedOrdersCount > 0) {
      const unlinkedCodes = (db.prepare(`
        SELECT DISTINCT order_code FROM canonical_activity_events
        WHERE event_timestamp >= ? AND event_timestamp < ?
          AND (order_id IS NULL OR order_match_status = 'UNRESOLVED')
          AND order_code IS NOT NULL AND order_code != ''
      `).all(startTime, endTime) as any[]).map(r => r.order_code);

      if (unlinkedCodes.length > 0 && isSupabaseConfigured()) {
        options.onProgress?.('RESTORING_ORDERS', `استرجاع تفاصيل الطلبات غير المربوطة من Supabase (${unlinkedCodes.length} طلب)...`, 0, unlinkedCodes.length);
        const restoredOrdersRes = await restoreMissingOrdersFromSupabase(unlinkedCodes);
        if (restoredOrdersRes.restored > 0) {
          diagnosticNotes.push(`تم استرجاع ${restoredOrdersRes.restored} طلب من أرشيف Supabase وتوثيقها محلياً`);
        }
      }
      backfillOrderLinksForEvents();
    }

    // Case D: Completely missing in both SQLite and Supabase -> fetch from Vendoor if requested
    const totalLocalNow = (db.prepare(`
      SELECT COUNT(*) as c FROM raw_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ?
    `).get(startTime, endTime) as any)?.c || 0;

    if (totalLocalNow === 0 && (!supaMetrics.isConnected || supaMetrics.rawCount === 0) && fetchFromVendoor) {
      if (vendoorClient.isConfigured()) {
        options.onProgress?.('FETCHING_VENDOOR', `جاري استكمال البيانات الناقصة من Vendoor للفترة ${cleanStart} إلى ${cleanEnd}...`, 0, 1);
        const fetchRes = await fetchAndPersistLogsForPeriod(cleanStart, cleanEnd);
        if (fetchRes.success) {
          diagnosticNotes.push(`تم جلب ${fetchRes.totalSaved} حركة من Vendoor عبر ${fetchRes.days.reduce((acc, d) => acc + d.pagesFetched, 0)} صفحة`);
        } else {
          diagnosticNotes.push(`تعذر استكمال البيانات من Vendoor: ${fetchRes.errorMessage || 'خطأ غير معروف'}`);
        }
      } else {
        diagnosticNotes.push('بيانات اعتماد Vendoor غير مهيأة للاستكمال الحي');
      }
    }
  }

  // 4. Re-calculate metrics after repair pass
  const finalSqliteRaw = (db.prepare(`
    SELECT COUNT(*) as c FROM raw_activity_events
    WHERE event_timestamp >= ? AND event_timestamp < ?
  `).get(startTime, endTime) as any)?.c || 0;

  const finalSqliteCanon = (db.prepare(`
    SELECT COUNT(*) as c FROM canonical_activity_events
    WHERE event_timestamp >= ? AND event_timestamp < ?
  `).get(startTime, endTime) as any)?.c || 0;

  const finalRawWithoutCanon = (db.prepare(`
    SELECT COUNT(*) as c FROM raw_activity_events r
    WHERE r.event_timestamp >= ? AND r.event_timestamp < ?
      AND NOT EXISTS (SELECT 1 FROM canonical_activity_events c WHERE c.raw_event_id = r.id)
  `).get(startTime, endTime) as any)?.c || 0;

  const finalUnlinked = (db.prepare(`
    SELECT COUNT(*) as c FROM canonical_activity_events c
    WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
      AND (c.order_id IS NULL OR c.order_match_status = 'UNRESOLVED')
      AND c.order_code IS NOT NULL AND c.order_code != ''
  `).get(startTime, endTime) as any)?.c || 0;

  const finalUniqueOrders = (db.prepare(`
    SELECT COUNT(DISTINCT order_code) as c FROM canonical_activity_events
    WHERE event_timestamp >= ? AND event_timestamp < ? AND order_code IS NOT NULL AND order_code != ''
  `).get(startTime, endTime) as any)?.c || 0;

  const finalSqliteMetrics: SourceMetricCounts = {
    rawCount: finalSqliteRaw,
    canonicalCount: finalSqliteCanon,
    uniqueOrdersCount: finalUniqueOrders,
    uniqueEventsCount: finalSqliteRaw,
    rawWithoutCanonicalCount: finalRawWithoutCanon,
    unlinkedOrdersCount: finalUnlinked,
  };

  // Determine parity status and primary data source
  let parityStatus: ReconciliationReport['parityStatus'] = 'VERIFIED_PARITY';
  let primarySource: ReconciliationReport['primarySource'] = 'SQLITE_LOCAL';
  let coverageStatus: ReconciliationReport['coverageStatus'] = 'COMPLETE';

  if (!supaMetrics.isConnected) {
    parityStatus = finalSqliteRaw > 0 ? 'LOCAL_ONLY' as any : 'EMPTY_VERIFIED';
    primarySource = 'SQLITE_LOCAL';
  } else if (finalSqliteRaw === 0 && supaMetrics.rawCount === 0) {
    parityStatus = 'EMPTY_VERIFIED';
    coverageStatus = 'EMPTY_VERIFIED';
    primarySource = 'NONE';
  } else if (finalSqliteRaw === supaMetrics.rawCount) {
    parityStatus = 'VERIFIED_PARITY';
    primarySource = restoredFromRemote > 0 ? 'SUPABASE_ARCHIVE' : 'SQLITE_LOCAL';
    coverageStatus = 'COMPLETE';
  } else if (finalSqliteRaw > supaMetrics.rawCount) {
    parityStatus = 'LOCAL_AHEAD';
    primarySource = 'SQLITE_LOCAL';
    coverageStatus = 'COMPLETE';
  } else {
    // Supabase still has more records than SQLite
    parityStatus = 'REMOTE_AHEAD';
    primarySource = 'SUPABASE_ARCHIVE';
    coverageStatus = 'PARTIAL';
  }

  if (restoredFromRemote > 0 || convertedFromRaw > 0) {
    if (parityStatus === 'VERIFIED_PARITY') {
      parityStatus = 'RECONCILED';
    }
  }

  // Generate clear user-facing Arabic summary
  let summaryMessageAr = '';
  if (parityStatus === 'VERIFIED_PARITY' || parityStatus === 'RECONCILED') {
    summaryMessageAr = `البيانات متطابقة تماماً بين المصدرين (${finalSqliteRaw} حركة خام، ${finalSqliteCanon} حركة معيارية، ${finalUniqueOrders} طلب مميز).`;
  } else if (parityStatus === 'EMPTY_VERIFIED') {
    summaryMessageAr = 'تم التحقق من خلو اليوم من أي حركات مسجلة في المصدرين (0 حركات).';
  } else if (parityStatus === 'LOCAL_AHEAD') {
    summaryMessageAr = `القاعدة المحلية تحتوي على سجلات إضافية (${finalSqliteRaw} محلي مقابل ${supaMetrics.rawCount} سحابي). سيتم ترحيل الفائض تلقائياً.`;
  } else if (parityStatus === 'REMOTE_AHEAD') {
    summaryMessageAr = `يحتوي أرشيف Supabase على سجلات أكثر (${supaMetrics.rawCount} سحابي مقابل ${finalSqliteRaw} محلي). يمكن إكمال المزامنة.`;
  } else {
    summaryMessageAr = `تم فحص ومطابقة الفترة: ${finalSqliteRaw} سجل محلي، ${finalSqliteCanon} سجل معياري.`;
  }

  return {
    startDate: cleanStart,
    endDate: cleanEnd,
    isSingleDay,
    sqlite: finalSqliteMetrics,
    supabase: supaMetrics,
    delta: {
      rawDifference: supaMetrics.rawCount - finalSqliteRaw,
      canonicalDifference: supaMetrics.canonicalCount - finalSqliteCanon,
      restoredFromRemote,
      convertedFromRaw,
      duplicatesIgnored,
      failedWrites,
      unlinkedCount: finalUnlinked,
    },
    parityStatus,
    primarySource,
    coverageStatus,
    summaryMessageAr,
    diagnosticNotes,
  };
}
