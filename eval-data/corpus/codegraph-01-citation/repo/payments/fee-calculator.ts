/**
 * Fee calculation for the payments domain (METIS code-graph eval fixture).
 */
export interface FeeSchedule {
  percentage: number;
  flatCents: number;
}

export function calculateProcessingFee(amountCents, schedule) {
  const variableCents = Math.round(amountCents * schedule.percentage);
  return variableCents + schedule.flatCents;
}

export class RefundPolicy {
  isRefundable(daysSincePurchase) {
    return daysSincePurchase <= 30;
  }
}
