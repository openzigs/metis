/**
 * Epic #394 P2 (#403) — webhook integration: dedup + async-queue path.
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

vi.mock("../src/lib/agents/pr-reviewer/webhook-dedup.js", () => ({
  recordDelivery: recordDeliveryMock,
  attachRunId: vi.fn(async () => undefined),
  purgeOldDeliveries: vi.fn(async () => 0),
}));

// #674 — the durable job-scope records the webhook writes for queued reviews.
const jobScopes = vi.hoisted(() => new Map<string, { kind: string; projectId: string | null }>());

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    jobScopeRecord: {
      upsert: vi.fn(
        async ({
          create,
        }: {
          create: { jobId: string; kind: string; projectId: string | null };
        }) => {
          // Lands late, so a write the webhook does not await is not seen by the ACK.
          await new Promise((r) => setTimeout(r, 5));
          jobScopes.set(create.jobId, { kind: create.kind, projectId: create.projectId });
          return create;
        },
      ),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
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
    agentRun: {
      create: vi.fn(async () => ({ id: "run_1" })),
      update: vi.fn(async () => ({})),
      findUnique: vi.fn(async () => ({ id: "run_1", startedAt: new Date() })),
    },
    agentRunStep: {
      count: vi.fn(async () => 0),
      create: vi.fn(async () => ({ id: "step_1" })),
    },
  },
}));

import { githubPrWebhookRouter } from "../src/routes/webhooks-github.js";
import {
  createPrReviewQueue,
  SHUTDOWN_REJECTED_JOB_ID,
  type PrReviewQueue,
} from "../src/lib/agents/pr-reviewer/queue.js";
import { _resetJobLifecycleMemory, getJobScope } from "../src/lib/socket/job-events.js";

const SECRET = "test-secret";

beforeEach(() => {
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  recordDeliveryMock.mockReset();
  recordDeliveryMock.mockImplementation(async (input) => ({
    duplicate: false,
    deliveryId: input.deliveryId,
  }));
});

afterEach(() => {
  delete process.env.GITHUB_WEBHOOK_SECRET;
});

function sign(body: string): string {
  return "sha256=" + crypto.createHmac("sha256", SECRET).update(body).digest("hex");
}

function makeApp(queue?: PrReviewQueue, opts: { skipDedup?: boolean } = {}): express.Application {
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
      judge: {
        evaluate: vi.fn(
          async () => '{"verdicts":[],"comments":[],"overallVerdict":"comment","summary":"x"}',
        ),
      },
      octokit: {
        pulls: {
          createReview: vi.fn(async () => ({ data: { id: 1, html_url: "u" } })),
          get: vi.fn(async () => ({ data: "" })),
        },
      } as never,
      ...(queue ? { queue } : {}),
      ...(opts.skipDedup ? { skipDedup: true } : {}),
    }),
  );
  return app;
}

function payload(prNumber: number) {
  return {
    action: "opened",
    pull_request: {
      number: prNumber,
      title: `PR #${prNumber}`,
      body: "",
      head: { sha: "abc", ref: "feature" },
      html_url: `https://github.com/acme/proj/pull/${prNumber}`,
    },
    repository: { full_name: "acme/proj", html_url: "https://github.com/acme/proj" },
    installation: { id: 1 },
  };
}

describe("webhook dedup + queue", () => {
  it("short-circuits with DUPLICATE_DELIVERY when dedup helper returns duplicate", async () => {
    recordDeliveryMock.mockResolvedValueOnce({ duplicate: true, deliveryId: "dup-1" });
    const app = makeApp();
    const body = JSON.stringify(payload(100));
    const resp = await request(app)
      .post("/api/webhooks/github/pr")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", sign(body))
      .set("X-GitHub-Delivery", "dup-1")
      .set("X-GitHub-Event", "pull_request")
      .send(body);
    expect(resp.status).toBe(200);
    expect(resp.body.handled).toBe(false);
    expect(resp.body.reason).toBe("DUPLICATE_DELIVERY");
  });

  it("never blocks the webhook on dedup helper failures", async () => {
    recordDeliveryMock.mockRejectedValueOnce(new Error("DB down"));
    const app = makeApp();
    const body = JSON.stringify(payload(101));
    const resp = await request(app)
      .post("/api/webhooks/github/pr")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", sign(body))
      .set("X-GitHub-Delivery", "x")
      .set("X-GitHub-Event", "pull_request")
      .send(body);
    expect(resp.status).toBe(200);
  });

  it("enqueues onto the provided queue + ACKs immediately", async () => {
    const enqueued: unknown[] = [];
    const queue: PrReviewQueue = {
      enqueue: (job) => {
        enqueued.push(job);
        return { jobId: "jq_1", queueDepth: 1 };
      },
      enqueueAfter: async (job, beforeDispatch) => {
        await beforeDispatch("jq_1");
        enqueued.push(job);
        return { jobId: "jq_1", queueDepth: 1 };
      },
      depth: () => enqueued.length,
      deadLetters: () => [],
      drain: async () => undefined,
    };
    const app = makeApp(queue);
    const body = JSON.stringify(payload(102));
    const resp = await request(app)
      .post("/api/webhooks/github/pr")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", sign(body))
      .set("X-GitHub-Delivery", "fresh")
      .set("X-GitHub-Event", "pull_request")
      .send(body);
    expect(resp.status).toBe(200);
    expect(enqueued).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((enqueued[0] as any).owner).toBe("acme");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((enqueued[0] as any).context.headSha).toBe("abc");
  });

  it("records the queued review's scope durably, under the project the webhook resolved", async () => {
    jobScopes.clear();
    _resetJobLifecycleMemory();
    const queue: PrReviewQueue = {
      enqueue: () => ({ jobId: "jq_scope", queueDepth: 1 }),
      enqueueAfter: async (_job, beforeDispatch) => {
        await beforeDispatch("jq_scope");
        return { jobId: "jq_scope", queueDepth: 1 };
      },
      depth: () => 1,
      deadLetters: () => [],
      drain: async () => undefined,
    };
    const body = JSON.stringify(payload(104));
    const resp = await request(makeApp(queue))
      .post("/api/webhooks/github/pr")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", sign(body))
      .set("X-GitHub-Delivery", "scope-1")
      .set("X-GitHub-Event", "pull_request")
      .send(body);
    expect(resp.status).toBe(200);
    // #674 — committed before the ACK, for a socket on any replica…
    expect(jobScopes.get("jq_scope")).toEqual({ kind: "pr-review", projectId: "proj_1" });
    // …and remembered on this one.
    expect(getJobScope("jq_scope")).toEqual({ kind: "pr-review", projectId: "proj_1" });
  });

  it("commits the queued review's durable scope before its first `started` event", async () => {
    jobScopes.clear();
    _resetJobLifecycleMemory();
    // The real queue: it dispatches, and so emits `started` (which the worker
    // relays to `project:{id}`), in the enqueue tick.
    const atStarted: Array<{ jobId: string; recorded: unknown }> = [];
    const queue = createPrReviewQueue({
      processor: async () => undefined,
      onLifecycle: (e) => {
        if (e.phase === "started")
          atStarted.push({ jobId: e.jobId, recorded: jobScopes.get(e.jobId) });
      },
    });
    const body = JSON.stringify(payload(105));
    const resp = await request(makeApp(queue))
      .post("/api/webhooks/github/pr")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", sign(body))
      .set("X-GitHub-Delivery", "order-1")
      .set("X-GitHub-Event", "pull_request")
      .send(body);
    await queue.drain();
    expect(resp.status).toBe(200);
    expect(atStarted).toEqual([
      { jobId: "prr-1-order-1", recorded: { kind: "pr-review", projectId: "proj_1" } },
    ]);
  });

  it("records no scope for a review the shutting-down queue rejects", async () => {
    jobScopes.clear();
    _resetJobLifecycleMemory();
    const queue = createPrReviewQueue({ processor: async () => undefined });
    await queue.shutdown();
    const body = JSON.stringify(payload(106));
    const resp = await request(makeApp(queue))
      .post("/api/webhooks/github/pr")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", sign(body))
      .set("X-GitHub-Delivery", "late-1")
      .set("X-GitHub-Event", "pull_request")
      .send(body);
    expect(resp.status).toBe(200);
    expect(jobScopes.size).toBe(0);
    expect(getJobScope(SHUTDOWN_REJECTED_JOB_ID)).toBeUndefined();
  });

  it("skips dedup when skipDedup=true (test seam)", async () => {
    const app = makeApp(undefined, { skipDedup: true });
    const body = JSON.stringify(payload(103));
    const resp = await request(app)
      .post("/api/webhooks/github/pr")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", sign(body))
      .set("X-GitHub-Delivery", "any-id")
      .set("X-GitHub-Event", "pull_request")
      .send(body);
    expect(resp.status).toBe(200);
    expect(recordDeliveryMock).not.toHaveBeenCalled();
  });

  it("integrates with the in-memory queue end-to-end", async () => {
    const seen: unknown[] = [];
    const queue = createPrReviewQueue({
      processor: async (job) => {
        seen.push(job);
      },
    });
    const app = makeApp(queue);
    const body = JSON.stringify(payload(104));
    await request(app)
      .post("/api/webhooks/github/pr")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", sign(body))
      .set("X-GitHub-Delivery", "real-1")
      .set("X-GitHub-Event", "pull_request")
      .send(body);
    await queue.drain();
    expect(seen).toHaveLength(1);
  });
});
