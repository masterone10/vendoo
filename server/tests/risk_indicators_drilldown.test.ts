import test from 'node:test';
import assert from 'node:assert';
import { db, getCairoDateInterval, getCairoDateString } from '../db.ts';
import {
  getDashboardRiskStats,
  getRiskOrdersDrilldown,
  getRiskConditionSql,
  RiskType,
} from '../riskService.ts';

test('Unified Risk Indicators & Drilldown Service Suite', async (t) => {
  const cairoToday = getCairoDateString();
  const dateInterval = getCairoDateInterval(cairoToday);

  await t.test('1. Exact 100% numerical consistency between Dashboard Risk Stats and Drilldown Modal for all 3 risk types', () => {
    const dashboardStats = getDashboardRiskStats(cairoToday);

    const riskTypes: Array<{ type: RiskType; totalStat: number; printedStat: number }> = [
      {
        type: 'multi_merchant',
        totalStat: dashboardStats.multiMerchantTotal,
        printedStat: dashboardStats.multiMerchantPrinted,
      },
      {
        type: 'no_extra_phone',
        totalStat: dashboardStats.missingExtraPhoneTotal,
        printedStat: dashboardStats.missingExtraPhonePrinted,
      },
      {
        type: 'low_delivery',
        totalStat: dashboardStats.lowDeliveryRateTotal,
        printedStat: dashboardStats.lowDeliveryRatePrinted,
      },
    ];

    for (const { type, totalStat, printedStat } of riskTypes) {
      // 1. Fetch modal drilldown with tab='all'
      const modalAll = getRiskOrdersDrilldown({
        riskType: type,
        tab: 'all',
        date: cairoToday,
        limit: 10,
        page: 0,
      });

      assert.strictEqual(
        totalStat,
        modalAll.totalSystemMatching,
        `[${type}] totalStat (${totalStat}) must equal modalAll.totalSystemMatching (${modalAll.totalSystemMatching})`
      );
      assert.strictEqual(
        totalStat,
        modalAll.tabCounts.all,
        `[${type}] totalStat (${totalStat}) must equal modalAll.tabCounts.all (${modalAll.tabCounts.all})`
      );

      // 2. Fetch modal drilldown with tab='today_printed'
      const modalTodayPrinted = getRiskOrdersDrilldown({
        riskType: type,
        tab: 'today_printed',
        date: cairoToday,
        limit: 10,
        page: 0,
      });

      assert.strictEqual(
        printedStat,
        modalTodayPrinted.todayPrintedMatching,
        `[${type}] printedStat (${printedStat}) must equal modalTodayPrinted.todayPrintedMatching (${modalTodayPrinted.todayPrintedMatching})`
      );
      assert.strictEqual(
        printedStat,
        modalTodayPrinted.tabCounts.today_printed,
        `[${type}] printedStat (${printedStat}) must equal modalTodayPrinted.tabCounts.today_printed (${modalTodayPrinted.tabCounts.today_printed})`
      );
      assert.strictEqual(
        modalTodayPrinted.filteredCount,
        modalTodayPrinted.tabCounts.today_printed,
        `[${type}] modalTodayPrinted.filteredCount must equal tabCounts.today_printed`
      );
    }
  });

  await t.test('2. Order Deduplication: Multiple items or merchant mappings never inflate order counts (Zero Cartesian product)', () => {
    // Insert a test order with 3 items from different warehouses
    const testRandomNumber = `test_multi_dedup_${Date.now()}`;
    const nowIso = new Date().toISOString();
    const insertOrder = db.prepare(`
      INSERT INTO orders (
        vendoor_id, random_number, order_no, current_status, customer_name,
        customer_phone, customer_phone_extra, extra_phone_valid, extra_phone_status,
        governorate, address, total_order, total_price, multi_merchant_flag,
        delivery_rate, delivery_rate_denom, total_customer_orders,
        last_observed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      9999001, testRandomNumber, testRandomNumber, 'Processing', 'عميل تجريبي متعدد المخازن',
      '01011112222', '01033334444', 1, 'PRESENT',
      'القاهرة', 'مدينة نصر', 1500, 1500, 1,
      85, 10, 10,
      nowIso, nowIso, nowIso
    );

    const orderId = insertOrder.lastInsertRowid;

    // Add 3 separate line items to order_items
    const insertItem = db.prepare(`
      INSERT INTO order_items (
        order_id, product_name, quantity, unit_price, warehouse_name, warehouse_code, merchant_code, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertItem.run(orderId, 'منتج مخزن 1', 2, 300, 'مخزن القاهرة الرئيسي', 'WH-CAI', 'M-001', nowIso);
    insertItem.run(orderId, 'منتج مخزن 2', 1, 500, 'مخزن الإسكندرية', 'WH-ALX', 'M-002', nowIso);
    insertItem.run(orderId, 'منتج مخزن 3', 1, 400, 'مخزن الجيزة', 'WH-GZA', 'M-003', nowIso);

    // Query drilldown searching specifically for this test order
    const result = getRiskOrdersDrilldown({
      riskType: 'multi_merchant',
      tab: 'all',
      search: testRandomNumber,
      limit: 10,
    });

    assert.strictEqual(result.filteredCount, 1, 'Order must appear exactly once in filteredCount despite 3 items');
    assert.strictEqual(result.orders.length, 1, 'Order list must contain exactly one order object');

    const retrievedOrder = result.orders[0];
    assert.strictEqual(retrievedOrder.random_number, testRandomNumber);
    assert.strictEqual(retrievedOrder.items.length, 3, 'Order items list must contain all 3 line items');
    assert.strictEqual(retrievedOrder.warehouses.length, 3, 'Order warehouses list must contain all 3 distinct warehouses');
    assert.strictEqual(retrievedOrder.merchantCodes.length, 3, 'Order merchantCodes list must contain all 3 distinct merchant codes');

    // Clean up test order
    db.prepare('DELETE FROM order_items WHERE order_id = ?').run(orderId);
    db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
  });

  await t.test('3. Exclusion of history-less customers (0/0) from low delivery rate risk', () => {
    // Insert a brand new customer order with delivery_rate = 0, cancel_rate = 0, total_customer_orders = 0
    const testNewCustOrder = `test_new_cust_${Date.now()}`;
    const nowIso = new Date().toISOString();
    const insertRes = db.prepare(`
      INSERT INTO orders (
        vendoor_id, random_number, current_status, customer_name, customer_phone,
        delivery_rate, delivery_rate_denom, cancel_rate, total_customer_orders,
        last_observed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      9999002, testNewCustOrder, 'New', 'عميل جديد بدون تاريخ', '01099998888',
      0, 0, 0, 0,
      nowIso, nowIso, nowIso
    );
    const orderId = insertRes.lastInsertRowid;

    // Verify it is NOT counted in low_delivery
    const result = getRiskOrdersDrilldown({
      riskType: 'low_delivery',
      tab: 'all',
      search: testNewCustOrder,
    });

    assert.strictEqual(
      result.filteredCount,
      0,
      'A new customer with 0/0 history must NOT be flagged as low_delivery risk'
    );

    // Clean up
    db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
  });

  await t.test('4. Tab Filtering across all statuses (Pending, Processing, Printed, Canceling, Canceled, New)', () => {
    const drilldown = getRiskOrdersDrilldown({
      riskType: 'no_extra_phone',
      tab: 'all',
      date: cairoToday,
      limit: 1,
    });

    // Check that each tab's count matches an individual filtered drilldown
    const statusesToTest = ['Pending', 'Processing', 'Printed', 'Canceling', 'Canceled', 'New'];
    for (const st of statusesToTest) {
      const tabDrilldown = getRiskOrdersDrilldown({
        riskType: 'no_extra_phone',
        tab: st,
        date: cairoToday,
        limit: 1,
      });

      const expectedCount = (drilldown.tabCounts as any)[st];
      assert.strictEqual(
        tabDrilldown.filteredCount,
        expectedCount,
        `Filtered count for tab "${st}" (${tabDrilldown.filteredCount}) must equal tabCounts.${st} (${expectedCount})`
      );
    }
  });

  await t.test('5. Multi-field search capability', () => {
    // Find an existing order in orders table
    const sampleOrder = db.prepare(`
      SELECT random_number, customer_phone, customer_name, id
      FROM orders
      WHERE ${getRiskConditionSql('no_extra_phone', 'orders')}
      LIMIT 1
    `).get() as any;

    if (sampleOrder) {
      // 1. Search by random_number
      const searchByCode = getRiskOrdersDrilldown({
        riskType: 'no_extra_phone',
        search: sampleOrder.random_number,
      });
      assert(searchByCode.filteredCount >= 1, 'Should find order by random_number');

      // 2. Search by customer_phone
      if (sampleOrder.customer_phone) {
        const searchByPhone = getRiskOrdersDrilldown({
          riskType: 'no_extra_phone',
          search: sampleOrder.customer_phone.slice(-6),
        });
        assert(searchByPhone.filteredCount >= 1, 'Should find order by phone suffix');
      }
    }
  });

  await t.test('6. Extra phone live exclusion: Orders with logged extra phone additions are never counted as missing extra phone', () => {
    const testCode = `test_phone_live_${Date.now()}`;
    const nowIso = new Date().toISOString();

    // Insert order initially without extra phone
    const res = db.prepare(`
      INSERT INTO orders (
        vendoor_id, random_number, current_status, customer_name, customer_phone,
        extra_phone_status, extra_phone_valid, last_observed_at, created_at, updated_at
      ) VALUES (?, ?, 'Pending', 'عميل إضافة هاتف', '01011119999', 'NOT_RETRIEVED', 0, ?, ?, ?)
    `).run(9999003, testCode, nowIso, nowIso, nowIso);
    const orderId = res.lastInsertRowid;

    // Verify it initially counts as no_extra_phone
    const check1 = getRiskOrdersDrilldown({
      riskType: 'no_extra_phone',
      search: testCode,
    });
    assert.strictEqual(check1.filteredCount, 1, 'Order without extra phone should be counted');

    // Simulate CS adding an extra phone in canonical_activity_events
    db.prepare(`
      INSERT INTO canonical_activity_events (
        raw_event_id, order_id, order_code, actor_name, action_type,
        new_value, event_timestamp, storage_tier, created_at
      ) VALUES (?, ?, ?, 'Hayam CS', 'extra_phone_added', '01062848048', ?, 'HOT', ?)
    `).run(null, orderId, testCode, nowIso, nowIso);

    // Verify it is NOW EXCLUDED from no_extra_phone count
    const check2 = getRiskOrdersDrilldown({
      riskType: 'no_extra_phone',
      search: testCode,
    });
    assert.strictEqual(
      check2.filteredCount,
      0,
      'Order with logged extra phone addition MUST NOT be counted in no_extra_phone'
    );

    // Clean up
    db.prepare('DELETE FROM canonical_activity_events WHERE order_code = ?').run(testCode);
    db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
  });
});
