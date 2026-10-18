import { isSupabaseConfigured, pgQuery } from './supabaseClient.js';
import { db } from './db.js';

export interface ArchiveWorkerStatus {
  isEnabled: boolean;
  isArchiving: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  totalOrdersArchived: number;
  totalEventsArchived: number;
}

const status: ArchiveWorkerStatus = {
  isEnabled: false,
  isArchiving: false,
  lastRunAt: null,
  lastSuccessAt: null,
  lastError: null,
  totalOrdersArchived: 0,
  totalEventsArchived: 0,
};

let timer: NodeJS.Timeout | null = null;

export function getArchiveWorkerStatus(): ArchiveWorkerStatus {
  return { ...status };
}

/**
 * Execute a single isolated archival pass to Supabase.
 * Reads validated records from the local store in a read-only manner
 * and persists them idempotently in Supabase PostgreSQL.
 * If Supabase is unavailable, logs the failure without affecting the live pipeline.
 */
export async function triggerArchivePass(): Promise<{ success: boolean; ordersArchived: number; eventsArchived: number; error?: string }> {
  if (!isSupabaseConfigured()) {
    return { success: false, ordersArchived: 0, eventsArchived: 0, error: 'Supabase DATABASE_URL is not configured' };
  }

  if (status.isArchiving) {
    return { success: false, ordersArchived: 0, eventsArchived: 0, error: 'Archive pass already in progress' };
  }

  status.isArchiving = true;
  status.lastRunAt = new Date().toISOString();
  const startTime = Date.now();

  let ordersArchived = 0;
  let eventsArchived = 0;

  try {
    // 1. Read up to 200 recent/updated canonical orders from local DB
    const recentOrders: any[] = db.prepare(`
      SELECT 
        vendoor_id, random_number, order_no, order_type, current_status,
        distinct_merchant_count, multi_merchant_flag, delivery_rate,
        customer_phone, customer_phone_extra, extra_phone_valid,
        customer_name, governorate, address, total_price, shipping_cost,
        total_order, created_at_source, state_entry_at, last_observed_at
      FROM orders
      ORDER BY last_observed_at DESC
      LIMIT 200
    `).all();

    for (const ord of recentOrders) {
      try {
        await pgQuery(`
          INSERT INTO orders (
            vendoor_id, random_number, order_no, order_type, current_status,
            distinct_merchant_count, multi_merchant_flag, delivery_rate,
            customer_phone, customer_phone_extra, extra_phone_valid,
            customer_name, governorate, address, total_price, shipping_cost,
            total_order, created_at_source, state_entry_at, last_observed_at
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8,
            $9, $10, $11,
            $12, $13, $14, $15, $16,
            $17, $18, $19, $20
          )
          ON CONFLICT (vendoor_id) DO UPDATE SET
            current_status = EXCLUDED.current_status,
            delivery_rate = EXCLUDED.delivery_rate,
            last_observed_at = EXCLUDED.last_observed_at,
            customer_phone_extra = COALESCE(EXCLUDED.customer_phone_extra, orders.customer_phone_extra),
            extra_phone_valid = GREATEST(EXCLUDED.extra_phone_valid, orders.extra_phone_valid)
        `, [
          ord.vendoor_id, ord.random_number, ord.order_no, ord.order_type || 'اوردر جديد', ord.current_status,
          ord.distinct_merchant_count || 1, ord.multi_merchant_flag || 0, ord.delivery_rate,
          ord.customer_phone, ord.customer_phone_extra, ord.extra_phone_valid || 0,
          ord.customer_name, ord.governorate, ord.address, ord.total_price || 0, ord.shipping_cost || 0,
          ord.total_order || 0, ord.created_at_source, ord.state_entry_at, ord.last_observed_at
        ]);
        ordersArchived++;
      } catch (err: any) {
        // Individual row error, continue with remaining
      }
    }

    // 2. Read up to 200 recent canonical activity events
    const recentEvents: any[] = db.prepare(`
      SELECT order_code, actor_name, action_type, from_status, to_status, raw_action_text, event_timestamp, is_system_actor
      FROM canonical_activity_events
      ORDER BY id DESC
      LIMIT 200
    `).all();

    for (const ev of recentEvents) {
      try {
        await pgQuery(`
          INSERT INTO canonical_activity_events (
            order_code, actor_name, action_type, from_status, to_status, raw_action_text, event_timestamp, is_system_actor
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT DO NOTHING
        `, [
          ev.order_code, ev.actor_name, ev.action_type || 'action', ev.from_status, ev.to_status,
          ev.raw_action_text, ev.event_timestamp, ev.is_system_actor || 0
        ]);
        eventsArchived++;
      } catch (err: any) {
        // Continue
      }
    }

    status.lastSuccessAt = new Date().toISOString();
    status.lastError = null;
    status.totalOrdersArchived += ordersArchived;
    status.totalEventsArchived += eventsArchived;

    console.log(`[SupabaseArchive] Archival pass completed in ${Date.now() - startTime}ms: ${ordersArchived} orders, ${eventsArchived} events`);
    return { success: true, ordersArchived, eventsArchived };
  } catch (err: any) {
    status.lastError = `Archive error: ${err.message}`;
    console.error('[SupabaseArchive Worker Error]:', err.message);
    return { success: false, ordersArchived, eventsArchived, error: err.message };
  } finally {
    status.isArchiving = false;
  }
}

/**
 * Start the background archive worker on its own isolated schedule.
 */
export function startSupabaseArchiveWorker(intervalSeconds = 300): void {
  status.isEnabled = true;
  console.log(`[SupabaseArchive] Background archive worker started (interval: ${intervalSeconds}s)...`);

  // Initial trigger after 15 seconds to let server finish booting
  setTimeout(() => {
    triggerArchivePass().catch(() => {});
  }, 15000);

  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    triggerArchivePass().catch(() => {});
  }, intervalSeconds * 1000);
}

export function stopSupabaseArchiveWorker(): void {
  status.isEnabled = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
