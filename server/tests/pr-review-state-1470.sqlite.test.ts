/**
 * #1470 — every automatic PR review the job path finishes, and every one it
 * skips, leaves a `PrReviewState` row that `/projects/:id/pulls` lists.
 *
 * Driven end to end against a REAL SQLite database built from the migration
 * chain: a signed GitHub `pull_request` delivery → the real webhook router →
 * a recording queue that hands each job to the REAL worker → the real
 * `executePrReviewJob` → the row → `GET /api/projects/:id/pr-reviews` through
 * the real `apiRouter()` (so the projects router's project-scope chokepoint
 * runs in its real mount order). No model runs and nothing reaches GitHub: the
 * judge and Octokit are stubs. Every row assertion is read back from the
 * database or the page's API, never from the job's own return value.
 */
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole, type AuthPayload, type RoleKey } from "@metis/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";
import type { PrReviewJob, PrReviewQueue } from "../src/lib/agents/pr-reviewer/queue.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return { db: null as unknown };
});
vi.mock("../src/lib/prisma.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/prisma.js")>("../src/lib/prisma.js");
  return {
    ...actual,
    get prisma() {
      return state.db;
    },
  };
});
const auditSpy = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: auditSpy }));

const { githubPrWebhookRouter, resolveProjectForQueuedReview } =
  await import("../src/routes/webhooks-github.js");
const { apiRouter } = await import("../src/routes/index.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { startWorker } = await import("../src/lib/agents/pr-reviewer/worker.js");
const { createJobEventEmitter } = await import("../src/lib/socket/job-events.js");
const { deleteProject } = await import("../src/lib/projects/project-service.js");

const WS = "ws-1470";
const WS_OTHER = "ws-other-1470";
const SECRET = "test-secret-1470";
const REVIEW_URL = (owner: string, pr: number) =>
  `https://github.com/${owner}/app/pull/${pr}#pullrequestreview-${9000 + pr}`;

const JUDGE_OK = JSON.stringify({
  verdicts: [
    {
      acId: "AC-1",
      verdict: "satisfied",
      reasoning: "The thing works",
      evidenceFiles: ["a.ts"],
    },
  ],
  comments: [],
  overallVerdict: "approve",
  summary: "Looks good",
});

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1470 — automatic PR reviews and skips appear on the pull requests page",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let api: express.Express;
    let worker: { queue: PrReviewQueue; shutdown(): Promise<void> };
    let recording: PrReviewQueue;
    const enqueued: PrReviewJob[] = [];
    let judgeWired = true;

    const evaluate = vi.fn(async () => JUDGE_OK);
    let lastOwner = "";
    const createReview = vi.fn(async (p: { owner: string; pull_number: number }) => {
      lastOwner = p.owner;
      return { data: { id: 9000 + p.pull_number, html_url: REVIEW_URL(p.owner, p.pull_number) } };
    });
    const octokit = {
      pulls: {
        createReview,
        get: vi.fn(async () => ({
          data: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n+x\n",
        })),
        listReviewComments: vi.fn(async () => ({ data: [] })),
      },
    };

    const bearer = (userId: string, role: RoleKey, workspaces: string[] = []) => {
      const payload: AuthPayload = {
        userId,
        username: userId,
        role,
        permissions: getPermissionsForRole(role),
        workspaces,
      };
      return `Bearer ${issueTokens(payload).accessToken}`;
    };
    /** A coordinator in the project's workspace (holds `pr.review.read` since #1472). */
    const member = () => bearer("u-owner", "coordinator", [WS]);
    /** A system admin: reads every project's reviews, deleted ones included. */
    const reader = () => bearer("u-admin", "admin", []);

    const webhookApp = () => {
      const a = express();
      a.use(
        express.json({
          verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
            req.rawBody = buf.toString("utf8");
          },
        }),
      );
      a.use("/api/webhooks", githubPrWebhookRouter({ queue: recording, skipDedup: true }));
      return a;
    };

    let deliverySeq = 0;
    const deliver = async (owner: string, prNumber: number, body: string) => {
      const payload = JSON.stringify({
        action: "opened",
        pull_request: {
          number: prNumber,
          title: `PR #${prNumber}`,
          body,
          head: { sha: `sha-${owner}-${prNumber}-${deliverySeq}`, ref: "feature" },
          html_url: `https://github.com/${owner}/app/pull/${prNumber}`,
        },
        repository: { full_name: `${owner}/app`, html_url: `https://github.com/${owner}/app` },
      });
      const sig = "sha256=" + crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
      const res = await request(webhookApp())
        .post("/api/webhooks/github/pr")
        .set("Content-Type", "application/json")
        .set("X-Hub-Signature-256", sig)
        .set("X-GitHub-Event", "pull_request")
        .set("X-GitHub-Delivery", `delivery-1470-${++deliverySeq}`)
        .send(payload);
      expect(res.status).toBe(200);
      await recording.drain();
    };

    const listPulls = (projectId: string, auth: string) =>
      request(api).get(`/api/projects/${projectId}/pr-reviews`).set("Authorization", auth);

    const rowOf = (projectId: string, owner: string, prNumber: number) =>
      db.prReviewState.findUnique({
        where: {
          projectId_repoOwner_repoName_prNumber: {
            projectId,
            repoOwner: owner,
            repoName: "app",
            prNumber,
          },
        },
      });

    /** A project (auto-review on) whose repo `<owner>/app` has a published issue #5 with one AC. */
    const seedProject = async (id: string, owner: string, workspaceId: string = WS) => {
      await db.project.create({
        data: {
          id,
          name: id,
          slug: id,
          createdById: "u-owner",
          workspaceId,
          status: "active",
          autoReviewPrs: true,
        },
      });
      await db.repoConnection.create({
        data: {
          id: `repo-${id}`,
          projectId: id,
          label: "main",
          ownerOrOrg: owner,
          repoName: "app",
          isPrimary: true,
          status: "connected",
        },
      });
      await db.analysis.create({ data: { id: `an-${id}`, projectId: id, startedById: "u-owner" } });
      await db.requirement.create({
        data: {
          id: `req-${id}`,
          projectId: id,
          analysisId: `an-${id}`,
          title: "Requirement",
          body: "body",
        },
      });
      await db.issueDraft.create({
        data: {
          id: `draft-${id}`,
          projectId: id,
          requirementId: `req-${id}`,
          title: "Draft",
          body: "## Acceptance criteria\n- [ ] The thing works",
          status: "published",
        },
      });
      await db.publishBatch.create({
        data: {
          id: `batch-${id}`,
          projectId: id,
          targetOwner: owner,
          targetRepo: "app",
          startedById: "u-owner",
          status: "completed",
        },
      });
      await db.publishedIssue.create({
        data: {
          batchId: `batch-${id}`,
          draftId: `draft-${id}`,
          issueNumber: 5,
          issueId: `node-${id}`,
          htmlUrl: `https://github.com/${owner}/app/issues/5`,
          destination: "github",
        },
      });
    };

    const P = "project-1470-a";
    const P_OWNER = "acme-1470";
    const Q = "project-1470-b";
    const Q_OWNER = "beta-1470";
    const GONE = "project-1470-gone";
    const GONE_OWNER = "gone-1470";

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1470-pr-review-state");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const id of ["u-owner", "u-outsider", "u-admin"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      for (const ws of [WS, WS_OTHER]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      await db.workspaceMember.create({
        data: { workspaceId: WS, userId: "u-owner", role: "member" },
      });
      await db.workspaceMember.create({
        data: { workspaceId: WS_OTHER, userId: "u-outsider", role: "member" },
      });
      await seedProject(P, P_OWNER);
      await seedProject(Q, Q_OWNER);
      await seedProject(GONE, GONE_OWNER);

      worker = startWorker({
        processorDeps: {
          resolveProject: resolveProjectForQueuedReview,
          // `server.ts` wires `async () => null` today; a test flips this to match.
          resolveJudge: async () => (judgeWired ? { evaluate } : null),
          resolveOctokit: async () => octokit as never,
        },
        setInterval: () => 0,
        clearInterval: () => undefined,
        purge: async () => 0,
        jobEvents: createJobEventEmitter(null),
        maxAttempts: 1,
      });
      // The recording queue: notes every job, then hands it to the real worker.
      recording = {
        ...worker.queue,
        enqueue: (job) => {
          enqueued.push(job as PrReviewJob);
          return worker.queue.enqueue(job);
        },
        enqueueAfter: (job, before) => {
          enqueued.push(job as PrReviewJob);
          return worker.queue.enqueueAfter(job, before);
        },
        drain: () => worker.queue.drain(),
      };

      api = express();
      api.use(express.json());
      api.use("/api", apiRouter());
      api.use(notFoundHandler);
      api.use(errorHandler);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await worker?.shutdown();
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      process.env.GITHUB_WEBHOOK_SECRET = SECRET;
      enqueued.length = 0;
      evaluate.mockClear();
      createReview.mockClear();
    });
    afterEach(() => {
      delete process.env.GITHUB_WEBHOOK_SECRET;
    });

    it("a completed review writes its row, and the pull requests page's API lists it", async () => {
      await deliver(P_OWNER, 31, "Closes #5");
      expect(enqueued).toHaveLength(1);
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(createReview).toHaveBeenCalledTimes(1);
      expect(lastOwner).toBe(P_OWNER);

      const row = await rowOf(P, P_OWNER, 31);
      expect(row).toMatchObject({
        lastStatus: "reviewed",
        lastVerdict: "approve",
        lastSkipReason: null,
        lastReviewUrl: REVIEW_URL(P_OWNER, 31),
        lastReviewedSha: enqueued[0].context.headSha,
      });
      expect(row?.lastRunId).toBeTruthy();
      const run = await db.agentRun.findUnique({ where: { id: row!.lastRunId! } });
      expect(run).toMatchObject({ projectId: P, status: "completed" });
      expect(JSON.parse(row!.acVerdictsJson)).toEqual([
        expect.objectContaining({ acId: "AC-1", verdict: "satisfied" }),
      ]);

      const res = await listPulls(P, reader());
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.items[0]).toMatchObject({
        projectId: P,
        repoOwner: P_OWNER,
        repoName: "app",
        prNumber: 31,
        lastStatus: "reviewed",
        lastVerdict: "approve",
        lastSkipReason: null,
        lastReviewUrl: REVIEW_URL(P_OWNER, 31),
        lastRunId: row!.lastRunId,
        acPassRate: 1,
      });

      // The page's detail link (TEST_PLAN Phase 15 step 1) resolves the same row.
      const detail = await request(api)
        .get(`/api/projects/${P}/pr-reviews/31?owner=${P_OWNER}&repo=app`)
        .set("Authorization", reader());
      expect(detail.status).toBe(200);
      expect(detail.body.data).toMatchObject({ prNumber: 31, lastStatus: "reviewed" });
    });

    it("a pull request that links no issue is recorded as skipped, with the reason", async () => {
      await deliver(P_OWNER, 32, "no issue linked here");
      expect(enqueued).toHaveLength(1);
      expect(evaluate).not.toHaveBeenCalled();
      expect(createReview).not.toHaveBeenCalled();
      expect(await rowOf(P, P_OWNER, 32)).toMatchObject({
        lastStatus: "skipped",
        lastSkipReason: "no_linked_issue",
        lastVerdict: null,
        lastReviewUrl: null,
      });
      const res = await listPulls(P, reader());
      const item = res.body.data.items.find((i: { prNumber: number }) => i.prNumber === 32);
      expect(item).toMatchObject({ lastStatus: "skipped", lastSkipReason: "no_linked_issue" });
    });

    it("a failed review is recorded as failed, pointing at its run", async () => {
      evaluate.mockRejectedValueOnce(new Error("model unavailable"));
      await deliver(P_OWNER, 34, "Closes #5");
      expect(createReview).not.toHaveBeenCalled();
      const row = await rowOf(P, P_OWNER, 34);
      expect(row).toMatchObject({ lastStatus: "failed", lastSkipReason: null, lastVerdict: null });
      const run = await db.agentRun.findUnique({ where: { id: row!.lastRunId! } });
      expect(run).toMatchObject({ projectId: P, status: "failed" });
    });

    it("past the monthly limit the PR is skipped for budget; its last posted review stays linked", async () => {
      await db.project.update({ where: { id: P }, data: { prReviewMonthlyBudgetCents: 100 } });
      await db.tokenUsage.create({
        data: {
          projectId: P,
          sessionId: "pr-review-1470-earlier",
          provider: "test",
          model: "m",
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          costCents: 150,
          costUsd: 1.5,
          agentStep: "pr-review",
        },
      });
      try {
        // PR 31 was reviewed in the first test; its update now arrives over the limit.
        await deliver(P_OWNER, 31, "Closes #5");
        expect(evaluate).not.toHaveBeenCalled();
        expect(createReview).not.toHaveBeenCalled();
        const row = await rowOf(P, P_OWNER, 31);
        expect(row).toMatchObject({
          lastStatus: "skipped",
          lastSkipReason: "budget_exceeded",
          // The review already on GitHub is still the last one posted.
          lastVerdict: "approve",
          lastReviewUrl: REVIEW_URL(P_OWNER, 31),
        });
        const res = await listPulls(P, reader());
        const item = res.body.data.items.find((i: { prNumber: number }) => i.prNumber === 31);
        expect(item).toMatchObject({
          lastStatus: "skipped",
          lastSkipReason: "budget_exceeded",
          lastReviewUrl: REVIEW_URL(P_OWNER, 31),
        });
      } finally {
        await db.project.update({ where: { id: P }, data: { prReviewMonthlyBudgetCents: null } });
      }
    });

    it("a job queued before automatic review was switched off is recorded as skipped, unreviewed", async () => {
      await db.project.update({ where: { id: P }, data: { autoReviewPrs: false } });
      try {
        // Switched off, a delivery is not even queued (#1169)…
        await deliver(P_OWNER, 35, "Closes #5");
        expect(enqueued).toHaveLength(0);
        expect(await rowOf(P, P_OWNER, 35)).toBeNull();
        // …but a job already in the queue still runs to the executor, which records the skip.
        recording.enqueue({
          deliveryId: "delivery-1470-queued-before-off",
          projectId: P,
          owner: P_OWNER,
          repo: "app",
          prNumber: 36,
          context: { action: "opened", prBody: "Closes #5", headSha: "sha-36" },
        });
        await recording.drain();
        expect(evaluate).not.toHaveBeenCalled();
        expect(createReview).not.toHaveBeenCalled();
        expect(await rowOf(P, P_OWNER, 36)).toMatchObject({
          lastStatus: "skipped",
          lastSkipReason: "auto_review_disabled",
          lastRunId: null,
        });
      } finally {
        await db.project.update({ where: { id: P }, data: { autoReviewPrs: true } });
      }
    });

    it("on a server with no review model wired, the PR is recorded as skipped for that reason", async () => {
      judgeWired = false;
      try {
        await deliver(P_OWNER, 37, "Closes #5");
        expect(enqueued).toHaveLength(1);
        expect(evaluate).not.toHaveBeenCalled();
        expect(createReview).not.toHaveBeenCalled();
        expect(await rowOf(P, P_OWNER, 37)).toMatchObject({
          lastStatus: "skipped",
          lastSkipReason: "review_not_configured",
          lastRunId: null,
        });
      } finally {
        judgeWired = true;
      }
    });

    describe("rows stay scoped to their project", () => {
      it("each project lists only its own reviews", async () => {
        await deliver(Q_OWNER, 31, "Closes #5");
        expect(await rowOf(Q, Q_OWNER, 31)).toMatchObject({ lastStatus: "reviewed" });
        // The same PR number on another project's repo is a separate row.
        expect(await rowOf(P, P_OWNER, 31)).toMatchObject({ lastSkipReason: "budget_exceeded" });

        const p = await listPulls(P, reader());
        const q = await listPulls(Q, reader());
        expect(p.status).toBe(200);
        expect(q.status).toBe(200);
        expect(new Set(p.body.data.items.map((i: { projectId: string }) => i.projectId))).toEqual(
          new Set([P]),
        );
        expect(q.body.data.items).toHaveLength(1);
        expect(q.body.data.items[0]).toMatchObject({ projectId: Q, repoOwner: Q_OWNER });
        expect(q.body.data.total).toBe(1);
      });

      it("a user outside the project's workspace gets 404, for the list and the detail", async () => {
        const outsider = bearer("u-outsider", "coordinator", [WS_OTHER]);
        const list = await listPulls(P, outsider);
        expect(list.status).toBe(404);
        expect(JSON.stringify(list.body)).not.toContain(P_OWNER);
        const detail = await request(api)
          .get(`/api/projects/${P}/pr-reviews/31?owner=${P_OWNER}&repo=app`)
          .set("Authorization", outsider);
        expect(detail.status).toBe(404);
        // An unknown project answers that same 404.
        const unknown = await listPulls("project-1470-missing", outsider);
        expect(unknown.status).toBe(404);
        expect(list.body).toEqual(unknown.body);
        // Positive control: the same request with a reader's access is answered.
        expect((await listPulls(P, reader())).status).toBe(200);
      });

      it("a deleted project's reviews are a 404 for a member, like an unknown project; an admin still reads them", async () => {
        await deliver(GONE_OWNER, 41, "Closes #5");
        expect(await rowOf(GONE, GONE_OWNER, 41)).toMatchObject({ lastStatus: "reviewed" });
        // While live, the member reads the list (#1472), so the 404 below is the
        // deleted-project rule.
        const before = await listPulls(GONE, member());
        expect(before.status).toBe(200);
        expect(before.body.data.items).toHaveLength(1);
        expect((await listPulls(GONE, reader())).body.data.items).toHaveLength(1);

        await deleteProject(GONE, { id: "u-admin", role: "admin" } as Parameters<
          typeof deleteProject
        >[1]);

        const gone = await listPulls(GONE, member());
        const unknown = await listPulls("project-1470-missing", member());
        expect(gone.status).toBe(404);
        expect(unknown.status).toBe(404);
        expect(gone.body).toEqual(unknown.body);
        const detail = await request(api)
          .get(`/api/projects/${GONE}/pr-reviews/41?owner=${GONE_OWNER}&repo=app`)
          .set("Authorization", member());
        expect(detail.status).toBe(404);

        const admin = await listPulls(GONE, reader());
        expect(admin.status).toBe(200);
        expect(admin.body.data.items).toHaveLength(1);

        // And a delivery for the deleted project's repo is neither reviewed nor recorded.
        evaluate.mockClear();
        await deliver(GONE_OWNER, 42, "Closes #5");
        expect(evaluate).not.toHaveBeenCalled();
        expect(await rowOf(GONE, GONE_OWNER, 42)).toBeNull();
      });
    });
  },
);
