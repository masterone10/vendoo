-- ============================================================================
-- VENDOOR OPERATIONS INTELLIGENCE — SUPABASE POSTGRESQL SCHEMA MIGRATION
-- Migration Version: 20261017000001
-- Description: Creates canonical tables, indexes, constraints, audit tables,
--              risk alerts, historical archives, and security policies.
-- Safe & Idempotent: Uses IF NOT EXISTS, avoids destructive drops/truncates.
-- ============================================================================

-- Enable required PostgreSQL extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- 1. APP SETTINGS & CONFIGURATION
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
  id BIGSERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  value JSONB NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

-- ----------------------------------------------------------------------------
-- 2. EMPLOYEES, MERCHANTS, AND WAREHOUSES DIRECTORY
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employees (
  id BIGSERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  source_actor_id TEXT,
  role TEXT DEFAULT 'staff',
  is_system_actor BOOLEAN DEFAULT false,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

CREATE TABLE IF NOT EXISTS merchants (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

CREATE TABLE IF NOT EXISTS warehouses (
  id BIGSERIAL PRIMARY KEY,
  warehouse_code TEXT UNIQUE NOT NULL,
  warehouse_name TEXT NOT NULL,
  governorate TEXT,
  address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

-- ----------------------------------------------------------------------------
-- 3. ORDERS TABLE: Canonical authoritative record per order
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  vendoor_id BIGINT UNIQUE NOT NULL,
  random_number TEXT NOT NULL UNIQUE,
  order_no TEXT,
  order_type TEXT DEFAULT 'اوردر جديد',
  current_status TEXT NOT NULL,
  status_raw TEXT,
  affiliate_code TEXT,
  affiliate_name TEXT,
  affiliate_id BIGINT,
  customer_name TEXT,
  customer_phone TEXT NOT NULL,
  customer_phone_extra TEXT,
  extra_phone_status TEXT DEFAULT 'NOT_RETRIEVED',
  extra_phone_valid BOOLEAN DEFAULT false,
  governorate TEXT,
  address TEXT,
  address_word_count INTEGER,
  address_is_latin BOOLEAN DEFAULT false,
  address_quality_status TEXT DEFAULT 'NOT_RETRIEVED',
  total_price NUMERIC(12, 2) DEFAULT 0,
  shipping_cost NUMERIC(12, 2) DEFAULT 0,
  total_order NUMERIC(12, 2) DEFAULT 0,
  created_at_source TIMESTAMPTZ,
  shipping_date TIMESTAMPTZ,
  printed_date TIMESTAMPTZ,
  canceling_date TIMESTAMPTZ,
  last_updated_source TIMESTAMPTZ,
  distinct_merchant_count INTEGER DEFAULT 1,
  multi_merchant_flag BOOLEAN DEFAULT false,
  distinct_warehouse_count INTEGER DEFAULT 1,
  multi_warehouse_flag BOOLEAN DEFAULT false,
  delivery_rate NUMERIC(5, 2),
  delivery_rate_num INTEGER,
  delivery_rate_denom INTEGER,
  cancel_rate NUMERIC(5, 2),
  cancel_rate_num INTEGER,
  cancel_rate_denom INTEGER,
  total_customer_orders INTEGER,
  customer_last_order_status TEXT,
  customer_last_order_elapsed TEXT,
  phone_repetition_count INTEGER,
  customer_delivery_warning TEXT,
  customer_history_checked_at TIMESTAMPTZ,
  confirmation_age_category TEXT,
  confirmation_age_observed_at TIMESTAMPTZ,
  state_entry_at TIMESTAMPTZ,
  validation_status TEXT DEFAULT 'PENDING_VALIDATION',
  storage_tier TEXT DEFAULT 'HOT',
  last_enrichment_at TIMESTAMPTZ,
  last_enrichment_status TEXT,
  last_observed_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

-- ----------------------------------------------------------------------------
-- 4. ORDER ITEMS: Multi-product lines per order
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  vendoor_item_id BIGINT,
  product_id BIGINT,
  product_name TEXT NOT NULL,
  merchant_code TEXT,
  merchant_name TEXT,
  merchant_id TEXT,
  warehouse_id TEXT,
  warehouse_name TEXT,
  sku TEXT,
  size TEXT,
  color TEXT,
  quantity INTEGER DEFAULT 1,
  unit_price NUMERIC(12, 2) DEFAULT 0,
  pay_vendor NUMERIC(12, 2) DEFAULT 0,
  image_path TEXT,
  raw_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

-- ----------------------------------------------------------------------------
-- 5. ORDER STATUS TIMELINE & OBSERVATIONS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_status_events (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  random_number TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_name TEXT DEFAULT 'النظام',
  event_time_source TIMESTAMPTZ,
  storage_tier TEXT DEFAULT 'HOT',
  observed_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  source_channel TEXT NOT NULL,
  raw_activity_id BIGINT
);

CREATE TABLE IF NOT EXISTS order_status_observations (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  vendoor_id BIGINT NOT NULL,
  observed_status TEXT NOT NULL,
  status_raw TEXT,
  scan_batch_id TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

-- ----------------------------------------------------------------------------
-- 6. SYSTEM LOGS & CANONICAL AUDIT EVENTS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS raw_activity_events (
  id BIGSERIAL PRIMARY KEY,
  source_hash TEXT UNIQUE NOT NULL,
  order_code TEXT,
  actor_name TEXT,
  raw_action_text TEXT NOT NULL,
  event_timestamp TIMESTAMPTZ NOT NULL,
  storage_tier TEXT DEFAULT 'HOT',
  observed_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  page_source TEXT DEFAULT 'log/system',
  is_duplicate BOOLEAN DEFAULT false
);

CREATE TABLE IF NOT EXISTS canonical_activity_events (
  id BIGSERIAL PRIMARY KEY,
  raw_event_id BIGINT REFERENCES raw_activity_events(id) ON DELETE SET NULL,
  order_code TEXT,
  actor_name TEXT NOT NULL,
  action_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  event_timestamp TIMESTAMPTZ NOT NULL,
  storage_tier TEXT DEFAULT 'HOT',
  is_system_actor BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

-- ----------------------------------------------------------------------------
-- 7. CUSTOMER HISTORY & ADDRESS ENRICHMENT
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_history_observations (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT REFERENCES orders(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  total_orders INTEGER,
  deliveries_num INTEGER,
  deliveries_denom INTEGER,
  delivery_rate NUMERIC(5, 2),
  cancels_num INTEGER,
  cancels_denom INTEGER,
  cancel_rate NUMERIC(5, 2),
  repetitions_count INTEGER,
  last_order_status TEXT,
  last_order_elapsed TEXT,
  warning_text TEXT,
  storage_tier TEXT DEFAULT 'HOT',
  observed_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

CREATE TABLE IF NOT EXISTS address_observations (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  raw_address TEXT NOT NULL,
  word_count INTEGER,
  is_latin BOOLEAN DEFAULT false,
  quality_status TEXT NOT NULL,
  detected_issues JSONB,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

CREATE TABLE IF NOT EXISTS confirmation_age_observations (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT REFERENCES orders(id) ON DELETE CASCADE,
  random_number TEXT NOT NULL,
  age_category TEXT NOT NULL,
  invoice_no TEXT,
  printed_date TIMESTAMPTZ,
  storage_tier TEXT DEFAULT 'HOT',
  observed_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

-- ----------------------------------------------------------------------------
-- 8. RISK ALERTS & RESOLUTION HISTORY
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alerts (
  id BIGSERIAL PRIMARY KEY,
  alert_key TEXT UNIQUE NOT NULL,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  random_number TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'CRITICAL',
  status TEXT NOT NULL DEFAULT 'OPEN',
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  details_json JSONB,
  is_pre_existing BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  resolution_notes TEXT
);

CREATE TABLE IF NOT EXISTS alert_resolution_history (
  id BIGSERIAL PRIMARY KEY,
  alert_id BIGINT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  actor_name TEXT NOT NULL,
  previous_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  notes TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

-- ----------------------------------------------------------------------------
-- 9. SYNCHRONIZATION DIAGNOSTICS & RUN TRACEABILITY
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_runs (
  id BIGSERIAL PRIMARY KEY,
  run_type TEXT NOT NULL,
  status TEXT NOT NULL,
  orders_scanned INTEGER DEFAULT 0,
  orders_created INTEGER DEFAULT 0,
  orders_updated INTEGER DEFAULT 0,
  events_detected INTEGER DEFAULT 0,
  alerts_triggered INTEGER DEFAULT 0,
  errors_count INTEGER DEFAULT 0,
  raw_rows_received INTEGER DEFAULT 0,
  valid_records_parsed INTEGER DEFAULT 0,
  unique_source_ids INTEGER DEFAULT 0,
  duplicate_source_ids INTEGER DEFAULT 0,
  new_orders_inserted INTEGER DEFAULT 0,
  existing_orders_examined INTEGER DEFAULT 0,
  records_with_field_changes INTEGER DEFAULT 0,
  status_changes_count INTEGER DEFAULT 0,
  unresolved_status_count INTEGER DEFAULT 0,
  invalid_records_count INTEGER DEFAULT 0,
  failed_pages_count INTEGER DEFAULT 0,
  failed_enrichment_count INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  phase_timings_json JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  completed_at TIMESTAMPTZ,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS sync_view_runs (
  id BIGSERIAL PRIMARY KEY,
  sync_run_id BIGINT REFERENCES sync_runs(id) ON DELETE CASCADE,
  view_name TEXT NOT NULL,
  total_reported INTEGER DEFAULT 0,
  pages_fetched INTEGER DEFAULT 0,
  records_extracted INTEGER DEFAULT 0,
  completion_status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER DEFAULT 0,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS sync_page_runs (
  id BIGSERIAL PRIMARY KEY,
  sync_view_run_id BIGINT REFERENCES sync_view_runs(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  raw_rows INTEGER DEFAULT 0,
  valid_rows INTEGER DEFAULT 0,
  unique_ids INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  status TEXT NOT NULL,
  error_message TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

CREATE TABLE IF NOT EXISTS sync_staging_orders (
  id BIGSERIAL PRIMARY KEY,
  batch_id TEXT NOT NULL,
  vendoor_id BIGINT NOT NULL,
  random_number TEXT NOT NULL,
  status_raw TEXT NOT NULL,
  parsed_status TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  validation_errors TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

CREATE TABLE IF NOT EXISTS data_quality_issues (
  id BIGSERIAL PRIMARY KEY,
  issue_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  description TEXT NOT NULL,
  raw_payload JSONB,
  status TEXT DEFAULT 'OPEN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  resolved_at TIMESTAMPTZ
);

-- ----------------------------------------------------------------------------
-- 10. HISTORICAL ARCHIVE, COVERAGE & SNAPSHOTS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS historical_coverage (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT DEFAULT 'primary',
  source_domain TEXT NOT NULL,
  period_date DATE NOT NULL,
  storage_tier TEXT NOT NULL,
  pages_discovered INTEGER DEFAULT 0,
  pages_read INTEGER DEFAULT 0,
  records_extracted INTEGER DEFAULT 0,
  records_saved INTEGER DEFAULT 0,
  completion_status TEXT NOT NULL,
  error_message TEXT,
  last_attempted_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  completed_at TIMESTAMPTZ,
  UNIQUE(source_domain, period_date)
);

CREATE TABLE IF NOT EXISTS historical_backfill_jobs (
  id BIGSERIAL PRIMARY KEY,
  source_domain TEXT NOT NULL,
  target_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  current_page INTEGER DEFAULT 1,
  total_pages INTEGER DEFAULT 1,
  records_saved INTEGER DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

CREATE TABLE IF NOT EXISTS daily_snapshots (
  id BIGSERIAL PRIMARY KEY,
  snapshot_date DATE UNIQUE NOT NULL,
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
  snapshot_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

-- ----------------------------------------------------------------------------
-- 11. INDEXES FOR HIGH-THROUGHPUT SEARCH & ANALYTICS
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_orders_vendoor_id ON orders(vendoor_id);
CREATE INDEX IF NOT EXISTS idx_orders_random_number ON orders(random_number);
CREATE INDEX IF NOT EXISTS idx_orders_current_status ON orders(current_status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at_source ON orders(created_at_source);
CREATE INDEX IF NOT EXISTS idx_orders_printed_date ON orders(printed_date);
CREATE INDEX IF NOT EXISTS idx_orders_canceling_date ON orders(canceling_date);
CREATE INDEX IF NOT EXISTS idx_orders_state_entry_at ON orders(state_entry_at);
CREATE INDEX IF NOT EXISTS idx_orders_multi_merchant ON orders(multi_merchant_flag);
CREATE INDEX IF NOT EXISTS idx_orders_multi_warehouse ON orders(multi_warehouse_flag);
CREATE INDEX IF NOT EXISTS idx_orders_delivery_rate ON orders(delivery_rate);
CREATE INDEX IF NOT EXISTS idx_orders_storage_tier ON orders(storage_tier);
CREATE INDEX IF NOT EXISTS idx_orders_customer_phone ON orders(customer_phone);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_merchant_code ON order_items(merchant_code);
CREATE INDEX IF NOT EXISTS idx_order_items_warehouse_id ON order_items(warehouse_id);

CREATE INDEX IF NOT EXISTS idx_status_events_order_id ON order_status_events(order_id);
CREATE INDEX IF NOT EXISTS idx_status_events_observed ON order_status_events(observed_at);
CREATE INDEX IF NOT EXISTS idx_status_events_to_status ON order_status_events(to_status);
CREATE INDEX IF NOT EXISTS idx_status_events_tier ON order_status_events(storage_tier);

CREATE INDEX IF NOT EXISTS idx_raw_activity_order ON raw_activity_events(order_code);
CREATE INDEX IF NOT EXISTS idx_raw_activity_actor ON raw_activity_events(actor_name);
CREATE INDEX IF NOT EXISTS idx_raw_activity_timestamp ON raw_activity_events(event_timestamp);

CREATE INDEX IF NOT EXISTS idx_canonical_actor ON canonical_activity_events(actor_name);
CREATE INDEX IF NOT EXISTS idx_canonical_timestamp ON canonical_activity_events(event_timestamp);
CREATE INDEX IF NOT EXISTS idx_canonical_action_type ON canonical_activity_events(action_type);

CREATE INDEX IF NOT EXISTS idx_cust_hist_phone ON customer_history_observations(phone);
CREATE INDEX IF NOT EXISTS idx_cust_hist_observed ON customer_history_observations(observed_at);

CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(alert_type);
CREATE INDEX IF NOT EXISTS idx_alerts_order ON alerts(order_id);

CREATE INDEX IF NOT EXISTS idx_hist_cov_domain_date ON historical_coverage(source_domain, period_date);
CREATE INDEX IF NOT EXISTS idx_daily_snapshots_date ON daily_snapshots(snapshot_date);

-- ----------------------------------------------------------------------------
-- 12. ROW-LEVEL SECURITY (RLS) POLICIES
-- ----------------------------------------------------------------------------
-- Enable RLS on sensitive tables
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_status_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_activity_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE canonical_activity_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_history_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE historical_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_snapshots ENABLE ROW LEVEL SECURITY;

-- Service role has full unrestricted access
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'service_role_all_orders') THEN
    CREATE POLICY service_role_all_orders ON orders FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'service_role_all_order_items') THEN
    CREATE POLICY service_role_all_order_items ON order_items FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'service_role_all_order_status_events') THEN
    CREATE POLICY service_role_all_order_status_events ON order_status_events FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'service_role_all_raw_activity_events') THEN
    CREATE POLICY service_role_all_raw_activity_events ON raw_activity_events FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'service_role_all_canonical_activity_events') THEN
    CREATE POLICY service_role_all_canonical_activity_events ON canonical_activity_events FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'service_role_all_alerts') THEN
    CREATE POLICY service_role_all_alerts ON alerts FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'service_role_all_sync_runs') THEN
    CREATE POLICY service_role_all_sync_runs ON sync_runs FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'service_role_all_historical_coverage') THEN
    CREATE POLICY service_role_all_historical_coverage ON historical_coverage FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'service_role_all_daily_snapshots') THEN
    CREATE POLICY service_role_all_daily_snapshots ON daily_snapshots FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;
