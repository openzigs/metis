-- Billing owns invoices. It reads Orders' customers and orders tables directly.
CREATE TABLE invoices (
  id             TEXT PRIMARY KEY,
  order_id       TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  amount_cents   INTEGER NOT NULL,
  currency       TEXT NOT NULL
);
