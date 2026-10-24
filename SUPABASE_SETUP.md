# Vendoor Operations Intelligence — Supabase PostgreSQL Setup & Cutoff Guide

Starting **October 23, 2026 (`Africa/Cairo` timezone)**, Vendoor Operations Intelligence operates in a hardened **Hybrid Local-Cloud Architecture**:
- **SQLite Local Authority (`data/vendoor_intelligence.sqlite`)**: Retains historical data prior to October 23, 2026 and provides sub-millisecond local analytical reads.
- **Supabase PostgreSQL**: Acts as the authoritative cloud archive for all operational records, status transitions, and system logs recorded on or after **October 23, 2026**.
- **Historical Protection**: Records created prior to October 23, 2026 are preserved locally in SQLite and are strictly excluded from Supabase uploads to prevent corrupting the cloud baseline.

---

## 1. Required Environment Variables

Configure these variables in your deployment environment or container secrets:

| Variable Name | Required | Description | Example / Source |
|---|---|---|---|
| `DATABASE_URL` | **Yes (for Cloud Archive)** | Supabase PostgreSQL Connection URI with SSL | `postgresql://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres?sslmode=require` |
| `DATABASE_PATH` | Optional | SQLite local database path (default: `data/vendoor_intelligence.sqlite`) | `data/vendoor_intelligence.sqlite` |
| `VENDOOR_EMAIL` | **Yes (for live sync)** | Vendoor Operations login email | `ops@example.com` |
| `VENDOOR_PASSWORD` | **Yes (for live sync)** | Vendoor Operations login password | `********` |
| `SYNC_INTERVAL_SECONDS` | Optional | Recurring sync cycle interval (default: `45` seconds) | `45` |
| `TIMEZONE` | Optional | Business timezone (default: `Africa/Cairo`) | `Africa/Cairo` |

> **Connection Note**: Using the Supabase **Transaction Pooler** (port `6543`) with `?sslmode=require` is recommended for cloud container environments.

---

## 2. Where to Obtain Supabase Connection URI

1. Log in to your [Supabase Dashboard](https://supabase.com/dashboard).
2. Open your project.
3. Navigate to **Project Settings** (gear icon) -> **Database**.
4. Under **Connection string**:
   - Select **URI**.
   - Choose **Transaction** mode (port `6543`).
   - Copy the URI and replace `[YOUR-PASSWORD]` with your actual Supabase database password.
5. Set the copied connection URI as the `DATABASE_URL` environment variable.

---

## 3. Applying the Schema Migration

The schema must be applied once to create tables, constraints, indexes, and security policies before the initial baseline begins:

### Method A: Supabase Dashboard SQL Editor (Recommended)
1. In your Supabase Dashboard, click on **SQL Editor** in the left sidebar.
2. Click **New Query**.
3. Open and copy the entire contents of:
   `supabase/migrations/20261017000001_create_vendoor_intelligence_schema.sql`
4. Paste it into the SQL Editor and click **Run**.
5. All tables (`orders`, `order_items`, `order_status_events`, `alerts`, `sync_runs`, `historical_coverage`, etc.) are created safely and idempotently (`IF NOT EXISTS`).

### Method B: Via Built-in Application UI
- Once `DATABASE_URL` is configured, navigate to the **Settings (الإعدادات والربط)** tab in the sidebar and click **"تطبيق الميجريشن (Apply Schema)"**. The server applies the migration directly via `/api/supabase/migrate`.

---

## 4. Live Baseline & Archive Process (From October 23, 2026)

On every synchronization cycle:
1. **Full Status Acquisition**:
   - Acquires the complete population for every status: `New`, `Pending`, `Processing`, `Canceling`, `Printed`, `Canceled`.
   - Paginates through 100% of source records without truncation.
2. **Canonical Identity**:
   - Stores one canonical order per verified source `vendoor_id`.
   - Distinguishes random order numbers (`random_number`) from internal database IDs.
3. **Preserving Original Timestamps**:
   - Preserves verified original Vendoor `created_at` timestamps so Pending age calculations remain accurate.
   - Records discrete `state_entry_at` timestamps for operational aging analysis.
4. **Historical Archive Isolation**:
   - All events on or after October 23, 2026 are archived to Supabase with count verification.
   - If pre-2026-10-23 sync is triggered, the worker safely skips cloud upload, logging a confirmation message.

---

## 5. Verification & Live Parity

- **Check Status via API**:
  `GET /api/supabase/status` returns connection latency, table row counts, and schema readiness.
- **Source/Local Reconciliation**:
  `GET /api/sync/reconcile` performs complete ID-set and status parity reconciliation between Vendoor and Supabase.
- **Fail-Safe Policy**:
  If Supabase is configured but temporarily unreachable, the app handles errors smoothly and continues servicing live tracking via SQLite without service interruptions.
