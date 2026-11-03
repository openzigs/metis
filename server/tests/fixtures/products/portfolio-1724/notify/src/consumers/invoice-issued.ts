import { loadInvoice } from "../db/notify-repo.js";

interface Consumer {
  subscribe(opts: { topic: string }): Promise<void>;
  run(opts: { eachMessage(m: { message: { value: string } }): Promise<void> }): Promise<void>;
}
interface Mailer {
  send(to: string, subject: string, body: string): Promise<void>;
}
declare const consumer: Consumer;
declare const mailer: Mailer;
declare const db: Parameters<typeof loadInvoice>[0];

/** Email a receipt for every issued invoice. */
export async function start(): Promise<void> {
  await consumer.subscribe({ topic: "invoice.issued" });
  await consumer.run({
    async eachMessage({ message }) {
      const { invoiceId } = JSON.parse(message.value) as { invoiceId: string };
      const invoice = await loadInvoice(db, invoiceId);
      if (!invoice) return;
      await mailer.send(
        invoice.customer_email,
        "Your receipt",
        `We received ${(invoice.amount_cents / 100).toFixed(2)} ${invoice.currency}.`,
      );
    },
  });
}
