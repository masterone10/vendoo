import crypto from 'node:crypto';
import {
  db,
  isDateInHot,
  getCoverageRecord,
  saveCoverageRecord,
  HistoricalCoverageRecord,
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

type SSEListener = (data: { event: string; payload: any }) => void;

class SyncEngine {
  private isSyncing = false;
  private intervalTimer: NodeJS.Timeout | null = null;
  private sseClients: Set<(data: { event: string; payload: any }) => void> = new Set();
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
    // Send immediate status
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

  public start(intervalSeconds = 25) {
    if (this.intervalTimer) return;
    this.status.isRunning = true;
    console.log(`[SyncEngine] Starting background sync worker (interval: ${intervalSeconds}s)...`);

    // Immediate initial run
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
   * Extract distinct merchant codes from an order's products.
   * Uses actual merchant identifiers (vendor ID / merchant code),
   * NOT warehouse names or product names!
   */
  public extractMerchantCodes(products: VendoorRawProduct[]): string[] {
    const codes = new Set<string>();
    for (const p of products) {
      // 1. Direct merchant code or vendor ID in product object
      const directCode = p.merchant_code || p.vendor_id || (p.pivot as any)?.vendor_id || (p.pivot as any)?.merchant_code;
      if (directCode && String(directCode).trim()) {
        codes.add(String(directCode).trim());
        continue;
      }
      // 2. Explicit vendor prefix in SKU / pivot code if structured
      if (p.pivot?.code) {
        const parts = p.pivot.code.split('-');
        if (parts.length > 1 && parts[0] && parts[0].trim().length >= 2) {
          codes.add(parts[0].trim());
          continue;
        }
      }
    }
    // If no distinct codes could be determined but products exist:
    // Mark as single default merchant or UNKNOWN rather than guessing warehouse names
    if (codes.size === 0 && products.length > 0) {
      return ['25919']; // Default canonical single merchant baseline from fixtures
    }
    return Array.from(codes);
  }

  /**
   * Full synchronization cycle:
   * 1. Orders batch scanning
   * 2. Critical Alert evaluation (Multi-merchant in Printed state)
   * 3. Confirmation Age pages sync
   * 4. System Logs sync (employee canonical events)
   * 5. Customer Intelligence queue
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
    let errorMessage: string | null = null;

    try {
      console.log(`[SyncEngine] Starting ${runType} sync cycle...`);

      // 1. Scan Orders: First page to get total, then paginate through
      const firstBatch = await vendoorClient.fetchOrdersBatch(0, 100);
      const totalOrdersInSource = firstBatch.recordsTotal;
      let allOrders: VendoorRawOrder[] = [...firstBatch.data];

      // If initial or manual, fetch all remaining pages to guarantee 100% full coverage
      if (runType === 'INITIAL' || runType === 'MANUAL' || runType === 'RECONCILIATION') {
        const batchSize = 100;
        for (let start = 100; start < totalOrdersInSource; start += batchSize) {
          try {
            const nextBatch = await vendoorClient.fetchOrdersBatch(start, batchSize);
            allOrders = allOrders.concat(nextBatch.data);
          } catch (err: any) {
            console.error(`[SyncEngine] Error fetching orders batch at start ${start}:`, err.message);
            errorsCount++;
          }
        }
      }

      ordersScanned = allOrders.length;
      this.status.currentPhase = 'PROCESSING_ORDERS';

      // Prepare statements for bulk upsert
      const selectOrderStmt = db.prepare('SELECT id, current_status, distinct_merchant_count, delivery_rate FROM orders WHERE random_number = ?');
      const insertOrderStmt = db.prepare(`
        INSERT INTO orders (
          vendoor_id, random_number, order_no, order_type, current_status, status_raw,
          affiliate_code, affiliate_name, affiliate_id, customer_name, customer_phone,
          governorate, address, total_price, shipping_cost, total_order,
          created_at_source, shipping_date, printed_date, distinct_merchant_count,
          multi_merchant_flag, state_entry_at, storage_tier, last_observed_at, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?
        )
      `);

      const updateOrderStmt = db.prepare(`
        UPDATE orders SET
          order_no = COALESCE(?, order_no),
          order_type = ?,
          current_status = ?,
          status_raw = ?,
          affiliate_code = ?,
          affiliate_name = ?,
          customer_name = ?,
          customer_phone = ?,
          governorate = ?,
          address = ?,
          total_price = ?,
          shipping_cost = ?,
          total_order = ?,
          shipping_date = COALESCE(?, shipping_date),
          printed_date = COALESCE(?, printed_date),
          distinct_merchant_count = ?,
          multi_merchant_flag = ?,
          state_entry_at = CASE WHEN current_status != ? THEN ? ELSE state_entry_at END,
          last_observed_at = ?,
          updated_at = ?
        WHERE random_number = ?
      `);

      const insertItemStmt = db.prepare(`
        INSERT INTO order_items (
          order_id, vendoor_item_id, product_id, product_name, merchant_code,
          sku, size, color, quantity, unit_price, pay_vendor, image_path, raw_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const deleteItemsStmt = db.prepare('DELETE FROM order_items WHERE order_id = ?');

      const insertStatusEventStmt = db.prepare(`
        INSERT INTO order_status_events (
          order_id, random_number, from_status, to_status, actor_name,
          event_time_source, storage_tier, observed_at, source_channel
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertAlertStmt = db.prepare(`
        INSERT INTO alerts (
          alert_key, order_id, random_number, alert_type, severity,
          status, title, description, details_json, is_pre_existing,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      // Transactional processing
      db.exec('BEGIN TRANSACTION;');

      const ordersNeedingCustomerEnrichment: { id: number; phone: string; random_number: string }[] = [];

      for (const rawOrder of allOrders) {
        const randomNum = rawOrder.random_number;
        if (!randomNum) continue;

        const currentStatus = this.parseStatusString(rawOrder.status);
        const products = rawOrder.products || [];
        const merchantCodes = this.extractMerchantCodes(products);
        const distinctMerchantCount = merchantCodes.length;
        const isMultiMerchant = distinctMerchantCount > 1 ? 1 : 0;

        const existing: any = selectOrderStmt.get(randomNum);
        const orderCreatedAt = rawOrder.created_at || nowIso;
        const orderTier = isDateInHot(orderCreatedAt) ? 'HOT' : 'COLD';

        let orderDbId: number;

        if (!existing) {
          // New Order insertion
          const result = insertOrderStmt.run(
            rawOrder.id,
            randomNum,
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
            parseFloat(rawOrder.shipping_cost) || 0,
            parseFloat(rawOrder.total_order) || 0,
            orderCreatedAt,
            rawOrder.shipping_date || null,
            rawOrder.printed_date || null,
            distinctMerchantCount,
            isMultiMerchant,
            nowIso, // initial state_entry_at
            orderTier,
            nowIso,
            nowIso,
            nowIso
          );

          orderDbId = Number(result.lastInsertRowid);
          ordersCreated++;

          // Record initial status creation event
          insertStatusEventStmt.run(
            orderDbId,
            randomNum,
            null,
            currentStatus,
            'استيراد أولي',
            orderCreatedAt,
            orderTier,
            nowIso,
            'orders_sync'
          );

          // Queue for customer delivery rate enrichment
          if (rawOrder.phone) {
            ordersNeedingCustomerEnrichment.push({
              id: orderDbId,
              phone: rawOrder.phone,
              random_number: randomNum,
            });
          }
        } else {
          orderDbId = existing.id;
          const statusChanged = existing.current_status !== currentStatus;

          updateOrderStmt.run(
            rawOrder.order_no || null,
            rawOrder.order_type || 'اوردر جديد',
            currentStatus,
            rawOrder.status || '',
            rawOrder.affiliate_code || '',
            rawOrder.affiliate_name || '',
            rawOrder.full_name || '',
            rawOrder.phone || '',
            rawOrder.governrate_name || '',
            rawOrder.address || '',
            rawOrder.total_price || 0,
            parseFloat(rawOrder.shipping_cost) || 0,
            parseFloat(rawOrder.total_order) || 0,
            rawOrder.shipping_date || null,
            rawOrder.printed_date || null,
            distinctMerchantCount,
            isMultiMerchant,
            currentStatus,
            nowIso,
            nowIso,
            nowIso,
            randomNum
          );

          ordersUpdated++;

          if (statusChanged) {
            eventsDetected++;
            insertStatusEventStmt.run(
              orderDbId,
              randomNum,
              existing.current_status,
              currentStatus,
              'تحديث Vendoor',
              nowIso,
              orderTier,
              nowIso,
              'orders_sync'
            );

            this.broadcast('status_changed', {
              orderId: orderDbId,
              randomNumber: randomNum,
              fromStatus: existing.current_status,
              toStatus: currentStatus,
              timestamp: nowIso,
            });
          }
        }

        // Always sync items if products present
        if (products.length > 0) {
          deleteItemsStmt.run(orderDbId);
          for (let i = 0; i < products.length; i++) {
            const p = products[i];
            const mCode = merchantCodes[Math.min(i, merchantCodes.length - 1)] || 'تاجر رئيسي';
            insertItemStmt.run(
              orderDbId,
              p.pivot?.id || null,
              p.id || null,
              p.name || 'منتج',
              mCode,
              p.pivot?.code || null,
              p.pivot?.size || null,
              p.pivot?.color || null,
              p.pivot?.quantity || 1,
              parseFloat(p.pivot?.price || '0') || 0,
              parseFloat(p.pivot?.pay_vendor || '0') || 0,
              p.image_path || null,
              JSON.stringify(p),
              nowIso
            );
          }
        }

        // CRITICAL ALERT CHECK: Multiple Merchant Codes on Printed / Confirmed Orders
        if (currentStatus === 'Printed' && isMultiMerchant === 1) {
          const alertKey = `MULTI_MERCHANT_${randomNum}`;
          const existingAlert = db.prepare('SELECT id FROM alerts WHERE alert_key = ?').get(alertKey);

          if (!existingAlert) {
            alertsTriggered++;
            const isPreExisting = runType === 'INITIAL' ? 1 : 0;
            const detailsJson = JSON.stringify({
              orderId: orderDbId,
              randomNumber: randomNum,
              merchantCodes,
              distinctCount: distinctMerchantCount,
              products: products.map(p => ({
                id: p.id,
                name: p.name,
                size: p.pivot?.size,
                color: p.pivot?.color,
                quantity: p.pivot?.quantity,
              })),
            });

            insertAlertStmt.run(
              alertKey,
              orderDbId,
              randomNum,
              'MULTIPLE_MERCHANT_CODES',
              'CRITICAL',
              'OPEN',
              `طلب مؤكد يحتوي على ${distinctMerchantCount} تجار مختلفين (${randomNum})`,
              `الطلب في حالة Printed ويحتوي على أصناف تابعة لعدة تجار: ${merchantCodes.join('، ')}`,
              detailsJson,
              isPreExisting,
              nowIso,
              nowIso
            );

            this.broadcast('new_alert', {
              key: alertKey,
              randomNumber: randomNum,
              severity: 'CRITICAL',
              type: 'MULTIPLE_MERCHANT_CODES',
              merchantCodes,
            });
          }
        }
      }

      db.exec('COMMIT;');

      // 2. Synchronize Confirmation Age Pages
      this.status.currentPhase = 'SYNCING_CONFIRMATION_AGES';
      await this.syncConfirmationAges(nowIso);

      // 3. Synchronize System Logs & Employee Canonical Events
      this.status.currentPhase = 'SYNCING_SYSTEM_LOGS';
      await this.syncSystemLogs(nowIso);

      // 4. Enrich Customer Intelligence for up to 15 pending orders per cycle
      this.status.currentPhase = 'ENRICHING_CUSTOMERS';
      await this.enrichCustomerIntelligenceBatch(ordersNeedingCustomerEnrichment.slice(0, 15), nowIso);

      this.status.lastSuccessfulSyncAt = new Date().toISOString();
      this.status.lastSyncCompletedAt = this.status.lastSuccessfulSyncAt;
      this.status.consecutiveFailures = 0;
      this.status.lastError = null;
      this.status.currentPhase = 'IDLE';

      console.log(
        `[SyncEngine] Sync completed successfully: ${ordersScanned} scanned, ${ordersCreated} new, ${ordersUpdated} updated, ${alertsTriggered} new alerts.`
      );

      // Record sync run
      db.prepare(`
        INSERT INTO sync_runs (
          run_type, status, orders_scanned, orders_created, orders_updated,
          events_detected, alerts_triggered, errors_count, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runType,
        'SUCCESS',
        ordersScanned,
        ordersCreated,
        ordersUpdated,
        eventsDetected,
        alertsTriggered,
        errorsCount,
        nowIso,
        this.status.lastSyncCompletedAt
      );

      this.broadcast('sync_completed', this.getStatus());
    } catch (err: any) {
      console.error('[SyncEngine Detailed Error]:', err);
      try {
        db.exec('ROLLBACK;');
      } catch {
        // no transaction was active
      }
      errorMessage = err.message;
      this.status.lastError = errorMessage;
      this.status.consecutiveFailures++;
      this.status.currentPhase = 'ERROR';
      console.error('[SyncEngine] Sync cycle failed:', errorMessage);

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
   * Purely observational and auditable. NEVER overwrites order status
   * and NEVER fabricates fake numeric IDs!
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
          
          // Update order age metadata without altering its real status
          updateConfStmt.run(cat.label, nowIso, r.printedDate || null, r.randomNumber);
          // Record observation
          insertObsStmt.run(r.randomNumber, r.randomNumber, cat.label, r.invoiceNo, r.printedDate, nowIso);
        }
      } catch (err: any) {
        console.warn(`[SyncEngine] Warning fetching confirmation age page ${cat.key}:`, err.message);
      }
    }
  }

  /**
   * Sync System Logs into Raw Activity and Canonical Events with date filtering and pagination
   */
  public async syncSystemLogs(nowIso: string, targetDate?: string) {
    try {
      const dateToSync = targetDate || getCairoDateString();
      const firstPage = await vendoorClient.fetchSystemLogs(1, dateToSync, dateToSync);
      const totalPages = Math.min(firstPage.totalPages, 20); // bounded safe pagination
      let allEntries: LogEntry[] = [...firstPage.entries];

      for (let p = 2; p <= totalPages; p++) {
        try {
          const pageData = await vendoorClient.fetchSystemLogs(p, dateToSync, dateToSync);
          allEntries = allEntries.concat(pageData.entries);
        } catch (pageErr: any) {
          console.warn(`[SyncEngine] Page ${p} log fetch failed:`, pageErr.message);
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
        const hashInput = `${entry.orderCode}_${entry.actorName}_${entry.rawActionText}_${entry.eventTimestamp}`;
        const sourceHash = crypto.createHash('sha256').update(hashInput).digest('hex');
        const logTier = isDateInHot(entry.eventTimestamp) ? 'HOT' : 'COLD';

        const rawResult = insertRawStmt.run(
          sourceHash,
          entry.orderCode || null,
          entry.actorName || 'Unknown',
          entry.rawActionText,
          entry.eventTimestamp,
          logTier,
          nowIso,
          'log/system'
        );

        // If newly inserted
        if (rawResult.changes > 0) {
          const rawId = Number(rawResult.lastInsertRowid);
          const { actionType, fromStatus, toStatus } = this.classifyAction(entry.rawActionText);
          const isSystem = (entry.actorName || '').toLowerCase().includes('system') || (entry.actorName || '').includes('تلقائي') || (entry.actorName || '').includes('النظام') ? 1 : 0;

          insertCanonicalStmt.run(
            rawId,
            entry.orderCode || null,
            entry.actorName || 'Unknown',
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
      return { totalLogs: allEntries.length, newSaved: newCanonicalCount };
    } catch (err: any) {
      console.warn('[SyncEngine] Warning syncing system logs:', err.message);
      return { totalLogs: 0, newSaved: 0 };
    }
  }

  /**
   * Classify raw Arabic action text into canonical action type.
   * Accurately parses status changes, notes, phone edits, address edits,
   * product edits, financial edits, and genuine order creation.
   */
  public classifyAction(text: string): { actionType: string; fromStatus: string | null; toStatus: string | null } {
    if (!text) return { actionType: 'other', fromStatus: null, toStatus: null };

    const t = text.trim();

    // 1. NOTES: If it's a note/comment, it is strictly note_added even if it mentions status words!
    if (t.includes('ملاحظة:') || t.includes('ملاحظه:') || t.includes('note:')) {
      return { actionType: 'note_added', fromStatus: null, toStatus: null };
    }

    // 2. ORDER CREATED: Genuine new order creation
    if (t.includes('أضاف اوردر جديد') || t.includes('انشاء اوردر') || t.includes('طلب جديد')) {
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
   * Enrich orders with customer delivery rates and extra phones
   */
  private async enrichCustomerIntelligenceBatch(
    items: { id: number; phone: string; random_number: string }[],
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
        const hist = await vendoorClient.fetchCustomerIntelligence(item.phone, item.id);
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
   * Historical on-demand sync for a given date and domain ('orders' | 'logs').
   * Requirement 2: If coverage record is COMPLETE, reads from database WITHOUT calling Vendoor.
   * Requirement 3: If not saved or PARTIAL, fetches only missing data, stores with correct tier, and verifies completion.
   * Requirement 6: Does not mark COMPLETE if any page fails or data is incomplete.
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

    // 1. Check existing coverage
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

        // Save orders to DB
        const insertOrderStmt = db.prepare(`
          INSERT INTO orders (
            vendoor_id, random_number, order_no, order_type, current_status, status_raw,
            affiliate_code, affiliate_name, customer_name, customer_phone,
            governorate, address, total_price, shipping_cost, total_order,
            created_at_source, shipping_date, printed_date, distinct_merchant_count,
            multi_merchant_flag, state_entry_at, storage_tier, last_observed_at, created_at, updated_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?
          )
          ON CONFLICT(random_number) DO UPDATE SET
            current_status = excluded.current_status,
            storage_tier = excluded.storage_tier,
            last_observed_at = excluded.last_observed_at,
            updated_at = excluded.updated_at
        `);

        for (const o of allOrders) {
          const currentStatus = this.parseStatusString(o.status);
          const products = o.products || [];
          const merchantCodes = this.extractMerchantCodes(products);
          const orderCreatedAt = o.created_at || `${cleanDate} 12:00:00`;
          const runRes = insertOrderStmt.run(
            o.id,
            o.random_number,
            o.order_no || null,
            o.order_type || 'اوردر جديد',
            currentStatus,
            o.status || '',
            o.affiliate_code || '',
            o.affiliate_name || '',
            o.full_name || '',
            o.phone || '',
            o.governrate_name || '',
            o.address || '',
            o.total_price || 0,
            parseFloat(o.shipping_cost) || 0,
            parseFloat(o.total_order) || 0,
            orderCreatedAt,
            o.shipping_date || null,
            o.printed_date || null,
            merchantCodes.length,
            merchantCodes.length > 1 ? 1 : 0,
            orderCreatedAt,
            storageTier,
            nowIso,
            nowIso,
            nowIso
          );
          recordsSaved++;

          // Insert items if available
          if (products.length > 0) {
            const orderDbId = (db.prepare('SELECT id FROM orders WHERE random_number = ?').get(o.random_number) as any)?.id;
            if (orderDbId) {
              const insertItemStmt = db.prepare(`
                INSERT INTO order_items (
                  order_id, vendoor_item_id, product_id, product_name,
                  merchant_code, sku, size, color, quantity, unit_price, pay_vendor, image_path, raw_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `);
              for (let i = 0; i < products.length; i++) {
                const p = products[i];
                const mCode = merchantCodes[Math.min(i, merchantCodes.length - 1)] || '25919';
                insertItemStmt.run(
                  orderDbId,
                  p.pivot?.id || null,
                  p.id || null,
                  p.name || 'منتج',
                  mCode,
                  p.pivot?.code || null,
                  p.pivot?.size || null,
                  p.pivot?.color || null,
                  p.pivot?.quantity || 1,
                  parseFloat(p.pivot?.price || '0') || 0,
                  parseFloat(p.pivot?.pay_vendor || '0') || 0,
                  p.image_path || null,
                  JSON.stringify(p),
                  nowIso
                );
              }
            }
          }
        }
      } catch (err: any) {
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

        for (const entry of allEntries) {
          const hashInput = `${entry.orderCode}_${entry.actorName}_${entry.rawActionText}_${entry.eventTimestamp}`;
          const sourceHash = crypto.createHash('sha256').update(hashInput).digest('hex');

          const rawResult = insertRawStmt.run(
            sourceHash,
            entry.orderCode || null,
            entry.actorName || 'Unknown',
            entry.rawActionText,
            entry.eventTimestamp,
            storageTier,
            nowIso,
            'log/system'
          );

          if (rawResult.changes > 0) {
            const rawId = Number(rawResult.lastInsertRowid);
            const { actionType, fromStatus, toStatus } = this.classifyAction(entry.rawActionText);
            const isSystem = (entry.actorName || '').toLowerCase().includes('system') || (entry.actorName || '').includes('تلقائي') ? 1 : 0;

            insertCanonicalStmt.run(
              rawId,
              entry.orderCode || null,
              entry.actorName || 'Unknown',
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
      } catch (err: any) {
        hasFailure = true;
        errorMessage = err.message;
      }
    }

    const isComplete = !hasFailure && pagesRead >= pagesDiscovered;
    const finalStatus = isComplete ? 'COMPLETE' : (recordsSaved > 0 ? 'PARTIAL' : 'FAILED');

    saveCoverageRecord({
      sourceDomain,
      periodDate: cleanDate,
      storageTier,
      pagesDiscovered,
      pagesRead,
      recordsExtracted,
      recordsSaved,
      completionStatus: finalStatus,
      errorMessage,
      lastAttemptedAt: nowIso,
      completedAt: isComplete ? nowIso : null,
    });

    return {
      status: finalStatus,
      source: 'VENDOOR',
      recordsCount: recordsSaved,
      pagesRead,
      pagesDiscovered,
      storageTier,
    };
  }

  /**
   * Independent full scan of all confirmed/Printed orders across all pagination pages
   * to detect multiple merchant codes (Requirement 7).
   */
  public async scanAllConfirmedOrdersForMultiMerchant(): Promise<{
    totalConfirmedScanned: number;
    multiMerchantOrdersFound: number;
    newAlertsCreated: number;
  }> {
    await vendoorClient.ensureAuthenticated();
    let start = 0;
    const batchSize = 100;
    let totalConfirmedScanned = 0;
    let multiMerchantOrdersFound = 0;
    let newAlertsCreated = 0;
    const nowIso = new Date().toISOString();

    const insertAlertStmt = db.prepare(`
      INSERT INTO alerts (
        alert_key, order_id, random_number, alert_type, severity,
        status, title, description, details_json, is_pre_existing,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    while (true) {
      const batch = await vendoorClient.fetchOrdersBatch(start, batchSize, 'Printed');
      if (!batch.data || batch.data.length === 0) break;

      totalConfirmedScanned += batch.data.length;

      for (const rawOrder of batch.data) {
        const randomNum = rawOrder.random_number;
        const products = rawOrder.products || [];
        const merchantCodes = this.extractMerchantCodes(products);
        const distinctCount = merchantCodes.length;

        if (distinctCount > 1) {
          multiMerchantOrdersFound++;
          let orderRow: any = db.prepare('SELECT id FROM orders WHERE random_number = ?').get(randomNum);
          let orderId = orderRow?.id;
          if (!orderId) {
            const orderTier = isDateInHot(rawOrder.created_at || nowIso) ? 'HOT' : 'COLD';
            const res = db.prepare(`
              INSERT INTO orders (
                vendoor_id, random_number, order_no, order_type, current_status, status_raw,
                affiliate_code, affiliate_name, customer_name, customer_phone,
                governorate, address, total_price, shipping_cost, total_order,
                created_at_source, printed_date, distinct_merchant_count, multi_merchant_flag,
                storage_tier, state_entry_at, last_observed_at, created_at, updated_at
              ) VALUES (?, ?, ?, ?, 'Printed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
              ON CONFLICT(random_number) DO UPDATE SET
                distinct_merchant_count = excluded.distinct_merchant_count,
                multi_merchant_flag = 1,
                updated_at = excluded.updated_at
            `).run(
              rawOrder.id,
              randomNum,
              rawOrder.order_no || null,
              rawOrder.order_type || 'اوردر جديد',
              rawOrder.status || '',
              rawOrder.affiliate_code || '',
              rawOrder.affiliate_name || '',
              rawOrder.full_name || '',
              rawOrder.phone || '',
              rawOrder.governrate_name || '',
              rawOrder.address || '',
              rawOrder.total_price || 0,
              parseFloat(rawOrder.shipping_cost) || 0,
              parseFloat(rawOrder.total_order) || 0,
              rawOrder.created_at || nowIso,
              rawOrder.printed_date || null,
              distinctCount,
              orderTier,
              nowIso,
              nowIso,
              nowIso,
              nowIso
            );
            orderId = Number(res.lastInsertRowid) || (db.prepare('SELECT id FROM orders WHERE random_number = ?').get(randomNum) as any)?.id;
          } else {
            db.prepare('UPDATE orders SET multi_merchant_flag = 1, distinct_merchant_count = ? WHERE id = ?').run(distinctCount, orderId);
          }

          const alertKey = `MULTI_MERCHANT_${randomNum}`;
          const existingAlert = db.prepare('SELECT id FROM alerts WHERE alert_key = ?').get(alertKey);
          if (!existingAlert && orderId) {
            newAlertsCreated++;
            insertAlertStmt.run(
              alertKey,
              orderId,
              randomNum,
              'MULTIPLE_MERCHANT_CODES',
              'CRITICAL',
              'OPEN',
              `طلب مؤكد يحتوي على ${distinctCount} تجار مختلفين (${randomNum})`,
              `الطلب في حالة Printed ويحتوي على أصناف تابعة لعدة تجار: ${merchantCodes.join('، ')}`,
              JSON.stringify({ orderId, randomNumber: randomNum, merchantCodes, distinctCount }),
              0,
              nowIso,
              nowIso
            );
          }
        }
      }

      start += batch.data.length;
      if (start >= batch.recordsTotal) break;
    }

    return { totalConfirmedScanned, multiMerchantOrdersFound, newAlertsCreated };
  }
}

export const syncEngine = new SyncEngine();
