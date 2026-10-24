# Vendoor Operations Intelligence — Operational Runbook & Troubleshooting

## 1. System Health Monitoring

The server exposes diagnostic endpoints for infrastructure monitoring:
- `GET /api/settings`: Returns connection status, SQLite WAL database size, and Supabase PostgreSQL pool latency.
- `GET /api/supabase/status`: Returns PostgreSQL connection status, table count verification, and schema migration state.
- `GET /api/sync/reconcile`: Runs cross-system reconciliation between Vendoor source and local/remote records.

---

## 2. Common Operational Issues & Remediation

### A. Session Expiry & Login Redirection (`VENDOOR_AUTH_REQUIRED`)
- **Symptom**: Polling log displays `[VendoorClient] Session cookie expired or redirected to login`.
- **Cause**: Vendoor invalidates operational session cookies periodically or on password update.
- **Remediation**:
  1. Verify `VENDOOR_EMAIL` and `VENDOOR_PASSWORD` in environment variables.
  2. The client automatically initiates a clean re-login handshake.
  3. Responses containing HTML login forms (`<form action="/dashboard/login"`) are rejected immediately to protect the database from storing empty records.

### B. Report Failures & Response Format Guard
- **Symptom**: Report view shows: «الخادم أرجع استجابة غير متوقعة بدل بيانات التقرير» (`INVALID_RESPONSE_FORMAT`).
- **Root Cause**: An upstream reverse proxy or misconfigured route returned HTML (e.g. `<!doctype html>`) with HTTP 200 instead of JSON.
- **Remediation**:
  1. The frontend strictly inspects the first non-whitespace characters of every response.
  2. Any response starting with `<` or missing `application/json` is categorized as `error` (never `empty` or zeros).
  3. Check the server log for the matching `[API Unhandled Error] [requestId]` to locate the unhandled exception.

### C. Supabase Pool Disconnections & Health Recovery
- **Symptom**: Server logs indicate `connection pool error` or temporary DNS timeout to AWS pooler.
- **Architecture Defense**:
  - The Supabase client encapsulates pool lifecycle management in `server/supabaseClient.ts`.
  - Error listeners are bound to specific pool references (`targetPool === pool`), preventing old tear-downs from killing renewed connection pools.
  - If Supabase is unavailable, local operations continue safely on SQLite, queuing records until cloud connectivity resumes.

### D. Missing Schema Columns (e.g., `distinct_warehouse_count`)
- **Prevention**: `server/db.ts` contains `ensureOrdersColumnsExist()` which queries `PRAGMA table_info(orders)` upon startup.
- If missing, it adds `distinct_warehouse_count INTEGER DEFAULT 0` idempotently without affecting existing rows.
