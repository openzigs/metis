-- Synthetic fixture for #1619 — not production content.
-- The order writer owns the orders table and writes it.
-- (A comment naming another table must not count: DELETE FROM audit_log;)

INSERT INTO orders (id, customer_id, total) VALUES (:id, :customer_id, :total);

UPDATE orders SET total = :total WHERE id = :id;

SELECT id, name FROM customers WHERE id = :customer_id;
