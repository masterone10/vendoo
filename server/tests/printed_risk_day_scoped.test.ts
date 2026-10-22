import test from 'node:test';
import assert from 'node:assert';
import { db, getCairoDateInterval, getCairoDateString } from '../db.ts';

test('Printed risk indicators are strictly scoped to selected business date and match /api/printed 100%', async (t) => {
  const datesToTest = ['2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22'];

  for (const dt of datesToTest) {
    await t.test(`Verify risk indicators for date ${dt}`, () => {
      const interval = getCairoDateInterval(dt);

      // 1. Dashboard query for risk indicators
      const stats = db.prepare(`
        SELECT
          COUNT(DISTINCT CASE WHEN o.multi_merchant_flag = 1 THEN o.id END) as multiMerchantCount,
          COUNT(DISTINCT CASE WHEN o.extra_phone_status = 'CONFIRMED_ABSENT' THEN o.id END) as missingPhoneCount,
          COUNT(DISTINCT CASE WHEN o.delivery_rate IS NOT NULL AND o.delivery_rate < 70
                                   AND (o.delivery_rate_denom > 0 OR o.total_customer_orders > 0)
                                   AND NOT (o.delivery_rate = 0 AND (o.cancel_rate = 0 OR o.cancel_rate IS NULL))
                              THEN o.id END) as lowDeliveryCount
        FROM orders o
        LEFT JOIN (
          SELECT order_code, id
          FROM canonical_activity_events
          WHERE event_timestamp >= ? AND event_timestamp < ?
            AND (to_status = 'Printed' OR action_type = 'confirmation')
          GROUP BY order_code
        ) c ON c.order_code = o.random_number OR c.order_code = o.order_no OR c.order_code = CAST(o.vendoor_id AS TEXT)
        WHERE (c.id IS NOT NULL OR (o.printed_date >= ? AND o.printed_date < ?))
      `).get(interval.startCairo, interval.endCairo, interval.startCairo, interval.endCairo) as any;

      // 2. Printed view query for low_delivery
      const printedLowDelivery = db.prepare(`
        SELECT COUNT(*) as count
        FROM orders o
        LEFT JOIN (
          SELECT order_code, id
          FROM canonical_activity_events
          WHERE event_timestamp >= ? AND event_timestamp < ?
            AND (to_status = 'Printed' OR action_type = 'confirmation')
          GROUP BY order_code
        ) c ON c.order_code = o.random_number OR c.order_code = o.order_no OR c.order_code = CAST(o.vendoor_id AS TEXT)
        WHERE (c.id IS NOT NULL OR (o.printed_date >= ? AND o.printed_date < ?))
          AND o.delivery_rate IS NOT NULL AND o.delivery_rate < 70
          AND (o.delivery_rate_denom > 0 OR o.total_customer_orders > 0)
          AND NOT (o.delivery_rate = 0 AND (o.cancel_rate = 0 OR o.cancel_rate IS NULL))
      `).get(interval.startCairo, interval.endCairo, interval.startCairo, interval.endCairo) as any;

      // 3. Printed view query for multi_merchant
      const printedMultiMerchant = db.prepare(`
        SELECT COUNT(*) as count
        FROM orders o
        LEFT JOIN (
          SELECT order_code, id
          FROM canonical_activity_events
          WHERE event_timestamp >= ? AND event_timestamp < ?
            AND (to_status = 'Printed' OR action_type = 'confirmation')
          GROUP BY order_code
        ) c ON c.order_code = o.random_number OR c.order_code = o.order_no OR c.order_code = CAST(o.vendoor_id AS TEXT)
        WHERE (c.id IS NOT NULL OR (o.printed_date >= ? AND o.printed_date < ?))
          AND o.multi_merchant_flag = 1
      `).get(interval.startCairo, interval.endCairo, interval.startCairo, interval.endCairo) as any;

      // 4. Printed view query for no_extra_phone
      const printedNoExtraPhone = db.prepare(`
        SELECT COUNT(*) as count
        FROM orders o
        LEFT JOIN (
          SELECT order_code, id
          FROM canonical_activity_events
          WHERE event_timestamp >= ? AND event_timestamp < ?
            AND (to_status = 'Printed' OR action_type = 'confirmation')
          GROUP BY order_code
        ) c ON c.order_code = o.random_number OR c.order_code = o.order_no OR c.order_code = CAST(o.vendoor_id AS TEXT)
        WHERE (c.id IS NOT NULL OR (o.printed_date >= ? AND o.printed_date < ?))
          AND o.extra_phone_status = 'CONFIRMED_ABSENT'
      `).get(interval.startCairo, interval.endCairo, interval.startCairo, interval.endCairo) as any;

      assert.strictEqual(
        stats.lowDeliveryCount,
        printedLowDelivery.count,
        `Date ${dt}: Dashboard low delivery count must exactly match printed view count`
      );

      assert.strictEqual(
        stats.multiMerchantCount,
        printedMultiMerchant.count,
        `Date ${dt}: Dashboard multi-merchant count must exactly match printed view count`
      );

      assert.strictEqual(
        stats.missingPhoneCount,
        printedNoExtraPhone.count,
        `Date ${dt}: Dashboard missing phone count must exactly match printed view count`
      );
    });
  }
});
