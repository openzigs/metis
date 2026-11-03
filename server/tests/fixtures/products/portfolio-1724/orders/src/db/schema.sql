-- Orders owns these tables. Billing reads them directly (a shared database).
CREATE TABLE customers (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  email TEXT NOT NULL
);

CREATE TABLE orders (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers (id),
  total_cents INTEGER NOT NULL,
  currency    TEXT NOT NULL
);
