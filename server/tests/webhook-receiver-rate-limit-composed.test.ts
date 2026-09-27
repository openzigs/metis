/**
 * #105 — the shared webhook-receiver limiter counts each request AT MOST ONCE,
 * over the COMPOSED `apiRouter()` (the defect only exists there).
 *
 * `triggersWebhookRouter()` and `syncWebhookRouter()` are both mounted on
 * `/webhooks` and both applied `webhookReceiverRateLimiter` as a path-less
 * `r.use`, which runs for every request entering the router — matched or not.
 * So `POST /api/webhooks/jira/issues` was counted twice (once while falling
 * through the triggers router) and got half the configured budget.
 *
 * With a budget of N, each receiver must answer N requests normally and 429 the
 * (N+1)th: fewer means double counting, more means the limiter no longer
 * covers the route (a widening this fix must not introduce).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async () => 1),
    user: { upsert: vi.fn(async () => ({ id: "user_admin" })) },
    userRole: { findFirst: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({})) },
    trigger: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
  },
}));

import request from "supertest";
import { createApp } from "../src/app.js";
import { __resetWebhookReceiverRateLimiter } from "../src/middleware/webhook-receiver-rate-limit.js";

const BUDGET = 3;

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  process.env.WEBHOOK_RECEIVER_LIMIT_MAX = String(BUDGET);
  // A generous own-limiter for /github/issues so only the shared one can trip.
  process.env.GITHUB_ISSUES_WEBHOOK_LIMIT_MAX = "1000";
  __resetWebhookReceiverRateLimiter();
  app = createApp();
});

afterEach(() => {
  delete process.env.WEBHOOK_RECEIVER_LIMIT_MAX;
  delete process.env.GITHUB_ISSUES_WEBHOOK_LIMIT_MAX;
  __resetWebhookReceiverRateLimiter();
});

/**
 * Every receiver sharing the budget. All requests are UNSIGNED and carry no
 * credentials: each must be refused (4xx) before the limiter trips, never
 * processed.
 */
const RECEIVERS: Array<{ path: string; body: Record<string, unknown> }> = [
  { path: "/api/webhooks/jira/issues", body: { timestamp: Date.now() } },
  { path: "/api/webhooks/github/pr", body: {} },
  { path: "/api/webhooks/github/issues", body: {} },
  { path: "/api/webhooks/github", body: { repository: { full_name: "o/r" } } },
  { path: "/api/webhooks/slack", body: { channel_id: "C1" } },
  { path: "/api/triggers/trg_1/fire", body: {} },
];

describe.each(RECEIVERS)("$path is counted exactly once per request (#105)", ({ path, body }) => {
  it(`answers ${BUDGET} unsigned requests with a refusal, then 429s`, async () => {
    const statuses: number[] = [];
    for (let i = 0; i < BUDGET + 1; i++) {
      const res = await request(app).post(path).set("Content-Type", "application/json").send(body);
      statuses.push(res.status);
    }
    const within = statuses.slice(0, BUDGET);
    for (const s of within) {
      expect(s, `statuses: ${statuses.join(",")}`).not.toBe(429);
      // Unsigned + unauthenticated: refused, never accepted.
      expect(s, `statuses: ${statuses.join(",")}`).toBeGreaterThanOrEqual(400);
    }
    expect(statuses[BUDGET], `statuses: ${statuses.join(",")}`).toBe(429);
  });
});

describe("requests to other /webhooks receivers do not spend a receiver's budget twice", () => {
  it("mixing jira/issues and github/pr shares ONE budget, one hit per request", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < BUDGET; i++) {
      const path = i % 2 === 0 ? "/api/webhooks/jira/issues" : "/api/webhooks/github/pr";
      const res = await request(app).post(path).set("Content-Type", "application/json").send({});
      statuses.push(res.status);
    }
    expect(
      statuses.every((s) => s !== 429),
      statuses.join(","),
    ).toBe(true);
    const next = await request(app)
      .post("/api/webhooks/jira/issues")
      .set("Content-Type", "application/json")
      .send({});
    expect(next.status).toBe(429);
  });
});
