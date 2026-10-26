import os from 'node:os';
import { getCairoDateString, getCairoDateInterval, isDateInHot } from './db.ts';
import {
  isSupabaseConfigured,
  getSupabasePool,
  pgQuery,
  checkSupabaseConnection,
} from './supabaseClient.ts';
export { getSupabasePool };
import { extractDistinctWarehouses, evaluateAddressQuality } from './syncEngine.ts';
import type { VendoorRawOrder } from './vendoorClient.ts';

export interface SystemDiagnosticData {
  timestamp: string;
  databaseType: 'SUPABASE_POSTGRES' | 'SQLITE_FALLBACK';
  instanceId: string;
  processPid: number;
  hostname: string;
  uptimeSeconds: number;
  dataSourceName: string;
  currentOperationalOrders: Record<string, number>;
  totalHistoricalOrders: number;
  totalEventsInSupabase: number;
  ordersCountByStatus: Record<string, number>;
  totalOrdersInDb: number;
  lastSuccessfulSyncAt: string | null;
  supabase: {
    isConfigured: boolean;
    isConnected: boolean;
    latencyMs: number | null;
    mode: string;
  };
}

/**
 * In production, Supabase PostgreSQL is the ONLY authoritative database.
 * SQLite is strictly restricted to offline test environments (process.env.NODE_ENV === 'test').
 */
export function isPrimaryPostgres(): boolean {
  const isRunningInTest =
    process.env.NODE_ENV === 'test' ||
    process.argv.some((arg) => arg.includes('.test.') || arg.includes('/tests/'));
  return isSupabaseConfigured() && !isRunningInTest;
}

export function getDataSourceIdentifier(): string {
  if (isPrimaryPostgres()) {
    const rawUrl = process.env.DATABASE_URL || '';
    const match = rawUrl.match(/@([^:/]+)/);
    return match ? `Supabase (${match[1]})` : 'Supabase PostgreSQL';
  }
  return `SQLite (Test Mode: ${process.env.DATABASE_PATH || 'data/vendoor_intelligence.sqlite'})`;
}

/**
 * Calculates Cairo business age buckets (0..4+ days) from timestamp
 */
export function calculateAgeBucket(dateStr?: string | null, nowMs = Date.now()): { ageInDays: number; ageBucket: string } {
  if (!dateStr) return { ageInDays: 0, ageBucket: '< 24h (يوم 1)' };
  const d = new Date(dateStr).getTime();
  if (isNaN(d)) return { ageInDays: 0, ageBucket: '< 24h (يوم 1)' };
  const diffHours = Math.max(0, (nowMs - d) / (1000 * 60 * 60));
  const ageInDays = Math.floor(diffHours / 24);

  if (ageInDays === 0) return { ageInDays, ageBucket: '< 24h (يوم 1)' };
  if (ageInDays === 1) return { ageInDays, ageBucket: '24-48h (يوم 2)' };
  if (ageInDays === 2) return { ageInDays, ageBucket: '48-72h (يوم 3)' };
  if (ageInDays === 3) return { ageInDays, ageBucket: '72-96h (يوم 4)' };
  return { ageInDays, ageBucket: '> 96h (5 أيام فأكثر)' };
}

/**
 * Fetch unified dashboard stats directly from Supabase PostgreSQL.
 * Separates live active queues ('New', 'Pending', 'Processing', 'Canceling' from current_operational_orders)
 * from historical archive ('Printed', 'Canceled' from canonical_activity_events).
 */
export async function getUnifiedDashboardStats(targetDate: string): Promise<any> {
  const cairoToday = getCairoDateString();
  const dateInterval = getCairoDateInterval(targetDate);
  const isToday = targetDate === cairoToday;
  const pool = getSupabasePool();

  // 1. Current Operational Counts for active queues
  // Query from current_operational_orders: 100% matched to Vendoor live scan
  const activeRes = await pool.query(`
    SELECT current_status, COUNT(*) as count
    FROM current_operational_orders
    GROUP BY current_status
  `);

  const currentCounts: Record<string, number> = {
    New: 0,
    Pending: 0,
    Processing: 0,
    Canceling: 0,
    Printed: 0,
    Canceled: 0,
  };

  for (const r of activeRes.rows) {
    if (r.current_status in currentCounts) {
      currentCounts[r.current_status] = parseInt(r.count, 10) || 0;
    }
  }

  // 2. Authoritative Printed Count for targetDate (Events & Unique Orders)
  const printedRes = await pool.query(`
    SELECT
      COUNT(DISTINCT order_code) as unique_orders,
      COUNT(*) as total_events
    FROM canonical_activity_events
    WHERE event_timestamp >= $1 AND event_timestamp < $2
      AND (to_status = 'Printed' OR action_type = 'confirmation')
      AND order_code IS NOT NULL AND order_code != ''
  `, [dateInterval.startCairo, dateInterval.endCairo]);

  const printedForDateCount = parseInt(printedRes.rows[0]?.unique_orders || '0', 10);
  const printedEventsCount = parseInt(printedRes.rows[0]?.total_events || '0', 10);

  // 3. Authoritative Canceled Count for targetDate (Events & Unique Orders)
  const cancelRes = await pool.query(`
    SELECT
      COUNT(DISTINCT order_code) as unique_orders,
      COUNT(*) as total_events
    FROM canonical_activity_events
    WHERE event_timestamp >= $1 AND event_timestamp < $2
      AND (to_status = 'Canceled' OR action_type = 'order_canceled')
      AND order_code IS NOT NULL AND order_code != ''
  `, [dateInterval.startCairo, dateInterval.endCairo]);

  const canceledForDateCount = parseInt(cancelRes.rows[0]?.unique_orders || '0', 10);
  const cancelEventsCount = parseInt(cancelRes.rows[0]?.total_events || '0', 10);

  currentCounts.Printed = printedForDateCount;
  currentCounts.Canceled = canceledForDateCount;

  // 4. Pending transitions inside targetDate
  const pendingEvtRes = await pool.query(`
    SELECT
      COUNT(DISTINCT order_code) as unique_orders,
      COUNT(*) as total_events
    FROM canonical_activity_events
    WHERE event_timestamp >= $1 AND event_timestamp < $2
      AND to_status = 'Pending'
      AND order_code IS NOT NULL AND order_code != ''
  `, [dateInterval.startCairo, dateInterval.endCairo]);

  const pendingUniqueOrders = parseInt(pendingEvtRes.rows[0]?.unique_orders || '0', 10);
  const pendingTotalEvents = parseInt(pendingEvtRes.rows[0]?.total_events || '0', 10);

  // 5. Processing transitions inside targetDate
  const procEvtRes = await pool.query(`
    SELECT
      COUNT(DISTINCT order_code) as unique_orders,
      COUNT(*) as total_events
    FROM canonical_activity_events
    WHERE event_timestamp >= $1 AND event_timestamp < $2
      AND to_status = 'Processing'
      AND order_code IS NOT NULL AND order_code != ''
  `, [dateInterval.startCairo, dateInterval.endCairo]);

  const processingUniqueOrders = parseInt(procEvtRes.rows[0]?.unique_orders || '0', 10);
  const processingTotalEvents = parseInt(procEvtRes.rows[0]?.total_events || '0', 10);

  // 6. Orders Created inside targetDate
  const createdRes = await pool.query(`
    SELECT COUNT(*) as count
    FROM orders
    WHERE created_at_source >= $1::timestamptz AND created_at_source < $2::timestamptz
  `, [dateInterval.startCairo, dateInterval.endCairo]);

  const createdOnDate = parseInt(createdRes.rows[0]?.count || '0', 10);

  // 7. Risk Indicators from live operational state
  const riskRes = await pool.query(`
    SELECT
      COUNT(CASE WHEN multi_merchant_flag::text IN ('1', 'true') THEN 1 END) as multi_merchant_total,
      COUNT(CASE WHEN extra_phone_valid::text IN ('0', 'false') THEN 1 END) as missing_phone_total,
      COUNT(CASE WHEN delivery_rate < 70 AND delivery_rate IS NOT NULL AND (delivery_rate_denom > 0 OR total_customer_orders > 0) THEN 1 END) as low_delivery_total
    FROM current_operational_orders
  `);

  const multiMerchantTotal = parseInt(riskRes.rows[0]?.multi_merchant_total || '0', 10);
  const missingExtraPhoneTotal = parseInt(riskRes.rows[0]?.missing_phone_total || '0', 10);
  const lowDeliveryRateTotal = parseInt(riskRes.rows[0]?.low_delivery_total || '0', 10);

  // Printed risk indicators (orders printed on targetDate that had risks)
  const printedRiskRes = await pool.query(`
    SELECT
      COUNT(CASE WHEN o.multi_merchant_flag::text IN ('1', 'true') THEN 1 END) as multi_merchant_printed,
      COUNT(CASE WHEN o.extra_phone_valid::text IN ('0', 'false') THEN 1 END) as missing_phone_printed,
      COUNT(CASE WHEN o.delivery_rate < 70 AND o.delivery_rate IS NOT NULL AND (o.delivery_rate_denom > 0 OR o.total_customer_orders > 0) THEN 1 END) as low_delivery_printed
    FROM orders o
    WHERE EXISTS (
      SELECT 1 FROM canonical_activity_events c
      WHERE (c.order_code = o.random_number OR c.order_code = o.order_no OR c.order_code = CAST(o.vendoor_id AS TEXT))
        AND c.event_timestamp >= $1 AND c.event_timestamp < $2
        AND (c.to_status = 'Printed' OR c.action_type = 'confirmation')
    )
  `, [dateInterval.startCairo, dateInterval.endCairo]);

  const multiMerchantPrinted = parseInt(printedRiskRes.rows[0]?.multi_merchant_printed || '0', 10);
  const missingExtraPhonePrinted = parseInt(printedRiskRes.rows[0]?.missing_phone_printed || '0', 10);
  const lowDeliveryRatePrinted = parseInt(printedRiskRes.rows[0]?.low_delivery_printed || '0', 10);

  // Open Alerts Count
  const alertsRes = await pool.query(`
    SELECT COUNT(*) as count FROM alerts WHERE status != 'RESOLVED'
  `);
  const openAlertsCount = parseInt(alertsRes.rows[0]?.count || '0', 10);

  // Pending Age Bucketing from current_operational_orders
  const pendingOrdersRes = await pool.query(`
    SELECT created_at_source FROM current_operational_orders WHERE current_status = 'Pending'
  `);
  const nowMs = Date.now();
  const pendingAge = {
    day1: 0,
    day2: 0,
    day3: 0,
    day4: 0,
    day5Plus: 0,
    total: pendingOrdersRes.rows.length,
  };
  for (const r of pendingOrdersRes.rows) {
    const { ageInDays } = calculateAgeBucket(r.created_at_source, nowMs);
    if (ageInDays === 0) pendingAge.day1++;
    else if (ageInDays === 1) pendingAge.day2++;
    else if (ageInDays === 2) pendingAge.day3++;
    else if (ageInDays === 3) pendingAge.day4++;
    else pendingAge.day5Plus++;
  }

  // Processing Age Bucketing from current_operational_orders
  const processingOrdersRes = await pool.query(`
    SELECT state_entry_at, created_at_source FROM current_operational_orders WHERE current_status = 'Processing'
  `);
  const processingAge = {
    day1: 0,
    day2: 0,
    day3: 0,
    day4: 0,
    day5Plus: 0,
    total: processingOrdersRes.rows.length,
  };
  for (const r of processingOrdersRes.rows) {
    const { ageInDays } = calculateAgeBucket(r.state_entry_at || r.created_at_source, nowMs);
    if (ageInDays === 0) processingAge.day1++;
    else if (ageInDays === 1) processingAge.day2++;
    else if (ageInDays === 2) processingAge.day3++;
    else if (ageInDays === 3) processingAge.day4++;
    else processingAge.day5Plus++;
  }

  const todayActivity = {
    Created: createdOnDate,
    Printed: printedForDateCount,
    Pending: pendingUniqueOrders,
    Processing: processingUniqueOrders,
    Canceling: 0,
    Canceled: canceledForDateCount,
    createdEvents: createdOnDate,
    printedEvents: printedEventsCount,
    pendingEvents: pendingTotalEvents,
    processingEvents: processingTotalEvents,
    cancelingEvents: 0,
    cancelEvents: cancelEventsCount,
  };

  const dayCumulative = {
    Pending: { uniqueOrders: todayActivity.Pending, totalEvents: todayActivity.pendingEvents },
    Processing: { uniqueOrders: todayActivity.Processing, totalEvents: todayActivity.processingEvents },
    Canceling: { uniqueOrders: todayActivity.Canceling, totalEvents: todayActivity.cancelingEvents },
    Printed: { uniqueOrders: todayActivity.Printed, totalEvents: todayActivity.printedEvents },
    Canceled: { uniqueOrders: todayActivity.Canceled, totalEvents: todayActivity.cancelEvents },
  };

  return {
    isPrimaryPostgres: true,
    selectedDate: targetDate,
    isToday,
    storageTier: isDateInHot(targetDate) ? 'HOT' : 'COLD',
    coverageStatus: isToday ? 'LIVE' : 'SYNCED',
    isCached: false,
    currentCounts,
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
    pendingAge,
    processingAge,
    databaseMode: 'SUPABASE_POSTGRES',
    supabaseConfigured: true,
  };
}

/**
 * Fetch orders list directly from Supabase PostgreSQL
 */
export async function getUnifiedOrdersList(opts: {
  status?: string;
  search?: string;
  page?: number;
  limit?: number;
  date?: string;
  startDate?: string;
  endDate?: string;
  multiMerchant?: boolean;
  lowDelivery?: boolean;
  noExtraPhone?: boolean;
  category?: string;
}): Promise<{ orders: any[]; total: number }> {
  const pool = getSupabasePool();
  const pageNum = Math.max(1, opts.page || 1);
  const pageSize = Math.min(100, Math.max(1, opts.limit || 50));
  const offset = (pageNum - 1) * pageSize;

  const conditions: string[] = [];
  const params: any[] = [];
  let pIdx = 1;

  if (opts.status && opts.status !== 'all') {
    conditions.push(`current_status = $${pIdx++}`);
    params.push(opts.status);
  }

  if (opts.startDate && opts.endDate) {
    const sInterval = getCairoDateInterval(opts.startDate);
    const eInterval = getCairoDateInterval(opts.endDate);
    conditions.push(`created_at_source >= $${pIdx++}::timestamptz AND created_at_source < $${pIdx++}::timestamptz`);
    params.push(sInterval.startCairo, eInterval.endCairo);
  } else if (opts.date) {
    const interval = getCairoDateInterval(opts.date);
    conditions.push(`created_at_source >= $${pIdx++}::timestamptz AND created_at_source < $${pIdx++}::timestamptz`);
    params.push(interval.startCairo, interval.endCairo);
  }

  if (opts.multiMerchant) {
    conditions.push("multi_merchant_flag::text IN ('1', 'true')");
  }
  if (opts.lowDelivery) {
    conditions.push('delivery_rate < 70 AND delivery_rate IS NOT NULL');
  }
  if (opts.noExtraPhone) {
    conditions.push("extra_phone_valid::text IN ('0', 'false')");
  }

  if (opts.search) {
    const q = `%${opts.search}%`;
    conditions.push(`(random_number ILIKE $${pIdx++} OR order_no ILIKE $${pIdx++} OR customer_phone ILIKE $${pIdx++} OR customer_name ILIKE $${pIdx++})`);
    params.push(q, q, q, q);
  }

  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRes = await pool.query(`SELECT COUNT(*) as total FROM orders ${whereSql}`, params);
  const total = parseInt(countRes.rows[0]?.total || '0', 10);

  const queryParams = [...params, pageSize, offset];
  const dataRes = await pool.query(`
    SELECT * FROM orders
    ${whereSql}
    ORDER BY id DESC
    LIMIT $${pIdx++} OFFSET $${pIdx++}
  `, queryParams);

  // Enrich with warehouse codes and names from order_items
  const orders = dataRes.rows;
  const orderIds = orders.map((o: any) => o.id);
  if (orderIds.length > 0) {
    try {
      const itemsRes = await pool.query(`
        SELECT order_id, warehouse_name, warehouse_code, merchant_code
        FROM order_items
        WHERE order_id = ANY($1)
      `, [orderIds]);

      const warehouseCodeMap: Record<number, string[]> = {};
      const warehouseNameMap: Record<number, string[]> = {};
      const merchantMap: Record<number, string[]> = {};

      for (const row of itemsRes.rows) {
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
        if (row.merchant_code && !merchantMap[row.order_id].includes(row.merchant_code)) {
          merchantMap[row.order_id].push(row.merchant_code);
        }
      }

      for (const ord of orders) {
        ord.warehouseCodes = warehouseCodeMap[ord.id] || [];
        ord.warehouseNames = warehouseNameMap[ord.id] || [];
        ord.merchantCodes = merchantMap[ord.id] || [];
      }
    } catch {}
  }

  return {
    orders,
    total,
  };
}

/**
 * Fetch single order details directly from Supabase PostgreSQL
 */
export async function getUnifiedOrderDetail(code: string): Promise<any> {
  const pool = getSupabasePool();
  const orderRes = await pool.query(`
    SELECT * FROM orders
    WHERE random_number = $1 OR vendoor_id = $2 OR order_no = $1
    LIMIT 1
  `, [code, isNaN(Number(code)) ? -1 : Number(code)]);

  if (orderRes.rows.length === 0) return null;
  const order = orderRes.rows[0];

  const [itemsRes, eventsRes, alertsRes, customerRes] = await Promise.all([
    pool.query(`SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC`, [order.id]),
    pool.query(`
      SELECT * FROM canonical_activity_events
      WHERE order_code = $1 OR order_id = $2
      ORDER BY event_timestamp ASC
    `, [order.random_number, order.id]),
    pool.query(`SELECT * FROM alerts WHERE order_id = $1 ORDER BY created_at DESC`, [order.id]),
    order.customer_phone ? pool.query(`
      SELECT * FROM customer_history_observations
      WHERE phone = $1
      ORDER BY observed_at DESC
      LIMIT 10
    `, [order.customer_phone]) : Promise.resolve({ rows: [] }),
  ]);

  return {
    ...order,
    items: itemsRes.rows,
    timeline: eventsRes.rows,
    alerts: alertsRes.rows,
    customerObservations: customerRes.rows,
  };
}

/**
 * Fetch pending orders categorized by age directly from current_operational_orders
 */
export async function getUnifiedPendingOrders(): Promise<{ orders: any[]; total: number }> {
  const pool = getSupabasePool();
  const res = await pool.query(`
    SELECT
      id, vendoor_id, random_number, customer_name, customer_phone,
      governorate, address, total_order, state_entry_at, created_at_source,
      distinct_merchant_count, delivery_rate, last_observed_at
    FROM current_operational_orders
    WHERE current_status = 'Pending'
    ORDER BY created_at_source ASC
  `);

  const nowMs = Date.now();
  const enriched = res.rows.map((o: any) => {
    const { ageInDays, ageBucket } = calculateAgeBucket(o.created_at_source, nowMs);
    return {
      ...o,
      ageInDays,
      ageBucket,
    };
  });

  return { orders: enriched, total: enriched.length };
}

/**
 * Fetch processing orders categorized by age directly from current_operational_orders
 */
export async function getUnifiedProcessingOrders(): Promise<{ orders: any[]; total: number }> {
  const pool = getSupabasePool();
  const res = await pool.query(`
    SELECT
      id, vendoor_id, random_number, customer_name, customer_phone,
      governorate, address, total_order, state_entry_at, created_at_source,
      distinct_merchant_count, delivery_rate, last_observed_at
    FROM current_operational_orders
    WHERE current_status = 'Processing'
    ORDER BY state_entry_at ASC
  `);

  const nowMs = Date.now();
  const enriched = res.rows.map((o: any) => {
    const { ageInDays, ageBucket } = calculateAgeBucket(o.state_entry_at || o.created_at_source, nowMs);
    return {
      ...o,
      processingStartedAt: o.state_entry_at,
      ageInDays,
      ageBucket,
    };
  });

  return { orders: enriched, total: enriched.length };
}

/**
 * Fetch canceling orders directly from current_operational_orders
 */
export async function getUnifiedCancelingOrders(): Promise<{ orders: any[]; total: number }> {
  const pool = getSupabasePool();
  const res = await pool.query(`
    SELECT
      id, vendoor_id, random_number, customer_name, customer_phone,
      governorate, address, total_order, state_entry_at, created_at_source,
      distinct_merchant_count, delivery_rate, last_observed_at
    FROM current_operational_orders
    WHERE current_status = 'Canceling'
    ORDER BY state_entry_at ASC
  `);

  return { orders: res.rows, total: res.rows.length };
}

/**
 * Fetch printed orders for targetDate from canonical_activity_events + orders
 */
export async function getUnifiedPrintedOrders(targetDate: string, category = 'all'): Promise<{ orders: any[]; total: number }> {
  const pool = getSupabasePool();
  const interval = getCairoDateInterval(targetDate);

  let categorySql = '';
  if (category === 'multi_warehouse') {
    categorySql = " AND o.multi_warehouse_flag::text IN ('1', 'true')";
  } else if (category === 'multi_merchant') {
    categorySql = " AND o.multi_merchant_flag::text IN ('1', 'true')";
  } else if (category === 'low_delivery') {
    categorySql = ' AND o.delivery_rate IS NOT NULL AND o.delivery_rate < 70 AND (o.delivery_rate_denom > 0 OR o.total_customer_orders > 0)';
  }

  const query = `
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
      SELECT DISTINCT ON (order_code) order_code, actor_name, event_timestamp, id
      FROM canonical_activity_events
      WHERE event_timestamp >= $1 AND event_timestamp < $2
        AND (to_status = 'Printed' OR action_type = 'confirmation')
      ORDER BY order_code, event_timestamp DESC
    ) c ON c.order_code = o.random_number OR c.order_code = o.order_no OR c.order_code = CAST(o.vendoor_id AS TEXT)
    WHERE (c.id IS NOT NULL OR o.printed_date::date = $3::date OR (o.printed_date >= $1::timestamptz AND o.printed_date < $2::timestamptz))
      ${categorySql}
    ORDER BY printed_date DESC, o.id DESC
  `;

  const res = await pool.query(query, [interval.startCairo, interval.endCairo, targetDate]);
  return { orders: res.rows, total: res.rows.length };
}

/**
 * Fetch risk drilldown orders directly from current_operational_orders in Supabase
 */
export async function getUnifiedRiskOrdersDrilldown(opts: {
  riskType: string;
  tab?: string;
  search?: string;
  page?: number;
  limit?: number;
  date?: string;
}): Promise<any> {
  const pool = getSupabasePool();
  const page = Math.max(0, opts.page || 0);
  const limit = Math.min(100, Math.max(1, opts.limit || 50));
  const offset = page * limit;
  const targetDate = opts.date || getCairoDateString();
  const interval = getCairoDateInterval(targetDate);

  let riskFilter = '';
  if (opts.riskType === 'multi_merchant' || opts.riskType === 'multi_warehouse') {
    riskFilter = 'multi_merchant_flag = 1 OR multi_warehouse_flag = 1 OR distinct_warehouse_count > 1';
  } else if (opts.riskType === 'missing_phone') {
    riskFilter = 'extra_phone_valid = 0';
  } else if (opts.riskType === 'low_delivery') {
    riskFilter = 'delivery_rate < 70 AND delivery_rate IS NOT NULL AND (delivery_rate_denom > 0 OR total_customer_orders > 0)';
  } else {
    riskFilter = 'multi_merchant_flag = 1';
  }

  let tableSource = 'current_operational_orders';
  let dateFilter = '';
  const params: any[] = [];
  let pIdx = 1;

  if (opts.tab === 'printed_today') {
    tableSource = 'orders';
    dateFilter = ` AND EXISTS (
      SELECT 1 FROM canonical_activity_events c
      WHERE (c.order_code = orders.random_number OR c.order_code = orders.order_no OR c.order_code = CAST(orders.vendoor_id AS TEXT))
        AND c.event_timestamp >= $${pIdx++} AND c.event_timestamp < $${pIdx++}
        AND (c.to_status = 'Printed' OR c.action_type = 'confirmation')
    )`;
    params.push(interval.startCairo, interval.endCairo);
  } else if (opts.tab && opts.tab !== 'all') {
    dateFilter = ` AND current_status = $${pIdx++}`;
    params.push(opts.tab);
  }

  let searchFilter = '';
  if (opts.search) {
    const q = `%${opts.search}%`;
    searchFilter = ` AND (random_number ILIKE $${pIdx++} OR order_no ILIKE $${pIdx++} OR customer_phone ILIKE $${pIdx++} OR customer_name ILIKE $${pIdx++})`;
    params.push(q, q, q, q);
  }

  const whereClause = `WHERE (${riskFilter}) ${dateFilter} ${searchFilter}`;

  const countRes = await pool.query(`SELECT COUNT(*) as total FROM ${tableSource} ${whereClause}`, params);
  const total = parseInt(countRes.rows[0]?.total || '0', 10);

  const dataRes = await pool.query(`
    SELECT * FROM ${tableSource}
    ${whereClause}
    ORDER BY id DESC
    LIMIT $${pIdx++} OFFSET $${pIdx++}
  `, [...params, limit, offset]);

  return {
    orders: dataRes.rows,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

/**
 * Fetch system logs directly from canonical_activity_events in Supabase
 */
export async function getUnifiedLogs(opts: {
  page?: number;
  limit?: number;
  search?: string;
  actionType?: string;
  startDate?: string;
  endDate?: string;
}): Promise<{ logs: any[]; total: number }> {
  const pool = getSupabasePool();
  const page = Math.max(1, opts.page || 1);
  const limit = Math.min(100, Math.max(1, opts.limit || 50));
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const params: any[] = [];
  let pIdx = 1;

  if (opts.actionType) {
    conditions.push(`action_type = $${pIdx++}`);
    params.push(opts.actionType);
  }

  if (opts.startDate && opts.endDate) {
    const s = getCairoDateInterval(opts.startDate).startCairo;
    const e = getCairoDateInterval(opts.endDate).endCairo;
    conditions.push(`event_timestamp >= $${pIdx++} AND event_timestamp < $${pIdx++}`);
    params.push(s, e);
  }

  if (opts.search) {
    const q = `%${opts.search}%`;
    conditions.push(`(order_code ILIKE $${pIdx++} OR actor_name ILIKE $${pIdx++} OR field_name ILIKE $${pIdx++})`);
    params.push(q, q, q);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRes = await pool.query(`SELECT COUNT(*) as total FROM canonical_activity_events ${whereClause}`, params);
  const total = parseInt(countRes.rows[0]?.total || '0', 10);

  const dataRes = await pool.query(`
    SELECT * FROM canonical_activity_events
    ${whereClause}
    ORDER BY event_timestamp DESC, id DESC
    LIMIT $${pIdx++} OFFSET $${pIdx++}
  `, [...params, limit, offset]);

  return { logs: dataRes.rows, total };
}

/**
 * Fetch team performance directly from canonical_activity_events in Supabase
 */
export async function getUnifiedTeamPerformance(targetDate: string): Promise<any[]> {
  const pool = getSupabasePool();
  const interval = getCairoDateInterval(targetDate);

  const res = await pool.query(`
    SELECT
      actor_name,
      COUNT(*) as total_actions,
      COUNT(DISTINCT order_code) as unique_orders,
      COUNT(CASE WHEN to_status = 'Printed' OR action_type = 'confirmation' THEN 1 END) as confirmations_count,
      COUNT(CASE WHEN to_status = 'Canceled' OR action_type = 'order_canceled' THEN 1 END) as cancellations_count,
      COUNT(CASE WHEN to_status = 'Processing' THEN 1 END) as processing_count,
      COUNT(CASE WHEN is_administrative = 1 THEN 1 END) as admin_edits_count,
      MIN(event_timestamp) as first_action_time,
      MAX(event_timestamp) as last_action_time
    FROM canonical_activity_events
    WHERE event_timestamp >= $1 AND event_timestamp < $2
      AND actor_name IS NOT NULL AND actor_name != ''
      AND is_system_actor = 0
    GROUP BY actor_name
    ORDER BY total_actions DESC
  `, [interval.startCairo, interval.endCairo]);

  return res.rows;
}

/**
 * Fetch alerts directly from Supabase
 */
export async function getUnifiedAlerts(opts: { status?: string }): Promise<any[]> {
  const pool = getSupabasePool();
  const filter = opts.status && opts.status !== 'all' ? 'WHERE status = $1' : '';
  const params = opts.status && opts.status !== 'all' ? [opts.status] : [];
  const res = await pool.query(`
    SELECT * FROM alerts
    ${filter}
    ORDER BY created_at DESC
    LIMIT 200
  `, params);
  return res.rows;
}

/**
 * Resolve an alert directly in Supabase
 */
export async function resolveUnifiedAlert(
  alertId: number,
  notes = '',
  resolvedBy = 'مشرف العمليات'
): Promise<any> {
  const pool = getSupabasePool();
  const nowIso = new Date().toISOString();
  await pool.query(`
    UPDATE alerts SET
      status = 'RESOLVED',
      resolved_at = $1,
      resolved_by = $2,
      resolution_notes = $3,
      updated_at = $1
    WHERE id = $4
  `, [nowIso, resolvedBy, notes, alertId]);
  return { success: true };
}

/**
 * Fetch canceled orders for target date from Supabase
 */
export async function getUnifiedCanceledOrders(targetDate: string): Promise<{ orders: any[]; total: number }> {
  const pool = getSupabasePool();
  const interval = getCairoDateInterval(targetDate);
  const res = await pool.query(`
    SELECT
      c.id, c.order_code, c.actor_name as canceled_by, c.event_timestamp as canceled_at,
      c.action_type, c.from_status, c.to_status, c.field_name, c.old_value, c.new_value,
      c.order_match_status,
      o.id as order_id, o.random_number, o.order_no, o.current_status as order_current_status,
      o.customer_name, o.customer_phone, o.governorate, o.address, o.total_order, o.delivery_rate
    FROM canonical_activity_events c
    LEFT JOIN orders o ON c.order_id = o.id OR c.order_code = o.random_number OR c.order_code = o.order_no OR c.order_code = CAST(o.vendoor_id AS TEXT)
    WHERE c.event_timestamp >= $1 AND c.event_timestamp < $2
      AND (c.to_status = 'Canceled' OR c.action_type = 'order_canceled')
    ORDER BY c.event_timestamp DESC
  `, [interval.startCairo, interval.endCairo]);
  return { orders: res.rows, total: res.rows.length };
}

/**
 * Comprehensive Operational Reports directly from Supabase PostgreSQL
 */
export async function getUnifiedOperationalReports(opts: {
  startDate?: string;
  endDate?: string;
  period?: string;
}): Promise<any> {
  const pool = getSupabasePool();
  let sDate = opts.startDate || '';
  let eDate = opts.endDate || '';

  if (opts.period === 'today') {
    sDate = getCairoDateString();
    eDate = sDate;
  } else if (opts.period === 'yesterday') {
    const now = new Date();
    const y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    sDate = getCairoDateString(y);
    eDate = sDate;
  } else if (opts.period === 'last_7_days') {
    const now = new Date();
    const past = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    sDate = getCairoDateString(past);
    eDate = getCairoDateString(now);
  } else if (opts.period === 'last_30_days') {
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

  const [
    covRes,
    createdRes,
    multiWhRes,
    touchedRes,
    totalEventsRes,
    transitionsRes,
    printedRes,
    cancelRes,
    cancelingRes,
    employeesRes,
    statusRes,
    dailyRes,
    govRes,
    timelineRes,
  ] = await Promise.all([
    pool.query(`
      SELECT period_date::text, completion_status
      FROM historical_coverage
      WHERE period_date >= $1 AND period_date <= $2 AND source_domain = 'logs'
    `, [sDate, eDate]),
    pool.query(`
      SELECT COUNT(*) as c, COALESCE(SUM(total_order), 0) as total_val
      FROM orders
      WHERE created_at_source >= $1::timestamptz AND created_at_source < $2::timestamptz
    `, [startTime, endTime]),
    pool.query(`
      SELECT COUNT(*) as c
      FROM orders
      WHERE created_at_source >= $1::timestamptz AND created_at_source < $2::timestamptz AND multi_merchant_flag = 1
    `, [startTime, endTime]),
    pool.query(`
      SELECT COUNT(DISTINCT order_code) as c
      FROM canonical_activity_events
      WHERE event_timestamp >= $1 AND event_timestamp < $2
        AND order_code IS NOT NULL AND order_code != ''
    `, [startTime, endTime]),
    pool.query(`
      SELECT COUNT(*) as c
      FROM canonical_activity_events
      WHERE event_timestamp >= $1 AND event_timestamp < $2
    `, [startTime, endTime]),
    pool.query(`
      SELECT from_status, to_status, COUNT(*) as count
      FROM canonical_activity_events
      WHERE event_timestamp >= $1 AND event_timestamp < $2 AND action_type = 'status_change'
      GROUP BY from_status, to_status
      ORDER BY count DESC
    `, [startTime, endTime]),
    pool.query(`
      SELECT COUNT(DISTINCT order_code) as unique_orders, COUNT(*) as total_events
      FROM canonical_activity_events
      WHERE event_timestamp >= $1 AND event_timestamp < $2
        AND (to_status = 'Printed' OR action_type = 'confirmation')
        AND order_code IS NOT NULL AND order_code != ''
    `, [startTime, endTime]),
    pool.query(`
      SELECT COUNT(DISTINCT order_code) as unique_orders, COUNT(*) as total_events
      FROM canonical_activity_events
      WHERE event_timestamp >= $1 AND event_timestamp < $2
        AND (to_status = 'Canceled' OR action_type = 'order_canceled')
        AND order_code IS NOT NULL AND order_code != ''
    `, [startTime, endTime]),
    pool.query(`
      SELECT COUNT(DISTINCT order_code) as unique_orders, COUNT(*) as total_events
      FROM canonical_activity_events
      WHERE event_timestamp >= $1 AND event_timestamp < $2
        AND to_status = 'Canceling'
        AND order_code IS NOT NULL AND order_code != ''
    `, [startTime, endTime]),
    pool.query(`
      SELECT
        actor_name,
        COUNT(*) as raw_action_count,
        COUNT(DISTINCT order_code) as unique_orders,
        COUNT(DISTINCT CASE WHEN to_status = 'Printed' OR action_type = 'confirmation' THEN order_code END) as printed_count,
        COUNT(DISTINCT CASE WHEN to_status = 'Canceled' OR action_type = 'order_canceled' THEN order_code END) as cancel_count,
        SUM(CASE WHEN to_status = 'Printed' OR action_type = 'confirmation' THEN 1 ELSE 0 END) as printed_events_count,
        SUM(CASE WHEN to_status = 'Canceled' OR action_type = 'order_canceled' THEN 1 ELSE 0 END) as canceled_events_count,
        SUM(CASE WHEN to_status = 'Canceling' THEN 1 ELSE 0 END) as canceling_events_count
      FROM canonical_activity_events
      WHERE event_timestamp >= $1 AND event_timestamp < $2 AND is_system_actor = 0
      GROUP BY actor_name
      ORDER BY raw_action_count DESC
    `, [startTime, endTime]),
    pool.query(`
      SELECT current_status as status, COUNT(*) as count, COALESCE(SUM(total_order), 0) as total_value
      FROM orders
      WHERE created_at_source >= $1::timestamptz AND created_at_source < $2::timestamptz
      GROUP BY current_status
      ORDER BY count DESC
    `, [startTime, endTime]),
    pool.query(`
      SELECT DATE(created_at_source)::text as date, COUNT(*) as created_count, COALESCE(SUM(total_order), 0) as daily_revenue
      FROM orders
      WHERE created_at_source >= $1::timestamptz AND created_at_source < $2::timestamptz
      GROUP BY DATE(created_at_source)
      ORDER BY date ASC
    `, [startTime, endTime]),
    pool.query(`
      SELECT governorate, COUNT(*) as count, COALESCE(SUM(total_order), 0) as total_value
      FROM orders
      WHERE created_at_source >= $1::timestamptz AND created_at_source < $2::timestamptz
        AND governorate IS NOT NULL AND length(governorate) > 0
      GROUP BY governorate
      ORDER BY count DESC
      LIMIT 12
    `, [startTime, endTime]),
    pool.query(`
      SELECT DATE(event_timestamp)::text as date, COUNT(*) as events_count, COUNT(DISTINCT order_code) as unique_orders
      FROM canonical_activity_events
      WHERE event_timestamp >= $1 AND event_timestamp < $2
      GROUP BY DATE(event_timestamp)
      ORDER BY date ASC
    `, [startTime, endTime]),
  ]);

  const covRows = covRes.rows;
  const createdCount = parseInt(createdRes.rows[0]?.c || '0', 10);
  const totalOrderValue = Math.round(parseFloat(createdRes.rows[0]?.total_val || '0') * 100) / 100;
  const averageOrderValue = createdCount > 0 ? Math.round((totalOrderValue / createdCount) * 10) / 10 : 0;
  const multiWarehouseCount = parseInt(multiWhRes.rows[0]?.c || '0', 10);
  const touchedCount = parseInt(touchedRes.rows[0]?.c || '0', 10);
  const totalEvents = parseInt(totalEventsRes.rows[0]?.c || '0', 10);

  const printedUniqueOrders = parseInt(printedRes.rows[0]?.unique_orders || '0', 10);
  const printedEventsCount = parseInt(printedRes.rows[0]?.total_events || '0', 10);
  const canceledUniqueOrders = parseInt(cancelRes.rows[0]?.unique_orders || '0', 10);
  const canceledEventsCount = parseInt(cancelRes.rows[0]?.total_events || '0', 10);
  const cancelingUniqueOrders = parseInt(cancelingRes.rows[0]?.unique_orders || '0', 10);
  const cancelingEventsCount = parseInt(cancelingRes.rows[0]?.total_events || '0', 10);

  let pendingTransitions = 0;
  let processingTransitions = 0;
  for (const t of transitionsRes.rows) {
    const c = parseInt(t.count, 10);
    if (t.to_status === 'Pending') pendingTransitions += c;
    else if (t.to_status === 'Processing') processingTransitions += c;
  }

  const employees = employeesRes.rows.map((e: any) => ({
    ...e,
    action_count: parseInt(e.raw_action_count, 10),
    unique_orders: parseInt(e.unique_orders, 10),
    printed_count: parseInt(e.printed_count, 10),
    cancel_count: parseInt(e.cancel_count, 10),
    printed_events_count: parseInt(e.printed_events_count, 10),
    canceled_events_count: parseInt(e.canceled_events_count, 10),
    canceling_events_count: parseInt(e.canceling_events_count, 10),
  }));

  return {
    startDate: sDate,
    endDate: eDate,
    period: opts.period || 'custom',
    createdCount,
    createdOrdersCount: createdCount,
    createdEventsCount: createdCount,
    totalOrderValue,
    averageOrderValue,
    multiWarehouseCount,
    multiWarehouseStats: {
      totalOrders: createdCount,
      multiOrders: multiWarehouseCount,
      singleOrders: Math.max(0, createdCount - multiWarehouseCount),
      multiValue: 0,
      singleValue: 0,
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
      created: createdCount,
      createdEvents: createdCount,
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
    ordersByStatus: statusRes.rows,
    dailyCreated: dailyRes.rows,
    transitions: transitionsRes.rows,
    cancellations: [],
    employees,
    warehouses: [],
    merchants: [],
    governorates: govRes.rows,
    timeline: timelineRes.rows,
    coverage: {
      totalDays: covRows.length,
      completeDays: covRows.filter((r: any) => r.completion_status === 'COMPLETE').length,
      partialDays: covRows.filter((r: any) => r.completion_status === 'PARTIAL').length,
      isFullyComplete: covRows.length > 0 && covRows.every((r: any) => r.completion_status === 'COMPLETE'),
    },
  };
}

/**
 * Generates comprehensive, production system diagnostic data.
 * Adheres strictly to Section 8 of architecture requirements:
 * Exposes databaseType, currentOperationalOrders, totalHistoricalOrders, totalEvents,
 * and Supabase connection metrics.
 */
export async function getSystemDiagnostic(): Promise<SystemDiagnosticData> {
  const timestamp = new Date().toISOString();
  const connStatus = await checkSupabaseConnection(false);
  const pool = getSupabasePool();

  // 1. Current Operational Orders by status from current_operational_orders
  const currentOperationalOrders: Record<string, number> = {
    New: 0,
    Pending: 0,
    Processing: 0,
    Canceling: 0,
  };

  let totalHistoricalOrders = 0;
  let totalEventsInSupabase = 0;
  let lastSuccessfulSyncAt: string | null = null;

  try {
    const cooRes = await pool.query(`
      SELECT current_status, COUNT(*) as c
      FROM current_operational_orders
      GROUP BY current_status
    `);
    for (const r of cooRes.rows) {
      if (r.current_status in currentOperationalOrders) {
        currentOperationalOrders[r.current_status] = parseInt(r.c, 10);
      }
    }

    // 2. Total Historical Orders
    const ordersRes = await pool.query(`SELECT COUNT(*) as c FROM orders`);
    totalHistoricalOrders = parseInt(ordersRes.rows[0]?.c || '0', 10);

    // 3. Total Events in Supabase
    const eventsRes = await pool.query(`SELECT COUNT(*) as c FROM canonical_activity_events`);
    totalEventsInSupabase = parseInt(eventsRes.rows[0]?.c || '0', 10);

    // 4. Last sync from sync_runs
    const syncRes = await pool.query(`
      SELECT completed_at FROM sync_runs
      WHERE status = 'SUCCESS'
      ORDER BY id DESC LIMIT 1
    `);
    if (syncRes.rows.length > 0) {
      lastSuccessfulSyncAt = syncRes.rows[0]?.completed_at;
    }
  } catch (err: any) {
    console.warn('[UnifiedDb] Error querying diagnostic from Supabase:', err.message);
  }

  const totalCurrentActive = Object.values(currentOperationalOrders).reduce((a, b) => a + b, 0);

  return {
    timestamp,
    databaseType: 'SUPABASE_POSTGRES',
    instanceId: `${process.pid}@${os.hostname()}`,
    processPid: process.pid,
    hostname: os.hostname(),
    uptimeSeconds: Math.floor(process.uptime()),
    dataSourceName: getDataSourceIdentifier(),
    currentOperationalOrders,
    totalHistoricalOrders,
    totalEventsInSupabase,
    ordersCountByStatus: currentOperationalOrders,
    totalOrdersInDb: totalCurrentActive > 0 ? totalCurrentActive : totalHistoricalOrders,
    lastSuccessfulSyncAt,
    supabase: {
      isConfigured: connStatus.isConfigured,
      isConnected: connStatus.isConnected,
      latencyMs: connStatus.latencyMs,
      mode: connStatus.mode,
    },
  };
}

