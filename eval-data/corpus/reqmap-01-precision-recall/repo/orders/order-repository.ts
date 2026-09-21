/**
 * Order persistence (METIS requirement→code mapping eval fixture).
 */
export class OrderRepository {
  saveOrder(order) {
    this._rows.set(order.id, order);
    return order;
  }

  findOrderById(orderId) {
    return this._rows.get(orderId);
  }
}
