/** Billing's copy of the Orders shapes it reads (kept in step by hand). */
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

export interface OrderCreatedEvent {
  orderId: string;
  customerId: string;
  totalCents: number;
  currency: string;
}

/** The payload of the `invoice.issued` event. */
export interface InvoiceIssuedEvent {
  invoiceId: string;
  orderId: string;
  customerEmail: string;
  amountCents: number;
  currency: string;
}
