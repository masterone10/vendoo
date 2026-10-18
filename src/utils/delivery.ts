/**
 * Delivery Rate & Warning Utilities (Stage 10)
 *
 * Requirements:
 * 1. Warning triggers ONLY if deliveryRate < 70% AND sufficient prior customer order history exists.
 * 2. If deliveryRate = 0% and cancelRate = 0%, NO warning (first-time customer or no prior outcomes).
 * 3. Brand new customers with no prior confirmed orders display "لا توجد طلبات سابقة" / "أول طلب للعميل", no warning.
 * 4. Incomplete or unretrieved data does NOT convert to 0% and does NOT trigger warning.
 * 5. If deliveryRate = 0% and cancelRate = 100% with verified history, warning triggers.
 * 6. deliveryRate = 69.9% triggers warning.
 * 7. deliveryRate = 70.0% does NOT trigger warning (strictly < 70%, never <= 70%).
 * 8. Printed / Processing states do NOT imply delivered.
 */

export interface DeliveryEvaluationResult {
  hasHistory: boolean;
  isLowDelivery: boolean;
  rateText: string;
  badgeText: string;
  badgeClass: string;
  warningText: string | null;
}

export function isLowDeliveryRate(
  deliveryRate: number | null | undefined,
  cancelRate: number | null | undefined,
  totalOrders: number | null | undefined,
  denom: number | null | undefined
): boolean {
  // If deliveryRate is not recorded or unknown, no warning
  if (deliveryRate === null || deliveryRate === undefined || isNaN(deliveryRate)) {
    return false;
  }

  // Must have verified customer history (eligible denominator or prior orders count > 0)
  const hasHistory = (denom !== null && denom !== undefined && denom > 0) ||
                     (totalOrders !== null && totalOrders !== undefined && totalOrders > 0);
  if (!hasHistory) {
    return false;
  }

  // If deliveryRate is 0% and cancelRate is 0% (or unrecorded), this is not low delivery
  const cleanCancel = cancelRate ?? 0;
  if (deliveryRate === 0 && cleanCancel === 0) {
    return false;
  }

  // Strictly less than 70% (70.0% is SAFE, 69.9% is WARNING)
  return deliveryRate < 70;
}

export function evaluateCustomerDelivery(
  deliveryRate: number | null | undefined,
  cancelRate: number | null | undefined,
  totalOrders: number | null | undefined,
  denom: number | null | undefined,
  deliveriesNum?: number | null
): DeliveryEvaluationResult {
  const hasHistory = (denom !== null && denom !== undefined && denom > 0) ||
                     (totalOrders !== null && totalOrders !== undefined && totalOrders > 0);

  if (!hasHistory || deliveryRate === null || deliveryRate === undefined) {
    return {
      hasHistory: false,
      isLowDelivery: false,
      rateText: '—',
      badgeText: 'أول طلب للعميل',
      badgeClass: 'bg-slate-800/80 text-slate-400 border-slate-700/60',
      warningText: null,
    };
  }

  const isLow = isLowDeliveryRate(deliveryRate, cancelRate, totalOrders, denom);
  const formattedRate = `${deliveryRate.toFixed(1).replace(/\.0$/, '')}%`;

  if (isLow) {
    return {
      hasHistory: true,
      isLowDelivery: true,
      rateText: formattedRate,
      badgeText: `نسبة تسليم منخفضة (${formattedRate})`,
      badgeClass: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
      warningText: `العميل لديه نسبة تسليم مؤكدة أقل من 70% (${formattedRate})، يرجى مراجعة الجدية قبل الشحن.`,
    };
  }

  return {
    hasHistory: true,
    isLowDelivery: false,
    rateText: formattedRate,
    badgeText: `تسليم جيد (${formattedRate})`,
    badgeClass: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    warningText: null,
  };
}
