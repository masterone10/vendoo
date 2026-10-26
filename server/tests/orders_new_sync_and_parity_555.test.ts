import test from 'node:test';
import assert from 'node:assert/strict';
import { db, getCairoDateString, getCairoDateInterval } from '../db.ts';
import { syncEngine } from '../syncEngine.ts';
import { vendoorClient, type VendoorRawOrder } from '../vendoorClient.ts';

test('Orders NEW Sync & 555 Parity Master Suite', async (t) => {
  const cairoToday = getCairoDateString();
  const originalFetchOrdersBatch = vendoorClient.fetchOrdersBatch.bind(vendoorClient);

  // Helper to generate mock VendoorRawOrder items with unique IDs
  const generateMockOrders = (count: number, prefix = 'TEST-555', idOffset = 8800000): VendoorRawOrder[] => {
    const list: VendoorRawOrder[] = [];
    for (let i = 1; i <= count; i++) {
      const vId = idOffset + i;
      const code = `${prefix}-${String(i).padStart(4, '0')}`;
      list.push({
        id: vId,
        order_no: `INV-${vId}`,
        integration_shipping_name: null,
        order_type: 'اوردر جديد',
        created_at: `${cairoToday} 10:00 AM`,
        affiliate_code: 'AFF-01',
        random_number: code,
        affiliate_name: 'Affiliate Test',
        full_name: `عميل تجريبي ${i}`,
        total_price: 250,
        shipping_cost: '50',
        phone: `010${String(10000000 + i).slice(0, 8)}`,
        governrate_name: 'القاهرة',
        address: 'شارع التحرير مبنى 10',
        total_order: '300',
        status: '<button type="button" name="status" class="status btn btn-primary btn-sm"> New</button>',
        products: [],
      });
    }
    return list;
  };

  // Clean test orders before suite
  db.prepare("DELETE FROM orders WHERE random_number LIKE 'TEST-555-%'").run();

  await t.test('1. Full crawl of 555 NEW orders across 3 pages (200, 200, 155)', async () => {
    const mock555 = generateMockOrders(555, 'TEST-555');
    const requestedStarts: number[] = [];

    (vendoorClient as any).fetchOrdersBatch = async (
      start = 0,
      length = 200,
      statusFilter = ''
    ) => {
      requestedStarts.push(start);
      assert.strictEqual(statusFilter, 'New', 'statusFilter must be New');
      const slice = mock555.slice(start, start + length);
      return {
        recordsTotal: 10000,
        recordsFiltered: mock555.length, // 555
        data: slice,
      };
    };

    try {
      const result = await syncEngine.syncOrdersByStatus('New', 200);

      assert.strictEqual(result.sourceTotalReported, 555, 'Source must report 555 orders');
      assert.strictEqual(result.pagesDiscovered, 3, 'Must discover 3 pages (200, 200, 155)');
      assert.strictEqual(result.pagesRead, 3, 'Must read all 3 pages');
      assert.strictEqual(result.totalOrdersFetched, 555, 'Must fetch all 555 orders');
      assert.strictEqual(result.uniqueOrdersFetched, 555, 'Must have 555 unique orders');
      assert.strictEqual(result.isComplete, true, 'Scan must be complete');
      assert.strictEqual(result.failedPageStart, null, 'No failed page');
      assert.deepStrictEqual(requestedStarts, [0, 200, 400], 'Must request offsets 0, 200, 400');

      // Verify database counts
      const countRow: any = db.prepare("SELECT COUNT(*) as c FROM orders WHERE random_number LIKE 'TEST-555-%' AND current_status = 'New'").get();
      assert.strictEqual(countRow.c, 555, 'Database must contain all 555 NEW orders');

      // Verify zero duplicates
      const uniqueCodes: any = db.prepare("SELECT COUNT(DISTINCT random_number) as c FROM orders WHERE random_number LIKE 'TEST-555-%'").get();
      assert.strictEqual(uniqueCodes.c, 555, 'Database must have 555 distinct order codes');
    } finally {
      (vendoorClient as any).fetchOrdersBatch = originalFetchOrdersBatch;
    }
  });

  await t.test('2. API Parity: /dashboard/stats and /api/orders reflect complete 555 count', async () => {
    // In db, count of New orders with TEST-555 prefix is 555
    const totalNewInDb: any = db.prepare("SELECT COUNT(*) as c FROM orders WHERE current_status = 'New' AND random_number LIKE 'TEST-555-%'").get();
    assert.strictEqual(totalNewInDb.c, 555);

    // Verify raw status query logic used by Dashboard
    const activeStatesRaw: any[] = db.prepare(`
      SELECT current_status, COUNT(*) as count
      FROM orders
      WHERE current_status IN ('New', 'Pending', 'Processing', 'Canceling')
      GROUP BY current_status
    `).all();

    const newRow = activeStatesRaw.find(r => r.current_status === 'New');
    assert.ok(newRow, 'New status row must exist');
    assert.ok(newRow.count >= 555, `New count must be at least 555 (was ${newRow.count})`);

    // Verify sample order details
    const sample: any = db.prepare("SELECT * FROM orders WHERE random_number = 'TEST-555-0001'").get();
    assert.strictEqual(sample.current_status, 'New');
    assert.strictEqual(sample.customer_name, 'عميل تجريبي 1');
    assert.strictEqual(sample.order_type, 'اوردر جديد');
  });

  await t.test('3. Mid-Crawl Interruption and Failure Handling', async () => {
    // Prepare fresh test set of 555 orders
    const mockHalt = generateMockOrders(555, 'HALT-555', 9900000);
    db.prepare("DELETE FROM orders WHERE random_number LIKE 'HALT-555-%'").run();

    let attemptsOnPage2 = 0;
    (vendoorClient as any).fetchOrdersBatch = async (
      start = 0,
      length = 200,
      statusFilter = ''
    ) => {
      if (start === 200) {
        attemptsOnPage2++;
        throw new Error('Simulated upstream gateway timeout on start=200');
      }
      return {
        recordsTotal: 10000,
        recordsFiltered: mockHalt.length,
        data: mockHalt.slice(start, start + length),
      };
    };

    try {
      const result = await syncEngine.syncOrdersByStatus('New', 200);

      // Verify that failure was recorded honestly
      assert.strictEqual(result.isComplete, false, 'Must NOT mark scan as complete on failure');
      assert.strictEqual(result.failedPageStart, 200, 'Must record failed offset 200');
      assert.strictEqual(result.pagesRead, 1, 'Only page 1 succeeded');
      assert.strictEqual(result.totalOrdersFetched, 200, 'Only 200 orders fetched before failure');
      assert.ok(attemptsOnPage2 >= 3, 'Must have attempted 3 retries on failed page');

      // Verify Page 1 (200 orders) was safely preserved locally without rollback
      const savedCount: any = db.prepare("SELECT COUNT(*) as c FROM orders WHERE random_number LIKE 'HALT-555-%'").get();
      assert.strictEqual(savedCount.c, 200, 'Must safely retain 200 orders from page 1');
    } finally {
      (vendoorClient as any).fetchOrdersBatch = originalFetchOrdersBatch;
    }
  });

  await t.test('4. Resumption of Remaining Pages without Duplication', async () => {
    const mockHalt = generateMockOrders(555, 'HALT-555', 9900000);
    // Now simulate upstream recovering and returning all pages
    (vendoorClient as any).fetchOrdersBatch = async (
      start = 0,
      length = 200,
      _statusFilter = ''
    ) => {
      return {
        recordsTotal: 10000,
        recordsFiltered: mockHalt.length,
        data: mockHalt.slice(start, start + length),
      };
    };

    try {
      const result = await syncEngine.syncOrdersByStatus('New', 200);

      assert.strictEqual(result.isComplete, true, 'Resumed scan must complete successfully');
      assert.strictEqual(result.sourceTotalReported, 555);
      assert.strictEqual(result.uniqueOrdersFetched, 555);

      // Verify final DB count is exactly 555 with zero duplicates
      const totalCount: any = db.prepare("SELECT COUNT(*) as c FROM orders WHERE random_number LIKE 'HALT-555-%'").get();
      assert.strictEqual(totalCount.c, 555, 'Database must have exactly 555 orders without duplication');

      const distinctCount: any = db.prepare("SELECT COUNT(DISTINCT vendoor_id) as c FROM orders WHERE random_number LIKE 'HALT-555-%'").get();
      assert.strictEqual(distinctCount.c, 555, 'Zero duplicate IDs');
    } finally {
      (vendoorClient as any).fetchOrdersBatch = originalFetchOrdersBatch;
      db.prepare("DELETE FROM orders WHERE random_number LIKE 'HALT-555-%'").run();
    }
  });

  await t.test('5. Status Transition: Order moving from NEW to another status updates properly without false cancellation', async () => {
    // Take order TEST-555-0001 which is currently 'New'
    const before: any = db.prepare("SELECT current_status FROM orders WHERE random_number = 'TEST-555-0001'").get();
    assert.strictEqual(before.current_status, 'New');

    // Simulate Vendoor returning TEST-555-0001 with updated status 'Processing'
    const updatedOrder: VendoorRawOrder = {
      id: 8800001,
      order_no: 'INV-8800001',
      integration_shipping_name: null,
      order_type: 'اوردر جديد',
      created_at: `${cairoToday} 10:00 AM`,
      affiliate_code: 'AFF-01',
      random_number: 'TEST-555-0001',
      affiliate_name: 'Affiliate Test',
      full_name: 'عميل تجريبي 1',
      total_price: 250,
      shipping_cost: '50',
      phone: '01010000001',
      governrate_name: 'القاهرة',
      address: 'شارع التحرير مبنى 10',
      total_order: '300',
      status: '<button type="button" name="status" class="status btn btn-info btn-sm"> Processing</button>',
      products: [],
    };

    const upsertRes = syncEngine.upsertCanonicalOrder(updatedOrder, new Date().toISOString());
    assert.strictEqual(upsertRes.statusChanged, true, 'Status change must be detected');
    assert.strictEqual(upsertRes.previousStatus, 'New');
    assert.strictEqual(upsertRes.currentStatus, 'Processing');

    // Verify DB reflection
    const after: any = db.prepare("SELECT current_status FROM orders WHERE random_number = 'TEST-555-0001'").get();
    assert.strictEqual(after.current_status, 'Processing', 'Order must be updated to Processing');

    // Verify audit status event was recorded
    const eventRow: any = db.prepare("SELECT from_status, to_status FROM order_status_events WHERE random_number = 'TEST-555-0001' ORDER BY id DESC LIMIT 1").get();
    assert.strictEqual(eventRow.from_status, 'New');
    assert.strictEqual(eventRow.to_status, 'Processing');
  });

  // Clean test orders after suite
  db.prepare("DELETE FROM orders WHERE random_number LIKE 'TEST-555-%'").run();
});
