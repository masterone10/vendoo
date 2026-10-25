import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';

const { Pool } = pg;

export interface SupabaseConnectionStatus {
  isConfigured: boolean;
  isConnected: boolean;
  latencyMs: number | null;
  mode: 'SUPABASE_POSTGRES' | 'SQLITE_AWAITING_CONFIG';
  host?: string;
  database?: string;
  missingTables: string[];
  presentTables: string[];
  tableCounts: Record<string, number>;
  canonicalConstraintPresent: boolean;
  error?: string | null;
}

let pool: pg.Pool | null = null;
let poolResetPromise: Promise<void> | null = null;
let lastConnectionCheck: SupabaseConnectionStatus | null = null;
let lastCheckTime = 0;

let poolMetrics = {
  totalAcquires: 0,
  totalReleases: 0,
  totalCreated: 0,
  totalRemoved: 0,
};

export interface QueryContext {
  correlationId?: string;
  operationName?: string;
}

export function getDatabaseUrl(): string | null {
  let url = process.env.DATABASE_URL;
  if (!url || typeof url !== 'string' || url.trim().length === 0 || url.includes('placeholder')) {
    return null;
  }
  url = url.trim();

  // Normalize Supabase pooler from Transaction Mode (port 6543) to Session Mode (port 5432)
  // for persistent backend stability, full session persistence, and elimination of SCRAM auth storms.
  if (url.includes('.pooler.supabase.com:6543')) {
    url = url.replace(/(\.pooler\.supabase\.com):6543/, '$1:5432');
  }

  return url;
}

export function isSupabaseConfigured(): boolean {
  return getDatabaseUrl() !== null;
}

export function getPoolTelemetry() {
  return {
    ...poolMetrics,
    totalCount: pool?.totalCount || 0,
    idleCount: pool?.idleCount || 0,
    waitingCount: pool?.waitingCount || 0,
  };
}

export async function resetSupabasePool(targetPool?: pg.Pool): Promise<void> {
  if (poolResetPromise) {
    return poolResetPromise;
  }

  if (pool && (!targetPool || pool === targetPool)) {
    const old = pool;
    pool = null;
    poolResetPromise = (async () => {
      try {
        await old.end();
      } catch {
        // Ignore errors during broken pool teardown
      } finally {
        poolResetPromise = null;
      }
    })();
    return poolResetPromise;
  }
}

export async function shutdownSupabasePool(): Promise<void> {
  if (pool) {
    const old = pool;
    pool = null;
    try {
      await old.end();
      console.log('[Supabase Client] Shared pool cleanly disconnected.');
    } catch (err: any) {
      console.warn('[Supabase Client] Notice while closing shared pool:', err.message);
    }
  }
}

export function getSupabasePool(): pg.Pool {
  const connStr = getDatabaseUrl();
  if (!connStr) {
    throw new Error('DATABASE_URL is not configured. Please set DATABASE_URL in Google AI Studio Secrets.');
  }

  if (!pool) {
    // 3 connections max as confirmed for single backend process: optimal for Supabase Session Pooler
    pool = new Pool({
      connectionString: connStr,
      ssl: {
        rejectUnauthorized: false,
      },
      max: 3,
      idleTimeoutMillis: 60000, // 60s idle timeout prevents churning sockets
      connectionTimeoutMillis: 20000, // 20s connection timeout for TLS/SCRAM negotiation
      statement_timeout: 30000, // 30s query execution ceiling
      query_timeout: 30000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
      allowExitOnIdle: true,
    });

    const currentPoolInstance = pool;

    currentPoolInstance.on('connect', () => {
      poolMetrics.totalCreated++;
    });

    currentPoolInstance.on('acquire', () => {
      poolMetrics.totalAcquires++;
    });

    currentPoolInstance.on('release', () => {
      poolMetrics.totalReleases++;
    });

    currentPoolInstance.on('remove', () => {
      poolMetrics.totalRemoved++;
    });

    // CRITICAL FIX: When an idle connection is closed by remote pooler/server,
    // pg.Pool automatically removes that specific client. DO NOT destroy the entire pool!
    currentPoolInstance.on('error', (err: any) => {
      const msg = String(err?.message || '');
      const isNormalIdleReap =
        msg.includes('Connection terminated') ||
        msg.includes('closed') ||
        msg.includes('timeout') ||
        msg.includes('ECLIENTSOCKETCLOSED') ||
        (err as any)?.code === '57P01';

      if (!isNormalIdleReap) {
        console.info('[Supabase Pool Notice]', msg);
      }
    });
  }

  return pool;
}

/**
 * Execute a SQL query on Supabase PostgreSQL with timing separation,
 * request correlation ID, and transient connection resilience without pool teardown.
 */
export async function pgQuery<T extends pg.QueryResultRow = any>(
  text: string,
  params: any[] = [],
  context: QueryContext = {}
): Promise<pg.QueryResult<T>> {
  const cid = context.correlationId || `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const opName = context.operationName || 'query';
  let lastErr: any = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const p = getSupabasePool();
    let client: pg.PoolClient | null = null;
    const tStartAcquire = Date.now();

    try {
      client = await p.connect();
      const tWaitMs = Date.now() - tStartAcquire;

      const tStartExec = Date.now();
      const res = await client.query<T>(text, params);
      const tExecMs = Date.now() - tStartExec;

      // Log timing telemetry if duration was notable (> 2500ms)
      if (tWaitMs + tExecMs > 2500) {
        console.info(`[Supabase Query ${cid}] Slow ${opName}: waitPool=${tWaitMs}ms execSql=${tExecMs}ms total=${tWaitMs + tExecMs}ms`);
      }

      client.release();
      client = null;
      return res;
    } catch (err: any) {
      lastErr = err;
      const isTransient =
        err.message?.includes('Connection terminated') ||
        err.message?.includes('timeout') ||
        err.message?.includes('ECONNRESET') ||
        err.message?.includes('ETIMEDOUT') ||
        err.message?.includes('ECLIENTSOCKETCLOSED') ||
        err.code === '57P01';

      if (client) {
        try {
          // Instruct pg.Pool to discard only this faulty socket client, preserving the pool
          client.release(err);
        } catch {}
        client = null;
      }

      if (isTransient && attempt < 2) {
        // Exponential backoff with small random jitter to avoid thundering herd
        const jitterMs = 300 + Math.floor(Math.random() * 400);
        await new Promise((r) => setTimeout(r, jitterMs));
        continue;
      }
      break;
    }
  }

  const isTransient =
    lastErr?.message?.includes('Connection terminated') ||
    lastErr?.message?.includes('timeout') ||
    lastErr?.message?.includes('ECONNRESET') ||
    lastErr?.message?.includes('ETIMEDOUT') ||
    lastErr?.message?.includes('ECLIENTSOCKETCLOSED') ||
    lastErr?.code === '57P01';

  if (isTransient) {
    console.info(`[Supabase Query Notice ${cid}] Standby (${opName}): ${lastErr.message}`);
  } else {
    console.warn(`[Supabase Query Warning ${cid}] ${lastErr.message} (${opName})`);
  }
  throw lastErr;
}

const REQUIRED_TABLES = [
  'orders',
  'order_items',
  'order_status_events',
  'order_status_observations',
  'raw_activity_events',
  'canonical_activity_events',
  'customer_history_observations',
  'address_observations',
  'confirmation_age_observations',
  'alerts',
  'alert_resolution_history',
  'sync_runs',
  'sync_view_runs',
  'sync_page_runs',
  'historical_coverage',
  'daily_snapshots',
  'app_settings',
];

/**
 * Validates Supabase PostgreSQL connectivity and schema completeness
 */
export async function checkSupabaseConnection(forceFresh = false): Promise<SupabaseConnectionStatus> {
  const now = Date.now();
  if (!forceFresh && lastConnectionCheck && now - lastCheckTime < 10000) {
    return lastConnectionCheck;
  }

  const connStr = getDatabaseUrl();
  if (!connStr) {
    lastConnectionCheck = {
      isConfigured: false,
      isConnected: false,
      latencyMs: null,
      mode: 'SQLITE_AWAITING_CONFIG',
      missingTables: REQUIRED_TABLES,
      presentTables: [],
      tableCounts: {},
      canonicalConstraintPresent: false,
      error: 'DATABASE_URL is not configured in Google AI Studio environment or Secrets. Supabase PostgreSQL is required.',
    };
    lastCheckTime = now;
    return lastConnectionCheck;
  }

  const start = Date.now();
  const checkCid = `check_${Date.now()}`;
  try {
    // 1. Ping
    const pingRes = await pgQuery('SELECT current_database() as db, inet_server_addr() as ip, now() as ts', [], {
      correlationId: checkCid,
      operationName: 'health_check_ping',
    });
    const latencyMs = Date.now() - start;
    const dbName = pingRes.rows[0]?.db || 'postgres';
    const serverIp = pingRes.rows[0]?.ip ? String(pingRes.rows[0]?.ip) : undefined;

    // 2. Query tables in public schema
    const tablesRes = await pgQuery(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `, [], { correlationId: checkCid, operationName: 'list_tables' });
    const existingTableNames = new Set(tablesRes.rows.map((r: any) => r.table_name));

    const presentTables: string[] = [];
    const missingTables: string[] = [];

    for (const t of REQUIRED_TABLES) {
      if (existingTableNames.has(t)) {
        presentTables.push(t);
      } else {
        missingTables.push(t);
      }
    }

    // 3. Count rows in present tables
    const tableCounts: Record<string, number> = {};
    for (const t of presentTables) {
      try {
        const countRes = await pgQuery(`SELECT count(*)::int as c FROM "${t}"`, [], {
          correlationId: checkCid,
          operationName: `count_${t}`,
        });
        tableCounts[t] = countRes.rows[0]?.c ?? 0;
      } catch {
        tableCounts[t] = 0;
      }
    }

    // 4. Check for canonical unique constraint on vendoor_id in orders
    let canonicalConstraintPresent = false;
    if (existingTableNames.has('orders')) {
      const constraintRes = await pgQuery(`
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'orders'::regclass AND contype = 'u'
      `, [], { correlationId: checkCid, operationName: 'check_constraint' });
      canonicalConstraintPresent = constraintRes.rows.some((r: any) =>
        r.conname.includes('vendoor_id') || r.conname.includes('orders_vendoor_id')
      );
    }

    lastConnectionCheck = {
      isConfigured: true,
      isConnected: true,
      latencyMs,
      mode: 'SUPABASE_POSTGRES',
      database: dbName,
      host: serverIp,
      missingTables,
      presentTables,
      tableCounts,
      canonicalConstraintPresent,
      error: missingTables.length > 0
        ? `Supabase is connected, but ${missingTables.length} required tables are missing. Please run migration.`
        : null,
    };
    lastCheckTime = now;
    return lastConnectionCheck;
  } catch (err: any) {
    lastConnectionCheck = {
      isConfigured: true,
      isConnected: false,
      latencyMs: null,
      mode: 'SUPABASE_POSTGRES',
      missingTables: REQUIRED_TABLES,
      presentTables: [],
      tableCounts: {},
      canonicalConstraintPresent: false,
      error: `Supabase connection failed: ${err.message}`,
    };
    lastCheckTime = now;
    return lastConnectionCheck;
  }
}

/**
 * Applies the migration SQL directly to the connected Supabase instance
 */
export async function applySupabaseMigration(): Promise<{ success: boolean; message: string; appliedTables: string[] }> {
  const migrationPath = path.resolve(process.cwd(), 'supabase/migrations/20261017000001_create_vendoor_intelligence_schema.sql');

  if (!fs.existsSync(migrationPath)) {
    throw new Error(`Migration file not found at: ${migrationPath}`);
  }

  const sql = fs.readFileSync(migrationPath, 'utf-8');
  await pgQuery(sql, [], { operationName: 'apply_migration' });

  // Re-check schema
  const status = await checkSupabaseConnection(true);
  return {
    success: status.missingTables.length === 0,
    message: status.missingTables.length === 0
      ? 'Migration applied successfully to Supabase PostgreSQL!'
      : `Migration partially applied. Missing tables: ${status.missingTables.join(', ')}`,
    appliedTables: status.presentTables,
  };
}

/**
 * Push all raw and canonical events for a specific business date from SQLite to Supabase,
 * then query Supabase to VERIFY readable persistence.
 */
export async function syncDayLogsToSupabase(dateStr: string): Promise<{
  success: boolean;
  verified: boolean;
  rawSaved: number;
  canonicalSaved: number;
  verifiedRemoteCount: number;
  rawInserted?: number;
  rawIgnored?: number;
  rawFailed?: number;
  canonicalInserted?: number;
  canonicalIgnored?: number;
  canonicalFailed?: number;
  error?: string;
}> {
  if (!isSupabaseConfigured()) {
    return {
      success: false,
      verified: false,
      rawSaved: 0,
      canonicalSaved: 0,
      verifiedRemoteCount: 0,
      error: 'Supabase DATABASE_URL is not configured',
    };
  }

  // CLOUD ARCHIVE POLICY: In accordance with free-tier storage boundaries,
  // logs prior to 2026-10-23 are stored strictly in local SQLite and must NOT be synced to Supabase.
  if (dateStr < '2026-10-23') {
    return {
      success: true,
      verified: true,
      rawSaved: 0,
      canonicalSaved: 0,
      verifiedRemoteCount: 0,
      error: 'CLOUD_ARCHIVE_POLICY: Logs prior to 2026-10-23 remain in local SQLite only',
    };
  }

  const { db, getCairoDateInterval } = await import('./db.ts');
  const interval = getCairoDateInterval(dateStr);

  try {
    const rawRows: any[] = db.prepare(`
      SELECT source_hash, order_code, actor_name, raw_action_text, event_timestamp,
             storage_tier, page_source, vendoor_order_id, raw_html, details_json,
             data_source, import_id
      FROM raw_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ?
    `).all(interval.startCairo, interval.endCairo);

    let rawInserted = 0;
    let rawIgnored = 0;
    let rawFailed = 0;
    for (const r of rawRows) {
      try {
        const res = await pgQuery(`
          INSERT INTO raw_activity_events (
            source_hash, order_code, actor_name, raw_action_text, event_timestamp,
            storage_tier, page_source, is_duplicate
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, false)
          ON CONFLICT (source_hash) DO NOTHING
        `, [
          r.source_hash, r.order_code, r.actor_name, r.raw_action_text,
          r.event_timestamp, r.storage_tier || 'HOT', r.page_source || 'log/system'
        ]);
        if (res.rowCount && res.rowCount > 0) {
          rawInserted++;
        } else {
          rawIgnored++;
        }
      } catch (insertErr: any) {
        rawFailed++;
        console.error(`[Supabase Sync] Failed to insert raw event (${r.source_hash}):`, insertErr.message);
      }
    }

    const canonRows: any[] = db.prepare(`
      SELECT order_code, actor_name, action_type, from_status, to_status,
             event_timestamp, is_system_actor, data_source, import_id
      FROM canonical_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ?
    `).all(interval.startCairo, interval.endCairo);

    let canonicalInserted = 0;
    let canonicalIgnored = 0;
    let canonicalFailed = 0;
    for (const c of canonRows) {
      try {
        const res = await pgQuery(`
          INSERT INTO canonical_activity_events (
            order_code, actor_name, action_type, from_status, to_status,
            event_timestamp, is_system_actor
          )
          SELECT $1, $2, $3, $4, $5, $6, $7
          WHERE NOT EXISTS (
            SELECT 1 FROM canonical_activity_events
            WHERE (order_code IS NOT DISTINCT FROM $1) AND event_timestamp = $6 AND action_type = $3 AND actor_name = $2
          )
        `, [
          c.order_code, c.actor_name, c.action_type || 'action', c.from_status, c.to_status,
          c.event_timestamp, Boolean(c.is_system_actor)
        ]);
        if (res.rowCount && res.rowCount > 0) {
          canonicalInserted++;
        } else {
          canonicalIgnored++;
        }
      } catch (insertErr: any) {
        canonicalFailed++;
        console.error(`[Supabase Sync] Failed to insert canonical event (${c.order_code || 'general'}):`, insertErr.message);
      }
    }

    // Comprehensive Verification: Query both canonical and raw counts directly from Supabase
    const [canonVerifyRes, rawVerifyRes] = await Promise.all([
      pgQuery(`SELECT COUNT(*)::int as c FROM canonical_activity_events WHERE event_timestamp >= $1 AND event_timestamp < $2`, [interval.startCairo, interval.endCairo]),
      pgQuery(`SELECT COUNT(*)::int as c FROM raw_activity_events WHERE event_timestamp >= $1 AND event_timestamp < $2`, [interval.startCairo, interval.endCairo]),
    ]);

    const verifiedRemoteCanonCount = Number(canonVerifyRes.rows[0]?.c || 0);
    const verifiedRemoteRawCount = Number(rawVerifyRes.rows[0]?.c || 0);

    const localCov: any = db.prepare(`
      SELECT completion_status, records_saved FROM historical_coverage
      WHERE period_date = ? AND source_domain = 'logs'
    `).get(dateStr);

    const localHasData = rawRows.length > 0 || canonRows.length > 0;
    // Strict verification: Remote must have all expected local rows, with zero failed writes.
    // If local has 0 rows, only verify as empty if local coverage is authentically complete or verified empty.
    const verified = localHasData
      ? (verifiedRemoteRawCount >= rawRows.length && verifiedRemoteCanonCount >= canonRows.length && rawFailed === 0 && canonicalFailed === 0)
      : Boolean(localCov && (localCov.completion_status === 'EMPTY_VERIFIED' || localCov.completion_status === 'COMPLETE'));

    const nowIso = new Date().toISOString();
    try {
      db.prepare(`
        UPDATE historical_coverage
        SET remote_archive_status = ?,
            last_supabase_verified_at = ?,
            verified_at = ?
        WHERE period_date = ? AND source_domain = 'logs'
      `).run(
        verified ? 'REMOTE_VERIFIED' : 'REMOTE_SYNCED',
        verified ? nowIso : null,
        verified ? nowIso : null,
        dateStr
      );
    } catch {}

    return {
      success: true,
      verified,
      rawSaved: rawInserted + rawIgnored,
      canonicalSaved: canonicalInserted + canonicalIgnored,
      verifiedRemoteCount: verifiedRemoteCanonCount,
      rawInserted,
      rawIgnored,
      rawFailed,
      canonicalInserted,
      canonicalIgnored,
      canonicalFailed,
    };
  } catch (err: any) {
    return {
      success: false,
      verified: false,
      rawSaved: 0,
      canonicalSaved: 0,
      verifiedRemoteCount: 0,
      error: err.message,
    };
  }
}

/**
 * Fetch logs for a given business date from Supabase archive back into local SQLite.
 * Uses strict Africa/Cairo timezone boundaries, streaming pagination for large datasets,
 * and guarantees canonical conversion even when raw records were pre-existing.
 */
export async function fetchDayLogsFromSupabase(
  dateStr: string,
  options?: {
    batchSize?: number;
    maxRecords?: number;
    onProgress?: (restored: number, total: number) => void;
  }
): Promise<{
  success: boolean;
  recordsRestored: number;
  rawRestored: number;
  canonicalRestored: number;
  duplicates: number;
  failedWrites: number;
  error?: string;
}> {
  if (!isSupabaseConfigured()) {
    return {
      success: false,
      recordsRestored: 0,
      rawRestored: 0,
      canonicalRestored: 0,
      duplicates: 0,
      failedWrites: 0,
      error: 'Supabase is not configured',
    };
  }

  const cleanDate = dateStr.trim().slice(0, 10);

  // CLOUD ARCHIVE POLICY: Remote archive begins from 2026-10-23.
  // Days prior to 2026-10-23 are stored locally in SQLite and not queried from remote.
  if (cleanDate < '2026-10-23') {
    return {
      success: true,
      recordsRestored: 0,
      rawRestored: 0,
      canonicalRestored: 0,
      duplicates: 0,
      failedWrites: 0,
    };
  }

  const { db, getCairoDateInterval, saveCoverageRecord } = await import('./db.ts');
  const { parseLogActionDetails } = await import('./logDetailsParser.ts');
  const interval = getCairoDateInterval(cleanDate);
  const batchSize = Math.max(200, Math.min(3000, options?.batchSize || 2000));
  const maxRecords = options?.maxRecords || 100000;

  let totalRawRestored = 0;
  let totalCanonicalRestored = 0;
  let duplicates = 0;
  let failedWrites = 0;
  const nowIso = new Date().toISOString();

  const startTz = `${cleanDate} 00:00:00+03`;
  const endTz = `${interval.nextDateStr} 00:00:00+03`;

  try {
    // 1. Get total count of raw events for this Cairo business date in Supabase
    const countRes = await pgQuery<{ count: string }>(`
      SELECT COUNT(*) as count
      FROM raw_activity_events
      WHERE event_timestamp >= $1::timestamptz AND event_timestamp < $2::timestamptz
    `, [startTz, endTz]);

    const totalInRemote = parseInt(countRes.rows[0]?.count || '0', 10);
    if (totalInRemote === 0) {
      return {
        success: true,
        recordsRestored: 0,
        rawRestored: 0,
        canonicalRestored: 0,
        duplicates: 0,
        failedWrites: 0,
      };
    }

    // Pre-cache orders into memory for lightning-fast O(1) order linking
    const orderMap = new Map<string, number>();
    const allOrders = db.prepare('SELECT id, random_number, order_no, vendoor_id FROM orders').all() as any[];
    for (const o of allOrders) {
      if (o.random_number) orderMap.set(o.random_number.trim(), o.id);
      if (o.order_no) orderMap.set(o.order_no.trim(), o.id);
      if (o.vendoor_id) orderMap.set(String(o.vendoor_id).trim(), o.id);
    }

    // Pre-cache existing local raw events and canonical keys for this interval
    const existingRawHashes = new Map<string, number>();
    const localRaws = db.prepare(`
      SELECT id, source_hash FROM raw_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ?
    `).all(interval.startCairo, interval.endCairo) as any[];
    for (const r of localRaws) {
      existingRawHashes.set(r.source_hash, r.id);
    }

    const existingCanonByRaw = new Set<number>();
    const existingCanonKeys = new Set<string>();
    const localCanons = db.prepare(`
      SELECT raw_event_id, order_code, actor_name, action_type, event_timestamp
      FROM canonical_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ?
    `).all(interval.startCairo, interval.endCairo) as any[];
    for (const c of localCanons) {
      if (c.raw_event_id) existingCanonByRaw.add(c.raw_event_id);
      existingCanonKeys.add(`${c.order_code || ''}::${c.actor_name}::${c.action_type}::${c.event_timestamp}`);
    }

    const insertRaw = db.prepare(`
      INSERT INTO raw_activity_events (
        source_hash, order_code, actor_name, raw_action_text, event_timestamp,
        storage_tier, observed_at, page_source, data_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SUPABASE_ARCHIVE')
      ON CONFLICT(source_hash) DO NOTHING
    `);

    const insertCanon = db.prepare(`
      INSERT INTO canonical_activity_events (
        raw_event_id, order_code, actor_name, action_type, from_status, to_status,
        event_timestamp, storage_tier, is_system_actor, created_at,
        order_id, order_match_status, is_administrative, field_name, old_value, new_value, details_json,
        data_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SUPABASE_ARCHIVE')
    `);

    // Stream/paginate in batches using fast primary key keyset index scan on id
    let lastSeenId = 0;
    let fetchedTotal = 0;
    const fetchLimit = Math.min(totalInRemote, maxRecords);

    while (fetchedTotal < fetchLimit) {
      const currentBatchLimit = Math.min(batchSize, fetchLimit - fetchedTotal);
      const rawRes = await pgQuery<{
        id: number;
        source_hash: string;
        order_code: string | null;
        actor_name: string | null;
        raw_action_text: string | null;
        cairo_event_time: string | null;
        storage_tier: string | null;
        page_source: string | null;
        is_duplicate: boolean | null;
      }>(`
        SELECT id, source_hash, order_code, actor_name, raw_action_text,
               to_char(event_timestamp AT TIME ZONE 'Africa/Cairo', 'YYYY-MM-DD HH24:MI:SS') as cairo_event_time,
               storage_tier, page_source, is_duplicate
        FROM raw_activity_events
        WHERE event_timestamp >= $1::timestamptz 
          AND event_timestamp < $2::timestamptz
          AND id > $3
        ORDER BY id ASC
        LIMIT $4
      `, [startTz, endTz, lastSeenId, currentBatchLimit]);

      if (!rawRes.rows || rawRes.rows.length === 0) break;
      lastSeenId = rawRes.rows[rawRes.rows.length - 1].id;

      db.exec('BEGIN TRANSACTION;');
      try {
        for (const r of rawRes.rows) {
          const eventTime = r.cairo_event_time || interval.startCairo;
          let rawId: number | null = existingRawHashes.get(r.source_hash) || null;

          if (rawId) {
            duplicates++;
          } else {
            try {
              const rawRun = insertRaw.run(
                r.source_hash,
                r.order_code,
                r.actor_name,
                r.raw_action_text,
                eventTime,
                r.storage_tier || 'HOT',
                nowIso,
                r.page_source || 'supabase_archive'
              );

              if (rawRun.changes > 0) {
                rawId = Number(rawRun.lastInsertRowid);
                existingRawHashes.set(r.source_hash, rawId);
                totalRawRestored++;
              } else {
                duplicates++;
              }
            } catch (insertErr: any) {
              if (insertErr?.code === 'SQLITE_CONSTRAINT' || insertErr?.message?.includes('UNIQUE')) {
                duplicates++;
              } else {
                failedWrites++;
                continue;
              }
            }
          }

          // Parse action details
          const parsed = parseLogActionDetails(r.raw_action_text || '', r.actor_name || '', r.order_code || '');
          const detailsJson = JSON.stringify(parsed);
          const canonKey = `${r.order_code || ''}::${r.actor_name || ''}::${parsed.actionType}::${eventTime}`;

          // Check canonical existence in memory (O(1))
          const alreadyHasCanon = (rawId !== null && existingCanonByRaw.has(rawId)) || existingCanonKeys.has(canonKey);

          if (!alreadyHasCanon) {
            const isSystem = (r.actor_name || '').toLowerCase().includes('system') || (r.actor_name || '').includes('النظام') ? 1 : 0;
            let matchedOrderId: number | null = null;
            let matchStatus = 'UNRESOLVED';

            if (!r.order_code) {
              matchStatus = 'GENERAL_LOG';
            } else {
              const trimmedCode = (r.order_code || '').trim();
              const foundId = orderMap.get(trimmedCode);
              if (foundId) {
                matchedOrderId = foundId;
                matchStatus = 'MATCHED';
              }
            }

            try {
              insertCanon.run(
                rawId,
                r.order_code,
                r.actor_name,
                parsed.actionType,
                parsed.fromStatus,
                parsed.toStatus,
                eventTime,
                r.storage_tier || 'HOT',
                isSystem,
                nowIso,
                matchedOrderId,
                matchStatus,
                parsed.isAdministrative ? 1 : 0,
                parsed.fieldName,
                parsed.oldValue,
                parsed.newValue,
                detailsJson
              );
              if (rawId !== null) existingCanonByRaw.add(rawId);
              existingCanonKeys.add(canonKey);
              totalCanonicalRestored++;
            } catch (canonErr: any) {
              if (canonErr?.code !== 'SQLITE_CONSTRAINT' && !canonErr?.message?.includes('UNIQUE')) {
                failedWrites++;
              }
            }
          }
        }
        db.exec('COMMIT;');
      } catch (txErr) {
        try { db.exec('ROLLBACK;'); } catch {}
        throw txErr;
      }

      fetchedTotal += rawRes.rows.length;
      options?.onProgress?.(fetchedTotal, totalInRemote);
    }

    // Update historical_coverage registry
    const finalRawCount = (db.prepare(`
      SELECT COUNT(*) as c FROM raw_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ?
    `).get(interval.startCairo, interval.endCairo) as any)?.c || 0;

    const finalCanonCount = (db.prepare(`
      SELECT COUNT(*) as c FROM canonical_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ?
    `).get(interval.startCairo, interval.endCairo) as any)?.c || 0;

    saveCoverageRecord({
      accountId: 'primary',
      sourceDomain: 'logs',
      periodDate: cleanDate,
      storageTier: 'HOT',
      pagesDiscovered: 1,
      pagesRead: 1,
      recordsExtracted: totalInRemote,
      recordsSaved: finalRawCount,
      completionStatus: 'COMPLETE',
      dataSource: 'SUPABASE_ARCHIVE',
      canonicalEventsCount: finalCanonCount,
      duplicatesCount: duplicates,
      localStorageStatus: 'LOCAL_SAVED',
      remoteArchiveStatus: 'REMOTE_VERIFIED',
      lastAttemptedAt: nowIso,
      completedAt: nowIso,
      verifiedAt: nowIso,
      lastSupabaseVerifiedAt: nowIso,
      notes: `Restored ${totalRawRestored} raw, ${totalCanonicalRestored} canonical from Supabase`,
    });

    return {
      success: true,
      recordsRestored: totalRawRestored + totalCanonicalRestored,
      rawRestored: totalRawRestored,
      canonicalRestored: totalCanonicalRestored,
      duplicates,
      failedWrites,
    };
  } catch (err: any) {
    console.warn(`[SupabaseClient Warning] Error restoring day ${cleanDate}:`, err.message);
    return {
      success: false,
      recordsRestored: 0,
      rawRestored: totalRawRestored,
      canonicalRestored: totalCanonicalRestored,
      duplicates,
      failedWrites,
      error: err.message,
    };
  }
}

/**
 * Restores missing orders from Supabase archive for a list of order codes.
 * Ensures all historical log events link to full order records and metadata.
 */
export async function restoreMissingOrdersFromSupabase(
  orderCodes: string[]
): Promise<{ restored: number; failed: number }> {
  if (!isSupabaseConfigured() || !orderCodes || orderCodes.length === 0) {
    return { restored: 0, failed: 0 };
  }

  const { db } = await import('./db.ts');

  // Filter unique non-empty codes
  const uniqueCodes = Array.from(new Set(orderCodes.map(c => (c || '').trim()).filter(Boolean)));
  if (uniqueCodes.length === 0) return { restored: 0, failed: 0 };

  // Check which ones are already in local SQLite
  const existingSet = new Set<string>();
  for (let i = 0; i < uniqueCodes.length; i += 500) {
    const chunk = uniqueCodes.slice(i, i + 500);
    const existingRows = db.prepare(`
      SELECT random_number FROM orders WHERE random_number IN (${chunk.map(() => '?').join(',')})
    `).all(...chunk) as any[];
    for (const r of existingRows) {
      if (r.random_number) existingSet.add(r.random_number);
    }
  }

  const missingCodes = uniqueCodes.filter(c => !existingSet.has(c));
  if (missingCodes.length === 0) return { restored: 0, failed: 0 };

  const insertOrder = db.prepare(`
    INSERT INTO orders (
      vendoor_id, random_number, order_no, order_type, current_status, status_raw,
      affiliate_code, affiliate_name, affiliate_id, customer_name, customer_phone,
      customer_phone_extra, extra_phone_status, extra_phone_valid, governorate,
      address, address_word_count, address_is_latin, address_quality_status,
      total_price, shipping_cost, total_order, created_at_source, shipping_date,
      printed_date, canceling_date, last_updated_source, distinct_merchant_count,
      multi_merchant_flag, distinct_warehouse_count, multi_warehouse_flag,
      delivery_rate, delivery_rate_num, delivery_rate_denom, cancel_rate,
      cancel_rate_num, cancel_rate_denom, total_customer_orders,
      customer_last_order_status, customer_last_order_elapsed,
      phone_repetition_count, customer_delivery_warning,
      confirmation_age_category, state_entry_at, validation_status,
      storage_tier, last_observed_at, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?
    )
    ON CONFLICT(random_number) DO UPDATE SET
      current_status = excluded.current_status,
      printed_date = COALESCE(orders.printed_date, excluded.printed_date),
      canceling_date = COALESCE(orders.canceling_date, excluded.canceling_date),
      updated_at = excluded.updated_at
  `);

  let restored = 0;
  let failed = 0;
  const CHUNK_SIZE = 400;

  for (let i = 0; i < missingCodes.length; i += CHUNK_SIZE) {
    const chunk = missingCodes.slice(i, i + CHUNK_SIZE);
    try {
      const res = await pgQuery(`
        SELECT * FROM orders
        WHERE random_number = ANY($1) OR order_no = ANY($1)
      `, [chunk]);

      if (res.rows && res.rows.length > 0) {
        db.exec('BEGIN TRANSACTION;');
        for (const row of res.rows) {
          try {
            insertOrder.run(
              row.vendoor_id,
              row.random_number,
              row.order_no,
              row.order_type || 'regular',
              row.current_status || 'New',
              row.status_raw,
              row.affiliate_code,
              row.affiliate_name,
              row.affiliate_id,
              row.customer_name,
              row.customer_phone,
              row.customer_phone_extra,
              row.extra_phone_status || 'NOT_RETRIEVED',
              row.extra_phone_valid || 0,
              row.governorate,
              row.address,
              row.address_word_count,
              row.address_is_latin || 0,
              row.address_quality_status || 'NOT_RETRIEVED',
              row.total_price || 0,
              row.shipping_cost || 0,
              row.total_order || 0,
              row.created_at_source,
              row.shipping_date,
              row.printed_date,
              row.canceling_date,
              row.last_updated_source,
              row.distinct_merchant_count || 1,
              row.multi_merchant_flag || 0,
              row.distinct_warehouse_count || 1,
              row.multi_warehouse_flag || 0,
              row.delivery_rate,
              row.delivery_rate_num,
              row.delivery_rate_denom,
              row.cancel_rate,
              row.cancel_rate_num,
              row.cancel_rate_denom,
              row.total_customer_orders,
              row.customer_last_order_status,
              row.customer_last_order_elapsed,
              row.phone_repetition_count,
              row.customer_delivery_warning,
              row.confirmation_age_category,
              row.state_entry_at,
              row.validation_status || 'VALIDATED_FROM_ARCHIVE',
              row.storage_tier || 'HOT',
              row.last_observed_at || new Date().toISOString(),
              row.created_at || new Date().toISOString(),
              row.updated_at || new Date().toISOString()
            );
            restored++;
          } catch {
            failed++;
          }
        }
        db.exec('COMMIT;');
      }
    } catch (chunkErr) {
      console.warn('[SupabaseClient] Error fetching missing orders chunk:', chunkErr);
      failed += chunk.length;
    }
  }

  return { restored, failed };
}

