/**
 * Inventory stock reservation (METIS requirement→code mapping eval fixture).
 */
export function reserveStockForOrder(order) {
  return order.lineItems.map((item) => ({ sku: item.sku, reserved: item.quantity }));
}

export function releaseReservedStock(order) {
  return order.lineItems.map((item) => ({ sku: item.sku, released: item.quantity }));
}
