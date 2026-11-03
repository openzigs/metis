/** The order and customer shapes the Orders API returns. */
export interface Customer {
  id: string;
  name: string;
  email: string;
}

export interface Order {
  id: string;
  customerId: string;
  totalCents: number;
  currency: string;
}

/** The payload of the `order.created` event. */
export interface OrderCreatedEvent {
  orderId: string;
  customerId: string;
  totalCents: number;
  currency: string;
}
