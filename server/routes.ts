import { Router, Request, Response } from 'express';
import { db, getCairoDateString, getDailySnapshot, saveDailySnapshot, getCoverageRecord, isDateInHot } from './db.js';
import { syncEngine } from './syncEngine.js';

export const apiRouter = Router();

// 1. Health & Sync Status
apiRouter.get('/health', (req: Request, res: Response) => {
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

    // If historical date and already saved as daily snapshot, return cached snapshot
    if (!isToday) {
      const cachedSnapshot = getDailySnapshot(targetDate);
      if (cachedSnapshot) {
        let snapshotData: any = {};
        try {
          if (cachedSnapshot.snapshot_json) snapshotData = JSON.parse(cachedSnapshot.snapshot_json);
        } catch {
          // ignore
        }

        return res.json({
          selectedDate: targetDate,
          isToday: false,
          storageTier: cachedSnapshot.storage_tier || storageTier,
          coverageStatus: coverageRecord?.completion_status || 'COMPLETE',
          isCached: true,
          currentCounts: {
            New: cachedSnapshot.new_count,
            Pending: cachedSnapshot.pending_count,
            Processing: cachedSnapshot.processing_count,
            Canceling: cachedSnapshot.canceling_count,
            Printed: cachedSnapshot.printed_count,
            Canceled: cachedSnapshot.canceled_count,
          },
          todayActivity: {
            Created: cachedSnapshot.created_today,
            Printed: cachedSnapshot.printed_today,
            Pending: cachedSnapshot.pending_today,
            Processing: cachedSnapshot.processing_today,
            Canceling: cachedSnapshot.canceling_today,
            Canceled: cachedSnapshot.canceled_today,
          },
          confirmationAges: snapshotData.confirmationAges || {
            '1_day': 0,
            '2_days': 0,
            '3_days': 0,
            'over_3_days': 0,
          },
          riskIndicators: {
            multiMerchantPrinted: cachedSnapshot.multi_merchant_printed,
            lowDeliveryRatePrinted: cachedSnapshot.low_delivery_rate_printed,
            missingExtraPhonePrinted: cachedSnapshot.missing_extra_phone_printed,
            openAlertsCount: snapshotData.openAlertsCount || 0,
          },
          pendingAge: snapshotData.pendingAge || { twoToFourDays: 0, fourToFiveDays: 0, overFiveDays: 0, total: 0 },
          processingAge: snapshotData.processingAge || { twoToFourDays: 0, fourToFiveDays: 0, overFiveDays: 0, total: 0 },
          syncStatus: syncEngine.getStatus(),
        });
      }
    }

    // 1. Current or Historical Status Counts
    let currentCounts: Record<string, number> = {
      New: 0,
      Pending: 0,
      Processing: 0,
      Canceling: 0,
      Printed: 0,
      Canceled: 0,
    };

    if (isToday) {
      const statusRows: any[] = db.prepare(`
        SELECT current_status, COUNT(*) as count
        FROM orders
        GROUP BY current_status
      `).all();

      for (const r of statusRows) {
        if (r.current_status in currentCounts) {
          currentCounts[r.current_status] = r.count;
        } else if (r.current_status.includes('Cancel') || r.current_status.includes('ملغي')) {
          currentCounts.Canceled += r.count;
        }
      }
    } else {
      // Historical end-of-day orders for targetDate
      const histRows: any[] = db.prepare(`
        SELECT current_status, COUNT(*) as count
        FROM orders
        WHERE created_at_source LIKE ? OR (created_at_source <= ? AND (printed_date IS NULL OR printed_date >= ?))
        GROUP BY current_status
      `).all(`${targetDate}%`, `${targetDate} 23:59:59`, targetDate);

      for (const r of histRows) {
        if (r.current_status in currentCounts) {
          currentCounts[r.current_status] = r.count;
        }
      }
    }

    // 2. Selected Date Activity Transitions from order_status_events & orders
    const dayTransitions: any[] = db.prepare(`
      SELECT to_status, COUNT(*) as count
      FROM order_status_events
      WHERE observed_at LIKE ? OR event_time_source LIKE ?
      GROUP BY to_status
    `).all(`${targetDate}%`, `${targetDate}%`);

    const todayActivity: Record<string, number> = {
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
      WHERE created_at_source LIKE ? OR created_at LIKE ?
    `).get(`${targetDate}%`, `${targetDate}%`) as any)?.count || 0;
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
      WHERE current_status = 'Printed' AND (customer_phone_extra IS NULL OR customer_phone_extra = '' OR extra_phone_valid = 0)
    `).get() as any)?.count || 0;

    const openAlertsCount = (db.prepare(`
      SELECT COUNT(*) as count
      FROM alerts
      WHERE status != 'RESOLVED'
    `).get() as any)?.count || 0;

    // 5. Age in status buckets for Pending & Processing
    const nowMs = Date.now();
    const ageBuckets = (status: string) => {
      const orders: any[] = db.prepare(`
        SELECT state_entry_at, created_at_source
        FROM orders
        WHERE current_status = ?
      `).all(status);

      let twoToFourDays = 0;
      let fourToFiveDays = 0;
      let overFiveDays = 0;

      for (const o of orders) {
        const entryTime = o.state_entry_at ? new Date(o.state_entry_at).getTime() : new Date(o.created_at_source).getTime();
        const diffDays = Math.max(0, (nowMs - entryTime) / (1000 * 60 * 60 * 24));
        if (diffDays >= 2 && diffDays < 4) twoToFourDays++;
        else if (diffDays >= 4 && diffDays <= 5) fourToFiveDays++;
        else if (diffDays > 5) overFiveDays++;
      }

      return { twoToFourDays, fourToFiveDays, overFiveDays, total: orders.length };
    };

    const pendingAge = ageBuckets('Pending');
    const processingAge = ageBuckets('Processing');

    // If historical date and we have non-zero data, save to daily_snapshots
    if (!isToday && (currentCounts.New + currentCounts.Pending + currentCounts.Processing + currentCounts.Printed > 0 || createdOnDate > 0)) {
      saveDailySnapshot({
        snapshotDate: targetDate,
        storageTier,
        newCount: currentCounts.New,
        pendingCount: currentCounts.Pending,
        processingCount: currentCounts.Processing,
        cancelingCount: currentCounts.Canceling,
        printedCount: currentCounts.Printed,
        canceledCount: currentCounts.Canceled,
        totalOrders: currentCounts.New + currentCounts.Pending + currentCounts.Processing + currentCounts.Canceling + currentCounts.Printed + currentCounts.Canceled,
        createdToday: todayActivity.Created,
        printedToday: todayActivity.Printed,
        pendingToday: todayActivity.Pending,
        processingToday: todayActivity.Processing,
        cancelingToday: todayActivity.Canceling,
        canceledToday: todayActivity.Canceled,
        multiMerchantPrinted,
        missingExtraPhonePrinted,
        lowDeliveryRatePrinted,
        snapshotJson: JSON.stringify({
          confirmationAges,
          openAlertsCount,
          pendingAge,
          processingAge,
        }),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    res.json({
      selectedDate: targetDate,
      isToday,
      storageTier,
      coverageStatus: coverageRecord?.completion_status || (isToday ? 'LIVE' : 'UNKNOWN'),
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
      syncStatus: syncEngine.getStatus(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Orders List with Search & Filters
apiRouter.get('/orders', async (req: Request, res: Response) => {
  try {
    const {
      status,
      search,
      governorate,
      multiMerchant,
      lowDelivery,
      confirmationAge,
      date,
      startDate,
      endDate,
      syncIfMissing,
      limit = '50',
      offset = '0',
    } = req.query;

    if (syncIfMissing === '1' && date) {
      await syncEngine.syncHistoricalDate('orders', String(date));
    }

    const conditions: string[] = [];
    const params: any[] = [];

    if (status && status !== 'all') {
      conditions.push('current_status = ?');
      params.push(status);
    }

    if (governorate) {
      conditions.push('governorate = ?');
      params.push(governorate);
    }

    if (multiMerchant === '1') {
      conditions.push('multi_merchant_flag = 1');
    }

    if (lowDelivery === '1') {
      conditions.push('delivery_rate IS NOT NULL AND delivery_rate < 70');
    }

    if (confirmationAge) {
      conditions.push('confirmation_age_category = ?');
      params.push(confirmationAge);
    }

    if (date) {
      conditions.push('created_at_source LIKE ?');
      params.push(`${date}%`);
    } else if (startDate && endDate) {
      conditions.push('created_at_source >= ? AND created_at_source <= ?');
      params.push(`${startDate} 00:00:00`, `${endDate} 23:59:59`);
    } else if (startDate) {
      conditions.push('created_at_source >= ?');
      params.push(`${startDate} 00:00:00`);
    } else if (endDate) {
      conditions.push('created_at_source <= ?');
      params.push(`${endDate} 23:59:59`);
    }

    if (search) {
      const q = `%${search}%`;
      conditions.push('(random_number LIKE ? OR customer_phone LIKE ? OR customer_name LIKE ? OR order_no LIKE ?)');
      params.push(q, q, q, q);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow: any = db.prepare(`SELECT COUNT(*) as total FROM orders ${whereClause}`).get(...params);
    const total = countRow?.total || 0;

    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 50));
    const offsetNum = Math.max(0, parseInt(offset as string, 10) || 0);

    const orders: any[] = db.prepare(`
      SELECT
        id, vendoor_id, random_number, order_no, order_type, current_status,
        affiliate_code, affiliate_name, customer_name, customer_phone,
        customer_phone_extra, extra_phone_valid, governorate, address,
        total_price, shipping_cost, total_order, distinct_merchant_count,
        multi_merchant_flag, delivery_rate, delivery_rate_num, delivery_rate_denom,
        cancel_rate, total_customer_orders, customer_delivery_warning,
        confirmation_age_category, state_entry_at, created_at_source,
        storage_tier, last_observed_at
      FROM orders
      ${whereClause}
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `).all(...params, limitNum, offsetNum);

    res.json({
      total,
      limit: limitNum,
      offset: offsetNum,
      orders,
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

    // Fetch items
    const items: any[] = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);

    // Fetch status events
    const timeline: any[] = db.prepare(`
      SELECT * FROM order_status_events
      WHERE order_id = ?
      ORDER BY id ASC
    `).all(order.id);

    // Fetch alerts
    const alerts: any[] = db.prepare('SELECT * FROM alerts WHERE order_id = ?').all(order.id);

    // Fetch customer history observations
    const customerObservations: any[] = db.prepare(`
      SELECT * FROM customer_history_observations
      WHERE order_id = ? OR phone = ?
      ORDER BY id DESC
      LIMIT 10
    `).all(order.id, order.customer_phone);

    res.json({
      order,
      items,
      timeline,
      alerts,
      customerObservations,
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
      whereCondition += ' AND (customer_phone_extra IS NULL OR extra_phone_valid = 0)';
    } else if (category === 'multi_merchant') {
      whereCondition += ' AND multi_merchant_flag = 1';
    } else if (category === 'low_delivery') {
      whereCondition += ' AND delivery_rate IS NOT NULL AND delivery_rate < 70';
    }

    const orders: any[] = db.prepare(`
      SELECT
        id, vendoor_id, random_number, order_no, customer_name,
        customer_phone, customer_phone_extra, extra_phone_valid,
        governorate, address, total_order, printed_date,
        distinct_merchant_count, multi_merchant_flag, delivery_rate,
        delivery_rate_num, delivery_rate_denom, confirmation_age_category,
        last_observed_at
      FROM orders
      WHERE ${whereCondition}
      ORDER BY id DESC
    `).all();

    res.json({ orders, total: orders.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Pending Orders Categorized by Age
apiRouter.get('/pending', (req: Request, res: Response) => {
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
      const entryTime = o.state_entry_at ? new Date(o.state_entry_at).getTime() : new Date(o.created_at_source).getTime();
      const diffDays = Math.max(0, (nowMs - entryTime) / (1000 * 60 * 60 * 24));
      let ageBucket = 'less_than_2_days';
      if (diffDays >= 2 && diffDays < 4) ageBucket = '2_to_4_days';
      else if (diffDays >= 4 && diffDays <= 5) ageBucket = '4_to_5_days';
      else if (diffDays > 5) ageBucket = 'over_5_days';

      return {
        ...o,
        ageInDays: Math.round(diffDays * 10) / 10,
        ageBucket,
      };
    });

    res.json({ orders: enriched, total: enriched.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Processing Orders Categorized by Age
apiRouter.get('/processing', (req: Request, res: Response) => {
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
      const entryTime = o.state_entry_at ? new Date(o.state_entry_at).getTime() : new Date(o.created_at_source).getTime();
      const diffDays = Math.max(0, (nowMs - entryTime) / (1000 * 60 * 60 * 24));
      let ageBucket = 'less_than_2_days';
      if (diffDays >= 2 && diffDays < 4) ageBucket = '2_to_4_days';
      else if (diffDays >= 4 && diffDays <= 5) ageBucket = '4_to_5_days';
      else if (diffDays > 5) ageBucket = 'over_5_days';

      return {
        ...o,
        ageInDays: Math.round(diffDays * 10) / 10,
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
    } else {
      const todayStr = getCairoDateString();
      dateLabel = todayStr;
      conditions.push('event_timestamp LIKE ?');
      params.push(`${todayStr}%`);
    }

    // Filter out system background actors from human employee rankings
    conditions.push('is_system_actor = 0');

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Distinct canonical events per human employee
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
        };
        userOrdersMap[name] = new Set<string>();
      }

      userStats[name].actions++;
      if (e.order_code) {
        userOrdersMap[name].add(e.order_code);
      }

      if (e.action_type === 'status_change') {
        const to = (e.to_status || '').toLowerCase();
        if (to.includes('print')) userStats[name].printed++;
        else if (to.includes('pend')) userStats[name].pending++;
        else if (to.includes('process')) userStats[name].processing++;
        else if (to.includes('cancel')) userStats[name].cancel++;
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

// 9. Employee Drill-down
apiRouter.get('/team/:actorName/events', (req: Request, res: Response) => {
  try {
    const actorName = req.params.actorName;
    const { date, startDate, endDate } = req.query;
    const conditions: string[] = ['c.actor_name = ?'];
    const params: any[] = [actorName];

    if (date) {
      conditions.push('c.event_timestamp LIKE ?');
      params.push(`${date}%`);
    } else if (startDate && endDate) {
      conditions.push('c.event_timestamp >= ? AND c.event_timestamp <= ?');
      params.push(`${startDate} 00:00:00`, `${endDate} 23:59:59`);
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
    const { status, type } = req.query;
    const conditions: string[] = [];
    const params: any[] = [];

    if (status && status !== 'all') {
      conditions.push('a.status = ?');
      params.push(status);
    }
    if (type) {
      conditions.push('a.alert_type = ?');
      params.push(type);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const alerts: any[] = db.prepare(`
      SELECT a.*, o.customer_name, o.customer_phone, o.governorate, o.total_order, o.delivery_rate
      FROM alerts a
      LEFT JOIN orders o ON a.order_id = o.id
      ${whereClause}
      ORDER BY a.id DESC
    `).all(...params);

    res.json({ alerts, total: alerts.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 11. Update Alert Status
apiRouter.patch('/alerts/:id', (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const { status, notes, resolvedBy = 'مشرف العمليات' } = req.body;

    if (!['OPEN', 'IN_REVIEW', 'RESOLVED'].includes(status)) {
      res.status(400).json({ error: 'Invalid alert status' });
      return;
    }

    const nowIso = new Date().toISOString();
    const resolvedAt = status === 'RESOLVED' ? nowIso : null;

    db.prepare(`
      UPDATE alerts SET
        status = ?,
        resolution_notes = COALESCE(?, resolution_notes),
        resolved_at = COALESCE(?, resolved_at),
        resolved_by = CASE WHEN ? = 'RESOLVED' THEN ? ELSE resolved_by END,
        updated_at = ?
      WHERE id = ?
    `).run(status, notes || null, resolvedAt, status, resolvedBy, nowIso, id);

    res.json({ success: true, id, status, updated_at: nowIso });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 12. Trigger Manual Sync
apiRouter.post('/sync/trigger', async (req: Request, res: Response) => {
  try {
    const status = await syncEngine.triggerManualSync();
    res.json({ success: true, status });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 13. Sync Runs Audit & Discrepancies
apiRouter.get('/sync/runs', (req: Request, res: Response) => {
  try {
    const runs: any[] = db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 30').all();
    const qualityIssues: any[] = db.prepare('SELECT * FROM data_quality_issues ORDER BY id DESC LIMIT 20').all();
    res.json({ runs, qualityIssues });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 14. Historical Coverage & On-Demand Sync
apiRouter.get('/historical/coverage', (req: Request, res: Response) => {
  try {
    const { domain, date } = req.query;
    let query = 'SELECT * FROM historical_coverage';
    const params: any[] = [];
    if (domain && date) {
      query += ' WHERE source_domain = ? AND period_date = ?';
      params.push(domain, date);
    } else if (domain) {
      query += ' WHERE source_domain = ?';
      params.push(domain);
    } else if (date) {
      query += ' WHERE period_date = ?';
      params.push(date);
    }
    query += ' ORDER BY period_date DESC, source_domain ASC';
    const records = db.prepare(query).all(...params);
    res.json({ records });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/historical/sync-date', async (req: Request, res: Response) => {
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

apiRouter.post('/alerts/scan-multi-merchant', async (_req: Request, res: Response) => {
  try {
    const result = await syncEngine.scanAllConfirmedOrdersForMultiMerchant();
    res.json({ success: true, result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 15. Server-Sent Events (SSE) Stream
apiRouter.get('/events/live', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send initial connected packet
  res.write(`data: ${JSON.stringify({ event: 'connected', payload: { time: new Date().toISOString() } })}\n\n`);

  const unregister = syncEngine.registerSSEClient(({ event, payload }) => {
    res.write(`data: ${JSON.stringify({ event, payload })}\n\n`);
  });

  // Heartbeat ping every 15s to keep connection alive
  const pingInterval = setInterval(() => {
    res.write(`data: ${JSON.stringify({ event: 'heartbeat', payload: { time: Date.now() } })}\n\n`);
  }, 15000);

  req.on('close', () => {
    clearInterval(pingInterval);
    unregister();
  });
});
