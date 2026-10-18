-- Additive Archival Schema Enhancements for Vendoor Operations Intelligence
-- Starts October 18, 2026

-- 1. Dedicated Merchant Code Mappings (from Excel/dedicated source field)
CREATE TABLE IF NOT EXISTS merchant_code_mappings (
  id BIGSERIAL PRIMARY KEY,
  merchant_code TEXT NOT NULL,
  merchant_name TEXT,
  source_sheet_name TEXT,
  excel_row_index INTEGER,
  sku_pattern TEXT,
  vendor_id_ref BIGINT,
  notes TEXT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_merchant_code_sheet UNIQUE (merchant_code, source_sheet_name)
);

CREATE INDEX IF NOT EXISTS idx_merchant_code_mappings_code ON merchant_code_mappings(merchant_code);

-- 2. Historical Log Backfill Jobs
CREATE TABLE IF NOT EXISTS historical_log_backfill_jobs (
  id BIGSERIAL PRIMARY KEY,
  job_key TEXT UNIQUE NOT NULL,
  requested_date DATE NOT NULL,
  source_domain TEXT NOT NULL DEFAULT 'logs',
  status TEXT NOT NULL DEFAULT 'QUEUED', -- QUEUED, RUNNING, COMPLETE, PARTIAL, FAILED
  pages_fetched INTEGER DEFAULT 0,
  pages_total INTEGER DEFAULT 0,
  events_saved INTEGER DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_historical_log_jobs_date ON historical_log_backfill_jobs(requested_date, source_domain);

-- 3. Ensure archive sync runs table
CREATE TABLE IF NOT EXISTS supabase_archive_runs (
  id BIGSERIAL PRIMARY KEY,
  status TEXT NOT NULL, -- SUCCESS, PARTIAL, FAILED
  orders_archived INTEGER DEFAULT 0,
  events_archived INTEGER DEFAULT 0,
  logs_archived INTEGER DEFAULT 0,
  duration_ms INTEGER,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ
);
