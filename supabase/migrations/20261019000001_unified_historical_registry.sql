-- ============================================================================
-- VENDOOR OPERATIONS INTELLIGENCE — UNIFIED HISTORICAL REGISTRY SCHEMA ENHANCEMENTS
-- Additive Migration: 20261019000001
-- Description: Adds unified data_source, local_storage_status, remote_archive_status,
--              and batch tracking columns to historical_coverage, raw_activity_events,
--              and canonical_activity_events in Supabase PostgreSQL.
-- ============================================================================

DO $$
BEGIN
  -- 1. historical_coverage enhancements
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'historical_coverage' AND column_name = 'timezone') THEN
    ALTER TABLE historical_coverage ADD COLUMN timezone TEXT DEFAULT 'Africa/Cairo';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'historical_coverage' AND column_name = 'data_source') THEN
    ALTER TABLE historical_coverage ADD COLUMN data_source TEXT DEFAULT 'VENDOOR_FETCH';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'historical_coverage' AND column_name = 'canonical_events_count') THEN
    ALTER TABLE historical_coverage ADD COLUMN canonical_events_count INTEGER DEFAULT 0;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'historical_coverage' AND column_name = 'duplicates_count') THEN
    ALTER TABLE historical_coverage ADD COLUMN duplicates_count INTEGER DEFAULT 0;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'historical_coverage' AND column_name = 'review_rows_count') THEN
    ALTER TABLE historical_coverage ADD COLUMN review_rows_count INTEGER DEFAULT 0;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'historical_coverage' AND column_name = 'batch_id') THEN
    ALTER TABLE historical_coverage ADD COLUMN batch_id TEXT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'historical_coverage' AND column_name = 'local_storage_status') THEN
    ALTER TABLE historical_coverage ADD COLUMN local_storage_status TEXT DEFAULT 'LOCAL_SAVED';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'historical_coverage' AND column_name = 'remote_archive_status') THEN
    ALTER TABLE historical_coverage ADD COLUMN remote_archive_status TEXT DEFAULT 'PENDING_REMOTE';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'historical_coverage' AND column_name = 'last_import_at') THEN
    ALTER TABLE historical_coverage ADD COLUMN last_import_at TIMESTAMPTZ;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'historical_coverage' AND column_name = 'last_vendoor_fetch_at') THEN
    ALTER TABLE historical_coverage ADD COLUMN last_vendoor_fetch_at TIMESTAMPTZ;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'historical_coverage' AND column_name = 'last_supabase_verified_at') THEN
    ALTER TABLE historical_coverage ADD COLUMN last_supabase_verified_at TIMESTAMPTZ;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'historical_coverage' AND column_name = 'verified_at') THEN
    ALTER TABLE historical_coverage ADD COLUMN verified_at TIMESTAMPTZ;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'historical_coverage' AND column_name = 'source_file_names') THEN
    ALTER TABLE historical_coverage ADD COLUMN source_file_names TEXT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'historical_coverage' AND column_name = 'notes') THEN
    ALTER TABLE historical_coverage ADD COLUMN notes TEXT;
  END IF;

  -- 2. raw_activity_events enhancements
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'raw_activity_events' AND column_name = 'data_source') THEN
    ALTER TABLE raw_activity_events ADD COLUMN data_source TEXT DEFAULT 'VENDOOR_FETCH';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'raw_activity_events' AND column_name = 'import_id') THEN
    ALTER TABLE raw_activity_events ADD COLUMN import_id TEXT;
  END IF;

  -- 3. canonical_activity_events enhancements
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'canonical_activity_events' AND column_name = 'data_source') THEN
    ALTER TABLE canonical_activity_events ADD COLUMN data_source TEXT DEFAULT 'VENDOOR_FETCH';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'canonical_activity_events' AND column_name = 'import_id') THEN
    ALTER TABLE canonical_activity_events ADD COLUMN import_id TEXT;
  END IF;
END $$;
