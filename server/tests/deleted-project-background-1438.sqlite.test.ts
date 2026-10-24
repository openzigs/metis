/**
 * #1438 — background work never runs for a soft-deleted project.
 *
 * #1430 closed a soft-deleted project to members' requests; nothing stopped
 * the work nobody is present for. Each firing path below is driven against a
 * soft-deleted project and, as the control, a live one set up identically.
 * (The webhook-trigger receivers are covered in `async-routes.test.ts`.)
 *
 * Proven against a REAL SQLite database built by the real migration chain, so
 * every `deletedAt` filter is the one production runs: a stub that ignores the
 * `where` clause could not tell a filter from no filter at all.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});
const noteRequirementCodeLinksChanged = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/docs-gen/approved-requirements-staleness.js", () => ({
  noteRequirementCodeLinksChanged,
}));
const { syncMergedPR } = await import("../src/lib/living-spec/requirement-sync.js");
const { findProjectForRepo, resolveProjectForQueuedReview } =
  await import("../src/routes/webhooks-github.js");
const { AsyncRunner } = await import("../src/lib/async/runner.js");
const { SchedulerService } = await import("../src/lib/scheduler/scheduler-service.js");
const { bootstrapScheduler } = await import("../src/lib/scheduler/index.js");
const { loadSchedulerConfig } = await import("../src/lib/scheduler/config.js");
const { isProjectSoftDeleted, softDeletedProjectIds } =
  await import("../src/lib/projects/deleted-project-guard.js");

const T0 = "2026-10-01T00:00:00.000Z";
const DIFF = `--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n+x\n`;
const LIVE = "pLive";
const DELETED = "pDel";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1438 — background work skips a soft-deleted project (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1438-deleted-project-background");
      sqlite.exec(
        `INSERT INTO users (id, username, displayName, email, createdAt, updatedAt)
         VALUES ('u1','u1','U1','u1@example.test',?,?)`,
        [T0, T0],
      );
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await seedProject(LIVE, "live-org");
      await seedProject(DELETED, "deleted-org");
      await db.project.update({ where: { id: DELETED }, data: { deletedAt: new Date() } });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    /** A project with a GitHub repo connection and a requirement published as issue #5. */
    async function seedProject(p: string, owner: string): Promise<void> {
      await db.project.create({
        data: { id: p, name: p, slug: `slug-${p}`, createdById: "u1", autoReviewPrs: true },
      });
      await db.repoConnection.create({
        data: {
          id: `repo_${p}`,
          projectId: p,
          label: "main",
          ownerOrOrg: owner,
          repoName: "app",
          isPrimary: true,
        },
      });
      await db.databaseConnection.create({
        data: { id: `db_${p}`, projectId: p, label: "warehouse", driver: "postgres" },
      });
      await db.analysis.create({ data: { id: `an_${p}`, projectId: p, startedById: "u1" } });
      await db.requirement.create({
        data: {
          id: `req_${p}`,
          projectId: p,
          analysisId: `an_${p}`,
          title: `Requirement of ${p}`,
          body: "body",
        },
      });
      await db.issueDraft.create({
        data: {
          id: `draft_${p}`,
          projectId: p,
          requirementId: `req_${p}`,
          title: `Draft of ${p}`,
          body: "body",
          status: "published",
        },
      });
      const batch = await db.publishBatch.create({
        data: {
          id: `batch_${p}`,
          projectId: p,
          targetOwner: owner,
          targetRepo: "app",
          startedById: "u1",
          status: "completed",
        },
      });
      await db.publishedIssue.create({
        data: {
          batchId: batch.id,
          draftId: `draft_${p}`,
          issueNumber: 5,
          issueId: `node_${p}`,
          htmlUrl: `https://github.com/${owner}/app/issues/5`,
          destination: "github",
        },
      });
    }

    async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
      for (let i = 0; i < 200; i++) {
        const v = await read();
        if (done(v)) return v;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("condition not reached");
    }

    it("the guard names soft-deleted projects only — not live, unknown or null ones", async () => {
      expect(await isProjectSoftDeleted(DELETED)).toBe(true);
      expect(await isProjectSoftDeleted(LIVE)).toBe(false);
      expect(await isProjectSoftDeleted("no-such-project")).toBe(false);
      expect(await isProjectSoftDeleted(null)).toBe(false);
      expect([...(await softDeletedProjectIds([LIVE, DELETED, null, DELETED]))]).toEqual([DELETED]);
    });

    describe("PR auto-review (findProjectForRepo)", () => {
      it("resolves no project for a repo connected only to a deleted project", async () => {
        expect(await findProjectForRepo("deleted-org/app")).toBeNull();
      });

      it("control: resolves the live project for its repo", async () => {
        expect(await findProjectForRepo("live-org/app")).toMatchObject({
          id: LIVE,
          autoReviewPrs: true,
        });
      });

      it("a live project sharing the repo wins over a deleted primary", async () => {
        await db.project.create({
          data: { id: "pShare", name: "share", slug: "slug-share", createdById: "u1" },
        });
        await db.repoConnection.create({
          data: {
            projectId: "pShare",
            label: "second",
            ownerOrOrg: "deleted-org",
            repoName: "app",
          },
        });
        try {
          expect(await findProjectForRepo("deleted-org/app")).toMatchObject({ id: "pShare" });
        } finally {
          await db.project.delete({ where: { id: "pShare" } });
        }
      });
    });

    describe("merged-PR requirement sync (syncMergedPR)", () => {
      const merged = (owner: string) => ({
        pr: {
          number: 9,
          merged: true,
          merged_at: T0,
          body: "Closes #5",
          merge_commit_sha: `sha-${owner}`,
          html_url: `https://github.com/${owner}/app/pull/9`,
        },
        repo: { full_name: `${owner}/app`, html_url: `https://github.com/${owner}/app` },
        diff: DIFF,
      });

      it("links nothing in a deleted project", async () => {
        await syncMergedPR(merged("deleted-org") as any);
        expect(
          await db.requirementImplementation.count({ where: { requirementId: `req_${DELETED}` } }),
        ).toBe(0);
      });

      it("control: links the live project's requirement", async () => {
        await syncMergedPR(merged("live-org") as any);
        expect(
          await db.requirementImplementation.count({ where: { requirementId: `req_${LIVE}` } }),
        ).toBeGreaterThan(0);
      });
    });

    describe("background runs (AsyncRunner)", () => {
      it("cancels a deleted project's queued run without calling its handler; a live run succeeds", async () => {
        const runner = new AsyncRunner({ concurrency: 1 });
        const handler = vi.fn(async () => ({ result: "ran" }));
        runner.registerHandler("custom", handler);

        const del = await runner.submit({ projectId: DELETED, kind: "custom" });
        await runner.onIdle();
        const delRow = await db.backgroundRun.findUniqueOrThrow({ where: { id: del.id } });
        expect(delRow.status).toBe("cancelled");
        expect(delRow.error).toBe("PROJECT_DELETED");
        expect(handler).not.toHaveBeenCalled();

        const live = await runner.submit({ projectId: LIVE, kind: "custom" });
        await runner.onIdle();
        const liveRow = await db.backgroundRun.findUniqueOrThrow({ where: { id: live.id } });
        expect(liveRow.status).toBe("succeeded");
        expect(handler).toHaveBeenCalledTimes(1);
        runner.stop();
      });

      it("cancels a run that was queued BEFORE its project was deleted", async () => {
        await db.project.create({
          data: { id: "pLate", name: "late", slug: "slug-late", createdById: "u1" },
        });
        const row = await db.backgroundRun.create({
          data: { projectId: "pLate", kind: "custom", payload: "{}" },
        });
        await db.project.update({ where: { id: "pLate" }, data: { deletedAt: new Date() } });
        const runner = new AsyncRunner({ concurrency: 1 });
        const handler = vi.fn(async () => ({}));
        runner.registerHandler("custom", handler);
        await runner.dispatchQueued();
        await runner.onIdle();
        const after = await db.backgroundRun.findUniqueOrThrow({ where: { id: row.id } });
        expect(after.status).toBe("cancelled");
        expect(handler).not.toHaveBeenCalled();
        runner.stop();
      });
    });

    describe("scheduled jobs (SchedulerService.fireScheduledJob)", () => {
      it("does not fire a deleted project's job and reports it skipped; a live project's job fires", async () => {
        const enqueue = vi.fn(async () => ({}));
        const events: Array<{ jobId: string; status: string; message?: string }> = [];
        const svc = new SchedulerService({
          queue: { enqueue } as any,
          registry: { get: () => undefined, list: () => [] } as any,
          emitter: {
            schedulerStatus: (e: any) => events.push(e),
            taskStatus() {},
            taskProgress() {},
          },
          config: loadSchedulerConfig({}),
        });
        const fire = (id: string) => (svc as any).fireScheduledJob(id) as Promise<void>;
        const delJob = await db.scheduledJob.create({
          data: { key: "del", name: "del", cron: "* * * * *", projectId: DELETED },
        });
        const liveJob = await db.scheduledJob.create({
          data: { key: "live", name: "live", cron: "* * * * *", projectId: LIVE },
        });

        await fire(delJob.id);
        expect(enqueue).not.toHaveBeenCalled();
        expect(events).toContainEqual(
          expect.objectContaining({
            jobId: delJob.id,
            status: "skipped",
            message: "project deleted",
          }),
        );
        // The job row is left as the owner set it, so a restore resumes it.
        const delAfter = await db.scheduledJob.findUniqueOrThrow({ where: { id: delJob.id } });
        expect(delAfter.enabled).toBe(true);
        expect(delAfter.lastFiredAt).toBeNull();

        await fire(liveJob.id);
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ projectId: LIVE }));
        await svc.stop();
      });

      it("refuses an admin's run-now of a deleted project's job with 410; a live job runs", async () => {
        const enqueue = vi.fn(async () => ({ id: "t1" }));
        const svc = new SchedulerService({
          queue: { enqueue } as any,
          registry: { get: () => undefined, list: () => [] } as any,
          emitter: { schedulerStatus() {}, taskStatus() {}, taskProgress() {} },
          config: loadSchedulerConfig({}),
        });
        const admin = { id: "u1", role: "admin" as const };
        const delJob = await db.scheduledJob.create({
          data: { key: "del-now", name: "del-now", cron: "* * * * *", projectId: DELETED },
        });
        const liveJob = await db.scheduledJob.create({
          data: { key: "live-now", name: "live-now", cron: "* * * * *", projectId: LIVE },
        });
        await expect(svc.runNow(delJob.id, admin)).rejects.toMatchObject({
          status: 410,
          code: "PROJECT_DELETED",
        });
        expect(enqueue).not.toHaveBeenCalled();
        await svc.runNow(liveJob.id, admin);
        expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ projectId: LIVE }));
      });
    });

    describe("scheduler tasks (the production TaskQueue from bootstrapScheduler)", () => {
      it("cancels a deleted project's task without running its handler; a live task runs", async () => {
        const boot = bootstrapScheduler({ config: { ...loadSchedulerConfig({}), enabled: false } });
        try {
          const handler = vi.fn(async () => ({ ok: true }));
          boot.registry.register({ type: "probe-1438", description: "probe", handler });

          const del = await boot.queue.enqueue({ type: "probe-1438", projectId: DELETED });
          const delRow = await waitFor(
            () => db.task.findUniqueOrThrow({ where: { id: del.id } }),
            (t) => t.status !== "pending" && t.status !== "running",
          );
          expect(delRow.status).toBe("cancelled");
          expect(delRow.errorMessage).toBe("project deleted");
          expect(handler).not.toHaveBeenCalled();

          const live = await boot.queue.enqueue({ type: "probe-1438", projectId: LIVE });
          const liveRow = await waitFor(
            () => db.task.findUniqueOrThrow({ where: { id: live.id } }),
            (t) => t.status !== "pending" && t.status !== "running",
          );
          expect(liveRow.status).toBe("completed");
          expect(handler).toHaveBeenCalledTimes(1);
        } finally {
          await boot.shutdown();
        }
      });
    });
    /**
     * #1438 review — the `projectId` column is optional. These task types name
     * their project only through their payload (or a connector or batch of the
     * project), so a gate keyed on the column alone let them run.
     */
    describe("task types that name their project only through the payload", () => {
      const cases: Array<{
        type: string;
        override:
          "rerunAnalysis" | "refreshRepoConnector" | "refreshDbConnectorSchema" | "publishBatch";
        payload: (p: string) => Record<string, unknown>;
      }> = [
        {
          type: "rerun-analysis",
          override: "rerunAnalysis",
          payload: (p) => ({ projectId: p }),
        },
        {
          type: "refresh-repo-connector",
          override: "refreshRepoConnector",
          payload: (p) => ({ connectorId: `repo_${p}` }),
        },
        {
          type: "refresh-db-connector-schema",
          override: "refreshDbConnectorSchema",
          payload: (p) => ({ connectorId: `db_${p}` }),
        },
        {
          type: "publish-batch",
          override: "publishBatch",
          payload: (p) => ({ batchId: `batch_${p}` }),
        },
      ];

      it.each(cases)(
        "the production queue cancels a $type task with a null projectId for a deleted project; a live one runs",
        async ({ type, override, payload }) => {
          const handler = vi.fn(async () => ({}));
          const boot = bootstrapScheduler({
            config: { ...loadSchedulerConfig({}), enabled: false },
            handlerOverrides: { [override]: handler },
          });
          try {
            const del = await boot.queue.enqueue({
              type,
              payload: payload(DELETED),
            });
            expect(del.projectId).toBeNull();
            const delRow = await waitFor(
              () => db.task.findUniqueOrThrow({ where: { id: del.id } }),
              (t) => t.status !== "pending" && t.status !== "running",
            );
            expect(delRow.status).toBe("cancelled");
            expect(delRow.errorMessage).toBe("project deleted");
            expect(handler).not.toHaveBeenCalled();

            const live = await boot.queue.enqueue({ type, payload: payload(LIVE) });
            const liveRow = await waitFor(
              () => db.task.findUniqueOrThrow({ where: { id: live.id } }),
              (t) => t.status !== "pending" && t.status !== "running",
            );
            expect(liveRow.status).toBe("completed");
            expect(handler).toHaveBeenCalledTimes(1);
          } finally {
            await boot.shutdown();
          }
        },
      );

      it.each(cases)(
        "a $type job with a null projectId does not fire for a deleted project; a live one fires",
        async ({ type, payload }) => {
          const enqueue = vi.fn(async () => ({}));
          const events: Array<{ jobId: string; status: string }> = [];
          const svc = new SchedulerService({
            queue: { enqueue } as any,
            registry: { get: () => undefined, list: () => [] } as any,
            emitter: {
              schedulerStatus: (e: any) => events.push(e),
              taskStatus() {},
              taskProgress() {},
            },
            config: loadSchedulerConfig({}),
          });
          const fire = (id: string) => (svc as any).fireScheduledJob(id) as Promise<void>;
          const delJob = await db.scheduledJob.create({
            data: {
              key: `null-del-${type}`,
              name: "n",
              cron: "* * * * *",
              taskType: type,
              payload: JSON.stringify(payload(DELETED)),
            },
          });
          const liveJob = await db.scheduledJob.create({
            data: {
              key: `null-live-${type}`,
              name: "n",
              cron: "* * * * *",
              taskType: type,
              payload: JSON.stringify(payload(LIVE)),
            },
          });
          await fire(delJob.id);
          expect(enqueue).not.toHaveBeenCalled();
          expect(events).toContainEqual(
            expect.objectContaining({ jobId: delJob.id, status: "skipped" }),
          );
          await expect(svc.runNow(delJob.id, { id: "u1", role: "admin" })).rejects.toMatchObject({
            status: 410,
          });
          await fire(liveJob.id);
          expect(enqueue).toHaveBeenCalledTimes(1);
          await svc.stop();
        },
      );
    });

    describe("queued PR review (resolveProjectForQueuedReview)", () => {
      const job = (projectId: string, owner: string) => ({
        deliveryId: "d1",
        projectId,
        owner,
        repo: "app",
        prNumber: 7,
      });

      it("control: a job runs for the live project it was enqueued for", async () => {
        expect(await resolveProjectForQueuedReview(job(LIVE, "live-org"))).toMatchObject({
          id: LIVE,
        });
      });

      it("never runs a job for a different project than it was enqueued for", async () => {
        // Enqueued for the (now deleted) project; the repo now resolves to another live one.
        await db.project.create({
          data: {
            id: "pOther",
            name: "other",
            slug: "slug-other",
            createdById: "u1",
            autoReviewPrs: true,
          },
        });
        await db.repoConnection.create({
          data: {
            projectId: "pOther",
            label: "o",
            ownerOrOrg: "deleted-org",
            repoName: "app",
          },
        });
        try {
          expect(await findProjectForRepo("deleted-org/app")).toMatchObject({
            id: "pOther",
          });
          expect(await resolveProjectForQueuedReview(job(DELETED, "deleted-org"))).toBeNull();
        } finally {
          await db.project.delete({ where: { id: "pOther" } });
        }
      });

      it("hands back a project that switched auto-review off, flagged off, so the skip is recorded (#1470)", async () => {
        await db.project.update({
          where: { id: LIVE },
          data: { autoReviewPrs: false },
        });
        try {
          // The executor's first gate refuses a project with review off; the
          // review itself is proven not to run in pr-review-state-1470.sqlite.test.ts.
          expect(await resolveProjectForQueuedReview(job(LIVE, "live-org"))).toMatchObject({
            id: LIVE,
            autoReviewPrs: false,
          });
        } finally {
          await db.project.update({
            where: { id: LIVE },
            data: { autoReviewPrs: true },
          });
        }
      });
    });
  },
);
