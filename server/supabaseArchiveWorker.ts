import { isSupabaseConfigured, pgQuery } from './supabaseClient.ts';
import { db } from './db.ts';

export interface ArchiveWorkerStatus {
  isEnabled: boolean;
  isArchiving: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  status: 'IDLE' | 'SUCCESS' | 'PARTIAL' | 'FAILED';
  batchSize: number;
  ordersWaiting: number;
  ordersArchivedThisPass: number;
  ordersRemaining: number;
  eventsWaiting: number;
  eventsArchivedThisPass: number;
  eventsRemaining: number;
  rawLogsWaiting: number;
  rawLogsArchivedThisPass: number;
  rawLogsRemaining: number;
  totalOrdersArchived: number;
  totalEventsArchived: number;
  totalRawLogsArchived: number;
  failedCount: number;
  lastDurationMs: number | null;
}

const status: ArchiveWorkerStatus = {
  isEnabled: false,
  isArchiving: false,
  lastRunAt: null,
  lastSuccessAt: null,
  lastError: null,
  status: 'IDLE',
  batchSize: 200,
  ordersWaiting: 0,
  ordersArchivedThisPass: 0,
  ordersRemaining: 0,
  eventsWaiting: 0,
  eventsArchivedThisPass: 0,
  eventsRemaining: 0,
  rawLogsWaiting: 0,
  rawLogsArchivedThisPass: 0,
  rawLogsRemaining: 0,
  totalOrdersArchived: 0,
  totalEventsArchived: 0,
  totalRawLogsArchived: 0,
  failedCount: 0,
  lastDurationMs: null,
};

let timer: NodeJS.Timeout | null = null;
const BATCH_SIZE = 200;

export function getArchiveWorkerStatus(): ArchiveWorkerStatus {
  return { ...status };
}

function getCheckpoint(entityType: string): { lastArchivedId: number; lastArchivedAt: string | null } {
  try {
    const row: any = db.prepare('SELECT last_archived_id, last_archived_at FROM archive_checkpoints WHERE entity_type = ?').get(entityType);
    return {
      lastArchivedId: Number(row?.last_archived_id || 0),
      lastArchivedAt: row?.last_archived_at || null,
    };
  } catch {
    return { lastArchivedId: 0, lastArchivedAt: null };
  }
}

function updateCheckpoint(entityType: string, lastId: number, lastAt: string | null, incrementCount: number) {
  try {
    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO archive_checkpoints (entity_type, last_archived_id, last_archived_at, total_archived, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(entity_type) DO UPDATE SET
        last_archived_id = excluded.last_archived_id,
        last_archived_at = excluded.last_archived_at,
        total_archived = archive_checkpoints.total_archived + excluded.total_archived,
        updated_at = excluded.updated_at
    `).run(entityType, lastId, lastAt, incrementCount, nowIso);
  } catch (err: any) {
    console.warn(`[SupabaseArchive] Warning updating checkpoint for ${entityType}:`, err.message);
  }
}

/**
 * Execute a single isolated archival pass to Supabase with cursor pagination.
 * Reads validated records from the local store in a read-only manner
 * and persists them idempotently in Supabase PostgreSQL without duplicates.
 */
export async function triggerArchivePass(): Promise<{
  success: boolean;
  ordersArchived: number;
  eventsArchived: number;
  rawLogsArchived: number;
  ordersRemaining: number;
  eventsRemaining: number;
  rawLogsRemaining: number;
  error?: string;
}> {
  if (!isSupabaseConfigured()) {
    status.status = 'FAILED';
    status.lastError = 'DATABASE_URL is not configured';
    return {
      success: false,
      ordersArchived: 0,
      eventsArchived: 0,
      rawLogsArchived: 0,
      ordersRemaining: 0,
      eventsRemaining: 0,
      rawLogsRemaining: 0,
      error: 'Supabase DATABASE_URL is not configured',
    };
  }

  if (status.isArchiving) {
    return {
      success: false,
      ordersArchived: 0,
      eventsArchived: 0,
      rawLogsArchived: 0,
      ordersRemaining: status.ordersRemaining,
      eventsRemaining: status.eventsRemaining,
      rawLogsRemaining: status.rawLogsRemaining,
      error: 'Archive pass already in progress',
    };
  }

  status.isArchiving = true;
  status.lastRunAt = new Date().toISOString();
  const startTime = Date.now();

  let ordersArchived = 0;
  let eventsArchived = 0;
  let rawLogsArchived = 0;
  let failedCount = 0;

  try {
    // -------------------------------------------------------------------------
    // 1. ORDERS: Cursor-paginated batch of up to BATCH_SIZE
    // -------------------------------------------------------------------------
    const ordersCheckpoint = getCheckpoint('orders');
    const totalOrdersWaiting = (db.prepare('SELECT count(*) as c FROM orders WHERE id > ?').get(ordersCheckpoint.lastArchivedId) as any)?.c || 0;
    status.ordersWaiting = totalOrdersWaiting;

    const ordersBatch: any[] = db.prepare(`
      SELECT 
        id, vendoor_id, random_number, order_no, order_type, current_status,
        distinct_merchant_count, multi_merchant_flag, delivery_rate,
        customer_phone, customer_phone_extra, extra_phone_valid,
        customer_name, governorate, address, total_price, shipping_cost,
        total_order, created_at_source, state_entry_at, last_observed_at
      FROM orders
      WHERE id > ?
      ORDER BY id ASC
      LIMIT ?
    `).all(ordersCheckpoint.lastArchivedId, BATCH_SIZE);

    let maxOrderId = ordersCheckpoint.lastArchivedId;
    let maxOrderTime = ordersCheckpoint.lastArchivedAt;

    for (const ord of ordersBatch) {
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
        if (ord.id > maxOrderId) maxOrderId = ord.id;
        if (!maxOrderTime || ord.last_observed_at > maxOrderTime) maxOrderTime = ord.last_observed_at;
      } catch (err: any) {
        failedCount++;
      }
    }

    if (ordersArchived > 0) {
      updateCheckpoint('orders', maxOrderId, maxOrderTime, ordersArchived);
    }
    const ordersRemaining = Math.max(0, totalOrdersWaiting - ordersArchived);
    status.ordersArchivedThisPass = ordersArchived;
    status.ordersRemaining = ordersRemaining;

    // -------------------------------------------------------------------------
    // 2. CANONICAL ACTIVITY EVENTS: Cursor-paginated batch of up to BATCH_SIZE
    // -------------------------------------------------------------------------
    const canonCheckpoint = getCheckpoint('canonical_activity_events');
    const totalCanonWaiting = (db.prepare('SELECT count(*) as c FROM canonical_activity_events WHERE id > ?').get(canonCheckpoint.lastArchivedId) as any)?.c || 0;
    status.eventsWaiting = totalCanonWaiting;

    const canonBatch: any[] = db.prepare(`
      SELECT id, order_code, actor_name, action_type, from_status, to_status, event_timestamp, is_system_actor
      FROM canonical_activity_events
      WHERE id > ?
      ORDER BY id ASC
      LIMIT ?
    `).all(canonCheckpoint.lastArchivedId, BATCH_SIZE);

    let maxCanonId = canonCheckpoint.lastArchivedId;
    let maxCanonTime = canonCheckpoint.lastArchivedAt;

    for (const ev of canonBatch) {
      try {
        // Idempotent insertion: only insert if identical event does not already exist
        await pgQuery(`
          INSERT INTO canonical_activity_events (
            order_code, actor_name, action_type, from_status, to_status, event_timestamp, is_system_actor
          )
          SELECT $1, $2, $3, $4, $5, $6, $7
          WHERE NOT EXISTS (
            SELECT 1 FROM canonical_activity_events
            WHERE order_code = $1 AND event_timestamp = $6 AND action_type = $3
          )
        `, [
          ev.order_code, ev.actor_name, ev.action_type || 'action', ev.from_status, ev.to_status,
          ev.event_timestamp, ev.is_system_actor || 0
        ]);
        eventsArchived++;
        if (ev.id > maxCanonId) maxCanonId = ev.id;
        if (!maxCanonTime || ev.event_timestamp > maxCanonTime) maxCanonTime = ev.event_timestamp;
      } catch (err: any) {
        failedCount++;
      }
    }

    if (eventsArchived > 0) {
      updateCheckpoint('canonical_activity_events', maxCanonId, maxCanonTime, eventsArchived);
    }
    const eventsRemaining = Math.max(0, totalCanonWaiting - eventsArchived);
    status.eventsArchivedThisPass = eventsArchived;
    status.eventsRemaining = eventsRemaining;

    // -------------------------------------------------------------------------
    // 3. RAW ACTIVITY EVENTS: Cursor-paginated batch of up to BATCH_SIZE
    // -------------------------------------------------------------------------
    const rawCheckpoint = getCheckpoint('raw_activity_events');
    const totalRawWaiting = (db.prepare('SELECT count(*) as c FROM raw_activity_events WHERE id > ?').get(rawCheckpoint.lastArchivedId) as any)?.c || 0;
    status.rawLogsWaiting = totalRawWaiting;

    const rawBatch: any[] = db.prepare(`
      SELECT id, source_hash, order_code, actor_name, raw_action_text, event_timestamp, page_source, is_duplicate
      FROM raw_activity_events
      WHERE id > ?
      ORDER BY id ASC
      LIMIT ?
    `).all(rawCheckpoint.lastArchivedId, BATCH_SIZE);

    let maxRawId = rawCheckpoint.lastArchivedId;
    let maxRawTime = rawCheckpoint.lastArchivedAt;

    for (const rawEv of rawBatch) {
      try {
        await pgQuery(`
          INSERT INTO raw_activity_events (
            source_hash, order_code, actor_name, raw_action_text, event_timestamp, page_source, is_duplicate
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (source_hash) DO NOTHING
        `, [
          rawEv.source_hash, rawEv.order_code, rawEv.actor_name, rawEv.raw_action_text,
          rawEv.event_timestamp, rawEv.page_source || 'log/system', rawEv.is_duplicate || 0
        ]);
        rawLogsArchived++;
        if (rawEv.id > maxRawId) maxRawId = rawEv.id;
        if (!maxRawTime || rawEv.event_timestamp > maxRawTime) maxRawTime = rawEv.event_timestamp;
      } catch (err: any) {
        failedCount++;
      }
    }

    if (rawLogsArchived > 0) {
      updateCheckpoint('raw_activity_events', maxRawId, maxRawTime, rawLogsArchived);
    }
    const rawLogsRemaining = Math.max(0, totalRawWaiting - rawLogsArchived);
    status.rawLogsArchivedThisPass = rawLogsArchived;
    status.rawLogsRemaining = rawLogsRemaining;

    const passDuration = Date.now() - startTime;
    status.lastDurationMs = passDuration;
    const totalArchivedThisPass = ordersArchived + eventsArchived + rawLogsArchived;
    const totalWaitingBeforePass = totalOrdersWaiting + totalCanonWaiting + totalRawWaiting;

    let passStatus: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'IDLE';
    if (failedCount > 0) {
      passStatus = totalArchivedThisPass > 0 ? 'PARTIAL' : 'FAILED';
    } else if (totalArchivedThisPass > 0) {
      passStatus = 'SUCCESS';
    } else {
      passStatus = 'IDLE';
    }
    status.status = passStatus;

    if (totalArchivedThisPass > 0) {
      status.lastSuccessAt = new Date().toISOString();
    }

    if (totalWaitingBeforePass === 0 && totalArchivedThisPass === 0) {
      console.log(`[SupabaseArchive] Archival worker idle — queue empty (0 records waiting).`);
    } else {
      console.log(`[SupabaseArchive] Archival pass (${passStatus}) completed in ${passDuration}ms: ${ordersArchived} orders (waiting: ${totalOrdersWaiting}, remaining: ${ordersRemaining}), ${eventsArchived} canonical events (waiting: ${totalCanonWaiting}, remaining: ${eventsRemaining}), ${rawLogsArchived} raw logs (waiting: ${totalRawWaiting}, remaining: ${rawLogsRemaining}). UnsyncedCount: ${failedCount}`);
    }

    // If there is significant backlog remaining, schedule next pass sooner (10 seconds)
    if (ordersRemaining > 0 || eventsRemaining > 0 || rawLogsRemaining > 0) {
      setTimeout(() => {
        triggerArchivePass().catch(() => {});
      }, 10000);
    }

    return {
      success: passStatus !== 'FAILED',
      ordersArchived,
      eventsArchived,
      rawLogsArchived,
      ordersRemaining,
      eventsRemaining,
      rawLogsRemaining,
    };
  } catch (err: any) {
    status.status = 'FAILED';
    status.lastError = `Archive error: ${err.message}`;
    console.error('[SupabaseArchive Worker Error]:', err.message);
    return {
      success: false,
      ordersArchived,
      eventsArchived,
      rawLogsArchived,
      ordersRemaining: status.ordersRemaining,
      eventsRemaining: status.eventsRemaining,
      rawLogsRemaining: status.rawLogsRemaining,
      error: err.message,
    };
  } finally {
    status.isArchiving = false;
  }
}

/**
 * Start the background archive worker on its own isolated schedule.
 */
export function startSupabaseArchiveWorker(intervalSeconds = 300): void {
  status.isEnabled = true;
  console.log(`[SupabaseArchive] Background archive worker started (batchSize: ${BATCH_SIZE}, interval: ${intervalSeconds}s)...`);

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
