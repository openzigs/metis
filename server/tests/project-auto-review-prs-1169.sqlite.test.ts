/**
 * #1169 — `Project.autoReviewPrs` gets a setter: `PATCH /api/projects/:id
 * { autoReviewPrs }`.
 *
 * Driven through the REAL projects router, project service and GitHub PR
 * webhook router against a REAL SQLite database built from the migration
 * chain. Every success is read back from the row (or a fresh GET), never from
 * the PATCH's own answer; every denial is paired with a positive control. The
 * webhook half proves the setter is the switch the receiver reads: the same
 * delivery enqueues a review while the flag is on and does nothing while off.
 * No model runs — the queue is a recording fake.
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
import type { PrReviewQueue } from "../src/lib/agents/pr-reviewer/queue.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return { db: null as unknown };
});
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});
const auditSpy = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: auditSpy }));

const { projectsRouter } = await import("../src/routes/projects.js");
const { githubPrWebhookRouter } = await import("../src/routes/webhooks-github.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const WS = "ws-1169";
const WS_OTHER = "ws-other-1169";
const SECRET = "test-secret-1169";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1169 — PATCH /api/projects/:id { autoReviewPrs }",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

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

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects", projectsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };

    const patch = (projectId: string, auth: string, body: unknown) =>
      request(app())
        .patch(`/api/projects/${projectId}`)
        .set("Authorization", auth)
        .send(body as object);

    const flagOf = async (projectId: string) =>
      (await db.project.findUniqueOrThrow({ where: { id: projectId } })).autoReviewPrs;

    let seq = 0;
    const newProject = async (createdById: string, workspaceId: string | null = WS) => {
      const id = `project-1169-${++seq}`;
      await db.project.create({
        data: { id, name: id, slug: id, createdById, workspaceId, status: "active" },
      });
      return id;
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1169-auto-review-prs");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const id of ["u-owner", "u-dev", "u-outsider", "u-reader"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      for (const ws of [WS, WS_OTHER]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      for (const [workspaceId, userId] of [
        [WS, "u-owner"],
        [WS, "u-dev"],
        [WS, "u-reader"],
        [WS_OTHER, "u-outsider"],
      ] as const) {
        await db.workspaceMember.create({ data: { workspaceId, userId, role: "member" } });
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => auditSpy.mockClear());

    it("defaults to off, and the project owner turns it on and off again", async () => {
      const id = await newProject("u-owner");
      expect(await flagOf(id)).toBe(false);
      const owner = bearer("u-owner", "coordinator", [WS]);

      const on = await patch(id, owner, { autoReviewPrs: true });
      expect(on.status).toBe(200);
      expect(await flagOf(id)).toBe(true);
      const read = await request(app()).get(`/api/projects/${id}`).set("Authorization", owner);
      expect(read.status).toBe(200);
      expect(read.body.data.autoReviewPrs).toBe(true);
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "project.autoReviewPrs.update",
          actor: { id: "u-owner" },
          target: { type: "project", id },
          metadata: { previous: false, next: true },
        }),
      );

      auditSpy.mockClear();
      const off = await patch(id, owner, { autoReviewPrs: false });
      expect(off.status).toBe(200);
      expect(await flagOf(id)).toBe(false);
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "project.autoReviewPrs.update",
          metadata: { previous: true, next: false },
        }),
      );
    });

    it("an unchanged value writes no dedicated audit entry", async () => {
      const id = await newProject("u-owner");
      const res = await patch(id, bearer("u-owner", "coordinator", [WS]), {
        autoReviewPrs: false,
      });
      expect(res.status).toBe(200);
      const actions = auditSpy.mock.calls.map((c) => (c[0] as { action: string }).action);
      expect(actions).not.toContain("project.autoReviewPrs.update");
    });

    it("leaves the flag alone when a PATCH does not mention it", async () => {
      const id = await newProject("u-owner");
      await db.project.update({ where: { id }, data: { autoReviewPrs: true } });
      const res = await patch(id, bearer("u-owner", "coordinator", [WS]), { name: "renamed" });
      expect(res.status).toBe(200);
      expect(await flagOf(id)).toBe(true);
    });

    it("rejects a non-boolean value with 400 and writes nothing", async () => {
      const id = await newProject("u-owner");
      for (const autoReviewPrs of ["yes", "true", 1, null]) {
        const res = await patch(id, bearer("u-owner", "coordinator", [WS]), { autoReviewPrs });
        expect(res.status).toBe(400);
      }
      expect(await flagOf(id)).toBe(false);
    });

    it("a developer (no project.update) gets 403 and the flag stays off", async () => {
      const id = await newProject("u-dev");
      const res = await patch(id, bearer("u-dev", "developer", [WS]), { autoReviewPrs: true });
      expect(res.status).toBe(403);
      expect(await flagOf(id)).toBe(false);
    });

    it("a reader gets 403 and the flag stays off", async () => {
      const id = await newProject("u-reader");
      const res = await patch(id, bearer("u-reader", "reader", [WS]), { autoReviewPrs: true });
      expect(res.status).toBe(403);
      expect(await flagOf(id)).toBe(false);
    });

    it("a coordinator from another workspace gets 404, not 403, and the flag stays off", async () => {
      const id = await newProject("u-owner");
      const res = await patch(id, bearer("u-outsider", "coordinator", [WS_OTHER]), {
        autoReviewPrs: true,
      });
      expect(res.status).toBe(404);
      expect(await flagOf(id)).toBe(false);
      // Positive control: the same request from a member of the project's workspace lands.
      const ok = await patch(id, bearer("u-owner", "coordinator", [WS]), { autoReviewPrs: true });
      expect(ok.status).toBe(200);
      expect(await flagOf(id)).toBe(true);
    });

    it("an unknown project is a 404", async () => {
      const res = await patch("p-1169-missing", bearer("u-owner", "admin", [WS]), {
        autoReviewPrs: true,
      });
      expect(res.status).toBe(404);
    });

    describe("the webhook reads the flag this setter writes", () => {
      const enqueued: Array<{ projectId: string; prNumber: number }> = [];
      const queue: PrReviewQueue = {
        enqueue: (job) => {
          enqueued.push(job);
          return { jobId: "jq", queueDepth: enqueued.length };
        },
        enqueueAfter: async (job) => {
          enqueued.push(job);
          return { jobId: `jq_${enqueued.length}`, queueDepth: enqueued.length };
        },
        depth: () => enqueued.length,
        deadLetters: () => [],
        drain: async () => undefined,
        shutdown: async () => undefined,
        isShuttingDown: () => false,
      };

      const webhookApp = () => {
        const a = express();
        a.use(
          express.json({
            verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
              req.rawBody = buf.toString("utf8");
            },
          }),
        );
        a.use("/api/webhooks", githubPrWebhookRouter({ queue, skipDedup: true }));
        return a;
      };

      const deliver = (prNumber: number) => {
        const body = JSON.stringify({
          action: "opened",
          pull_request: {
            number: prNumber,
            title: `PR #${prNumber}`,
            body: "",
            head: { sha: "abc", ref: "feature" },
            html_url: `https://github.com/acme-1169/app/pull/${prNumber}`,
          },
          repository: {
            full_name: "acme-1169/app",
            html_url: "https://github.com/acme-1169/app",
          },
        });
        const sig = "sha256=" + crypto.createHmac("sha256", SECRET).update(body).digest("hex");
        return request(webhookApp())
          .post("/api/webhooks/github/pr")
          .set("Content-Type", "application/json")
          .set("X-Hub-Signature-256", sig)
          .set("X-GitHub-Event", "pull_request")
          .send(body);
      };

      let projectId: string;
      beforeAll(async () => {
        projectId = await newProject("u-owner");
        await db.repoConnection.create({
          data: {
            id: "repo-1169",
            projectId,
            label: "main",
            ownerOrOrg: "acme-1169",
            repoName: "app",
            isPrimary: true,
            status: "connected",
          },
        });
      });
      beforeEach(() => {
        process.env.GITHUB_WEBHOOK_SECRET = SECRET;
        enqueued.length = 0;
      });
      afterEach(() => {
        delete process.env.GITHUB_WEBHOOK_SECRET;
      });

      it("with the flag off, an opened PR enqueues nothing", async () => {
        const owner = bearer("u-owner", "coordinator", [WS]);
        expect((await patch(projectId, owner, { autoReviewPrs: false })).status).toBe(200);
        const res = await deliver(7);
        expect(res.status).toBe(200);
        expect(enqueued).toHaveLength(0);
      });

      it("once switched on through the route, the same delivery enqueues a review", async () => {
        const owner = bearer("u-owner", "coordinator", [WS]);
        expect((await patch(projectId, owner, { autoReviewPrs: true })).status).toBe(200);
        const res = await deliver(8);
        expect(res.status).toBe(200);
        expect(enqueued).toHaveLength(1);
        expect(enqueued[0]).toMatchObject({ projectId, prNumber: 8 });
      });

      it("switched on it fires, and switched back off it stops again", async () => {
        const owner = bearer("u-owner", "coordinator", [WS]);
        expect((await patch(projectId, owner, { autoReviewPrs: true })).status).toBe(200);
        await deliver(9);
        expect(enqueued).toHaveLength(1);
        expect((await patch(projectId, owner, { autoReviewPrs: false })).status).toBe(200);
        await deliver(10);
        expect(enqueued).toHaveLength(1);
      });
    });

    describe("prReviewMonthlyBudgetCents — the monthly limit on PR-review spend", () => {
      const budgetOf = async (projectId: string) =>
        (await db.project.findUniqueOrThrow({ where: { id: projectId } }))
          .prReviewMonthlyBudgetCents;

      it("defaults to no limit; the owner sets it, changes it and clears it, each audited", async () => {
        const id = await newProject("u-owner");
        const owner = bearer("u-owner", "coordinator", [WS]);
        expect(await budgetOf(id)).toBeNull();

        expect((await patch(id, owner, { prReviewMonthlyBudgetCents: 2500 })).status).toBe(200);
        expect(await budgetOf(id)).toBe(2500);
        expect(auditSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "project.prReviewMonthlyBudget.update",
            actor: { id: "u-owner" },
            target: { type: "project", id },
            metadata: { previous: null, next: 2500 },
          }),
        );

        auditSpy.mockClear();
        expect((await patch(id, owner, { prReviewMonthlyBudgetCents: null })).status).toBe(200);
        expect(await budgetOf(id)).toBeNull();
        expect(auditSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "project.prReviewMonthlyBudget.update",
            metadata: { previous: 2500, next: null },
          }),
        );
      });

      it("an unchanged limit writes no dedicated audit entry, and an unrelated PATCH keeps it", async () => {
        const id = await newProject("u-owner");
        await db.project.update({ where: { id }, data: { prReviewMonthlyBudgetCents: 900 } });
        const owner = bearer("u-owner", "coordinator", [WS]);
        expect((await patch(id, owner, { prReviewMonthlyBudgetCents: 900 })).status).toBe(200);
        expect((await patch(id, owner, { name: "renamed-1169" })).status).toBe(200);
        const actions = auditSpy.mock.calls.map((c) => (c[0] as { action: string }).action);
        expect(actions).not.toContain("project.prReviewMonthlyBudget.update");
        expect(await budgetOf(id)).toBe(900);
      });

      it("rejects negative, zero, fractional, string and over-the-maximum limits with 400", async () => {
        const id = await newProject("u-owner");
        await db.project.update({ where: { id }, data: { prReviewMonthlyBudgetCents: 700 } });
        const owner = bearer("u-owner", "coordinator", [WS]);
        for (const prReviewMonthlyBudgetCents of [-1, 0, 12.5, "500", "", 10_000_001, true]) {
          const res = await patch(id, owner, { prReviewMonthlyBudgetCents });
          expect(res.status).toBe(400);
        }
        expect(await budgetOf(id)).toBe(700);
        // The documented maximum itself is accepted.
        expect((await patch(id, owner, { prReviewMonthlyBudgetCents: 10_000_000 })).status).toBe(
          200,
        );
      });

      it("a developer gets 403 and an outsider 404; the limit is unchanged", async () => {
        const id = await newProject("u-owner");
        const dev = await patch(id, bearer("u-dev", "developer", [WS]), {
          prReviewMonthlyBudgetCents: 100,
        });
        expect(dev.status).toBe(403);
        const outsider = await patch(id, bearer("u-outsider", "coordinator", [WS_OTHER]), {
          prReviewMonthlyBudgetCents: 100,
        });
        expect(outsider.status).toBe(404);
        expect(await budgetOf(id)).toBeNull();
      });
    });

    describe("GET /api/projects/:id/pr-review-budget", () => {
      const get = (projectId: string, auth: string) =>
        request(app())
          .get(`/api/projects/${projectId}/pr-review-budget`)
          .set("Authorization", auth);

      it("reports this month's PR-review spend with no limit, and the verdict once one is set", async () => {
        const id = await newProject("u-owner");
        await db.tokenUsage.create({
          data: {
            projectId: id,
            sessionId: "pr-review-1-a",
            provider: "test",
            model: "m",
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            costCents: 123,
            costUsd: 1.23,
            agentStep: "pr-review",
          },
        });
        // Spend that is not a PR review is not counted.
        await db.tokenUsage.create({
          data: {
            projectId: id,
            sessionId: "chat-1",
            provider: "test",
            model: "m",
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            costCents: 5000,
            costUsd: 50,
            agentStep: "chat",
          },
        });
        const reader = bearer("u-reader", "reader", [WS]);
        const open = await get(id, reader);
        expect(open.status).toBe(200);
        expect(open.body.data).toMatchObject({ capCents: null, spentCents: 123, allowed: true });
        expect(open.headers["ratelimit-limit"]).toBeDefined();

        await db.project.update({ where: { id }, data: { prReviewMonthlyBudgetCents: 100 } });
        const capped = await get(id, reader);
        expect(capped.body.data).toMatchObject({ capCents: 100, spentCents: 123, allowed: false });
      });

      it("is a 404 outside the project's workspace", async () => {
        const id = await newProject("u-owner");
        const res = await get(id, bearer("u-outsider", "coordinator", [WS_OTHER]));
        expect(res.status).toBe(404);
        const control = await get(id, bearer("u-owner", "coordinator", [WS]));
        expect(control.status).toBe(200);
      });
    });

    describe("the monthly limit stops reviews end to end (webhook → queue → worker)", () => {
      const OWNER = "acme-1169-budget";
      const evaluate = vi.fn(
        async () => '{"verdicts":[],"comments":[],"overallVerdict":"comment","summary":"x"}',
      );
      const createReview = vi.fn(async () => ({ data: { id: 1, html_url: "u" } }));
      const octokit = {
        pulls: {
          createReview,
          get: vi.fn(async () => ({
            data: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n+x\n",
          })),
          listReviewComments: vi.fn(async () => ({ data: [] })),
        },
      };
      const enqueued: Array<{ projectId: string; prNumber: number }> = [];
      let worker: { queue: PrReviewQueue; shutdown(): Promise<void> };
      let recording: PrReviewQueue;
      let projectId: string;

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

      const deliver = (prNumber: number) => {
        const body = JSON.stringify({
          action: "opened",
          pull_request: {
            number: prNumber,
            title: `PR #${prNumber}`,
            body: "Closes #5",
            head: { sha: `sha${prNumber}`, ref: "feature" },
            html_url: `https://github.com/${OWNER}/app/pull/${prNumber}`,
          },
          repository: { full_name: `${OWNER}/app`, html_url: `https://github.com/${OWNER}/app` },
        });
        const sig = "sha256=" + crypto.createHmac("sha256", SECRET).update(body).digest("hex");
        return request(webhookApp())
          .post("/api/webhooks/github/pr")
          .set("Content-Type", "application/json")
          .set("X-Hub-Signature-256", sig)
          .set("X-GitHub-Event", "pull_request")
          .set("X-GitHub-Delivery", `delivery-1169-${prNumber}`)
          .send(body);
      };

      const skippedForBudget = () =>
        auditSpy.mock.calls
          .map((c) => c[0] as { action: string; metadata?: { reason?: string } })
          .filter(
            (a) => a.action === "pr.review_skipped" && a.metadata?.reason === "budget_exceeded",
          );

      beforeAll(async () => {
        const { startWorker } = await import("../src/lib/agents/pr-reviewer/worker.js");
        const { resolveProjectForQueuedReview } = await import("../src/routes/webhooks-github.js");
        const { createJobEventEmitter } = await import("../src/lib/socket/job-events.js");
        worker = startWorker({
          processorDeps: {
            resolveProject: resolveProjectForQueuedReview,
            resolveJudge: async () => ({ evaluate }),
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
            enqueued.push(job);
            return worker.queue.enqueue(job);
          },
          enqueueAfter: (job, before) => {
            enqueued.push(job);
            return worker.queue.enqueueAfter(job, before);
          },
          drain: () => worker.queue.drain(),
        };

        projectId = await newProject("u-owner");
        await db.repoConnection.create({
          data: {
            id: "repo-1169-budget",
            projectId,
            label: "main",
            ownerOrOrg: OWNER,
            repoName: "app",
            isPrimary: true,
            status: "connected",
          },
        });
        await db.analysis.create({
          data: { id: "an-1169-budget", projectId, startedById: "u-owner" },
        });
        await db.requirement.create({
          data: {
            id: "req-1169-budget",
            projectId,
            analysisId: "an-1169-budget",
            title: "Requirement",
            body: "body",
          },
        });
        await db.issueDraft.create({
          data: {
            id: "draft-1169-budget",
            projectId,
            requirementId: "req-1169-budget",
            title: "Draft",
            body: "## Acceptance criteria\n- [ ] The thing works",
            status: "published",
          },
        });
        await db.publishBatch.create({
          data: {
            id: "batch-1169-budget",
            projectId,
            targetOwner: OWNER,
            targetRepo: "app",
            startedById: "u-owner",
            status: "completed",
          },
        });
        await db.publishedIssue.create({
          data: {
            batchId: "batch-1169-budget",
            draftId: "draft-1169-budget",
            issueNumber: 5,
            issueId: "node-1169-budget",
            htmlUrl: `https://github.com/${OWNER}/app/issues/5`,
            destination: "github",
          },
        });
        const owner = bearer("u-owner", "coordinator", [WS]);
        expect(
          (await patch(projectId, owner, { autoReviewPrs: true, prReviewMonthlyBudgetCents: 100 }))
            .status,
        ).toBe(200);
      });
      afterAll(async () => {
        await worker?.shutdown();
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

      it("under the limit, the delivery is reviewed and the review posted", async () => {
        expect((await deliver(21)).status).toBe(200);
        await recording.drain();
        expect(enqueued).toHaveLength(1);
        expect(evaluate).toHaveBeenCalledTimes(1);
        expect(createReview).toHaveBeenCalledTimes(1);
        expect(skippedForBudget()).toHaveLength(0);
      });

      it("once this month's PR-review spend reaches the limit, the next delivery is not reviewed", async () => {
        await db.tokenUsage.create({
          data: {
            projectId,
            sessionId: "pr-review-20-earlier",
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
        expect((await deliver(22)).status).toBe(200);
        await recording.drain();
        expect(enqueued).toHaveLength(1);
        // No model call and nothing posted to GitHub — and the skip is recorded.
        expect(evaluate).not.toHaveBeenCalled();
        expect(createReview).not.toHaveBeenCalled();
        const skips = skippedForBudget();
        expect(skips).toHaveLength(1);
        expect(skips[0].metadata).toMatchObject({ reason: "budget_exceeded" });
        // And the status the settings card and PR-review page read says so.
        const status = await request(app())
          .get(`/api/projects/${projectId}/pr-review-budget`)
          .set("Authorization", bearer("u-owner", "coordinator", [WS]));
        expect(status.body.data).toMatchObject({ capCents: 100, allowed: false });
      });

      it("raising the limit lets reviews run again", async () => {
        const owner = bearer("u-owner", "coordinator", [WS]);
        expect((await patch(projectId, owner, { prReviewMonthlyBudgetCents: 10_000 })).status).toBe(
          200,
        );
        await deliver(23);
        await recording.drain();
        expect(evaluate).toHaveBeenCalledTimes(1);
      });
    });
  },
);
