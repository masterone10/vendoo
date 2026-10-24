import { isSupabaseConfigured, pgQuery } from './supabaseClient.ts';
import { db } from './db.ts';

export interface ArchiveWorkerStatus {
  isEnabled: boolean;
  isArchiving: boolean;
  isArchiveComplete: boolean;
  isCircuitOpen: boolean;
  consecutiveFailures: number;
  nextScheduledAttemptAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  status: 'IDLE' | 'DRAINING' | 'FULLY_ARCHIVED' | 'PARTIAL' | 'FAILED' | 'AWAITING_CONFIG' | 'STANDBY_LOCAL_RETAIN';
  batchStatus: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'IDLE';
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
  coverageWaiting: number;
  coverageRemaining: number;
  totalWaiting: number;
  tablesWaiting: {
    orders: number;
    canonical_activity_events: number;
    raw_activity_events: number;
    historical_coverage: number;
  };
  totalOrdersArchived: number;
  totalEventsArchived: number;
  totalRawLogsArchived: number;
  failedCount: number;
  lastDurationMs: number | null;
}

const status: ArchiveWorkerStatus = {
  isEnabled: false,
  isArchiving: false,
  isArchiveComplete: false,
  isCircuitOpen: false,
  consecutiveFailures: 0,
  nextScheduledAttemptAt: null,
  lastRunAt: null,
  lastSuccessAt: null,
  lastError: null,
  status: 'IDLE',
  batchStatus: 'IDLE',
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
  coverageWaiting: 0,
  coverageRemaining: 0,
  totalWaiting: 0,
  tablesWaiting: {
    orders: 0,
    canonical_activity_events: 0,
    raw_activity_events: 0,
    historical_coverage: 0,
  },
  totalOrdersArchived: 0,
  totalEventsArchived: 0,
  totalRawLogsArchived: 0,
  failedCount: 0,
  lastDurationMs: null,
};

let drainTimer: NodeJS.Timeout | null = null;
let periodicTimer: NodeJS.Timeout | null = null;
let scheduledIntervalMs = 300000;
let consecutiveFailures = 0;
let nextScheduledAttemptAt: string | null = null;
const BATCH_SIZE = 200;
const CHUNK_SIZE = 50;

/**
 * Real Exponential Backoff calculation with random jitter and strict ceiling of 5 minutes (300,000 ms).
 * Formula: Math.min(maxMs, baseMs * 2^(min(failures - 1, 10))) + jitter
 *
 * Example progression (baseMs = 5000, maxMs = 300000, jitter = 0..2000ms):
 * Attempt 1: ~5s (+ jitter)
 * Attempt 2: ~10s (+ jitter)
 * Attempt 3: ~20s (+ jitter)
 * Attempt 4: ~40s (+ jitter)
 * Attempt 5: ~80s (+ jitter)
 * Attempt 6: ~160s (+ jitter)
 * Attempt 7+: 300s (capped at 5 minutes ceiling)
 */
export function calculateExponentialBackoff(
  failures: number,
  baseMs = 5000,
  maxMs = 300000,
  jitterRangeMs = 2000
): number {
  if (failures <= 0) return 0;
  const exponent = Math.min(failures - 1, 10);
  const exponentialDelay = baseMs * Math.pow(2, exponent);
  const clampedBase = Math.min(maxMs, exponentialDelay);
  const jitter = Math.floor(Math.random() * jitterRangeMs);
  return Math.min(maxMs, clampedBase + jitter);
}

export function getArchiveWorkerStatus(): ArchiveWorkerStatus {
  let covWaiting = 0;
  try {
    const row: any = db.prepare("SELECT count(*) as c FROM historical_coverage WHERE period_date >= '2026-10-23' AND remote_archive_status != 'REMOTE_VERIFIED'").get();
    covWaiting = Number(row?.c || 0);
  } catch {}

  // If not actively executing a pass, re-query live SQLite counts to ensure
  // current status reflects exact state and never falsely reports FULLY_ARCHIVED
  if (!status.isArchiving) {
    try {
      const ordersCheckpoint = getCheckpoint('orders');
      const canonCheckpoint = getCheckpoint('canonical_activity_events');
      const rawCheckpoint = getCheckpoint('raw_activity_events');

      const oWait = (db.prepare("SELECT count(*) as c FROM orders WHERE id > ? AND created_at_source >= '2026-10-23 00:00:00'").get(ordersCheckpoint.lastArchivedId) as any)?.c || 0;
      const eWait = (db.prepare("SELECT count(*) as c FROM canonical_activity_events WHERE id > ? AND event_timestamp >= '2026-10-23 00:00:00'").get(canonCheckpoint.lastArchivedId) as any)?.c || 0;
      const rWait = (db.prepare("SELECT count(*) as c FROM raw_activity_events WHERE id > ? AND event_timestamp >= '2026-10-23 00:00:00'").get(rawCheckpoint.lastArchivedId) as any)?.c || 0;

      status.ordersWaiting = oWait;
      status.eventsWaiting = eWait;
      status.rawLogsWaiting = rWait;
      status.ordersRemaining = oWait;
      status.eventsRemaining = eWait;
      status.rawLogsRemaining = rWait;

      const totalWaitingNow = oWait + eWait + rWait + covWaiting;
      if (totalWaitingNow > 0) {
        status.isArchiveComplete = false;
        if (status.status === 'FULLY_ARCHIVED' || status.status === 'IDLE') {
          status.status = consecutiveFailures >= 2 ? 'STANDBY_LOCAL_RETAIN' : 'DRAINING';
        }
      } else if (status.failedCount === 0) {
        status.isArchiveComplete = true;
        if (status.status !== 'STANDBY_LOCAL_RETAIN' && status.status !== 'FAILED') {
          status.status = 'FULLY_ARCHIVED';
        }
      }
    } catch {}
  }

  const totalWaiting = status.ordersWaiting + status.eventsWaiting + status.rawLogsWaiting + covWaiting;
  const isCircuitOpen = consecutiveFailures >= 2;

  return {
    ...status,
    isCircuitOpen,
    consecutiveFailures,
    nextScheduledAttemptAt,
    coverageWaiting: covWaiting,
    coverageRemaining: covWaiting,
    totalWaiting,
    tablesWaiting: {
      orders: status.ordersWaiting,
      canonical_activity_events: status.eventsWaiting,
      raw_activity_events: status.rawLogsWaiting,
      historical_coverage: covWaiting,
    },
  };
}

function isConnectionOrTimeoutError(err: any): boolean {
  if (!err) return false;
  const msg = String(err.message || '');
  return (
    msg.includes('Connection terminated') ||
    msg.includes('timeout') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('closed') ||
    err.code === '57P01' ||
    err.code === '08006' ||
    err.code === '08001'
  );
}

function clearScheduledTimers() {
  if (drainTimer) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
  if (periodicTimer) {
    clearTimeout(periodicTimer);
    periodicTimer = null;
  }
  nextScheduledAttemptAt = null;
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
  isArchiveComplete: boolean;
  error?: string;
}> {
  if (!isSupabaseConfigured()) {
    status.status = 'AWAITING_CONFIG';
    status.batchStatus = 'IDLE';
    status.isArchiveComplete = false;
    status.lastError = 'DATABASE_URL is not configured';
    return {
      success: false,
      ordersArchived: 0,
      eventsArchived: 0,
      rawLogsArchived: 0,
      ordersRemaining: 0,
      eventsRemaining: 0,
      rawLogsRemaining: 0,
      isArchiveComplete: false,
      error: 'Supabase DATABASE_URL is not configured (running in local SQLite mode)',
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
      isArchiveComplete: status.isArchiveComplete,
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
  let hadConnectionError = false;

  try {
    // -------------------------------------------------------------------------
    // 0. CHECK PENDING RECORDS IN SQLITE (Strictly enforce Cutoff >= 2026-10-23)
    // -------------------------------------------------------------------------
    const ordersCheckpoint = getCheckpoint('orders');
    const canonCheckpoint = getCheckpoint('canonical_activity_events');
    const rawCheckpoint = getCheckpoint('raw_activity_events');

    const totalOrdersWaiting = (db.prepare("SELECT count(*) as c FROM orders WHERE id > ? AND created_at_source >= '2026-10-23 00:00:00'").get(ordersCheckpoint.lastArchivedId) as any)?.c || 0;
    const totalCanonWaiting = (db.prepare("SELECT count(*) as c FROM canonical_activity_events WHERE id > ? AND event_timestamp >= '2026-10-23 00:00:00'").get(canonCheckpoint.lastArchivedId) as any)?.c || 0;
    const totalRawWaiting = (db.prepare("SELECT count(*) as c FROM raw_activity_events WHERE id > ? AND event_timestamp >= '2026-10-23 00:00:00'").get(rawCheckpoint.lastArchivedId) as any)?.c || 0;

    status.ordersWaiting = totalOrdersWaiting;
    status.eventsWaiting = totalCanonWaiting;
    status.rawLogsWaiting = totalRawWaiting;

    const totalWaitingBeforePass = totalOrdersWaiting + totalCanonWaiting + totalRawWaiting;

    // If no post-cutoff records are pending, conclude without opening remote connections
    if (totalWaitingBeforePass === 0) {
      status.ordersRemaining = 0;
      status.eventsRemaining = 0;
      status.rawLogsRemaining = 0;
      status.isArchiveComplete = true;
      status.status = 'FULLY_ARCHIVED';
      status.batchStatus = 'IDLE';
      consecutiveFailures = 0;

      clearScheduledTimers();
      if (status.isEnabled) {
        periodicTimer = setTimeout(() => {
          triggerArchivePass().catch(() => {});
        }, scheduledIntervalMs);
      }

      return {
        success: true,
        ordersArchived: 0,
        eventsArchived: 0,
        rawLogsArchived: 0,
        ordersRemaining: 0,
        eventsRemaining: 0,
        rawLogsRemaining: 0,
        isArchiveComplete: true,
      };
    }

    // -------------------------------------------------------------------------
    // Pre-flight health ping: verify pool connectivity before starting batch operations
    // -------------------------------------------------------------------------
    const pingCid = `arch_ping_${Date.now()}`;
    try {
      await pgQuery('SELECT 1 as ping', [], {
        correlationId: pingCid,
        operationName: 'archive_preflight_ping',
      });
      consecutiveFailures = 0;
      nextScheduledAttemptAt = null;
    } catch (pingErr: any) {
      consecutiveFailures++;
      const backoffMs = calculateExponentialBackoff(consecutiveFailures, 5000, 300000, 2000);
      nextScheduledAttemptAt = new Date(Date.now() + backoffMs).toISOString();
      status.status = consecutiveFailures >= 2 ? 'STANDBY_LOCAL_RETAIN' : 'PARTIAL';
      status.batchStatus = 'FAILED';
      status.lastError = `Supabase standby (${pingErr.message}). Pending records preserved in SQLite.`;

      if (consecutiveFailures <= 2) {
        console.info(
          `[SupabaseArchive] Pre-flight connection standby: ${pingErr.message}. Local records safely retained in SQLite. Backing off for ${Math.round(backoffMs / 1000)}s with jitter (consecutive: ${consecutiveFailures}).`
        );
      }

      clearScheduledTimers();
      if (status.isEnabled) {
        drainTimer = setTimeout(() => {
          triggerArchivePass().catch(() => {});
        }, backoffMs);
      }

      return {
        success: false,
        ordersArchived: 0,
        eventsArchived: 0,
        rawLogsArchived: 0,
        ordersRemaining: totalOrdersWaiting,
        eventsRemaining: totalCanonWaiting,
        rawLogsRemaining: totalRawWaiting,
        isArchiveComplete: false,
        error: pingErr.message,
      };
    }

    // -------------------------------------------------------------------------
    // 1. ORDERS: Cursor-paginated batch of up to BATCH_SIZE with multi-row chunking
    // CLOUD ARCHIVE POLICY: Only archive orders from 2026-10-23 onwards to Supabase
    // -------------------------------------------------------------------------
    let currentOrderCheckpointId = ordersCheckpoint.lastArchivedId;
    let currentOrderCheckpointTime = ordersCheckpoint.lastArchivedAt;

    if (totalOrdersWaiting > 0) {
      const ordersBatch: any[] = db.prepare(`
        SELECT 
          id, vendoor_id, random_number, order_no, order_type, current_status,
          distinct_merchant_count, multi_merchant_flag, distinct_warehouse_count, multi_warehouse_flag, delivery_rate,
          customer_phone, customer_phone_extra, extra_phone_valid,
          customer_name, governorate, address, total_price, shipping_cost,
          total_order, created_at_source, state_entry_at, last_observed_at
        FROM orders
        WHERE id > ? AND created_at_source >= '2026-10-23 00:00:00'
        ORDER BY id ASC
        LIMIT ?
      `).all(ordersCheckpoint.lastArchivedId, BATCH_SIZE);

      for (let i = 0; i < ordersBatch.length; i += CHUNK_SIZE) {
        const chunk = ordersBatch.slice(i, i + CHUNK_SIZE);
        const valuesSql: string[] = [];
        const params: any[] = [];
        let pIdx = 1;

        for (const ord of chunk) {
          valuesSql.push(`(
            $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++},
            $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++},
            $${pIdx++}, $${pIdx++}, $${pIdx++},
            $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++},
            $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}
          )`);
          params.push(
            ord.vendoor_id, ord.random_number, ord.order_no, ord.order_type || 'اوردر جديد', ord.current_status,
            ord.distinct_merchant_count || 1, ord.multi_merchant_flag || 0,
            ord.distinct_warehouse_count || 1, ord.multi_warehouse_flag || 0,
            ord.delivery_rate,
            ord.customer_phone, ord.customer_phone_extra, ord.extra_phone_valid || 0,
            ord.customer_name, ord.governorate, ord.address, ord.total_price || 0, ord.shipping_cost || 0,
            ord.total_order || 0, ord.created_at_source, ord.state_entry_at, ord.last_observed_at
          );
        }

        const queryText = `
          INSERT INTO orders (
            vendoor_id, random_number, order_no, order_type, current_status,
            distinct_merchant_count, multi_merchant_flag, distinct_warehouse_count, multi_warehouse_flag, delivery_rate,
            customer_phone, customer_phone_extra, extra_phone_valid,
            customer_name, governorate, address, total_price, shipping_cost,
            total_order, created_at_source, state_entry_at, last_observed_at
          ) VALUES ${valuesSql.join(', ')}
          ON CONFLICT (vendoor_id) DO UPDATE SET
            current_status = EXCLUDED.current_status,
            delivery_rate = EXCLUDED.delivery_rate,
            distinct_warehouse_count = COALESCE(EXCLUDED.distinct_warehouse_count, orders.distinct_warehouse_count),
            multi_warehouse_flag = COALESCE(EXCLUDED.multi_warehouse_flag, orders.multi_warehouse_flag),
            last_observed_at = EXCLUDED.last_observed_at,
            customer_phone_extra = COALESCE(EXCLUDED.customer_phone_extra, orders.customer_phone_extra),
            extra_phone_valid = GREATEST(EXCLUDED.extra_phone_valid, orders.extra_phone_valid)
        `;

        try {
          await pgQuery(queryText, params);
          ordersArchived += chunk.length;
          const lastChunkItem = chunk[chunk.length - 1];
          currentOrderCheckpointId = lastChunkItem.id;
          currentOrderCheckpointTime = lastChunkItem.last_observed_at || currentOrderCheckpointTime;
          updateCheckpoint('orders', currentOrderCheckpointId, currentOrderCheckpointTime, chunk.length);
          await new Promise((r) => setTimeout(r, 60)); // Pacing
        } catch (chunkErr: any) {
          failedCount += chunk.length;
          console.info(`[SupabaseArchive] Orders chunk (${chunk.length} rows) notice:`, chunkErr.message);
          if (isConnectionOrTimeoutError(chunkErr)) {
            hadConnectionError = true;
          }
          break; // Stop advancing checkpoint past failed chunk
        }
      }
    }

    // Direct mathematical count from SQLite after cursor advance to prevent stale math drift
    const ordersRemaining = (db.prepare("SELECT count(*) as c FROM orders WHERE id > ? AND created_at_source >= '2026-10-23 00:00:00'").get(currentOrderCheckpointId) as any)?.c || 0;
    status.ordersArchivedThisPass = ordersArchived;
    status.ordersRemaining = ordersRemaining;

    // -------------------------------------------------------------------------
    // 2. CANONICAL ACTIVITY EVENTS: Multi-row idempotent chunked insertion
    // CLOUD ARCHIVE POLICY: Only archive events from 2026-10-23 onwards to Supabase
    // -------------------------------------------------------------------------
    let currentCanonCheckpointId = canonCheckpoint.lastArchivedId;
    let currentCanonCheckpointTime = canonCheckpoint.lastArchivedAt;

    if (!hadConnectionError && totalCanonWaiting > 0) {
      const canonBatch: any[] = db.prepare(`
        SELECT id, order_code, actor_name, action_type, from_status, to_status, event_timestamp, is_system_actor
        FROM canonical_activity_events
        WHERE id > ? AND event_timestamp >= '2026-10-23 00:00:00'
        ORDER BY id ASC
        LIMIT ?
      `).all(canonCheckpoint.lastArchivedId, BATCH_SIZE);

      for (let i = 0; i < canonBatch.length; i += CHUNK_SIZE) {
        const chunk = canonBatch.slice(i, i + CHUNK_SIZE);
        const valuesSql: string[] = [];
        const params: any[] = [];
        let pIdx = 1;

        for (const ev of chunk) {
          valuesSql.push(`($${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}::timestamptz, $${pIdx++}::boolean)`);
          params.push(
            ev.order_code, ev.actor_name, ev.action_type || 'action', ev.from_status, ev.to_status,
            ev.event_timestamp, Boolean(ev.is_system_actor)
          );
        }

        const queryText = `
          INSERT INTO canonical_activity_events (
            order_code, actor_name, action_type, from_status, to_status, event_timestamp, is_system_actor
          )
          SELECT v.order_code, v.actor_name, v.action_type, v.from_status, v.to_status, v.event_timestamp, v.is_system_actor
          FROM (VALUES ${valuesSql.join(', ')}) AS v(order_code, actor_name, action_type, from_status, to_status, event_timestamp, is_system_actor)
          WHERE NOT EXISTS (
            SELECT 1 FROM canonical_activity_events c
            WHERE (c.order_code IS NOT DISTINCT FROM v.order_code)
              AND c.event_timestamp = v.event_timestamp
              AND c.action_type = v.action_type
              AND c.actor_name = v.actor_name
          )
        `;

        try {
          await pgQuery(queryText, params);
          eventsArchived += chunk.length;
          const lastChunkItem = chunk[chunk.length - 1];
          currentCanonCheckpointId = lastChunkItem.id;
          currentCanonCheckpointTime = lastChunkItem.event_timestamp || currentCanonCheckpointTime;
          updateCheckpoint('canonical_activity_events', currentCanonCheckpointId, currentCanonCheckpointTime, chunk.length);
          await new Promise((r) => setTimeout(r, 60)); // Pacing
        } catch (chunkErr: any) {
          failedCount += chunk.length;
          console.info(`[SupabaseArchive] Canonical events chunk (${chunk.length} rows) notice:`, chunkErr.message);
          if (isConnectionOrTimeoutError(chunkErr)) {
            hadConnectionError = true;
          }
          break; // Stop advancing checkpoint past failed chunk
        }
      }
    }

    const eventsRemaining = (db.prepare("SELECT count(*) as c FROM canonical_activity_events WHERE id > ? AND event_timestamp >= '2026-10-23 00:00:00'").get(currentCanonCheckpointId) as any)?.c || 0;
    status.eventsArchivedThisPass = eventsArchived;
    status.eventsRemaining = eventsRemaining;

    // -------------------------------------------------------------------------
    // 3. RAW ACTIVITY EVENTS: Multi-row chunked insertion with ON CONFLICT DO NOTHING
    // CLOUD ARCHIVE POLICY: Only archive raw logs from 2026-10-23 onwards to Supabase
    // -------------------------------------------------------------------------
    let currentRawCheckpointId = rawCheckpoint.lastArchivedId;
    let currentRawCheckpointTime = rawCheckpoint.lastArchivedAt;

    if (!hadConnectionError && totalRawWaiting > 0) {
      const rawBatch: any[] = db.prepare(`
        SELECT id, source_hash, order_code, actor_name, raw_action_text, event_timestamp, page_source, is_duplicate
        FROM raw_activity_events
        WHERE id > ? AND event_timestamp >= '2026-10-23 00:00:00'
        ORDER BY id ASC
        LIMIT ?
      `).all(rawCheckpoint.lastArchivedId, BATCH_SIZE);

      for (let i = 0; i < rawBatch.length; i += CHUNK_SIZE) {
        const chunk = rawBatch.slice(i, i + CHUNK_SIZE);
        const valuesSql: string[] = [];
        const params: any[] = [];
        let pIdx = 1;

        for (const rawEv of chunk) {
          valuesSql.push(`($${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}::timestamptz, $${pIdx++}, $${pIdx++}::boolean)`);
          params.push(
            rawEv.source_hash, rawEv.order_code, rawEv.actor_name, rawEv.raw_action_text,
            rawEv.event_timestamp, rawEv.page_source || 'log/system', Boolean(rawEv.is_duplicate)
          );
        }

        const queryText = `
          INSERT INTO raw_activity_events (
            source_hash, order_code, actor_name, raw_action_text, event_timestamp, page_source, is_duplicate
          ) VALUES ${valuesSql.join(', ')}
          ON CONFLICT (source_hash) DO NOTHING
        `;

        try {
          await pgQuery(queryText, params);
          rawLogsArchived += chunk.length;
          const lastChunkItem = chunk[chunk.length - 1];
          currentRawCheckpointId = lastChunkItem.id;
          currentRawCheckpointTime = lastChunkItem.event_timestamp || currentRawCheckpointTime;
          updateCheckpoint('raw_activity_events', currentRawCheckpointId, currentRawCheckpointTime, chunk.length);
          await new Promise((r) => setTimeout(r, 60)); // Pacing
        } catch (chunkErr: any) {
          failedCount += chunk.length;
          console.info(`[SupabaseArchive] Raw logs chunk (${chunk.length} rows) notice:`, chunkErr.message);
          if (isConnectionOrTimeoutError(chunkErr)) {
            hadConnectionError = true;
          }
          break; // Stop advancing checkpoint past failed chunk
        }
      }
    }

    const rawLogsRemaining = (db.prepare("SELECT count(*) as c FROM raw_activity_events WHERE id > ? AND event_timestamp >= '2026-10-23 00:00:00'").get(currentRawCheckpointId) as any)?.c || 0;
    status.rawLogsArchivedThisPass = rawLogsArchived;
    status.rawLogsRemaining = rawLogsRemaining;

    // Cumulative totals
    status.totalOrdersArchived += ordersArchived;
    status.totalEventsArchived += eventsArchived;
    status.totalRawLogsArchived += rawLogsArchived;

    const passDuration = Date.now() - startTime;
    status.lastDurationMs = passDuration;
    const totalArchivedThisPass = ordersArchived + eventsArchived + rawLogsArchived;
    const totalRemaining = ordersRemaining + eventsRemaining + rawLogsRemaining;

    // Distinct evaluation of pass outcome vs overall archival state
    let batchStatus: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'IDLE';
    if (hadConnectionError || (failedCount > 0 && totalArchivedThisPass === 0)) {
      batchStatus = 'FAILED';
    } else if (failedCount > 0) {
      batchStatus = 'PARTIAL';
    } else if (totalArchivedThisPass > 0) {
      batchStatus = 'SUCCESS';
    } else {
      batchStatus = 'IDLE';
    }
    status.batchStatus = batchStatus;

    if (totalArchivedThisPass > 0) {
      status.lastSuccessAt = new Date().toISOString();
      status.lastError = null;
    }

    const isArchiveComplete = totalRemaining === 0;
    status.isArchiveComplete = isArchiveComplete;

    if (isArchiveComplete) {
      status.status = 'FULLY_ARCHIVED';
    } else if (batchStatus === 'FAILED') {
      status.status = consecutiveFailures >= 2 ? 'STANDBY_LOCAL_RETAIN' : 'FAILED';
    } else if (batchStatus === 'PARTIAL') {
      status.status = 'PARTIAL';
    } else {
      status.status = 'DRAINING';
    }

    // Diagnostics & logging:
    if (totalWaitingBeforePass === 0 && totalArchivedThisPass === 0) {
      console.log(`[SupabaseArchive] Idle — local queue is fully synchronized with Supabase (0 records remaining).`);
    } else if (failedCount === 0) {
      const stateMsg = isArchiveComplete
        ? 'All records fully archived to Supabase!'
        : `Backlog remaining: ${totalRemaining} (orders: ${ordersRemaining}, events: ${eventsRemaining}, logs: ${rawLogsRemaining}). Drain in progress.`;
      console.log(
        `[SupabaseArchive] Batch pass (${batchStatus}) completed in ${passDuration}ms: ` +
        `orders: ${ordersArchived}, events: ${eventsArchived}, raw logs: ${rawLogsArchived}. ${stateMsg}`
      );
    } else {
      console.info(
        `[SupabaseArchive] Batch pass (${batchStatus}) completed with ${failedCount} notices in ${passDuration}ms: ` +
        `orders: ${ordersArchived}, events: ${eventsArchived}, raw logs: ${rawLogsArchived}. Remaining: ${totalRemaining}`
      );
    }

    // Controlled scheduling with exponential backoff on failure:
    clearScheduledTimers();
    if (status.isEnabled) {
      if (batchStatus === 'FAILED') {
        consecutiveFailures++;
        const backoffMs = calculateExponentialBackoff(consecutiveFailures, 5000, 300000, 2000);
        nextScheduledAttemptAt = new Date(Date.now() + backoffMs).toISOString();
        if (consecutiveFailures <= 2) {
          console.info(`[SupabaseArchive] Backing off next drain pass for ${Math.round(backoffMs / 1000)}s with jitter (consecutive: ${consecutiveFailures}, SQLite data safe).`);
        }
        drainTimer = setTimeout(() => {
          triggerArchivePass().catch(() => {});
        }, backoffMs);
      } else if (totalRemaining > 0) {
        consecutiveFailures = 0;
        nextScheduledAttemptAt = new Date(Date.now() + 6000).toISOString();
        drainTimer = setTimeout(() => {
          triggerArchivePass().catch(() => {});
        }, 6000);
      } else {
        consecutiveFailures = 0;
        nextScheduledAttemptAt = new Date(Date.now() + scheduledIntervalMs).toISOString();
        periodicTimer = setTimeout(() => {
          triggerArchivePass().catch(() => {});
        }, scheduledIntervalMs);
      }
    }

    return {
      success: batchStatus !== 'FAILED',
      ordersArchived,
      eventsArchived,
      rawLogsArchived,
      ordersRemaining,
      eventsRemaining,
      rawLogsRemaining,
      isArchiveComplete,
    };
  } catch (err: any) {
    consecutiveFailures++;
    const backoffMs = calculateExponentialBackoff(consecutiveFailures, 5000, 300000, 2000);
    nextScheduledAttemptAt = new Date(Date.now() + backoffMs).toISOString();
    status.status = consecutiveFailures >= 2 ? 'STANDBY_LOCAL_RETAIN' : 'FAILED';
    status.batchStatus = 'FAILED';
    status.lastError = `Archive notice: ${err.message}`;
    if (consecutiveFailures <= 2) {
      console.info(`[SupabaseArchive Notice]: ${err.message}. Data safely retained in SQLite. Retrying in ${Math.round(backoffMs / 1000)}s.`);
    }

    clearScheduledTimers();
    if (status.isEnabled) {
      drainTimer = setTimeout(() => {
        triggerArchivePass().catch(() => {});
      }, backoffMs);
    }

    return {
      success: false,
      ordersArchived,
      eventsArchived,
      rawLogsArchived,
      ordersRemaining: status.ordersRemaining,
      eventsRemaining: status.eventsRemaining,
      rawLogsRemaining: status.rawLogsRemaining,
      isArchiveComplete: false,
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
  scheduledIntervalMs = intervalSeconds * 1000;
  console.log(`[SupabaseArchive] Background archive worker started (batchSize: ${BATCH_SIZE}, chunkSize: ${CHUNK_SIZE}, periodicInterval: ${intervalSeconds}s)...`);

  // Initial trigger after 30 seconds to let server finish booting
  clearScheduledTimers();
  drainTimer = setTimeout(() => {
    triggerArchivePass().catch(() => {});
  }, 30000);
}

export function stopSupabaseArchiveWorker(): void {
  status.isEnabled = false;
  clearScheduledTimers();
}
