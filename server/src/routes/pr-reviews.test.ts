/**
 * Epic #394 P2 (#404) — pr-reviews route tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

interface Row {
  id: string;
  projectId: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  lastReviewedSha: string | null;
  acVerdictsJson: string;
  lastRunId: string | null;
  lastVerdict: string | null;
  createdAt: Date;
  updatedAt: Date;
}
const rows: Row[] = [];

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    prReviewState: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findUnique: vi.fn(async ({ where }: any) => {
        const k = where.projectId_repoOwner_repoName_prNumber;
        return (
          rows.find(
            (r) =>
              r.projectId === k.projectId &&
              r.repoOwner === k.repoOwner &&
              r.repoName === k.repoName &&
              r.prNumber === k.prNumber,
          ) ?? null
        );
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: vi.fn(async ({ where, take, skip }: any) => {
        const all = rows.filter((r) => r.projectId === where.projectId);
        all.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        return all.slice(skip ?? 0, (skip ?? 0) + (take ?? all.length));
      }),
      count: vi.fn(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async ({ where }: any) => rows.filter((r) => r.projectId === where.projectId).length,
      ),
    },
  },
}));

vi.mock("../middleware/auth.js", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { userId: "u1", roles: ["admin"], permissions: ["pr.review.read"] };
    next();
  },
}));

vi.mock("../middleware/require-permission.js", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

import { prReviewsRouter } from "./pr-reviews.js";
import { errorHandler, notFoundHandler } from "../middleware/error-handler.js";

function makeApp(opts: { resolveQueue?: () => unknown } = {}) {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/projects/:projectId/pr-reviews",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prReviewsRouter(opts as any),
  );
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  rows.length = 0;
});

function seed(over: Partial<Row> = {}): Row {
  const now = new Date(Date.now() + rows.length * 1000);
  const row: Row = {
    id: `pr_${rows.length + 1}`,
    projectId: "p1",
    repoOwner: "acme",
    repoName: "site",
    prNumber: rows.length + 1,
    lastReviewedSha: "sha",
    acVerdictsJson: JSON.stringify([
      { acId: "AC1", verdict: "satisfied", reasoning: "ok", evidenceFiles: ["src/a.ts"] },
      { acId: "AC2", verdict: "not_satisfied", reasoning: "fail", evidenceFiles: ["src/b.ts"] },
    ]),
    lastRunId: "run_1",
    lastVerdict: "comment",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  rows.push(row);
  return row;
}

describe("GET /api/projects/:projectId/pr-reviews", () => {
  it("returns rows scoped to the project with computed acPassRate", async () => {
    seed();
    seed();
    const app = makeApp();
    const resp = await request(app).get("/api/projects/p1/pr-reviews");
    expect(resp.status).toBe(200);
    expect(resp.body.success).toBe(true);
    expect(resp.body.data.items).toHaveLength(2);
    expect(resp.body.data.items[0].acPassRate).toBeCloseTo(0.5);
    expect(resp.body.data.items[0].prUrl).toMatch(/^https:\/\/github.com\/acme\/site\/pull\//);
  });

  it("respects limit + offset (with safe parsing)", async () => {
    for (let i = 0; i < 5; i += 1) seed();
    const app = makeApp();
    const resp = await request(app).get("/api/projects/p1/pr-reviews?limit=2&offset=1");
    expect(resp.status).toBe(200);
    expect(resp.body.data.items).toHaveLength(2);
    expect(resp.body.data.total).toBe(5);
  });

  it("falls back to default limit when query is non-numeric", async () => {
    seed();
    const app = makeApp();
    const resp = await request(app).get("/api/projects/p1/pr-reviews?limit=abc&offset=-9");
    expect(resp.status).toBe(200);
    expect(resp.body.data.limit).toBe(50);
    expect(resp.body.data.offset).toBe(0);
  });
});

describe("GET /api/projects/:projectId/pr-reviews/:prNumber", () => {
  it("returns the row when present", async () => {
    seed({ prNumber: 42 });
    const app = makeApp();
    const resp = await request(app).get("/api/projects/p1/pr-reviews/42?owner=acme&repo=site");
    expect(resp.status).toBe(200);
    expect(resp.body.data.prNumber).toBe(42);
    expect(resp.body.data.acVerdicts).toHaveLength(2);
  });

  it("returns 404 when not present", async () => {
    const app = makeApp();
    const resp = await request(app).get("/api/projects/p1/pr-reviews/999?owner=acme&repo=site");
    expect(resp.status).toBe(404);
    expect(resp.body.success).toBe(false);
  });

  it("400s on missing owner/repo querystring", async () => {
    const app = makeApp();
    const resp = await request(app).get("/api/projects/p1/pr-reviews/1");
    expect(resp.status).toBe(400);
  });

  it("400s on non-numeric prNumber", async () => {
    const app = makeApp();
    const resp = await request(app).get("/api/projects/p1/pr-reviews/abc?owner=acme&repo=site");
    expect(resp.status).toBe(400);
  });
});

// Epic #394 P2 review #404 — manual re-review endpoint.
describe("POST /api/projects/:projectId/pr-reviews/:prNumber/re-review", () => {
  function fakeQueue() {
    const enqueued: unknown[] = [];
    return {
      enqueued,
      queue: {
        enqueue(payload: unknown) {
          enqueued.push(payload);
          return { jobId: "job-1", queueDepth: 1 };
        },
        depth: () => 1,
        deadLetters: () => [],
        drain: async () => {},
        shutdown: async () => {},
        isShuttingDown: () => false,
      },
    };
  }

  it("202 ACCEPTED + enqueues onto the worker queue when the row exists", async () => {
    seed({ prNumber: 7, lastReviewedSha: "deadbeef" });
    const fq = fakeQueue();
    const app = makeApp({ resolveQueue: () => fq.queue });
    const resp = await request(app)
      .post("/api/projects/p1/pr-reviews/7/re-review")
      .send({ owner: "acme", repo: "site" });
    expect(resp.status).toBe(202);
    expect(resp.body.success).toBe(true);
    expect(resp.body.data.jobId).toBe("job-1");
    expect(fq.enqueued).toHaveLength(1);
    const payload = fq.enqueued[0] as {
      projectId: string;
      owner: string;
      repo: string;
      prNumber: number;
      deliveryId: string;
      context: { headSha: string | null; action: string };
    };
    expect(payload.projectId).toBe("p1");
    expect(payload.owner).toBe("acme");
    expect(payload.repo).toBe("site");
    expect(payload.prNumber).toBe(7);
    expect(payload.deliveryId).toMatch(/^manual-rerun-acme-site-7-/);
    expect(payload.context.action).toBe("manual_rerun");
    expect(payload.context.headSha).toBe("deadbeef");
  });

  it("404s when the PR-review row does not exist", async () => {
    const fq = fakeQueue();
    const app = makeApp({ resolveQueue: () => fq.queue });
    const resp = await request(app)
      .post("/api/projects/p1/pr-reviews/999/re-review")
      .send({ owner: "acme", repo: "site" });
    expect(resp.status).toBe(404);
    expect(resp.body.success).toBe(false);
  });

  it("400s on missing owner/repo body", async () => {
    seed({ prNumber: 7 });
    const fq = fakeQueue();
    const app = makeApp({ resolveQueue: () => fq.queue });
    const resp = await request(app).post("/api/projects/p1/pr-reviews/7/re-review").send({});
    expect(resp.status).toBe(400);
  });

  it("503s when the worker is unavailable (no live queue)", async () => {
    seed({ prNumber: 7 });
    const app = makeApp({ resolveQueue: () => null });
    const resp = await request(app)
      .post("/api/projects/p1/pr-reviews/7/re-review")
      .send({ owner: "acme", repo: "site" });
    expect(resp.status).toBe(503);
    expect(resp.body.error).toBe("WORKER_UNAVAILABLE");
  });

  it("400s on non-numeric prNumber", async () => {
    const fq = fakeQueue();
    const app = makeApp({ resolveQueue: () => fq.queue });
    const resp = await request(app)
      .post("/api/projects/p1/pr-reviews/abc/re-review")
      .send({ owner: "acme", repo: "site" });
    expect(resp.status).toBe(400);
  });
});
