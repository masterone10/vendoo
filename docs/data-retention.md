# Vendoor Operations Intelligence — Data Retention & Cutoff Policy

## 1. Authoritative Historical Cutoff: October 23, 2026 (`Africa/Cairo`)

To guarantee data integrity and eliminate synchronization noise between legacy offline records and real-time cloud operations, Vendoor Operations Intelligence implements a strict bidirectional retention cutoff:

| Period Date Range | Primary Storage | Supabase Cloud Archive | Notes |
|---|---|---|---|
| **Before October 23, 2026** (`< 2026-10-23`) | **SQLite Local Authority** | **Excluded (Never Synced)** | Historical baseline remains safely in SQLite. Preserved for audits and historical reporting without cloud pollution. |
| **On or After October 23, 2026** (`>= 2026-10-23`) | **SQLite + Supabase** | **Active Cloud Archive** | All live orders, status events, timeline changes, and system logs are continuously archived to Supabase PostgreSQL. |

---

## 2. Retention Guarantees

### A. Non-Destructive Invariant
- **No Truncation**: No script or routine ever calls `DROP TABLE`, `TRUNCATE`, or unconstrained `DELETE` on operational tables.
- **Permanent Audit Trail**: All status movements (`New`, `Pending`, `Processing`, `Canceling`, `Printed`, `Canceled`) generate discrete rows in `canonical_activity_events` and `order_status_events`.
- **Pre-Existing Order Flag**: Orders existing prior to the first system scan are permanently flagged with `is_pre_existing = 1` and preserve their original Vendoor creation timestamp.

### B. Daily Coverage Classifications
Every calendar date in `Africa/Cairo` is registered in `historical_coverage` with one of the following authoritative states:

1. **`COMPLETE`**:
   The full population of logs has been extracted from Vendoor across 100% of discovered pages (`pages_read === pages_discovered`). Fully verified.
2. **`EMPTY_VERIFIED`**:
   The source system was queried and verified to contain zero logs for this date. Distinguished strictly from communication failures.
3. **`PARTIAL`**:
   A network timeout, rate limit, or page drop occurred during extraction. The system marks the exact pages fetched and exposes a "Partial Coverage" warning in reports.
4. **`UNVERIFIED_SOURCE`**:
   Data was ingested from an uploaded manual CSV or Excel file. Used for local analytics, but flagged so reports do not claim certified completeness.
5. **`NOT_SYNCED`**:
   No data has been captured yet for this calendar date.

---

## 3. Storage Tiers (HOT vs COLD)

- **HOT Tier**: Calendar dates within the last 30 calendar days (inclusive of today in `Africa/Cairo`). Evaluated frequently during scheduled polling loops.
- **COLD Tier**: Calendar dates older than 30 calendar days. Query results are cached locally in SQLite. Once marked `COMPLETE` or `EMPTY_VERIFIED`, COLD dates bypass repeated external scraping unless manual force-refresh is requested.
