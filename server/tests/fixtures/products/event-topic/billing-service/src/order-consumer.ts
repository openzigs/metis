// Synthetic fixture for #1619 — not production content, never executed.
// The billing service subscribes to the channel the orders service documents.
//
// It used to listen to stock reservations too; the call is commented out, so
// it must NOT become an edge to the shipping service, which still publishes it:
// await consumer.subscribe({ topic: "inventory.reserved" });

declare const consumer: {
  subscribe(opts: { topic: string }): Promise<void>;
  run(opts: object): Promise<void>;
};

export async function startBilling(): Promise<void> {
  await consumer.subscribe({ topic: "orders.created" });
  /* consumer.subscribe({ topic: "inventory.reserved" }) — retired in 2025 */
  await consumer.run({});
}
