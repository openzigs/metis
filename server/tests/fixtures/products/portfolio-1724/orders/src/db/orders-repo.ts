import type { Customer, Order } from "../types/order.js";

interface Db {
  query<T>(sql: string, params: unknown[]): Promise<T[]>;
}

export async function insertOrder(db: Db, order: Order): Promise<void> {
  await db.query(
    "INSERT INTO orders (id, customer_id, total_cents, currency) VALUES ($1, $2, $3, $4)",
    [order.id, order.customerId, order.totalCents, order.currency],
  );
}

export async function insertCustomer(db: Db, customer: Customer): Promise<void> {
  await db.query("INSERT INTO customers (id, name, email) VALUES ($1, $2, $3)", [
    customer.id,
    customer.name,
    customer.email,
  ]);
}

export async function updateCustomerEmail(db: Db, id: string, email: string): Promise<void> {
  await db.query("UPDATE customers SET email = $2 WHERE id = $1", [id, email]);
}
