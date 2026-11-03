import type { InvoiceIssuedEvent } from "../types/order.js";

interface Db {
  query<T>(sql: string, params: unknown[]): Promise<T[]>;
}

/** Read the order and its customer straight from the Orders tables. */
export async function loadOrderForInvoice(
  db: Db,
  orderId: string,
): Promise<{ total_cents: number; currency: string; email: string } | undefined> {
  const rows = await db.query<{ total_cents: number; currency: string; email: string }>(
    "SELECT o.total_cents, o.currency, c.email FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1",
    [orderId],
  );
  return rows[0];
}

export async function insertInvoice(db: Db, invoice: InvoiceIssuedEvent): Promise<void> {
  await db.query(
    "INSERT INTO invoices (id, order_id, customer_email, amount_cents, currency) VALUES ($1, $2, $3, $4, $5)",
    [
      invoice.invoiceId,
      invoice.orderId,
      invoice.customerEmail,
      invoice.amountCents,
      invoice.currency,
    ],
  );
}
