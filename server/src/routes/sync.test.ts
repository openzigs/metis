/**
 * Epic #739 — Tests for sync routes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import { syncWebhookRouter, syncDriftRouter } from "./sync.js";

const { seenDeliveries } = vi.hoisted(() => ({ seenDeliveries: new Set<string>() }));

// #681 — stateful mock of the shared delivery-dedup so the replay test is
// deterministic and never touches the real pr_review_webhook_deliveries table.
vi.mock("../lib/agents/pr-reviewer/webhook-dedup.js", () => ({
  recordDelivery: vi.fn(async ({ deliveryId }: { deliveryId: string }) => {
    const id = (deliveryId ?? "").trim();
    if (!id) return { duplicate: false, deliveryId: "" };
    const dup = seenDeliveries.has(id);
    if (!dup) seenDeliveries.add(id);
    return { duplicate: dup, deliveryId: id };
  }),
}));

// Mock dependencies
vi.mock("../lib/sync/index.js", () => ({
  reconcileIssueChange: vi.fn().mockResolvedValue({ handled: true, driftEventId: "drift-1" }),
  resolveDriftEvent: vi.fn().mockResolvedValue({
    id: "drift-1",
    status: "resolved",
    resolution: "adopt",
    publishedIssueId: "pub-1",
    projectId: "proj-1",
    requirementId: null,
    source: "github",
    deliveryId: "del-1",
    action: "edited",
    fieldDiffs: [],
    externalSnapshot: { title: "T", body: "B", state: "open", labels: [], assignees: [] },
    localSnapshot: null,
    resolvedById: "user-1",
    resolvedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  }),
  listDriftEvents: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  getDriftCount: vi.fn().mockResolvedValue(3),
  verifyGithubIssueSignature: vi.fn().mockReturnValue({ ok: true }),
  normalizeGithubIssueEvent: vi.fn().mockReturnValue({
    event: {
      deliveryId: "del-1",
      source: "github",
      externalId: "node-1",
      externalRef: "42",
      action: "edited",
      changes: { title: "New" },
      current: { title: "New", body: "B", state: "open", labels: [], assignees: [] },
      timestamp: new Date().toISOString(),
    },
  }),
  verifyJiraWebhookSignature: vi.fn().mockReturnValue({ ok: true }),
  normalizeJiraIssueEvent: vi.fn().mockReturnValue({
    event: {
      deliveryId: "jira-del-1",
      source: "jira",
      externalId: "10042",
      externalRef: "PROJ-42",
      action: "edited",
      changes: {},
      current: { title: "T", body: "B", state: "open", labels: [], assignees: [] },
      timestamp: new Date().toISOString(),
    },
  }),
}));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: Request & { user?: unknown }, _res: Response, next: NextFunction) => {
    req.user = { userId: "user-1", role: "coordinator", username: "test" };
    next();
  },
}));

vi.mock("../middleware/require-permission.js", () => ({
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock("../middleware/error-handler.js", () => {
  class AppError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return { AppError };
});

function createApp() {
  const app = express();
  app.use(express.json());
  // Simulate raw body
  app.use((req: Request & { rawBody?: string }, _res: Response, next: NextFunction) => {
    req.rawBody = JSON.stringify(req.body);
    next();
  });
  app.use("/webhooks", syncWebhookRouter());
  app.use("/sync", syncDriftRouter());
  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

beforeEach(() => seenDeliveries.clear());

describe("GitHub issues webhook route", () => {
  it("returns 200 with handled result on valid payload", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/webhooks/github/issues")
      .set("x-github-event", "issues")
      .set("x-hub-signature-256", "sha256=valid")
      .set("x-github-delivery", "del-1")
      .send({ action: "edited", issue: { id: 1, node_id: "N_1", number: 1 } });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.handled).toBe(true);
  });

  it("returns 401 when signature verification fails", async () => {
    const { verifyGithubIssueSignature } = await import("../lib/sync/index.js");
    vi.mocked(verifyGithubIssueSignature).mockReturnValueOnce({
      ok: false,
      reason: "SIGNATURE_MISMATCH",
    });

    const app = createApp();
    const res = await request(app)
      .post("/webhooks/github/issues")
      .set("x-github-event", "issues")
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.reason).toBe("SIGNATURE_MISMATCH");
  });

  it("returns 200 with handled=false for non-issues events", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/webhooks/github/issues")
      .set("x-github-event", "pull_request")
      .set("x-hub-signature-256", "sha256=valid")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.handled).toBe(false);
    expect(res.body.reason).toBe("NOT_ISSUES_EVENT");
  });

  it("dedups a replayed delivery — second identical X-GitHub-Delivery is a no-op (#681)", async () => {
    const app = createApp();
    const send = () =>
      request(app)
        .post("/webhooks/github/issues")
        .set("x-github-event", "issues")
        .set("x-hub-signature-256", "sha256=valid")
        .set("x-github-delivery", "replay-1")
        .send({ action: "edited", issue: { id: 1, node_id: "N_1", number: 1 } });
    const first = await send();
    expect(first.status).toBe(200);
    expect(first.body.handled).toBe(true);
    const replay = await send();
    expect(replay.status).toBe(200);
    expect(replay.body.handled).toBe(false);
    expect(replay.body.reason).toBe("DUPLICATE_DELIVERY");
  });
});

describe("Jira issues webhook route", () => {
  it("returns 200 with handled result on valid payload", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/webhooks/jira/issues")
      .set("x-hub-signature", "valid-sig")
      .send({ webhookEvent: "jira:issue_updated", issue: { id: "1", key: "P-1" } });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 401 when Jira signature fails", async () => {
    const { verifyJiraWebhookSignature } = await import("../lib/sync/index.js");
    vi.mocked(verifyJiraWebhookSignature).mockReturnValueOnce({
      ok: false,
      reason: "SIGNATURE_MISMATCH",
    });

    const app = createApp();
    const res = await request(app).post("/webhooks/jira/issues").send({});

    expect(res.status).toBe(401);
  });

  it("dedups a replayed delivery — second identical X-Atlassian-Webhook-Id is a no-op (#681)", async () => {
    const app = createApp();
    const send = () =>
      request(app)
        .post("/webhooks/jira/issues")
        .set("x-hub-signature", "valid-sig")
        .set("x-atlassian-webhook-id", "jira-replay-1")
        .send({ webhookEvent: "jira:issue_updated", issue: { id: "1", key: "P-1" } });
    const first = await send();
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    const replay = await send();
    expect(replay.status).toBe(200);
    expect(replay.body.reason).toBe("DUPLICATE_DELIVERY");
  });
});

describe("Drift management routes", () => {
  // The first supertest round-trip in this block pays the cold-start cost of
  // booting an ephemeral HTTP server; under full-suite parallel load that can
  // exceed the 5s default and flake. The handler itself is fully mocked, so a
  // generous timeout is the correct fix rather than a behavioural change.
  it("GET /sync/drift returns list", async () => {
    const app = createApp();
    const res = await request(app).get("/sync/drift?projectId=proj-1");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty("items");
    expect(res.body.data).toHaveProperty("total");
  }, 20000);

  it("GET /sync/drift/count returns count", async () => {
    const app = createApp();
    const res = await request(app).get("/sync/drift/count?projectId=proj-1");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.count).toBe(3);
  });

  it("GET /sync/drift returns 400 without projectId", async () => {
    const app = createApp();
    const res = await request(app).get("/sync/drift");

    expect(res.status).toBe(400);
  });

  it("POST /sync/drift/:id/resolve resolves drift", async () => {
    const app = createApp();
    const res = await request(app).post("/sync/drift/drift-1/resolve").send({ action: "adopt" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.resolution).toBe("adopt");
  });

  it("POST /sync/drift/:id/resolve rejects invalid action", async () => {
    const app = createApp();
    const res = await request(app).post("/sync/drift/drift-1/resolve").send({ action: "invalid" });

    expect(res.status).toBe(400);
  });
});
