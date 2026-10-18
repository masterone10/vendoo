# Vendoor Operations Intelligence — Supabase PostgreSQL Setup & Fresh Baseline Guide

Starting **October 17, 2026 (`Africa/Cairo` timezone)**, Vendoor Operations Intelligence runs directly on **Supabase PostgreSQL** as its single authoritative persistent database.

Legacy SQLite data is **not imported**. Instead, the application starts fresh by acquiring a complete, verified live baseline from Vendoor and permanently storing all operational history, status changes, and logs in Supabase from this point forward.

---

## 1. Required Environment Variables

Configure these variables in **Google AI Studio's Server-Side Secrets / Environment Settings**.
**Never** put secret keys into frontend code, browser bundles, or `VITE_*` variables.

| Variable Name | Required | Description | Example / Source |
|---|---|---|---|
| `DATABASE_URL` | **Yes (Authoritative)** | Supabase PostgreSQL Connection URI with SSL | `postgresql://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres?sslmode=require` |
| `VENDOOR_EMAIL` | **Yes (for live sync)** | Vendoor Operations login email | `ops@example.com` |
| `VENDOOR_PASSWORD` | **Yes (for live sync)** | Vendoor Operations login password | `********` |
| `SYNC_INTERVAL_SECONDS` | Optional | Recurring sync cycle interval (default: `300` seconds / 5 mins) | `300` |
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
5. In **Google AI Studio**, open project settings / Secrets and paste the value as `DATABASE_URL`.

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
* Once `DATABASE_URL` is configured, navigate to the **Settings (الإعدادات والربط)** tab in the sidebar and click **"تطبيق الميجريشن (Apply Schema)"**. The server applies the migration directly via `/api/supabase/migrate`.

---

## 4. Fresh Live Baseline Process (From October 17, 2026)

On the first successful sync:
1. **Full Status Acquisition**:
   - Acquires the complete population for every status: `New`, `Pending`, `Processing`, `Canceling`, `Printed`, `Canceled`.
   - Paginates through 100% of source records (not just the first 100).
2. **Canonical Identity**:
   - Stores one canonical Supabase order per verified source `vendoor_id`.
   - Distinct from `random_number` (الرقم العشوائي) and `order_type`.
3. **Preserving Original Timestamps**:
   - Preserves the verified original Vendoor `created_at` timestamp (even if older than Oct 17, 2026) so Pending age calculations remain 100% accurate.
   - Records a separate `state_entry_at` and `last_observed_at` baseline timestamp.
4. **Historical Archive from Today**:
   - Starting October 17, 2026, all status transitions, employee actions, logs, and daily snapshots are permanently archived in Supabase.
   - If historical logs prior to the collection start are unavailable, they remain accurately classified as `Unknown` rather than fabricating artificial events.

---

## 5. Verification & Live Parity

* **Check Status via API**:
  `GET /api/supabase/status` returns connection latency, table row counts, and schema readiness.
* **Source/Local Reconciliation**:
  `GET /api/sync/reconcile` performs complete ID-set and status parity reconciliation between Vendoor and Supabase.
* **Fail-Safe Policy**:
  If Supabase is configured but temporarily unreachable, the app returns a clean connection error and will **never** silently fall back to stale SQLite data.
