/**
 * Epic #192 (A.3) — webhook router tests.
 */
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const updateMany = vi.hoisted(() => vi.fn(async () => ({ count: 0 })));
const findMany = vi.hoisted(() => vi.fn(async () => [] as Array<unknown>));
const repoFindMany = vi.hoisted(() => vi.fn(async () => [] as unknown[]));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    publishedIssue: { findMany },
    requirement: { updateMany },
    requirementImplementation: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
    },
    repoConnection: { findMany: repoFindMany },
    agentRun: {
      create: vi.fn(async () => ({ id: "run1" })),
      update: vi.fn(async () => ({})),
      findUnique: vi.fn(async () => ({ id: "run1", startedAt: new Date() })),
    },
    agentRunStep: { count: vi.fn(async () => 0), create: vi.fn(async () => ({ id: "step1" })) },
  },
}));

import { githubPrWebhookRouter } from "../src/routes/webhooks-github.js";

const SECRET = "webhook-secret";

beforeEach(() => {
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  updateMany.mockClear();
  findMany.mockClear();
  repoFindMany.mockClear();
});

afterEach(() => {
  delete process.env.GITHUB_WEBHOOK_SECRET;
});

function makeApp(): express.Application {
  const app = express();
  app.use(
    express.json({
      verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
        req.rawBody = buf.toString("utf8");
      },
    }),
  );
  app.use("/api/webhooks", githubPrWebhookRouter());
  return app;
}

function sign(body: string): string {
  return "sha256=" + crypto.createHmac("sha256", SECRET).update(body).digest("hex");
}

describe("POST /api/webhooks/github/pr", () => {
  it("rejects an unsigned request with 401", async () => {
    const app = makeApp();
    const res = await request(app).post("/api/webhooks/github/pr").send({ action: "opened" });
    expect(res.status).toBe(401);
  });

  it("rejects a tampered body with 401", async () => {
    const app = makeApp();
    const body = JSON.stringify({ action: "opened", pull_request: { number: 1 } });
    const res = await request(app)
      .post("/api/webhooks/github/pr")
      .set("content-type", "application/json")
      .set("x-hub-signature-256", sign("different"))
      .send(body);
    expect(res.status).toBe(401);
  });

  it("returns 200 with handled:false for actions we ignore", async () => {
    const app = makeApp();
    const body = JSON.stringify({
      action: "labeled",
      pull_request: { number: 1, merged: false },
      repository: { full_name: "acme/proj" },
    });
    const res = await request(app)
      .post("/api/webhooks/github/pr")
      .set("content-type", "application/json")
      .set("x-hub-signature-256", sign(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.handled).toBe(false);
  });

  it("triggers living-spec sync on closed+merged", async () => {
    findMany.mockResolvedValueOnce([
      { issueNumber: 5, draft: { requirementId: "req1", projectId: "proj1" } },
    ]);
    const app = makeApp();
    const body = JSON.stringify({
      action: "closed",
      pull_request: {
        number: 42,
        merged: true,
        body: "Closes #5",
        merged_at: "2026-04-26T00:00:00Z",
        merge_commit_sha: "abc",
      },
      repository: { full_name: "acme/proj" },
    });
    const res = await request(app)
      .post("/api/webhooks/github/pr")
      .set("content-type", "application/json")
      .set("x-hub-signature-256", sign(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.handled).toBe(true);
    expect(res.body.kind).toBe("merged");
    expect(updateMany).toHaveBeenCalled();
  });

  it("returns handled:true kind:reviewable on opened (no judge configured = noop)", async () => {
    const app = makeApp();
    const body = JSON.stringify({
      action: "opened",
      pull_request: { number: 1, body: "" },
      repository: { full_name: "acme/proj" },
    });
    const res = await request(app)
      .post("/api/webhooks/github/pr")
      .set("content-type", "application/json")
      .set("x-hub-signature-256", sign(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.handled).toBe(true);
    expect(res.body.kind).toBe("reviewable");
  });

  it("invokes the judge when judge+octokit are injected and project.autoReviewPrs is true", async () => {
    repoFindMany.mockResolvedValueOnce([{ project: { id: "proj1", autoReviewPrs: true } }]);
    // AC traceability now resolves criteria via PublishedIssue lookup; the
    // legacy in-body heuristic was retired in Epic #394 (#398).
    findMany.mockResolvedValueOnce([
      {
        issueNumber: 5,
        draft: {
          id: "draft-5",
          body: "## Acceptance criteria\n- [ ] **Given** x **When** y **Then** z",
        },
      },
    ]);
    const judgeFn = vi.fn(async () =>
      JSON.stringify({
        verdicts: [{ acId: "AC1", verdict: "satisfied", reasoning: "", evidenceFiles: [] }],
        comments: [],
        overallVerdict: "approve",
        summary: "ok",
      }),
    );
    const createReview = vi.fn(async () => ({ data: { id: 1, html_url: "u" } }));
    // (#399) — webhook now fetches the real diff from Octokit before the
    // judge runs. Inject a stub `pulls.get` returning a tiny diff.
    const getPull = vi.fn(async () => ({
      data: "diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-a\n+b\n",
    }));
    const app = express();
    app.use(
      express.json({
        verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
          req.rawBody = buf.toString("utf8");
        },
      }),
    );
    app.use(
      "/api/webhooks",
      githubPrWebhookRouter({
        judge: { evaluate: judgeFn },
        octokit: { pulls: { createReview, get: getPull } },
        // Tests don't stub the Project / TokenUsage tables — short-circuit
        // the budget guard with a no-cap stub so the review proceeds.
        budget: {
          check: async () => ({
            allowed: true,
            capCents: null,
            spentCents: 0,
            monthBucket: "2026-04",
            resetAt: "2026-05-01T00:00:00.000Z",
          }),
          record: async () => undefined,
        },
      }),
    );
    const body = JSON.stringify({
      action: "opened",
      pull_request: {
        number: 7,
        title: "feat",
        body: "Closes #5\n- [ ] **Given x When y Then z**",
      },
      repository: { full_name: "acme/proj" },
    });
    const res = await request(app)
      .post("/api/webhooks/github/pr")
      .set("content-type", "application/json")
      .set("x-hub-signature-256", sign(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(judgeFn).toHaveBeenCalledTimes(1);
    expect(createReview).toHaveBeenCalledTimes(1);
  });

  it("skips the review (no_published_issue) when the linked issue cannot be resolved", async () => {
    repoFindMany.mockResolvedValueOnce([{ project: { id: "proj1", autoReviewPrs: true } }]);
    findMany.mockResolvedValueOnce([]); // no PublishedIssue match
    const judgeFn = vi.fn(async () => "{}");
    const app = express();
    app.use(
      express.json({
        verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
          req.rawBody = buf.toString("utf8");
        },
      }),
    );
    app.use(
      "/api/webhooks",
      githubPrWebhookRouter({
        judge: { evaluate: judgeFn },
        octokit: { pulls: { createReview: vi.fn(), get: vi.fn() } },
      }),
    );
    const body = JSON.stringify({
      action: "opened",
      pull_request: { number: 8, body: "Closes #99", title: "" },
      repository: { full_name: "acme/proj" },
    });
    const res = await request(app)
      .post("/api/webhooks/github/pr")
      .set("content-type", "application/json")
      .set("x-hub-signature-256", sign(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(judgeFn).not.toHaveBeenCalled();
  });

  it("skips with diff_too_large when the PR diff exceeds the configured cap", async () => {
    repoFindMany.mockResolvedValueOnce([
      {
        project: {
          id: "proj1",
          autoReviewPrs: true,
          prReviewMaxDiffBytes: 50,
        },
      },
    ]);
    findMany.mockResolvedValueOnce([
      {
        issueNumber: 5,
        draft: {
          id: "draft-5",
          body: "## Acceptance criteria\n- [ ] **Given** x **When** y **Then** z",
        },
      },
    ]);
    const judgeFn = vi.fn(async () => "{}");
    const oversized = "diff --git a/x b/x\n" + "+a\n".repeat(500);
    const app = express();
    app.use(
      express.json({
        verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
          req.rawBody = buf.toString("utf8");
        },
      }),
    );
    app.use(
      "/api/webhooks",
      githubPrWebhookRouter({
        judge: { evaluate: judgeFn },
        octokit: {
          pulls: {
            createReview: vi.fn(),
            get: vi.fn(async () => ({ data: oversized })),
          },
        },
      }),
    );
    const body = JSON.stringify({
      action: "opened",
      pull_request: { number: 9, body: "Closes #5", title: "" },
      repository: { full_name: "acme/proj" },
    });
    const res = await request(app)
      .post("/api/webhooks/github/pr")
      .set("content-type", "application/json")
      .set("x-hub-signature-256", sign(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(judgeFn).not.toHaveBeenCalled();
  });

  it("skips when octokit.pulls.get throws (audit-only, no 500)", async () => {
    repoFindMany.mockResolvedValueOnce([{ project: { id: "proj1", autoReviewPrs: true } }]);
    findMany.mockResolvedValueOnce([
      {
        issueNumber: 5,
        draft: {
          id: "draft-5",
          body: "## Acceptance criteria\n- [ ] **Given** x **When** y **Then** z",
        },
      },
    ]);
    const judgeFn = vi.fn(async () => "{}");
    const app = express();
    app.use(
      express.json({
        verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
          req.rawBody = buf.toString("utf8");
        },
      }),
    );
    app.use(
      "/api/webhooks",
      githubPrWebhookRouter({
        judge: { evaluate: judgeFn },
        octokit: {
          pulls: {
            createReview: vi.fn(),
            get: vi.fn(async () => {
              throw new Error("403 Forbidden");
            }),
          },
        },
      }),
    );
    const body = JSON.stringify({
      action: "opened",
      pull_request: { number: 10, body: "Closes #5", title: "" },
      repository: { full_name: "acme/proj" },
    });
    const res = await request(app)
      .post("/api/webhooks/github/pr")
      .set("content-type", "application/json")
      .set("x-hub-signature-256", sign(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(judgeFn).not.toHaveBeenCalled();
  });

  it("uses resolveSecret override when provided", async () => {
    const app = express();
    app.use(
      express.json({
        verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
          req.rawBody = buf.toString("utf8");
        },
      }),
    );
    app.use("/api/webhooks", githubPrWebhookRouter({ resolveSecret: () => "alt-secret" }));
    const body = JSON.stringify({
      action: "opened",
      pull_request: { number: 1 },
      repository: { full_name: "acme/proj" },
    });
    const sigAlt = "sha256=" + crypto.createHmac("sha256", "alt-secret").update(body).digest("hex");
    const res = await request(app)
      .post("/api/webhooks/github/pr")
      .set("content-type", "application/json")
      .set("x-hub-signature-256", sigAlt)
      .send(body);
    expect(res.status).toBe(200);
  });
});
