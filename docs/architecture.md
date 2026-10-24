# Vendoor Operations Intelligence — System Architecture

## 1. Overview & Core Philosophy

Vendoor Operations Intelligence is an enterprise-grade tracking and analytics engine designed to extract, reconcile, and audit operational data from Vendoor e-commerce systems. It operates under strict integrity guarantees:
- **Zero Data Loss**: Append-only event tracking; historical records and raw logs are never deleted or truncated.
- **Strict Read-Only Source Access**: All external scraping and polling rely exclusively on idempotent `GET` operations.
- **Event-Driven Metrics**: Metrics such as Confirmed Orders (`Printed`) and Canceled Orders (`Cancel`) are derived strictly from daily event log transitions, not mutable current order states.
- **Graceful Failure Pathways**: Clear error boundaries with zero fallback to silent zeroes, false empty states, or endless loading indicators.

---

## 2. High-Level Component Flow

```
                      +---------------------------------------+
                      |       External Vendoor Source         |
                      |  (HTML Dashboard / Excel Log Exports) |
                      +---------------------------------------+
                                          |
                      [Strict Read-Only GET / Signature Check]
                                          v
                      +---------------------------------------+
                      |         Vendoor Client Engine         |
                      | - Session Auth & Cookie Heartbeat     |
                      | - HTML Login Page Rejection Guard     |
                      | - Buffer Streaming & Retry Bounds     |
                      +---------------------------------------+
                                          |
                                          v
                      +---------------------------------------+
                      |        Ingestion & Normalization      |
                      | - Cairo Timezone Interval Bounding    |
                      | - Canonical Activity Event Parsing    |
                      | - Employee / System Actor Separation  |
                      +---------------------------------------+
                                          |
                                          v
                      +---------------------------------------+
                      |      Primary Local Authority          |
                      |           (SQLite WAL)                |
                      | - raw_system_logs & canonical_events  |
                      | - orders, order_items, alerts         |
                      | - historical_coverage tracking        |
                      +---------------------------------------+
                                          |
                 +------------------------+------------------------+
                 |                                                 |
  [Archival Worker: Post-2026-10-23]               [Analytical API Routes]
                 v                                                 v
+----------------------------------+              +----------------------------------+
|    Cloud Archive (Supabase)      |              |      Express API Layer           |
| - Connection Pool Isolation      |              | - Multi-State Reports (JSON)     |
| - Two-Sided Count Verification   |              | - Structured RFC Error Codes     |
| - Idempotent Batch Synchronization|              | - Vite SPA Frontend Middleware  |
+----------------------------------+              +----------------------------------+
```

---

## 3. Storage Architecture: Hybrid Local & Cloud Archive

The system adopts a hybrid storage strategy balancing sub-millisecond local analytical performance with long-term cloud durability:

### A. Local SQLite Authority (`data/vendoor_intelligence.sqlite`)
- Configured with `PRAGMA journal_mode = WAL` and `PRAGMA synchronous = NORMAL`.
- Holds the authoritative historical data prior to **October 23, 2026 (`Africa/Cairo`)**.
- Holds the full working set of active orders, raw logs, item details, and status transition logs.
- Schema upgrades are managed idempotently through runtime migration checks (`PRAGMA table_info`) without altering existing rows.

### B. Cloud Archive (`Supabase PostgreSQL`)
- Serves as the persistent cloud replica for operations recorded on or after **October 23, 2026 (`Africa/Cairo`)**.
- Pre-cutoff data (`< 2026-10-23`) is strictly preserved locally and never uploaded to Supabase, guaranteeing compliance with the historical baseline cutoff.
- Connection management utilizes an isolated connection pool with guarded error listeners to prevent cascading connection teardowns.
- Synchronization requires exact count parity (`remoteCount >= localCount`) before marking a day as `REMOTE_VERIFIED`.

---

## 4. Ingestion & Security Hardening

1. **Early Environment Bootstrapping (`server/env.ts`)**:
   In ESM environments, imports are resolved prior to module execution. `server/env.ts` executes `dotenv.config()` synchronously upon evaluation, guaranteeing that all database paths, port definitions, and credentials are valid before database connections open.

2. **Source Integrity & Login Redirect Guards**:
   Vendoor returns HTTP 200 with HTML markup when authentication expires. Both the HTML parser and Excel binary parser inspect payloads for login markers and file magic numbers (ZIP / OLE), rejecting non-data responses with `VENDOOR_AUTH_REQUIRED` rather than recording empty data.

3. **Status Integrity & Deduplication**:
   - Status changes are attributed to specific employees, filtering out automated system duplicates.
   - Bursts of identical status transitions within tight timeframes are deduplicated safely while preserving genuine re-entries.
