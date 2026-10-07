/**
 * Epic #475 (Phase 1, #478) — discussions REST route tests.
 *
 * Covers create-thread, post-(human)-message, and list-history with attribution.
 * The critical invariants: a human post makes NO LLM call and writes NO
 * AITokenUsage row; member-only authz (non-members 404 (#734 — no existence oracle), missing/soft-deleted
 * threads 404); body validation; cursor pagination.
 *
 * Prisma + the access helpers are mocked (the #289 lesson: never touch a real
 * DB in route tests) so this runs hermetically in clean CI.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const logWarn = vi.hoisted(() => vi.fn());
vi.mock("../lib/logger.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/logger.js")>();
  return {
    ...real,
    createChildLogger: (name: string) =>
      name === "discussions-routes"
        ? { ...real.createChildLogger(name), warn: logWarn }
        : real.createChildLogger(name),
  };
});

let currentUser: { userId: string; role: string; workspaces?: string[] } = {
  userId: "u1",
  role: "member",
};
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: typeof currentUser }).user = currentUser;
    next();
  },
}));

// Prisma double — only the calls the router makes.
const threadCreate = vi.fn();
const threadFindFirst = vi.fn();
const threadFindMany = vi.fn();
const threadUpdate = vi.fn();
const messageCreate = vi.fn();
const messageFindMany = vi.fn();
const messageFindFirst = vi.fn();
const aiTokenUsageCreate = vi.fn();
const analysisFindFirst = vi.fn();
const requirementFindFirst = vi.fn();
const specKitFeatureFindFirst = vi.fn();
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    discussionThread: {
      create: (...a: unknown[]) => threadCreate(...a),
      findFirst: (...a: unknown[]) => threadFindFirst(...a),
      findMany: (...a: unknown[]) => threadFindMany(...a),
      update: (...a: unknown[]) => threadUpdate(...a),
    },
    discussionMessage: {
      create: (...a: unknown[]) => messageCreate(...a),
      findMany: (...a: unknown[]) => messageFindMany(...a),
      findFirst: (...a: unknown[]) => messageFindFirst(...a),
    },
    aiTokenUsage: { create: (...a: unknown[]) => aiTokenUsageCreate(...a) },
    analysis: { findFirst: (...a: unknown[]) => analysisFindFirst(...a) },
    requirement: { findFirst: (...a: unknown[]) => requirementFindFirst(...a) },
    specKitFeature: { findFirst: (...a: unknown[]) => specKitFeatureFindFirst(...a) },
  },
}));

// Access guards (#734 — both are the project-access seam; unit-tested in
// lib/discussions/access.test.ts).
const canAccessProjectDiscussions = vi.fn();
const canAccessThread = vi.fn();
vi.mock("../lib/discussions/access.js", () => ({
  canAccessThread: (...a: unknown[]) => canAccessThread(...a),
  canAccessProjectDiscussions: (...a: unknown[]) => canAccessProjectDiscussions(...a),
}));

// Promote helper is unit-tested separately; the route mocks it and asserts
// wiring + the PromoteError → HTTP-status mapping.
const promoteMessageToRequirement = vi.fn();
class PromoteError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PromoteError";
  }
}
vi.mock("../lib/discussions/promote.js", () => ({
  promoteMessageToRequirement: (...a: unknown[]) => promoteMessageToRequirement(...a),
  PromoteError,
}));

// Epic #475 (#481) — the realtime emitter is unit-tested separately; here we
// only assert the route wires the fan-out after persisting a human message.
const emitMessageNew = vi.fn();
const emitMessageStream = vi.fn();
vi.mock("../lib/discussions/socket-emitter.js", () => ({
  emitMessageNew: (...a: unknown[]) => emitMessageNew(...a),
  emitMessageStream: (...a: unknown[]) => emitMessageStream(...a),
}));

// AI responder (#484) — unit-tested separately; the route mocks it and asserts
// it is (or is NOT) invoked depending on the gate, plus SSE wiring. The gate
// itself (`shouldAIRespond`) is the real pure function so the route's decision
// is exercised end-to-end.
const streamAIReply = vi.fn();
vi.mock("../lib/discussions/ai-responder.js", () => ({
  streamAIReply: (...a: unknown[]) => streamAIReply(...a),
}));

// #739 — grounding: chat's auto-RAG builder and the discussion toolset builder
// are unit-tested where they live; the route only wires them to the thread.
const buildAutoRagContext = vi.fn();
vi.mock("./ai.js", () => ({
  buildAutoRagContext: (...a: unknown[]) => buildAutoRagContext(...a),
}));
const resolveDiscussionTools = vi.fn();
vi.mock("../lib/discussions/grounding.js", () => ({
  resolveDiscussionTools: (...a: unknown[]) => resolveDiscussionTools(...a),
}));

// Provider seam — the route builds a provider from config; stub it so no real
// model is constructed in tests.
vi.mock("../lib/ai/index.js", () => ({
  buildProvider: () => ({ key: "offline-stub", model: "offline-stub", offline: true }),
  loadAIConfig: () => ({ provider: "offline-stub", model: "offline-stub" }),
}));

// Audit (#485) — assert the rate-limit denial is audited; spy only.
const audit = vi.fn();
vi.mock("../lib/audit/audit-service.js", () => ({ audit: (...a: unknown[]) => audit(...a) }));

// #775 — the project budget gate. The real error class, so the route's
// `instanceof` mapping onto a 402 is exercised.
const assertWithinBudget = vi.fn();
vi.mock("../lib/finops/budget-enforcer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/finops/budget-enforcer.js")>()),
  assertWithinBudget: (...a: unknown[]) => assertWithinBudget(...a),
}));
const { BudgetExceededError } = await import("../lib/finops/budget-enforcer.js");

// #489 — mention-notification fan-out is unit-tested separately (notify.test.ts);
// here we only assert the post-message route dispatches it with the right args.
const dispatchDiscussionMentions = vi.fn();
vi.mock("../lib/discussions/notify.js", () => ({
  dispatchDiscussionMentions: (...a: unknown[]) => dispatchDiscussionMentions(...a),
}));

// The discussion AI rate limiter is the REAL (deterministic, in-memory) module;
// we reset it between tests and force a tiny limit via env so the deny path is
// exercised through the route end-to-end.
const { __resetThreadAIRateLimiter } = await import("../lib/discussions/ai-rate-limit.js");

const { discussionsRouter } = await import("./discussions.js");
const { errorHandler } = await import("../middleware/error-handler.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/discussions", discussionsRouter());
  app.use(errorHandler);
  return app;
}

describe("discussions routes", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: "u1", role: "member" };
    __resetThreadAIRateLimiter();
    delete process.env.DISCUSSION_AI_RATE_LIMIT_MAX;
    delete process.env.DISCUSSION_AI_RATE_LIMIT_WINDOW_MS;
    app = createApp();
  });

  describe("#734 — project-access seam wiring", () => {
    it("passes the caller's verified workspace claim to the thread check", async () => {
      currentUser = { userId: "u1", role: "developer", workspaces: ["ws1"] };
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      messageFindMany.mockResolvedValue([]);
      await request(app).get("/discussions/threads/t1/messages");
      expect(canAccessThread).toHaveBeenCalledWith(
        { id: "u1", role: "developer", workspaces: ["ws1"] },
        "t1",
      );
    });

    it("passes the claim to the list check and audits under the list action", async () => {
      currentUser = { userId: "u1", role: "developer", workspaces: ["ws1"] };
      canAccessProjectDiscussions.mockResolvedValue(true);
      threadFindMany.mockResolvedValue([]);
      await request(app).get("/discussions/threads?projectId=p1");
      expect(canAccessProjectDiscussions).toHaveBeenCalledWith(
        { id: "u1", role: "developer", workspaces: ["ws1"] },
        "p1",
        expect.objectContaining({ action: "discussion.thread.list" }),
      );
    });

    it("answers a non-member exactly as it answers a missing thread", async () => {
      canAccessThread.mockResolvedValue({ ok: false, reason: "forbidden" });
      const denied = await request(app).get("/discussions/threads/t1/messages");
      canAccessThread.mockResolvedValue({ ok: false, reason: "not_found" });
      const missing = await request(app).get("/discussions/threads/t1/messages");
      expect(denied.status).toBe(404);
      expect(denied.body).toEqual(missing.body);
    });

    it("answers a non-member on the thread list with 404", async () => {
      canAccessProjectDiscussions.mockResolvedValue(false);
      const res = await request(app).get("/discussions/threads?projectId=p1");
      expect(res.status).toBe(404);
      expect(threadFindMany).not.toHaveBeenCalled();
    });
  });

  describe("POST /threads", () => {
    it("creates a project-scoped thread for a project member", async () => {
      canAccessProjectDiscussions.mockResolvedValue(true);
      threadCreate.mockResolvedValue({ id: "t1", projectId: "p1", title: "Perf chat" });

      const res = await request(app)
        .post("/discussions/threads")
        .send({ projectId: "p1", title: "Perf chat" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ success: true, data: { id: "t1", projectId: "p1" } });
      expect(threadCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ projectId: "p1", title: "Perf chat", createdById: "u1" }),
        }),
      );
    });

    it("defaults aiResponseMode is left to the schema default (not set on create)", async () => {
      canAccessProjectDiscussions.mockResolvedValue(true);
      threadCreate.mockResolvedValue({ id: "t1", projectId: "p1" });
      await request(app).post("/discussions/threads").send({ projectId: "p1" });
      const data = threadCreate.mock.calls[0][0].data;
      expect(data.aiResponseMode).toBeUndefined();
    });

    it("audits thread creation with provenance (#489)", async () => {
      canAccessProjectDiscussions.mockResolvedValue(true);
      threadCreate.mockResolvedValue({ id: "t1", projectId: "p1" });
      await request(app).post("/discussions/threads").send({ projectId: "p1" });
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "discussion.thread.created",
          target: { type: "discussion_thread", id: "t1" },
        }),
      );
    });

    it("rejects a non-member with 404", async () => {
      canAccessProjectDiscussions.mockResolvedValue(false);
      const res = await request(app).post("/discussions/threads").send({ projectId: "p1" });
      expect(res.status).toBe(404);
      expect(threadCreate).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "discussion.thread.created" }),
      );
    });

    it("rejects a missing projectId with 400", async () => {
      const res = await request(app).post("/discussions/threads").send({ title: "no project" });
      expect(res.status).toBe(400);
      expect(canAccessProjectDiscussions).not.toHaveBeenCalled();
    });

    it("validates an analysis anchor belongs to the same project", async () => {
      canAccessProjectDiscussions.mockResolvedValue(true);
      analysisFindFirst.mockResolvedValue(null); // anchor not in project
      const res = await request(app)
        .post("/discussions/threads")
        .send({ projectId: "p1", anchor: { analysisId: "a-other" } });
      expect(res.status).toBe(400);
      expect(threadCreate).not.toHaveBeenCalled();
    });

    it("accepts a valid analysis anchor", async () => {
      canAccessProjectDiscussions.mockResolvedValue(true);
      analysisFindFirst.mockResolvedValue({ id: "a1" });
      threadCreate.mockResolvedValue({ id: "t1", projectId: "p1", analysisId: "a1" });
      const res = await request(app)
        .post("/discussions/threads")
        .send({ projectId: "p1", anchor: { analysisId: "a1" } });
      expect(res.status).toBe(201);
      expect(threadCreate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ analysisId: "a1" }) }),
      );
    });

    it("accepts a valid requirement anchor and rejects a foreign one", async () => {
      canAccessProjectDiscussions.mockResolvedValue(true);
      // valid
      requirementFindFirst.mockResolvedValueOnce({ id: "r1" });
      threadCreate.mockResolvedValue({ id: "t1", projectId: "p1", requirementId: "r1" });
      const ok = await request(app)
        .post("/discussions/threads")
        .send({ projectId: "p1", anchor: { requirementId: "r1" } });
      expect(ok.status).toBe(201);
      expect(threadCreate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ requirementId: "r1" }) }),
      );

      // foreign
      requirementFindFirst.mockResolvedValueOnce(null);
      const bad = await request(app)
        .post("/discussions/threads")
        .send({ projectId: "p1", anchor: { requirementId: "r-other" } });
      expect(bad.status).toBe(400);
    });

    it("accepts a valid spec-kit-feature anchor and rejects a foreign one", async () => {
      canAccessProjectDiscussions.mockResolvedValue(true);
      // valid
      specKitFeatureFindFirst.mockResolvedValueOnce({ id: "f1" });
      threadCreate.mockResolvedValue({ id: "t1", projectId: "p1", specKitFeatureId: "f1" });
      const ok = await request(app)
        .post("/discussions/threads")
        .send({ projectId: "p1", anchor: { specKitFeatureId: "f1" } });
      expect(ok.status).toBe(201);
      expect(threadCreate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ specKitFeatureId: "f1" }) }),
      );

      // foreign
      specKitFeatureFindFirst.mockResolvedValueOnce(null);
      const bad = await request(app)
        .post("/discussions/threads")
        .send({ projectId: "p1", anchor: { specKitFeatureId: "f-other" } });
      expect(bad.status).toBe(400);
    });
  });

  // #486 — list a project's discussion threads (drives the Discussions tab's
  // list view). Member-gated like thread creation.
  describe("GET /threads (#486 — list project threads)", () => {
    it("returns the project's threads for a member, newest first", async () => {
      canAccessProjectDiscussions.mockResolvedValue(true);
      threadFindMany.mockResolvedValue([
        { id: "t2", projectId: "p1", title: "Newer", aiResponseMode: "on_mention" },
        { id: "t1", projectId: "p1", title: "Older", aiResponseMode: "off" },
      ]);
      const res = await request(app).get("/discussions/threads?projectId=p1");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true });
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0]).toMatchObject({ id: "t2" });
      // Soft-deleted threads are excluded and order is newest-first.
      expect(threadFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ projectId: "p1", deletedAt: null }),
          orderBy: { createdAt: "desc" },
        }),
      );
    });

    it("rejects a non-member with 404", async () => {
      canAccessProjectDiscussions.mockResolvedValue(false);
      const res = await request(app).get("/discussions/threads?projectId=p1");
      expect(res.status).toBe(404);
      expect(threadFindMany).not.toHaveBeenCalled();
    });

    it("rejects a missing projectId with 400", async () => {
      const res = await request(app).get("/discussions/threads");
      expect(res.status).toBe(400);
      expect(canAccessProjectDiscussions).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /threads/:id (#483 — aiResponseMode)", () => {
    it("updates aiResponseMode for a member and persists it", async () => {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      threadUpdate.mockResolvedValue({ id: "t1", aiResponseMode: "auto" });

      const res = await request(app)
        .patch("/discussions/threads/t1")
        .send({ aiResponseMode: "auto" });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, data: { aiResponseMode: "auto" } });
      expect(threadUpdate).toHaveBeenCalledWith({
        where: { id: "t1" },
        data: { aiResponseMode: "auto" },
      });
    });

    it.each(["off", "on_mention", "auto"])("accepts the %s mode", async (mode) => {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      threadUpdate.mockResolvedValue({ id: "t1", aiResponseMode: mode });
      const res = await request(app)
        .patch("/discussions/threads/t1")
        .send({ aiResponseMode: mode });
      expect(res.status).toBe(200);
    });

    it("rejects an invalid mode with 400 (no update)", async () => {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      const res = await request(app)
        .patch("/discussions/threads/t1")
        .send({ aiResponseMode: "always" });
      expect(res.status).toBe(400);
      expect(threadUpdate).not.toHaveBeenCalled();
    });

    it("rejects an empty payload with 400 (no updatable fields)", async () => {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      const res = await request(app).patch("/discussions/threads/t1").send({});
      expect(res.status).toBe(400);
      expect(threadUpdate).not.toHaveBeenCalled();
    });

    it("returns 404 for a non-member before any update", async () => {
      canAccessThread.mockResolvedValue({ ok: false, reason: "forbidden" });
      const res = await request(app)
        .patch("/discussions/threads/t1")
        .send({ aiResponseMode: "off" });
      expect(res.status).toBe(404);
      expect(threadUpdate).not.toHaveBeenCalled();
    });

    it("returns 404 for a missing / soft-deleted thread", async () => {
      canAccessThread.mockResolvedValue({ ok: false, reason: "not_found" });
      const res = await request(app)
        .patch("/discussions/threads/ghost")
        .send({ aiResponseMode: "off" });
      expect(res.status).toBe(404);
      expect(threadUpdate).not.toHaveBeenCalled();
    });

    // #488 — the settings PATCH now also accepts an optional anchor, validated
    // against the thread's own project (same rule as create-time anchoring).
    it("sets a valid analysis anchor on the thread", async () => {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      analysisFindFirst.mockResolvedValue({ id: "a1" });
      threadUpdate.mockResolvedValue({ id: "t1", analysisId: "a1" });
      const res = await request(app)
        .patch("/discussions/threads/t1")
        .send({ anchor: { analysisId: "a1" } });
      expect(res.status).toBe(200);
      expect(threadUpdate).toHaveBeenCalledWith({
        where: { id: "t1" },
        data: { analysisId: "a1" },
      });
    });

    it("rejects an anchor that is not in the thread's project (400)", async () => {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      requirementFindFirst.mockResolvedValue(null);
      const res = await request(app)
        .patch("/discussions/threads/t1")
        .send({ anchor: { requirementId: "r-other" } });
      expect(res.status).toBe(400);
      expect(threadUpdate).not.toHaveBeenCalled();
    });

    it("updates both aiResponseMode and an anchor together", async () => {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      specKitFeatureFindFirst.mockResolvedValue({ id: "f1" });
      threadUpdate.mockResolvedValue({ id: "t1", aiResponseMode: "auto", specKitFeatureId: "f1" });
      const res = await request(app)
        .patch("/discussions/threads/t1")
        .send({ aiResponseMode: "auto", anchor: { specKitFeatureId: "f1" } });
      expect(res.status).toBe(200);
      expect(threadUpdate).toHaveBeenCalledWith({
        where: { id: "t1" },
        data: { aiResponseMode: "auto", specKitFeatureId: "f1" },
      });
    });
  });

  describe("POST /threads/:id/ai-respond (#484 — triggered AI reply)", () => {
    it("invokes the responder and streams SSE when the gate fires (@AI in on_mention)", async () => {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      threadFindFirst.mockResolvedValue({
        id: "t1",
        projectId: "p1",
        aiResponseMode: "on_mention",
      });
      messageFindFirst.mockResolvedValue({ id: "m1", body: "@AI help", authorKind: "human" });
      messageFindMany.mockResolvedValue([]);
      streamAIReply.mockImplementation(async (input: { onChunk?: (c: unknown) => void }) => {
        input.onChunk?.({ type: "delta", content: "hello" });
        return {
          message: {
            id: "ai-1",
            body: "hello",
            aiModel: "offline-stub",
            aiProvider: "offline-stub",
            aiSessionId: "sess-1",
          },
          usage: { totalTokens: 3 },
        };
      });

      const res = await request(app)
        .post("/discussions/threads/t1/ai-respond")
        .send({ messageId: "m1" });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/event-stream");
      expect(res.text).toContain("event: delta");
      expect(res.text).toContain("hello");
      expect(streamAIReply).toHaveBeenCalledTimes(1);
      const call = streamAIReply.mock.calls[0][0];
      expect(call.thread).toMatchObject({ id: "t1", aiResponseMode: "on_mention" });
      expect(call.triggerMessage).toMatchObject({ id: "m1" });
      expect(call.actor).toMatchObject({ id: "u1" });
    });

    it("#739 — grounds the reply in the THREAD's project: its retrieval and its read-only tools", async () => {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      threadFindFirst.mockResolvedValue({ id: "t1", projectId: "p1", aiResponseMode: "auto" });
      messageFindFirst.mockResolvedValue({
        id: "m1",
        body: "how is a feed scheduled?",
        authorKind: "human",
      });
      messageFindMany.mockResolvedValue([]);
      buildAutoRagContext.mockImplementation(
        async (_p: string, _m: unknown, _d: unknown, capture: { sources: number }) => {
          capture.sources = 2;
          return "## Retrieved Knowledge";
        },
      );
      resolveDiscussionTools.mockResolvedValue({ toolset: "ts" });
      let grounded: unknown[] = [];
      streamAIReply.mockImplementation(
        async (input: {
          retrieve: (q: string) => Promise<unknown>;
          resolveTools: (s: { id: string }) => Promise<unknown>;
        }) => {
          grounded = [await input.retrieve("q?"), await input.resolveTools({ id: "sess-9" })];
          return {
            message: {
              id: "ai-1",
              body: "x",
              aiModel: "m",
              aiProvider: "p",
              aiSessionId: "sess-9",
            },
            usage: { totalTokens: 1 },
          };
        },
      );

      await request(app).post("/discussions/threads/t1/ai-respond").send({ messageId: "m1" });

      expect(buildAutoRagContext).toHaveBeenCalledWith(
        "p1",
        [{ role: "user", content: "q?" }],
        undefined,
        expect.objectContaining({ contexts: expect.any(Array) }),
      );
      expect(resolveDiscussionTools).toHaveBeenCalledWith(
        expect.objectContaining({
          session: { id: "sess-9", userId: "u1", projectId: "p1" },
          model: "offline-stub",
        }),
      );
      expect(grounded).toEqual([
        { block: "## Retrieved Knowledge", sources: 2 },
        { toolset: "ts" },
      ]);
    });

    // #486 — the AI reply must ALSO fan out over the `thread:{id}` room (not only
    // SSE) so other connected members see it live like a human message. Token
    // deltas mirror to `emitMessageStream`; the persisted reply publishes via
    // `emitMessageNew` once `streamAIReply` resolves.
    it("fans the AI reply out to the thread room (stream chunks + persisted message)", async () => {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      threadFindFirst.mockResolvedValue({
        id: "t1",
        projectId: "p1",
        aiResponseMode: "on_mention",
      });
      messageFindFirst.mockResolvedValue({ id: "m1", body: "@AI help", authorKind: "human" });
      messageFindMany.mockResolvedValue([]);
      streamAIReply.mockImplementation(async (input: { onChunk?: (c: unknown) => void }) => {
        input.onChunk?.({ type: "delta", content: "hi " });
        input.onChunk?.({ type: "delta", content: "there" });
        return {
          message: {
            id: "ai-9",
            body: "hi there",
            aiModel: "offline-stub",
            aiProvider: "offline-stub",
            aiSessionId: "sess-9",
          },
          usage: { totalTokens: 5 },
        };
      });

      await request(app).post("/discussions/threads/t1/ai-respond").send({ messageId: "m1" });

      // One stream emit per delta + one terminal done frame.
      expect(emitMessageStream).toHaveBeenCalledWith("t1", { delta: "hi " });
      expect(emitMessageStream).toHaveBeenCalledWith("t1", { delta: "there" });
      expect(emitMessageStream).toHaveBeenCalledWith("t1", {
        delta: "",
        messageId: "ai-9",
        done: true,
      });
      // The persisted AI message fans out as a `message:new` with attribution.
      expect(emitMessageNew).toHaveBeenCalledTimes(1);
      const [room, msg] = emitMessageNew.mock.calls[0];
      expect(room).toBe("t1");
      expect(msg).toMatchObject({
        id: "ai-9",
        threadId: "t1",
        authorKind: "ai",
        authorUserId: null,
        aiModel: "offline-stub",
        aiProvider: "offline-stub",
        aiSessionId: "sess-9",
        body: "hi there",
      });
    });

    it("does NOT fan out a message:new when the responder errors mid-stream", async () => {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      threadFindFirst.mockResolvedValue({
        id: "t1",
        projectId: "p1",
        aiResponseMode: "on_mention",
      });
      messageFindFirst.mockResolvedValue({ id: "m1", body: "@AI help", authorKind: "human" });
      messageFindMany.mockResolvedValue([]);
      streamAIReply.mockImplementation(async (input: { onChunk?: (c: unknown) => void }) => {
        input.onChunk?.({ type: "delta", content: "partial" });
        throw new Error("boom");
      });

      await request(app).post("/discussions/threads/t1/ai-respond").send({ messageId: "m1" });
      // The delta still mirrors to the room, but no authoritative message:new is
      // published because nothing was persisted on the error path.
      expect(emitMessageStream).toHaveBeenCalledWith("t1", { delta: "partial" });
      expect(emitMessageNew).not.toHaveBeenCalled();
    });

    it("does NOT invoke the provider when mode=off, even on an @AI mention (cost control)", async () => {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      threadFindFirst.mockResolvedValue({ id: "t1", projectId: "p1", aiResponseMode: "off" });
      messageFindFirst.mockResolvedValue({ id: "m1", body: "@AI help", authorKind: "human" });

      const res = await request(app)
        .post("/discussions/threads/t1/ai-respond")
        .send({ messageId: "m1" });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, data: { responded: false } });
      expect(streamAIReply).not.toHaveBeenCalled();
    });

    it("does NOT invoke the provider for a plain statement in on_mention mode", async () => {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      threadFindFirst.mockResolvedValue({
        id: "t1",
        projectId: "p1",
        aiResponseMode: "on_mention",
      });
      messageFindFirst.mockResolvedValue({
        id: "m1",
        body: "the build is green",
        authorKind: "human",
      });

      const res = await request(app)
        .post("/discussions/threads/t1/ai-respond")
        .send({ messageId: "m1" });

      expect(res.body).toMatchObject({ data: { responded: false } });
      expect(streamAIReply).not.toHaveBeenCalled();
    });

    it("invokes the provider for a clear question in auto mode (no mention needed)", async () => {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      threadFindFirst.mockResolvedValue({ id: "t1", projectId: "p1", aiResponseMode: "auto" });
      messageFindFirst.mockResolvedValue({
        id: "m1",
        body: "what are the perf targets?",
        authorKind: "human",
      });
      messageFindMany.mockResolvedValue([]);
      streamAIReply.mockResolvedValue({
        message: {
          id: "ai-1",
          aiProvider: "stub",
          aiModel: "stub-model",
          aiSessionId: "sess-1",
          body: "answer",
        },
        usage: { totalTokens: 42 },
      });

      await request(app).post("/discussions/threads/t1/ai-respond").send({ messageId: "m1" });
      expect(streamAIReply).toHaveBeenCalledTimes(1);
    });

    it("audits the AI invocation with model id + token-usage reference (#489)", async () => {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      threadFindFirst.mockResolvedValue({ id: "t1", projectId: "p1", aiResponseMode: "auto" });
      messageFindFirst.mockResolvedValue({
        id: "m1",
        body: "what are the perf targets?",
        authorKind: "human",
      });
      messageFindMany.mockResolvedValue([]);
      streamAIReply.mockResolvedValue({
        message: {
          id: "ai-1",
          aiProvider: "stub",
          aiModel: "stub-model",
          aiSessionId: "sess-1",
          body: "answer",
        },
        usage: { totalTokens: 42 },
      });

      await request(app).post("/discussions/threads/t1/ai-respond").send({ messageId: "m1" });

      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "discussion.ai.invoked",
          target: { type: "discussion_thread", id: "t1" },
          metadata: expect.objectContaining({
            aiModel: "stub-model",
            aiSessionId: "sess-1",
            totalTokens: 42,
          }),
        }),
      );
    });

    it("returns 404 when the trigger message is not in the thread", async () => {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      threadFindFirst.mockResolvedValue({ id: "t1", projectId: "p1", aiResponseMode: "auto" });
      messageFindFirst.mockResolvedValue(null);

      const res = await request(app)
        .post("/discussions/threads/t1/ai-respond")
        .send({ messageId: "ghost" });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("MESSAGE_NOT_FOUND");
      expect(streamAIReply).not.toHaveBeenCalled();
    });

    it("rejects a missing messageId with 400", async () => {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      const res = await request(app).post("/discussions/threads/t1/ai-respond").send({});
      expect(res.status).toBe(400);
      expect(streamAIReply).not.toHaveBeenCalled();
    });

    it("returns 404 for a non-member before any provider work", async () => {
      canAccessThread.mockResolvedValue({ ok: false, reason: "forbidden" });
      const res = await request(app)
        .post("/discussions/threads/t1/ai-respond")
        .send({ messageId: "m1" });
      expect(res.status).toBe(404);
      expect(streamAIReply).not.toHaveBeenCalled();
    });

    it("returns 404 for a missing / soft-deleted thread", async () => {
      canAccessThread.mockResolvedValue({ ok: false, reason: "not_found" });
      const res = await request(app)
        .post("/discussions/threads/ghost/ai-respond")
        .send({ messageId: "m1" });
      expect(res.status).toBe(404);
      expect(streamAIReply).not.toHaveBeenCalled();
    });

    it("still streams + ends the SSE response if the responder errors mid-stream", async () => {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      threadFindFirst.mockResolvedValue({
        id: "t1",
        projectId: "p1",
        aiResponseMode: "on_mention",
      });
      messageFindFirst.mockResolvedValue({ id: "m1", body: "@AI help", authorKind: "human" });
      messageFindMany.mockResolvedValue([]);
      streamAIReply.mockImplementation(async (input: { onChunk?: (c: unknown) => void }) => {
        input.onChunk?.({ type: "error", code: "AI_PROVIDER_ERROR", message: "boom" });
        throw new Error("boom");
      });

      const res = await request(app)
        .post("/discussions/threads/t1/ai-respond")
        .send({ messageId: "m1" });

      expect(res.status).toBe(200);
      expect(res.text).toContain("event: error");
    });
  });

  // #541 — the /api/ai/stream write-after-end guards (#506/#521) applied to the
  // other SSE route. A write after `res.end()` is not thrown: Node emits
  // ERR_STREAM_WRITE_AFTER_END as an `'error'` on the response a tick later,
  // which with no listener is an uncaught exception. These tests assert on the
  // response itself, as ai-routes.test.ts's #521 block does.
  describe("POST /threads/:id/ai-respond — no write after the response ended (#541)", () => {
    type Probe = {
      res: import("express").Response | null;
      /** Every chunk written while `res.writableEnded` was already true. */
      writesAfterEnd: string[];
      errors: Error[];
    };

    function makeProbedApp(probe: Probe, opts: { listenForErrors: boolean }) {
      const probed = express();
      probed.use(express.json());
      probed.use((_req, res, next) => {
        probe.res = res;
        const write = res.write.bind(res) as (...args: unknown[]) => boolean;
        res.write = ((chunk: unknown, ...rest: unknown[]) => {
          if (res.writableEnded) probe.writesAfterEnd.push(String(chunk));
          return write(chunk, ...rest);
        }) as typeof res.write;
        if (opts.listenForErrors) res.on("error", (e: Error) => probe.errors.push(e));
        next();
      });
      probed.use("/discussions", discussionsRouter());
      probed.use(errorHandler);
      return probed;
    }

    function armTriggerable() {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      threadFindFirst.mockResolvedValue({
        id: "t1",
        projectId: "p1",
        aiResponseMode: "on_mention",
      });
      messageFindFirst.mockResolvedValue({ id: "m1", body: "@AI help", authorKind: "human" });
      messageFindMany.mockResolvedValue([]);
    }

    const reply = {
      message: {
        id: "ai-1",
        body: "hello",
        aiModel: "offline-stub",
        aiProvider: "offline-stub",
        aiSessionId: "sess-1",
      },
      usage: { totalTokens: 3 },
    };

    it("drops a chunk that arrives after the response has ended", async () => {
      armTriggerable();
      let lateChunk: ((c: unknown) => void) | undefined;
      streamAIReply.mockImplementation(async (input: { onChunk?: (c: unknown) => void }) => {
        input.onChunk?.({ type: "delta", content: "hello" });
        // A provider callback that outlives the turn keeps its `onChunk`.
        lateChunk = input.onChunk;
        return reply;
      });
      const probe: Probe = { res: null, writesAfterEnd: [], errors: [] };

      const res = await request(makeProbedApp(probe, { listenForErrors: true }))
        .post("/discussions/threads/t1/ai-respond")
        .send({ messageId: "m1" });
      expect(res.text).toContain("event: done");
      expect(probe.res!.writableEnded).toBe(true);

      lateChunk!({ type: "delta", content: "late" });
      // Node emits a write-after-end error on the next tick; let it land.
      await new Promise((r) => setImmediate(r));
      expect(probe.writesAfterEnd).toEqual([]);
      expect(probe.errors).toEqual([]);
    });

    it("an `error` on the response is handled rather than thrown", async () => {
      armTriggerable();
      const probe: Probe = { res: null, writesAfterEnd: [], errors: [] };
      let thrown: unknown;
      streamAIReply.mockImplementation(async (input: { onChunk?: (c: unknown) => void }) => {
        input.onChunk?.({ type: "delta", content: "hello" });
        // With no listener, EventEmitter throws an emitted `error` — in
        // production that is an uncaught exception that ends the process.
        try {
          probe.res!.emit("error", new Error("socket reset"));
        } catch (err) {
          thrown = err;
        }
        return reply;
      });

      const res = await request(makeProbedApp(probe, { listenForErrors: false }))
        .post("/discussions/threads/t1/ai-respond")
        .send({ messageId: "m1" });

      expect(res.status).toBe(200);
      expect(thrown).toBeUndefined();
      expect(res.text).toContain("event: done");
      // PR #546 review — the error is recorded, not merely swallowed.
      expect(logWarn).toHaveBeenCalledWith(
        "Discussion AI stream response emitted an error",
        expect.objectContaining({ threadId: "t1", userId: "u1", error: "socket reset" }),
      );
    });
  });

  describe("POST /threads/:id/ai-respond budget gate (#775)", () => {
    function armTriggerable() {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      threadFindFirst.mockResolvedValue({
        id: "t1",
        projectId: "p1",
        aiResponseMode: "on_mention",
      });
      messageFindFirst.mockResolvedValue({ id: "m1", body: "@AI help", authorKind: "human" });
      messageFindMany.mockResolvedValue([]);
      streamAIReply.mockResolvedValue({ message: { id: "ai-1" }, usage: {} });
    }

    it("checks the THREAD's project budget before replying", async () => {
      armTriggerable();
      const res = await request(app)
        .post("/discussions/threads/t1/ai-respond")
        .send({ messageId: "m1" });
      expect(res.status).toBe(200);
      expect(assertWithinBudget).toHaveBeenCalledWith("p1");
      expect(streamAIReply).toHaveBeenCalledTimes(1);
    });

    it("answers 402 over budget, makes no provider call, spends no rate-limit slot, and audits", async () => {
      process.env.DISCUSSION_AI_RATE_LIMIT_MAX = "1";
      armTriggerable();
      assertWithinBudget.mockRejectedValueOnce(new BudgetExceededError(1200, 1000));

      const res = await request(app)
        .post("/discussions/threads/t1/ai-respond")
        .send({ messageId: "m1" });

      expect(res.status).toBe(402);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.body.error).toMatchObject({ code: "BUDGET_EXCEEDED" });
      expect(streamAIReply).not.toHaveBeenCalled();
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "discussion.ai.budget_exceeded",
          target: { type: "discussion_thread", id: "t1" },
          metadata: { usedTokens: 1200, budget: 1000 },
        }),
      );

      // The denied request did not consume the single allowed invocation.
      const next = await request(app)
        .post("/discussions/threads/t1/ai-respond")
        .send({ messageId: "m1" });
      expect(next.status).toBe(200);
    });

    it("does not reach the gate when the trigger gate declines (no @AI)", async () => {
      armTriggerable();
      messageFindFirst.mockResolvedValue({ id: "m1", body: "just chatting", authorKind: "human" });
      await request(app).post("/discussions/threads/t1/ai-respond").send({ messageId: "m1" });
      expect(assertWithinBudget).not.toHaveBeenCalled();
    });
  });

  describe("POST /threads/:id/ai-respond rate limiting (#485)", () => {
    function armTriggerable() {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      threadFindFirst.mockResolvedValue({
        id: "t1",
        projectId: "p1",
        aiResponseMode: "on_mention",
      });
      messageFindFirst.mockResolvedValue({ id: "m1", body: "@AI help", authorKind: "human" });
      messageFindMany.mockResolvedValue([]);
      streamAIReply.mockResolvedValue({ message: { id: "ai-1" }, usage: {} });
    }

    it("allows invocations under the per-(thread,user) limit", async () => {
      process.env.DISCUSSION_AI_RATE_LIMIT_MAX = "2";
      armTriggerable();

      const a = await request(app)
        .post("/discussions/threads/t1/ai-respond")
        .send({ messageId: "m1" });
      const b = await request(app)
        .post("/discussions/threads/t1/ai-respond")
        .send({ messageId: "m1" });
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(streamAIReply).toHaveBeenCalledTimes(2);
    });

    it("blocks the invocation that exceeds the limit with 429 and does NOT call the provider", async () => {
      process.env.DISCUSSION_AI_RATE_LIMIT_MAX = "1";
      armTriggerable();

      const ok = await request(app)
        .post("/discussions/threads/t1/ai-respond")
        .send({ messageId: "m1" });
      expect(ok.status).toBe(200);

      const blocked = await request(app)
        .post("/discussions/threads/t1/ai-respond")
        .send({ messageId: "m1" });
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe("DISCUSSION_AI_RATE_LIMITED");
      expect(blocked.headers["retry-after"]).toBeDefined();
      // Provider was called exactly once (for the allowed request) — the blocked
      // one never reached streamAIReply.
      expect(streamAIReply).toHaveBeenCalledTimes(1);
      // The denial is audited.
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "discussion.ai.rate_limited" }),
      );
    });

    it("scopes the limit per user — a second user in the same thread is not blocked", async () => {
      process.env.DISCUSSION_AI_RATE_LIMIT_MAX = "1";
      armTriggerable();

      currentUser = { userId: "u1", role: "member" };
      await request(app).post("/discussions/threads/t1/ai-respond").send({ messageId: "m1" });
      const u1Blocked = await request(app)
        .post("/discussions/threads/t1/ai-respond")
        .send({ messageId: "m1" });
      expect(u1Blocked.status).toBe(429);

      // Switch to u2 — independent budget.
      currentUser = { userId: "u2", role: "member" };
      const u2 = await request(app)
        .post("/discussions/threads/t1/ai-respond")
        .send({ messageId: "m1" });
      expect(u2.status).toBe(200);
    });

    it("does NOT rate-limit when the gate says no (no AI invocation to limit)", async () => {
      process.env.DISCUSSION_AI_RATE_LIMIT_MAX = "1";
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      threadFindFirst.mockResolvedValue({
        id: "t1",
        projectId: "p1",
        aiResponseMode: "on_mention",
      });
      // Plain statement → gate returns false, so the limiter is never consulted.
      messageFindFirst.mockResolvedValue({
        id: "m1",
        body: "the build is green",
        authorKind: "human",
      });

      // Many calls — all return responded:false, none 429.
      for (let i = 0; i < 5; i++) {
        const res = await request(app)
          .post("/discussions/threads/t1/ai-respond")
          .send({ messageId: "m1" });
        expect(res.body).toMatchObject({ data: { responded: false } });
      }
      expect(audit).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "discussion.ai.rate_limited" }),
      );
    });
  });

  describe("POST /threads/:id/messages", () => {
    it("inserts a human message attributed to the JWT user — no LLM, no AITokenUsage", async () => {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      messageCreate.mockResolvedValue({
        id: "m1",
        threadId: "t1",
        authorKind: "human",
        authorUserId: "u1",
        body: "hi",
      });

      const res = await request(app).post("/discussions/threads/t1/messages").send({ body: "hi" });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ authorKind: "human", authorUserId: "u1" });
      // The cost-control guarantee: zero AITokenUsage writes.
      expect(aiTokenUsageCreate).not.toHaveBeenCalled();
      const data = messageCreate.mock.calls[0][0].data;
      expect(data).toMatchObject({
        threadId: "t1",
        authorKind: "human",
        authorUserId: "u1",
        aiProvider: null,
        aiModel: null,
        aiSessionId: null,
      });
      // #481 — the new message is fanned out to the thread room after persist.
      expect(emitMessageNew).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({ id: "m1", authorKind: "human", authorUserId: "u1" }),
      );
    });

    it("dispatches @mention notifications with thread/project/message context (#489)", async () => {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      messageCreate.mockResolvedValue({
        id: "m1",
        threadId: "t1",
        authorKind: "human",
        authorUserId: "u1",
        body: "hey @bob",
      });

      await request(app).post("/discussions/threads/t1/messages").send({ body: "hey @bob" });

      expect(dispatchDiscussionMentions).toHaveBeenCalledWith({
        threadId: "t1",
        projectId: "p1",
        messageId: "m1",
        body: "hey @bob",
        authorId: "u1",
      });
    });

    it("does NOT dispatch mentions when the post is rejected (404)", async () => {
      canAccessThread.mockResolvedValue({ ok: false, reason: "forbidden" });
      await request(app).post("/discussions/threads/t1/messages").send({ body: "@bob" });
      expect(dispatchDiscussionMentions).not.toHaveBeenCalled();
    });

    it("rejects an empty body with 400 (and no message row)", async () => {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      const res = await request(app).post("/discussions/threads/t1/messages").send({ body: "" });
      expect(res.status).toBe(400);
      expect(messageCreate).not.toHaveBeenCalled();
    });

    it("rejects an over-long body with 400", async () => {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      const res = await request(app)
        .post("/discussions/threads/t1/messages")
        .send({ body: "x".repeat(10001) });
      expect(res.status).toBe(400);
      expect(messageCreate).not.toHaveBeenCalled();
    });

    it("returns 404 when the caller cannot access the thread", async () => {
      canAccessThread.mockResolvedValue({ ok: false, reason: "forbidden" });
      const res = await request(app).post("/discussions/threads/t1/messages").send({ body: "hi" });
      expect(res.status).toBe(404);
      expect(messageCreate).not.toHaveBeenCalled();
    });

    it("returns 404 for a missing / soft-deleted thread", async () => {
      canAccessThread.mockResolvedValue({ ok: false, reason: "not_found" });
      const res = await request(app)
        .post("/discussions/threads/ghost/messages")
        .send({ body: "hi" });
      expect(res.status).toBe(404);
      expect(messageCreate).not.toHaveBeenCalled();
    });
  });

  describe("GET /threads/:id/messages", () => {
    it("returns paginated history with explicit attribution for a member", async () => {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      messageFindMany.mockResolvedValue([
        { id: "m1", authorKind: "human", authorUserId: "u1", body: "hi", createdAt: new Date() },
        { id: "m2", authorKind: "ai", aiModel: "gpt-4", body: "hello", createdAt: new Date() },
      ]);

      const res = await request(app).get("/discussions/threads/t1/messages?limit=2");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0]).toMatchObject({ authorKind: "human" });
      expect(res.body.data[1]).toMatchObject({ authorKind: "ai" });
    });

    it("#734 — names each human author instead of returning only the raw user id", async () => {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      messageFindMany.mockResolvedValue([
        {
          id: "m1",
          authorKind: "human",
          authorUserId: "u1",
          authorUser: { displayName: "Test Developer" },
          body: "hi",
          createdAt: new Date(),
        },
        { id: "m2", authorKind: "human", authorUserId: null, authorUser: null, body: "x" },
        { id: "m3", authorKind: "ai", aiModel: "gpt-4", authorUser: null, body: "hello" },
      ]);

      const res = await request(app).get("/discussions/threads/t1/messages");

      expect(messageFindMany.mock.calls[0][0].select.authorUser).toEqual({
        select: { displayName: true },
      });
      expect(res.body.data[0]).toMatchObject({ authorUserId: "u1", authorName: "Test Developer" });
      expect(res.body.data[0]).not.toHaveProperty("authorUser");
      expect(res.body.data[1]).not.toHaveProperty("authorName");
      expect(res.body.data[2]).not.toHaveProperty("authorName");
    });

    it("forwards the cursor and a bounded limit to prisma", async () => {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      messageFindMany.mockResolvedValue([]);

      await request(app).get("/discussions/threads/t1/messages?cursor=m5&limit=5");

      const args = messageFindMany.mock.calls[0][0];
      expect(args.take).toBe(5);
      expect(args.cursor).toEqual({ id: "m5" });
      expect(args.skip).toBe(1);
      expect(args.where).toMatchObject({ threadId: "t1", deletedAt: null });
    });

    it("clamps an oversized limit to the max page size", async () => {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      messageFindMany.mockResolvedValue([]);
      await request(app).get("/discussions/threads/t1/messages?limit=9999");
      expect(messageFindMany.mock.calls[0][0].take).toBe(100);
    });

    it("returns 404 for a non-member", async () => {
      canAccessThread.mockResolvedValue({ ok: false, reason: "forbidden" });
      const res = await request(app).get("/discussions/threads/t1/messages");
      expect(res.status).toBe(404);
      expect(messageFindMany).not.toHaveBeenCalled();
    });

    it("returns 404 for a missing thread", async () => {
      canAccessThread.mockResolvedValue({ ok: false, reason: "not_found" });
      const res = await request(app).get("/discussions/threads/ghost/messages");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /threads/:id/messages/:messageId/promote", () => {
    it("promotes a message and returns the new requirement id (201)", async () => {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      promoteMessageToRequirement.mockResolvedValue({
        requirementId: "req-1",
        analysisId: "a1",
        analysisIdSource: "latest-analysis",
      });

      const res = await request(app)
        .post("/discussions/threads/t1/messages/m1/promote")
        .send({ title: "SSO support", type: "feature", priority: "high" });

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ requirementId: "req-1" });
      expect(promoteMessageToRequirement).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "t1",
          messageId: "m1",
          title: "SSO support",
          type: "feature",
          priority: "high",
          actor: expect.objectContaining({ id: "u1" }),
        }),
      );
    });

    it("rejects a non-member with 404 before promoting", async () => {
      canAccessThread.mockResolvedValue({ ok: false, reason: "forbidden" });
      const res = await request(app)
        .post("/discussions/threads/t1/messages/m1/promote")
        .send({ title: "x" });
      expect(res.status).toBe(404);
      expect(promoteMessageToRequirement).not.toHaveBeenCalled();
    });

    it("returns 404 when the thread is missing", async () => {
      canAccessThread.mockResolvedValue({ ok: false, reason: "not_found" });
      const res = await request(app)
        .post("/discussions/threads/ghost/messages/m1/promote")
        .send({ title: "x" });
      expect(res.status).toBe(404);
    });

    it("rejects a missing title with 400", async () => {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      const res = await request(app)
        .post("/discussions/threads/t1/messages/m1/promote")
        .send({ type: "feature" });
      expect(res.status).toBe(400);
      expect(promoteMessageToRequirement).not.toHaveBeenCalled();
    });

    it("maps a MESSAGE_NOT_FOUND PromoteError to 404", async () => {
      canAccessThread.mockResolvedValue({ ok: true, projectId: "p1" });
      promoteMessageToRequirement.mockRejectedValue(
        new PromoteError("MESSAGE_NOT_FOUND", "Message not found in this thread"),
      );
      const res = await request(app)
        .post("/discussions/threads/t1/messages/ghost/promote")
        .send({ title: "x" });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("MESSAGE_NOT_FOUND");
    });
  });
});
