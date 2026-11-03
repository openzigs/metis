import type { OrderCreatedEvent } from "../types/order.js";

interface Producer {
  send(record: { topic: string; messages: { value: string }[] }): Promise<void>;
}

/** Publish `order.created` once an order is stored. */
export async function publishOrderCreated(
  producer: Producer,
  event: OrderCreatedEvent,
): Promise<void> {
  await producer.send({ topic: "order.created", messages: [{ value: JSON.stringify(event) }] });
}
