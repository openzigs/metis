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
  // #102 — the drift's owning project, resolved before the write is authorised.
  getDriftEventProjectId: vi.fn().mockResolvedValue("proj-1"),
  listDriftEvents: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  getDriftCount: vi.fn().mockResolvedValue(3),
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

// #88 — the drift reads now narrow `req.user` before handing it to the
// project-scope seam. `authedUser = null` mounts the router as an unauthenticated
// request would reach it, so that arm is exercised rather than assumed.
let authedUser: unknown = { userId: "user-1", role: "coordinator", username: "test" };
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: Request & { user?: unknown }, _res: Response, next: NextFunction) => {
    if (authedUser) req.user = authedUser;
    next();
  },
}));

vi.mock("../middleware/require-permission.js", () => ({
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// #88 — the drift reads gate on `sync.read` alone, so they must ALSO go through
// the canonical object-level project-scope seam (`assertProjectAccess`, the same
// predicate `requireProjectAccess` applies to `/projects/:projectId/*`). A
// non-member gets 404, never 403, so route probing cannot enumerate projects.
let accessibleProjectIds: string[] = ["proj-1"];
const assertProjectAccess = vi.fn(async (_user: unknown, projectId: string) => {
  if (!accessibleProjectIds.includes(projectId)) {
    const { AppError } = await import("../middleware/error-handler.js");
    throw new AppError(404, "NOT_FOUND", "Project not found");
  }
});
vi.mock("../lib/custom-agents/authz.js", () => ({
  assertProjectAccess: (...args: [unknown, string]) => assertProjectAccess(...args),
}));

vi.mock("../middleware/error-handler.js", () => {
  class AppError extends Error {
    status: number;
    statusCode: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.statusCode = status;
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

beforeEach(() => {
  seenDeliveries.clear();
  vi.clearAllMocks();
  accessibleProjectIds = ["proj-1"];
  authedUser = { userId: "user-1", role: "coordinator", username: "test" };
});

// Issue #96 — `POST /webhooks/github/issues` is no longer registered by this
// router (it was shadowed by the spec-kit receiver and never reached). Its drift
// coverage lives with the single real receiver, in
// `server/tests/webhooks-github-issues-integration.test.ts`.
describe("GitHub issues path is not registered here (#96)", () => {
  it("falls through to 404 instead of serving a second, shadowed handler", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/webhooks/github/issues")
      .set("x-github-event", "issues")
      .set("x-hub-signature-256", "sha256=valid")
      .send({ action: "edited", issue: { id: 1, node_id: "N_1", number: 1 } });
    expect(res.status).toBe(404);
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

  /**
   * #88 — both drift READS checked `sync.read` and nothing else, so any holder
   * of that permission could read (and badge-count) the drift of ANY project by
   * passing its id in the query string. `ui/src/hooks/use-drift-count.ts` is
   * their first UI consumer, which is what surfaced it.
   */
  describe("#88 project access on the drift reads", () => {
    it("GET /sync/drift returns 404 for a project the caller cannot access", async () => {
      const { listDriftEvents } = await import("../lib/sync/index.js");
      const app = createApp();
      const res = await request(app).get("/sync/drift?projectId=proj-other");

      expect(res.status).toBe(404);
      // The refusal happens BEFORE the read, so no drift content is loaded.
      expect(vi.mocked(listDriftEvents)).not.toHaveBeenCalled();
    });

    it("GET /sync/drift/count returns 404 for a project the caller cannot access", async () => {
      const { getDriftCount } = await import("../lib/sync/index.js");
      const app = createApp();
      const res = await request(app).get("/sync/drift/count?projectId=proj-other");

      expect(res.status).toBe(404);
      expect(vi.mocked(getDriftCount)).not.toHaveBeenCalled();
    });

    it("returns 401 rather than skipping the scope check when there is no caller", async () => {
      authedUser = null;
      const { listDriftEvents, getDriftCount } = await import("../lib/sync/index.js");
      const app = createApp();

      const list = await request(app).get("/sync/drift?projectId=proj-1");
      const count = await request(app).get("/sync/drift/count?projectId=proj-1");

      expect(list.status).toBe(401);
      expect(count.status).toBe(401);
      expect(vi.mocked(listDriftEvents)).not.toHaveBeenCalled();
      expect(vi.mocked(getDriftCount)).not.toHaveBeenCalled();
      expect(assertProjectAccess).not.toHaveBeenCalled();
    });

    it("asserts access against the project id the caller actually asked for", async () => {
      const app = createApp();
      await request(app).get("/sync/drift?projectId=proj-1");
      expect(assertProjectAccess).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user-1" }),
        "proj-1",
      );
    });
  });

  it("POST /sync/drift/:id/resolve resolves drift", async () => {
    const app = createApp();
    const res = await request(app).post("/sync/drift/drift-1/resolve").send({ action: "adopt" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.resolution).toBe("adopt");
  });

  /**
   * #102 — the WRITE twin of #88. `sync.resolve` is a role check; it said the
   * caller may resolve drift, never whose. Any holder could resolve another
   * project's drift by id, which destroys that project's signal.
   */
  describe("#102 project access on the drift resolve", () => {
    it("returns 404 and does not resolve a drift in a project the caller cannot access", async () => {
      const { getDriftEventProjectId, resolveDriftEvent } = await import("../lib/sync/index.js");
      vi.mocked(getDriftEventProjectId).mockResolvedValueOnce("proj-other");
      const app = createApp();
      const res = await request(app).post("/sync/drift/drift-9/resolve").send({ action: "adopt" });

      expect(res.status).toBe(404);
      expect(vi.mocked(resolveDriftEvent)).not.toHaveBeenCalled();
    });

    it("answers an inaccessible drift exactly as it answers a nonexistent one", async () => {
      const { getDriftEventProjectId } = await import("../lib/sync/index.js");
      const app = createApp();

      vi.mocked(getDriftEventProjectId).mockResolvedValueOnce("proj-other");
      const foreign = await request(app)
        .post("/sync/drift/drift-9/resolve")
        .send({ action: "adopt" });
      vi.mocked(getDriftEventProjectId).mockResolvedValueOnce(null);
      const missing = await request(app)
        .post("/sync/drift/no-such/resolve")
        .send({ action: "adopt" });

      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      // Same body: the error channel is not an existence oracle across projects.
      expect(foreign.body).toEqual(missing.body);
    });

    it("never consults the scope seam for a drift that does not exist", async () => {
      const { getDriftEventProjectId, resolveDriftEvent } = await import("../lib/sync/index.js");
      vi.mocked(getDriftEventProjectId).mockResolvedValueOnce(null);
      const app = createApp();
      const res = await request(app).post("/sync/drift/no-such/resolve").send({ action: "adopt" });

      expect(res.status).toBe(404);
      expect(assertProjectAccess).not.toHaveBeenCalled();
      expect(vi.mocked(resolveDriftEvent)).not.toHaveBeenCalled();
    });

    it("asserts access against the drift's OWN project, not one the caller names", async () => {
      const { getDriftEventProjectId } = await import("../lib/sync/index.js");
      const app = createApp();
      await request(app)
        .post("/sync/drift/drift-1/resolve?projectId=proj-other")
        .send({ action: "adopt", projectId: "proj-other" });

      expect(vi.mocked(getDriftEventProjectId)).toHaveBeenCalledWith("drift-1");
      expect(assertProjectAccess).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user-1" }),
        "proj-1",
      );
    });

    it("propagates a scope-seam failure that is not a 404", async () => {
      const { resolveDriftEvent } = await import("../lib/sync/index.js");
      assertProjectAccess.mockRejectedValueOnce(new Error("db down"));
      const app = createApp();
      const res = await request(app).post("/sync/drift/drift-1/resolve").send({ action: "adopt" });

      expect(res.status).toBe(500);
      expect(vi.mocked(resolveDriftEvent)).not.toHaveBeenCalled();
    });

    it("returns 401 rather than skipping the scope check when there is no caller", async () => {
      authedUser = null;
      const { resolveDriftEvent } = await import("../lib/sync/index.js");
      const app = createApp();
      const res = await request(app).post("/sync/drift/drift-1/resolve").send({ action: "adopt" });

      expect(res.status).toBe(401);
      expect(vi.mocked(resolveDriftEvent)).not.toHaveBeenCalled();
    });
  });

  it("POST /sync/drift/:id/resolve rejects invalid action", async () => {
    const app = createApp();
    const res = await request(app).post("/sync/drift/drift-1/resolve").send({ action: "invalid" });

    expect(res.status).toBe(400);
  });
});
