import { Router, type Request, type Response } from 'express';
import { processAndDeduplicateTeamEvents } from './teamDeduplication.ts';
import {
  db,
  DB_PATH,
  getCairoDateString,
  getCairoDateInterval,
  getDailySnapshot,
  saveDailySnapshot,
  getCoverageRecord,
  isDateInHot,
} from './db.ts';
import {
  syncEngine,
  calculateAgeBucket,
  getProcessingTransitionTime,
} from './syncEngine.ts';
import {
  checkSupabaseConnection,
  applySupabaseMigration,
  getDatabaseUrl,
  isSupabaseConfigured,
  syncDayLogsToSupabase,
} from './supabaseClient.ts';
import { runSqliteToSupabaseImport } from './importSqliteToSupabase.ts';
import {
  getOrFetchHistoricalLogs,
  fetchAndPersistLogsForPeriod,
  getActiveJobStatus,
} from './historicalLogsService.ts';
import {
  ensureCoverageForRange,
  generateLogsIntelligenceReport,
  getRangeJobStatus,
  getDrilldownLogs,
} from './logsIntelligenceService.ts';
import { applyMerchantCodeMappings } from './excelMerchantCodes.ts';
import { getArchiveWorkerStatus, triggerArchivePass } from './supabaseArchiveWorker.ts';
import { importBatchLogFiles } from './batchLogsImporter.ts';
import { handleLogUploadChunk, getImportJob, getActiveOrRecentJob } from './importJobManager.ts';
import { resolveHistoricalDay } from './historicalDayResolver.ts';
import { reconcileHistoricalRange } from './historicalReconciliationService.ts';
import {
  getDashboardRiskStats,
  getRiskOrdersDrilldown,
  getRiskConditionSql,
} from './riskService.ts';

export function isCSEmployee(actorName: string): boolean {
  if (!actorName) return false;
  const trimmed = actorName.trim();
  const csRegex = /(?:^|[\s\-_/(\[])(?:CS|cs|Cs|cS)(?:$|[\s\-_/)\]])/;
  const arabicRegex = /خدمة\s*العملاء/i;
  return csRegex.test(trimmed) || arabicRegex.test(trimmed);
}

export const apiRouter = Router();

// Ensure all responses from apiRouter explicitly declare JSON content type
apiRouter.use((_req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

// 1. Health & Sync Status
apiRouter.get('/health', (_req: Request, res: Response) => {
  const syncStatus = syncEngine.getStatus();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    sync: syncStatus,
  });
});

// 2. Dashboard KPIs & Aggregations with Global Business Date
apiRouter.get('/dashboard/stats', (req: Request, res: Response) => {
  try {
    const rawDate = typeof req.query.date === 'string' && req.query.date.trim() ? req.query.date.trim().slice(0, 10) : '';
    const cairoToday = getCairoDateString();
    const targetDate = rawDate || cairoToday;
    const isToday = targetDate === cairoToday;
    const storageTier = isDateInHot(targetDate) ? 'HOT' : 'COLD';
    const coverageRecord = getCoverageRecord('orders', targetDate);
    const coverageStatus = isToday ? 'LIVE' : (coverageRecord?.completion_status || 'NOT_SYNCED');

    // 2. Target Date Activity
    const dateInterval = getCairoDateInterval(targetDate);

    // 1. Status Counts:
    // Active workflow states (New, Pending, Processing, Canceling) reflect authoritative active population.
    // Printed reflects orders confirmed/printed on targetDate (backed by Vendoor logs & transitions).
    // Canceled reflects orders canceled on targetDate strictly from Vendoor logs.
    const activeStatesRaw: any[] = isToday
      ? db.prepare(`
          SELECT current_status, COUNT(*) as count
          FROM orders
          WHERE current_status IN ('New', 'Pending', 'Processing', 'Canceling')
          GROUP BY current_status
        `).all()
      : db.prepare(`
          SELECT current_status, COUNT(*) as count
          FROM orders
          WHERE created_at_source >= ? AND created_at_source < ?
            AND current_status IN ('New', 'Pending', 'Processing', 'Canceling')
          GROUP BY current_status
        `).all(dateInterval.startCairo, dateInterval.endCairo);

    const currentCounts = {
      New: 0,
      Pending: 0,
      Processing: 0,
      Canceling: 0,
      Printed: 0,
      Canceled: 0,
    };

    for (const r of activeStatesRaw) {
      if (r.current_status in currentCounts) {
        (currentCounts as any)[r.current_status] = r.count;
      }
    }

    // Authoritative Printed Count for targetDate (distinct orders confirmed on that date)
    const printedForDateCount = (db.prepare(`
      SELECT COUNT(DISTINCT o_id) as count FROM (
        SELECT c.order_code as o_id
        FROM canonical_activity_events c
        WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
          AND (c.to_status = 'Printed' OR c.action_type = 'confirmation')
          AND c.order_code IS NOT NULL AND c.order_code != ''
        UNION
        SELECT o.random_number as o_id
        FROM orders o
        WHERE o.printed_date >= ? AND o.printed_date < ?
          AND o.current_status = 'Printed'
      )
    `).get(dateInterval.startCairo, dateInterval.endCairo, dateInterval.startCairo, dateInterval.endCairo) as any)?.count || 0;

    const printedEventsCount = (db.prepare(`
      SELECT COUNT(*) as count
      FROM canonical_activity_events c
      WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
        AND (c.to_status = 'Printed' OR c.action_type = 'confirmation')
        AND c.order_code IS NOT NULL AND c.order_code != ''
    `).get(dateInterval.startCairo, dateInterval.endCairo) as any)?.count || printedForDateCount;

    // Authoritative Canceled Count for targetDate (strictly from verified Vendoor logs)
    const canceledForDateCount = (db.prepare(`
      SELECT COUNT(DISTINCT c.order_code) as count
      FROM canonical_activity_events c
      WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
        AND (c.to_status = 'Canceled' OR c.action_type = 'order_canceled')
        AND c.order_code IS NOT NULL AND c.order_code != ''
    `).get(dateInterval.startCairo, dateInterval.endCairo) as any)?.count || 0;

    const cancelEventsCount = (db.prepare(`
      SELECT COUNT(*) as count
      FROM canonical_activity_events c
      WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
        AND (c.to_status = 'Canceled' OR c.action_type = 'order_canceled')
        AND c.order_code IS NOT NULL AND c.order_code != ''
    `).get(dateInterval.startCairo, dateInterval.endCairo) as any)?.count || canceledForDateCount;

    currentCounts.Printed = printedForDateCount;
    currentCounts.Canceled = canceledForDateCount;

    // Distinct unique orders and total events that entered Pending today from canonical logs (plus memory transitions fallback)
    const pendingStats = (db.prepare(`
      SELECT 
        COUNT(DISTINCT o_id) as unique_orders,
        COUNT(*) as total_events
      FROM (
        SELECT order_code as o_id FROM canonical_activity_events
        WHERE event_timestamp >= ? AND event_timestamp < ?
          AND to_status = 'Pending'
          AND order_code IS NOT NULL AND order_code != ''
        UNION ALL
        SELECT random_number as o_id FROM order_status_events
        WHERE observed_at >= ? AND observed_at < ?
          AND to_status = 'Pending'
          AND random_number IS NOT NULL AND random_number != ''
          AND NOT EXISTS (
            SELECT 1 FROM canonical_activity_events c
            WHERE c.order_code = order_status_events.random_number
              AND c.event_timestamp >= ? AND c.event_timestamp < ?
              AND c.to_status = 'Pending'
          )
      )
    `).get(
      dateInterval.startCairo, dateInterval.endCairo,
      dateInterval.startCairo, dateInterval.endCairo,
      dateInterval.startCairo, dateInterval.endCairo
    ) as any);
    const pendingUniqueOrders = pendingStats?.unique_orders || 0;
    const pendingTotalEvents = pendingStats?.total_events || 0;

    // Distinct unique orders and total events that entered Processing today
    const processingStats = (db.prepare(`
      SELECT 
        COUNT(DISTINCT o_id) as unique_orders,
        COUNT(*) as total_events
      FROM (
        SELECT order_code as o_id FROM canonical_activity_events
        WHERE event_timestamp >= ? AND event_timestamp < ?
          AND to_status = 'Processing'
          AND order_code IS NOT NULL AND order_code != ''
        UNION ALL
        SELECT random_number as o_id FROM order_status_events
        WHERE observed_at >= ? AND observed_at < ?
          AND to_status = 'Processing'
          AND random_number IS NOT NULL AND random_number != ''
          AND NOT EXISTS (
            SELECT 1 FROM canonical_activity_events c
            WHERE c.order_code = order_status_events.random_number
              AND c.event_timestamp >= ? AND c.event_timestamp < ?
              AND c.to_status = 'Processing'
          )
      )
    `).get(
      dateInterval.startCairo, dateInterval.endCairo,
      dateInterval.startCairo, dateInterval.endCairo,
      dateInterval.startCairo, dateInterval.endCairo
    ) as any);
    const processingUniqueOrders = processingStats?.unique_orders || 0;
    const processingTotalEvents = processingStats?.total_events || 0;

    // Distinct unique orders and total events that entered Canceling today
    const cancelingStats = (db.prepare(`
      SELECT 
        COUNT(DISTINCT o_id) as unique_orders,
        COUNT(*) as total_events
      FROM (
        SELECT order_code as o_id FROM canonical_activity_events
        WHERE event_timestamp >= ? AND event_timestamp < ?
          AND to_status = 'Canceling'
          AND order_code IS NOT NULL AND order_code != ''
        UNION ALL
        SELECT random_number as o_id FROM order_status_events
        WHERE observed_at >= ? AND observed_at < ?
          AND to_status = 'Canceling'
          AND random_number IS NOT NULL AND random_number != ''
          AND NOT EXISTS (
            SELECT 1 FROM canonical_activity_events c
            WHERE c.order_code = order_status_events.random_number
              AND c.event_timestamp >= ? AND c.event_timestamp < ?
              AND c.to_status = 'Canceling'
          )
      )
    `).get(
      dateInterval.startCairo, dateInterval.endCairo,
      dateInterval.startCairo, dateInterval.endCairo,
      dateInterval.startCairo, dateInterval.endCairo
    ) as any);
    const cancelingUniqueOrders = cancelingStats?.unique_orders || 0;
    const cancelingTotalEvents = cancelingStats?.total_events || 0;

    const createdOnDate = (db.prepare(`
      SELECT COUNT(*) as count
      FROM orders
      WHERE created_at_source >= ? AND created_at_source < ?
    `).get(dateInterval.startCairo, dateInterval.endCairo) as any)?.count || 0;

    const dayCumulative = {
      Pending: { uniqueOrders: pendingUniqueOrders, totalEvents: pendingTotalEvents },
      Processing: { uniqueOrders: processingUniqueOrders, totalEvents: processingTotalEvents },
      Canceling: { uniqueOrders: cancelingUniqueOrders, totalEvents: cancelingTotalEvents },
      Printed: { uniqueOrders: printedForDateCount, totalEvents: printedEventsCount },
      Canceled: { uniqueOrders: canceledForDateCount, totalEvents: cancelEventsCount },
    };

    const todayActivity = {
      Created: createdOnDate,
      Printed: printedForDateCount,
      Pending: pendingUniqueOrders,
      Processing: processingUniqueOrders,
      Canceling: cancelingUniqueOrders,
      Canceled: canceledForDateCount,
      createdEvents: createdOnDate,
      printedEvents: printedEventsCount,
      pendingEvents: pendingTotalEvents,
      processingEvents: processingTotalEvents,
      cancelingEvents: cancelingTotalEvents,
      cancelEvents: cancelEventsCount,
    };

    // 3. Confirmation Age counts
    const confStatus = syncEngine.getStatus().confirmationAgeStatus;
    const isAvailable = confStatus?.isAvailable ?? false;
    const confRows: any[] = db.prepare(`
      SELECT confirmation_age_category, COUNT(*) as count
      FROM orders
      WHERE confirmation_age_category IS NOT NULL
      GROUP BY confirmation_age_category
    `).all();

    const confirmationAges: Record<string, any> = {
      '1_day': 0,
      '2_days': 0,
      '3_days': 0,
      'over_3_days': 0,
      isAvailable,
      state: confStatus?.state || 'NOT_AVAILABLE',
      lastObservedAt: confStatus?.lastObservedAt || null,
      lastSuccessAt: confStatus?.lastSuccessAt || null,
    };
    for (const cr of confRows) {
      if (cr.confirmation_age_category in confirmationAges) {
        confirmationAges[cr.confirmation_age_category] = cr.count;
      }
    }

    // 4. Unified Risk Indicators from riskService (Guarantees 100% mathematical consistency)
    const riskStats = getDashboardRiskStats(targetDate);
    const multiMerchantTotal = riskStats.multiMerchantTotal;
    const multiMerchantPrinted = riskStats.multiMerchantPrinted;
    const missingExtraPhoneTotal = riskStats.missingExtraPhoneTotal;
    const missingExtraPhonePrinted = riskStats.missingExtraPhonePrinted;
    const lowDeliveryRateTotal = riskStats.lowDeliveryRateTotal;
    const lowDeliveryRatePrinted = riskStats.lowDeliveryRatePrinted;

    const openAlertsCount = (db.prepare(`
      SELECT COUNT(*) as count
      FROM alerts
      WHERE status != 'RESOLVED'
    `).get() as any)?.count || 0;

    // 5. Age in status buckets for Pending & Processing (Shared, mutually exclusive 5 buckets)
    const nowMs = Date.now();

    // Pending: strictly from created_at_source
    const pendingOrders: any[] = db.prepare('SELECT created_at_source FROM orders WHERE current_status = ?').all('Pending');
    let pendingLessThan2 = 0;
    let pending2to4 = 0;
    let pending4to5 = 0;
    let pendingOver5 = 0;
    let pendingUnknown = 0;

    for (const o of pendingOrders) {
      const resAge = calculateAgeBucket(o.created_at_source, nowMs);
      if (resAge.ageBucket === 'less_than_2_days') pendingLessThan2++;
      else if (resAge.ageBucket === '2_to_4_days') pending2to4++;
      else if (resAge.ageBucket === '4_to_5_days') pending4to5++;
      else if (resAge.ageBucket === 'over_5_days') pendingOver5++;
      else pendingUnknown++;
    }

    const pendingAge = {
      lessThanTwoDays: pendingLessThan2,
      twoToFourDays: pending2to4,
      fourToFiveDays: pending4to5,
      overFiveDays: pendingOver5,
      unknown: pendingUnknown,
      total: pendingOrders.length,
    };

    // Processing: strictly from latest qualifying Processing transition log/event
    const processingOrders: any[] = db.prepare('SELECT id, random_number FROM orders WHERE current_status = ?').all('Processing');
    let procLessThan2 = 0;
    let proc2to4 = 0;
    let proc4to5 = 0;
    let procOver5 = 0;
    let procUnknown = 0;

    for (const o of processingOrders) {
      const transTime = getProcessingTransitionTime(o.id, o.random_number);
      const resAge = calculateAgeBucket(transTime, nowMs);
      if (resAge.ageBucket === 'less_than_2_days') procLessThan2++;
      else if (resAge.ageBucket === '2_to_4_days') proc2to4++;
      else if (resAge.ageBucket === '4_to_5_days') proc4to5++;
      else if (resAge.ageBucket === 'over_5_days') procOver5++;
      else procUnknown++;
    }

    const processingAge = {
      lessThanTwoDays: procLessThan2,
      twoToFourDays: proc2to4,
      fourToFiveDays: proc4to5,
      overFiveDays: procOver5,
      unknown: procUnknown,
      total: processingOrders.length,
    };

    const syncStatus = syncEngine.getStatus();
    const todayLogsCoverage = syncEngine.getTodayLogsCoverage();

    res.json({
      selectedDate: targetDate,
      isToday,
      storageTier,
      coverageStatus,
      isCached: false,
      currentCounts,
      confirmationAges,
      riskIndicators: {
        multiMerchantTotal,
        multiMerchantPrinted,
        missingExtraPhoneTotal,
        missingExtraPhonePrinted,
        lowDeliveryRateTotal,
        lowDeliveryRatePrinted,
        multiMerchantCount: multiMerchantTotal,
        lowDeliveryCount: lowDeliveryRateTotal,
        missingPhoneCount: missingExtraPhoneTotal,
        openAlertsCount,
      },
      todayActivity,
      dayCumulative,
      todayLogsCoverage,
      pendingAge,
      processingAge,
      syncStatus,
      databaseMode: isSupabaseConfigured() ? 'SUPABASE_POSTGRES' : 'SQLITE_AWAITING_CONFIG',
      supabaseConfigured: isSupabaseConfigured(),
    });
  } catch (err: any) {
    console.error('Error in /dashboard/stats:', err);
    res.status(500).json({ error: err.message });
  }
});

// 2b. Risk Drilldown Orders Endpoint (100% consistent with dashboard cards & system state)
apiRouter.get('/dashboard/risk-orders', (req: Request, res: Response) => {
  try {
    const riskType = (req.query.riskType as any) || 'multi_merchant';
    const tab = (req.query.tab as string) || 'all';
    const search = (req.query.search as string) || '';
    const page = Math.max(0, parseInt((req.query.page as string) || '0', 10));
    const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || '50', 10)));
    const date = req.query.date as string | undefined;

    const result = getRiskOrdersDrilldown({
      riskType,
      tab,
      search,
      page,
      limit,
      date,
    });

    res.json(result);
  } catch (err: any) {
    console.error('Error in /dashboard/risk-orders:', err);
    res.status(500).json({ error: err.message });
  }
});

// 3. Orders List with dynamic filtering and pagination
apiRouter.get('/orders', (req: Request, res: Response) => {
  try {
    const {
      status,
      search,
      page = '1',
      limit = '50',
      date,
      startDate,
      endDate,
      multiMerchant,
      lowDelivery,
      noExtraPhone,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page as string, 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10)));
    const offset = (pageNum - 1) * pageSize;

    const conditions: string[] = [];
    const params: any[] = [];

    if (status && status !== 'all') {
      if (typeof status === 'string' && status.includes(',')) {
        const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
        conditions.push(`current_status IN (${statuses.map(() => '?').join(',')})`);
        params.push(...statuses);
      } else {
        conditions.push('current_status = ?');
        params.push(status);
      }
    }

    if (startDate && endDate) {
      const sInterval = getCairoDateInterval(startDate as string);
      const eInterval = getCairoDateInterval(endDate as string);
      if (status === 'Printed') {
        conditions.push(`((printed_date >= ? AND printed_date < ?) OR EXISTS (SELECT 1 FROM canonical_activity_events c WHERE (c.order_code = orders.random_number OR c.order_id = orders.id) AND c.event_timestamp >= ? AND c.event_timestamp < ? AND c.to_status = 'Printed'))`);
        params.push(sInterval.startCairo, eInterval.endCairo, sInterval.startCairo, eInterval.endCairo);
      } else if (status === 'Canceled') {
        conditions.push(`((canceling_date >= ? AND canceling_date < ?) OR EXISTS (SELECT 1 FROM canonical_activity_events c WHERE (c.order_code = orders.random_number OR c.order_id = orders.id) AND c.event_timestamp >= ? AND c.event_timestamp < ? AND c.to_status = 'Canceled'))`);
        params.push(sInterval.startCairo, eInterval.endCairo, sInterval.startCairo, eInterval.endCairo);
      } else {
        conditions.push('created_at_source >= ? AND created_at_source < ?');
        params.push(sInterval.startCairo, eInterval.endCairo);
      }
    } else if (date) {
      const interval = getCairoDateInterval(date as string);
      if (status === 'Printed') {
        conditions.push(`((printed_date >= ? AND printed_date < ?) OR EXISTS (SELECT 1 FROM canonical_activity_events c WHERE (c.order_code = orders.random_number OR c.order_id = orders.id) AND c.event_timestamp >= ? AND c.event_timestamp < ? AND c.to_status = 'Printed'))`);
        params.push(interval.startCairo, interval.endCairo, interval.startCairo, interval.endCairo);
      } else if (status === 'Canceled') {
        conditions.push(`((canceling_date >= ? AND canceling_date < ?) OR EXISTS (SELECT 1 FROM canonical_activity_events c WHERE (c.order_code = orders.random_number OR c.order_id = orders.id) AND c.event_timestamp >= ? AND c.event_timestamp < ? AND c.to_status = 'Canceled'))`);
        params.push(interval.startCairo, interval.endCairo, interval.startCairo, interval.endCairo);
      } else {
        conditions.push('created_at_source >= ? AND created_at_source < ?');
        params.push(interval.startCairo, interval.endCairo);
      }
    }

    if (multiMerchant === '1') {
      conditions.push(getRiskConditionSql('multi_merchant', 'orders'));
    }

    if (lowDelivery === '1') {
      conditions.push(getRiskConditionSql('low_delivery', 'orders'));
    }

    if (noExtraPhone === '1') {
      conditions.push(getRiskConditionSql('no_extra_phone', 'orders'));
    }

    if (search) {
      const q = `%${search}%`;
      conditions.push('(random_number LIKE ? OR order_no LIKE ? OR customer_phone LIKE ? OR customer_name LIKE ?)');
      params.push(q, q, q, q);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow: any = db.prepare(`SELECT COUNT(*) as total FROM orders ${whereClause}`).get(...params);
    const total = countRow?.total || 0;

    const orders: any[] = db.prepare(`
      SELECT
        id, vendoor_id, random_number, order_no, order_type, current_status,
        customer_name, customer_phone, customer_phone_extra, extra_phone_valid, extra_phone_status,
        governorate, address, total_price, shipping_cost, total_order,
        created_at_source, shipping_date, printed_date, distinct_merchant_count,
        multi_merchant_flag, delivery_rate, delivery_rate_num, delivery_rate_denom,
        cancel_rate, total_customer_orders, customer_last_order_status,
        confirmation_age_category, address_quality_status, last_observed_at
      FROM orders
      ${whereClause}
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);

    // Enrich with associated warehouse names, warehouse codes, and genuine merchant codes
    const orderIds = orders.map(o => o.id);
    const warehouseCodeMap: Record<number, string[]> = {};
    const warehouseNameMap: Record<number, string[]> = {};
    const merchantMap: Record<number, string[]> = {};
    if (orderIds.length > 0) {
      try {
        const placeholders = orderIds.map(() => '?').join(',');
        const itemRows: any[] = db.prepare(`
          SELECT order_id, merchant_code, warehouse_name, warehouse_code
          FROM order_items
          WHERE order_id IN (${placeholders})
        `).all(...orderIds);
        for (const row of itemRows) {
          if (!warehouseCodeMap[row.order_id]) warehouseCodeMap[row.order_id] = [];
          if (!warehouseNameMap[row.order_id]) warehouseNameMap[row.order_id] = [];
          if (!merchantMap[row.order_id]) merchantMap[row.order_id] = [];

          const whName = row.warehouse_name;
          const whCode = row.warehouse_code || (whName ? whName.replace(/^مخزن\s*/, '').trim() : null);

          if (whCode && !warehouseCodeMap[row.order_id].includes(whCode)) {
            warehouseCodeMap[row.order_id].push(whCode);
          }
          if (whName && !warehouseNameMap[row.order_id].includes(whName)) {
            warehouseNameMap[row.order_id].push(whName);
          }
          if (
            row.merchant_code &&
            typeof row.merchant_code === 'string' &&
            row.merchant_code.trim().length > 0 &&
            !row.merchant_code.startsWith('مخزن') &&
            row.merchant_code !== 'غير محدد' &&
            row.merchant_code !== whName &&
            row.merchant_code !== whCode &&
            !merchantMap[row.order_id].includes(row.merchant_code.trim())
          ) {
            merchantMap[row.order_id].push(row.merchant_code.trim());
          }
        }
      } catch {}
    }

    const enrichedOrders = orders.map(o => ({
      ...o,
      warehouseCodes: warehouseCodeMap[o.id] || [],
      warehouseNames: warehouseNameMap[o.id] || [],
      merchantCodes: merchantMap[o.id] || [],
    }));

    res.json({
      orders: enrichedOrders,
      total,
      page: pageNum,
      limit: pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Single Order Details
apiRouter.get('/orders/:code', (req: Request, res: Response) => {
  try {
    const code = req.params.code;
    const order: any = db.prepare('SELECT * FROM orders WHERE random_number = ? OR vendoor_id = ?').get(code, code);

    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    const items: any[] = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);

    const timeline: any[] = db.prepare(`
      SELECT * FROM order_status_events
      WHERE order_id = ?
      ORDER BY id ASC
    `).all(order.id);

    const alerts: any[] = db.prepare('SELECT * FROM alerts WHERE order_id = ?').all(order.id);

    const customerObservations: any[] = db.prepare(`
      SELECT * FROM customer_history_observations
      WHERE order_id = ? OR phone = ?
      ORDER BY id DESC
      LIMIT 10
    `).all(order.id, order.customer_phone);

    const sourceLogs: any[] = db.prepare(`
      SELECT 
        c.id, c.order_code, c.actor_name, c.action_type, c.from_status, c.to_status,
        c.event_timestamp, c.storage_tier, c.is_system_actor, c.created_at,
        c.order_id, c.order_match_status, c.is_administrative, c.field_name, c.old_value, c.new_value,
        c.details_json,
        COALESCE(r.raw_action_text, '') as raw_action_text,
        r.observed_at as imported_at,
        r.source_hash,
        r.page_source,
        r.vendoor_order_id
      FROM canonical_activity_events c
      LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
      WHERE c.order_id = ? OR c.order_code = ? OR c.order_code = ?
      ORDER BY c.event_timestamp DESC, c.id DESC
      LIMIT 100
    `).all(order.id, order.random_number, String(order.vendoor_id));

    res.json({
      order,
      items,
      timeline,
      alerts,
      customerObservations,
      sourceLogs,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Printed View (Scoped to date, backed by Vendoor logs & transitions)
apiRouter.get('/printed', (req: Request, res: Response) => {
  try {
    const { category = 'all', date } = req.query;
    const cairoToday = getCairoDateString();
    const targetDate = typeof date === 'string' && date.trim() ? date.trim().slice(0, 10) : cairoToday;
    const interval = getCairoDateInterval(targetDate);

    let categorySql = '';
    if (category === 'no_extra_phone') {
      categorySql = " AND o.extra_phone_status = 'CONFIRMED_ABSENT'";
    } else if (category === 'multi_merchant') {
      categorySql = ' AND o.multi_merchant_flag = 1';
    } else if (category === 'low_delivery') {
      categorySql = ' AND o.delivery_rate IS NOT NULL AND o.delivery_rate < 70 AND (o.delivery_rate_denom > 0 OR o.total_customer_orders > 0) AND NOT (o.delivery_rate = 0 AND (o.cancel_rate = 0 OR o.cancel_rate IS NULL))';
    }

    // Query orders that transitioned to Printed on targetDate (from log events or printed_date)
    const orders: any[] = db.prepare(`
      SELECT
        o.id, o.vendoor_id, o.random_number, o.order_no, o.order_type, o.current_status,
        o.customer_name, o.customer_phone, o.customer_phone_extra, o.extra_phone_valid, o.extra_phone_status,
        o.governorate, o.address, o.total_order, o.total_price, o.shipping_cost,
        COALESCE(c.event_timestamp, o.printed_date, o.state_entry_at) as printed_date,
        COALESCE(c.actor_name, 'النظام') as printed_by,
        CASE WHEN c.id IS NOT NULL THEN 'MATCHED' ELSE 'PENDING_LOG_MATCH' END as log_match_status,
        o.distinct_merchant_count, o.multi_merchant_flag, o.delivery_rate,
        o.delivery_rate_num, o.delivery_rate_denom, o.cancel_rate, o.total_customer_orders,
        o.confirmation_age_category, o.address_quality_status, o.last_observed_at
      FROM orders o
      LEFT JOIN (
        SELECT order_code, actor_name, event_timestamp, id
        FROM canonical_activity_events
        WHERE event_timestamp >= ? AND event_timestamp < ?
          AND (to_status = 'Printed' OR action_type = 'confirmation')
        GROUP BY order_code
      ) c ON c.order_code = o.random_number OR c.order_code = o.order_no OR c.order_code = CAST(o.vendoor_id AS TEXT)
      WHERE (c.id IS NOT NULL OR (o.printed_date >= ? AND o.printed_date < ?))
        ${categorySql}
      ORDER BY printed_date DESC, o.id DESC
    `).all(interval.startCairo, interval.endCairo, interval.startCairo, interval.endCairo);

    // Enrich with associated warehouse names and codes
    const orderIds = orders.map(o => o.id);
    const warehouseCodeMap: Record<number, string[]> = {};
    const warehouseNameMap: Record<number, string[]> = {};
    if (orderIds.length > 0) {
      try {
        const placeholders = orderIds.map(() => '?').join(',');
        const itemRows: any[] = db.prepare(`
          SELECT order_id, warehouse_name, warehouse_code
          FROM order_items
          WHERE order_id IN (${placeholders})
        `).all(...orderIds);
        for (const row of itemRows) {
          if (!warehouseCodeMap[row.order_id]) warehouseCodeMap[row.order_id] = [];
          if (!warehouseNameMap[row.order_id]) warehouseNameMap[row.order_id] = [];
          if (row.warehouse_code && !warehouseCodeMap[row.order_id].includes(row.warehouse_code)) {
            warehouseCodeMap[row.order_id].push(row.warehouse_code);
          }
          if (row.warehouse_name && !warehouseNameMap[row.order_id].includes(row.warehouse_name)) {
            warehouseNameMap[row.order_id].push(row.warehouse_name);
          }
        }
      } catch {}
    }

    const enrichedOrders = orders.map(o => ({
      ...o,
      warehouseCodes: warehouseCodeMap[o.id] || [],
      warehouseNames: warehouseNameMap[o.id] || [],
    }));

    res.json({
      date: targetDate,
      orders: enrichedOrders,
      total: enrichedOrders.length,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5b. Canceled Orders View (Strictly derived from Vendoor activity logs for target date)
apiRouter.get('/canceled', (req: Request, res: Response) => {
  try {
    const { date } = req.query;
    const cairoToday = getCairoDateString();
    const targetDate = typeof date === 'string' && date.trim() ? date.trim().slice(0, 10) : cairoToday;
    const interval = getCairoDateInterval(targetDate);

    const logs: any[] = db.prepare(`
      SELECT 
        c.id, c.order_code, c.actor_name as canceled_by, c.event_timestamp as canceled_at,
        c.action_type, c.from_status, c.to_status, c.field_name, c.old_value, c.new_value,
        c.order_match_status,
        COALESCE(r.raw_action_text, '') as raw_action_text,
        o.id as order_id, o.random_number, o.order_no, o.current_status as order_current_status,
        o.customer_name, o.customer_phone, o.governorate, o.address, o.total_order, o.delivery_rate
      FROM canonical_activity_events c
      LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
      LEFT JOIN orders o ON c.order_id = o.id OR c.order_code = o.random_number OR c.order_code = o.order_no OR c.order_code = CAST(o.vendoor_id AS TEXT)
      WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
        AND (c.to_status = 'Canceled' OR c.action_type = 'order_canceled')
      GROUP BY COALESCE(c.order_code, c.id)
      ORDER BY c.event_timestamp DESC
    `).all(interval.startCairo, interval.endCairo);

    res.json({
      date: targetDate,
      total: logs.length,
      orders: logs,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Pending Orders Categorized by Age (Shared 5 buckets)
apiRouter.get('/pending', (_req: Request, res: Response) => {
  try {
    const orders: any[] = db.prepare(`
      SELECT
        id, vendoor_id, random_number, customer_name, customer_phone,
        governorate, address, total_order, state_entry_at, created_at_source,
        distinct_merchant_count, delivery_rate, last_observed_at
      FROM orders
      WHERE current_status = 'Pending'
      ORDER BY id DESC
    `).all();

    const nowMs = Date.now();
    const enriched = orders.map(o => {
      const { ageInDays, ageBucket } = calculateAgeBucket(o.created_at_source, nowMs);
      return {
        ...o,
        ageInDays,
        ageBucket,
      };
    });

    res.json({ orders: enriched, total: enriched.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Processing Orders Categorized by Age (Shared 5 buckets, from source logs)
apiRouter.get('/processing', (_req: Request, res: Response) => {
  try {
    const orders: any[] = db.prepare(`
      SELECT
        id, vendoor_id, random_number, customer_name, customer_phone,
        governorate, address, total_order, state_entry_at, created_at_source,
        distinct_merchant_count, delivery_rate, last_observed_at
      FROM orders
      WHERE current_status = 'Processing'
      ORDER BY id DESC
    `).all();

    const nowMs = Date.now();
    const enriched = orders.map(o => {
      const transTime = getProcessingTransitionTime(o.id, o.random_number);
      const { ageInDays, ageBucket } = calculateAgeBucket(transTime, nowMs);
      return {
        ...o,
        processingStartedAt: transTime,
        ageInDays,
        ageBucket,
      };
    });

    res.json({ orders: enriched, total: enriched.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Team Performance Based on Canonical Activity Events
apiRouter.get('/team', async (req: Request, res: Response) => {
  try {
    const { period, date, startDate, endDate, syncIfMissing } = req.query;

    let dateLabel = '';
    const conditions: string[] = [];
    const params: any[] = [];

    const effectiveDate = (date as string) || (period === 'today' ? getCairoDateString() : '');
    if (effectiveDate) {
      dateLabel = effectiveDate;
      const interval = getCairoDateInterval(effectiveDate);
      conditions.push('c.event_timestamp >= ? AND c.event_timestamp < ?');
      params.push(interval.startCairo, interval.endCairo);
      if (syncIfMissing === '1') {
        await syncEngine.syncHistoricalDate('logs', effectiveDate);
      }
    } else if (startDate && endDate) {
      if (startDate === endDate) {
        dateLabel = String(startDate);
        const interval = getCairoDateInterval(String(startDate));
        conditions.push('c.event_timestamp >= ? AND c.event_timestamp < ?');
        params.push(interval.startCairo, interval.endCairo);
      } else {
        dateLabel = `${startDate} إلى ${endDate}`;
        const startInt = getCairoDateInterval(String(startDate));
        const endInt = getCairoDateInterval(String(endDate));
        conditions.push('c.event_timestamp >= ? AND c.event_timestamp < ?');
        params.push(startInt.startCairo, endInt.endCairo);
      }
    } else if (period === 'yesterday') {
      const now = new Date();
      const y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const yStr = getCairoDateString(y);
      dateLabel = yStr;
      const interval = getCairoDateInterval(yStr);
      conditions.push('c.event_timestamp >= ? AND c.event_timestamp < ?');
      params.push(interval.startCairo, interval.endCairo);
    } else if (period === 'all') {
      dateLabel = 'كل الفترات';
    } else {
      const todayStr = getCairoDateString();
      dateLabel = todayStr;
      const interval = getCairoDateInterval(todayStr);
      conditions.push('c.event_timestamp >= ? AND c.event_timestamp < ?');
      params.push(interval.startCairo, interval.endCairo);
    }

    conditions.push('c.is_system_actor = 0');
    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const rawEvents: any[] = db.prepare(`
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
        COALESCE(r.raw_action_text, '') as raw_action_text
      FROM canonical_activity_events c
      LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
      ${whereClause}
      ORDER BY c.event_timestamp ASC, c.id ASC
    `).all(...params);

    // Condition 1 & 4: Seed prior statuses for orders before this period to avoid double-counting on boundaries
    const priorStatusMap = new Map<string, string>();
    const orderCodes = Array.from(new Set(rawEvents.map((e: any) => e.order_code).filter(Boolean)));
    if (orderCodes.length > 0 && params.length >= 1) {
      const minTimestamp = params[0];
      const chunkSize = 200;
      for (let i = 0; i < orderCodes.length; i += chunkSize) {
        const slice = orderCodes.slice(i, i + chunkSize);
        const placeholders = slice.map(() => '?').join(',');
        const priors = db.prepare(`
          SELECT order_code, to_status
          FROM canonical_activity_events
          WHERE order_code IN (${placeholders})
            AND event_timestamp < ?
            AND action_type = 'status_change'
            AND to_status IS NOT NULL
          ORDER BY event_timestamp DESC, id DESC
        `).all(...slice, minTimestamp);
        for (const p of priors as any[]) {
          const k = p.order_code?.toLowerCase();
          if (k && !priorStatusMap.has(k)) {
            priorStatusMap.set(k, p.to_status);
          }
        }
      }
    }

    const annotatedEvents = processAndDeduplicateTeamEvents(rawEvents as any, priorStatusMap);

    const userOrdersMap: Record<string, Set<string>> = {};
    const userStats: Record<string, {
      name: string;
      actions: number;
      uniqueOrders: number;
      printed: number;
      pending: number;
      processing: number;
      cancel: number;
      other: number;
      rawEventsCount: number;
      duplicateEventsCount: number;
      lastActionAt: string | null;
    }> = {};

    for (const e of annotatedEvents) {
      const name = e.actor_name || 'غير معروف';
      if (!userStats[name]) {
        userStats[name] = {
          name,
          actions: 0,
          uniqueOrders: 0,
          printed: 0,
          pending: 0,
          processing: 0,
          cancel: 0,
          other: 0,
          rawEventsCount: 0,
          duplicateEventsCount: 0,
          lastActionAt: null,
        };
        userOrdersMap[name] = new Set();
      }

      userStats[name].rawEventsCount++;
      if (e.order_code) {
        userOrdersMap[name].add(e.order_code);
      }
      if (!userStats[name].lastActionAt || e.event_timestamp > userStats[name].lastActionAt!) {
        userStats[name].lastActionAt = e.event_timestamp;
      }

      // Condition 6: Count each actual status transition once in the total actions and status metrics
      if (!e.is_counted) {
        userStats[name].duplicateEventsCount++;
        continue;
      }

      userStats[name].actions++;
      if (e.action_type === 'status_change') {
        if (e.to_status === 'Printed') userStats[name].printed++;
        else if (e.to_status === 'Pending') userStats[name].pending++;
        else if (e.to_status === 'Processing') userStats[name].processing++;
        else if (e.to_status === 'Canceled') userStats[name].cancel++;
        else if (e.to_status === 'Canceling') (userStats[name] as any).canceling = ((userStats[name] as any).canceling || 0) + 1;
        else userStats[name].other++;
      } else {
        userStats[name].other++;
      }
    }

    const isCsOnly = req.query.role !== 'all';
    const allMembers = Object.values(userStats).map(u => ({
      ...u,
      isCS: isCSEmployee(u.name),
      uniqueOrders: userOrdersMap[u.name]?.size || 0,
      printedPercent: u.actions > 0 ? Math.round((u.printed / u.actions) * 1000) / 10 : 0,
      pendingPercent: u.actions > 0 ? Math.round((u.pending / u.actions) * 1000) / 10 : 0,
      processingPercent: u.actions > 0 ? Math.round((u.processing / u.actions) * 1000) / 10 : 0,
      cancelPercent: u.actions > 0 ? Math.round((u.cancel / u.actions) * 1000) / 10 : 0,
      otherPercent: u.actions > 0 ? Math.round((u.other / u.actions) * 1000) / 10 : 0,
    })).sort((a, b) => b.actions - a.actions);

    const csTeamList = allMembers.filter(m => m.isCS);
    const nonCsStaff = allMembers.filter(m => !m.isCS);

    const teamList = isCsOnly ? csTeamList : allMembers;
    const csActionsTotal = csTeamList.reduce((acc, m) => acc + m.actions, 0);
    const csUniqueOrdersTotal = new Set(
      annotatedEvents.filter(e => isCSEmployee(e.actor_name || '') && e.is_counted).map(e => e.order_code).filter(Boolean)
    ).size;

    const countedEventsList = annotatedEvents.filter(e => e.is_counted);

    res.json({
      period: period || (date ? 'custom_date' : (startDate ? 'custom_range' : 'today')),
      dateFilter: dateLabel,
      team: teamList,
      isCsOnly,
      csStaffCount: csTeamList.length,
      nonCsStaffCount: nonCsStaff.length,
      csActionsTotal,
      csUniqueOrdersTotal,
      totalActions: countedEventsList.length,
      totalRawEvents: annotatedEvents.length,
      totalDuplicatesExcluded: annotatedEvents.filter(e => e.is_duplicate_transition).length,
      totalUniqueOrders: new Set(annotatedEvents.map(e => e.order_code).filter(Boolean)).size,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 9. Employee Drill-down with period support & transition deduplication annotations
apiRouter.get('/team/:actorName/events', (req: Request, res: Response) => {
  try {
    const actorName = req.params.actorName;
    const { date, startDate, endDate, period } = req.query;
    const dateConditions: string[] = [];
    const dateParams: any[] = [];

    if (date && typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date.trim())) {
      const interval = getCairoDateInterval(date.trim());
      dateConditions.push('c.event_timestamp >= ? AND c.event_timestamp < ?');
      dateParams.push(interval.startCairo, interval.endCairo);
    } else if (startDate && endDate) {
      if (startDate === endDate) {
        const interval = getCairoDateInterval(String(startDate));
        dateConditions.push('c.event_timestamp >= ? AND c.event_timestamp < ?');
        dateParams.push(interval.startCairo, interval.endCairo);
      } else {
        const startInt = getCairoDateInterval(String(startDate));
        const endInt = getCairoDateInterval(String(endDate));
        dateConditions.push('c.event_timestamp >= ? AND c.event_timestamp < ?');
        dateParams.push(startInt.startCairo, endInt.endCairo);
      }
    } else if (period === 'yesterday') {
      const now = new Date();
      const y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const yStr = getCairoDateString(y);
      const interval = getCairoDateInterval(yStr);
      dateConditions.push('c.event_timestamp >= ? AND c.event_timestamp < ?');
      dateParams.push(interval.startCairo, interval.endCairo);
    } else if (period === 'today') {
      const todayStr = getCairoDateString();
      const interval = getCairoDateInterval(todayStr);
      dateConditions.push('c.event_timestamp >= ? AND c.event_timestamp < ?');
      dateParams.push(interval.startCairo, interval.endCairo);
    }

    // Condition 1 & 5: Retrieve events for the actor, and calculate deduplication across the orders touched
    const actorQueryConditions = [...dateConditions, 'c.actor_name = ?'];
    const actorQueryParams = [...dateParams, actorName];

    const rawActorEvents: any[] = db.prepare(`
      SELECT 
        c.*, 
        COALESCE(r.raw_action_text, '') as raw_action_text,
        r.observed_at as imported_at,
        r.source_hash,
        o.order_no,
        o.current_status as order_current_status,
        o.customer_name,
        o.customer_phone,
        o.governorate,
        o.total_order,
        o.distinct_merchant_count
      FROM canonical_activity_events c
      LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
      LEFT JOIN orders o ON c.order_id = o.id
      WHERE ${actorQueryConditions.join(' AND ')}
      ORDER BY c.event_timestamp ASC, c.id ASC
    `).all(...actorQueryParams);

    // Get all orders touched by this actor in this window
    const touchedCodes = Array.from(new Set(rawActorEvents.map((e: any) => e.order_code).filter(Boolean)));
    let allOrderEvents: any[] = rawActorEvents;

    if (touchedCodes.length > 0) {
      const placeholders = touchedCodes.map(() => '?').join(',');
      const fullOrderEvents = db.prepare(`
        SELECT 
          c.*, 
          COALESCE(r.raw_action_text, '') as raw_action_text,
          r.observed_at as imported_at,
          r.source_hash,
          o.order_no,
          o.current_status as order_current_status,
          o.customer_name,
          o.customer_phone,
          o.governorate,
          o.total_order,
          o.distinct_merchant_count
        FROM canonical_activity_events c
        LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
        LEFT JOIN orders o ON c.order_id = o.id
        WHERE c.order_code IN (${placeholders})
          ${dateConditions.length > 0 ? `AND ${dateConditions.join(' AND ')}` : ''}
        ORDER BY c.event_timestamp ASC, c.id ASC
      `).all(...touchedCodes, ...dateParams);
      allOrderEvents = fullOrderEvents;
    }

    const annotatedAll = processAndDeduplicateTeamEvents(allOrderEvents as any);
    const annotatedMap = new Map<number, any>();
    for (const a of annotatedAll) {
      annotatedMap.set(a.id, a);
    }

    // Condition 2, 6, 8: Return all original log rows for audit, annotated with is_counted and duplicate status
    const finalEvents = rawActorEvents.map((ev: any) => {
      const ann = annotatedMap.get(ev.id);
      return {
        ...ev,
        is_counted: ann ? ann.is_counted : true,
        is_duplicate_transition: ann ? ann.is_duplicate_transition : false,
        exclusion_reason: ann ? ann.exclusion_reason : null,
      };
    }).sort((a, b) => {
      if (b.event_timestamp !== a.event_timestamp) {
        return b.event_timestamp.localeCompare(a.event_timestamp);
      }
      return (b.id || 0) - (a.id || 0);
    });

    const totalEvents = finalEvents.length;
    const countedTransitions = finalEvents.filter(e => e.is_counted).length;
    const duplicateEventsCount = finalEvents.filter(e => e.is_duplicate_transition).length;

    res.json({
      actorName,
      totalEvents,
      countedTransitions,
      duplicateEventsCount,
      events: finalEvents.slice(0, 300),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 10. Alerts Management
apiRouter.get('/alerts', (req: Request, res: Response) => {
  try {
    const { status, type, severity } = req.query;
    const conditions: string[] = [];
    const params: any[] = [];

    if (status && status !== 'all') {
      conditions.push('a.status = ?');
      params.push(status);
    }
    if (type && type !== 'all') {
      conditions.push('a.alert_type = ?');
      params.push(type);
    }
    if (severity && severity !== 'all') {
      conditions.push('a.severity = ?');
      params.push(severity);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const alerts: any[] = db.prepare(`
      SELECT
        a.*,
        o.customer_name,
        o.customer_phone,
        o.governorate,
        o.total_order,
        o.delivery_rate
      FROM alerts a
      LEFT JOIN orders o ON a.order_id = o.id
      ${whereClause}
      ORDER BY
        CASE a.severity
          WHEN 'CRITICAL' THEN 1
          WHEN 'WARNING' THEN 2
          ELSE 3
        END ASC,
        a.id DESC
    `).all(...params);

    res.json({ alerts, total: alerts.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/alerts/:id/resolve', (req: Request, res: Response) => {
  try {
    const alertId = parseInt(req.params.id, 10);
    const { notes = '', resolvedBy = 'مشرف العمليات' } = req.body;
    const nowIso = new Date().toISOString();

    const info = db.prepare(`
      UPDATE alerts SET
        status = 'RESOLVED',
        resolved_at = ?,
        resolved_by = ?,
        resolution_notes = ?,
        updated_at = ?
      WHERE id = ?
    `).run(nowIso, resolvedBy, notes, nowIso, alertId);

    if (info.changes === 0) {
      res.status(404).json({ error: 'Alert not found' });
      return;
    }

    res.json({ success: true, alertId, resolvedAt: nowIso });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 10b. Logs-Only Intelligence Report (Single Day, Week, or Custom Period)
function isValidReportDateString(d: string): boolean {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const parsed = Date.parse(`${d}T00:00:00Z`);
  return !isNaN(parsed);
}

// 10. Intelligent Activity Reports & Log Analytics
apiRouter.get('/reports/logs-intelligence', async (req: Request, res: Response) => {
  try {
    const { startDate, endDate, period, autoFetch = 'true' } = req.query;
    let sDate = (startDate as string) || '';
    let eDate = (endDate as string) || '';

    if (period === 'today') {
      sDate = getCairoDateString();
      eDate = sDate;
    } else if (period === 'yesterday') {
      const now = new Date();
      const y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      sDate = getCairoDateString(y);
      eDate = sDate;
    } else if (period === 'last_7_days') {
      const now = new Date();
      const past = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
      sDate = getCairoDateString(past);
      eDate = getCairoDateString(now);
    } else if (period === 'last_30_days') {
      const now = new Date();
      const past = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
      sDate = getCairoDateString(past);
      eDate = getCairoDateString(now);
    }

    if (!sDate) sDate = getCairoDateString();
    if (!eDate) eDate = sDate;

    // Validate date format strictly
    if (!isValidReportDateString(sDate)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_START_DATE',
          message: `تاريخ البداية '${sDate}' غير صالح. يجب استخدام صيغة YYYY-MM-DD`,
          retryable: false,
          requestId: crypto.randomUUID(),
        },
      });
    }

    if (!isValidReportDateString(eDate)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_END_DATE',
          message: `تاريخ النهاية '${eDate}' غير صالح. يجب استخدام صيغة YYYY-MM-DD`,
          retryable: false,
          requestId: crypto.randomUUID(),
        },
      });
    }

    if (sDate > eDate) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_DATE_RANGE',
          message: `تاريخ بداية التقرير (${sDate}) لا يمكن أن يكون بعد تاريخ نهايته (${eDate})`,
          retryable: false,
          requestId: crypto.randomUUID(),
        },
      });
    }

    // Check if autoFetch is requested and if coverage is missing
    const jobKey = `${sDate}_${eDate}`;
    let jobStatus = getRangeJobStatus(sDate, eDate);

    const shouldAutoFetch = autoFetch !== 'false';
    const isJobActive =
      jobStatus &&
      (jobStatus.stage === 'CHECKING_STORAGE' ||
        jobStatus.stage === 'FETCHING_VENDOOR' ||
        jobStatus.stage === 'SAVING_RECORDS' ||
        jobStatus.stage === 'ANALYZING_ACTIONS' ||
        jobStatus.stage === 'COMPUTING_METRICS' ||
        jobStatus.stage === 'PREPARING_REPORT');

    let report = generateLogsIntelligenceReport(sDate, eDate);

    if (shouldAutoFetch && !isJobActive && (!report.coverage.isFullyComplete || !jobStatus)) {
      ensureCoverageForRange(sDate, eDate).catch(err => {
        console.error(`[LogsIntelligence] Auto-fetch error for ${jobKey}:`, err.message);
      });
      jobStatus = getRangeJobStatus(sDate, eDate);
    }

    if (
      jobStatus &&
      (jobStatus.stage === 'CHECKING_STORAGE' ||
        jobStatus.stage === 'FETCHING_VENDOOR' ||
        jobStatus.stage === 'SAVING_RECORDS' ||
        jobStatus.stage === 'ANALYZING_ACTIONS' ||
        jobStatus.stage === 'COMPUTING_METRICS' ||
        jobStatus.stage === 'PREPARING_REPORT')
    ) {
      report.status = 'FETCHING';
    }
    report.loadedFromCache = jobStatus ? jobStatus.loadedFromCache : report.coverage.isFullyComplete;

    res.json({ success: true, report, jobStatus });
  } catch (err: any) {
    const requestId = crypto.randomUUID();
    console.error(`[LogsIntelligence API Error] [${requestId}]:`, err);
    res.status(500).json({
      success: false,
      error: {
        code: 'REPORT_GENERATION_FAILED',
        message: 'تعذر إنشاء تقرير اللوجز الذكي بسبب خطأ داخلي في الخادم',
        retryable: true,
        requestId,
      },
    });
  }
});

// Logs status polling endpoint for the animated Infinity indicator
apiRouter.get('/reports/logs-status', (req: Request, res: Response) => {
  try {
    const { startDate, endDate } = req.query;
    const sDate = ((startDate as string) || getCairoDateString()).slice(0, 10);
    const eDate = ((endDate as string) || sDate).slice(0, 10);

    if (!isValidReportDateString(sDate) || !isValidReportDateString(eDate)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_DATE_INPUT',
          message: 'التاريخ المدخل لحالة التقرير غير صالح',
          retryable: false,
          requestId: crypto.randomUUID(),
        },
      });
    }

    const job = getRangeJobStatus(sDate, eDate);
    res.json({ success: true, job });
  } catch (err: any) {
    const requestId = crypto.randomUUID();
    console.error(`[LogsStatus API Error] [${requestId}]:`, err);
    res.status(500).json({
      success: false,
      error: {
        code: 'REPORT_STATUS_ERROR',
        message: 'تعذر التحقق من حالة جلب التقرير',
        retryable: true,
        requestId,
      },
    });
  }
});

// Manual trigger for fetching missing logs for a period
apiRouter.post('/reports/logs-fetch', async (req: Request, res: Response) => {
  try {
    const { startDate, endDate, force } = req.body;
    const sDate = ((startDate as string) || getCairoDateString()).slice(0, 10);
    const eDate = ((endDate as string) || sDate).slice(0, 10);

    if (!isValidReportDateString(sDate) || !isValidReportDateString(eDate)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_DATE_INPUT',
          message: 'التاريخ المدخل لإعادة الجلب غير صالح',
          retryable: false,
          requestId: crypto.randomUUID(),
        },
      });
    }

    const job = await ensureCoverageForRange(sDate, eDate, undefined, Boolean(force ?? true));
    const report = generateLogsIntelligenceReport(sDate, eDate);
    res.json({ success: true, job, report });
  } catch (err: any) {
    const requestId = crypto.randomUUID();
    console.error(`[LogsFetch API Error] [${requestId}]:`, err);
    res.status(500).json({
      success: false,
      error: {
        code: 'REPORT_FETCH_FAILED',
        message: 'تعذر جلب لوجز الفترة من المصدر',
        retryable: true,
        requestId,
      },
    });
  }
});

// Single Day Resolution Status: checks local storage, external imports, and remote Supabase archive
apiRouter.get('/reports/day-status', async (req: Request, res: Response) => {
  try {
    const rawDate = typeof req.query.date === 'string' ? req.query.date.trim().slice(0, 10) : '';
    const targetDate = rawDate || getCairoDateString();

    if (!isValidReportDateString(targetDate)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_DATE_INPUT',
          message: 'تاريخ فحص اليوم غير صالح',
          retryable: false,
          requestId: crypto.randomUUID(),
        },
      });
    }

    const result = await resolveHistoricalDay(targetDate, { autoFetchMissing: false });
    res.json({ success: true, dayStatus: result });
  } catch (err: any) {
    const requestId = crypto.randomUUID();
    console.error(`[DayStatus API Error] [${requestId}]:`, err);
    res.status(500).json({
      success: false,
      error: {
        code: 'DAY_STATUS_ERROR',
        message: 'تعذر فحص حالة اليوم التاريخي',
        retryable: true,
        requestId,
      },
    });
  }
});

// Single Day Actions: explicit re-check, manual completion of missing pages, or force full refetch
apiRouter.post('/reports/day-action', async (req: Request, res: Response) => {
  try {
    const { date, action } = req.body;
    if (!date) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'MISSING_DATE',
          message: 'حقل التاريخ (date) مطلوب لتنفيذ إجراء اليوم',
          retryable: false,
          requestId: crypto.randomUUID(),
        },
      });
    }
    const cleanDate = String(date).slice(0, 10);

    let result;
    if (action === 'recheck') {
      result = await resolveHistoricalDay(cleanDate, { autoFetchMissing: false, forceRefetch: false });
    } else if (action === 'complete_missing') {
      result = await resolveHistoricalDay(cleanDate, { autoFetchMissing: true, forceRefetch: false });
    } else if (action === 'force_refetch') {
      result = await resolveHistoricalDay(cleanDate, { forceRefetch: true });
    } else if (action === 'sync_supabase') {
      if (cleanDate < '2026-10-23') {
        return res.status(400).json({
          success: false,
          error: {
            code: 'PRE_CUTOFF_ARCHIVE_NOT_ALLOWED',
            message: 'سياسة الأرشيف السحابي تبدأ من 23 أكتوبر 2026 فقط. الأيام السابقة تبقى محفوظة محلياً في SQLite.',
            retryable: false,
            requestId: crypto.randomUUID(),
          },
        });
      }
      await syncDayLogsToSupabase(cleanDate);
      result = await resolveHistoricalDay(cleanDate, { autoFetchMissing: false });
    } else if (action === 'reconcile') {
      const rec = await reconcileHistoricalRange(cleanDate, cleanDate, { autoRepair: true });
      result = await resolveHistoricalDay(cleanDate, { autoFetchMissing: false });
      res.json({ success: true, dayStatus: result, reconciliation: rec });
      return;
    } else {
      const requestId = crypto.randomUUID();
      return res.status(400).json({
        success: false,
        error: {
          code: 'UNKNOWN_ACTION',
          message: `الإجراء المطلوب '${action}' غير مدعوم`,
          retryable: false,
          requestId,
        },
      });
    }

    res.json({ success: true, dayStatus: result });
  } catch (err: any) {
    const requestId = crypto.randomUUID();
    console.error(`[DayAction API Error] [${requestId}]:`, err);
    res.status(500).json({
      success: false,
      error: {
        code: 'DAY_ACTION_FAILED',
        message: err.message || 'حدث خطأ أثناء تنفيذ إجراء اليوم',
        retryable: true,
        requestId,
      },
    });
  }
});

// Comprehensive Historical Reconciliation Diagnostic Report
apiRouter.get('/historical/reconciliation', async (req: Request, res: Response) => {
  try {
    const rawDate = typeof req.query.date === 'string' ? req.query.date.trim().slice(0, 10) : '';
    const rawStart = typeof req.query.startDate === 'string' ? req.query.startDate.trim().slice(0, 10) : '';
    const rawEnd = typeof req.query.endDate === 'string' ? req.query.endDate.trim().slice(0, 10) : '';
    const autoRepair = req.query.autoRepair !== 'false';
    const fetchFromVendoor = req.query.fetchVendoor === 'true';

    const sDate = rawStart || rawDate || getCairoDateString();
    const eDate = rawEnd || rawDate || sDate;

    const report = await reconcileHistoricalRange(sDate, eDate, {
      autoRepair,
      fetchFromVendoorIfMissing: fetchFromVendoor,
    });
    res.json({ success: true, report });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Idempotent Historical Repair Endpoint (Repairs gaps, converts raw->canonical, links orders)
apiRouter.post('/historical/repair', async (req: Request, res: Response) => {
  try {
    const { date, startDate, endDate, actions } = req.body || {};
    const sDate = (startDate || date || getCairoDateString()).slice(0, 10);
    const eDate = (endDate || date || sDate).slice(0, 10);

    const report = await reconcileHistoricalRange(sDate, eDate, {
      autoRepair: true,
      fetchFromVendoorIfMissing: Array.isArray(actions) && actions.includes('fetch_vendoor'),
    });
    res.json({ success: true, report });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Chunked File Upload for Large Log Files (streaming, bounded memory, bypasses JSON body limit)
apiRouter.post('/logs/upload-chunk', async (req: Request, res: Response) => {
  try {
    const uploadId = (req.headers['x-upload-id'] as string) || '';
    const chunkIndex = parseInt((req.headers['x-chunk-index'] as string) || '0', 10);
    const totalChunks = parseInt((req.headers['x-total-chunks'] as string) || '1', 10);
    const fileName = decodeURIComponent((req.headers['x-file-name'] as string) || 'logs.xlsx');
    const fileSize = parseInt((req.headers['x-file-size'] as string) || '0', 10);

    if (!uploadId) {
      res.status(400).json({ success: false, error: 'x-upload-id header is required' });
      return;
    }

    const chunkBuffer = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(req.body || '');

    if (chunkBuffer.length === 0) {
      res.status(400).json({ success: false, error: 'Chunk buffer is empty' });
      return;
    }

    const result = await handleLogUploadChunk({
      uploadId,
      chunkIndex,
      totalChunks,
      fileName,
      fileSize,
      chunkBuffer,
    });

    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Poll active or recent import job
apiRouter.get('/logs/import-job/active', (_req: Request, res: Response) => {
  const job = getActiveOrRecentJob();
  res.json({ success: true, job });
});

// Poll specific import job by ID
apiRouter.get('/logs/import-job/:id', (req: Request, res: Response) => {
  const job = getImportJob(req.params.id);
  if (!job) {
    res.status(404).json({ success: false, error: 'Job not found' });
    return;
  }
  res.json({ success: true, job });
});

// Batch Logs Ingestion: Direct Multi-day Excel & CSV logs upload with automatic date discovery
apiRouter.post('/logs/import-batch', async (req: Request, res: Response) => {
  try {
    const { files } = req.body;
    if (!files || !Array.isArray(files) || files.length === 0) {
      res.status(400).json({ success: false, error: 'files array is required' });
      return;
    }

    const result = await importBatchLogFiles(files);
    // Explicitly convey genuine result status; do NOT fabricate success: true
    res.json({ success: result.success, result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Drilldown details for logs-based KPI pillars
apiRouter.get('/reports/logs-drilldown', (req: Request, res: Response) => {
  try {
    const {
      pillar = 'all',
      startDate,
      endDate,
      actor,
      search,
      page = '1',
      limit = '25',
      viewType,
    } = req.query;

    const sDate = ((startDate as string) || getCairoDateString()).slice(0, 10);
    const eDate = ((endDate as string) || sDate).slice(0, 10);

    const result = getDrilldownLogs({
      pillar: String(pillar),
      startDate: sDate,
      endDate: eDate,
      actor: actor ? String(actor) : undefined,
      search: search ? String(search) : undefined,
      page: parseInt(page as string, 10) || 1,
      limit: parseInt(limit as string, 10) || 25,
      viewType: viewType ? (String(viewType) as 'orders' | 'events') : undefined,
    });

    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// CSV Export for logs report
apiRouter.get('/reports/logs-export', (req: Request, res: Response) => {
  try {
    const { startDate, endDate, pillar = 'all', viewType } = req.query;
    const sDate = ((startDate as string) || getCairoDateString()).slice(0, 10);
    const eDate = ((endDate as string) || sDate).slice(0, 10);

    const drilldown = getDrilldownLogs({
      pillar: String(pillar),
      startDate: sDate,
      endDate: eDate,
      limit: 5000,
      viewType: viewType ? (String(viewType) as 'orders' | 'events') : undefined,
    });

    const header = [
      'المعرف',
      'توقيت الحدث (توقيت القاهرة)',
      'كود الطلب',
      'اسم المنفذ',
      'نوع الإجراء',
      'الحالة السابقة',
      'الحالة الناتجة',
      'الحقل المعدل',
      'القيمة السابقة',
      'القيمة الجديدة',
      'نص الحركة الأصلي الكامل',
    ];

    const escapeCsv = (str: any) => {
      if (str === null || str === undefined) return '""';
      const s = String(str).replace(/"/g, '""');
      return `"${s}"`;
    };

    const csvLines = [
      header.map(escapeCsv).join(','),
      ...drilldown.events.map((ev: any) => [
        ev.id,
        ev.event_timestamp,
        ev.order_code || 'عام',
        ev.actor_name || 'غير محدد',
        ev.action_type || '',
        ev.from_status || '',
        ev.to_status || '',
        ev.field_name || '',
        ev.old_value || '',
        ev.new_value || '',
        ev.raw_action_text || '',
      ].map(escapeCsv).join(',')),
    ];

    const csvContent = '\uFEFF' + csvLines.join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="logs_report_${pillar}_${sDate}_to_${eDate}.csv"`
    );
    res.send(csvContent);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 11. Comprehensive Operational Reports
apiRouter.get('/reports', (req: Request, res: Response) => {
  try {
    const { startDate, endDate, period } = req.query;
    let sDate = (startDate as string) || '';
    let eDate = (endDate as string) || '';

    if (period === 'today') {
      sDate = getCairoDateString();
      eDate = sDate;
    } else if (period === 'yesterday') {
      const now = new Date();
      const y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      sDate = getCairoDateString(y);
      eDate = sDate;
    } else if (period === 'last_7_days') {
      const now = new Date();
      const past = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      sDate = getCairoDateString(past);
      eDate = getCairoDateString(now);
    } else if (period === 'last_30_days') {
      const now = new Date();
      const past = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      sDate = getCairoDateString(past);
      eDate = getCairoDateString(now);
    }

    if (!sDate) sDate = getCairoDateString();
    if (!eDate) eDate = sDate;

    const startInterval = getCairoDateInterval(sDate);
    const endInterval = getCairoDateInterval(eDate);
    const startTime = startInterval.startCairo;
    const endTime = endInterval.endCairo;

    // Coverage status in range
    const covRows: any[] = db.prepare(`
      SELECT period_date, completion_status
      FROM historical_coverage
      WHERE period_date >= ? AND period_date <= ? AND source_domain = 'orders'
    `).all(sDate, eDate);

    // Orders Created in period with financial totals
    const createdData = db.prepare(`
      SELECT COUNT(*) as c, COALESCE(SUM(total_order), 0) as total_val FROM orders
      WHERE created_at_source >= ? AND created_at_source < ?
    `).get(startTime, endTime) as any;
    const createdCount = createdData?.c || 0;
    const totalOrderValue = Math.round((createdData?.total_val || 0) * 100) / 100;
    const averageOrderValue = createdCount > 0 ? Math.round((totalOrderValue / createdCount) * 10) / 10 : 0;

    // Multi-warehouse orders created in period
    const multiWarehouseCount = (db.prepare(`
      SELECT COUNT(*) as c FROM orders
      WHERE created_at_source >= ? AND created_at_source < ? AND multi_merchant_flag = 1
    `).get(startTime, endTime) as any)?.c || 0;

    const orderIdentitySql = `COALESCE(
      CASE WHEN c.order_id IS NOT NULL THEN 'ORD_ID_' || c.order_id END,
      CASE WHEN r.vendoor_order_id IS NOT NULL AND r.vendoor_order_id > 0 THEN 'VEND_ID_' || r.vendoor_order_id END,
      CASE WHEN c.order_code IS NOT NULL AND TRIM(c.order_code) != '' THEN 'CODE_' || LOWER(TRIM(c.order_code)) END
    )`;

    const orderHasIdentitySql = `((c.order_code IS NOT NULL AND TRIM(c.order_code) != '') OR c.order_id IS NOT NULL OR (r.vendoor_order_id IS NOT NULL AND r.vendoor_order_id > 0))`;

    // Orders Touched in period (distinct orders with canonical activity events in period)
    const touchedCount = (db.prepare(`
      SELECT COUNT(DISTINCT ${orderIdentitySql}) as c
      FROM canonical_activity_events c
      LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
      WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
        AND ${orderHasIdentitySql}
    `).get(startTime, endTime) as any)?.c || 0;

    // Events in period
    const totalEvents = (db.prepare(`
      SELECT COUNT(*) as c FROM canonical_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ?
    `).get(startTime, endTime) as any)?.c || 0;

    // Transitions in period
    const transitions: any[] = db.prepare(`
      SELECT from_status, to_status, COUNT(*) as count
      FROM canonical_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ? AND action_type = 'status_change'
      GROUP BY from_status, to_status
      ORDER BY count DESC
    `).all(startTime, endTime);

    // Key status transition counts
    let printedTransitions = 0;
    let pendingTransitions = 0;
    let processingTransitions = 0;
    let cancelingTransitions = 0;
    for (const t of transitions) {
      if (t.to_status === 'Printed') printedTransitions += t.count;
      else if (t.to_status === 'Pending') pendingTransitions += t.count;
      else if (t.to_status === 'Processing') processingTransitions += t.count;
      else if (t.to_status === 'Canceling') cancelingTransitions += t.count;
    }

    // Precise unique orders vs events for printed, canceled, and canceling
    const printedUniqueOrders = (db.prepare(`
      SELECT COUNT(DISTINCT ${orderIdentitySql}) as c
      FROM canonical_activity_events c
      LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
      WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
        AND ${orderHasIdentitySql}
        AND c.to_status = 'Printed'
    `).get(startTime, endTime) as any)?.c || 0;

    const printedEventsCount = (db.prepare(`
      SELECT COUNT(*) as c
      FROM canonical_activity_events c
      WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
        AND c.to_status = 'Printed'
    `).get(startTime, endTime) as any)?.c || 0;

    const canceledUniqueOrders = (db.prepare(`
      SELECT COUNT(DISTINCT ${orderIdentitySql}) as c
      FROM canonical_activity_events c
      LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
      WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
        AND ${orderHasIdentitySql}
        AND c.to_status = 'Canceled'
    `).get(startTime, endTime) as any)?.c || 0;

    const canceledEventsCount = (db.prepare(`
      SELECT COUNT(*) as c
      FROM canonical_activity_events c
      WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
        AND c.to_status = 'Canceled'
    `).get(startTime, endTime) as any)?.c || 0;

    const cancelingUniqueOrders = (db.prepare(`
      SELECT COUNT(DISTINCT ${orderIdentitySql}) as c
      FROM canonical_activity_events c
      LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
      WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
        AND ${orderHasIdentitySql}
        AND c.to_status = 'Canceling'
    `).get(startTime, endTime) as any)?.c || 0;

    const cancelingEventsCount = (db.prepare(`
      SELECT COUNT(*) as c
      FROM canonical_activity_events c
      WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
        AND c.to_status = 'Canceling'
    `).get(startTime, endTime) as any)?.c || 0;

    // Created Orders from canonical logs (with fallback to orders table)
    const createdLogsData: any = db.prepare(`
      SELECT 
        COUNT(DISTINCT ${orderIdentitySql}) as unique_orders,
        COUNT(*) as events_count
      FROM canonical_activity_events c
      LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
      WHERE c.event_timestamp >= ? AND c.event_timestamp < ?
        AND ${orderHasIdentitySql}
        AND c.action_type = 'order_created'
    `).get(startTime, endTime);

    const createdUniqueOrders = createdLogsData?.unique_orders > 0 ? createdLogsData.unique_orders : createdCount;
    const createdEventsCount = createdLogsData?.events_count || createdUniqueOrders;

    // Cancellations in period
    const cancellations: any[] = db.prepare(`
      SELECT to_status, COUNT(*) as count
      FROM canonical_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ? AND (to_status = 'Canceled' OR to_status = 'Canceling')
      GROUP BY to_status
    `).all(startTime, endTime);

    // Employee activity in period
    const employees: any[] = db.prepare(`
      SELECT 
        c.actor_name, 
        COUNT(*) as raw_action_count, 
        COUNT(DISTINCT ${orderIdentitySql}) as unique_orders,
        COUNT(DISTINCT CASE WHEN c.to_status = 'Printed' THEN ${orderIdentitySql} END) as printed_count,
        COUNT(DISTINCT CASE WHEN c.to_status = 'Canceled' THEN ${orderIdentitySql} END) as cancel_count,
        SUM(CASE WHEN c.to_status = 'Printed' THEN 1 ELSE 0 END) as printed_events_count,
        SUM(CASE WHEN c.to_status = 'Canceled' THEN 1 ELSE 0 END) as canceled_events_count,
        SUM(CASE WHEN c.to_status = 'Canceling' THEN 1 ELSE 0 END) as canceling_events_count
      FROM canonical_activity_events c
      LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
      WHERE c.event_timestamp >= ? AND c.event_timestamp < ? AND c.is_system_actor = 0
      GROUP BY c.actor_name
      ORDER BY raw_action_count DESC
    `).all(startTime, endTime).map((e: any) => ({
      ...e,
      action_count: e.raw_action_count,
    }));

    // Status breakdown of orders created in period
    let ordersByStatus: any[] = db.prepare(`
      SELECT 
        current_status as status, 
        COUNT(*) as count, 
        COALESCE(SUM(total_order), 0) as total_value
      FROM orders
      WHERE created_at_source >= ? AND created_at_source < ?
      GROUP BY current_status
      ORDER BY count DESC
    `).all(startTime, endTime);

    if (ordersByStatus.length === 0) {
      ordersByStatus = db.prepare(`
        SELECT 
          current_status as status, 
          COUNT(*) as count, 
          COALESCE(SUM(total_order), 0) as total_value
        FROM orders
        GROUP BY current_status
        ORDER BY count DESC
      `).all();
    }

    // Multi-warehouse vs single-warehouse detailed breakdown
    const multiWarehouseStats = db.prepare(`
      SELECT 
        COUNT(*) as total_orders,
        SUM(CASE WHEN multi_merchant_flag = 1 THEN 1 ELSE 0 END) as multi_orders,
        SUM(CASE WHEN multi_merchant_flag = 0 THEN 1 ELSE 0 END) as single_orders,
        COALESCE(SUM(CASE WHEN multi_merchant_flag = 1 THEN total_order ELSE 0 END), 0) as multi_value,
        COALESCE(SUM(CASE WHEN multi_merchant_flag = 0 THEN total_order ELSE 0 END), 0) as single_value
      FROM orders
      WHERE created_at_source >= ? AND created_at_source < ?
    `).get(startTime, endTime) as any;

    // Daily created trend
    const dailyCreated: any[] = db.prepare(`
      SELECT 
        substr(created_at_source, 1, 10) as date,
        COUNT(*) as created_count,
        COALESCE(SUM(total_order), 0) as daily_revenue
      FROM orders
      WHERE created_at_source >= ? AND created_at_source < ?
      GROUP BY date
      ORDER BY date ASC
    `).all(startTime, endTime);

    // Warehouses breakdown in period
    let warehouses: any[] = db.prepare(`
      SELECT 
        COALESCE(NULLIF(oi.warehouse_code, ''), TRIM(REPLACE(REPLACE(oi.warehouse_name, 'مخزن', ''), 'كود', '')), 'غير محدد') as warehouse_code,
        COALESCE(NULLIF(oi.warehouse_name, ''), 'غير محدد') as warehouse_name,
        COUNT(DISTINCT oi.order_id) as orders_count,
        SUM(oi.quantity) as items_quantity,
        COALESCE(SUM(o.total_order), 0) as associated_revenue
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE o.created_at_source >= ? AND o.created_at_source < ?
      GROUP BY COALESCE(NULLIF(oi.warehouse_name, ''), 'غير محدد')
      ORDER BY items_quantity DESC
      LIMIT 50
    `).all(startTime, endTime);

    if (warehouses.length === 0) {
      warehouses = db.prepare(`
        SELECT 
          COALESCE(NULLIF(oi.warehouse_code, ''), TRIM(REPLACE(REPLACE(oi.warehouse_name, 'مخزن', ''), 'كود', '')), 'غير محدد') as warehouse_code,
          COALESCE(NULLIF(oi.warehouse_name, ''), 'غير محدد') as warehouse_name,
          COUNT(DISTINCT oi.order_id) as orders_count,
          SUM(oi.quantity) as items_quantity,
          COALESCE(SUM(o.total_order), 0) as associated_revenue
        FROM order_items oi
        JOIN orders o ON oi.order_id = o.id
        GROUP BY COALESCE(NULLIF(oi.warehouse_name, ''), 'غير محدد')
        ORDER BY items_quantity DESC
        LIMIT 50
      `).all();
    }

    // Genuine Merchants breakdown in period
    let merchants: any[] = db.prepare(`
      SELECT 
        oi.merchant_code,
        COALESCE(oi.merchant_name, 'تاجر معتمد') as merchant_name,
        COUNT(DISTINCT oi.order_id) as orders_count,
        SUM(oi.quantity) as items_quantity,
        COALESCE(SUM(o.total_order), 0) as associated_revenue
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE o.created_at_source >= ? AND o.created_at_source < ?
        AND oi.merchant_code IS NOT NULL
        AND oi.merchant_code != ''
        AND oi.merchant_code NOT LIKE 'مخزن%'
        AND oi.merchant_code != 'غير محدد'
      GROUP BY oi.merchant_code
      ORDER BY items_quantity DESC
      LIMIT 50
    `).all(startTime, endTime);

    // Top Governorates
    let governorates: any[] = db.prepare(`
      SELECT governorate, COUNT(*) as count, COALESCE(SUM(total_order), 0) as total_value
      FROM orders
      WHERE created_at_source >= ? AND created_at_source < ? AND governorate IS NOT NULL AND length(governorate) > 0
      GROUP BY governorate
      ORDER BY count DESC
      LIMIT 12
    `).all(startTime, endTime);

    if (governorates.length === 0) {
      governorates = db.prepare(`
        SELECT governorate, COUNT(*) as count, COALESCE(SUM(total_order), 0) as total_value
        FROM orders
        WHERE governorate IS NOT NULL AND length(governorate) > 0
        GROUP BY governorate
        ORDER BY count DESC
        LIMIT 12
      `).all();
    }

    // Daily activity trend in period
    const timeline: any[] = db.prepare(`
      SELECT 
        substr(event_timestamp, 1, 10) as date,
        COUNT(*) as events_count,
        COUNT(DISTINCT order_code) as unique_orders
      FROM canonical_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ?
      GROUP BY date
      ORDER BY date ASC
    `).all(startTime, endTime);

    res.json({
      startDate: sDate,
      endDate: eDate,
      period: period || 'custom',
      createdCount: createdUniqueOrders,
      createdOrdersCount: createdUniqueOrders,
      createdEventsCount,
      totalOrderValue,
      averageOrderValue,
      multiWarehouseCount,
      multiWarehouseStats: {
        totalOrders: multiWarehouseStats?.total_orders || createdCount,
        multiOrders: multiWarehouseStats?.multi_orders || multiWarehouseCount,
        singleOrders: multiWarehouseStats?.single_orders || (createdCount - multiWarehouseCount),
        multiValue: Math.round((multiWarehouseStats?.multi_value || 0) * 100) / 100,
        singleValue: Math.round((multiWarehouseStats?.single_value || 0) * 100) / 100,
      },
      touchedCount,
      uniqueOrdersTouched: touchedCount,
      totalEvents,
      totalLogs: totalEvents,
      statusCounts: {
        printed: printedUniqueOrders,
        printedEvents: printedEventsCount,
        canceled: canceledUniqueOrders,
        canceledEvents: canceledEventsCount,
        canceling: cancelingUniqueOrders,
        cancelingEvents: cancelingEventsCount,
        created: createdUniqueOrders,
        createdEvents: createdEventsCount,
        pending: pendingTransitions,
        processing: processingTransitions,
      },
      confirmedOrdersCount: printedUniqueOrders,
      printedUniqueOrders,
      printedEventsCount,
      canceledOrdersCount: canceledUniqueOrders,
      canceledEventsCount,
      cancelingOrdersCount: cancelingUniqueOrders,
      cancelingEventsCount,
      ordersByStatus,
      dailyCreated,
      transitions,
      cancellations,
      employees,
      warehouses,
      merchants,
      governorates,
      timeline,
      coverage: {
        totalDays: covRows.length,
        completeDays: covRows.filter(r => r.completion_status === 'COMPLETE').length,
        partialDays: covRows.filter(r => r.completion_status === 'PARTIAL').length,
        isFullyComplete: covRows.length > 0 && covRows.every(r => r.completion_status === 'COMPLETE'),
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 12. Period A vs Period B Comparison
apiRouter.get('/comparison', (req: Request, res: Response) => {
  try {
    const { periodAStart, periodAEnd, periodBStart, periodBEnd } = req.query;
    if (!periodAStart || !periodAEnd || !periodBStart || !periodBEnd) {
      res.status(400).json({ error: 'periodAStart, periodAEnd, periodBStart, and periodBEnd are all required' });
      return;
    }

    const calcMetrics = (sDate: string, eDate: string) => {
      const sInterval = getCairoDateInterval(sDate);
      const eInterval = getCairoDateInterval(eDate);
      const startTime = sInterval.startCairo;
      const endTime = eInterval.endCairo;

      const created = (db.prepare('SELECT COUNT(*) as c FROM orders WHERE created_at_source >= ? AND created_at_source < ?').get(startTime, endTime) as any)?.c || 0;
      const touched = (db.prepare('SELECT COUNT(DISTINCT order_code) as c FROM canonical_activity_events WHERE event_timestamp >= ? AND event_timestamp < ? AND order_code IS NOT NULL').get(startTime, endTime) as any)?.c || 0;
      const events = (db.prepare('SELECT COUNT(*) as c FROM canonical_activity_events WHERE event_timestamp >= ? AND event_timestamp < ?').get(startTime, endTime) as any)?.c || 0;
      const printedTransitions = (db.prepare("SELECT COUNT(*) as c FROM canonical_activity_events WHERE event_timestamp >= ? AND event_timestamp < ? AND to_status = 'Printed'").get(startTime, endTime) as any)?.c || 0;
      const canceledTransitions = (db.prepare("SELECT COUNT(*) as c FROM canonical_activity_events WHERE event_timestamp >= ? AND event_timestamp < ? AND (to_status = 'Canceled' OR to_status = 'Canceling')").get(startTime, endTime) as any)?.c || 0;

      const sTimeMs = new Date(sDate).getTime();
      const eTimeMs = new Date(eDate).getTime();
      const daysCount = Math.max(1, Math.round((eTimeMs - sTimeMs) / (24 * 60 * 60 * 1000)) + 1);

      const covRows: any[] = db.prepare('SELECT completion_status FROM historical_coverage WHERE period_date >= ? AND period_date <= ?').all(sDate, eDate);
      const isComplete = covRows.length >= daysCount && covRows.every(r => r.completion_status === 'COMPLETE');

      return {
        startDate: sDate,
        endDate: eDate,
        daysCount,
        created,
        touched,
        events,
        printedTransitions,
        canceledTransitions,
        dailyCreated: Math.round((created / daysCount) * 10) / 10,
        dailyTouched: Math.round((touched / daysCount) * 10) / 10,
        dailyEvents: Math.round((events / daysCount) * 10) / 10,
        isComplete,
      };
    };

    const metricsA = calcMetrics(periodAStart as string, periodAEnd as string);
    const metricsB = calcMetrics(periodBStart as string, periodBEnd as string);

    const calcChange = (valA: number, valB: number) => {
      const diff = valB - valA;
      const pct = valA > 0 ? Math.round(((valB - valA) / valA) * 1000) / 10 : null;
      return { diff, pct };
    };

    res.json({
      periodA: metricsA,
      periodB: metricsB,
      comparison: {
        created: calcChange(metricsA.created, metricsB.created),
        touched: calcChange(metricsA.touched, metricsB.touched),
        events: calcChange(metricsA.events, metricsB.events),
        printedTransitions: calcChange(metricsA.printedTransitions, metricsB.printedTransitions),
        canceledTransitions: calcChange(metricsA.canceledTransitions, metricsB.canceledTransitions),
      },
      hasCoverageWarning: !metricsA.isComplete || !metricsB.isComplete,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 13. System Activity Logs Filter & Comprehensive Audit Intelligence
apiRouter.get('/logs', (req: Request, res: Response) => {
  try {
    const {
      date,
      startDate,
      endDate,
      actor,
      actionType,
      orderCode,
      matchStatus,
      isAdministrative,
      search,
      format,
      limit = '50',
      offset = '0',
    } = req.query;
    const conditions: string[] = [];
    const params: any[] = [];

    // Date range or single date filtering with exact Cairo date isolation bounds [startCairo, endCairo)
    if (startDate && endDate && typeof startDate === 'string' && typeof endDate === 'string') {
      const sInterval = getCairoDateInterval(startDate.trim());
      const eInterval = getCairoDateInterval(endDate.trim());
      conditions.push('c.event_timestamp >= ? AND c.event_timestamp < ?');
      params.push(sInterval.startCairo, eInterval.endCairo);
    } else if (date && typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date.trim())) {
      const interval = getCairoDateInterval(date.trim());
      conditions.push('c.event_timestamp >= ? AND c.event_timestamp < ?');
      params.push(interval.startCairo, interval.endCairo);
    }

    if (actor && actor !== 'all') {
      conditions.push('c.actor_name = ?');
      params.push(actor);
    }
    if (actionType && actionType !== 'all') {
      conditions.push('c.action_type = ?');
      params.push(actionType);
    }
    if (orderCode) {
      conditions.push('c.order_code = ?');
      params.push(orderCode);
    }
    if (matchStatus && matchStatus !== 'all') {
      conditions.push('c.order_match_status = ?');
      params.push(matchStatus);
    }
    if (isAdministrative && isAdministrative !== 'all') {
      conditions.push('c.is_administrative = ?');
      params.push(isAdministrative === '1' ? 1 : 0);
    }
    if (search && typeof search === 'string' && search.trim()) {
      const term = `%${search.trim()}%`;
      conditions.push('(c.order_code LIKE ? OR r.raw_action_text LIKE ? OR c.actor_name LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ? OR o.order_no LIKE ? OR c.field_name LIKE ? OR c.new_value LIKE ?)');
      params.push(term, term, term, term, term, term, term, term);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitNum = Math.min(500, Math.max(1, parseInt(limit as string, 10)));
    const offsetNum = Math.max(0, parseInt(offset as string, 10));

    // Support CSV Export
    if (format === 'csv') {
      const allRows: any[] = db.prepare(`
        SELECT 
          c.id, c.event_timestamp, c.actor_name, c.action_type, c.order_code,
          c.field_name, c.old_value, c.new_value, c.from_status, c.to_status,
          c.order_match_status, c.is_administrative,
          COALESCE(r.raw_action_text, '') as raw_action_text,
          r.observed_at as imported_at,
          r.source_hash,
          o.order_no, o.current_status as order_status, o.customer_name, o.customer_phone,
          o.governorate, o.total_order
        FROM canonical_activity_events c
        LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
        LEFT JOIN orders o ON c.order_id = o.id
        ${whereClause}
        ORDER BY c.event_timestamp DESC, c.id DESC
        LIMIT 5000
      `).all(...params);

      const header = ['المعرف', 'توقيت الحدث', 'اسم المنفذ', 'نوع الإجراء', 'كود الطلب', 'رقم الطلب', 'اسم العميل', 'رقم الهاتف', 'حالة الطلب', 'الحقل المعدل', 'القيمة السابقة', 'القيمة الجديدة', 'نص الحركة الأصلي الكامل', 'حالة الربط', 'توقيت الاستيراد'];
      const escapeCsv = (str: any) => {
        if (str === null || str === undefined) return '""';
        const s = String(str).replace(/"/g, '""');
        return `"${s}"`;
      };

      const csvLines = [
        header.map(escapeCsv).join(','),
        ...allRows.map(row => [
          row.id,
          row.event_timestamp,
          row.actor_name,
          row.action_type,
          row.order_code || 'عام',
          row.order_no || 'غير متوفر',
          row.customer_name || 'غير متوفر',
          row.customer_phone || 'غير متوفر',
          row.order_status || 'غير متوفر',
          row.field_name || 'غير متوفر',
          row.old_value || 'غير متوفر',
          row.new_value || 'غير متوفر',
          row.raw_action_text,
          row.order_match_status === 'MATCHED' ? 'مرتبط بطلب' : row.order_match_status === 'GENERAL_LOG' ? 'حركة عامة' : 'غير مرتبط',
          row.imported_at || 'غير متوفر',
        ].map(escapeCsv).join(',')),
      ];

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="vendoor_logs_${Date.now()}.csv"`);
      res.send('\uFEFF' + csvLines.join('\r\n'));
      return;
    }

    const total = (
      db.prepare(`
        SELECT COUNT(*) as c
        FROM canonical_activity_events c
        LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
        LEFT JOIN orders o ON c.order_id = o.id
        ${whereClause}
      `).get(...params) as any
    )?.c || 0;

    const logs: any[] = db.prepare(`
      SELECT 
        c.id, c.raw_event_id, c.order_code, c.actor_name, c.action_type, c.from_status, c.to_status,
        c.event_timestamp, c.storage_tier, c.is_system_actor, c.created_at,
        c.order_id, c.order_match_status, c.is_administrative, c.field_name, c.old_value, c.new_value,
        c.details_json,
        COALESCE(r.raw_action_text, '') as raw_action_text,
        r.observed_at as imported_at,
        r.source_hash,
        r.page_source,
        r.vendoor_order_id,
        o.order_no,
        o.current_status as order_current_status,
        o.customer_name,
        o.customer_phone,
        o.customer_phone_extra,
        o.governorate,
        o.address as order_address,
        o.total_order,
        o.affiliate_name,
        o.affiliate_code,
        o.distinct_merchant_count,
        o.delivery_rate
      FROM canonical_activity_events c
      LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
      LEFT JOIN orders o ON c.order_id = o.id
      ${whereClause}
      ORDER BY c.event_timestamp DESC, c.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, limitNum, offsetNum);

    // Compute high-level KPI stats for logs
    const todayCairo = getCairoDateString();
    const todayInterval = getCairoDateInterval(todayCairo);

    const statsRow = db.prepare(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN event_timestamp >= ? AND event_timestamp < ? THEN 1 END) as todayLogs,
        COUNT(DISTINCT actor_name) as activeEmployees,
        COUNT(CASE WHEN order_id IS NOT NULL THEN 1 END) as matchedWithOrders,
        COUNT(CASE WHEN is_administrative = 1 THEN 1 END) as administrativeLogs,
        COUNT(CASE WHEN order_match_status = 'UNRESOLVED' THEN 1 END) as unresolvedLogs,
        COUNT(CASE WHEN action_type = 'status_change' THEN 1 END) as statusChangesCount,
        COUNT(CASE WHEN action_type = 'note_added' THEN 1 END) as notesCount,
        COUNT(CASE WHEN action_type = 'address_edit' THEN 1 END) as addressEditsCount,
        COUNT(CASE WHEN action_type = 'phone_edit' THEN 1 END) as phoneEditsCount
      FROM canonical_activity_events
    `).get(todayInterval.startCairo, todayInterval.endCairo) as any;

    const stats = {
      total: statsRow?.total || 0,
      todayLogs: statsRow?.todayLogs || 0,
      activeEmployees: statsRow?.activeEmployees || 0,
      matchedWithOrders: statsRow?.matchedWithOrders || 0,
      administrativeLogs: statsRow?.administrativeLogs || 0,
      unresolvedLogs: statsRow?.unresolvedLogs || 0,
      statusChangesCount: statsRow?.statusChangesCount || 0,
      notesCount: statsRow?.notesCount || 0,
      addressEditsCount: statsRow?.addressEditsCount || 0,
      phoneEditsCount: statsRow?.phoneEditsCount || 0,
    };

    res.json({ logs, total, limit: limitNum, offset: offsetNum, stats });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Single Log Detail Inspector (returns full raw and linked data)
apiRouter.get('/logs/:id', (req: Request, res: Response) => {
  try {
    const logId = parseInt(req.params.id, 10);
    const log: any = db.prepare(`
      SELECT 
        c.*,
        COALESCE(r.raw_action_text, '') as raw_action_text,
        r.observed_at as imported_at,
        r.source_hash,
        r.page_source,
        r.vendoor_order_id,
        r.raw_html,
        o.id as linked_order_id,
        o.random_number,
        o.order_no,
        o.current_status as order_current_status,
        o.customer_name,
        o.customer_phone,
        o.customer_phone_extra,
        o.extra_phone_valid,
        o.governorate,
        o.address as order_address,
        o.total_order,
        o.total_price,
        o.shipping_cost,
        o.affiliate_name,
        o.affiliate_code,
        o.distinct_merchant_count,
        o.delivery_rate,
        o.delivery_rate_num,
        o.delivery_rate_denom,
        o.created_at_source as order_created_at
      FROM canonical_activity_events c
      LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
      LEFT JOIN orders o ON c.order_id = o.id
      WHERE c.id = ?
    `).get(logId);

    if (!log) {
      res.status(404).json({ error: 'Log entry not found' });
      return;
    }

    let items: any[] = [];
    if (log.linked_order_id) {
      items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(log.linked_order_id);
    }

    res.json({ log, items });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});



// Explicit Period Logs Fetch & Save Action: «جلب وحفظ لوجز الفترة»
apiRouter.post('/logs/fetch-period', async (req: Request, res: Response) => {
  try {
    const { startDate, endDate } = req.body;
    if (!startDate || !endDate) {
      res.status(400).json({ error: 'startDate and endDate are required in YYYY-MM-DD format' });
      return;
    }

    const cleanStart = String(startDate).slice(0, 10);
    const cleanEnd = String(endDate).slice(0, 10);

    const report = await fetchAndPersistLogsForPeriod(cleanStart, cleanEnd);
    res.json({ success: true, report });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 14. Historical Coverage Registry
apiRouter.get('/historical/coverage', (_req: Request, res: Response) => {
  try {
    const coverage: any[] = db.prepare(`
      SELECT * FROM historical_coverage
      ORDER BY period_date DESC, source_domain ASC
    `).all();

    res.json({ coverage });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get('/history/coverage', (_req: Request, res: Response) => {
  try {
    const coverage: any[] = db.prepare(`
      SELECT * FROM historical_coverage
      ORDER BY period_date DESC, source_domain ASC
    `).all();

    res.json({ coverage });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.all('/history/ensure', (_req: Request, res: Response) => {
  res.json({ success: true });
});

apiRouter.post('/historical/backfill', async (req: Request, res: Response) => {
  try {
    const { sourceDomain, date } = req.body;
    if (!sourceDomain || !date) {
      res.status(400).json({ error: 'sourceDomain and date are required' });
      return;
    }
    const result = await syncEngine.syncHistoricalDate(sourceDomain, date);
    res.json({ success: true, result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/history/backfill', async (req: Request, res: Response) => {
  try {
    const { sourceDomain, date } = req.body;
    if (!sourceDomain || !date) {
      res.status(400).json({ error: 'sourceDomain and date are required' });
      return;
    }
    const result = await syncEngine.syncHistoricalDate(sourceDomain, date);
    res.json({ success: true, result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 14b. Historical Logs with automatic fetch-on-missing & caching
apiRouter.get('/historical/logs', async (req: Request, res: Response) => {
  try {
    const rawDate = typeof req.query.date === 'string' && req.query.date.trim()
      ? req.query.date.trim().slice(0, 10)
      : getCairoDateString();

    const result = await getOrFetchHistoricalLogs(rawDate);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 14c. Global Search (Order Code, Phone, or Customer Name)
apiRouter.get('/search', (req: Request, res: Response) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!query || query.length < 2) {
      res.json({ results: [], total: 0, query });
      return;
    }

    const cleanDigits = query.replace(/[^\d]/g, '');
    let normalizedPhonePattern = '';
    if (cleanDigits.length >= 7) {
      const localPhone = cleanDigits.startsWith('20') ? cleanDigits.slice(2) : cleanDigits;
      normalizedPhonePattern = `%${localPhone}%`;
    }

    const isNumericId = /^\d+$/.test(query);

    const conditions: string[] = [];
    const params: any[] = [];

    conditions.push('random_number LIKE ?');
    params.push(`%${query}%`);

    conditions.push('order_no LIKE ?');
    params.push(`%${query}%`);

    conditions.push('customer_name LIKE ?');
    params.push(`%${query}%`);

    if (isNumericId) {
      conditions.push('vendoor_id = ?');
      params.push(parseInt(query, 10));
    }

    if (normalizedPhonePattern) {
      conditions.push('customer_phone LIKE ? OR customer_phone_extra LIKE ?');
      params.push(normalizedPhonePattern, normalizedPhonePattern);
    } else {
      conditions.push('customer_phone LIKE ? OR customer_phone_extra LIKE ?');
      params.push(`%${query}%`, `%${query}%`);
    }

    const sql = `
      SELECT 
        id, vendoor_id, random_number, order_no, order_type, current_status,
        customer_name, customer_phone, customer_phone_extra, extra_phone_valid, extra_phone_status,
        governorate, address, total_price, shipping_cost, total_order,
        delivery_rate, delivery_rate_num, delivery_rate_denom,
        cancel_rate, cancel_rate_num, cancel_rate_denom, total_customer_orders,
        created_at_source, last_observed_at
      FROM orders
      WHERE ${conditions.join(' OR ')}
      ORDER BY id DESC
      LIMIT 25
    `;

    const orders: any[] = db.prepare(sql).all(...params);

    const enrichedResults = orders.map(ord => {
      const items: any[] = db.prepare(`
        SELECT id, product_name, merchant_code, warehouse_name, sku, size, color, quantity, unit_price
        FROM order_items
        WHERE order_id = ?
      `).all(ord.id);

      const statusTimeline: any[] = db.prepare(`
        SELECT from_status, to_status, actor_name, observed_at as event_time, 'status_transition' as event_type
        FROM order_status_events
        WHERE order_id = ?
        ORDER BY observed_at ASC
      `).all(ord.id);

      const activityTimeline: any[] = db.prepare(`
        SELECT action_type, from_status, to_status, actor_name, raw_action_text, event_timestamp as event_time, 'log_event' as event_type
        FROM canonical_activity_events
        WHERE order_code = ? OR order_code = ?
        ORDER BY event_timestamp ASC
      `).all(ord.random_number, String(ord.vendoor_id));

      const hasPriorOrders = (ord.total_customer_orders !== null && ord.total_customer_orders > 0) ||
                             (ord.delivery_rate_denom !== null && ord.delivery_rate_denom > 0);
      const rateStatus = hasPriorOrders ? 'VERIFIED' : 'NO_HISTORY';

      return {
        ...ord,
        items,
        rateStatus,
        rateLabel: !hasPriorOrders ? 'لا توجد طلبات سابقة' : `${ord.delivery_rate}%`,
        timeline: [...statusTimeline, ...activityTimeline].sort((a, b) => (a.event_time > b.event_time ? 1 : -1)),
      };
    });

    res.json({
      query,
      total: enrichedResults.length,
      results: enrichedResults,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 14d. Excel Merchant Codes Import
apiRouter.post('/merchants/excel-import', (req: Request, res: Response) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(400).json({ error: 'rows must be a non-empty array of objects' });
      return;
    }

    const report = applyMerchantCodeMappings(rows);
    res.json({ success: true, report });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 14e. Reports Export (CSV with preserved text merchant codes and leading zeros)
apiRouter.get('/reports/export', (req: Request, res: Response) => {
  try {
    const { startDate, endDate, status } = req.query;
    const sDate = (startDate as string) || getCairoDateString();
    const eDate = (endDate as string) || sDate;
    const sInterval = getCairoDateInterval(sDate);
    const eInterval = getCairoDateInterval(eDate);

    const conditions = ['created_at_source >= ? AND created_at_source < ?'];
    const params: any[] = [sInterval.startCairo, eInterval.endCairo];

    if (status && status !== 'all') {
      conditions.push('current_status = ?');
      params.push(status);
    }

    const rows: any[] = db.prepare(`
      SELECT 
        o.vendoor_id, o.random_number, o.order_no, o.current_status,
        o.customer_name, o.customer_phone, o.customer_phone_extra,
        o.governorate, o.address, o.total_order, o.delivery_rate, o.created_at_source,
        i.product_name, i.sku, i.merchant_code, i.merchant_name, i.warehouse_code, i.warehouse_name, i.code_source, i.quantity
      FROM orders o
      LEFT JOIN order_items i ON o.id = i.order_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY o.id DESC
      LIMIT 1000
    `).all(...params);

    const headers = [
      'Vendoor ID', 'Random Code', 'Order No', 'Status',
      'Customer Name', 'Phone', 'Extra Phone', 'Governorate',
      'Address', 'Total Order', 'Delivery Rate', 'Created At',
      'Product Name', 'SKU', 'Merchant Code (Text)', 'Merchant Name', 'Warehouse Code', 'Warehouse Name', 'Code Source', 'Quantity'
    ];

    const escapeCsv = (val: any) => {
      if (val === null || val === undefined) return '""';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    const csvLines = [headers.join(',')];
    for (const r of rows) {
      csvLines.push([
        escapeCsv(r.vendoor_id),
        escapeCsv(r.random_number),
        escapeCsv(r.order_no),
        escapeCsv(r.current_status),
        escapeCsv(r.customer_name),
        escapeCsv(r.customer_phone),
        escapeCsv(r.customer_phone_extra),
        escapeCsv(r.governorate),
        escapeCsv(r.address),
        escapeCsv(r.total_order),
        escapeCsv(r.delivery_rate !== null ? `${r.delivery_rate}%` : 'N/A'),
        escapeCsv(r.created_at_source),
        escapeCsv(r.product_name),
        escapeCsv(r.sku || ''),
        escapeCsv(r.merchant_code || ''),
        escapeCsv(r.merchant_name || ''),
        escapeCsv(r.warehouse_code || ''),
        escapeCsv(r.warehouse_name || ''),
        escapeCsv(r.code_source || ''),
        escapeCsv(r.quantity || 1)
      ].join(','));
    }

    const csvContent = '\uFEFF' + csvLines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="vendoor_report_${sDate}_${eDate}.csv"`);
    res.send(csvContent);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 14f. Supabase Archival Worker Status & Trigger
apiRouter.get('/supabase/archive/status', (_req: Request, res: Response) => {
  res.json(getArchiveWorkerStatus());
});

apiRouter.post('/supabase/archive/run', async (_req: Request, res: Response) => {
  try {
    const result = await triggerArchivePass();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 15. Synchronization Triggers & Runs
apiRouter.post('/sync/trigger', async (_req: Request, res: Response) => {
  try {
    const status = await syncEngine.triggerManualSync();
    res.json({ success: true, status });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get('/sync/runs', (_req: Request, res: Response) => {
  try {
    const runs: any[] = db.prepare(`
      SELECT * FROM sync_runs
      ORDER BY id DESC
      LIMIT 30
    `).all();
    res.json({ runs });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.get('/sync/reconcile', async (_req: Request, res: Response) => {
  try {
    const report = await syncEngine.reconcileLiveWithVendoor();
    res.json(report);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 15b. Active Orders Verification & Absent Orders Review (Privacy-Preserving Audit)
apiRouter.get('/sync/absent-orders', (_req: Request, res: Response) => {
  try {
    const status = syncEngine.getStatus();
    const summary = status.absentOrdersSummary || {
      lastCheckedAt: null,
      totalActiveInDb: 0,
      presentInScan: 0,
      absentFromScan: 0,
      resolvedViaLogs: 0,
      confirmedViaLogs: 0,
      preservedUnresolved: 0,
      unresolvedRandomNumbers: [],
    };

    // Query absent and audit-resolved orders without customer PII (privacy-safe audit)
    const absentOrdersList = db.prepare(`
      SELECT 
        id, vendoor_id, random_number, order_no, current_status,
        validation_status, created_at_source, last_observed_at
      FROM orders
      WHERE validation_status IN ('UNRESOLVED_ABSENT_FROM_VIEW', 'RESOLVED_VIA_AUDIT_LOGS', 'CONFIRMED_VIA_AUDIT_LOGS')
      ORDER BY last_observed_at DESC
      LIMIT 100
    `).all();

    res.json({
      summary,
      orders: absentOrdersList,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/alerts/scan-multi-merchant', async (_req: Request, res: Response) => {
  try {
    const result = await syncEngine.scanAllConfirmedOrdersForMultiMerchant();
    res.json({ success: true, result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 16. Supabase Management & Migration
apiRouter.get('/supabase/status', async (_req: Request, res: Response) => {
  try {
    const status = await checkSupabaseConnection();
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/supabase/migrate', async (_req: Request, res: Response) => {
  try {
    const result = await applySupabaseMigration();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

apiRouter.post('/supabase/import-sqlite', async (_req: Request, res: Response) => {
  try {
    const result = await runSqliteToSupabaseImport();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 17. Server-Sent Events (SSE) Stream
apiRouter.get('/events/live', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ event: 'connected', payload: { time: new Date().toISOString() } })}\n\n`);

  const unregister = syncEngine.registerSSEClient(({ event, payload }) => {
    res.write(`data: ${JSON.stringify({ event, payload })}\n\n`);
  });

  const pingInterval = setInterval(() => {
    res.write(`data: ${JSON.stringify({ event: 'heartbeat', payload: { time: Date.now() } })}\n\n`);
  }, 15000);

  req.on('close', () => {
    clearInterval(pingInterval);
    unregister();
  });
});

// 18. System Settings & Configuration Status
apiRouter.get('/settings', async (_req: Request, res: Response) => {
  try {
    const email = process.env.VENDOOR_EMAIL || '';
    const maskedEmail = email ? email.replace(/^(.{2})(.*)(@.*)$/, (_, a, b, c) => `${a}***${c}`) : 'غير محدد';
    const dbSize = (db.prepare('SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()').get() as any)?.size || 0;
    const walMode = (db.prepare('PRAGMA journal_mode').get() as any)?.journal_mode || 'unknown';

    const supabaseStatus = await checkSupabaseConnection();
    const dbUrl = getDatabaseUrl();
    const maskedDbUrl = dbUrl
      ? dbUrl.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@')
      : null;

    res.json({
      authEmail: maskedEmail,
      loginUrl: process.env.VENDOOR_LOGIN_URL || 'https://aff.ven-door.com/dashboard/login',
      timezone: 'Africa/Cairo',
      syncInterval: parseInt(process.env.SYNC_INTERVAL_SECONDS || '25', 10),
      databaseMode: isSupabaseConfigured() ? 'SUPABASE_POSTGRES' : 'SQLITE_AWAITING_CONFIG',
      supabase: {
        configured: isSupabaseConfigured(),
        connected: supabaseStatus.isConnected,
        url: maskedDbUrl,
        latencyMs: supabaseStatus.latencyMs,
        database: supabaseStatus.database,
        host: supabaseStatus.host,
        missingTables: supabaseStatus.missingTables,
        presentTables: supabaseStatus.presentTables,
        tableCounts: supabaseStatus.tableCounts,
        canonicalConstraintPresent: supabaseStatus.canonicalConstraintPresent,
        error: supabaseStatus.error,
      },
      sqlite: {
        path: DB_PATH,
        sizeBytes: dbSize,
        journalMode: walMode,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
