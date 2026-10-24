/**
 * Unified Risk Indicators & Drilldown Service
 * 
 * Provides 100% mathematical consistency between:
 * 1. Dashboard Risk Indicator Cards (/api/dashboard/stats)
 * 2. Risk Details Modal (/api/dashboard/risk-orders)
 * 3. Comprehensive Orders View (/api/orders)
 * 
 * Guarantees:
 * - Order deduplication (distinct order primary keys, preventing Cartesian product duplication from line item JOINs)
 * - Strict Africa/Cairo midnight (00:00:00) day scoping for "today_printed"
 * - Separation between warehouse codes (logistical location) and merchant codes (commercial supplier)
 * - Authentic delivery rate fraction (X/Y) with exclusion of history-less (0/0) customers
 */

import { db, getCairoDateInterval, getCairoDateString } from './db.ts';

export type RiskType = 'multi_merchant' | 'no_extra_phone' | 'low_delivery';

export interface RiskOrdersParams {
  riskType: RiskType;
  tab?: string; // 'all' | 'today_printed' | 'Pending' | 'Processing' | 'Printed' | 'Canceling' | 'Canceled' | 'New'
  search?: string;
  page?: number;
  limit?: number;
  date?: string; // YYYY-MM-DD (defaults to Cairo today)
}

export interface EnrichedRiskItem {
  id: number;
  product_name: string;
  warehouse_name: string | null;
  warehouse_code: string | null;
  merchant_code: string | null;
  merchant_name: string | null;
  quantity: number;
  unit_price: number;
  sku: string | null;
}

export interface EnrichedRiskOrder {
  id: number;
  vendoor_id: number;
  random_number: string;
  order_no: string | null;
  current_status: string;
  customer_name: string | null;
  customer_phone: string;
  customer_phone_extra: string | null;
  extra_phone_valid: number;
  extra_phone_status: string | null;
  governorate: string | null;
  address: string | null;
  total_order: number;
  total_price: number;
  shipping_cost: number;
  created_at_source: string | null;
  printed_date: string | null;
  multi_merchant_flag: number;
  distinct_merchant_count: number;
  delivery_rate: number | null;
  delivery_rate_num: number | null;
  delivery_rate_denom: number | null;
  cancel_rate: number | null;
  cancel_rate_num: number | null;
  cancel_rate_denom: number | null;
  total_customer_orders: number | null;
  customer_last_order_status: string | null;
  is_printed_today: boolean;
  items: EnrichedRiskItem[];
  warehouses: Array<{ name: string; code: string }>;
  merchantCodes: string[];
}

export interface RiskOrdersResult {
  success: boolean;
  riskType: RiskType;
  targetDate: string;
  totalSystemMatching: number;
  todayPrintedMatching: number;
  filteredCount: number;
  tabCounts: {
    all: number;
    today_printed: number;
    Pending: number;
    Processing: number;
    Printed: number;
    Canceling: number;
    Canceled: number;
    New: number;
  };
  orders: EnrichedRiskOrder[];
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Automatically reflects logged extra phone additions and edits from canonical_activity_events
 * directly into orders table, ensuring the "no_extra_phone" indicator is 100% LIVE and orders with
 * added extra phones never count as missing extra phone.
 */
export function syncLoggedExtraPhonesToOrders(): { updatedCount: number } {
  try {
    const latestPhoneEvents: any[] = db.prepare(`
      SELECT cae.order_code, cae.order_id, cae.new_value, cae.action_type, cae.event_timestamp
      FROM canonical_activity_events cae
      INNER JOIN (
        SELECT order_code, MAX(event_timestamp) as max_time
        FROM canonical_activity_events
        WHERE action_type IN ('extra_phone_added', 'extra_phone_edit')
          AND order_code IS NOT NULL
        GROUP BY order_code
      ) latest ON latest.order_code = cae.order_code AND latest.max_time = cae.event_timestamp
      WHERE cae.action_type IN ('extra_phone_added', 'extra_phone_edit')
    `).all();

    if (!latestPhoneEvents || latestPhoneEvents.length === 0) {
      return { updatedCount: 0 };
    }

    const updatePhoneStmt = db.prepare(`
      UPDATE orders
      SET customer_phone_extra = ?,
          extra_phone_valid = ?,
          extra_phone_status = ?,
          updated_at = COALESCE(?, updated_at)
      WHERE (id = ? OR random_number = ? OR order_no = ? OR CAST(vendoor_id AS TEXT) = ?)
        AND (
          customer_phone_extra IS NULL 
          OR customer_phone_extra != ? 
          OR extra_phone_status != ?
        )
    `);

    let updatedCount = 0;
    db.exec('BEGIN TRANSACTION;');
    try {
      for (const ev of latestPhoneEvents) {
        const rawNew = (ev.new_value || '').trim();
        const cleanPhone = rawNew.replace(/[\s\-\+]/g, '');
        // Egyptian mobile phone validation
        const isValid = /^(01[0125]\d{8}|201[0125]\d{8})$/.test(cleanPhone);
        const isPresent = cleanPhone.length >= 10 && isValid;
        const status = isPresent ? 'PRESENT' : (rawNew === '' ? 'CONFIRMED_ABSENT' : 'INVALID');

        const res = updatePhoneStmt.run(
          rawNew || null,
          isValid ? 1 : 0,
          status,
          ev.event_timestamp,
          ev.order_id || -1,
          ev.order_code,
          ev.order_code,
          ev.order_code,
          rawNew || '',
          status
        );
        if (res.changes > 0) {
          updatedCount += Number(res.changes);
        }
      }
      db.exec('COMMIT;');
    } catch (txErr) {
      db.exec('ROLLBACK;');
      throw txErr;
    }

    return { updatedCount };
  } catch (err: any) {
    console.warn('[riskService] Warning in syncLoggedExtraPhonesToOrders:', err.message);
    return { updatedCount: 0 };
  }
}

/**
 * Returns the exact WHERE clause fragment for the specified risk type.
 */
export function getRiskConditionSql(riskType: RiskType, tableAlias = 'o'): string {
  switch (riskType) {
    case 'multi_merchant':
      return `${tableAlias}.multi_merchant_flag = 1`;
    case 'no_extra_phone':
      return `(
        (${tableAlias}.extra_phone_status = 'CONFIRMED_ABSENT' OR (${tableAlias}.customer_phone_extra IS NULL OR TRIM(${tableAlias}.customer_phone_extra) = '' OR ${tableAlias}.customer_phone_extra = 'N/A' OR ${tableAlias}.customer_phone_extra = ${tableAlias}.customer_phone OR ${tableAlias}.extra_phone_valid = 0) AND ${tableAlias}.extra_phone_status != 'PRESENT')
      )`;
    case 'low_delivery':
      return `(${tableAlias}.delivery_rate IS NOT NULL AND ${tableAlias}.delivery_rate < 70 AND (${tableAlias}.delivery_rate_denom > 0 OR ${tableAlias}.total_customer_orders > 0) AND NOT (${tableAlias}.delivery_rate = 0 AND (${tableAlias}.cancel_rate = 0 OR ${tableAlias}.cancel_rate IS NULL)))`;
    default:
      return '1=1';
  }
}

/**
 * Common query for Dashboard stats to ensure exact 1:1 match with drilldown modal
 */
export function getDashboardRiskStats(targetDate?: string): {
  multiMerchantTotal: number;
  multiMerchantPrinted: number;
  missingExtraPhoneTotal: number;
  missingExtraPhonePrinted: number;
  lowDeliveryRateTotal: number;
  lowDeliveryRatePrinted: number;
} {
  // Guarantee live reflection of logged extra phones
  syncLoggedExtraPhonesToOrders();
  const cairoDate = (targetDate && /^\d{4}-\d{2}-\d{2}$/.test(targetDate.trim()))
    ? targetDate.trim()
    : getCairoDateString();
  const dateInterval = getCairoDateInterval(cairoDate);

  // 1. Total counts across entire system
  const totalStatsRow = db.prepare(`
    SELECT
      COUNT(DISTINCT CASE WHEN ${getRiskConditionSql('multi_merchant', 'o')} THEN o.id END) as multiMerchantTotal,
      COUNT(DISTINCT CASE WHEN ${getRiskConditionSql('no_extra_phone', 'o')} THEN o.id END) as missingExtraPhoneTotal,
      COUNT(DISTINCT CASE WHEN ${getRiskConditionSql('low_delivery', 'o')} THEN o.id END) as lowDeliveryRateTotal
    FROM orders o
  `).get() as any;

  // 2. Today's printed counts (orders confirmed today in Cairo logs from 00:00:00)
  const printedStatsRow = db.prepare(`
    SELECT
      COUNT(DISTINCT CASE WHEN ${getRiskConditionSql('multi_merchant', 'o')} THEN o.id END) as multiMerchantPrinted,
      COUNT(DISTINCT CASE WHEN ${getRiskConditionSql('no_extra_phone', 'o')} THEN o.id END) as missingExtraPhonePrinted,
      COUNT(DISTINCT CASE WHEN ${getRiskConditionSql('low_delivery', 'o')} THEN o.id END) as lowDeliveryRatePrinted
    FROM orders o
    WHERE (
      o.random_number IN (
        SELECT order_code FROM canonical_activity_events
        WHERE event_timestamp >= ? AND event_timestamp < ?
          AND (to_status = 'Printed' OR action_type = 'confirmation')
      )
      OR o.order_no IN (
        SELECT order_code FROM canonical_activity_events
        WHERE event_timestamp >= ? AND event_timestamp < ?
          AND (to_status = 'Printed' OR action_type = 'confirmation')
      )
      OR substr(o.printed_date, 1, 10) = ?
      OR (o.printed_date >= ? AND o.printed_date < ?)
    )
  `).get(
    dateInterval.startCairo, dateInterval.endCairo,
    dateInterval.startCairo, dateInterval.endCairo,
    cairoDate, dateInterval.startCairo, dateInterval.endCairo
  ) as any;

  return {
    multiMerchantTotal: totalStatsRow?.multiMerchantTotal || 0,
    multiMerchantPrinted: printedStatsRow?.multiMerchantPrinted || 0,
    missingExtraPhoneTotal: totalStatsRow?.missingExtraPhoneTotal || 0,
    missingExtraPhonePrinted: printedStatsRow?.missingExtraPhonePrinted || 0,
    lowDeliveryRateTotal: totalStatsRow?.lowDeliveryRateTotal || 0,
    lowDeliveryRatePrinted: printedStatsRow?.lowDeliveryRatePrinted || 0,
  };
}

/**
 * Fetches enriched risk orders for the Risk Details Modal with exact server-side
 * pagination, tab filtering, and multi-field search.
 */
export function getRiskOrdersDrilldown(params: RiskOrdersParams): RiskOrdersResult {
  // Guarantee live reflection of logged extra phones
  syncLoggedExtraPhonesToOrders();

  const {
    riskType,
    tab = 'all',
    search = '',
    page = 0,
    limit = 50,
    date,
  } = params;

  const cairoDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date.trim()))
    ? date.trim()
    : getCairoDateString();
  const dateInterval = getCairoDateInterval(cairoDate);

  const baseRiskCondition = getRiskConditionSql(riskType, 'o');
  const todayStart = dateInterval.startCairo;
  const todayEnd = dateInterval.endCairo;

  // Subquery determining whether an order is printed today using indexed scans
  const todayPrintedJoin = '';
  const todayPrintedWhere = `(
    o.random_number IN (
      SELECT order_code FROM canonical_activity_events
      WHERE event_timestamp >= '${todayStart}' AND event_timestamp < '${todayEnd}'
        AND (to_status = 'Printed' OR action_type = 'confirmation')
    )
    OR o.order_no IN (
      SELECT order_code FROM canonical_activity_events
      WHERE event_timestamp >= '${todayStart}' AND event_timestamp < '${todayEnd}'
        AND (to_status = 'Printed' OR action_type = 'confirmation')
    )
    OR substr(o.printed_date, 1, 10) = '${cairoDate}'
    OR (o.printed_date >= '${todayStart}' AND o.printed_date < '${todayEnd}')
  )`;

  // 1. Compute Tab Counts across all statuses for this risk type
  const tabCountsRow = db.prepare(`
    SELECT
      COUNT(DISTINCT o.id) as all_count,
      COUNT(DISTINCT CASE WHEN ${todayPrintedWhere} THEN o.id END) as today_printed_count,
      COUNT(DISTINCT CASE WHEN o.current_status = 'Pending' THEN o.id END) as pending_count,
      COUNT(DISTINCT CASE WHEN o.current_status = 'Processing' THEN o.id END) as processing_count,
      COUNT(DISTINCT CASE WHEN o.current_status = 'Printed' THEN o.id END) as printed_count,
      COUNT(DISTINCT CASE WHEN o.current_status = 'Canceling' THEN o.id END) as canceling_count,
      COUNT(DISTINCT CASE WHEN o.current_status = 'Canceled' THEN o.id END) as canceled_count,
      COUNT(DISTINCT CASE WHEN o.current_status = 'New' OR o.current_status = 'اوردر جديد' THEN o.id END) as new_count
    FROM orders o
    ${todayPrintedJoin}
    WHERE ${baseRiskCondition}
  `).get() as any;

  const tabCounts = {
    all: tabCountsRow?.all_count || 0,
    today_printed: tabCountsRow?.today_printed_count || 0,
    Pending: tabCountsRow?.pending_count || 0,
    Processing: tabCountsRow?.processing_count || 0,
    Printed: tabCountsRow?.printed_count || 0,
    Canceling: tabCountsRow?.canceling_count || 0,
    Canceled: tabCountsRow?.canceled_count || 0,
    New: tabCountsRow?.new_count || 0,
  };

  const totalSystemMatching = tabCounts.all;
  const todayPrintedMatching = tabCounts.today_printed;

  // 2. Build filter conditions
  const filterConditions: string[] = [baseRiskCondition];
  const queryParams: any[] = [];

  // Tab filtering
  if (tab === 'today_printed') {
    filterConditions.push(todayPrintedWhere);
  } else if (tab === 'New') {
    filterConditions.push("(o.current_status = 'New' OR o.current_status = 'اوردر جديد')");
  } else if (tab && tab !== 'all') {
    filterConditions.push('o.current_status = ?');
    queryParams.push(tab);
  }

  // Search filtering
  if (search && search.trim()) {
    const cleanSearch = `%${search.trim()}%`;
    filterConditions.push(`(
      o.random_number LIKE ? OR
      o.order_no LIKE ? OR
      o.customer_name LIKE ? OR
      o.customer_phone LIKE ? OR
      o.customer_phone_extra LIKE ? OR
      o.governorate LIKE ? OR
      EXISTS (
        SELECT 1 FROM order_items oi
        WHERE oi.order_id = o.id
          AND (oi.product_name LIKE ? OR oi.merchant_code LIKE ? OR oi.warehouse_name LIKE ? OR oi.warehouse_code LIKE ?)
      )
    )`);
    queryParams.push(
      cleanSearch, cleanSearch, cleanSearch, cleanSearch, cleanSearch, cleanSearch,
      cleanSearch, cleanSearch, cleanSearch, cleanSearch
    );
  }

  const whereClause = `WHERE ${filterConditions.join(' AND ')}`;

  // 3. Count matching filtered records
  const countRow = db.prepare(`
    SELECT COUNT(DISTINCT o.id) as c
    FROM orders o
    ${todayPrintedJoin}
    ${whereClause}
  `).get(...queryParams) as any;

  const filteredCount = countRow?.c || 0;

  // 4. Retrieve paginated orders
  const limitNum = Math.min(200, Math.max(1, limit));
  const offsetNum = Math.max(0, page) * limitNum;

  const orderRows: any[] = db.prepare(`
    SELECT
      o.id,
      o.vendoor_id,
      o.random_number,
      o.order_no,
      o.current_status,
      o.customer_name,
      o.customer_phone,
      o.customer_phone_extra,
      o.extra_phone_valid,
      o.extra_phone_status,
      o.governorate,
      o.address,
      o.total_order,
      o.total_price,
      o.shipping_cost,
      o.created_at_source,
      o.printed_date,
      o.multi_merchant_flag,
      o.distinct_merchant_count,
      o.delivery_rate,
      o.delivery_rate_num,
      o.delivery_rate_denom,
      o.cancel_rate,
      o.cancel_rate_num,
      o.cancel_rate_denom,
      o.total_customer_orders,
      o.customer_last_order_status,
      CASE WHEN ${todayPrintedWhere} THEN 1 ELSE 0 END as is_printed_today
    FROM orders o
    ${todayPrintedJoin}
    ${whereClause}
    ORDER BY o.id DESC
    LIMIT ? OFFSET ?
  `).all(...queryParams, limitNum, offsetNum);

  // 5. Enrich each order with its line items, warehouses, and merchant codes
  const enrichedOrders: EnrichedRiskOrder[] = orderRows.map((ord) => {
    const itemsRaw: any[] = db.prepare(`
      SELECT
        id,
        product_name,
        warehouse_name,
        warehouse_code,
        merchant_code,
        merchant_name,
        quantity,
        unit_price,
        sku
      FROM order_items
      WHERE order_id = ?
    `).all(ord.id);

    const warehousesMap = new Map<string, string>();
    const merchantCodesSet = new Set<string>();

    for (const it of itemsRaw) {
      if (it.warehouse_name || it.warehouse_code) {
        const whCode = it.warehouse_code || it.warehouse_name;
        const whName = it.warehouse_name || it.warehouse_code;
        warehousesMap.set(whCode, whName);
      }
      if (it.merchant_code && it.merchant_code !== 'غير محدد') {
        merchantCodesSet.add(it.merchant_code);
      }
    }

    const warehouses = Array.from(warehousesMap.entries()).map(([code, name]) => ({ code, name }));
    const merchantCodes = Array.from(merchantCodesSet);

    return {
      id: ord.id,
      vendoor_id: ord.vendoor_id,
      random_number: ord.random_number,
      order_no: ord.order_no,
      current_status: ord.current_status,
      customer_name: ord.customer_name,
      customer_phone: ord.customer_phone,
      customer_phone_extra: ord.customer_phone_extra,
      extra_phone_valid: ord.extra_phone_valid ? 1 : 0,
      extra_phone_status: ord.extra_phone_status,
      governorate: ord.governorate,
      address: ord.address,
      total_order: Number(ord.total_order || 0),
      total_price: Number(ord.total_price || 0),
      shipping_cost: Number(ord.shipping_cost || 0),
      created_at_source: ord.created_at_source,
      printed_date: ord.printed_date,
      multi_merchant_flag: ord.multi_merchant_flag ? 1 : 0,
      distinct_merchant_count: Number(ord.distinct_merchant_count || 1),
      delivery_rate: ord.delivery_rate !== null ? Number(ord.delivery_rate) : null,
      delivery_rate_num: ord.delivery_rate_num !== null ? Number(ord.delivery_rate_num) : null,
      delivery_rate_denom: ord.delivery_rate_denom !== null ? Number(ord.delivery_rate_denom) : null,
      cancel_rate: ord.cancel_rate !== null ? Number(ord.cancel_rate) : null,
      cancel_rate_num: ord.cancel_rate_num !== null ? Number(ord.cancel_rate_num) : null,
      cancel_rate_denom: ord.cancel_rate_denom !== null ? Number(ord.cancel_rate_denom) : null,
      total_customer_orders: ord.total_customer_orders !== null ? Number(ord.total_customer_orders) : null,
      customer_last_order_status: ord.customer_last_order_status,
      is_printed_today: Boolean(ord.is_printed_today),
      items: itemsRaw,
      warehouses,
      merchantCodes,
    };
  });

  const totalPages = Math.ceil(filteredCount / limitNum);

  return {
    success: true,
    riskType,
    targetDate: cairoDate,
    totalSystemMatching,
    todayPrintedMatching,
    filteredCount,
    tabCounts,
    orders: enrichedOrders,
    page,
    limit: limitNum,
    totalPages,
  };
}
