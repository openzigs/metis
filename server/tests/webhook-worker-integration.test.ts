/**
 * Epic #394 P2 — webhook→worker integration test (post-`e7eb006` fix).
 *
 * Asserts that when the webhook handler enqueues onto the worker
 * singleton, the worker's *real* processor (built from
 * `processorDeps`) actually invokes the PR-review agent — not the
 * placeholder no-op that shipped in `e7eb006`.
 */
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const recordDeliveryMock = vi.hoisted(() =>
  vi.fn(async (_input: { deliveryId: string; eventType: string }) => ({
    duplicate: false,
    deliveryId: "set-by-test",
  })),
);

const startRunMock = vi.hoisted(() => vi.fn(async () => "run_int_1"));
const recordStepMock = vi.hoisted(() => vi.fn(async () => undefined));
const finishRunMock = vi.hoisted(() => vi.fn(async () => undefined));
const computeRunCostMock = vi.hoisted(() => vi.fn(async () => ({ costCents: 0, totalTokens: 0 })));

vi.mock("../src/lib/agents/pr-reviewer/webhook-dedup.js", () => ({
  recordDelivery: recordDeliveryMock,
  attachRunId: vi.fn(async () => undefined),
  purgeOldDeliveries: vi.fn(async () => 0),
}));

vi.mock("../src/lib/replay/runs-service.js", () => ({
  startRun: startRunMock,
  recordStep: recordStepMock,
  finishRun: finishRunMock,
  computeRunCost: computeRunCostMock,
}));

vi.mock("../src/lib/agents/pr-reviewer/ac-traceability.js", () => ({
  resolveAcceptanceCriteriaForPr: vi.fn(async () => ({
    criteria: [{ id: "AC1", text: "Given X, When Y, Then Z" }],
    linkedIssueNumbers: [42],
    skipReason: null,
  })),
}));

vi.mock("../src/lib/agents/pr-reviewer/diff-fetcher.js", () => ({
  fetchPrDiff: vi.fn(async () => ({
    diff: "@@ -1 +1 @@\n-old\n+new",
    rawBytes: 32,
    tooLarge: false,
  })),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    publishedIssue: { findMany: vi.fn(async () => []) },
    requirement: { updateMany: vi.fn(async () => ({ count: 0 })) },
    requirementImplementation: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
    },
    repoConnection: {
      findMany: vi.fn(async () => [
        {
          project: {
            id: "proj_1",
            autoReviewPrs: true,
            prReviewMaxDiffBytes: null,
            prReviewSkipGlobs: null,
          },
        },
      ]),
    },
    prReviewState: {
      upsert: vi.fn(async () => ({ id: "state_1" })),
      findUnique: vi.fn(async () => null),
    },
    agentRun: {
      create: vi.fn(async () => ({ id: "run_int_1" })),
      update: vi.fn(async () => ({})),
      findUnique: vi.fn(async () => ({ id: "run_int_1", startedAt: new Date() })),
    },
    agentRunStep: {
      count: vi.fn(async () => 0),
      create: vi.fn(async () => ({ id: "step_int_1" })),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: vi.fn(),
}));

import { githubPrWebhookRouter } from "../src/routes/webhooks-github.js";
import { startWorker } from "../src/lib/agents/pr-reviewer/worker.js";
import {
  setPrReviewWorker,
  getPrReviewWorker,
} from "../src/lib/agents/pr-reviewer/worker-singleton.js";

const SECRET = "test-secret";

beforeEach(() => {
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  recordDeliveryMock.mockReset();
  recordDeliveryMock.mockImplementation(async (input) => ({
    duplicate: false,
    deliveryId: input.deliveryId,
  }));
  startRunMock.mockClear();
  recordStepMock.mockClear();
  finishRunMock.mockClear();
});

afterEach(async () => {
  delete process.env.GITHUB_WEBHOOK_SECRET;
  const w = getPrReviewWorker();
  if (w) {
    setPrReviewWorker(null);
    await w.shutdown();
  }
});

function sign(body: string): string {
  return "sha256=" + crypto.createHmac("sha256", SECRET).update(body).digest("hex");
}

function payload(prNumber: number) {
  return {
    action: "opened",
    pull_request: {
      number: prNumber,
      title: `PR #${prNumber}`,
      body: "Closes #42",
      head: { sha: "abc123", ref: "feature/x" },
      html_url: `https://github.com/acme/proj/pull/${prNumber}`,
    },
    repository: { full_name: "acme/proj", html_url: "https://github.com/acme/proj" },
    installation: { id: 1 },
  };
}

describe("webhook→worker integration (post-e7eb006 regression fix)", () => {
  it("enqueued jobs run the real PR-review agent — judge.evaluate is invoked + GitHub review is posted", async () => {
    const judge = {
      evaluate: vi.fn(async () =>
        JSON.stringify({
          verdicts: [{ acId: "AC1", verdict: "satisfied", reasoning: "ok" }],
          comments: [],
          overallVerdict: "approve",
          summary: "lgtm",
        }),
      ),
    };
    const createReview = vi.fn(async () => ({
      data: { id: 999, html_url: "https://github.com/acme/proj/pull/77#review-999" },
    }));
    const octokit = {
      pulls: {
        createReview,
        get: vi.fn(async () => ({ data: "" })),
      },
    } as never;

    // Boot a worker with real processor wiring (mirrors what `server.ts`
    // does in production once judge/octokit factories are supplied).
    const worker = startWorker({
      processorDeps: {
        resolveProject: async () => ({
          id: "proj_1",
          autoReviewPrs: true,
          prReviewMaxDiffBytes: null,
          prReviewSkipGlobs: null,
        }),
        resolveJudge: async () => judge,
        resolveOctokit: async () => octokit,
        // Hermetic budget — bypass FinOps prisma calls in this test.
        resolveBudget: async () => ({
          check: async () => ({
            allowed: true,
            capCents: null,
            spentCents: 0,
            resetAt: "2099-01-01T00:00:00Z",
          }),
          record: async () => undefined,
        }),
      },
      // Disable the periodic purge to keep the test deterministic.
      purgeIntervalMs: 60_000_000,
      setInterval: () => 0,
      clearInterval: () => undefined,
    });
    setPrReviewWorker(worker);

    // Build the webhook router with NO inline judge/octokit — the only
    // way the review can run is via the worker singleton's processor.
    const app = express();
    app.use(
      express.json({
        verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
          req.rawBody = buf.toString("utf8");
        },
      }),
    );
    app.use("/api/webhooks", githubPrWebhookRouter());

    const body = JSON.stringify(payload(77));
    const resp = await request(app)
      .post("/api/webhooks/github/pr")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", sign(body))
      .set("X-GitHub-Delivery", "int-delivery-1")
      .set("X-GitHub-Event", "pull_request")
      .send(body);

    expect(resp.status).toBe(200);

    // Wait for the worker to drain the queued job. The processor may
    // have already fired before `drain()` (microtask scheduling), so
    // we don't assert pre-drain state — only that the agent actually
    // ran end-to-end after the queue settled.
    await worker.queue.drain();

    // The real processor must have invoked the agent + posted the review.
    expect(judge.evaluate).toHaveBeenCalledTimes(1);
    expect(createReview).toHaveBeenCalledTimes(1);
    expect(createReview.mock.calls[0][0]).toMatchObject({
      owner: "acme",
      repo: "proj",
      pull_number: 77,
    });
    // AgentRun lifecycle was recorded, now carrying the attributed cost
    // (zeroed here via the computeRunCost mock — no seeded TokenUsage).
    expect(startRunMock).toHaveBeenCalledTimes(1);
    expect(computeRunCostMock).toHaveBeenCalledWith("run_int_1");
    expect(finishRunMock).toHaveBeenCalledWith({
      runId: "run_int_1",
      status: "completed",
      costCents: 0,
      totalTokens: 0,
    });
  });

  it("setPrReviewWorker shuts down the previous singleton on replacement", async () => {
    const shutdown = vi.fn(async () => undefined);
    const fakePrev = {
      // Minimal queue stub — the singleton only needs `shutdown()`.
      queue: {} as never,
      shutdown,
    };
    setPrReviewWorker(fakePrev as never);

    const next = startWorker({
      processorDeps: {
        resolveProject: async () => null,
        resolveJudge: async () => null,
        resolveOctokit: async () => null,
      },
      purgeIntervalMs: 60_000_000,
      setInterval: () => 0,
      clearInterval: () => undefined,
    });
    setPrReviewWorker(next);
    // Shutdown is fire-and-forget — flush the microtask queue.
    await new Promise((r) => setTimeout(r, 0));
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
