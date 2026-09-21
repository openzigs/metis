/**
 * Payment fee calculation (METIS requirement→code mapping eval fixture).
 */
export interface FeeSchedule {
  percentage: number;
  flatCents: number;
}

export function calculateProcessingFee(amountCents, schedule) {
  const variableCents = Math.round(amountCents * schedule.percentage);
  return variableCents + schedule.flatCents;
}

export function applyTieredFeeSchedule(amountCents, tiers) {
  const tier = tiers.find((t) => amountCents <= t.maxCents) ?? tiers[tiers.length - 1];
  return calculateProcessingFee(amountCents, tier.schedule);
}

export class RefundPolicy {
  isRefundable(daysSincePurchase) {
    return daysSincePurchase <= 30;
  }
}
