// Synthetic fixture for #1619 — not production content, never executed.
// The shipping service publishes stock reservations; nobody subscribes in code.

declare const producer: {
  send(opts: { topic: string; messages: Array<{ value: string }> }): Promise<void>;
};

export async function reserve(orderId: string): Promise<void> {
  await producer.send({ topic: "inventory.reserved", messages: [{ value: orderId }] });
}
