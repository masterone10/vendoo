# Antigravity Deployment & Setup Guide

## 1. Prerequisites

- **Runtime**: Node.js `22.x` (LTS recommended)
- **Package Manager**: `npm` (or `bun`)
- **Operating System**: Linux (Ubuntu 22.04+ / Debian 12 / Docker container)
- **Local Storage**: Minimum 500MB free disk space for SQLite WAL database (`data/`)

---

## 2. Environment Configuration

Create a `.env` file in the project root based on `.env.example`:

```bash
# SQLite Local Authority Database File
DATABASE_PATH=data/vendoor_intelligence.sqlite

# Supabase PostgreSQL Connection URI (Transaction Pooler, Port 6543)
DATABASE_URL=postgresql://postgres.example:[PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require

# Vendoor Authentication Credentials
VENDOOR_EMAIL=operations@example.com
VENDOOR_PASSWORD=SecurePassword123
VENDOOR_LOGIN_URL=https://aff.ven-door.com/dashboard/login

# Operational Scheduling & Timezone
SYNC_INTERVAL_SECONDS=45
TIMEZONE=Africa/Cairo

# Server Port & Mode
PORT=3000
NODE_ENV=production
```

---

## 3. Installation & Build

```bash
# 1. Install dependencies
npm install

# 2. Compile frontend and bundle production server
npm run build
```

The build step generates:
- `dist/`: Minified client-side single page application assets.
- `dist-server/server.js`: Self-contained Node 22 ESM server executable.

---

## 4. Running the Application

### Production Mode
```bash
npm start
```
Starts the bundled server on port `3000` (or `PORT` specified in `.env`).

### Development Mode
```bash
npm run dev
```
Starts the live server with Vite middleware support.

---

## 5. Verification & Testing

Verify that all subsystems operate according to specifications:

```bash
# Run isolated unit tests
npm run test:unit

# Run end-to-end integration tests
npm run test:integration

# Run full master test suite (all 20+ regression, coverage & parity suites)
npm test
```
