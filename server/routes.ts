import { Router, Request, Response } from 'express';
import {
  db,
  getCairoDateString,
  getCairoDateInterval,
  getDailySnapshot,
  saveDailySnapshot,
  getCoverageRecord,
  isDateInHot,
} from './db.js';
import {
  syncEngine,
  calculateAgeBucket,
  getProcessingTransitionTime,
} from './syncEngine.js';

export const apiRouter = Router();

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

    // 1. Current Live Status Population in Database
    const statusCountsRaw: any[] = db.prepare(`
      SELECT current_status, COUNT(*) as count
      FROM orders
      GROUP BY current_status
    `).all();

    const currentCounts = {
      New: 0,
      Pending: 0,
      Processing: 0,
      Canceling: 0,
      Printed: 0,
      Canceled: 0,
    };

    for (const r of statusCountsRaw) {
      if (r.current_status in currentCounts) {
        (currentCounts as any)[r.current_status] = r.count;
      }
    }

    // 2. Target Date Activity
    const dateInterval = getCairoDateInterval(targetDate);
    const dayTransitions: any[] = db.prepare(`
      SELECT to_status, COUNT(*) as count
      FROM order_status_events
      WHERE observed_at >= ? AND observed_at < ?
      GROUP BY to_status
    `).all(dateInterval.startCairo, dateInterval.endCairo);

    const todayActivity = {
      Created: 0,
      Printed: 0,
      Pending: 0,
      Processing: 0,
      Canceling: 0,
      Canceled: 0,
    };

    const createdOnDate = (db.prepare(`
      SELECT COUNT(*) as count
      FROM orders
      WHERE created_at_source >= ? AND created_at_source < ?
    `).get(dateInterval.startCairo, dateInterval.endCairo) as any)?.count || 0;
    todayActivity.Created = createdOnDate;

    for (const t of dayTransitions) {
      if (t.to_status === 'Printed') todayActivity.Printed = t.count;
      else if (t.to_status === 'Pending') todayActivity.Pending = t.count;
      else if (t.to_status === 'Processing') todayActivity.Processing = t.count;
      else if (t.to_status === 'Canceling') todayActivity.Canceling = t.count;
      else if (t.to_status === 'Canceled') todayActivity.Canceled = t.count;
    }

    // 3. Confirmation Age counts
    const confRows: any[] = db.prepare(`
      SELECT confirmation_age_category, COUNT(*) as count
      FROM orders
      WHERE confirmation_age_category IS NOT NULL
      GROUP BY confirmation_age_category
    `).all();

    const confirmationAges: Record<string, number> = {
      '1_day': 0,
      '2_days': 0,
      '3_days': 0,
      'over_3_days': 0,
    };
    for (const cr of confRows) {
      if (cr.confirmation_age_category in confirmationAges) {
        confirmationAges[cr.confirmation_age_category] = cr.count;
      }
    }

    // 4. Risk Indicators for Printed orders
    const multiMerchantPrinted = (db.prepare(`
      SELECT COUNT(*) as count
      FROM orders
      WHERE current_status = 'Printed' AND multi_merchant_flag = 1
    `).get() as any)?.count || 0;

    const lowDeliveryRatePrinted = (db.prepare(`
      SELECT COUNT(*) as count
      FROM orders
      WHERE current_status = 'Printed' AND delivery_rate IS NOT NULL AND delivery_rate < 70
    `).get() as any)?.count || 0;

    const missingExtraPhonePrinted = (db.prepare(`
      SELECT COUNT(*) as count
      FROM orders
      WHERE current_status = 'Printed' AND extra_phone_status = 'CONFIRMED_ABSENT'
    `).get() as any)?.count || 0;

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

    res.json({
      selectedDate: targetDate,
      isToday,
      storageTier,
      coverageStatus,
      isCached: false,
      currentCounts,
      confirmationAges,
      riskIndicators: {
        multiMerchantPrinted,
        lowDeliveryRatePrinted,
        missingExtraPhonePrinted,
        openAlertsCount,
      },
      todayActivity,
      pendingAge,
      processingAge,
      syncStatus,
    });
  } catch (err: any) {
    console.error('Error in /dashboard/stats:', err);
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
      conditions.push('current_status = ?');
      params.push(status);
    }

    if (date) {
      const interval = getCairoDateInterval(date as string);
      conditions.push('created_at_source >= ? AND created_at_source < ?');
      params.push(interval.startCairo, interval.endCairo);
    }

    if (multiMerchant === '1') {
      conditions.push('multi_merchant_flag = 1');
    }

    if (lowDelivery === '1') {
      conditions.push('delivery_rate IS NOT NULL AND delivery_rate < 70');
    }

    if (noExtraPhone === '1') {
      conditions.push("extra_phone_status = 'CONFIRMED_ABSENT'");
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

    res.json({
      orders,
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
      SELECT * FROM canonical_activity_events
      WHERE order_code = ? OR order_code = ?
      ORDER BY id DESC
      LIMIT 50
    `).all(order.random_number, String(order.vendoor_id));

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

// 5. Printed View
apiRouter.get('/printed', (req: Request, res: Response) => {
  try {
    const { category = 'all' } = req.query;

    let whereCondition = "current_status = 'Printed'";
    if (category === 'no_extra_phone') {
      whereCondition += " AND extra_phone_status = 'CONFIRMED_ABSENT'";
    } else if (category === 'multi_merchant') {
      whereCondition += ' AND multi_merchant_flag = 1';
    } else if (category === 'low_delivery') {
      whereCondition += ' AND delivery_rate IS NOT NULL AND delivery_rate < 70';
    }

    const orders: any[] = db.prepare(`
      SELECT
        id, vendoor_id, random_number, order_no, customer_name,
        customer_phone, customer_phone_extra, extra_phone_valid, extra_phone_status,
        governorate, address, total_order, printed_date,
        distinct_merchant_count, multi_merchant_flag, delivery_rate,
        delivery_rate_num, delivery_rate_denom, confirmation_age_category,
        address_quality_status, last_observed_at
      FROM orders
      WHERE ${whereCondition}
      ORDER BY id DESC
    `).all();

    res.json({ orders, total: orders.length });
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
      conditions.push('event_timestamp LIKE ?');
      params.push(`${effectiveDate}%`);
      if (syncIfMissing === '1') {
        await syncEngine.syncHistoricalDate('logs', effectiveDate);
      }
    } else if (startDate && endDate) {
      dateLabel = `${startDate} إلى ${endDate}`;
      conditions.push('event_timestamp >= ? AND event_timestamp <= ?');
      params.push(`${startDate} 00:00:00`, `${endDate} 23:59:59`);
    } else if (period === 'yesterday') {
      const now = new Date();
      const y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const yStr = getCairoDateString(y);
      dateLabel = yStr;
      conditions.push('event_timestamp LIKE ?');
      params.push(`${yStr}%`);
    } else if (period === 'all') {
      dateLabel = 'كل الفترات';
    } else {
      const todayStr = getCairoDateString();
      dateLabel = todayStr;
      conditions.push('event_timestamp LIKE ?');
      params.push(`${todayStr}%`);
    }

    conditions.push('is_system_actor = 0');
    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const events: any[] = db.prepare(`
      SELECT
        actor_name,
        action_type,
        to_status,
        order_code,
        event_timestamp
      FROM canonical_activity_events
      ${whereClause}
    `).all(...params);

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
      lastActionAt: string | null;
    }> = {};

    for (const e of events) {
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
          lastActionAt: null,
        };
        userOrdersMap[name] = new Set();
      }

      userStats[name].actions++;
      if (e.order_code) {
        userOrdersMap[name].add(e.order_code);
      }
      if (!userStats[name].lastActionAt || e.event_timestamp > userStats[name].lastActionAt!) {
        userStats[name].lastActionAt = e.event_timestamp;
      }

      if (e.action_type === 'status_change') {
        if (e.to_status === 'Printed') userStats[name].printed++;
        else if (e.to_status === 'Pending') userStats[name].pending++;
        else if (e.to_status === 'Processing') userStats[name].processing++;
        else if (e.to_status === 'Canceled' || e.to_status === 'Canceling') userStats[name].cancel++;
        else userStats[name].other++;
      } else {
        userStats[name].other++;
      }
    }

    const teamList = Object.values(userStats).map(u => ({
      ...u,
      uniqueOrders: userOrdersMap[u.name]?.size || 0,
      printedPercent: u.actions > 0 ? Math.round((u.printed / u.actions) * 1000) / 10 : 0,
      pendingPercent: u.actions > 0 ? Math.round((u.pending / u.actions) * 1000) / 10 : 0,
      processingPercent: u.actions > 0 ? Math.round((u.processing / u.actions) * 1000) / 10 : 0,
      cancelPercent: u.actions > 0 ? Math.round((u.cancel / u.actions) * 1000) / 10 : 0,
      otherPercent: u.actions > 0 ? Math.round((u.other / u.actions) * 1000) / 10 : 0,
    })).sort((a, b) => b.actions - a.actions);

    res.json({
      period: period || (date ? 'custom_date' : (startDate ? 'custom_range' : 'today')),
      dateFilter: dateLabel,
      team: teamList,
      totalActions: events.length,
      totalUniqueOrders: new Set(events.map(e => e.order_code).filter(Boolean)).size,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 9. Employee Drill-down with period support
apiRouter.get('/team/:actorName/events', (req: Request, res: Response) => {
  try {
    const actorName = req.params.actorName;
    const { date, startDate, endDate, period } = req.query;
    const conditions: string[] = ['c.actor_name = ?'];
    const params: any[] = [actorName];

    if (date) {
      conditions.push('c.event_timestamp LIKE ?');
      params.push(`${date}%`);
    } else if (startDate && endDate) {
      conditions.push('c.event_timestamp >= ? AND c.event_timestamp <= ?');
      params.push(`${startDate} 00:00:00`, `${endDate} 23:59:59`);
    } else if (period === 'yesterday') {
      const now = new Date();
      const y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const yStr = getCairoDateString(y);
      conditions.push('c.event_timestamp LIKE ?');
      params.push(`${yStr}%`);
    } else if (period === 'today') {
      const todayStr = getCairoDateString();
      conditions.push('c.event_timestamp LIKE ?');
      params.push(`${todayStr}%`);
    }

    const events: any[] = db.prepare(`
      SELECT c.*, r.raw_action_text
      FROM canonical_activity_events c
      LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY c.id DESC
      LIMIT 200
    `).all(...params);

    res.json({ actorName, events });
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

    // Orders Created in period
    const createdCount = (db.prepare(`
      SELECT COUNT(*) as c FROM orders
      WHERE created_at_source >= ? AND created_at_source < ?
    `).get(startTime, endTime) as any)?.c || 0;

    // Orders Touched in period (distinct orders with canonical activity events in period)
    const touchedCount = (db.prepare(`
      SELECT COUNT(DISTINCT order_code) as c FROM canonical_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ? AND order_code IS NOT NULL
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

    // Cancellations in period
    const cancellations: any[] = db.prepare(`
      SELECT to_status, COUNT(*) as count
      FROM canonical_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ? AND (to_status = 'Canceled' OR to_status = 'Canceling')
      GROUP BY to_status
    `).all(startTime, endTime);

    // Employee activity in period
    const employees: any[] = db.prepare(`
      SELECT actor_name, COUNT(*) as action_count, COUNT(DISTINCT order_code) as unique_orders
      FROM canonical_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ? AND is_system_actor = 0
      GROUP BY actor_name
      ORDER BY action_count DESC
    `).all(startTime, endTime);

    res.json({
      startDate: sDate,
      endDate: eDate,
      period: period || 'custom',
      createdCount,
      touchedCount,
      totalEvents,
      transitions,
      cancellations,
      employees,
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

// 13. System Activity Logs Filter
apiRouter.get('/logs', (req: Request, res: Response) => {
  try {
    const { date, actor, actionType, orderCode, limit = '50', offset = '0' } = req.query;
    const conditions: string[] = [];
    const params: any[] = [];

    if (date) {
      conditions.push('c.event_timestamp LIKE ?');
      params.push(`${date}%`);
    }
    if (actor) {
      conditions.push('c.actor_name = ?');
      params.push(actor);
    }
    if (actionType) {
      conditions.push('c.action_type = ?');
      params.push(actionType);
    }
    if (orderCode) {
      conditions.push('c.order_code = ?');
      params.push(orderCode);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitNum = Math.min(200, Math.max(1, parseInt(limit as string, 10)));
    const offsetNum = Math.max(0, parseInt(offset as string, 10));

    const total = (db.prepare(`SELECT COUNT(*) as c FROM canonical_activity_events c ${whereClause}`).get(...params) as any)?.c || 0;

    const logs: any[] = db.prepare(`
      SELECT c.*, r.raw_action_text
      FROM canonical_activity_events c
      LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
      ${whereClause}
      ORDER BY c.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, limitNum, offsetNum);

    res.json({ logs, total, limit: limitNum, offset: offsetNum });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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

apiRouter.post('/alerts/scan-multi-merchant', async (_req: Request, res: Response) => {
  try {
    const result = await syncEngine.scanAllConfirmedOrdersForMultiMerchant();
    res.json({ success: true, result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 16. Server-Sent Events (SSE) Stream
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

// 17. System Settings & Configuration Status
apiRouter.get('/settings', (_req: Request, res: Response) => {
  try {
    const email = process.env.VENDOOR_EMAIL || '';
    const maskedEmail = email ? email.replace(/^(.{2})(.*)(@.*)$/, (_, a, b, c) => `${a}***${c}`) : 'غير محدد';
    const dbSize = (db.prepare('SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()').get() as any)?.size || 0;
    const walMode = (db.prepare('PRAGMA journal_mode').get() as any)?.journal_mode || 'unknown';

    res.json({
      authEmail: maskedEmail,
      loginUrl: process.env.VENDOOR_LOGIN_URL || 'https://aff.ven-door.com/dashboard/login',
      timezone: 'Africa/Cairo',
      syncInterval: parseInt(process.env.SYNC_INTERVAL_SECONDS || '30', 10),
      database: {
        path: process.env.DATABASE_PATH || 'data/vendoor_intelligence.sqlite',
        sizeBytes: dbSize,
        journalMode: walMode,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
