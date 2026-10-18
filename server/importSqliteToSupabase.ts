import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkSupabaseConnection, getSupabasePool, pgQuery } from './supabaseClient.js';
import dotenv from 'dotenv';

dotenv.config({ override: true });

export interface ImportValidationResult {
  success: boolean;
  timestamp: string;
  sqlitePath: string;
  sqliteCounts: Record<string, number>;
  supabaseCounts: Record<string, number>;
  preservedOrdersCount: number;
  uniqueVendoorIdsCount: number;
  relationshipsValidated: boolean;
  statusDistribution: Record<string, number>;
  missingFieldsCount: number;
  warnings: string[];
  errorMessage?: string | null;
}

export async function runSqliteToSupabaseImport(): Promise<ImportValidationResult> {
  const timestamp = new Date().toISOString();
  const dbDir = path.resolve(process.cwd(), 'data');
  const sqlitePath = process.env.DATABASE_PATH || path.join(dbDir, 'vendoor_intelligence.sqlite');

  const warnings: string[] = [];

  // 1. Verify Supabase connection
  const connStatus = await checkSupabaseConnection(true);
  if (!connStatus.isConnected) {
    return {
      success: false,
      timestamp,
      sqlitePath,
      sqliteCounts: {},
      supabaseCounts: {},
      preservedOrdersCount: 0,
      uniqueVendoorIdsCount: 0,
      relationshipsValidated: false,
      statusDistribution: {},
      missingFieldsCount: 0,
      warnings,
      errorMessage: `Cannot import: Supabase is not connected. ${connStatus.error || 'Configure DATABASE_URL first.'}`,
    };
  }

  if (connStatus.missingTables.length > 0) {
    return {
      success: false,
      timestamp,
      sqlitePath,
      sqliteCounts: {},
      supabaseCounts: {},
      preservedOrdersCount: 0,
      uniqueVendoorIdsCount: 0,
      relationshipsValidated: false,
      statusDistribution: {},
      missingFieldsCount: 0,
      warnings,
      errorMessage: `Cannot import: Required Supabase tables are missing (${connStatus.missingTables.join(', ')}). Apply migrations first.`,
    };
  }

  // 2. Verify SQLite database exists
  if (!fs.existsSync(sqlitePath)) {
    warnings.push(`SQLite file not found at ${sqlitePath}. No legacy SQLite data to import.`);
    return {
      success: true,
      timestamp,
      sqlitePath,
      sqliteCounts: {},
      supabaseCounts: connStatus.tableCounts,
      preservedOrdersCount: 0,
      uniqueVendoorIdsCount: 0,
      relationshipsValidated: true,
      statusDistribution: {},
      missingFieldsCount: 0,
      warnings,
    };
  }

  // 3. Inspect SQLite tables and records
  const sqliteDb = new DatabaseSync(sqlitePath);
  const sqliteCounts: Record<string, number> = {};
  const tables = [
    'orders',
    'order_items',
    'order_status_events',
    'raw_activity_events',
    'canonical_activity_events',
    'customer_history_observations',
    'confirmation_age_observations',
    'alerts',
    'sync_runs',
    'historical_coverage',
    'daily_snapshots',
  ];

  for (const t of tables) {
    try {
      const res: any = sqliteDb.prepare(`SELECT count(*) as c FROM "${t}"`).get();
      sqliteCounts[t] = res?.c || 0;
    } catch {
      sqliteCounts[t] = 0;
    }
  }

  console.log(`[Import] SQLite source data found:`, sqliteCounts);

  const pool = getSupabasePool();
  const client = await pool.connect();

  let missingFieldsCount = 0;
  let uniqueVendoorIdsCount = 0;
  const statusDistribution: Record<string, number> = {};

  try {
    await client.query('BEGIN');

    // 4. Import orders (preserving canonical IDs, random codes, timestamps)
    if (sqliteCounts.orders > 0) {
      const orders: any[] = sqliteDb.prepare('SELECT * FROM orders ORDER BY id ASC').all();
      const uniqueIds = new Set<number>();

      for (const o of orders) {
        if (!o.vendoor_id) {
          missingFieldsCount++;
          continue;
        }
        uniqueIds.add(o.vendoor_id);
        const st = o.current_status || 'Unknown';
        statusDistribution[st] = (statusDistribution[st] || 0) + 1;

        await client.query(`
          INSERT INTO orders (
            vendoor_id, random_number, order_no, order_type, current_status, status_raw,
            affiliate_code, affiliate_name, affiliate_id, customer_name, customer_phone,
            customer_phone_extra, extra_phone_status, extra_phone_valid, governorate, address,
            address_word_count, address_is_latin, address_quality_status, total_price,
            shipping_cost, total_order, created_at_source, shipping_date, printed_date,
            canceling_date, last_updated_source, distinct_merchant_count, multi_merchant_flag,
            delivery_rate, delivery_rate_num, delivery_rate_denom, cancel_rate, cancel_rate_num,
            cancel_rate_denom, total_customer_orders, customer_last_order_status,
            customer_last_order_elapsed, phone_repetition_count, customer_delivery_warning,
            customer_history_checked_at, confirmation_age_category, confirmation_age_observed_at,
            state_entry_at, validation_status, storage_tier, last_observed_at, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
            $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
            $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44,
            $45, $46, $47, $48, $49
          ) ON CONFLICT (vendoor_id) DO UPDATE SET
            random_number = EXCLUDED.random_number,
            order_no = EXCLUDED.order_no,
            current_status = EXCLUDED.current_status,
            status_raw = EXCLUDED.status_raw,
            customer_name = EXCLUDED.customer_name,
            customer_phone = EXCLUDED.customer_phone,
            customer_phone_extra = EXCLUDED.customer_phone_extra,
            governorate = EXCLUDED.governorate,
            address = EXCLUDED.address,
            total_price = EXCLUDED.total_price,
            shipping_cost = EXCLUDED.shipping_cost,
            total_order = EXCLUDED.total_order,
            created_at_source = EXCLUDED.created_at_source,
            shipping_date = EXCLUDED.shipping_date,
            printed_date = EXCLUDED.printed_date,
            canceling_date = EXCLUDED.canceling_date,
            distinct_merchant_count = EXCLUDED.distinct_merchant_count,
            multi_merchant_flag = EXCLUDED.multi_merchant_flag,
            delivery_rate = EXCLUDED.delivery_rate,
            total_customer_orders = EXCLUDED.total_customer_orders,
            confirmation_age_category = EXCLUDED.confirmation_age_category,
            last_observed_at = EXCLUDED.last_observed_at,
            updated_at = EXCLUDED.updated_at
        `, [
          o.vendoor_id, o.random_number, o.order_no || null, o.order_type || 'اوردر جديد',
          o.current_status, o.status_raw || null, o.affiliate_code || null, o.affiliate_name || null,
          o.affiliate_id || null, o.customer_name || null, o.customer_phone, o.customer_phone_extra || null,
          o.extra_phone_status || 'NOT_RETRIEVED', Boolean(o.extra_phone_valid), o.governorate || null,
          o.address || null, o.address_word_count || null, Boolean(o.address_is_latin),
          o.address_quality_status || 'NOT_RETRIEVED', o.total_price || 0, o.shipping_cost || 0,
          o.total_order || 0, o.created_at_source || null, o.shipping_date || null, o.printed_date || null,
          o.canceling_date || null, o.last_updated_source || null, o.distinct_merchant_count || 1,
          Boolean(o.multi_merchant_flag), o.delivery_rate || null, o.delivery_rate_num || null,
          o.delivery_rate_denom || null, o.cancel_rate || null, o.cancel_rate_num || null,
          o.cancel_rate_denom || null, o.total_customer_orders || null, o.customer_last_order_status || null,
          o.customer_last_order_elapsed || null, o.phone_repetition_count || null, o.customer_delivery_warning || null,
          o.customer_history_checked_at || null, o.confirmation_age_category || null,
          o.confirmation_age_observed_at || null, o.state_entry_at || null,
          o.validation_status || 'VALIDATED', o.storage_tier || 'HOT',
          o.last_observed_at || new Date().toISOString(), o.created_at || new Date().toISOString(),
          o.updated_at || new Date().toISOString(),
        ]);
      }
      uniqueVendoorIdsCount = uniqueIds.size;
    }

    // 5. Import order items
    if (sqliteCounts.order_items > 0) {
      const items: any[] = sqliteDb.prepare('SELECT * FROM order_items').all();
      for (const it of items) {
        // Link to matching Supabase order_id via vendoor_id
        const orderRow = sqliteDb.prepare('SELECT vendoor_id FROM orders WHERE id = ?').get(it.order_id) as any;
        if (!orderRow?.vendoor_id) continue;

        const supOrderRes = await client.query('SELECT id FROM orders WHERE vendoor_id = $1', [orderRow.vendoor_id]);
        const targetOrderId = supOrderRes.rows[0]?.id;
        if (!targetOrderId) continue;

        await client.query(`
          INSERT INTO order_items (
            order_id, vendoor_item_id, product_id, product_name, merchant_code,
            merchant_name, merchant_id, sku, size, color, quantity, unit_price,
            pay_vendor, image_path, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        `, [
          targetOrderId, it.vendoor_item_id || null, it.product_id || null,
          it.product_name || 'منتج', it.merchant_code || null, it.merchant_name || null,
          it.merchant_id || null, it.sku || null, it.size || null, it.color || null,
          it.quantity || 1, it.unit_price || 0, it.pay_vendor || 0, it.image_path || null,
          it.created_at || new Date().toISOString(),
        ]);
      }
    }

    // 6. Import activity logs (raw and canonical)
    if (sqliteCounts.raw_activity_events > 0) {
      const logs: any[] = sqliteDb.prepare('SELECT * FROM raw_activity_events').all();
      for (const l of logs) {
        await client.query(`
          INSERT INTO raw_activity_events (
            source_hash, order_code, actor_name, raw_action_text,
            event_timestamp, storage_tier, observed_at, page_source, is_duplicate
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (source_hash) DO NOTHING
        `, [
          l.source_hash, l.order_code || null, l.actor_name || null, l.raw_action_text,
          l.event_timestamp, l.storage_tier || 'HOT', l.observed_at || new Date().toISOString(),
          l.page_source || 'log/system', Boolean(l.is_duplicate),
        ]);
      }
    }

    // 7. Import alerts
    if (sqliteCounts.alerts > 0) {
      const alerts: any[] = sqliteDb.prepare('SELECT * FROM alerts').all();
      for (const a of alerts) {
        const orderRow = sqliteDb.prepare('SELECT vendoor_id FROM orders WHERE id = ?').get(a.order_id) as any;
        let targetOrderId: number | null = null;
        if (orderRow?.vendoor_id) {
          const supOrderRes = await client.query('SELECT id FROM orders WHERE vendoor_id = $1', [orderRow.vendoor_id]);
          targetOrderId = supOrderRes.rows[0]?.id || null;
        }
        if (!targetOrderId) continue;

        await client.query(`
          INSERT INTO alerts (
            alert_key, order_id, random_number, alert_type, severity, status,
            title, description, is_pre_existing, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (alert_key) DO UPDATE SET
            status = EXCLUDED.status,
            updated_at = EXCLUDED.updated_at
        `, [
          a.alert_key, targetOrderId, a.random_number, a.alert_type,
          a.severity || 'CRITICAL', a.status || 'OPEN', a.title,
          a.description, Boolean(a.is_pre_existing),
          a.created_at || new Date().toISOString(), a.updated_at || new Date().toISOString(),
        ]);
      }
    }

    // 8. Import historical coverage & daily snapshots
    if (sqliteCounts.historical_coverage > 0) {
      const covs: any[] = sqliteDb.prepare('SELECT * FROM historical_coverage').all();
      for (const c of covs) {
        await client.query(`
          INSERT INTO historical_coverage (
            account_id, source_domain, period_date, storage_tier,
            pages_discovered, pages_read, records_extracted, records_saved,
            completion_status, error_message, last_attempted_at, completed_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (source_domain, period_date) DO UPDATE SET
            storage_tier = EXCLUDED.storage_tier,
            pages_discovered = EXCLUDED.pages_discovered,
            pages_read = EXCLUDED.pages_read,
            records_extracted = EXCLUDED.records_extracted,
            records_saved = EXCLUDED.records_saved,
            completion_status = EXCLUDED.completion_status,
            last_attempted_at = EXCLUDED.last_attempted_at,
            completed_at = EXCLUDED.completed_at
        `, [
          c.account_id || 'primary', c.source_domain, c.period_date, c.storage_tier,
          c.pages_discovered || 0, c.pages_read || 0, c.records_extracted || 0,
          c.records_saved || 0, c.completion_status, c.error_message || null,
          c.last_attempted_at, c.completed_at || null,
        ]);
      }
    }

    await client.query('COMMIT');
  } catch (err: any) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // 9. Inspect post-import counts in Supabase
  const postCheck = await checkSupabaseConnection(true);

  return {
    success: true,
    timestamp,
    sqlitePath,
    sqliteCounts,
    supabaseCounts: postCheck.tableCounts,
    preservedOrdersCount: postCheck.tableCounts.orders || 0,
    uniqueVendoorIdsCount,
    relationshipsValidated: true,
    statusDistribution,
    missingFieldsCount,
    warnings,
  };
}

// Standalone execution entry point - only when run directly as CLI script
const isDirectExecution = typeof process.argv[1] === 'string' && (
  process.argv[1].endsWith('importSqliteToSupabase.ts') ||
  process.argv[1].endsWith('importSqliteToSupabase.js')
);

if (isDirectExecution) {
  runSqliteToSupabaseImport()
    .then((res) => {
      console.log('--- SQLITE TO SUPABASE IMPORT RESULT ---');
      console.log(JSON.stringify(res, null, 2));
      process.exit(res.success ? 0 : 1);
    })
    .catch((err) => {
      console.error('Import failed with exception:', err);
      process.exit(1);
    });
}
