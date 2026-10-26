-- Migration: Create current_operational_orders for authoritative live operational state
-- Separates live active queues ('New', 'Pending', 'Processing', 'Canceling') from 80k+ historical orders.

CREATE TABLE IF NOT EXISTS current_operational_orders (
  id BIGSERIAL PRIMARY KEY,
  vendoor_id BIGINT UNIQUE NOT NULL,
  random_number VARCHAR(64) UNIQUE NOT NULL,
  order_no VARCHAR(64),
  order_type VARCHAR(64) DEFAULT 'regular',
  current_status VARCHAR(64) NOT NULL,
  status_raw TEXT,
  affiliate_code VARCHAR(64),
  affiliate_name TEXT,
  affiliate_id BIGINT,
  customer_name TEXT,
  customer_phone VARCHAR(64),
  customer_phone_extra VARCHAR(64),
  extra_phone_status VARCHAR(64) DEFAULT 'NOT_RETRIEVED',
  extra_phone_valid SMALLINT DEFAULT 0,
  governorate VARCHAR(128),
  address TEXT,
  address_word_count INTEGER DEFAULT 0,
  address_is_latin SMALLINT DEFAULT 0,
  address_quality_status VARCHAR(64) DEFAULT 'NOT_RETRIEVED',
  total_price NUMERIC DEFAULT 0,
  shipping_cost NUMERIC DEFAULT 0,
  total_order NUMERIC DEFAULT 0,
  created_at_source TIMESTAMPTZ,
  shipping_date TIMESTAMPTZ,
  printed_date TIMESTAMPTZ,
  canceling_date TIMESTAMPTZ,
  last_updated_source TIMESTAMPTZ,
  distinct_merchant_count INTEGER DEFAULT 1,
  multi_merchant_flag SMALLINT DEFAULT 0,
  distinct_warehouse_count INTEGER DEFAULT 1,
  multi_warehouse_flag SMALLINT DEFAULT 0,
  delivery_rate NUMERIC,
  delivery_rate_num INTEGER,
  delivery_rate_denom INTEGER,
  cancel_rate NUMERIC,
  cancel_rate_num INTEGER,
  cancel_rate_denom INTEGER,
  total_customer_orders INTEGER,
  customer_last_order_status VARCHAR(64),
  customer_last_order_elapsed VARCHAR(64),
  phone_repetition_count INTEGER DEFAULT 0,
  customer_delivery_warning TEXT,
  confirmation_age_category VARCHAR(64),
  state_entry_at TIMESTAMPTZ,
  validation_status VARCHAR(64) DEFAULT 'VALID',
  last_observed_at TIMESTAMPTZ DEFAULT NOW(),
  last_scan_run_id VARCHAR(64),
  raw_json JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_coo_current_status ON current_operational_orders (current_status);
CREATE INDEX IF NOT EXISTS idx_coo_random_number ON current_operational_orders (random_number);
CREATE INDEX IF NOT EXISTS idx_coo_vendoor_id ON current_operational_orders (vendoor_id);
CREATE INDEX IF NOT EXISTS idx_coo_customer_phone ON current_operational_orders (customer_phone);
CREATE INDEX IF NOT EXISTS idx_coo_multi_merchant ON current_operational_orders (multi_merchant_flag);
CREATE INDEX IF NOT EXISTS idx_coo_created_at_source ON current_operational_orders (created_at_source);
CREATE INDEX IF NOT EXISTS idx_coo_state_entry_at ON current_operational_orders (state_entry_at);
