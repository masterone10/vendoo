# Vendoor Operations Intelligence

[![Node.js](https://img.shields.io/badge/Node.js-22.x-green.svg)](https://nodejs.org/)
[![Database](https://img.shields.io/badge/Storage-SQLite%20WAL%20%2B%20Supabase-blue.svg)](https://supabase.com/)
[![Timezone](https://img.shields.io/badge/Timezone-Africa%2FCairo-orange.svg)](#)

Vendoor Operations Intelligence is a production-grade operational analytics and audit tracking platform built for high-volume e-commerce fulfillment operations on the Vendoor platform.

---

## Key Capabilities

- **Operational Timeline & Status Tracing**: Append-only event tracking for order lifecycle transitions (`New`, `Pending`, `Processing`, `Canceling`, `Printed`, `Canceled`).
- **Audit-Accurate Metrics**: Metrics for Confirmed Orders (`Printed`) and Canceled Orders (`Cancel`) are derived strictly from daily log events, not mutable snapshot states.
- **Multi-Merchant Anomaly Scanner**: Detects and alerts on single orders containing products fulfilling from disparate merchant entities before dispatch.
- **Hardened Reporting Flow**: Multi-state UI handling (`idle`, `loading`, `success`, `empty`, `partial`, `error`) with structured RFC error responses, `requestId` tracing, and retry resilience.
- **Zero-Loss Hybrid Architecture**:
  - **Authoritative Cutoff**: **October 23, 2026 (`Africa/Cairo`)**.
  - Historical records prior to `2026-10-23` reside safely in local SQLite and are never pushed to the cloud.
  - Records on or after `2026-10-23` are archived to Supabase PostgreSQL with two-sided count parity verification.

---

## Quickstart

### 1. Prerequisites
- Node.js 22.x LTS
- npm or bun

### 2. Environment Configuration
Copy `.env.example` to `.env` and fill in your credentials:
```bash
cp .env.example .env
```

### 3. Build & Run

```bash
# Install dependencies
npm install

# Build client and server bundles
npm run build

# Start production server
npm start
```

For development:
```bash
npm run dev
```

---

## Automated Verification & Testing

The repository contains an exhaustive test suite covering all operational invariants:

```bash
# Run unit tests (requirements, transition dedup, Cairo intervals)
npm run test:unit

# Run integration tests (API pipelines, report failure states, acceptance)
npm run test:integration

# Run full regression & reconciliation master test suite
npm test
```

---

## Documentation Index

- [Architecture & Data Flow](docs/architecture.md) — Detailed explanation of ingestion, local authority, cloud archive, and security hardening.
- [Data Retention & Cutoff Policy](docs/data-retention.md) — The October 23, 2026 cutoff rules and historical coverage tiers.
- [Operational Runbook & Troubleshooting](docs/operations.md) — Session drops, timeout tuning, schema integrity, and failure states.
- [Antigravity Deployment Guide](docs/antigravity-setup.md) — Step-by-step instructions for container and cloud deployments.
- [Supabase Setup Guide](SUPABASE_SETUP.md) — PostgreSQL database schema and connection setup.
