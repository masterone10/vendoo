import crypto from 'node:crypto';
import {
  db,
  isDateInHot,
  getCoverageRecord,
  saveCoverageRecord,
  HistoricalCoverageRecord,
  getCairoDateString,
  getCairoDateInterval,
} from './db.js';
import {
  vendoorClient,
  VendoorRawOrder,
  VendoorRawProduct,
  ConfirmationRow,
  LogEntry,
} from './vendoorClient.js';

export interface SyncEngineStatus {
  isRunning: boolean;
  lastSyncStartedAt: string | null;
  lastSyncCompletedAt: string | null;
  lastSuccessfulSyncAt: string | null;
  currentPhase: string;
  totalOrdersInDb: number;
  totalAlertsOpen: number;
  lastError: string | null;
  consecutiveFailures: number;
}

export interface AgeCalculationResult {
  ageInDays: number | null;
  ageBucket: 'less_than_2_days' | '2_to_4_days' | '4_to_5_days' | 'over_5_days' | 'unknown';
}

/**
 * Shared, mutually exclusive age calculation.
 * 1. less_than_2_days (< 2 days)
 * 2. 2_to_4_days (>= 2 and < 4 days)
 * 3. 4_to_5_days (>= 4 and <= 5 days)
 * 4. over_5_days (> 5 days)
 * 5. unknown (missing, invalid, or unverified timestamp)
 */
export function calculateAgeBucket(timestampStr: string | null | undefined, nowMs: number = Date.now()): AgeCalculationResult {
  if (!timestampStr) {
    return { ageInDays: null, ageBucket: 'unknown' };
  }
  const cleanStr = String(timestampStr).trim();
  if (!cleanStr) {
    return { ageInDays: null, ageBucket: 'unknown' };
  }
  const t = new Date(cleanStr).getTime();
  if (isNaN(t) || t <= 0) {
    return { ageInDays: null, ageBucket: 'unknown' };
  }
  const diffDays = Math.max(0, (nowMs - t) / (1000 * 60 * 60 * 24));
  const rounded = Math.round(diffDays * 10) / 10;
  if (diffDays < 2) {
    return { ageInDays: rounded, ageBucket: 'less_than_2_days' };
  } else if (diffDays >= 2 && diffDays < 4) {
    return { ageInDays: rounded, ageBucket: '2_to_4_days' };
  } else if (diffDays >= 4 && diffDays <= 5) {
    return { ageInDays: rounded, ageBucket: '4_to_5_days' };
  } else {
    return { ageInDays: rounded, ageBucket: 'over_5_days' };
  }
}

/**
 * Retrieves the genuine qualifying Processing transition timestamp for an order.
 * Strictly from Vendoor logs or recorded status events; never falls back to created_at or local sync time.
 */
export function getProcessingTransitionTime(orderId: number, orderCode?: string): string | null {
  const evt: any = db.prepare(`
    SELECT event_time_source
    FROM order_status_events
    WHERE order_id = ? AND to_status = 'Processing' AND event_time_source IS NOT NULL
    ORDER BY id DESC
    LIMIT 1
  `).get(orderId);

  if (evt && evt.event_time_source) {
    return evt.event_time_source;
  }

  if (orderCode) {
    const canon: any = db.prepare(`
      SELECT event_timestamp
      FROM canonical_activity_events
      WHERE order_code = ? AND to_status = 'Processing'
      ORDER BY id DESC
      LIMIT 1
    `).get(orderCode);

    if (canon && canon.event_timestamp) {
      return canon.event_timestamp;
    }
  }

  return null;
}

/**
 * Decode common HTML entities from Vendoor text
 */
export function decodeHtmlEntities(str: string): string {
  if (!str) return '';
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
}

/**
 * Extracts verified warehouse name from a Vendoor product object or product name.
 * e.g. "Oncloud slipper code Tex12 ( مخزن Te1 )" -> "مخزن Te1"
 * Returns null if no warehouse identifier is present. Never guesses.
 */
export function extractWarehouseFromProduct(p: VendoorRawProduct): string | null {
  const name = p.name || '';
  const warehouseMatch = name.match(/\(\s*مخزن\s*([^)]+)\s*\)/i);
  if (warehouseMatch && warehouseMatch[1]?.trim()) {
    return `مخزن ${warehouseMatch[1].trim()}`;
  }
  const codeMatch = name.match(/\(\s*كود\s*([^)]+)\s*\)/i);
  if (codeMatch && codeMatch[1]?.trim()) {
    return `كود ${codeMatch[1].trim()}`;
  }
  if (p.warehouse_name && String(p.warehouse_name).trim()) {
    return String(p.warehouse_name).trim();
  }
  return null;
}

/**
 * Evaluates distinct warehouses across an order's product list.
 */
export function extractDistinctWarehouses(products: VendoorRawProduct[]): {
  warehouses: string[];
  isMultiWarehouse: boolean;
  isUnresolved: boolean;
} {
  const set = new Set<string>();
  let hasUnknown = false;
  for (const p of products) {
    const w = extractWarehouseFromProduct(p);
    if (w) {
      set.add(w);
    } else {
      hasUnknown = true;
    }
  }
  const warehouses = Array.from(set);
  return {
    warehouses,
    isMultiWarehouse: warehouses.length > 1,
    isUnresolved: warehouses.length === 0 && products.length > 0,
  };
}

/**
 * Unicode-aware address quality check
 */
export function evaluateAddressQuality(address: string | null | undefined): {
  isConfirmedShort: boolean;
  isConfirmedLatin: boolean;
  wordCount: number;
  latinRatio: number;
  status: 'VALID' | 'SHORT_ADDRESS' | 'LATIN_SCRIPT' | 'MISSING' | 'NOT_RETRIEVED';
} {
  if (address === null || address === undefined) {
    return { isConfirmedShort: false, isConfirmedLatin: false, wordCount: 0, latinRatio: 0, status: 'NOT_RETRIEVED' };
  }
  const clean = address.trim();
  if (!clean) {
    return { isConfirmedShort: false, isConfirmedLatin: false, wordCount: 0, latinRatio: 0, status: 'MISSING' };
  }
  const words = clean.match(/[\p{L}\p{N}]+/gu) || [];
  const wordCount = words.length;
  const isConfirmedShort = wordCount <= 3;

  const lettersOnly = clean.replace(/[^\p{L}]/gu, '');
  let latinRatio = 0;
  if (lettersOnly.length > 0) {
    const latinLetters = lettersOnly.match(/[A-Za-z]/g) || [];
    latinRatio = latinLetters.length / lettersOnly.length;
  }
  const isConfirmedLatin = latinRatio > 0.6; // >60% Latin

  let status: 'VALID' | 'SHORT_ADDRESS' | 'LATIN_SCRIPT' | 'MISSING' | 'NOT_RETRIEVED' = 'VALID';
  if (isConfirmedShort) status = 'SHORT_ADDRESS';
  else if (isConfirmedLatin) status = 'LATIN_SCRIPT';

  return { isConfirmedShort, isConfirmedLatin, wordCount, latinRatio, status };
}

type SSEListener = (data: { event: string; payload: any }) => void;

export class SyncEngine {
  private isSyncing = false;
  private intervalTimer: NodeJS.Timeout | null = null;
  private sseClients: Set<SSEListener> = new Set();
  private status: SyncEngineStatus = {
    isRunning: false,
    lastSyncStartedAt: null,
    lastSyncCompletedAt: null,
    lastSuccessfulSyncAt: null,
    currentPhase: 'IDLE',
    totalOrdersInDb: 0,
    totalAlertsOpen: 0,
    lastError: null,
    consecutiveFailures: 0,
  };

  public getStatus(): SyncEngineStatus {
    const ordersCount = (db.prepare('SELECT COUNT(*) as count FROM orders').get() as any)?.count || 0;
    const alertsCount = (db.prepare("SELECT COUNT(*) as count FROM alerts WHERE status != 'RESOLVED'").get() as any)?.count || 0;
    return {
      ...this.status,
      totalOrdersInDb: ordersCount,
      totalAlertsOpen: alertsCount,
    };
  }

  public registerSSEClient(listener: SSEListener): () => void {
    this.sseClients.add(listener);
    listener({ event: 'status', payload: this.getStatus() });
    return () => {
      this.sseClients.delete(listener);
    };
  }

  private broadcast(event: string, payload: any) {
    for (const listener of this.sseClients) {
      try {
        listener({ event, payload });
      } catch (err) {
        // client disconnected
      }
    }
  }

  public start(intervalSeconds = 30) {
    if (this.intervalTimer) return;
    this.status.isRunning = true;
    console.log(`[SyncEngine] Starting background sync worker (interval: ${intervalSeconds}s)...`);

    // Run initial sync cycle
    this.runFullSyncCycle('INITIAL').catch(err => {
      console.error('[SyncEngine] Initial sync error:', err.message);
    });

    this.intervalTimer = setInterval(() => {
      this.runFullSyncCycle('PERIODIC').catch(err => {
        console.error('[SyncEngine] Periodic sync error:', err.message);
      });
    }, intervalSeconds * 1000);
  }

  public stop() {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    this.status.isRunning = false;
  }

  public async triggerManualSync(): Promise<SyncEngineStatus> {
    if (this.isSyncing) {
      return this.getStatus();
    }
    await this.runFullSyncCycle('MANUAL');
    return this.getStatus();
  }

  /**
   * Helper to normalize raw status button HTML and Arabic text into standard statuses
   */
  public parseStatusString(rawStatusHtml: string): string {
    if (!rawStatusHtml) return 'Unknown';
    const clean = rawStatusHtml.replace(/<[^>]+>/g, '').trim();
    if (clean.includes('Printed') || clean.includes('طباعة') || clean.includes('مطبوع')) return 'Printed';
    if (clean.includes('Pending') || clean.includes('معلق')) return 'Pending';
    if (clean.includes('Processing') || clean.includes('قيد التجهيز') || clean.includes('قيد التنفيذ')) return 'Processing';
    if (clean.includes('Canceling') || clean.includes('قيد الالغاء') || clean.includes('قيد الإلغاء')) return 'Canceling';
    if (clean.includes('Cancel') || clean.includes('ملغي') || clean.includes('ملغى') || clean.includes('تم الإلغاء')) return 'Canceled';
    if (clean.includes('New') || clean.includes('جديد')) return 'New';
    if (clean.includes('Shipped') || clean.includes('شحن')) return 'Shipped';
    if (clean.includes('Delivered') || clean.includes('تسليم')) return 'Delivered';
    return clean || 'Unknown';
  }

  /**
   * Reconciles order items in place without destructive churn.
   * Updates existing lines by vendoor_item_id, inserts new lines,
   * and preserves existing lines on partial/failed responses.
   */
  public reconcileOrderProducts(orderDbId: number, products: VendoorRawProduct[], nowIso: string): { distinctWarehouses: string[]; isMultiWarehouse: boolean } {
    if (!products || products.length === 0) {
      return { distinctWarehouses: [], isMultiWarehouse: false };
    }

    const existingItems: any[] = db.prepare('SELECT id, vendoor_item_id, product_id, sku, quantity, unit_price, merchant_code, product_name FROM order_items WHERE order_id = ?').all(orderDbId);
    const existingMap = new Map<number, any>();
    for (const it of existingItems) {
      if (it.vendoor_item_id) existingMap.set(it.vendoor_item_id, it);
    }

    const seenIds = new Set<number>();
    const warehouseSet = new Set<string>();

    const insertItemStmt = db.prepare(`
      INSERT INTO order_items (
        order_id, vendoor_item_id, product_id, product_name, merchant_code,
        sku, size, color, quantity, unit_price, pay_vendor, image_path, raw_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const updateItemStmt = db.prepare(`
      UPDATE order_items SET
        product_name = ?,
        merchant_code = ?,
        warehouse_name = ?,
        sku = ?,
        size = ?,
        color = ?,
        quantity = ?,
        unit_price = ?,
        pay_vendor = ?,
        image_path = COALESCE(?, image_path)
      WHERE id = ?
    `);

    for (const p of products) {
      const warehouse = extractWarehouseFromProduct(p);
      if (warehouse) warehouseSet.add(warehouse);

      const itemId = p.pivot?.id || null;
      const unitPrice = parseFloat(p.pivot?.price || '0') || 0;
      const payVendor = parseFloat(p.pivot?.pay_vendor || '0') || 0;
      const qty = p.pivot?.quantity || 1;
      const productName = p.name || 'منتج';
      const sku = p.pivot?.code || null;
      const size = p.pivot?.size || null;
      const color = p.pivot?.color || null;
      const warehouseDisplay = warehouse || 'غير محدد';

      if (itemId && existingMap.has(itemId)) {
        seenIds.add(itemId);
        const curr = existingMap.get(itemId);
        if (curr.quantity !== qty || curr.unit_price !== unitPrice || curr.product_name !== productName || curr.merchant_code !== warehouseDisplay) {
          updateItemStmt.run(productName, warehouseDisplay, warehouse, sku, size, color, qty, unitPrice, payVendor, p.image_path || null, curr.id);
        }
      } else {
        insertItemStmt.run(
          orderDbId,
          itemId,
          p.id || null,
          productName,
          warehouseDisplay,
          sku,
          size,
          color,
          qty,
          unitPrice,
          payVendor,
          p.image_path || null,
          JSON.stringify(p),
          nowIso
        );
        if (itemId) seenIds.add(itemId);
      }
    }

    return {
      distinctWarehouses: Array.from(warehouseSet),
      isMultiWarehouse: warehouseSet.size > 1,
    };
  }

  /**
   * Evaluates business risk alerts for an order
   */
  public evaluateOrderAlerts(orderDbId: number, randomNum: string, currentStatus: string, isMultiWarehouse: number, warehouses: string[], nowIso: string): number {
    let triggered = 0;
    const insertAlertStmt = db.prepare(`
      INSERT INTO alerts (
        alert_key, order_id, random_number, alert_type, severity,
        status, title, description, details_json, is_pre_existing,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(alert_key) DO UPDATE SET
        status = CASE WHEN alerts.status = 'RESOLVED' THEN 'OPEN' ELSE alerts.status END,
        updated_at = excluded.updated_at
    `);

    // 1. Multi-Warehouse on Printed Orders
    if (currentStatus === 'Printed' && isMultiWarehouse === 1) {
      const alertKey = `MULTI_WAREHOUSE_${randomNum}`;
      insertAlertStmt.run(
        alertKey,
        orderDbId,
        randomNum,
        'MULTIPLE_MERCHANT_CODES',
        'CRITICAL',
        'OPEN',
        `طلب مؤكد يحتوي منتجات من ${warehouses.length} مخازن مختلفة (${randomNum})`,
        `الطلب في حالة Printed ويحتوي على أصناف من مخازن مستقلة: ${warehouses.join('، ')}`,
        JSON.stringify({ orderId: orderDbId, randomNum, warehouses }),
        0,
        nowIso,
        nowIso
      );
      triggered++;
    }

    // 2. Low delivery rate (< 70% strictly, unknown is NOT low)
    const orderRow: any = db.prepare('SELECT delivery_rate, customer_phone_extra, extra_phone_status, address_quality_status, created_at_source FROM orders WHERE id = ?').get(orderDbId);
    if (orderRow) {
      if (orderRow.delivery_rate !== null && orderRow.delivery_rate !== undefined && orderRow.delivery_rate < 70) {
        const alertKey = `LOW_DELIVERY_${randomNum}`;
        insertAlertStmt.run(
          alertKey,
          orderDbId,
          randomNum,
          'LOW_DELIVERY_RATE',
          'WARNING',
          'OPEN',
          `نسبة تسليم منخفضة للعميل (${orderRow.delivery_rate}%) - (${randomNum})`,
          `العميل لديه نسبة تسليم مؤكدة أقل من 70% (${orderRow.delivery_rate}%)، يرجى مراجعة الجدية قبل الشحن.`,
          JSON.stringify({ deliveryRate: orderRow.delivery_rate }),
          0,
          nowIso,
          nowIso
        );
        triggered++;
      }

      // 3. Confirmed absent extra phone in Printed state
      if (currentStatus === 'Printed' && orderRow.extra_phone_status === 'CONFIRMED_ABSENT') {
        const alertKey = `NO_EXTRA_PHONE_${randomNum}`;
        insertAlertStmt.run(
          alertKey,
          orderDbId,
          randomNum,
          'MISSING_EXTRA_PHONE',
          'WARNING',
          'OPEN',
          `طلب مؤكد دون هاتف إضافي (${randomNum})`,
          `تم التأكد من غياب رقم الهاتف الإضافي في بيانات الطلب المطبوع.`,
          JSON.stringify({ extraPhoneStatus: orderRow.extra_phone_status }),
          0,
          nowIso,
          nowIso
        );
        triggered++;
      }

      // 4. Low address quality
      if (currentStatus === 'Printed' && (orderRow.address_quality_status === 'SHORT_ADDRESS' || orderRow.address_quality_status === 'LATIN_SCRIPT')) {
        const alertKey = `POOR_ADDRESS_${randomNum}`;
        const reason = orderRow.address_quality_status === 'SHORT_ADDRESS' ? 'العنوان يحتوي 3 كلمات أو أقل' : 'العنوان مكتوب بحروف لاتينية / إنجليزية';
        insertAlertStmt.run(
          alertKey,
          orderDbId,
          randomNum,
          'INCOMPLETE_DATA',
          'INFO',
          'OPEN',
          `ملاحظة جودة عنوان الطلب (${randomNum})`,
          `طلب في حالة Printed مع ملاحظة عنوان: ${reason}`,
          JSON.stringify({ addressQualityStatus: orderRow.address_quality_status }),
          0,
          nowIso,
          nowIso
        );
        triggered++;
      }

      // 5. Long-running Pending (> 5 days)
      if (currentStatus === 'Pending' && orderRow.created_at_source) {
        const ageRes = calculateAgeBucket(orderRow.created_at_source);
        if (ageRes.ageBucket === 'over_5_days') {
          const alertKey = `LONG_PENDING_${randomNum}`;
          insertAlertStmt.run(
            alertKey,
            orderDbId,
            randomNum,
            'INCOMPLETE_DATA',
            'WARNING',
            'OPEN',
            `طلب معلق متجاوز 5 أيام (${randomNum})`,
            `الطلب في حالة Pending منذ ${ageRes.ageInDays} يوم، متجاوزاً الحد التشغيلي الموصى به.`,
            JSON.stringify({ ageInDays: ageRes.ageInDays }),
            0,
            nowIso,
            nowIso
          );
          triggered++;
        }
      }
    }

    return triggered;
  }

  /**
   * Field-aware canonical order upsert using vendoor_id as primary source key
   */
  public upsertCanonicalOrder(rawOrder: VendoorRawOrder, nowIso: string): {
    orderDbId: number;
    isNew: boolean;
    statusChanged: boolean;
    previousStatus: string | null;
    currentStatus: string;
  } {
    const vendoorId = rawOrder.id;
    if (!vendoorId) {
      throw new Error('Order missing required vendoor_id');
    }

    const currentStatus = this.parseStatusString(rawOrder.status);
    const rawProducts = rawOrder.products || [];
    const { warehouses, isMultiWarehouse } = extractDistinctWarehouses(rawProducts);
    const distinctCount = warehouses.length > 0 ? warehouses.length : 1;
    const multiWarehouseFlag = isMultiWarehouse ? 1 : 0;
    const orderCreatedAt = rawOrder.created_at || nowIso;
    const orderTier = isDateInHot(orderCreatedAt) ? 'HOT' : 'COLD';
    const addressEval = evaluateAddressQuality(rawOrder.address);

    let existing: any = db.prepare('SELECT * FROM orders WHERE vendoor_id = ?').get(vendoorId);
    if (!existing && rawOrder.random_number) {
      existing = db.prepare('SELECT * FROM orders WHERE random_number = ?').get(rawOrder.random_number);
    }

    let orderDbId: number;
    let isNew = false;
    let statusChanged = false;
    let previousStatus: string | null = null;

    if (!existing) {
      isNew = true;
      const res = db.prepare(`
        INSERT INTO orders (
          vendoor_id, random_number, order_no, order_type, current_status, status_raw,
          affiliate_code, affiliate_name, affiliate_id, customer_name, customer_phone,
          governorate, address, total_price, shipping_cost, total_order,
          created_at_source, shipping_date, printed_date, distinct_merchant_count,
          multi_merchant_flag, state_entry_at, storage_tier,
          address_word_count, address_is_latin, address_quality_status,
          last_observed_at, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?
        )
      `).run(
        vendoorId,
        rawOrder.random_number || `VND_${vendoorId}`,
        rawOrder.order_no || null,
        rawOrder.order_type || 'اوردر جديد',
        currentStatus,
        rawOrder.status || '',
        rawOrder.affiliate_code || '',
        rawOrder.affiliate_name || '',
        rawOrder.affiliate_id || null,
        rawOrder.full_name || '',
        rawOrder.phone || '',
        rawOrder.governrate_name || '',
        rawOrder.address || '',
        rawOrder.total_price || 0,
        parseFloat(rawOrder.shipping_cost || '0') || 0,
        parseFloat(rawOrder.total_order || '0') || 0,
        orderCreatedAt,
        rawOrder.shipping_date || null,
        rawOrder.printed_date || null,
        distinctCount,
        multiWarehouseFlag,
        nowIso,
        orderTier,
        addressEval.wordCount,
        addressEval.isConfirmedLatin ? 1 : 0,
        addressEval.status,
        nowIso,
        nowIso,
        nowIso
      );

      orderDbId = Number(res.lastInsertRowid);

      db.prepare(`
        INSERT INTO order_status_events (
          order_id, random_number, from_status, to_status, actor_name,
          event_time_source, storage_tier, observed_at, source_channel
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        orderDbId,
        rawOrder.random_number || `VND_${vendoorId}`,
        null,
        currentStatus,
        'استيراد أولي',
        orderCreatedAt,
        orderTier,
        nowIso,
        'initial_import'
      );
    } else {
      orderDbId = existing.id;
      previousStatus = existing.current_status;
      statusChanged = existing.current_status !== currentStatus;

      db.prepare(`
        UPDATE orders SET
          vendoor_id = ?,
          random_number = COALESCE(?, random_number),
          order_no = COALESCE(?, order_no),
          order_type = COALESCE(?, order_type),
          current_status = ?,
          status_raw = COALESCE(?, status_raw),
          affiliate_code = COALESCE(?, affiliate_code),
          affiliate_name = COALESCE(?, affiliate_name),
          customer_name = COALESCE(?, customer_name),
          customer_phone = COALESCE(?, customer_phone),
          governorate = COALESCE(?, governorate),
          address = COALESCE(?, address),
          total_price = CASE WHEN ? > 0 THEN ? ELSE total_price END,
          shipping_cost = CASE WHEN ? > 0 THEN ? ELSE shipping_cost END,
          total_order = CASE WHEN ? > 0 THEN ? ELSE total_order END,
          shipping_date = COALESCE(?, shipping_date),
          printed_date = COALESCE(?, printed_date),
          distinct_merchant_count = ?,
          multi_merchant_flag = ?,
          address_word_count = COALESCE(?, address_word_count),
          address_is_latin = ?,
          address_quality_status = ?,
          state_entry_at = CASE WHEN current_status != ? THEN ? ELSE state_entry_at END,
          last_observed_at = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        vendoorId,
        rawOrder.random_number || null,
        rawOrder.order_no || null,
        rawOrder.order_type || null,
        currentStatus,
        rawOrder.status || null,
        rawOrder.affiliate_code || null,
        rawOrder.affiliate_name || null,
        rawOrder.full_name || null,
        rawOrder.phone || null,
        rawOrder.governrate_name || null,
        rawOrder.address || null,
        rawOrder.total_price || 0,
        rawOrder.total_price || 0,
        parseFloat(rawOrder.shipping_cost || '0') || 0,
        parseFloat(rawOrder.shipping_cost || '0') || 0,
        parseFloat(rawOrder.total_order || '0') || 0,
        parseFloat(rawOrder.total_order || '0') || 0,
        rawOrder.shipping_date || null,
        rawOrder.printed_date || null,
        distinctCount,
        multiWarehouseFlag,
        addressEval.wordCount,
        addressEval.isConfirmedLatin ? 1 : 0,
        addressEval.status,
        currentStatus,
        nowIso,
        nowIso,
        nowIso,
        orderDbId
      );

      if (statusChanged) {
        db.prepare(`
          INSERT INTO order_status_events (
            order_id, random_number, from_status, to_status, actor_name,
            event_time_source, storage_tier, observed_at, source_channel
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          orderDbId,
          rawOrder.random_number || existing.random_number,
          previousStatus,
          currentStatus,
          'النظام',
          nowIso,
          orderTier,
          nowIso,
          'poll_detection'
        );
      }
    }

    if (rawProducts.length > 0) {
      this.reconcileOrderProducts(orderDbId, rawProducts, nowIso);
    }

    this.evaluateOrderAlerts(orderDbId, rawOrder.random_number || existing?.random_number || `VND_${vendoorId}`, currentStatus, multiWarehouseFlag, warehouses, nowIso);

    return { orderDbId, isNew, statusChanged, previousStatus, currentStatus };
  }

  /**
   * Full synchronization cycle:
   * Covers all orders with full pagination across batches,
   * updates canonical orders, synchronizes confirmation age pages,
   * fetches full system logs, and enriches customer intelligence.
   */
  public async runFullSyncCycle(runType: 'INITIAL' | 'PERIODIC' | 'RECONCILIATION' | 'MANUAL') {
    if (this.isSyncing) return;
    this.isSyncing = true;
    const nowIso = new Date().toISOString();
    this.status.lastSyncStartedAt = nowIso;
    this.status.currentPhase = 'SCANNING_ORDERS';

    let ordersScanned = 0;
    let ordersCreated = 0;
    let ordersUpdated = 0;
    let eventsDetected = 0;
    let alertsTriggered = 0;
    let errorsCount = 0;
    let hasFailedPage = false;
    let errorMessage: string | null = null;

    try {
      console.log(`[SyncEngine] Starting ${runType} sync cycle...`);

      // 1. Scan Orders: First page to get total and records
      const firstBatch = await vendoorClient.fetchOrdersBatch(0, 100);
      const totalOrdersInSource = firstBatch.recordsTotal;
      let allOrders: VendoorRawOrder[] = [...firstBatch.data];

      // In EVERY cycle (including PERIODIC), paginate through all pages to guarantee complete coverage
      const batchSize = 100;
      for (let start = 100; start < totalOrdersInSource; start += batchSize) {
        try {
          const nextBatch = await vendoorClient.fetchOrdersBatch(start, batchSize);
          allOrders = allOrders.concat(nextBatch.data);
        } catch (pageErr: any) {
          console.error(`[SyncEngine] Error fetching orders batch at start ${start}:`, pageErr.message);
          errorsCount++;
          hasFailedPage = true;
          errorMessage = `Failed to fetch page at offset ${start}: ${pageErr.message}`;
          break;
        }
      }

      ordersScanned = allOrders.length;
      this.status.currentPhase = 'PROCESSING_ORDERS';

      const enrichmentQueue: { id: number; phone: string; vendoorId: number; random_number: string; status: string }[] = [];

      db.exec('BEGIN TRANSACTION;');

      for (const rawOrder of allOrders) {
        if (!rawOrder.id) continue;
        const upsertRes = this.upsertCanonicalOrder(rawOrder, nowIso);
        if (upsertRes.isNew) ordersCreated++;
        else ordersUpdated++;
        if (upsertRes.statusChanged) eventsDetected++;

        if (rawOrder.phone) {
          enrichmentQueue.push({
            id: upsertRes.orderDbId,
            phone: rawOrder.phone,
            vendoorId: rawOrder.id,
            random_number: rawOrder.random_number || `VND_${rawOrder.id}`,
            status: upsertRes.currentStatus,
          });
        }
      }

      db.exec('COMMIT;');

      // 2. Synchronize Confirmation Age Pages
      this.status.currentPhase = 'SYNCING_CONFIRMATION_AGES';
      await this.syncConfirmationAges(nowIso);

      // 3. Synchronize System Logs & Employee Canonical Events (full pagination)
      this.status.currentPhase = 'SYNCING_SYSTEM_LOGS';
      const logRes = await this.syncSystemLogs(nowIso);
      if (logRes.hasErrors) {
        errorsCount++;
      }

      // 4. Enrich Customer Intelligence and Extra Phones
      this.status.currentPhase = 'ENRICHING_CUSTOMERS';
      await this.enrichCustomerIntelligenceBatch(enrichmentQueue.slice(0, 20), nowIso);

      // 5. Enrich Additional Phone for Printed orders needing check
      await this.enrichAdditionalPhones(nowIso);

      this.status.lastSuccessfulSyncAt = new Date().toISOString();
      this.status.lastSyncCompletedAt = this.status.lastSuccessfulSyncAt;
      this.status.consecutiveFailures = 0;
      this.status.lastError = hasFailedPage ? errorMessage : null;
      this.status.currentPhase = 'IDLE';

      const finalStatus = hasFailedPage ? 'PARTIAL' : 'SUCCESS';

      console.log(
        `[SyncEngine] ${runType} sync completed (${finalStatus}): ${ordersScanned} scanned, ${ordersCreated} new, ${ordersUpdated} updated, ${eventsDetected} status changes.`
      );

      db.prepare(`
        INSERT INTO sync_runs (
          run_type, status, orders_scanned, orders_created, orders_updated,
          events_detected, alerts_triggered, errors_count, started_at, completed_at, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runType,
        finalStatus,
        ordersScanned,
        ordersCreated,
        ordersUpdated,
        eventsDetected,
        alertsTriggered,
        errorsCount,
        nowIso,
        this.status.lastSyncCompletedAt,
        hasFailedPage ? errorMessage : null
      );

      this.broadcast('sync_completed', this.getStatus());
    } catch (err: any) {
      console.error('[SyncEngine Detailed Error]:', err);
      try {
        db.exec('ROLLBACK;');
      } catch {
        // no transaction active
      }
      errorMessage = err.message;
      this.status.lastError = errorMessage;
      this.status.consecutiveFailures++;
      this.status.currentPhase = 'ERROR';

      db.prepare(`
        INSERT INTO sync_runs (
          run_type, status, orders_scanned, orders_created, orders_updated,
          errors_count, started_at, completed_at, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runType,
        'FAILED',
        ordersScanned,
        ordersCreated,
        ordersUpdated,
        errorsCount + 1,
        nowIso,
        new Date().toISOString(),
        errorMessage
      );

      this.broadcast('sync_error', { error: errorMessage });
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Sync confirmation age pages (1 day, 2 days, 3 days, >3 days)
   */
  private async syncConfirmationAges(nowIso: string) {
    const categories: Array<{ key: 'one' | 'two' | 'three' | 'over_three'; label: string }> = [
      { key: 'one', label: '1_day' },
      { key: 'two', label: '2_days' },
      { key: 'three', label: '3_days' },
      { key: 'over_three', label: 'over_3_days' },
    ];

    const updateConfStmt = db.prepare(`
      UPDATE orders SET
        confirmation_age_category = ?,
        confirmation_age_observed_at = ?,
        printed_date = COALESCE(?, printed_date)
      WHERE random_number = ?
    `);

    const insertObsStmt = db.prepare(`
      INSERT INTO confirmation_age_observations (
        order_id, random_number, age_category, invoice_no, printed_date, observed_at
      ) VALUES (
        (SELECT id FROM orders WHERE random_number = ?),
        ?, ?, ?, ?, ?
      )
    `);

    for (const cat of categories) {
      try {
        const rows: ConfirmationRow[] = await vendoorClient.fetchConfirmationAgePage(cat.key);
        for (const r of rows) {
          if (!r.randomNumber) continue;
          updateConfStmt.run(cat.label, nowIso, r.printedDate || null, r.randomNumber);
          insertObsStmt.run(r.randomNumber, r.randomNumber, cat.label, r.invoiceNo, r.printedDate, nowIso);
        }
      } catch (err: any) {
        console.warn(`[SyncEngine] Warning fetching confirmation age page ${cat.key}:`, err.message);
      }
    }
  }

  /**
   * Sync System Logs into Raw Activity and Canonical Events with full pagination
   */
  public async syncSystemLogs(nowIso: string, targetDate?: string): Promise<{ totalLogs: number; newSaved: number; hasErrors: boolean }> {
    let hasErrors = false;
    try {
      const dateToSync = targetDate || getCairoDateString();
      const firstPage = await vendoorClient.fetchSystemLogs(1, dateToSync, dateToSync);
      const totalPages = Math.max(1, firstPage.totalPages);
      let allEntries: LogEntry[] = [...firstPage.entries];

      for (let p = 2; p <= totalPages; p++) {
        try {
          const pageData = await vendoorClient.fetchSystemLogs(p, dateToSync, dateToSync);
          allEntries = allEntries.concat(pageData.entries);
        } catch (pageErr: any) {
          console.warn(`[SyncEngine] Page ${p} log fetch failed:`, pageErr.message);
          hasErrors = true;
          break;
        }
      }

      const insertRawStmt = db.prepare(`
        INSERT OR IGNORE INTO raw_activity_events (
          source_hash, order_code, actor_name, raw_action_text,
          event_timestamp, storage_tier, observed_at, page_source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertCanonicalStmt = db.prepare(`
        INSERT INTO canonical_activity_events (
          raw_event_id, order_code, actor_name, action_type,
          from_status, to_status, event_timestamp, storage_tier, is_system_actor, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      let newCanonicalCount = 0;
      for (const entry of allEntries) {
        const rawText = decodeHtmlEntities(entry.rawActionText || '');
        const hashInput = `${entry.orderCode}_${entry.actorName}_${rawText}_${entry.eventTimestamp}`;
        const sourceHash = crypto.createHash('sha256').update(hashInput).digest('hex');
        const logTier = isDateInHot(entry.eventTimestamp) ? 'HOT' : 'COLD';

        const rawResult = insertRawStmt.run(
          sourceHash,
          entry.orderCode || null,
          entry.actorName || 'غير معروف',
          rawText,
          entry.eventTimestamp,
          logTier,
          nowIso,
          'log/system'
        );

        if (rawResult.changes > 0) {
          const rawId = Number(rawResult.lastInsertRowid);
          const { actionType, fromStatus, toStatus } = this.classifyAction(rawText);
          const isSystem = (entry.actorName || '').toLowerCase().includes('system') || (entry.actorName || '').includes('تلقائي') || (entry.actorName || '').includes('النظام') ? 1 : 0;

          insertCanonicalStmt.run(
            rawId,
            entry.orderCode || null,
            entry.actorName || 'غير معروف',
            actionType,
            fromStatus,
            toStatus,
            entry.eventTimestamp,
            logTier,
            isSystem,
            nowIso
          );
          newCanonicalCount++;
        }
      }

      // Record historical coverage
      saveCoverageRecord({
        accountId: 'primary',
        sourceDomain: 'logs',
        periodDate: dateToSync,
        storageTier: isDateInHot(dateToSync) ? 'HOT' : 'COLD',
        pagesDiscovered: totalPages,
        pagesRead: totalPages,
        recordsExtracted: allEntries.length,
        recordsSaved: newCanonicalCount,
        completionStatus: hasErrors ? 'PARTIAL' : 'COMPLETE',
        lastAttemptedAt: nowIso,
        completedAt: hasErrors ? null : nowIso,
      });

      return { totalLogs: allEntries.length, newSaved: newCanonicalCount, hasErrors };
    } catch (err: any) {
      console.warn('[SyncEngine] Warning syncing system logs:', err.message);
      return { totalLogs: 0, newSaved: 0, hasErrors: true };
    }
  }

  /**
   * Classify raw Arabic/English action text into canonical action type.
   * Accurately parses status changes, notes, phone edits, address edits,
   * product edits, financial edits, staff assignment, and order creation.
   */
  public classifyAction(text: string): { actionType: string; fromStatus: string | null; toStatus: string | null } {
    if (!text) return { actionType: 'other', fromStatus: null, toStatus: null };

    const t = decodeHtmlEntities(text).trim();

    // 1. NOTES: If it's a note/comment, it is strictly note_added even if it mentions status words!
    if (t.includes('ملاحظة:') || t.includes('ملاحظه:') || t.includes('note:')) {
      return { actionType: 'note_added', fromStatus: null, toStatus: null };
    }

    // 2. ORDER CREATED: Genuine new order creation
    if (t.includes('أضاف اوردر جديد') || t.includes('انشاء اوردر') || t.includes('طلب جديد') || t.includes('create order')) {
      return { actionType: 'order_created', fromStatus: null, toStatus: 'New' };
    }

    // 3. STATUS CHANGE PATTERNS:
    // Pattern A: عدل ... حالة الطلب/الاوردر من 'X' إلى/إلي 'Y'
    const fullFromToMatch = t.match(/حالة\s+(?:الطلب|الاوردر)\s+من\s*['"״]?([^'"״\s]+)['"״]?\s*(?:إلى|إلي|الى)\s*['"״]?([^'"״\s]+)['"״]?/i);
    if (fullFromToMatch) {
      return {
        actionType: 'status_change',
        fromStatus: this.parseStatusString(fullFromToMatch[1]),
        toStatus: this.parseStatusString(fullFromToMatch[2]),
      };
    }

    // Pattern B: عدل ... حالة الطلب/الاوردر إلى/إلي 'Y'
    const toOnlyMatch = t.match(/حالة\s+(?:الطلب|الاوردر)\s+(?:إلى|إلي|الى)\s*['"״]?([^'"״\s]+)['"״]?/i);
    if (toOnlyMatch) {
      return {
        actionType: 'status_change',
        fromStatus: null,
        toStatus: this.parseStatusString(toOnlyMatch[1]),
      };
    }

    // Pattern C: عدل حالة الاوردر الى Printed
    const altStatusMatch = t.match(/(?:عدل|تغيير)\s+(?:حالة\s+)?(?:الطلب|الاوردر)\s+(?:إلى|إلي|الى)\s*([a-zA-Z\u0600-\u06FF]+)/i);
    if (altStatusMatch) {
      const parsedTo = this.parseStatusString(altStatusMatch[1]);
      if (parsedTo !== 'Unknown') {
        return {
          actionType: 'status_change',
          fromStatus: null,
          toStatus: parsedTo,
        };
      }
    }

    // 4. PHONE EDITS:
    if (t.includes('هاتف') || t.includes('موبايل') || t.includes('تليفون') || t.includes('رقم إضافي') || t.includes('رقم اضافي')) {
      return { actionType: 'phone_edit', fromStatus: null, toStatus: null };
    }

    // 5. ADDRESS EDITS:
    if (t.includes('عنوان') || t.includes('محافظة') || t.includes('مدينة') || t.includes('address')) {
      return { actionType: 'address_edit', fromStatus: null, toStatus: null };
    }

    // 6. PRODUCT EDITS:
    if (t.includes('منتج جديد') || t.includes('حذف منتج') || t.includes('تعديل منتج') || t.includes('مقاس') || t.includes('اللون')) {
      return { actionType: 'product_edit', fromStatus: null, toStatus: null };
    }

    // 7. FINANCIAL EDITS:
    if (t.includes('عمولة') || t.includes('السعر') || t.includes('الشحن') || t.includes('خصم')) {
      return { actionType: 'financial_edit', fromStatus: null, toStatus: null };
    }

    // 8. STAFF ASSIGNMENT:
    if (t.includes('تعيين') || t.includes('مسؤول') || t.includes('assign')) {
      return { actionType: 'assign_staff', fromStatus: null, toStatus: null };
    }

    // 9. CUSTOMER NAME:
    if (t.includes('اسم العميل') || t.includes('تعديل الاسم')) {
      return { actionType: 'customer_edit', fromStatus: null, toStatus: null };
    }

    return { actionType: 'other', fromStatus: null, toStatus: null };
  }

  /**
   * Enrich customer delivery rates using verified vendoor_id
   */
  private async enrichCustomerIntelligenceBatch(
    items: { id: number; phone: string; vendoorId: number; random_number: string }[],
    nowIso: string
  ) {
    const updateCustomerStmt = db.prepare(`
      UPDATE orders SET
        delivery_rate = ?,
        delivery_rate_num = ?,
        delivery_rate_denom = ?,
        cancel_rate = ?,
        cancel_rate_num = ?,
        cancel_rate_denom = ?,
        total_customer_orders = ?,
        customer_last_order_status = ?,
        customer_last_order_elapsed = ?,
        phone_repetition_count = ?,
        customer_delivery_warning = ?,
        customer_history_checked_at = ?
      WHERE id = ?
    `);

    const insertObsStmt = db.prepare(`
      INSERT INTO customer_history_observations (
        order_id, phone, total_orders, deliveries_num, deliveries_denom,
        delivery_rate, cancels_num, cancels_denom, cancel_rate,
        repetitions_count, last_order_status, last_order_elapsed,
        warning_text, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of items) {
      try {
        const hist = await vendoorClient.fetchCustomerIntelligence(item.phone, item.vendoorId);
        updateCustomerStmt.run(
          hist.deliveryRate,
          hist.deliveriesNum,
          hist.deliveriesDenom,
          hist.cancelRate,
          hist.cancelsNum,
          hist.cancelsDenom,
          hist.totalOrders,
          hist.lastOrderStatus,
          hist.lastOrderElapsed,
          hist.repetitionsCount,
          hist.warningText,
          nowIso,
          item.id
        );

        insertObsStmt.run(
          item.id,
          item.phone,
          hist.totalOrders,
          hist.deliveriesNum,
          hist.deliveriesDenom,
          hist.deliveryRate,
          hist.cancelsNum,
          hist.cancelsDenom,
          hist.cancelRate,
          hist.repetitionsCount,
          hist.lastOrderStatus,
          hist.lastOrderElapsed,
          hist.warningText,
          nowIso
        );
      } catch (err: any) {
        console.warn(`[SyncEngine] Warning enriching customer ${item.phone}:`, err.message);
      }
    }
  }

  /**
   * Enrich Printed orders with additional phone numbers
   */
  private async enrichAdditionalPhones(nowIso: string) {
    const ordersToEnrich: any[] = db.prepare(`
      SELECT id, vendoor_id, random_number
      FROM orders
      WHERE current_status = 'Printed' AND (extra_phone_status = 'NOT_RETRIEVED' OR extra_phone_status IS NULL)
      LIMIT 10
    `).all();

    for (const ord of ordersToEnrich) {
      try {
        const res = await vendoorClient.fetchOrderDetailsEnrichment(ord.vendoor_id);
        if (res.success) {
          const status = res.anotherPhone ? 'PRESENT' : 'CONFIRMED_ABSENT';
          db.prepare(`
            UPDATE orders SET
              customer_phone_extra = ?,
              extra_phone_valid = ?,
              extra_phone_status = ?,
              last_enrichment_at = ?,
              last_enrichment_status = 'SUCCESS'
            WHERE id = ?
          `).run(res.anotherPhone || null, res.extraPhoneValid ? 1 : 0, status, nowIso, ord.id);
        } else {
          db.prepare(`
            UPDATE orders SET
              extra_phone_status = 'RETRIEVAL_FAILED',
              last_enrichment_at = ?,
              last_enrichment_status = 'FAILED'
            WHERE id = ?
          `).run(nowIso, ord.id);
        }
      } catch (err: any) {
        console.warn(`[SyncEngine] Warning enriching order ${ord.vendoor_id}:`, err.message);
      }
    }
  }

  /**
   * Historical on-demand sync for a given date and domain ('orders' | 'logs').
   */
  public async syncHistoricalDate(
    sourceDomain: 'orders' | 'logs',
    dateStr: string
  ): Promise<{
    status: 'COMPLETE' | 'PARTIAL' | 'FAILED' | 'CACHED';
    source: 'DATABASE' | 'VENDOOR';
    recordsCount: number;
    pagesRead: number;
    pagesDiscovered: number;
    storageTier: 'HOT' | 'COLD';
  }> {
    const cleanDate = dateStr.slice(0, 10);
    const storageTier = isDateInHot(cleanDate) ? 'HOT' : 'COLD';
    const nowIso = new Date().toISOString();

    // 1. Check existing coverage: if marked COMPLETE, use database
    const existingCov = getCoverageRecord(sourceDomain, cleanDate);
    if (existingCov && existingCov.completion_status === 'COMPLETE') {
      let count = 0;
      if (sourceDomain === 'orders') {
        const row: any = db.prepare('SELECT COUNT(*) as c FROM orders WHERE created_at_source LIKE ?').get(`${cleanDate}%`);
        count = row?.c || 0;
      } else {
        const row: any = db.prepare('SELECT COUNT(*) as c FROM canonical_activity_events WHERE event_timestamp LIKE ?').get(`${cleanDate}%`);
        count = row?.c || 0;
      }
      return {
        status: 'CACHED',
        source: 'DATABASE',
        recordsCount: count,
        pagesRead: existingCov.pages_read,
        pagesDiscovered: existingCov.pages_discovered,
        storageTier: existingCov.storage_tier || storageTier,
      };
    }

    // 2. Fetch missing data from Vendoor
    let pagesRead = 0;
    let pagesDiscovered = 1;
    let recordsExtracted = 0;
    let recordsSaved = 0;
    let hasFailure = false;
    let errorMessage: string | null = null;

    if (sourceDomain === 'orders') {
      try {
        const firstBatch = await vendoorClient.fetchOrdersBatch(0, 100, '', cleanDate, cleanDate);
        const total = firstBatch.recordsTotal;
        recordsExtracted += firstBatch.data.length;
        pagesDiscovered = Math.max(1, Math.ceil(total / 100));
        pagesRead++;

        let allOrders: VendoorRawOrder[] = [...firstBatch.data];

        for (let start = 100; start < total; start += 100) {
          try {
            const nextBatch = await vendoorClient.fetchOrdersBatch(start, 100, '', cleanDate, cleanDate);
            allOrders = allOrders.concat(nextBatch.data);
            recordsExtracted += nextBatch.data.length;
            pagesRead++;
          } catch (pageErr: any) {
            hasFailure = true;
            errorMessage = pageErr.message;
            break;
          }
        }

        db.exec('BEGIN TRANSACTION;');
        for (const o of allOrders) {
          if (!o.id) continue;
          this.upsertCanonicalOrder(o, nowIso);
          recordsSaved++;
        }
        db.exec('COMMIT;');
      } catch (err: any) {
        try { db.exec('ROLLBACK;'); } catch {}
        hasFailure = true;
        errorMessage = err.message;
      }
    } else {
      // sourceDomain === 'logs'
      try {
        const firstPage = await vendoorClient.fetchSystemLogs(1, cleanDate, cleanDate);
        pagesDiscovered = Math.max(1, firstPage.totalPages);
        pagesRead++;
        recordsExtracted += firstPage.entries.length;

        let allEntries: LogEntry[] = [...firstPage.entries];

        for (let p = 2; p <= pagesDiscovered; p++) {
          try {
            const pageData = await vendoorClient.fetchSystemLogs(p, cleanDate, cleanDate);
            allEntries = allEntries.concat(pageData.entries);
            recordsExtracted += pageData.entries.length;
            pagesRead++;
          } catch (pageErr: any) {
            hasFailure = true;
            errorMessage = pageErr.message;
            break;
          }
        }

        db.exec('BEGIN TRANSACTION;');
        for (const entry of allEntries) {
          const rawText = decodeHtmlEntities(entry.rawActionText || '');
          const hashInput = `${entry.orderCode}_${entry.actorName}_${rawText}_${entry.eventTimestamp}`;
          const sourceHash = crypto.createHash('sha256').update(hashInput).digest('hex');

          const rawResult = db.prepare(`
            INSERT OR IGNORE INTO raw_activity_events (
              source_hash, order_code, actor_name, raw_action_text,
              event_timestamp, storage_tier, observed_at, page_source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            sourceHash,
            entry.orderCode || null,
            entry.actorName || 'غير معروف',
            rawText,
            entry.eventTimestamp,
            storageTier,
            nowIso,
            'log/historical'
          );

          if (rawResult.changes > 0) {
            const rawId = Number(rawResult.lastInsertRowid);
            const { actionType, fromStatus, toStatus } = this.classifyAction(rawText);
            const isSystem = (entry.actorName || '').toLowerCase().includes('system') || (entry.actorName || '').includes('تلقائي') || (entry.actorName || '').includes('النظام') ? 1 : 0;

            db.prepare(`
              INSERT INTO canonical_activity_events (
                raw_event_id, order_code, actor_name, action_type,
                from_status, to_status, event_timestamp, storage_tier, is_system_actor, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              rawId,
              entry.orderCode || null,
              entry.actorName || 'غير معروف',
              actionType,
              fromStatus,
              toStatus,
              entry.eventTimestamp,
              storageTier,
              isSystem,
              nowIso
            );
            recordsSaved++;
          }
        }
        db.exec('COMMIT;');
      } catch (err: any) {
        try { db.exec('ROLLBACK;'); } catch {}
        hasFailure = true;
        errorMessage = err.message;
      }
    }

    const completionStatus: 'COMPLETE' | 'PARTIAL' | 'FAILED' = hasFailure
      ? (recordsSaved > 0 ? 'PARTIAL' : 'FAILED')
      : 'COMPLETE';

    saveCoverageRecord({
      accountId: 'primary',
      sourceDomain,
      periodDate: cleanDate,
      storageTier,
      pagesDiscovered,
      pagesRead,
      recordsExtracted,
      recordsSaved,
      completionStatus,
      errorMessage,
      lastAttemptedAt: nowIso,
      completedAt: completionStatus === 'COMPLETE' ? nowIso : null,
    });

    return {
      status: completionStatus,
      source: 'VENDOOR',
      recordsCount: recordsSaved,
      pagesRead,
      pagesDiscovered,
      storageTier,
    };
  }

  public async scanAllConfirmedOrdersForMultiMerchant(): Promise<{ scanned: number; alertsTriggered: number }> {
    const printedOrders: any[] = db.prepare(`
      SELECT id, random_number, current_status
      FROM orders
      WHERE current_status = 'Printed'
    `).all();

    let alertsTriggered = 0;
    const nowIso = new Date().toISOString();

    for (const ord of printedOrders) {
      const items: any[] = db.prepare('SELECT product_name, merchant_code, warehouse_name FROM order_items WHERE order_id = ?').all(ord.id);
      const warehouses = new Set<string>();
      for (const it of items) {
        const w = extractWarehouseFromProduct({ name: it.product_name, warehouse_name: it.warehouse_name || it.merchant_code } as any);
        if (w) warehouses.add(w);
      }
      const distinctList = Array.from(warehouses);
      const isMulti = distinctList.length > 1;

      db.prepare(`
        UPDATE orders SET
          distinct_merchant_count = ?,
          multi_merchant_flag = ?
        WHERE id = ?
      `).run(distinctList.length > 0 ? distinctList.length : 1, isMulti ? 1 : 0, ord.id);

      if (isMulti) {
        const tr = this.evaluateOrderAlerts(ord.id, ord.random_number, 'Printed', 1, distinctList, nowIso);
        if (tr > 0) alertsTriggered++;
      }
    }

    return { scanned: printedOrders.length, alertsTriggered };
  }
}

export const syncEngine = new SyncEngine();
