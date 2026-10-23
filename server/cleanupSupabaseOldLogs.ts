import { pgQuery, getSupabasePool } from './supabaseClient.ts';

const BATCH_SIZE = 15000;

async function runCleanup() {
  console.log('================================================================================');
  console.log('  STARTING SUPABASE SPACE RECLAMATION & LOGS ARCHIVE RESET TO 2026-10-23        ');
  console.log('================================================================================\n');

  // Step 1: Pre-cleanup size and counts
  const initialDbSize = await pgQuery('SELECT pg_size_pretty(pg_database_size(current_database())) as size');
  console.log(`[Status] Initial Supabase Database Size: ${initialDbSize.rows[0].size}\n`);

  // Step 2: Clean backup tables first
  console.log('--- Phase 1: Cleaning Obsolete Backup Tables ---');
  
  // 1a. backup_20261021_historical_coverage
  try {
    const res = await pgQuery('DELETE FROM backup_20261021_historical_coverage');
    console.log(`  Deleted ${res.rowCount} rows from backup_20261021_historical_coverage`);
  } catch (e: any) {
    console.log(`  Note on backup_20261021_historical_coverage: ${e.message}`);
  }

  // 1b. backup_20261021_canonical_activity_events (in chunks)
  try {
    let bCanonDeletedTotal = 0;
    while (true) {
      const res = await pgQuery(`
        WITH to_del AS (
          SELECT ctid FROM backup_20261021_canonical_activity_events LIMIT ${BATCH_SIZE}
        )
        DELETE FROM backup_20261021_canonical_activity_events
        WHERE ctid IN (SELECT ctid FROM to_del)
      `);
      const count = res.rowCount || 0;
      if (count === 0) break;
      bCanonDeletedTotal += count;
      console.log(`  backup_20261021_canonical_activity_events: deleted ${count} rows (total: ${bCanonDeletedTotal.toLocaleString()})...`);
    }
    console.log(`  ✅ Finished backup_20261021_canonical_activity_events: ${bCanonDeletedTotal.toLocaleString()} rows deleted.`);
  } catch (e: any) {
    console.log(`  Note on backup_20261021_canonical_activity_events: ${e.message}`);
  }

  // 1c. backup_20261021_raw_activity_events (in chunks)
  try {
    let bRawDeletedTotal = 0;
    while (true) {
      const res = await pgQuery(`
        WITH to_del AS (
          SELECT ctid FROM backup_20261021_raw_activity_events LIMIT ${BATCH_SIZE}
        )
        DELETE FROM backup_20261021_raw_activity_events
        WHERE ctid IN (SELECT ctid FROM to_del)
      `);
      const count = res.rowCount || 0;
      if (count === 0) break;
      bRawDeletedTotal += count;
      console.log(`  backup_20261021_raw_activity_events: deleted ${count} rows (total: ${bRawDeletedTotal.toLocaleString()})...`);
    }
    console.log(`  ✅ Finished backup_20261021_raw_activity_events: ${bRawDeletedTotal.toLocaleString()} rows deleted.`);
  } catch (e: any) {
    console.log(`  Note on backup_20261021_raw_activity_events: ${e.message}`);
  }

  // Step 3: Clean canonical_activity_events before 2026-10-23 Africa/Cairo
  console.log('\n--- Phase 2: Cleaning canonical_activity_events (< 2026-10-23 Cairo) ---');
  let canonDeletedTotal = 0;
  while (true) {
    const res = await pgQuery(`
      WITH to_del AS (
        SELECT id FROM canonical_activity_events
        WHERE event_timestamp < ('2026-10-23 00:00:00'::timestamp AT TIME ZONE 'Africa/Cairo')
        LIMIT ${BATCH_SIZE}
      )
      DELETE FROM canonical_activity_events
      WHERE id IN (SELECT id FROM to_del)
    `);
    const cCount = res.rowCount || 0;
    if (cCount === 0) break;
    canonDeletedTotal += cCount;
    console.log(`  canonical_activity_events: deleted ${cCount} rows (total: ${canonDeletedTotal.toLocaleString()})...`);
  }
  console.log(`  ✅ Finished canonical_activity_events: ${canonDeletedTotal.toLocaleString()} rows deleted.`);

  // Step 4: Clean raw_activity_events before 2026-10-23 Africa/Cairo
  console.log('\n--- Phase 3: Cleaning raw_activity_events (< 2026-10-23 Cairo) ---');
  let rawDeletedTotal = 0;
  while (true) {
    const res = await pgQuery(`
      WITH to_del AS (
        SELECT id FROM raw_activity_events
        WHERE event_timestamp < ('2026-10-23 00:00:00'::timestamp AT TIME ZONE 'Africa/Cairo')
        LIMIT ${BATCH_SIZE}
      )
      DELETE FROM raw_activity_events
      WHERE id IN (SELECT id FROM to_del)
    `);
    const rCount = res.rowCount || 0;
    if (rCount === 0) break;
    rawDeletedTotal += rCount;
    console.log(`  raw_activity_events: deleted ${rCount} rows (total: ${rawDeletedTotal.toLocaleString()})...`);
  }
  console.log(`  ✅ Finished raw_activity_events: ${rawDeletedTotal.toLocaleString()} rows deleted.`);

  // Step 5: Clean historical_coverage before 2026-10-23
  console.log('\n--- Phase 4: Cleaning historical_coverage (< 2026-10-23) ---');
  try {
    const res = await pgQuery("DELETE FROM historical_coverage WHERE period_date < '2026-10-23'");
    console.log(`  ✅ historical_coverage: deleted ${res.rowCount} rows.`);
  } catch (e: any) {
    console.log(`  Note on historical_coverage: ${e.message}`);
  }

  // Step 6: Verify preserved rows
  console.log('\n--- Phase 5: Verification of Preserved Data ---');
  const remainingRaw = await pgQuery('SELECT COUNT(*) as c FROM raw_activity_events');
  const remainingCanon = await pgQuery('SELECT COUNT(*) as c FROM canonical_activity_events');
  const preservedOrders = await pgQuery('SELECT COUNT(*) as c FROM orders');
  const preservedItems = await pgQuery('SELECT COUNT(*) as c FROM order_items');

  console.log(`  raw_activity_events remaining (>= 2026-10-23):       ${parseInt(remainingRaw.rows[0].c, 10).toLocaleString()} rows`);
  console.log(`  canonical_activity_events remaining (>= 2026-10-23): ${parseInt(remainingCanon.rows[0].c, 10).toLocaleString()} rows`);
  console.log(`  orders preserved (100% untouched):                   ${parseInt(preservedOrders.rows[0].c, 10).toLocaleString()} rows`);
  console.log(`  order_items preserved (100% untouched):              ${parseInt(preservedItems.rows[0].c, 10).toLocaleString()} rows`);

  // Step 7: VACUUM ANALYZE to reclaim space
  console.log('\n--- Phase 6: Running VACUUM ANALYZE to reclaim disk space ---');
  try {
    await pgQuery('VACUUM ANALYZE canonical_activity_events');
    console.log('  VACUUM ANALYZE canonical_activity_events complete.');
  } catch (e: any) {
    console.log('  VACUUM canonical_activity_events skipped:', e.message);
  }

  try {
    await pgQuery('VACUUM ANALYZE raw_activity_events');
    console.log('  VACUUM ANALYZE raw_activity_events complete.');
  } catch (e: any) {
    console.log('  VACUUM raw_activity_events skipped:', e.message);
  }

  // Final database size
  const finalDbSize = await pgQuery('SELECT pg_size_pretty(pg_database_size(current_database())) as size');
  console.log(`\n[Status] Final Supabase Database Size: ${finalDbSize.rows[0].size} (was ${initialDbSize.rows[0].size})`);

  console.log('\n================================================================================');
  console.log('  🎉 SUPABASE SPACE RECLAMATION COMPLETED SUCCESSFULLY! 🎉                      ');
  console.log('================================================================================\n');

  process.exit(0);
}

runCleanup().catch(err => {
  console.error('Cleanup failed with error:', err);
  process.exit(1);
});
