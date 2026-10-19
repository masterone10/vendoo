import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { parseLogActionDetails } from './logDetailsParser.js';

const DB_DIR = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const rawEnvDbPath = process.env.DATABASE_PATH;
export const DB_PATH = (rawEnvDbPath && rawEnvDbPath !== 'false' && rawEnvDbPath !== 'undefined')
  ? rawEnvDbPath
  : path.join(DB_DIR, 'vendoor_intelligence.sqlite');

export const db = new DatabaseSync(DB_PATH);

/**
 * Return YYYY-MM-DD for a given Date in Africa/Cairo timezone
 */
export function getCairoDateString(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Returns interval [startCairo, endCairo) for a YYYY-MM-DD date in Africa/Cairo
 */
export function getCairoDateInterval(dateStr: string): { startCairo: string; endCairo: string; nextDateStr: string } {
  const cleanDate = (dateStr || getCairoDateString()).slice(0, 10);
  const [year, month, day] = cleanDate.split('-').map(Number);
  const nextDate = new Date(Date.UTC(year, month - 1, day + 1));
  const nextDateStr = nextDate.toISOString().slice(0, 10);
  return {
    startCairo: `${cleanDate} 00:00:00`,
    endCairo: `${nextDateStr} 00:00:00`,
    nextDateStr,
  };
}

/**
 * Returns the threshold date (YYYY-MM-DD) for HOT vs COLD tier.
 * HOT = Today + 29 preceding calendar days (30 calendar days total window) in Africa/Cairo.
 */
export function getHotThresholdDate(refDate: Date = new Date()): string {
  const cairoToday = getCairoDateString(refDate);
  const [year, month, day] = cairoToday.split('-').map(Number);
  // Subtract 29 calendar days from midnight Cairo date
  const thresholdTime = Date.UTC(year, month - 1, day) - 29 * 24 * 60 * 60 * 1000;
  return new Date(thresholdTime).toISOString().slice(0, 10);
}

/**
 * Check if a date (YYYY-MM-DD or ISO string) falls into HOT window (last 30 calendar days including today in Africa/Cairo).
 */
export function isDateInHot(dateStr: string, refDate: Date = new Date()): boolean {
  if (!dateStr) return true;
  const cleanDate = dateStr.slice(0, 10);
  const threshold = getHotThresholdDate(refDate);
  return cleanDate >= threshold;
}

export interface HistoricalCoverageRecord {
  id?: number;
  accountId?: string;
  sourceDomain: 'logs' | 'orders' | 'confirmation_ages' | 'customer_intel';
  periodDate: string; // YYYY-MM-DD
  storageTier: 'HOT' | 'COLD';
  pagesDiscovered: number;
  pagesRead: number;
  recordsExtracted: number;
  recordsSaved: number;
  completionStatus: 'NOT_SYNCED' | 'IN_PROGRESS' | 'PARTIAL' | 'COMPLETE' | 'FAILED';
  errorMessage?: string | null;
  lastAttemptedAt: string;
  completedAt?: string | null;
}

// Initialize database pragmas, tables, and migrations
export function initDatabase() {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  // 1. Create tables if they do not exist
  db.exec(`
    -- Orders table: Authoritative single record per order
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendoor_id INTEGER UNIQUE NOT NULL,
      random_number TEXT NOT NULL UNIQUE,
      order_no TEXT,
      order_type TEXT DEFAULT 'اوردر جديد',
      current_status TEXT NOT NULL,
      status_raw TEXT,
      affiliate_code TEXT,
      affiliate_name TEXT,
      affiliate_id INTEGER,
      customer_name TEXT,
      customer_phone TEXT NOT NULL,
      customer_phone_extra TEXT,
      extra_phone_valid INTEGER DEFAULT 0,
      governorate TEXT,
      address TEXT,
      total_price REAL DEFAULT 0,
      shipping_cost REAL DEFAULT 0,
      total_order REAL DEFAULT 0,
      created_at_source TEXT,
      shipping_date TEXT,
      printed_date TEXT,
      last_updated_source TEXT,
      distinct_merchant_count INTEGER DEFAULT 1,
      multi_merchant_flag INTEGER DEFAULT 0,
      delivery_rate REAL,
      delivery_rate_num INTEGER,
      delivery_rate_denom INTEGER,
      cancel_rate REAL,
      cancel_rate_num INTEGER,
      cancel_rate_denom INTEGER,
      total_customer_orders INTEGER,
      customer_last_order_status TEXT,
      customer_last_order_elapsed TEXT,
      phone_repetition_count INTEGER,
      customer_delivery_warning TEXT,
      customer_history_checked_at TEXT,
      confirmation_age_category TEXT,
      confirmation_age_observed_at TEXT,
      state_entry_at TEXT,
      validation_status TEXT DEFAULT 'PENDING_VALIDATION',
      storage_tier TEXT DEFAULT 'HOT',
      last_observed_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Order items: Multi-product line items linked to order
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      vendoor_item_id INTEGER,
      product_id INTEGER,
      product_name TEXT NOT NULL,
      merchant_code TEXT,
      merchant_name TEXT,
      warehouse_name TEXT,
      warehouse_code TEXT,
      code_source TEXT DEFAULT 'VENDOOR_SOURCE',
      merchant_id TEXT,
      sku TEXT,
      size TEXT,
      color TEXT,
      quantity INTEGER DEFAULT 1,
      unit_price REAL DEFAULT 0,
      pay_vendor REAL DEFAULT 0,
      image_path TEXT,
      raw_json TEXT,
      created_at TEXT NOT NULL
    );

    -- Order status transitions timeline
    CREATE TABLE IF NOT EXISTS order_status_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      random_number TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      actor_name TEXT DEFAULT 'النظام',
      event_time_source TEXT,
      storage_tier TEXT DEFAULT 'HOT',
      observed_at TEXT NOT NULL,
      source_channel TEXT NOT NULL,
      raw_activity_id INTEGER
    );

    -- Raw activity logs from Vendoor system logs
    CREATE TABLE IF NOT EXISTS raw_activity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_hash TEXT UNIQUE NOT NULL,
      order_code TEXT,
      actor_name TEXT,
      raw_action_text TEXT NOT NULL,
      event_timestamp TEXT NOT NULL,
      storage_tier TEXT DEFAULT 'HOT',
      observed_at TEXT NOT NULL,
      page_source TEXT DEFAULT 'log/system',
      is_duplicate INTEGER DEFAULT 0,
      vendoor_order_id INTEGER,
      raw_html TEXT,
      details_json TEXT,
      field_name TEXT,
      old_value TEXT,
      new_value TEXT
    );

    -- Canonical events for employee metrics & deduplicated audit
    CREATE TABLE IF NOT EXISTS canonical_activity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_event_id INTEGER REFERENCES raw_activity_events(id) ON DELETE SET NULL,
      order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
      order_code TEXT,
      actor_name TEXT NOT NULL,
      action_type TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      field_name TEXT,
      old_value TEXT,
      new_value TEXT,
      details_json TEXT,
      order_match_status TEXT DEFAULT 'UNRESOLVED',
      is_administrative INTEGER DEFAULT 0,
      event_timestamp TEXT NOT NULL,
      storage_tier TEXT DEFAULT 'HOT',
      is_system_actor INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    -- Customer History Observations (Auditable snapshot per read)
    CREATE TABLE IF NOT EXISTS customer_history_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
      phone TEXT NOT NULL,
      total_orders INTEGER,
      deliveries_num INTEGER,
      deliveries_denom INTEGER,
      delivery_rate REAL,
      cancels_num INTEGER,
      cancels_denom INTEGER,
      cancel_rate REAL,
      repetitions_count INTEGER,
      last_order_status TEXT,
      last_order_elapsed TEXT,
      warning_text TEXT,
      storage_tier TEXT DEFAULT 'HOT',
      observed_at TEXT NOT NULL
    );

    -- Confirmation Age Observations
    CREATE TABLE IF NOT EXISTS confirmation_age_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
      random_number TEXT NOT NULL,
      age_category TEXT NOT NULL,
      invoice_no TEXT,
      printed_date TEXT,
      storage_tier TEXT DEFAULT 'HOT',
      observed_at TEXT NOT NULL
    );

    -- Alerts table (Critical Multi-Merchant Engine, etc.)
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_key TEXT UNIQUE NOT NULL,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      random_number TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'CRITICAL',
      status TEXT NOT NULL DEFAULT 'OPEN',
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      details_json TEXT,
      is_pre_existing INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      resolution_notes TEXT
    );

    -- Synchronization Runs Tracking
    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_type TEXT NOT NULL,
      status TEXT NOT NULL,
      orders_scanned INTEGER DEFAULT 0,
      orders_created INTEGER DEFAULT 0,
      orders_updated INTEGER DEFAULT 0,
      events_detected INTEGER DEFAULT 0,
      alerts_triggered INTEGER DEFAULT 0,
      errors_count INTEGER DEFAULT 0,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      error_message TEXT
    );

    -- Data Quality & Reconciliation Issues
    CREATE TABLE IF NOT EXISTS data_quality_issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      description TEXT NOT NULL,
      raw_payload TEXT,
      status TEXT DEFAULT 'OPEN',
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    -- Historical Coverage Registry: Tracks coverage status per date and source domain
    CREATE TABLE IF NOT EXISTS historical_coverage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT DEFAULT 'primary',
      source_domain TEXT NOT NULL,
      period_date TEXT NOT NULL,
      storage_tier TEXT NOT NULL,
      pages_discovered INTEGER DEFAULT 0,
      pages_read INTEGER DEFAULT 0,
      records_extracted INTEGER DEFAULT 0,
      records_saved INTEGER DEFAULT 0,
      completion_status TEXT NOT NULL,
      error_message TEXT,
      last_attempted_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(source_domain, period_date)
    );

    -- Immutable / Versioned Daily Snapshots for Historical Consistency
    CREATE TABLE IF NOT EXISTS daily_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_date TEXT UNIQUE NOT NULL,
      storage_tier TEXT NOT NULL DEFAULT 'HOT',
      new_count INTEGER DEFAULT 0,
      pending_count INTEGER DEFAULT 0,
      processing_count INTEGER DEFAULT 0,
      canceling_count INTEGER DEFAULT 0,
      printed_count INTEGER DEFAULT 0,
      canceled_count INTEGER DEFAULT 0,
      total_orders INTEGER DEFAULT 0,
      created_today INTEGER DEFAULT 0,
      printed_today INTEGER DEFAULT 0,
      pending_today INTEGER DEFAULT 0,
      processing_today INTEGER DEFAULT 0,
      canceling_today INTEGER DEFAULT 0,
      canceled_today INTEGER DEFAULT 0,
      multi_merchant_printed INTEGER DEFAULT 0,
      missing_extra_phone_printed INTEGER DEFAULT 0,
      low_delivery_rate_printed INTEGER DEFAULT 0,
      snapshot_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Archive checkpoints for Supabase cursor/pagination tracking
    CREATE TABLE IF NOT EXISTS archive_checkpoints (
      entity_type TEXT PRIMARY KEY,
      last_archived_id INTEGER DEFAULT 0,
      last_archived_at TEXT,
      total_archived INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    -- Dedicated Merchant Code Mappings table
    CREATE TABLE IF NOT EXISTS merchant_code_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      merchant_code TEXT NOT NULL,
      merchant_name TEXT,
      source_sheet_name TEXT,
      excel_row_index INTEGER,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(merchant_code, source_sheet_name)
    );
  `);

  // 2. Run soft schema migrations for existing database columns before creating indexes
  tryRunMigration("ALTER TABLE historical_coverage ADD COLUMN verified_at TEXT");
  tryRunMigration("ALTER TABLE orders ADD COLUMN validation_status TEXT DEFAULT 'PENDING_VALIDATION'");
  tryRunMigration("ALTER TABLE orders ADD COLUMN storage_tier TEXT DEFAULT 'HOT'");
  tryRunMigration("ALTER TABLE orders ADD COLUMN canceling_date TEXT");
  tryRunMigration("ALTER TABLE orders ADD COLUMN extra_phone_status TEXT DEFAULT 'NOT_RETRIEVED'");
  tryRunMigration("ALTER TABLE orders ADD COLUMN address_word_count INTEGER");
  tryRunMigration("ALTER TABLE orders ADD COLUMN address_is_latin INTEGER DEFAULT 0");
  tryRunMigration("ALTER TABLE orders ADD COLUMN address_quality_status TEXT DEFAULT 'NOT_RETRIEVED'");
  tryRunMigration("ALTER TABLE orders ADD COLUMN last_enrichment_at TEXT");
  tryRunMigration("ALTER TABLE orders ADD COLUMN last_enrichment_status TEXT");
  tryRunMigration("ALTER TABLE order_items ADD COLUMN merchant_name TEXT");
  tryRunMigration("ALTER TABLE order_items ADD COLUMN warehouse_name TEXT");
  tryRunMigration("ALTER TABLE order_items ADD COLUMN warehouse_code TEXT");
  tryRunMigration("ALTER TABLE order_items ADD COLUMN code_source TEXT DEFAULT 'VENDOOR_SOURCE'");
  tryRunMigration("ALTER TABLE order_status_events ADD COLUMN storage_tier TEXT DEFAULT 'HOT'");
  tryRunMigration("ALTER TABLE raw_activity_events ADD COLUMN storage_tier TEXT DEFAULT 'HOT'");
  tryRunMigration("ALTER TABLE raw_activity_events ADD COLUMN vendoor_order_id INTEGER");
  tryRunMigration("ALTER TABLE raw_activity_events ADD COLUMN raw_html TEXT");
  tryRunMigration("ALTER TABLE raw_activity_events ADD COLUMN details_json TEXT");
  tryRunMigration("ALTER TABLE raw_activity_events ADD COLUMN field_name TEXT");
  tryRunMigration("ALTER TABLE raw_activity_events ADD COLUMN old_value TEXT");
  tryRunMigration("ALTER TABLE raw_activity_events ADD COLUMN new_value TEXT");
  tryRunMigration("ALTER TABLE canonical_activity_events ADD COLUMN storage_tier TEXT DEFAULT 'HOT'");
  tryRunMigration("ALTER TABLE canonical_activity_events ADD COLUMN order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL");
  tryRunMigration("ALTER TABLE canonical_activity_events ADD COLUMN order_match_status TEXT DEFAULT 'UNRESOLVED'");
  tryRunMigration("ALTER TABLE canonical_activity_events ADD COLUMN is_administrative INTEGER DEFAULT 0");
  tryRunMigration("ALTER TABLE canonical_activity_events ADD COLUMN details_json TEXT");
  tryRunMigration("ALTER TABLE canonical_activity_events ADD COLUMN field_name TEXT");
  tryRunMigration("ALTER TABLE canonical_activity_events ADD COLUMN old_value TEXT");
  tryRunMigration("ALTER TABLE canonical_activity_events ADD COLUMN new_value TEXT");
  tryRunMigration("ALTER TABLE customer_history_observations ADD COLUMN storage_tier TEXT DEFAULT 'HOT'");
  tryRunMigration("ALTER TABLE confirmation_age_observations ADD COLUMN storage_tier TEXT DEFAULT 'HOT'");
  tryRunMigration("ALTER TABLE sync_runs ADD COLUMN raw_rows_received INTEGER DEFAULT 0");
  tryRunMigration("ALTER TABLE sync_runs ADD COLUMN valid_records_parsed INTEGER DEFAULT 0");
  tryRunMigration("ALTER TABLE sync_runs ADD COLUMN unique_source_ids INTEGER DEFAULT 0");
  tryRunMigration("ALTER TABLE sync_runs ADD COLUMN duplicate_source_ids INTEGER DEFAULT 0");
  tryRunMigration("ALTER TABLE sync_runs ADD COLUMN new_orders_inserted INTEGER DEFAULT 0");
  tryRunMigration("ALTER TABLE sync_runs ADD COLUMN existing_orders_examined INTEGER DEFAULT 0");
  tryRunMigration("ALTER TABLE sync_runs ADD COLUMN records_with_field_changes INTEGER DEFAULT 0");
  tryRunMigration("ALTER TABLE sync_runs ADD COLUMN status_changes_count INTEGER DEFAULT 0");
  tryRunMigration("ALTER TABLE sync_runs ADD COLUMN unresolved_status_count INTEGER DEFAULT 0");
  tryRunMigration("ALTER TABLE sync_runs ADD COLUMN invalid_records_count INTEGER DEFAULT 0");
  tryRunMigration("ALTER TABLE sync_runs ADD COLUMN failed_pages_count INTEGER DEFAULT 0");
  tryRunMigration("ALTER TABLE sync_runs ADD COLUMN duration_ms INTEGER DEFAULT 0");
  tryRunMigration("ALTER TABLE sync_runs ADD COLUMN phase_timings_json TEXT");
  tryRunMigration("ALTER TABLE merchant_code_mappings ADD COLUMN sku TEXT");
  tryRunMigration("ALTER TABLE merchant_code_mappings ADD COLUMN product_id INTEGER");
  tryRunMigration("ALTER TABLE merchant_code_mappings ADD COLUMN product_name TEXT");
  tryRunMigration("ALTER TABLE merchant_code_mappings ADD COLUMN order_code TEXT");
  tryRunMigration("ALTER TABLE merchant_code_mappings ADD COLUMN vendoor_id INTEGER");
  tryRunMigration("ALTER TABLE merchant_code_mappings ADD COLUMN warehouse_code TEXT");
  tryRunMigration("ALTER TABLE merchant_code_mappings ADD COLUMN warehouse_name TEXT");
  tryRunMigration("ALTER TABLE merchant_code_mappings ADD COLUMN updated_at TEXT");

  // 3. Create all indexes safely
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_mcm_sku ON merchant_code_mappings(sku);
    CREATE INDEX IF NOT EXISTS idx_mcm_order_code ON merchant_code_mappings(order_code);
    CREATE INDEX IF NOT EXISTS idx_mcm_product_id ON merchant_code_mappings(product_id);
    CREATE INDEX IF NOT EXISTS idx_orders_random_number ON orders(random_number);
    CREATE INDEX IF NOT EXISTS idx_orders_current_status ON orders(current_status);
    CREATE INDEX IF NOT EXISTS idx_orders_state_entry_at ON orders(state_entry_at);
    CREATE INDEX IF NOT EXISTS idx_orders_multi_merchant ON orders(multi_merchant_flag);
    CREATE INDEX IF NOT EXISTS idx_orders_delivery_rate ON orders(delivery_rate);
    CREATE INDEX IF NOT EXISTS idx_orders_created_at_source ON orders(created_at_source);
    CREATE INDEX IF NOT EXISTS idx_orders_storage_tier ON orders(storage_tier);
    CREATE INDEX IF NOT EXISTS idx_orders_validation_status ON orders(validation_status);

    CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_merchant_code ON order_items(merchant_code);

    CREATE INDEX IF NOT EXISTS idx_status_events_order_id ON order_status_events(order_id);
    CREATE INDEX IF NOT EXISTS idx_status_events_observed ON order_status_events(observed_at);
    CREATE INDEX IF NOT EXISTS idx_status_events_to_status ON order_status_events(to_status);
    CREATE INDEX IF NOT EXISTS idx_status_events_tier ON order_status_events(storage_tier);

    CREATE INDEX IF NOT EXISTS idx_raw_activity_order ON raw_activity_events(order_code);
    CREATE INDEX IF NOT EXISTS idx_raw_activity_actor ON raw_activity_events(actor_name);
    CREATE INDEX IF NOT EXISTS idx_raw_activity_timestamp ON raw_activity_events(event_timestamp);
    CREATE INDEX IF NOT EXISTS idx_raw_activity_tier ON raw_activity_events(storage_tier);

    CREATE INDEX IF NOT EXISTS idx_canonical_order_id ON canonical_activity_events(order_id);
    CREATE INDEX IF NOT EXISTS idx_canonical_order_code ON canonical_activity_events(order_code);
    CREATE INDEX IF NOT EXISTS idx_canonical_match_status ON canonical_activity_events(order_match_status);
    CREATE INDEX IF NOT EXISTS idx_canonical_is_admin ON canonical_activity_events(is_administrative);
    CREATE INDEX IF NOT EXISTS idx_canonical_actor ON canonical_activity_events(actor_name);
    CREATE INDEX IF NOT EXISTS idx_canonical_timestamp ON canonical_activity_events(event_timestamp);
    CREATE INDEX IF NOT EXISTS idx_canonical_action_type ON canonical_activity_events(action_type);
    CREATE INDEX IF NOT EXISTS idx_canonical_tier ON canonical_activity_events(storage_tier);

    CREATE INDEX IF NOT EXISTS idx_cust_hist_phone ON customer_history_observations(phone);
    CREATE INDEX IF NOT EXISTS idx_cust_hist_tier ON customer_history_observations(storage_tier);

    CREATE INDEX IF NOT EXISTS idx_conf_age_random ON confirmation_age_observations(random_number);

    CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
    CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(alert_type);
    CREATE INDEX IF NOT EXISTS idx_alerts_order ON alerts(order_id);

    CREATE INDEX IF NOT EXISTS idx_hist_cov_domain_date ON historical_coverage(source_domain, period_date);
    CREATE INDEX IF NOT EXISTS idx_hist_cov_tier ON historical_coverage(storage_tier);
    CREATE INDEX IF NOT EXISTS idx_hist_cov_status ON historical_coverage(completion_status);

    CREATE INDEX IF NOT EXISTS idx_daily_snapshots_date ON daily_snapshots(snapshot_date);
    CREATE INDEX IF NOT EXISTS idx_daily_snapshots_tier ON daily_snapshots(storage_tier);
  `);

  // Populate initial coverage records if database already contains imported data
  try {
    populateInitialCoverageFromExistingData();
  } catch (err: any) {
    console.warn('[DB] Warning populating initial coverage:', err.message);
  }

  // Backfill order links and administrative flags for existing log events
  try {
    backfillOrderLinksForEvents();
  } catch (err: any) {
    console.warn('[DB] Warning backfilling log order links:', err.message);
  }

  // Segregate warehouse names and clean merchant codes in order_items
  try {
    repairMerchantAndWarehouseData();
  } catch (err: any) {
    console.warn('[DB] Warning repairing merchant/warehouse data:', err.message);
  }
}

/**
 * Automatically resolves order_id, order_match_status, and parses rich details for log events
 * by looking up random_number, order_no, or vendoor_id in orders.
 */
export function backfillOrderLinksForEvents() {
  try {
    const orderRows: any[] = db.prepare('SELECT id, random_number, order_no, vendoor_id FROM orders').all();
    const orderMap = new Map<string, number>();
    for (const o of orderRows) {
      if (o.random_number) orderMap.set(o.random_number.toLowerCase(), o.id);
      if (o.order_no) orderMap.set(String(o.order_no).toLowerCase(), o.id);
      if (o.vendoor_id) orderMap.set(String(o.vendoor_id).toLowerCase(), o.id);
    }

    const events: any[] = db.prepare(`
      SELECT c.id, c.order_code, c.actor_name, c.action_type, r.raw_action_text
      FROM canonical_activity_events c
      LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
      WHERE c.order_match_status IS NULL OR c.order_match_status = 'UNRESOLVED' OR c.field_name IS NULL
    `).all();

    if (events.length === 0) return;


    const updateStmt = db.prepare(`
      UPDATE canonical_activity_events
      SET 
        order_id = ?,
        order_match_status = ?,
        is_administrative = ?,
        action_type = ?,
        from_status = COALESCE(?, from_status),
        to_status = COALESCE(?, to_status),
        field_name = ?,
        old_value = ?,
        new_value = ?,
        details_json = ?
      WHERE id = ?
    `);

    db.exec('BEGIN TRANSACTION;');
    for (const ev of events) {
      const code = (ev.order_code || '').trim().toLowerCase();
      let orderId: number | null = null;
      let matchStatus = 'UNRESOLVED';
      if (!code) {
        matchStatus = 'GENERAL_LOG';
      } else if (orderMap.has(code)) {
        orderId = orderMap.get(code)!;
        matchStatus = 'MATCHED';
      }

      const parsed = parseLogActionDetails(ev.raw_action_text || '', ev.actor_name || '', ev.order_code || '');
      const detailsJson = JSON.stringify(parsed);

      updateStmt.run(
        orderId,
        matchStatus,
        parsed.isAdministrative ? 1 : 0,
        parsed.actionType !== 'other' ? parsed.actionType : ev.action_type,
        parsed.fromStatus,
        parsed.toStatus,
        parsed.fieldName,
        parsed.oldValue,
        parsed.newValue,
        detailsJson,
        ev.id
      );
    }
    db.exec('COMMIT;');
  } catch (err: any) {
    try { db.exec('ROLLBACK;'); } catch {}
    console.warn('[DB] Warning backfilling log order links:', err.message);
  }
}

/**
 * Segregates warehouse names from merchant codes in order_items.
 * - Extracts and populates warehouse_name (e.g. "مخزن Y 21") and warehouse_code ("Y 21").
 * - Clears merchant_code to NULL if it was mistakenly set to warehouse names ("مخزن %", "كود %", "غير محدد").
 * - Preserves authentic merchant codes (from Excel imports or vendor mappings).
 * - Never invents merchant codes or treats SKU/warehouse as merchant code.
 */
export function repairMerchantAndWarehouseData() {
  try {
    // 0. Drop NOT NULL constraint on merchant_code if present in SQLite schema
    const pragma: any[] = db.prepare('PRAGMA table_info(order_items)').all();
    const mcCol = pragma.find(c => c.name === 'merchant_code');
    if (mcCol && mcCol.notnull === 1) {
      db.exec('PRAGMA foreign_keys = OFF;');
      db.exec(`
        CREATE TABLE IF NOT EXISTS order_items_v2 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          vendoor_item_id INTEGER,
          product_id INTEGER,
          product_name TEXT NOT NULL,
          merchant_code TEXT,
          merchant_name TEXT,
          warehouse_name TEXT,
          warehouse_code TEXT,
          code_source TEXT DEFAULT 'VENDOOR_SOURCE',
          merchant_id TEXT,
          sku TEXT,
          size TEXT,
          color TEXT,
          quantity INTEGER DEFAULT 1,
          unit_price REAL DEFAULT 0,
          pay_vendor REAL DEFAULT 0,
          image_path TEXT,
          raw_json TEXT,
          created_at TEXT NOT NULL
        );

        INSERT INTO order_items_v2 (
          id, order_id, vendoor_item_id, product_id, product_name,
          merchant_code, merchant_name, warehouse_name, warehouse_code,
          code_source, merchant_id, sku, size, color, quantity, unit_price,
          pay_vendor, image_path, raw_json, created_at
        )
        SELECT
          id, order_id, vendoor_item_id, product_id, product_name,
          merchant_code, merchant_name, warehouse_name, warehouse_code,
          code_source, merchant_id, sku, size, color, quantity, unit_price,
          pay_vendor, image_path, raw_json, created_at
        FROM order_items;

        DROP TABLE order_items;
        ALTER TABLE order_items_v2 RENAME TO order_items;

        CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
        CREATE INDEX IF NOT EXISTS idx_order_items_merchant_code ON order_items(merchant_code);
        CREATE INDEX IF NOT EXISTS idx_order_items_warehouse_name ON order_items(warehouse_name);
      `);
      db.exec('PRAGMA foreign_keys = ON;');
    }

    // 1. If warehouse_name is NULL or empty, but merchant_code holds a warehouse name
    db.prepare(`
      UPDATE order_items
      SET warehouse_name = merchant_code,
          warehouse_code = TRIM(REPLACE(REPLACE(merchant_code, 'مخزن', ''), 'كود', ''))
      WHERE (warehouse_name IS NULL OR warehouse_name = '')
        AND (merchant_code LIKE 'مخزن %' OR merchant_code LIKE 'كود %')
    `).run();

    // 2. Also extract warehouse_name from product_name for any items still lacking warehouse_name
    const itemsWithoutWh: any[] = db.prepare(`
      SELECT id, product_name FROM order_items
      WHERE warehouse_name IS NULL OR warehouse_name = '' OR warehouse_name = 'غير محدد'
    `).all();

    if (itemsWithoutWh.length > 0) {
      const updateWh = db.prepare(`
        UPDATE order_items 
        SET warehouse_name = ?,
            warehouse_code = ?
        WHERE id = ?
      `);
      db.exec('BEGIN TRANSACTION;');
      for (const it of itemsWithoutWh) {
        const name = it.product_name || '';
        const match = name.match(/\(\s*مخزن\s*([^)]+)\s*\)/i);
        if (match && match[1]?.trim()) {
          const whName = 'مخزن ' + match[1].trim();
          const whCode = match[1].trim();
          updateWh.run(whName, whCode, it.id);
        } else {
          const codeMatch = name.match(/\(\s*كود\s*([^)]+)\s*\)/i);
          if (codeMatch && codeMatch[1]?.trim()) {
            const whName = 'كود ' + codeMatch[1].trim();
            const whCode = codeMatch[1].trim();
            updateWh.run(whName, whCode, it.id);
          }
        }
      }
      db.exec('COMMIT;');
    }

    // 3. Clear merchant_code where it mistakenly contains warehouse strings or matches warehouse name/code
    db.prepare(`
      UPDATE order_items
      SET merchant_code = NULL
      WHERE merchant_code LIKE 'مخزن%'
         OR merchant_code LIKE 'كود %'
         OR merchant_code = 'غير محدد'
         OR (warehouse_name IS NOT NULL AND merchant_code = warehouse_name)
         OR (warehouse_code IS NOT NULL AND merchant_code = warehouse_code)
    `).run();

    // 3b. Reconcile unmapped items against verified persistent merchant_code_mappings
    try {
      db.prepare(`
        UPDATE order_items
        SET merchant_code = (
          SELECT m.merchant_code FROM merchant_code_mappings m
          WHERE (m.sku IS NOT NULL AND m.sku != '' AND m.sku = order_items.sku)
             OR (m.product_id IS NOT NULL AND m.product_id = order_items.product_id)
          LIMIT 1
        ),
        code_source = 'EXCEL_MAPPING'
        WHERE (order_items.merchant_code IS NULL OR order_items.merchant_code = '')
          AND EXISTS (
            SELECT 1 FROM merchant_code_mappings m
            WHERE (m.sku IS NOT NULL AND m.sku != '' AND m.sku = order_items.sku)
               OR (m.product_id IS NOT NULL AND m.product_id = order_items.product_id)
          )
      `).run();
    } catch (mErr: any) {
      console.warn('[DB] Warning reconciling order_items with merchant_code_mappings:', mErr.message);
    }

    // 4. Update distinct_merchant_count and multi_merchant_flag on orders table
    // based on actual distinct warehouse names (avoiding confusion)
    const distinctWarehousesPerOrder: any[] = db.prepare(`
      SELECT order_id, COUNT(DISTINCT warehouse_name) as wh_count
      FROM order_items
      WHERE warehouse_name IS NOT NULL AND warehouse_name != ''
      GROUP BY order_id
    `).all();

    const updateOrderWhCount = db.prepare(`
      UPDATE orders
      SET distinct_merchant_count = ?,
          multi_merchant_flag = ?
      WHERE id = ?
    `);

    db.exec('BEGIN TRANSACTION;');
    for (const row of distinctWarehousesPerOrder) {
      const cnt = Math.max(1, row.wh_count || 1);
      updateOrderWhCount.run(cnt, cnt > 1 ? 1 : 0, row.order_id);
    }
    db.exec('COMMIT;');
  } catch (err: any) {
    try { db.exec('ROLLBACK;'); } catch {}
    console.warn('[DB] Warning in repairMerchantAndWarehouseData:', err.message);
  }
}

function tryRunMigration(sql: string) {
  try {
    db.exec(sql);
  } catch (err: any) {
    // Column already exists or duplicate column name is normal during migrations
  }
}

/**
 * Historical Coverage Helpers
 */
export function getCoverageRecord(sourceDomain: string, periodDate: string): any {
  return db.prepare(`
    SELECT * FROM historical_coverage
    WHERE source_domain = ? AND period_date = ?
  `).get(sourceDomain, periodDate);
}

export function saveCoverageRecord(cov: HistoricalCoverageRecord) {
  db.prepare(`
    INSERT INTO historical_coverage (
      account_id, source_domain, period_date, storage_tier,
      pages_discovered, pages_read, records_extracted, records_saved,
      completion_status, error_message, last_attempted_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_domain, period_date) DO UPDATE SET
      storage_tier = excluded.storage_tier,
      pages_discovered = excluded.pages_discovered,
      pages_read = excluded.pages_read,
      records_extracted = excluded.records_extracted,
      records_saved = excluded.records_saved,
      completion_status = excluded.completion_status,
      error_message = excluded.error_message,
      last_attempted_at = excluded.last_attempted_at,
      completed_at = excluded.completed_at
  `).run(
    cov.accountId || 'primary',
    cov.sourceDomain,
    cov.periodDate,
    cov.storageTier,
    cov.pagesDiscovered,
    cov.pagesRead,
    cov.recordsExtracted,
    cov.recordsSaved,
    cov.completionStatus,
    cov.errorMessage || null,
    cov.lastAttemptedAt,
    cov.completedAt || null
  );
}

/**
 * HOT / COLD Archiving Policy
 * Moves historical log events and snapshots older than 30 days to storage_tier = 'COLD'.
 * IMPORTANT: Active orders (New, Pending, Processing) are NEVER archived to COLD
 * so they remain visible in operational dashboards!
 */
export function runHotColdArchival(): { archivedEvents: number; archivedLogs: number } {
  const hotThreshold = getHotThresholdDate();

  // Archive historical events older than 30 days
  const evRes = db.prepare(`
    UPDATE canonical_activity_events
    SET storage_tier = 'COLD'
    WHERE storage_tier = 'HOT' AND event_timestamp < ?
  `).run(`${hotThreshold} 00:00:00`);

  const rawRes = db.prepare(`
    UPDATE raw_activity_events
    SET storage_tier = 'COLD'
    WHERE storage_tier = 'HOT' AND event_timestamp < ?
  `).run(`${hotThreshold} 00:00:00`);

  // Archive historical customer observations
  db.prepare(`
    UPDATE customer_history_observations
    SET storage_tier = 'COLD'
    WHERE storage_tier = 'HOT' AND observed_at < ?
  `).run(`${hotThreshold}T00:00:00`);

  // Archive completed orders that are finalized (e.g. Canceled or old delivered)
  // while strictly keeping New, Pending, Processing active in HOT!
  db.prepare(`
    UPDATE orders
    SET storage_tier = 'COLD'
    WHERE storage_tier = 'HOT'
      AND current_status NOT IN ('New', 'Pending', 'Processing')
      AND created_at_source < ?
  `).run(`${hotThreshold} 00:00:00`);

  return {
    archivedEvents: Number(evRes.changes),
    archivedLogs: Number(rawRes.changes),
  };
}

export interface DailySnapshotRecord {
  id?: number;
  snapshotDate: string; // YYYY-MM-DD
  storageTier: 'HOT' | 'COLD';
  newCount: number;
  pendingCount: number;
  processingCount: number;
  cancelingCount: number;
  printedCount: number;
  canceledCount: number;
  totalOrders: number;
  createdToday: number;
  printedToday: number;
  pendingToday: number;
  processingToday: number;
  cancelingToday: number;
  canceledToday: number;
  multiMerchantPrinted: number;
  missingExtraPhonePrinted: number;
  lowDeliveryRatePrinted: number;
  snapshotJson?: string | null;
  createdAt: string;
  updatedAt: string;
}

export function getDailySnapshot(snapshotDate: string): any {
  return db.prepare(`
    SELECT * FROM daily_snapshots WHERE snapshot_date = ?
  `).get(snapshotDate);
}

export function saveDailySnapshot(snap: DailySnapshotRecord) {
  db.prepare(`
    INSERT INTO daily_snapshots (
      snapshot_date, storage_tier, new_count, pending_count, processing_count,
      canceling_count, printed_count, canceled_count, total_orders,
      created_today, printed_today, pending_today, processing_today, canceling_today, canceled_today,
      multi_merchant_printed, missing_extra_phone_printed, low_delivery_rate_printed,
      snapshot_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(snapshot_date) DO UPDATE SET
      storage_tier = excluded.storage_tier,
      new_count = excluded.new_count,
      pending_count = excluded.pending_count,
      processing_count = excluded.processing_count,
      canceling_count = excluded.canceling_count,
      printed_count = excluded.printed_count,
      canceled_count = excluded.canceled_count,
      total_orders = excluded.total_orders,
      created_today = excluded.created_today,
      printed_today = excluded.printed_today,
      pending_today = excluded.pending_today,
      processing_today = excluded.processing_today,
      canceling_today = excluded.canceling_today,
      canceled_today = excluded.canceled_today,
      multi_merchant_printed = excluded.multi_merchant_printed,
      missing_extra_phone_printed = excluded.missing_extra_phone_printed,
      low_delivery_rate_printed = excluded.low_delivery_rate_printed,
      snapshot_json = excluded.snapshot_json,
      updated_at = excluded.updated_at
  `).run(
    snap.snapshotDate,
    snap.storageTier,
    snap.newCount,
    snap.pendingCount,
    snap.processingCount,
    snap.cancelingCount,
    snap.printedCount,
    snap.canceledCount,
    snap.totalOrders,
    snap.createdToday,
    snap.printedToday,
    snap.pendingToday,
    snap.processingToday,
    snap.cancelingToday,
    snap.canceledToday,
    snap.multiMerchantPrinted,
    snap.missingExtraPhonePrinted,
    snap.lowDeliveryRatePrinted,
    snap.snapshotJson || null,
    snap.createdAt,
    snap.updatedAt
  );
}

/**
 * Initializes coverage records for dates already in the database
 * so historical coverage accurately reflects existing imported data.
 */
export function populateInitialCoverageFromExistingData() {
  const existingCoverageCount = (db.prepare('SELECT COUNT(*) as c FROM historical_coverage').get() as any)?.c || 0;
  if (existingCoverageCount > 0) return;

  const nowIso = new Date().toISOString();

  // 1. Logs coverage for 2026-10-14 (1,140 rows in DB)
  const logRows = (db.prepare("SELECT COUNT(*) as c FROM raw_activity_events WHERE event_timestamp LIKE '2026-10-14%'").get() as any)?.c || 0;
  if (logRows > 0) {
    saveCoverageRecord({
      accountId: 'primary',
      sourceDomain: 'logs',
      periodDate: '2026-10-14',
      storageTier: 'HOT',
      pagesDiscovered: 1,
      pagesRead: 1,
      recordsExtracted: logRows,
      recordsSaved: logRows,
      completionStatus: 'PARTIAL',
      lastAttemptedAt: nowIso,
      completedAt: null,
    });
  }

  // 2. Orders coverage for major dates present in database
  const orderDates: any[] = db.prepare(`
    SELECT substr(created_at_source, 1, 10) as dt, COUNT(*) as c
    FROM orders
    WHERE created_at_source IS NOT NULL AND length(created_at_source) >= 10
    GROUP BY dt
  `).all();

  for (const od of orderDates) {
    if (!od.dt || od.dt.length < 10) continue;
    saveCoverageRecord({
      accountId: 'primary',
      sourceDomain: 'orders',
      periodDate: od.dt,
      storageTier: isDateInHot(od.dt) ? 'HOT' : 'COLD',
      pagesDiscovered: 1,
      pagesRead: 1,
      recordsExtracted: od.c,
      recordsSaved: od.c,
      completionStatus: 'PARTIAL',
      lastAttemptedAt: nowIso,
      completedAt: null,
    });
  }
}

// Auto-initialize schema on module load
try {
  initDatabase();
} catch (err: any) {
  // Safe if already initialized
}

