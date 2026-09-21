/**
 * Refund processing (METIS requirement→code mapping eval fixture).
 */
export interface RefundRequest {
  orderId: string;
  amountCents: number;
  partial: boolean;
}

export function processPartialRefund(request) {
  const capped = Math.max(0, request.amountCents);
  return { orderId: request.orderId, refundedCents: capped, partial: request.partial };
}

export function issueFullRefund(orderId, amountCents) {
  return processPartialRefund({ orderId, amountCents, partial: false });
}
