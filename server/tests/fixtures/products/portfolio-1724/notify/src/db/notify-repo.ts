interface Db {
  query<T>(sql: string, params: unknown[]): Promise<T[]>;
}

/** Read the invoice to address the receipt email. */
export async function loadInvoice(
  db: Db,
  invoiceId: string,
): Promise<{ customer_email: string; amount_cents: number; currency: string } | undefined> {
  const rows = await db.query<{ customer_email: string; amount_cents: number; currency: string }>(
    "SELECT customer_email, amount_cents, currency FROM invoices WHERE id = $1",
    [invoiceId],
  );
  return rows[0];
}
