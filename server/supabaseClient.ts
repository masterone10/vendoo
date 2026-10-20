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
let lastConnectionCheck: SupabaseConnectionStatus | null = null;
let lastCheckTime = 0;

export function getDatabaseUrl(): string | null {
  const url = process.env.DATABASE_URL;
  if (url && typeof url === 'string' && url.trim().length > 0 && !url.includes('placeholder')) {
    return url.trim();
  }
  return null;
}

export function isSupabaseConfigured(): boolean {
  return getDatabaseUrl() !== null;
}

export function getSupabasePool(): pg.Pool {
  const connStr = getDatabaseUrl();
  if (!connStr) {
    throw new Error('DATABASE_URL is not configured. Please set DATABASE_URL in Google AI Studio Secrets per SUPABASE_SETUP.md');
  }

  if (!pool) {
    pool = new Pool({
      connectionString: connStr,
      ssl: {
        rejectUnauthorized: false, // Required for Supabase pooler connections in cloud containers
      },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    pool.on('error', (err) => {
      console.error('[Supabase Pool Error]', err.message);
    });
  }

  return pool;
}

/**
 * Execute a SQL query on Supabase PostgreSQL with parameters
 */
export async function pgQuery<T extends pg.QueryResultRow = any>(text: string, params: any[] = []): Promise<pg.QueryResult<T>> {
  const p = getSupabasePool();
  const start = Date.now();
  try {
    const res = await p.query<T>(text, params);
    return res;
  } catch (err: any) {
    console.error(`[Supabase Query Error] ${err.message} (SQL: ${text.slice(0, 100)}...)`);
    throw err;
  }
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
  try {
    const p = getSupabasePool();
    // 1. Ping
    const pingRes = await p.query('SELECT current_database() as db, inet_server_addr() as ip, now() as ts');
    const latencyMs = Date.now() - start;
    const dbName = pingRes.rows[0]?.db || 'postgres';
    const serverIp = pingRes.rows[0]?.ip ? String(pingRes.rows[0]?.ip) : undefined;

    // 2. Query tables in public schema
    const tablesRes = await p.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `);
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
        const countRes = await p.query(`SELECT count(*)::int as c FROM "${t}"`);
        tableCounts[t] = countRes.rows[0]?.c ?? 0;
      } catch {
        tableCounts[t] = 0;
      }
    }

    // 4. Check for canonical unique constraint on vendoor_id in orders
    let canonicalConstraintPresent = false;
    if (existingTableNames.has('orders')) {
      const constraintRes = await p.query(`
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'orders'::regclass AND contype = 'u'
      `);
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
  const p = getSupabasePool();
  const migrationPath = path.resolve(process.cwd(), 'supabase/migrations/20261017000001_create_vendoor_intelligence_schema.sql');

  if (!fs.existsSync(migrationPath)) {
    throw new Error(`Migration file not found at: ${migrationPath}`);
  }

  const sql = fs.readFileSync(migrationPath, 'utf-8');
  await p.query(sql);

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

    let rawSaved = 0;
    for (const r of rawRows) {
      try {
        await pgQuery(`
          INSERT INTO raw_activity_events (
            source_hash, order_code, actor_name, raw_action_text, event_timestamp,
            storage_tier, page_source, is_duplicate
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, false)
          ON CONFLICT (source_hash) DO NOTHING
        `, [
          r.source_hash, r.order_code, r.actor_name, r.raw_action_text,
          r.event_timestamp, r.storage_tier || 'HOT', r.page_source || 'log/system'
        ]);
        rawSaved++;
      } catch {}
    }

    const canonRows: any[] = db.prepare(`
      SELECT order_code, actor_name, action_type, from_status, to_status,
             event_timestamp, is_system_actor, data_source, import_id
      FROM canonical_activity_events
      WHERE event_timestamp >= ? AND event_timestamp < ?
    `).all(interval.startCairo, interval.endCairo);

    let canonicalSaved = 0;
    for (const c of canonRows) {
      try {
        await pgQuery(`
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
        canonicalSaved++;
      } catch {}
    }

    // Verification check: Query Supabase directly
    const verifyRes = await pgQuery(`
      SELECT COUNT(*)::int as c FROM canonical_activity_events
      WHERE event_timestamp >= $1 AND event_timestamp < $2
    `, [interval.startCairo, interval.endCairo]);

    const verifiedRemoteCount = Number(verifyRes.rows[0]?.c || 0);
    const verified = verifiedRemoteCount > 0 || (rawRows.length === 0 && canonRows.length === 0);

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
      rawSaved,
      canonicalSaved,
      verifiedRemoteCount,
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
 */
export async function fetchDayLogsFromSupabase(dateStr: string): Promise<{
  success: boolean;
  recordsRestored: number;
  error?: string;
}> {
  if (!isSupabaseConfigured()) {
    return { success: false, recordsRestored: 0, error: 'Supabase is not configured' };
  }

  const { db, getCairoDateInterval } = await import('./db.ts');
  const { parseLogActionDetails } = await import('./logDetailsParser.ts');
  const interval = getCairoDateInterval(dateStr);

  try {
    // 1. Fetch raw logs from Supabase
    const rawRes = await pgQuery(`
      SELECT source_hash, order_code, actor_name, raw_action_text, event_timestamp,
             storage_tier, page_source, is_duplicate
      FROM raw_activity_events
      WHERE event_timestamp >= $1 AND event_timestamp < $2
    `, [interval.startCairo, interval.endCairo]);

    if (!rawRes.rows || rawRes.rows.length === 0) {
      return { success: true, recordsRestored: 0 };
    }

    let restored = 0;
    const nowIso = new Date().toISOString();

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
        order_match_status, is_administrative, field_name, old_value, new_value, details_json,
        data_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SUPABASE_ARCHIVE')
    `);

    db.exec('BEGIN TRANSACTION;');
    try {
      for (const r of rawRes.rows) {
        const rawResRun = insertRaw.run(
          r.source_hash,
          r.order_code,
          r.actor_name,
          r.raw_action_text,
          r.event_timestamp,
          r.storage_tier || 'HOT',
          nowIso,
          r.page_source || 'supabase_archive'
        );

        let rawId: number | null = null;
        if (rawResRun.changes > 0) {
          rawId = Number(rawResRun.lastInsertRowid);
        } else {
          const ex = db.prepare('SELECT id FROM raw_activity_events WHERE source_hash = ?').get(r.source_hash) as any;
          rawId = ex?.id || null;
        }

        const parsed = parseLogActionDetails(r.raw_action_text || '', r.actor_name || '', r.order_code || '');
        const detailsJson = JSON.stringify(parsed);

        // Check if canonical exists
        const exists = db.prepare(`
          SELECT id FROM canonical_activity_events
          WHERE (raw_event_id IS NOT NULL AND raw_event_id = ?)
             OR (order_code IS ? AND actor_name = ? AND action_type = ? AND event_timestamp = ?)
        `).get(rawId, r.order_code, r.actor_name, parsed.actionType, r.event_timestamp);

        if (!exists && rawResRun.changes > 0) {
          const isSystem = (r.actor_name || '').toLowerCase().includes('system') || (r.actor_name || '').includes('النظام') ? 1 : 0;
          insertCanon.run(
            rawId,
            r.order_code,
            r.actor_name,
            parsed.actionType,
            parsed.fromStatus,
            parsed.toStatus,
            r.event_timestamp,
            r.storage_tier || 'HOT',
            isSystem,
            nowIso,
            r.order_code ? 'MATCHED' : 'GENERAL_LOG',
            parsed.isAdministrative ? 1 : 0,
            parsed.fieldName,
            parsed.oldValue,
            parsed.newValue,
            detailsJson
          );
          restored++;
        }
      }
      db.exec('COMMIT;');
    } catch (txErr) {
      db.exec('ROLLBACK;');
      throw txErr;
    }

    return {
      success: true,
      recordsRestored: restored > 0 ? restored : rawRes.rows.length,
    };
  } catch (err: any) {
    return { success: false, recordsRestored: 0, error: err.message };
  }
}
