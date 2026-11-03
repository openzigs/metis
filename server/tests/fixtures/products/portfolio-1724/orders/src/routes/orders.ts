import { insertOrder } from "../db/orders-repo.js";
import { publishOrderCreated } from "../events/publisher.js";
import type { Order } from "../types/order.js";

// Minimal stand-ins so the fixture type-checks without dependencies.
type Handler = (
  req: { params: Record<string, string>; body: unknown },
  res: { json(v: unknown): void },
) => void;
interface Router {
  get(path: string, h: Handler): void;
  post(path: string, h: Handler): void;
}
declare const router: Router;
declare const db: Parameters<typeof insertOrder>[0];
declare const producer: Parameters<typeof publishOrderCreated>[0];

router.get("/orders/:id", (req, res) => {
  res.json({ id: req.params.id });
});

router.post("/orders", async (req, res) => {
  const order = req.body as Order;
  await insertOrder(db, order);
  await publishOrderCreated(producer, {
    orderId: order.id,
    customerId: order.customerId,
    totalCents: order.totalCents,
    currency: order.currency,
  });
  res.json(order);
});

router.get("/customers/:id", (req, res) => {
  res.json({ id: req.params.id });
});
