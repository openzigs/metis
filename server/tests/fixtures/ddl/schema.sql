CREATE TABLE crm.customers (
  id BIGINT PRIMARY KEY,
  email_address VARCHAR(255) NOT NULL,
  display_name VARCHAR(255),
  tenant_id BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS shop.orders (
  id BIGINT PRIMARY KEY,
  customer_id BIGINT NOT NULL,
  total NUMERIC(12,2) NOT NULL,
  status VARCHAR(32),
  CONSTRAINT fk_customer FOREIGN KEY (customer_id) REFERENCES crm.customers (id)
);
