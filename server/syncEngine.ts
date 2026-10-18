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

export interface ConfirmationAgeSyncStatus {
  state: 'SUCCESS' | 'PARTIAL' | 'STALE' | 'NOT_AVAILABLE';
  lastObservedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  categoryStatuses: Record<'one' | 'two' | 'three' | 'over_three', 'SUCCESS' | 'TIMEOUT' | 'ERROR' | 'PENDING'>;
  counts: Record<string, number>;
}

export interface DetailedSyncMetrics {
  rawRowsReceived: number;
  validRecordsParsed: number;
  uniqueSourceIds: number;
  duplicateSourceIds: number;
  duplicatesAcrossPages: number;
  duplicatesWithinPage: number;
  recheckTopDuplicates: number;
  recheckTopNewOrders: number;
  newOrdersInserted: number;
  existingOrdersExamined: number;
  recordsWithFieldChanges: number;
  statusChangesCount: number;
  unresolvedStatusCount: number;
  invalidRecordsCount: number;
  failedPagesCount: number;
  failedEnrichmentCount: number;
}

export interface PhaseTimings {
  ordersFetchMs: number;
  dbUpsertMs: number;
  confirmationAgesMs: number;
  systemLogsMs: number;
  enrichmentMs: number;
  totalDurationMs: number;
}

export interface SyncEngineStatus {
  isRunning: boolean;
  cycleState: 'IDLE' | 'QUEUED' | 'RUNNING' | 'PARTIAL' | 'SUCCESS' | 'ERROR';
  lastSyncStartedAt: string | null;
  lastSyncCompletedAt: string | null;
  lastSuccessfulSyncAt: string | null;
  nextScheduledRunAt: string | null;
  configuredIntervalSeconds: number;
  currentPhase: string;
  totalOrdersInDb: number;
  totalAlertsOpen: number;
  lastError: string | null;
  consecutiveFailures: number;
  skippedTicksCount: number;
  lastDurationMs: number | null;
  phaseTimings: PhaseTimings | null;
  detailedMetrics: DetailedSyncMetrics | null;
  confirmationAgeStatus?: ConfirmationAgeSyncStatus;
}

export interface StatusReconciliationItem {
  status: string;
  sourceCount: number;
  localCount: number;
  matchingCount: number;
  sourceOnlyCount: number;
  localOnlyCount: number;
  statusMismatchCount: number;
}

export interface ReconciliationReport {
  timestamp: string;
  sourceTotalUnique: number;
  localTotalUnique: number;
  overallMatching: number;
  missingLocallyCount: number;
  missingInSourceCount: number;
  statusMismatchTotal: number;
  duplicateSourceIdsCount: number;
  duplicateCanonicalInDbCount: number;
  unresolvedStatusCount: number;
  byStatus: Record<string, StatusReconciliationItem>;
  sampleMismatches: Array<{
    vendoorId: number;
    sourceStatus: string;
    localStatus: string;
    sourceOrderNo?: string | null;
  }>;
  parityStatus: 'VERIFIED' | 'MISMATCH' | 'PARTIAL' | 'UNVERIFIED';
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

/**
 * Normalized comparison between existing local canonical order and incoming raw order.
 * Strictly checks business fields and status; ignores observation metadata and local timestamps.
 */
export function detectOrderBusinessChanges(
  existing: any,
  rawOrder: VendoorRawOrder,
  normalizedStatus: string,
  multiWarehouseFlag: number,
  distinctCount: number
): {
  businessFieldsChanged: boolean;
  statusChanged: boolean;
  changedFields: string[];
} {
  const changedFields: string[] = [];
  const statusChanged = Boolean(existing && existing.current_status !== normalizedStatus);
  if (statusChanged) {
    changedFields.push('current_status');
  }

  if (!existing) {
    return { businessFieldsChanged: true, statusChanged: false, changedFields: ['new_record'] };
  }

  // Compare normalized business fields only
  if (rawOrder.random_number && existing.random_number !== rawOrder.random_number) {
    changedFields.push('random_number');
  }
  if (rawOrder.order_no && existing.order_no !== rawOrder.order_no) {
    changedFields.push('order_no');
  }
  if (rawOrder.order_type && existing.order_type !== rawOrder.order_type) {
    changedFields.push('order_type');
  }
  if (rawOrder.full_name && existing.customer_name !== rawOrder.full_name) {
    changedFields.push('customer_name');
  }
  if (rawOrder.phone && existing.customer_phone !== rawOrder.phone) {
    changedFields.push('customer_phone');
  }
  if (rawOrder.governrate_name && existing.governorate !== rawOrder.governrate_name) {
    changedFields.push('governorate');
  }
  if (rawOrder.address && existing.address !== rawOrder.address) {
    changedFields.push('address');
  }

  const newTotal = parseFloat(rawOrder.total_order || '0') || 0;
  if (newTotal > 0 && Math.abs((existing.total_order || 0) - newTotal) > 0.01) {
    changedFields.push('total_order');
  }

  const newShipping = parseFloat(rawOrder.shipping_cost || '0') || 0;
  if (newShipping > 0 && Math.abs((existing.shipping_cost || 0) - newShipping) > 0.01) {
    changedFields.push('shipping_cost');
  }

  if (rawOrder.shipping_date && existing.shipping_date !== rawOrder.shipping_date) {
    changedFields.push('shipping_date');
  }
  if (rawOrder.printed_date && existing.printed_date !== rawOrder.printed_date) {
    changedFields.push('printed_date');
  }

  if (existing.multi_merchant_flag !== multiWarehouseFlag) {
    changedFields.push('multi_merchant_flag');
  }
  if (existing.distinct_merchant_count !== distinctCount) {
    changedFields.push('distinct_merchant_count');
  }

  const businessFieldsChanged = changedFields.some(f => f !== 'current_status');
  return { businessFieldsChanged, statusChanged, changedFields };
}

type SSEListener = (data: { event: string; payload: any }) => void;

export class SyncEngine {
  private isSyncing = false;
  private intervalTimer: NodeJS.Timeout | null = null;
  private sseClients: Set<SSEListener> = new Set();
  private status: SyncEngineStatus = {
    isRunning: false,
    cycleState: 'IDLE',
    lastSyncStartedAt: null,
    lastSyncCompletedAt: null,
    lastSuccessfulSyncAt: null,
    nextScheduledRunAt: null,
    configuredIntervalSeconds: 45,
    currentPhase: 'IDLE',
    totalOrdersInDb: 0,
    totalAlertsOpen: 0,
    lastError: null,
    consecutiveFailures: 0,
    skippedTicksCount: 0,
    lastDurationMs: null,
    phaseTimings: null,
    detailedMetrics: null,
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
    this.status.configuredIntervalSeconds = intervalSeconds;
    this.status.isRunning = true;
    console.log(`[SyncEngine] Starting background sync worker (interval: ${intervalSeconds}s)...`);

    // Run initial sync cycle
    this.runFullSyncCycle('INITIAL').catch(err => {
      console.error('[SyncEngine] Initial sync error:', err.message);
    });

    this.intervalTimer = setInterval(() => {
      if (this.isSyncing) {
        this.status.skippedTicksCount = (this.status.skippedTicksCount || 0) + 1;
        return;
      }
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

    // 2. Low delivery rate (< 70% strictly, unknown or no history is NOT low)
    const orderRow: any = db.prepare('SELECT delivery_rate, customer_phone_extra, extra_phone_status, address_quality_status, created_at_source, total_customer_orders, delivery_rate_denom FROM orders WHERE id = ?').get(orderDbId);
    if (orderRow) {
      const hasValidEligibleHistory = (orderRow.delivery_rate_denom !== null && orderRow.delivery_rate_denom > 0) ||
                                      (orderRow.total_customer_orders !== null && orderRow.total_customer_orders > 0);
      if (orderRow.delivery_rate !== null && orderRow.delivery_rate !== undefined && orderRow.delivery_rate < 70 && hasValidEligibleHistory) {
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
          JSON.stringify({ deliveryRate: orderRow.delivery_rate, totalOrders: orderRow.total_customer_orders, denom: orderRow.delivery_rate_denom }),
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
   * Field-aware canonical order upsert using vendoor_id as primary source key.
   * Compares business fields and status; does NOT flag unchanged records as updated.
   */
  public upsertCanonicalOrder(rawOrder: VendoorRawOrder, nowIso: string): {
    orderDbId: number;
    isNew: boolean;
    statusChanged: boolean;
    businessFieldsChanged: boolean;
    previousStatus: string | null;
    currentStatus: string;
    changedFields: string[];
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
    let businessFieldsChanged = false;
    let previousStatus: string | null = null;
    let changedFields: string[] = [];

    if (!existing) {
      isNew = true;
      changedFields = ['new_order'];
      const res = db.prepare(`
        INSERT INTO orders (
          vendoor_id, random_number, order_no, order_type, current_status, status_raw,
          affiliate_code, affiliate_name, affiliate_id, customer_name, customer_phone,
          governorate, address, total_price, shipping_cost, total_order,
          created_at_source, shipping_date, printed_date, distinct_merchant_count,
          multi_merchant_flag, state_entry_at, storage_tier,
          address_word_count, address_is_latin, address_quality_status,
          validation_status, last_observed_at, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?
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
        'VALIDATED',
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

      const changeDetection = detectOrderBusinessChanges(
        existing,
        rawOrder,
        currentStatus,
        multiWarehouseFlag,
        distinctCount
      );

      statusChanged = changeDetection.statusChanged;
      businessFieldsChanged = changeDetection.businessFieldsChanged;
      changedFields = changeDetection.changedFields;

      if (statusChanged || businessFieldsChanged) {
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
            validation_status = 'VALIDATED',
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
      } else {
        // Pure observation heartbeat: touch last_observed_at and mark validated without polluting updated_at
        db.prepare(`
          UPDATE orders SET
            last_observed_at = ?,
            validation_status = 'VALIDATED'
          WHERE id = ?
        `).run(nowIso, orderDbId);
      }
    }

    if (rawProducts.length > 0) {
      this.reconcileOrderProducts(orderDbId, rawProducts, nowIso);
    }

    this.evaluateOrderAlerts(
      orderDbId,
      rawOrder.random_number || existing?.random_number || `VND_${vendoorId}`,
      currentStatus,
      multiWarehouseFlag,
      warehouses,
      nowIso
    );

    return {
      orderDbId,
      isNew,
      statusChanged,
      businessFieldsChanged,
      previousStatus,
      currentStatus,
      changedFields,
    };
  }

  /**
   * Full synchronization cycle:
   * 1. Paginates across all order batches with explicit request timeouts.
   * 2. Deduplicates incoming rows by stable vendoor_id before DB execution.
   * 3. Accurately separates new canonical orders, existing examined, and genuine business changes.
   * 4. Synchronizes confirmation ages, system logs, and customer enrichment with bounded concurrency.
   * 5. Tracks comprehensive phase timings and explicit audit metrics.
   */
  public async runFullSyncCycle(runType: 'INITIAL' | 'PERIODIC' | 'RECONCILIATION' | 'MANUAL') {
    if (this.isSyncing) return;

    if (!vendoorClient.isConfigured()) {
      const msg = 'Vendoor credentials (VENDOOR_EMAIL / VENDOOR_PASSWORD) are not configured. Background polling paused until credentials are provided in environment or secrets.';
      this.status.currentPhase = 'AWAITING_CREDENTIALS';
      this.status.cycleState = 'IDLE';
      this.status.lastError = msg;
      console.warn(`[SyncEngine] ${msg}`);
      return;
    }

    this.isSyncing = true;
    const tCycleStart = Date.now();
    const nowIso = new Date().toISOString();
    this.status.lastSyncStartedAt = nowIso;
    this.status.currentPhase = 'SCANNING_ORDERS';
    this.status.cycleState = 'RUNNING';

    const phaseTimings: PhaseTimings = {
      ordersFetchMs: 0,
      dbUpsertMs: 0,
      confirmationAgesMs: 0,
      systemLogsMs: 0,
      enrichmentMs: 0,
      totalDurationMs: 0,
    };

    let rawRowsReceived = 0;
    let duplicateSourceIds = 0;
    let duplicatesAcrossPages = 0;
    let duplicatesWithinPage = 0;
    let recheckTopDuplicates = 0;
    let recheckTopNewOrders = 0;
    let invalidRecordsCount = 0;
    let failedPagesCount = 0;
    let failedEnrichmentCount = 0;
    let totalChangedDuringScan = false;
    let errorsCount = 0;
    let hasFailedPage = false;
    let errorMessage: string | null = null;

    const ordersMap = new Map<number, VendoorRawOrder>();

    try {
      console.log(`[SyncEngine] Starting ${runType} sync cycle at ${nowIso}...`);

      // 1. Scan Orders: First page to get total and initial batch
      const tOrdersStart = Date.now();
      const firstBatch = await vendoorClient.fetchOrdersBatch(0, 100);
      const totalOrdersInSource = firstBatch.recordsTotal;

      const seenInPage0 = new Set<number>();
      for (const ord of firstBatch.data) {
        rawRowsReceived++;
        if (!ord || typeof ord.id !== 'number') {
          invalidRecordsCount++;
          continue;
        }
        if (seenInPage0.has(ord.id)) {
          duplicatesWithinPage++;
          duplicateSourceIds++;
        } else if (ordersMap.has(ord.id)) {
          duplicatesAcrossPages++;
          duplicateSourceIds++;
        } else {
          ordersMap.set(ord.id, ord);
        }
        seenInPage0.add(ord.id);
      }

      // Paginate through all remaining pages to guarantee 100% full coverage
      const batchSize = 100;
      for (let start = 100; start < totalOrdersInSource; start += batchSize) {
        try {
          const nextBatch = await vendoorClient.fetchOrdersBatch(start, batchSize);
          if (nextBatch.recordsTotal !== totalOrdersInSource) {
            totalChangedDuringScan = true;
          }
          const seenInSubPage = new Set<number>();
          for (const ord of nextBatch.data) {
            rawRowsReceived++;
            if (!ord || typeof ord.id !== 'number') {
              invalidRecordsCount++;
              continue;
            }
            if (seenInSubPage.has(ord.id)) {
              duplicatesWithinPage++;
              duplicateSourceIds++;
            } else if (ordersMap.has(ord.id)) {
              duplicatesAcrossPages++;
              duplicateSourceIds++;
            } else {
              ordersMap.set(ord.id, ord);
            }
            seenInSubPage.add(ord.id);
          }
        } catch (pageErr: any) {
          console.error(`[SyncEngine] Error fetching orders batch at start ${start}:`, pageErr.message);
          errorsCount++;
          failedPagesCount++;
          hasFailedPage = true;
          errorMessage = `Failed to fetch page at offset ${start}: ${pageErr.message}`;
          break;
        }
      }

      // If source count shifted during pagination due to active concurrent order placements,
      // run a fast verification pass of start=0 to guarantee top orders displaced by offset shifts are captured
      if (totalChangedDuringScan && !hasFailedPage) {
        try {
          const topCheck = await vendoorClient.fetchOrdersBatch(0, 50);
          for (const ord of topCheck.data) {
            rawRowsReceived++;
            if (!ord || typeof ord.id !== 'number') {
              invalidRecordsCount++;
              continue;
            }
            if (ordersMap.has(ord.id)) {
              recheckTopDuplicates++;
              duplicateSourceIds++;
            } else {
              ordersMap.set(ord.id, ord);
              recheckTopNewOrders++;
            }
          }
        } catch {}
      }

      phaseTimings.ordersFetchMs = Date.now() - tOrdersStart;
      this.status.currentPhase = 'PROCESSING_ORDERS';

      // 2. Canonical DB Upsert and Change Detection
      const tDbStart = Date.now();
      let newOrdersInserted = 0;
      let existingOrdersExamined = 0;
      let recordsWithFieldChanges = 0;
      let statusChangesCount = 0;
      let unresolvedStatusCount = 0;

      db.exec('BEGIN TRANSACTION;');
      for (const rawOrder of ordersMap.values()) {
        const upsertRes = this.upsertCanonicalOrder(rawOrder, nowIso);
        if (upsertRes.isNew) {
          newOrdersInserted++;
        } else {
          existingOrdersExamined++;
          if (upsertRes.businessFieldsChanged) {
            recordsWithFieldChanges++;
          }
          if (upsertRes.statusChanged) {
            statusChangesCount++;
          }
        }
        if (upsertRes.currentStatus === 'Unknown') {
          unresolvedStatusCount++;
        }
      }
      db.exec('COMMIT;');
      phaseTimings.dbUpsertMs = Date.now() - tDbStart;

      // 2b. Active Population Verification:
      // Orders previously active in DB that are absent from the current active search window
      // MUST NOT be blindly marked as 'Canceled'!
      // Only transition status if an authoritative status-change log explicitly proves the new state.
      // Otherwise, preserve the last verified status and mark validation_status as UNRESOLVED_ABSENT_FROM_VIEW.
      if (!hasFailedPage && totalOrdersInSource > 0) {
        const cairoToday = getCairoDateString();
        const activeDbOrders: any[] = db.prepare(`
          SELECT id, vendoor_id, random_number, current_status
          FROM orders
          WHERE current_status IN ('New', 'Pending', 'Processing', 'Canceling')
            AND (created_at_source >= datetime('now', '-3 days') OR created_at_source LIKE ? OR created_at_source LIKE ?)
        `).all(`${cairoToday}%`, `${getCairoDateString(new Date(Date.now() - 86400000))}%`);

        const absentOrders = activeDbOrders.filter(act => !ordersMap.has(act.vendoor_id));
        const totalActiveInDb = activeDbOrders.length;
        const absentFromActiveViewTotal = absentOrders.length;

        let resolvedViaLogsCount = 0;
        let confirmedCurrentStatusViaLogsCount = 0;
        let preservedUnresolvedCount = 0;

        const findLatestStatusEventStmt = db.prepare(`
          SELECT to_status, actor_name, event_timestamp
          FROM canonical_activity_events
          WHERE order_code = ? AND action_type = 'status_change' AND to_status IS NOT NULL
          ORDER BY event_timestamp DESC
          LIMIT 1
        `);

        db.exec('BEGIN TRANSACTION;');
        for (const act of absentOrders) {
          // Check if there is an authoritative status change log from Vendoor
          const latestEvent: any = findLatestStatusEventStmt.get(act.random_number);

          if (latestEvent && latestEvent.to_status && latestEvent.to_status !== act.current_status) {
            // Update strictly based on verified log evidence from Vendoor
            db.prepare(`
              UPDATE orders
              SET current_status = ?,
                  validation_status = 'RESOLVED_VIA_AUDIT_LOGS',
                  last_observed_at = ?,
                  updated_at = ?
              WHERE id = ?
            `).run(latestEvent.to_status, nowIso, nowIso, act.id);

            db.prepare(`
              INSERT INTO order_status_events (
                order_id, random_number, from_status, to_status, actor_name,
                event_time_source, storage_tier, observed_at, source_channel
              ) VALUES (?, ?, ?, ?, ?, ?, 'HOT', ?, 'vendoor_audit_log')
            `).run(act.id, act.random_number, act.current_status, latestEvent.to_status, latestEvent.actor_name || 'سجلات فيندور', latestEvent.event_timestamp, nowIso);

            resolvedViaLogsCount++;
            statusChangesCount++;
          } else if (latestEvent && latestEvent.to_status && latestEvent.to_status === act.current_status) {
            // Log explicitly confirmed order remains in current status
            db.prepare(`
              UPDATE orders
              SET validation_status = 'CONFIRMED_VIA_AUDIT_LOGS',
                  last_observed_at = ?,
                  updated_at = ?
              WHERE id = ?
            `).run(nowIso, nowIso, act.id);

            confirmedCurrentStatusViaLogsCount++;
          } else {
            // Retain last known verified status without guessing or forcing Canceled!
            db.prepare(`
              UPDATE orders
              SET validation_status = 'UNRESOLVED_ABSENT_FROM_VIEW',
                  last_observed_at = ?,
                  updated_at = ?
              WHERE id = ?
            `).run(nowIso, nowIso, act.id);

            preservedUnresolvedCount++;
          }
        }
        db.exec('COMMIT;');

        if (absentFromActiveViewTotal > 0) {
          console.log(
            `[SyncEngine] Active orders verification: TotalActiveInDb=${totalActiveInDb}, PresentInScan=${totalActiveInDb - absentFromActiveViewTotal}, ` +
            `AbsentFromScan=${absentFromActiveViewTotal} (ResolvedViaLogs=${resolvedViaLogsCount}, ConfirmedStatusViaLogs=${confirmedCurrentStatusViaLogsCount}, PreservedUnresolved=${preservedUnresolvedCount})`
          );
        }
      }

      // 3. Synchronize Confirmation Age Pages (Printed age monitoring)
      this.status.currentPhase = 'SYNCING_CONFIRMATION_AGES';
      const tConfStart = Date.now();
      await this.syncConfirmationAges(nowIso);
      phaseTimings.confirmationAgesMs = Date.now() - tConfStart;

      // 4. Synchronize System Logs & Employee Canonical Events (full pagination)
      this.status.currentPhase = 'SYNCING_SYSTEM_LOGS';
      const tLogsStart = Date.now();
      const logRes = await this.syncSystemLogs(nowIso);
      if (logRes.hasErrors) {
        errorsCount++;
      }
      phaseTimings.systemLogsMs = Date.now() - tLogsStart;

      // 5. Customer Intelligence and Phone Enrichment with Bounded Concurrency & Timeouts
      this.status.currentPhase = 'ENRICHING_CUSTOMERS';
      const tEnrichStart = Date.now();
      const enrichStats = await this.enrichCustomersAndPhonesBounded(nowIso);
      failedEnrichmentCount += enrichStats.failedEnrichments;
      phaseTimings.enrichmentMs = Date.now() - tEnrichStart;

      const tCycleEnd = Date.now();
      phaseTimings.totalDurationMs = tCycleEnd - tCycleStart;

      const uniqueSourceIds = ordersMap.size;
      const validRecordsParsed = rawRowsReceived - invalidRecordsCount;

      const detailedMetrics: DetailedSyncMetrics = {
        rawRowsReceived,
        validRecordsParsed,
        uniqueSourceIds,
        duplicateSourceIds,
        duplicatesAcrossPages,
        duplicatesWithinPage,
        recheckTopDuplicates,
        recheckTopNewOrders,
        newOrdersInserted,
        existingOrdersExamined,
        recordsWithFieldChanges,
        statusChangesCount,
        unresolvedStatusCount,
        invalidRecordsCount,
        failedPagesCount,
        failedEnrichmentCount,
      };

      this.status.lastSuccessfulSyncAt = new Date().toISOString();
      this.status.lastSyncCompletedAt = this.status.lastSuccessfulSyncAt;
      this.status.lastDurationMs = phaseTimings.totalDurationMs;
      this.status.phaseTimings = phaseTimings;
      this.status.detailedMetrics = detailedMetrics;
      this.status.consecutiveFailures = 0;
      this.status.lastError = hasFailedPage ? errorMessage : null;
      this.status.currentPhase = 'IDLE';
      this.status.cycleState = hasFailedPage ? 'PARTIAL' : 'SUCCESS';

      const intervalSec = this.status.configuredIntervalSeconds || parseInt(process.env.SYNC_INTERVAL_SECONDS || '45', 10);
      this.status.nextScheduledRunAt = new Date(Date.now() + intervalSec * 1000).toISOString();

      const finalStatus = hasFailedPage ? 'PARTIAL' : 'SUCCESS';

      console.log(
        `[SyncEngine] ${runType} sync completed (${finalStatus}) in ${phaseTimings.totalDurationMs}ms: ` +
        `Raw=${rawRowsReceived}, Valid=${validRecordsParsed}, Unique=${uniqueSourceIds}, ` +
        `DupsAcrossPages=${duplicatesAcrossPages}, DupsWithinPage=${duplicatesWithinPage}, ` +
        `RecheckTopDups=${recheckTopDuplicates}, RecheckTopNew=${recheckTopNewOrders}, Invalid=${invalidRecordsCount}, ` +
        `New=${newOrdersInserted}, Examined=${existingOrdersExamined}, FieldChanges=${recordsWithFieldChanges}, ` +
        `StatusChanges=${statusChangesCount}, UnreachablePages=${failedPagesCount}, EnrichmentRetries=${failedEnrichmentCount}`
      );
      console.log(
        `[SyncEngine] Phase timings: ordersFetch=${phaseTimings.ordersFetchMs}ms, dbUpsert=${phaseTimings.dbUpsertMs}ms, ` +
        `confirmationAges=${phaseTimings.confirmationAgesMs}ms, systemLogs=${phaseTimings.systemLogsMs}ms, ` +
        `enrichment=${phaseTimings.enrichmentMs}ms, total=${phaseTimings.totalDurationMs}ms`
      );

      db.prepare(`
        INSERT INTO sync_runs (
          run_type, status, orders_scanned, orders_created, orders_updated,
          events_detected, alerts_triggered, errors_count, started_at, completed_at, error_message,
          raw_rows_received, valid_records_parsed, unique_source_ids, duplicate_source_ids,
          new_orders_inserted, existing_orders_examined, records_with_field_changes,
          status_changes_count, unresolved_status_count, invalid_records_count,
          failed_pages_count, failed_enrichment_count, duration_ms, phase_timings_json
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?
        )
      `).run(
        runType,
        finalStatus,
        uniqueSourceIds,
        newOrdersInserted,
        recordsWithFieldChanges,
        statusChangesCount,
        0,
        errorsCount,
        nowIso,
        this.status.lastSyncCompletedAt,
        hasFailedPage ? errorMessage : null,
        rawRowsReceived,
        validRecordsParsed,
        uniqueSourceIds,
        duplicateSourceIds,
        newOrdersInserted,
        existingOrdersExamined,
        recordsWithFieldChanges,
        statusChangesCount,
        unresolvedStatusCount,
        invalidRecordsCount,
        failedPagesCount,
        failedEnrichmentCount,
        phaseTimings.totalDurationMs,
        JSON.stringify(phaseTimings)
      );

      this.broadcast('sync_completed', this.getStatus());
    } catch (err: any) {
      if (err.message?.includes('VENDOOR_EMAIL') || err.message?.includes('VENDOOR_PASSWORD')) {
        console.warn('[SyncEngine] Authentication credentials missing:', err.message);
      } else {
        console.error('[SyncEngine Detailed Error]:', err);
      }
      try {
        db.exec('ROLLBACK;');
      } catch {
        // no transaction active
      }
      errorMessage = err.message;
      this.status.lastError = errorMessage;
      this.status.consecutiveFailures++;
      this.status.currentPhase = 'ERROR';
      this.status.cycleState = 'ERROR';

      const durationMs = Date.now() - tCycleStart;
      this.status.lastDurationMs = durationMs;

      db.prepare(`
        INSERT INTO sync_runs (
          run_type, status, orders_scanned, orders_created, orders_updated,
          errors_count, started_at, completed_at, error_message,
          raw_rows_received, valid_records_parsed, unique_source_ids, duplicate_source_ids,
          new_orders_inserted, existing_orders_examined, records_with_field_changes,
          status_changes_count, unresolved_status_count, invalid_records_count,
          failed_pages_count, failed_enrichment_count, duration_ms
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?
        )
      `).run(
        runType,
        'FAILED',
        ordersMap.size,
        0,
        0,
        errorsCount + 1,
        nowIso,
        new Date().toISOString(),
        errorMessage,
        rawRowsReceived,
        rawRowsReceived - invalidRecordsCount,
        ordersMap.size,
        duplicateSourceIds,
        0,
        0,
        0,
        0,
        0,
        invalidRecordsCount,
        failedPagesCount,
        failedEnrichmentCount,
        durationMs
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

    const categoryStatuses: Record<'one' | 'two' | 'three' | 'over_three', 'SUCCESS' | 'TIMEOUT' | 'ERROR' | 'PENDING'> = {
      one: 'PENDING',
      two: 'PENDING',
      three: 'PENDING',
      over_three: 'PENDING',
    };

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

    // Sequential execution to keep connection pool stable and prevent connection reset on Vendoor
    for (const cat of categories) {
      try {
        const rows: ConfirmationRow[] = await vendoorClient.fetchConfirmationAgePage(cat.key);
        for (const r of rows) {
          if (!r.randomNumber) continue;
          updateConfStmt.run(cat.label, nowIso, r.printedDate || null, r.randomNumber);
          insertObsStmt.run(r.randomNumber, r.randomNumber, cat.label, r.invoiceNo, r.printedDate, nowIso);
        }
        categoryStatuses[cat.key] = 'SUCCESS';
      } catch (err: any) {
        const isTimeout = err.name === 'AbortError' || err.message?.includes('timeout') || err.message?.includes('15000ms');
        categoryStatuses[cat.key] = isTimeout ? 'TIMEOUT' : 'ERROR';
        console.info(`[SyncEngine] Confirmation age endpoint ${cat.key} check: ${categoryStatuses[cat.key]} (${err.message})`);
      }
      await new Promise(r => setTimeout(r, 300));
    }

    // Read current database counts so existing verified observations are preserved without zeroing out
    const dbAgeRows: any[] = db.prepare(`
      SELECT confirmation_age_category, COUNT(*) as c
      FROM orders
      WHERE current_status = 'Printed' AND confirmation_age_category IS NOT NULL
      GROUP BY confirmation_age_category
    `).all();

    const counts: Record<string, number> = {
      '1_day': 0,
      '2_days': 0,
      '3_days': 0,
      'over_3_days': 0,
    };
    for (const r of dbAgeRows) {
      if (r.confirmation_age_category in counts) {
        counts[r.confirmation_age_category] = r.c;
      }
    }

    const statuses = Object.values(categoryStatuses);
    const successCount = statuses.filter(s => s === 'SUCCESS').length;
    let overallState: 'SUCCESS' | 'PARTIAL' | 'STALE' | 'NOT_AVAILABLE';
    if (successCount === 4) {
      overallState = 'SUCCESS';
    } else if (successCount > 0) {
      overallState = 'PARTIAL';
    } else if (this.status.confirmationAgeStatus?.lastSuccessAt) {
      overallState = 'STALE';
    } else {
      overallState = 'NOT_AVAILABLE';
    }

    this.status.confirmationAgeStatus = {
      state: overallState,
      lastObservedAt: nowIso,
      lastSuccessAt: successCount > 0 ? nowIso : (this.status.confirmationAgeStatus?.lastSuccessAt || null),
      lastError: successCount < 4 ? `Non-successful categories: ${Object.entries(categoryStatuses).filter(([_, s]) => s !== 'SUCCESS').map(([k, s]) => `${k}=${s}`).join(', ')}` : null,
      categoryStatuses,
      counts,
    };

    console.log(`[SyncEngine] Confirmation Age observation summary (${overallState}): 1_day=${counts['1_day']}, 2_days=${counts['2_days']}, 3_days=${counts['3_days']}, over_3_days=${counts['over_3_days']}`);
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
      const maxPages = Math.min(totalPages, targetDate ? 50 : 20);

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

      let totalLogs = 0;
      let newCanonicalCount = 0;

      const processEntries = (entries: LogEntry[]): number => {
        let newOnPage = 0;
        db.exec('BEGIN TRANSACTION;');
        try {
          for (const entry of entries) {
            totalLogs++;
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
              newOnPage++;
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
          db.exec('COMMIT;');
        } catch (txErr) {
          db.exec('ROLLBACK;');
          throw txErr;
        }
        return newOnPage;
      };

      // Process first page
      const newOnFirstPage = processEntries(firstPage.entries);

      // Check if DB already has existing events
      const existingEventsCount = (db.prepare('SELECT count(*) as c FROM raw_activity_events').get() as any)?.c || 0;

      if (newOnFirstPage === 0 && existingEventsCount > 0 && !targetDate) {
        // Fast exit: no new logs on page 1 since last sync cycle
      } else {
        // Scan backwards through recent pages until an entire page is already known
        for (let p = 2; p <= maxPages; p++) {
          try {
            const pageData = await vendoorClient.fetchSystemLogs(p, dateToSync, dateToSync);
            if (!pageData.entries || pageData.entries.length === 0) {
              break;
            }
            const newOnPage = processEntries(pageData.entries);
            // If an entire page contains only previously ingested events, earlier pages are guaranteed older
            if (newOnPage === 0 && existingEventsCount > 0) {
              break;
            }
          } catch (pageErr: any) {
            console.warn(`[SyncEngine] Page ${p} log fetch failed:`, pageErr.message);
            hasErrors = true;
            break;
          }
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
        recordsExtracted: totalLogs,
        recordsSaved: newCanonicalCount,
        completionStatus: hasErrors ? 'PARTIAL' : 'COMPLETE',
        lastAttemptedAt: nowIso,
        completedAt: hasErrors ? null : nowIso,
      });

      return { totalLogs, newSaved: newCanonicalCount, hasErrors };
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
   * Bounded concurrency enrichment for customer intelligence and additional phone numbers.
   * - Does not re-enrich orders that are already up-to-date.
   * - Bounded concurrency (max 2 parallel).
   * - Explicit timeouts on every network call.
   * - Non-blocking: failures do not invalidate canonical order sync.
   */
  public async enrichCustomersAndPhonesBounded(nowIso: string): Promise<{ failedEnrichments: number }> {
    let failedEnrichments = 0;

    // 1. Orders needing customer intelligence: checked_at IS NULL or > 24 hours old
    const ordersToEnrich: any[] = db.prepare(`
      SELECT id, vendoor_id, random_number, customer_phone, current_status
      FROM orders
      WHERE customer_phone IS NOT NULL AND customer_phone != ''
        AND (customer_history_checked_at IS NULL OR customer_history_checked_at < datetime('now', '-24 hours'))
      ORDER BY CASE WHEN current_status = 'Printed' THEN 0 WHEN current_status = 'New' THEN 1 ELSE 2 END, id DESC
      LIMIT 10
    `).all();

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

    // Bounded execution with max 2 concurrent requests
    for (let i = 0; i < ordersToEnrich.length; i += 2) {
      const slice = ordersToEnrich.slice(i, i + 2);
      await Promise.all(slice.map(async (item) => {
        try {
          const hist = await vendoorClient.fetchCustomerIntelligence(item.customer_phone, item.vendoor_id);
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
            item.customer_phone,
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
          failedEnrichments++;
          console.info(`[SyncEngine] Non-blocking customer enrichment deferred for ${item.customer_phone}: ${err.message}`);
          try {
            db.prepare(`UPDATE orders SET customer_history_checked_at = ? WHERE id = ?`).run(nowIso, item.id);
          } catch {}
        }
      }));
    }

    // 2. Extra phone lookups for Printed orders:
    const printedNeedingPhone: any[] = db.prepare(`
      SELECT id, vendoor_id, random_number
      FROM orders
      WHERE current_status = 'Printed' AND (extra_phone_status = 'NOT_RETRIEVED' OR extra_phone_status IS NULL)
      LIMIT 6
    `).all();

    for (let i = 0; i < printedNeedingPhone.length; i += 2) {
      const slice = printedNeedingPhone.slice(i, i + 2);
      await Promise.all(slice.map(async (ord) => {
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
          failedEnrichments++;
          console.warn(`[SyncEngine] Non-blocking order detail enrichment failure for ${ord.vendoor_id}:`, err.message);
        }
      }));
    }

    return { failedEnrichments };
  }

  /**
   * Reconciles source order IDs against local SQLite database.
   * Measures exact parity by status without guessing or altering data.
   */
  public reconcileSourceVsLocal(sourceOrders?: VendoorRawOrder[], scopeIds?: number[]): ReconciliationReport {
    const timestamp = new Date().toISOString();
    const sourceMap = new Map<number, VendoorRawOrder>();
    let duplicateSourceIdsCount = 0;
    let unresolvedStatusCount = 0;

    if (sourceOrders) {
      for (const ord of sourceOrders) {
        if (!ord || typeof ord.id !== 'number') continue;
        if (sourceMap.has(ord.id)) {
          duplicateSourceIdsCount++;
        } else {
          sourceMap.set(ord.id, ord);
        }
      }
    }

    const localOrders: any[] = (scopeIds && scopeIds.length > 0)
      ? db.prepare(`SELECT id, vendoor_id, random_number, order_no, current_status FROM orders WHERE vendoor_id IN (${scopeIds.map(() => '?').join(',')})`).all(...scopeIds)
      : db.prepare('SELECT id, vendoor_id, random_number, order_no, current_status FROM orders').all();
    const localMap = new Map<number, any>();
    let duplicateCanonicalInDbCount = 0;

    for (const ord of localOrders) {
      if (localMap.has(ord.vendoor_id)) {
        duplicateCanonicalInDbCount++;
      } else {
        localMap.set(ord.vendoor_id, ord);
      }
    }

    const allStatuses = ['New', 'Pending', 'Processing', 'Printed', 'Canceling', 'Canceled'];
    const byStatus: Record<string, StatusReconciliationItem> = {};
    for (const st of allStatuses) {
      byStatus[st] = {
        status: st,
        sourceCount: 0,
        localCount: 0,
        matchingCount: 0,
        sourceOnlyCount: 0,
        localOnlyCount: 0,
        statusMismatchCount: 0,
      };
    }

    const sampleMismatches: Array<{
      vendoorId: number;
      sourceStatus: string;
      localStatus: string;
      sourceOrderNo?: string | null;
    }> = [];

    let overallMatching = 0;
    let missingLocallyCount = 0;
    let statusMismatchTotal = 0;

    if (sourceOrders && sourceOrders.length > 0) {
      for (const [vId, sOrd] of sourceMap.entries()) {
        const parsedStatus = this.parseStatusString(sOrd.status);
        if (parsedStatus === 'Unknown') unresolvedStatusCount++;

        if (!byStatus[parsedStatus]) {
          byStatus[parsedStatus] = {
            status: parsedStatus,
            sourceCount: 0,
            localCount: 0,
            matchingCount: 0,
            sourceOnlyCount: 0,
            localOnlyCount: 0,
            statusMismatchCount: 0,
          };
        }
        byStatus[parsedStatus].sourceCount++;

        if (localMap.has(vId)) {
          const lOrd = localMap.get(vId);
          if (lOrd.current_status === parsedStatus) {
            byStatus[parsedStatus].matchingCount++;
            overallMatching++;
          } else {
            byStatus[parsedStatus].statusMismatchCount++;
            statusMismatchTotal++;
            if (sampleMismatches.length < 15) {
              sampleMismatches.push({
                vendoorId: vId,
                sourceStatus: parsedStatus,
                localStatus: lOrd.current_status,
                sourceOrderNo: sOrd.order_no || null,
              });
            }
          }
        } else {
          byStatus[parsedStatus].sourceOnlyCount++;
          missingLocallyCount++;
        }
      }
    }

    let missingInSourceCount = 0;
    for (const [vId, lOrd] of localMap.entries()) {
      const st = lOrd.current_status;
      if (!byStatus[st]) {
        byStatus[st] = {
          status: st,
          sourceCount: 0,
          localCount: 0,
          matchingCount: 0,
          sourceOnlyCount: 0,
          localOnlyCount: 0,
          statusMismatchCount: 0,
        };
      }
      byStatus[st].localCount++;

      if (sourceOrders && sourceOrders.length > 0 && !sourceMap.has(vId)) {
        byStatus[st].localOnlyCount++;
        missingInSourceCount++;
      }
    }

    let parityStatus: 'VERIFIED' | 'MISMATCH' | 'PARTIAL' | 'UNVERIFIED' = 'UNVERIFIED';
    if (sourceOrders && sourceOrders.length > 0) {
      if (missingLocallyCount === 0 && statusMismatchTotal === 0 && sourceMap.size === localMap.size) {
        parityStatus = 'VERIFIED';
      } else if (missingLocallyCount > 0 || statusMismatchTotal > 0) {
        parityStatus = 'MISMATCH';
      } else {
        parityStatus = 'PARTIAL';
      }
    }

    return {
      timestamp,
      sourceTotalUnique: sourceMap.size,
      localTotalUnique: localMap.size,
      overallMatching,
      missingLocallyCount,
      missingInSourceCount,
      statusMismatchTotal,
      duplicateSourceIdsCount,
      duplicateCanonicalInDbCount,
      unresolvedStatusCount,
      byStatus,
      sampleMismatches,
      parityStatus,
    };
  }

  /**
   * Executes real live acquisition from Vendoor (if credentials configured)
   * and performs complete ID-set and status parity reconciliation.
   */
  public async reconcileLiveWithVendoor(): Promise<ReconciliationReport & { liveAcquisitionAttempted: boolean; message: string }> {
    const hasEmail = Boolean(process.env.VENDOOR_EMAIL && process.env.VENDOOR_EMAIL.trim());
    const hasPass = Boolean(process.env.VENDOOR_PASSWORD && process.env.VENDOOR_PASSWORD.trim());

    if (!hasEmail || !hasPass) {
      const baseReport = this.reconcileSourceVsLocal();
      return {
        ...baseReport,
        parityStatus: 'UNVERIFIED',
        liveAcquisitionAttempted: false,
        message: 'Live source parity is UNVERIFIED because Vendoor credentials (VENDOOR_EMAIL, VENDOOR_PASSWORD) are not configured in AI Studio Secrets.',
      };
    }

    try {
      console.log('[SyncEngine] Fetching live Vendoor population for reconciliation...');
      const firstBatch = await vendoorClient.fetchOrdersBatch(0, 100);
      const total = firstBatch.recordsTotal;
      let allOrders: VendoorRawOrder[] = [...firstBatch.data];

      for (let start = 100; start < total; start += 100) {
        try {
          const nextBatch = await vendoorClient.fetchOrdersBatch(start, 100);
          allOrders = allOrders.concat(nextBatch.data);
        } catch (pageErr: any) {
          console.warn(`[Reconcile] Error fetching page at start=${start}:`, pageErr.message);
          break;
        }
      }

      const report = this.reconcileSourceVsLocal(allOrders);
      return {
        ...report,
        liveAcquisitionAttempted: true,
        message: `Live source acquisition completed with ${allOrders.length} orders received. Status: ${report.parityStatus}.`,
      };
    } catch (err: any) {
      const baseReport = this.reconcileSourceVsLocal();
      return {
        ...baseReport,
        parityStatus: 'UNVERIFIED',
        liveAcquisitionAttempted: true,
        message: `Live acquisition attempt failed: ${err.message}. Parity marked UNVERIFIED.`,
      };
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
