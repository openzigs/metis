/**
 * Order lifecycle service (METIS requirement→code mapping eval fixture).
 */
export function createOrder(customerId, lineItems) {
  return { id: `order-${customerId}`, lineItems, status: "created" };
}

export function cancelOrder(order) {
  return { ...order, status: "cancelled" };
}
