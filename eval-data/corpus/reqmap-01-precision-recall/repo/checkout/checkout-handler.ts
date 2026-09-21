/**
 * Checkout orchestration (METIS requirement→code mapping eval fixture).
 *
 * Calls into fee calculation and order creation, so it is an upstream CALLER
 * of `calculateProcessingFee` / `createOrder` — the blast-radius edges declared
 * in `reqmap.json` mirror these call sites.
 */
export function handleCheckout(customerId, cart) {
  return { customerId, itemCount: cart.length };
}
