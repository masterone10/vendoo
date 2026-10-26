import os from 'node:os';
import { db, getCairoDateString, getCairoDateInterval, isDateInHot, getHotThresholdDate } from './db.ts';
import { isSupabaseConfigured, getSupabasePool, pgQuery, type SupabaseConnectionStatus, checkSupabaseConnection } from './supabaseClient.ts';
import { syncEngine, extractDistinctWarehouses, evaluateAddressQuality } from './syncEngine.ts';
import { parseLogActionDetails } from './logDetailsParser.ts';
import type { VendoorRawOrder } from './vendoorClient.ts';

export interface SystemDiagnosticData {
  timestamp: string;
  databaseType: 'SUPABASE_POSTGRES' | 'SQLITE_FALLBACK';
  instanceId: string;
  processPid: number;
  hostname: string;
  uptimeSeconds: number;
  dataSourceName: string;
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

export function isPrimaryPostgres(): boolean {
  const isRunningInTest = process.env.NODE_ENV === 'test' ||
    process.argv.some(arg => arg.includes('.test.') || arg.includes('/tests/'));
  return isSupabaseConfigured() && !isRunningInTest;
}

export function getDataSourceIdentifier(): string {
  if (isPrimaryPostgres()) {
    const rawUrl = process.env.DATABASE_URL || '';
    const match = rawUrl.match(/@([^:/]+)/);
    return match ? `Supabase (${match[1]})` : 'Supabase PostgreSQL';
  }
  return `SQLite (${process.env.DATABASE_PATH || 'data/vendoor_intelligence.sqlite'})`;
}

/**
 * Fetch unified dashboard stats directly from Supabase PostgreSQL (or fallback to SQLite)
 */
export async function getUnifiedDashboardStats(targetDate: string): Promise<any> {
  const cairoToday = getCairoDateString();
  const dateInterval = getCairoDateInterval(targetDate);
  const isToday = targetDate === cairoToday;

  if (isPrimaryPostgres()) {
    try {
      const pool = getSupabasePool();

      // 1. Current counts for active states
      const activeStatesQuery = isToday
        ? `
            SELECT current_status, COUNT(*) as count
            FROM orders
            WHERE current_status IN ('New', 'Pending', 'Processing', 'Canceling')
              AND validation_status != 'UNRESOLVED_ABSENT_FROM_VIEW'
            GROUP BY current_status
          `
        : `
            SELECT current_status, COUNT(*) as count
            FROM orders
            WHERE created_at_source >= $1::timestamptz AND created_at_source < $2::timestamptz
              AND current_status IN ('New', 'Pending', 'Processing', 'Canceling')
              AND validation_status != 'UNRESOLVED_ABSENT_FROM_VIEW'
            GROUP BY current_status
          `;

      const activeParams = isToday ? [] : [dateInterval.startCairo, dateInterval.endCairo];
      const activeRes = await pool.query(activeStatesQuery, activeParams);

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

      // 2. Authoritative Printed Count for targetDate
      const printedRes = await pool.query(`
        SELECT COUNT(DISTINCT o_id) as count FROM (
          SELECT c.order_code as o_id
          FROM canonical_activity_events c
          WHERE c.event_timestamp >= $1 AND c.event_timestamp < $2
            AND (c.to_status = 'Printed' OR c.action_type = 'confirmation')
            AND c.order_code IS NOT NULL AND c.order_code != ''
          UNION
          SELECT o.random_number as o_id
          FROM orders o
          WHERE (o.printed_date::date = $3::date OR (o.printed_date >= $1::timestamptz AND o.printed_date < $2::timestamptz))
            AND o.current_status = 'Printed'
        ) sub
      `, [dateInterval.startCairo, dateInterval.endCairo, targetDate]);

      const printedForDateCount = parseInt(printedRes.rows[0]?.count || '0', 10);

      const printedEvtRes = await pool.query(`
        SELECT COUNT(*) as count
        FROM canonical_activity_events c
        WHERE c.event_timestamp >= $1 AND c.event_timestamp < $2
          AND (c.to_status = 'Printed' OR c.action_type = 'confirmation')
          AND c.order_code IS NOT NULL AND c.order_code != ''
      `, [dateInterval.startCairo, dateInterval.endCairo]);

      const printedEventsCount = parseInt(printedEvtRes.rows[0]?.count || '0', 10) || printedForDateCount;

      // 3. Authoritative Canceled Count for targetDate
      const cancelRes = await pool.query(`
        SELECT COUNT(DISTINCT c.order_code) as count
        FROM canonical_activity_events c
        WHERE c.event_timestamp >= $1 AND c.event_timestamp < $2
          AND (c.to_status = 'Canceled' OR c.action_type = 'order_canceled')
          AND c.order_code IS NOT NULL AND c.order_code != ''
      `, [dateInterval.startCairo, dateInterval.endCairo]);

      const canceledForDateCount = parseInt(cancelRes.rows[0]?.count || '0', 10);

      const cancelEvtRes = await pool.query(`
        SELECT COUNT(*) as count
        FROM canonical_activity_events c
        WHERE c.event_timestamp >= $1 AND c.event_timestamp < $2
          AND (c.to_status = 'Canceled' OR c.action_type = 'order_canceled')
          AND c.order_code IS NOT NULL AND c.order_code != ''
      `, [dateInterval.startCairo, dateInterval.endCairo]);

      const cancelEventsCount = parseInt(cancelEvtRes.rows[0]?.count || '0', 10) || canceledForDateCount;

      currentCounts.Printed = printedForDateCount;
      currentCounts.Canceled = canceledForDateCount;

      // 4. Pending transitions for targetDate
      const pendingRes = await pool.query(`
        SELECT
          COUNT(DISTINCT o_id) as unique_orders,
          COUNT(*) as total_events
        FROM (
          SELECT order_code as o_id FROM canonical_activity_events
          WHERE event_timestamp >= $1 AND event_timestamp < $2
            AND to_status = 'Pending'
            AND order_code IS NOT NULL AND order_code != ''
          UNION ALL
          SELECT random_number as o_id FROM order_status_events
          WHERE observed_at >= $1 AND observed_at < $2
            AND to_status = 'Pending'
            AND random_number IS NOT NULL AND random_number != ''
        ) sub
      `, [dateInterval.startCairo, dateInterval.endCairo]);

      const pendingUniqueOrders = parseInt(pendingRes.rows[0]?.unique_orders || '0', 10);
      const pendingTotalEvents = parseInt(pendingRes.rows[0]?.total_events || '0', 10);

      // 5. Processing transitions for targetDate
      const procRes = await pool.query(`
        SELECT
          COUNT(DISTINCT o_id) as unique_orders,
          COUNT(*) as total_events
        FROM (
          SELECT order_code as o_id FROM canonical_activity_events
          WHERE event_timestamp >= $1 AND event_timestamp < $2
            AND to_status = 'Processing'
            AND order_code IS NOT NULL AND order_code != ''
          UNION ALL
          SELECT random_number as o_id FROM order_status_events
          WHERE observed_at >= $1 AND observed_at < $2
            AND to_status = 'Processing'
            AND random_number IS NOT NULL AND random_number != ''
        ) sub
      `, [dateInterval.startCairo, dateInterval.endCairo]);

      const processingUniqueOrders = parseInt(procRes.rows[0]?.unique_orders || '0', 10);
      const processingTotalEvents = parseInt(procRes.rows[0]?.total_events || '0', 10);

      // 6. Created on date
      const createdRes = await pool.query(`
        SELECT COUNT(*) as count
        FROM orders
        WHERE created_at_source >= $1::timestamptz AND created_at_source < $2::timestamptz
      `, [dateInterval.startCairo, dateInterval.endCairo]);

      const createdOnDate = parseInt(createdRes.rows[0]?.count || '0', 10);

      return {
        isPrimaryPostgres: true,
        currentCounts,
        todayActivity: {
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
        },
      };
    } catch (pgErr: any) {
      console.warn('[UnifiedDb] Postgres query error, falling back to SQLite:', pgErr.message);
    }
  }

  // SQLite Fallback
  return null;
}

/**
 * Fetch orders list directly from Supabase PostgreSQL (or fallback to SQLite)
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
}): Promise<{ orders: any[]; total: number } | null> {
  if (!isPrimaryPostgres()) {
    return null;
  }

  try {
    const pool = getSupabasePool();
    const cairoToday = getCairoDateString();
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
      if (opts.status === 'Printed') {
        conditions.push(`(
          (printed_date >= $${pIdx++}::timestamptz AND printed_date < $${pIdx++}::timestamptz)
          OR EXISTS (
            SELECT 1 FROM canonical_activity_events c
            WHERE (c.order_code = orders.random_number OR c.order_id = orders.id)
              AND c.event_timestamp >= $${pIdx++} AND c.event_timestamp < $${pIdx++}
              AND c.to_status = 'Printed'
          )
        )`);
        params.push(sInterval.startCairo, eInterval.endCairo, sInterval.startCairo, eInterval.endCairo);
      } else if (opts.status === 'Canceled') {
        conditions.push(`(
          (canceling_date >= $${pIdx++}::timestamptz AND canceling_date < $${pIdx++}::timestamptz)
          OR EXISTS (
            SELECT 1 FROM canonical_activity_events c
            WHERE (c.order_code = orders.random_number OR c.order_id = orders.id)
              AND c.event_timestamp >= $${pIdx++} AND c.event_timestamp < $${pIdx++}
              AND c.to_status = 'Canceled'
          )
        )`);
        params.push(sInterval.startCairo, eInterval.endCairo, sInterval.startCairo, eInterval.endCairo);
      } else {
        conditions.push(`created_at_source >= $${pIdx++}::timestamptz AND created_at_source < $${pIdx++}::timestamptz`);
        params.push(sInterval.startCairo, eInterval.endCairo);
      }
    } else if (opts.date) {
      const interval = getCairoDateInterval(opts.date);
      if (opts.status === 'Printed') {
        conditions.push(`(
          (printed_date::date = $${pIdx++}::date OR (printed_date >= $${pIdx++}::timestamptz AND printed_date < $${pIdx++}::timestamptz))
          OR EXISTS (
            SELECT 1 FROM canonical_activity_events c
            WHERE (c.order_code = orders.random_number OR c.order_id = orders.id)
              AND c.event_timestamp >= $${pIdx++} AND c.event_timestamp < $${pIdx++}
              AND c.to_status = 'Printed'
          )
        )`);
        params.push(opts.date, interval.startCairo, interval.endCairo, interval.startCairo, interval.endCairo);
      } else if (opts.status === 'Canceled') {
        conditions.push(`(
          (canceling_date::date = $${pIdx++}::date OR (canceling_date >= $${pIdx++}::timestamptz AND canceling_date < $${pIdx++}::timestamptz))
          OR EXISTS (
            SELECT 1 FROM canonical_activity_events c
            WHERE (c.order_code = orders.random_number OR c.order_id = orders.id)
              AND c.event_timestamp >= $${pIdx++} AND c.event_timestamp < $${pIdx++}
              AND c.to_status = 'Canceled'
          )
        )`);
        params.push(opts.date, interval.startCairo, interval.endCairo, interval.startCairo, interval.endCairo);
      } else {
        if (opts.status === 'New' && opts.date === cairoToday) {
          // Live active snapshot of New orders: show all active New orders without date truncation
          conditions.push(`validation_status != 'UNRESOLVED_ABSENT_FROM_VIEW'`);
        } else {
          conditions.push(`created_at_source >= $${pIdx++}::timestamptz AND created_at_source < $${pIdx++}::timestamptz`);
          params.push(interval.startCairo, interval.endCairo);
        }
      }
    }

    if (opts.multiMerchant) {
      conditions.push('multi_merchant_flag = 1');
    }
    if (opts.lowDelivery) {
      conditions.push('delivery_rate < 70 AND delivery_rate IS NOT NULL');
    }
    if (opts.noExtraPhone) {
      conditions.push("extra_phone_status = 'CONFIRMED_ABSENT'");
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

    return {
      orders: dataRes.rows,
      total,
    };
  } catch (err: any) {
    console.warn('[UnifiedDb] Postgres orders query error, falling back to SQLite:', err.message);
    return null;
  }
}

/**
 * Dual-write batch upsert: persists orders to Supabase PostgreSQL immediately
 * while also retaining local SQLite for fast cache lookups.
 */
export async function batchUpsertOrdersToPrimary(rawOrders: VendoorRawOrder[], nowIso?: string): Promise<{ count: number }> {
  const now = nowIso || new Date().toISOString();
  let count = 0;

  if (isPrimaryPostgres() && rawOrders.length > 0) {
    try {
      const pool = getSupabasePool();
      const CHUNK_SIZE = 50;

      for (let i = 0; i < rawOrders.length; i += CHUNK_SIZE) {
        const chunk = rawOrders.slice(i, i + CHUNK_SIZE);
        const valuesSql: string[] = [];
        const params: any[] = [];
        let pIdx = 1;

        for (const ord of chunk) {
          if (!ord || !ord.id) continue;
          const statusClean = syncEngine.parseStatusString(ord.status);
          const rawProds = ord.products || [];
          const { warehouses, isMultiWarehouse } = extractDistinctWarehouses(rawProds);
          const distinctCount = warehouses.length > 0 ? warehouses.length : 1;
          const multiWarehouseFlag = isMultiWarehouse ? 1 : 0;
          const addressEval = evaluateAddressQuality(ord.address);

          valuesSql.push(`(
            $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++},
            $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++},
            $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++},
            $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}
          )`);

          params.push(
            ord.id,
            ord.random_number || `VND_${ord.id}`,
            ord.order_no || null,
            ord.order_type || 'اوردر جديد',
            statusClean,
            ord.status || null,
            ord.affiliate_code || null,
            ord.affiliate_name || null,
            ord.full_name || null,
            ord.phone || '',
            ord.governrate_name || null,
            ord.address || null,
            parseFloat(String(ord.total_price || 0)) || 0,
            parseFloat(String(ord.shipping_cost || 0)) || 0,
            parseFloat(String(ord.total_order || 0)) || 0,
            ord.created_at || now,
            distinctCount,
            multiWarehouseFlag,
            'VALIDATED',
            'HOT',
            now,
            now,
            now
          );
        }

        if (valuesSql.length === 0) continue;

        const queryText = `
          INSERT INTO orders (
            vendoor_id, random_number, order_no, order_type, current_status, status_raw,
            affiliate_code, affiliate_name, customer_name, customer_phone, governorate, address,
            total_price, shipping_cost, total_order, created_at_source,
            distinct_merchant_count, multi_merchant_flag, validation_status, storage_tier,
            last_observed_at, created_at, updated_at
          ) VALUES ${valuesSql.join(', ')}
          ON CONFLICT (vendoor_id) DO UPDATE SET
            current_status = EXCLUDED.current_status,
            status_raw = EXCLUDED.status_raw,
            random_number = COALESCE(EXCLUDED.random_number, orders.random_number),
            order_no = COALESCE(EXCLUDED.order_no, orders.order_no),
            customer_name = COALESCE(EXCLUDED.customer_name, orders.customer_name),
            customer_phone = COALESCE(EXCLUDED.customer_phone, orders.customer_phone),
            governorate = COALESCE(EXCLUDED.governorate, orders.governorate),
            address = COALESCE(EXCLUDED.address, orders.address),
            total_order = CASE WHEN EXCLUDED.total_order > 0 THEN EXCLUDED.total_order ELSE orders.total_order END,
            validation_status = 'VALIDATED',
            last_observed_at = EXCLUDED.last_observed_at,
            updated_at = EXCLUDED.updated_at
        `;

        await pool.query(queryText, params);
        count += chunk.length;
      }
    } catch (err: any) {
      console.warn('[UnifiedDb] Postgres batch upsert error:', err.message);
    }
  }

  return { count };
}

/**
 * Reconciles absent orders in Supabase after an authoritative complete scan
 */
export async function reconcileAbsentOrdersInPrimary(statusName: string, activeVendoorIds: Set<number>, nowIso?: string): Promise<void> {
  if (!isPrimaryPostgres() || activeVendoorIds.size === 0) return;

  try {
    const pool = getSupabasePool();
    const idArray = Array.from(activeVendoorIds);

    // 1. For orders absent from live view, update from canonical logs if a transition is recorded
    await pool.query(`
      UPDATE orders o
      SET current_status = c.to_status,
          validation_status = 'RESOLVED_VIA_AUDIT_LOGS',
          updated_at = NOW()
      FROM (
        SELECT DISTINCT ON (order_code) order_code, to_status, event_timestamp
        FROM canonical_activity_events
        WHERE to_status IS NOT NULL
        ORDER BY order_code, event_timestamp DESC
      ) c
      WHERE c.order_code = o.random_number
        AND o.current_status = $1
        AND NOT (o.vendoor_id = ANY($2))
    `, [statusName, idArray]);

    // 2. For remaining orders absent from live view without canonical event,
    // mark validation_status = 'UNRESOLVED_ABSENT_FROM_VIEW' so they never inflate active live balance!
    await pool.query(`
      UPDATE orders
      SET validation_status = 'UNRESOLVED_ABSENT_FROM_VIEW',
          updated_at = NOW()
      WHERE current_status = $1
        AND NOT (vendoor_id = ANY($2))
        AND validation_status != 'UNRESOLVED_ABSENT_FROM_VIEW'
    `, [statusName, idArray]);
  } catch (err: any) {
    console.warn('[UnifiedDb] Postgres reconcile absent orders error:', err.message);
  }
}

/**
 * Generates comprehensive, privacy-preserving system diagnostic
 */
export async function getSystemDiagnostic(): Promise<SystemDiagnosticData> {
  const timestamp = new Date().toISOString();
  const connStatus = await checkSupabaseConnection(false);
  const dbType: 'SUPABASE_POSTGRES' | 'SQLITE_FALLBACK' = isPrimaryPostgres() && connStatus.isConnected ? 'SUPABASE_POSTGRES' : 'SQLITE_FALLBACK';
  const dataSourceName = getDataSourceIdentifier();

  let ordersCountByStatus: Record<string, number> = {};
  let totalOrdersInDb = 0;

  if (dbType === 'SUPABASE_POSTGRES') {
    try {
      const pool = getSupabasePool();
      const res = await pool.query(`
        SELECT current_status, COUNT(*) as c
        FROM orders
        WHERE validation_status != 'UNRESOLVED_ABSENT_FROM_VIEW'
        GROUP BY current_status
        ORDER BY c DESC
      `);
      for (const r of res.rows) {
        ordersCountByStatus[r.current_status] = parseInt(r.c, 10);
        totalOrdersInDb += ordersCountByStatus[r.current_status];
      }
    } catch {
      // Fallback to SQLite if query fails
    }
  }

  if (Object.keys(ordersCountByStatus).length === 0) {
    try {
      const rows: any[] = db.prepare(`
        SELECT current_status, COUNT(*) as c
        FROM orders
        WHERE validation_status != 'UNRESOLVED_ABSENT_FROM_VIEW'
        GROUP BY current_status
        ORDER BY c DESC
      `).all();
      for (const r of rows) {
        ordersCountByStatus[r.current_status] = Number(r.c);
        totalOrdersInDb += Number(r.c);
      }
    } catch {}
  }

  const syncStatus = syncEngine.getStatus();

  return {
    timestamp,
    databaseType: dbType,
    instanceId: `${process.pid}@${os.hostname()}`,
    processPid: process.pid,
    hostname: os.hostname(),
    uptimeSeconds: Math.floor(process.uptime()),
    dataSourceName,
    ordersCountByStatus,
    totalOrdersInDb,
    lastSuccessfulSyncAt: syncStatus.lastSuccessfulSyncAt,
    supabase: {
      isConfigured: connStatus.isConfigured,
      isConnected: connStatus.isConnected,
      latencyMs: connStatus.latencyMs,
      mode: connStatus.mode,
    },
  };
}
