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
