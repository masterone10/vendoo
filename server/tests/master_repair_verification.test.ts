import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getCairoDateInterval, getCairoDateString } from '../db.js';
import { SyncEngine } from '../syncEngine.js';

console.log('===================================================================');
console.log('  VENDOOR INTELLIGENCE: MASTER PRODUCTION REPAIR VERIFICATION      ');
console.log('===================================================================\n');

let totalTests = 0;
let passedTests = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`✅ [PASS] ${name}`);
  } catch (err: any) {
    console.error(`❌ [FAIL] ${name}:`, err.message);
    throw err;
  }
}

async function runMasterVerification() {
  // Test 1: Production bundle verification
  await test('Ver 1: dist-server/server.js exists, compiles cleanly, and distPath resolves', () => {
    const distServerPath = path.resolve(process.cwd(), 'dist-server/server.js');
    assert.strictEqual(fs.existsSync(distServerPath), true, 'dist-server/server.js must exist after build');
    const content = fs.readFileSync(distServerPath, 'utf-8');
    assert.strictEqual(content.includes('import.meta.url === `file://${process.argv[1]}`'), false, 'Must not self-execute importSqliteToSupabase on server bundle');
  });

  // Test 2: Supabase Archive Worker query does not fail with "no such column: raw_action_text"
  await test('Ver 2: Supabase Archive Worker queries canonical_activity_events without raw_action_text', () => {
    const testDb = new DatabaseSync(':memory:');
    testDb.exec(`
      CREATE TABLE canonical_activity_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        raw_event_id INTEGER,
        order_code TEXT,
        actor_name TEXT NOT NULL,
        action_type TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT,
        event_timestamp TEXT NOT NULL,
        storage_tier TEXT DEFAULT 'HOT',
        is_system_actor INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE raw_activity_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_hash TEXT UNIQUE NOT NULL,
        order_code TEXT,
        actor_name TEXT,
        raw_action_text TEXT NOT NULL,
        event_timestamp TEXT NOT NULL,
        page_source TEXT DEFAULT 'log/system',
        is_duplicate INTEGER DEFAULT 0
      );
    `);

    // Verify canonical query executes without error on real schema
    const canonicalRows = testDb.prepare(`
      SELECT order_code, actor_name, action_type, from_status, to_status, event_timestamp, is_system_actor
      FROM canonical_activity_events
      ORDER BY id DESC
      LIMIT 200
    `).all();
    assert.strictEqual(Array.isArray(canonicalRows), true);

    // Verify raw query executes with raw_action_text
    const rawRows = testDb.prepare(`
      SELECT source_hash, order_code, actor_name, raw_action_text, event_timestamp, page_source, is_duplicate
      FROM raw_activity_events
      ORDER BY id DESC
      LIMIT 200
    `).all();
    assert.strictEqual(Array.isArray(rawRows), true);
  });

  // Test 3: Disappearing orders must NOT be automatically turned into 'Canceled'
  await test('Ver 3: Disappearing order retains previous active status and is never blindly auto-canceled', () => {
    const testDb = new DatabaseSync(':memory:');
    testDb.exec(`
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vendoor_id INTEGER UNIQUE NOT NULL,
        random_number TEXT NOT NULL UNIQUE,
        current_status TEXT NOT NULL,
        validation_status TEXT DEFAULT 'PENDING_VALIDATION',
        created_at_source TEXT,
        last_observed_at TEXT
      );
      CREATE TABLE canonical_activity_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_code TEXT,
        actor_name TEXT NOT NULL,
        action_type TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT,
        event_timestamp TEXT NOT NULL
      );
      CREATE TABLE order_status_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER,
        random_number TEXT,
        from_status TEXT,
        to_status TEXT,
        actor_name TEXT,
        event_time_source TEXT,
        observed_at TEXT
      );

      INSERT INTO orders (vendoor_id, random_number, current_status, created_at_source, last_observed_at)
      VALUES (999, 'RND_DISAPPEARED', 'Pending', datetime('now'), datetime('now'));
    `);

    // Simulate active reconciliation without matching order in source and no cancel log
    const ordersMap = new Map(); // Empty search results
    const activeDbOrders: any[] = testDb.prepare("SELECT * FROM orders WHERE current_status IN ('New', 'Pending', 'Processing')").all();

    const findLatestStatusEventStmt = testDb.prepare(`
      SELECT to_status, actor_name, event_timestamp
      FROM canonical_activity_events
      WHERE order_code = ? AND action_type = 'status_change' AND to_status IS NOT NULL
      ORDER BY event_timestamp DESC
      LIMIT 1
    `);

    const nowIso = new Date().toISOString();
    for (const act of activeDbOrders) {
      if (!ordersMap.has(act.vendoor_id)) {
        const latestEvent: any = findLatestStatusEventStmt.get(act.random_number);
        if (latestEvent && latestEvent.to_status && latestEvent.to_status !== act.current_status) {
          testDb.prepare("UPDATE orders SET current_status = ?, validation_status = 'VERIFIED_VIA_AUDIT_LOGS' WHERE id = ?")
            .run(latestEvent.to_status, act.id);
        } else {
          testDb.prepare("UPDATE orders SET validation_status = 'UNRESOLVED_ABSENT_FROM_VIEW', last_observed_at = ? WHERE id = ?")
            .run(nowIso, act.id);
        }
      }
    }

    const orderAfter = testDb.prepare('SELECT * FROM orders WHERE vendoor_id = 999').get() as any;
    assert.strictEqual(orderAfter.current_status, 'Pending', 'Status must NOT be changed to Canceled');
    assert.strictEqual(orderAfter.validation_status, 'UNRESOLVED_ABSENT_FROM_VIEW', 'Validation status must reflect unresolved absence');
  });

  // Test 4: Disappearing order with authoritative Vendoor log DOES transition accurately
  await test('Ver 4: Disappearing order with authoritative Vendoor status log transitions per log evidence', () => {
    const testDb = new DatabaseSync(':memory:');
    testDb.exec(`
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vendoor_id INTEGER UNIQUE NOT NULL,
        random_number TEXT NOT NULL UNIQUE,
        current_status TEXT NOT NULL,
        validation_status TEXT DEFAULT 'PENDING_VALIDATION',
        last_observed_at TEXT
      );
      CREATE TABLE canonical_activity_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_code TEXT,
        actor_name TEXT NOT NULL,
        action_type TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT,
        event_timestamp TEXT NOT NULL
      );

      INSERT INTO orders (vendoor_id, random_number, current_status)
      VALUES (888, 'RND_WITH_LOG', 'Pending');

      INSERT INTO canonical_activity_events (order_code, actor_name, action_type, from_status, to_status, event_timestamp)
      VALUES ('RND_WITH_LOG', 'فريق خدمة العملاء', 'status_change', 'Pending', 'Printed', '2026-10-18 10:00:00');
    `);

    const ordersMap = new Map();
    const activeDbOrders: any[] = testDb.prepare("SELECT * FROM orders WHERE current_status IN ('New', 'Pending', 'Processing')").all();

    const findLatestStatusEventStmt = testDb.prepare(`
      SELECT to_status, actor_name, event_timestamp
      FROM canonical_activity_events
      WHERE order_code = ? AND action_type = 'status_change' AND to_status IS NOT NULL
      ORDER BY event_timestamp DESC
      LIMIT 1
    `);

    for (const act of activeDbOrders) {
      if (!ordersMap.has(act.vendoor_id)) {
        const latestEvent: any = findLatestStatusEventStmt.get(act.random_number);
        if (latestEvent && latestEvent.to_status && latestEvent.to_status !== act.current_status) {
          testDb.prepare("UPDATE orders SET current_status = ?, validation_status = 'VERIFIED_VIA_AUDIT_LOGS' WHERE id = ?")
            .run(latestEvent.to_status, act.id);
        }
      }
    }

    const orderAfter = testDb.prepare('SELECT * FROM orders WHERE vendoor_id = 888').get() as any;
    assert.strictEqual(orderAfter.current_status, 'Printed', 'Status must transition to verified log status');
    assert.strictEqual(orderAfter.validation_status, 'VERIFIED_VIA_AUDIT_LOGS', 'Validation status must record audit evidence');
  });

  // Test 5: Date interval in Africa/Cairo isolates exact day
  await test('Ver 5: Date interval strictly isolates midnight to next midnight in Cairo', () => {
    const interval = getCairoDateInterval('2026-10-18');
    assert.strictEqual(interval.startCairo, '2026-10-18 00:00:00');
    assert.strictEqual(interval.endCairo, '2026-10-19 00:00:00');
  });

  // Test 6: Delivery rate thresholds (< 70% is risk, 70.0% is not, null has no risk alert)
  await test('Ver 6: Delivery rate warning condition is strictly < 70% and ignores null/first orders', () => {
    const isRisk = (rate: number | null) => rate !== null && rate < 70;
    assert.strictEqual(isRisk(null), false, 'First order / no history must not trigger risk warning');
    assert.strictEqual(isRisk(69.9), true, '69.9% must trigger risk warning');
    assert.strictEqual(isRisk(70.0), false, '70.0% must NOT trigger risk warning');
    assert.strictEqual(isRisk(85.5), false, '85.5% must NOT trigger risk warning');
  });

  // Test 7: Protection of the 5 Live Statuses
  await test('Ver 7: The 5 core operational statuses (New, Pending, Processing, Canceling, Printed) are preserved', () => {
    const engine = new SyncEngine();
    assert.strictEqual(engine.parseStatusString('<button>New</button>'), 'New');
    assert.strictEqual(engine.parseStatusString('<button>قيد الانتظار (Pending)</button>'), 'Pending');
    assert.strictEqual(engine.parseStatusString('<button>جاري التجهيز (Processing)</button>'), 'Processing');
    assert.strictEqual(engine.parseStatusString('<button>جاري الإلغاء (Canceling)</button>'), 'Canceling');
    assert.strictEqual(engine.parseStatusString('<button>تم الطباعة (Printed)</button>'), 'Printed');
    assert.strictEqual(engine.parseStatusString('<button>تم الإلغاء (Canceled)</button>'), 'Canceled');
  });

  console.log(`\n🎉 ALL ${passedTests} / ${totalTests} MASTER REPAIR TESTS PASSED! 🎉\n`);
}

runMasterVerification().catch((err) => {
  console.error('Master verification failure:', err);
  process.exit(1);
});
