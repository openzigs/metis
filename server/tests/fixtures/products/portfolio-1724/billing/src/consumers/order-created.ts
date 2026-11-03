import { insertInvoice, loadOrderForInvoice } from "../db/billing-repo.js";
import type { InvoiceIssuedEvent, OrderCreatedEvent } from "../types/order.js";

interface Consumer {
  subscribe(opts: { topic: string }): Promise<void>;
  run(opts: { eachMessage(m: { message: { value: string } }): Promise<void> }): Promise<void>;
}
interface Producer {
  send(record: { topic: string; messages: { value: string }[] }): Promise<void>;
}
declare const consumer: Consumer;
declare const producer: Producer;
declare const db: Parameters<typeof loadOrderForInvoice>[0];

/** Invoice every new order, then announce the invoice. */
export async function start(): Promise<void> {
  await consumer.subscribe({ topic: "order.created" });
  await consumer.run({
    async eachMessage({ message }) {
      const event = JSON.parse(message.value) as OrderCreatedEvent;
      const order = await loadOrderForInvoice(db, event.orderId);
      if (!order) return;
      const invoice: InvoiceIssuedEvent = {
        invoiceId: `inv-${event.orderId}`,
        orderId: event.orderId,
        customerEmail: order.email,
        amountCents: order.total_cents,
        currency: order.currency,
      };
      await insertInvoice(db, invoice);
      await producer.send({
        topic: "invoice.issued",
        messages: [{ value: JSON.stringify(invoice) }],
      });
    },
  });
}
