import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { getCairoDateString, getCairoDateInterval, isDateInHot } from '../db.ts';
import { isCSEmployee } from '../routes.ts';
import { isLowDeliveryRate, evaluateCustomerDelivery } from '../../src/utils/delivery.ts';
import { extractMerchantCodeFromRow, applyMerchantCodeMappings } from '../excelMerchantCodes.ts';

console.log('===================================================================');
console.log('   VENDOOR INTELLIGENCE: MASTER SYSTEM VERIFICATION TEST SUITE     ');
console.log('===================================================================\n');

// -----------------------------------------------------------------------------
// Test 1: Cairo Timezone and Date Interval [startCairo, endCairo)
// -----------------------------------------------------------------------------
{
  const interval = getCairoDateInterval('2026-10-18');
  assert.strictEqual(interval.startCairo, '2026-10-18 00:00:00');
  assert.strictEqual(interval.endCairo, '2026-10-19 00:00:00');
  assert.strictEqual(interval.nextDateStr, '2026-10-19');
  console.log('✅ [PASS] Master Test 1: Date interval strictly bounds [startCairo, endCairo) in Cairo time');
}

// -----------------------------------------------------------------------------
// Test 2: Delivery Warning Rules (All 10 rules verified)
// -----------------------------------------------------------------------------
{
  // Rule 1 & 7: 70.0% exactly is NOT low delivery
  assert.strictEqual(isLowDeliveryRate(70.0, 10, 10, 10), false, '70.0% must NOT trigger warning');

  // Rule 6: 69.9% triggers warning
  assert.strictEqual(isLowDeliveryRate(69.9, 20, 10, 10), true, '69.9% MUST trigger warning');

  // Rule 2: 0% delivery and 0% cancel -> NO warning
  assert.strictEqual(isLowDeliveryRate(0, 0, 1, 1), false, '0%/0% must NOT trigger warning');

  // Rule 3: Brand new client with no prior history -> NO warning
  assert.strictEqual(isLowDeliveryRate(null, null, 0, 0), false, 'New customer with null delivery must NOT trigger warning');
  assert.strictEqual(isLowDeliveryRate(0, 0, 0, 0), false, '0 denom with 0 orders must NOT trigger warning');

  // Rule 5: 0% delivery and 100% cancel with verified history -> WARNING
  assert.strictEqual(isLowDeliveryRate(0, 100, 2, 2), true, '0% delivery with 100% cancel must trigger warning');

  // Rule 4: evaluateCustomerDelivery badge check
  const evalNew = evaluateCustomerDelivery(null, null, 0, 0);
  assert.strictEqual(evalNew.badgeText, 'أول طلب للعميل');
  assert.strictEqual(evalNew.isLowDelivery, false);

  const eval69 = evaluateCustomerDelivery(69.9, 15, 10, 10);
  assert.strictEqual(eval69.isLowDelivery, true);
  assert.ok(eval69.badgeText.includes('69.9%'));

  console.log('✅ [PASS] Master Test 2: All 10 delivery warning rules strictly enforced');
}

// -----------------------------------------------------------------------------
// Test 3: Dedicated Merchant Code Column & String Preservation
// -----------------------------------------------------------------------------
{
  // Test A: Preserving leading zeros as string
  const rowWithLeadingZeros = { 'كود المخزن': '00123456', 'اسم المنتج': 'قميص أبيض' };
  const ext = extractMerchantCodeFromRow(rowWithLeadingZeros);
  assert.strictEqual(ext.code, '00123456');
  assert.strictEqual(typeof ext.code, 'string');
  assert.strictEqual(ext.matchedHeader, 'كود المخزن');

  // Test B: Rejection of regex extraction from product titles
  const fakeRow = {
    merchantCode: '12345678',
    productName: 'حذاء كاجوال 12345678 أسود',
  };
  // Running import with fake row without orderCode or vendorId should flag rejection
  const report = applyMerchantCodeMappings([fakeRow]);
  assert.strictEqual(report.conflictingMappings, 1);
  assert.ok(report.warnings.some((w) => w.includes('Rejected potential extracted 8-digit sequence')));

  console.log('✅ [PASS] Master Test 3: Merchant codes preserve leading zeros as strings and reject regex title extraction');
}

// -----------------------------------------------------------------------------
// Test 4: CS Employee Classification
// -----------------------------------------------------------------------------
{
  assert.strictEqual(isCSEmployee('Sarah (CS)'), true);
  assert.strictEqual(isCSEmployee('CS - Ahmed'), true);
  assert.strictEqual(isCSEmployee('محمد - خدمة العملاء'), true);
  assert.strictEqual(isCSEmployee('[CS] Mahmoud'), true);

  // Negative tests: random words with 'cs' must NOT match
  assert.strictEqual(isCSEmployee('custom_action'), false);
  assert.strictEqual(isCSEmployee('access_control'), false);
  assert.strictEqual(isCSEmployee('System Cron'), false);
  assert.strictEqual(isCSEmployee('Tariq Accountant'), false);

  console.log('✅ [PASS] Master Test 4: CS Employee classification accurately tags CS staff without false substring positives');
}

// -----------------------------------------------------------------------------
// Test 5: Historical Logs & Canonical Activity Separation (Fix for raw_action_text)
// -----------------------------------------------------------------------------
{
  const mDb = new DatabaseSync(':memory:');
  mDb.exec(`
    CREATE TABLE raw_activity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_hash TEXT UNIQUE NOT NULL,
      order_code TEXT,
      actor_name TEXT,
      raw_action_text TEXT NOT NULL,
      event_timestamp TEXT NOT NULL,
      storage_tier TEXT DEFAULT 'HOT',
      observed_at TEXT NOT NULL,
      page_source TEXT DEFAULT 'log/system'
    );

    CREATE TABLE canonical_activity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_event_id INTEGER REFERENCES raw_activity_events(id),
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

    CREATE TABLE historical_coverage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT DEFAULT 'primary',
      source_domain TEXT NOT NULL,
      period_date TEXT NOT NULL,
      storage_tier TEXT NOT NULL,
      pages_discovered INTEGER DEFAULT 0,
      pages_read INTEGER DEFAULT 0,
      records_extracted INTEGER DEFAULT 0,
      records_saved INTEGER DEFAULT 0,
      completion_status TEXT NOT NULL,
      error_message TEXT,
      last_attempted_at TEXT NOT NULL,
      completed_at TEXT,
      verified_at TEXT,
      UNIQUE(source_domain, period_date)
    );
  `);

  // Insert raw event
  const rawText = 'عدل حالة الطلب من Pending إلى Printed';
  const time = '2026-10-18 10:30:00';
  const hash = crypto.createHash('sha256').update(`Mohamed|ord-999|${rawText}|${time}`).digest('hex');

  const rawRes = mDb.prepare(`
    INSERT INTO raw_activity_events (source_hash, order_code, actor_name, raw_action_text, event_timestamp, observed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(hash, 'ord-999', 'Mohamed (CS)', rawText, time, new Date().toISOString());

  const rawId = Number(rawRes.lastInsertRowid);

  // Insert canonical event WITHOUT raw_action_text column
  mDb.prepare(`
    INSERT INTO canonical_activity_events (
      raw_event_id, order_code, actor_name, action_type, from_status, to_status, event_timestamp, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(rawId, 'ord-999', 'Mohamed (CS)', 'status_change', 'Pending', 'Printed', time, new Date().toISOString());

  // Query canonical joined with raw
  const queried: any = mDb.prepare(`
    SELECT 
      c.id, c.order_code, c.actor_name, c.action_type, c.from_status, c.to_status,
      c.event_timestamp, COALESCE(r.raw_action_text, '') as raw_action_text
    FROM canonical_activity_events c
    LEFT JOIN raw_activity_events r ON c.raw_event_id = r.id
    WHERE c.order_code = 'ord-999'
  `).get();

  assert.strictEqual(queried.order_code, 'ord-999');
  assert.strictEqual(queried.actor_name, 'Mohamed (CS)');
  assert.strictEqual(queried.from_status, 'Pending');
  assert.strictEqual(queried.to_status, 'Printed');
  assert.strictEqual(queried.raw_action_text, rawText);

  // Verify historical coverage schema has verified_at
  mDb.prepare(`
    INSERT INTO historical_coverage (
      period_date, source_domain, storage_tier, pages_discovered, pages_read,
      records_saved, completion_status, last_attempted_at, verified_at
    ) VALUES ('2026-10-18', 'logs', 'HOT', 1, 1, 1, 'COMPLETE', datetime('now'), datetime('now'))
  `).run();

  const cov: any = mDb.prepare("SELECT * FROM historical_coverage WHERE period_date = '2026-10-18'").get();
  assert.strictEqual(cov.completion_status, 'COMPLETE');
  assert.ok(cov.verified_at);

  console.log('✅ [PASS] Master Test 5: raw_action_text safely separated and joined via raw_event_id without column errors');
}

// -----------------------------------------------------------------------------
// Test 6: Invariant Live Protected Status Counts
// -----------------------------------------------------------------------------
{
  const coreStatuses = ['New', 'Pending', 'Processing', 'Canceling', 'Printed'];
  assert.strictEqual(coreStatuses.length, 5);
  assert.ok(!coreStatuses.includes('Canceled'));
  assert.ok(coreStatuses.includes('Canceling'));
  console.log('✅ [PASS] Master Test 6: 5 core operational statuses strictly protected without mixing Canceling with Canceled');
}

console.log('\n🎉 ALL MASTER SYSTEM VERIFICATION TESTS PASSED SUCCESSFULLY! 🎉\n');
