/**
 * #1221 — scheduled jobs, tasks and the sandbox follow project access: the
 * project's workspace members, not only its creator.
 *
 * One workspace (`ws1`) holds project A, created by Alice. Bob is a second
 * member of `ws1` (coordinator, NOT the creator), Rita a third (reader role).
 * Mallory is a coordinator in `ws2`, where she created project B. Nobody here
 * is a system admin — an admin bypasses the check, so an admin test proves
 * nothing about it.
 *
 * Real SQLite built by the migration chain, real routers, real JWTs, the real
 * scheduler bootstrap with its Prisma-backed task store; the only doubles are
 * the task handlers and the sandbox provider (so nothing executes). Every
 * mutation is read back from the database.
 *
 * Each "Bob may" assertion fails if the creator-only check
 * (`listAccessibleProjectIds(actor).includes(projectId)`) is restored in
 * `actorHasProjectAccess` / `buildProjectAccessWhere`.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole, type AuthPayload, type RoleKey } from "@metis/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.SCHEDULER_RUN_LIMIT_MAX = "100000";
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

// The sandbox provider never runs: a fake sandbox answers every snippet.
const sandboxRuns = vi.hoisted(() => [] as Array<{ projectId: string; userId: string }>);
vi.mock("../src/lib/sandbox/factory.js", () => ({ getSandboxProvider: () => ({}) }));
vi.mock("../src/lib/sandbox/with-sandbox.js", () => ({
  withSandbox: async (
    _provider: unknown,
    opts: { projectId: string; userId: string },
    fn: (sandbox: unknown) => Promise<unknown>,
  ) => {
    sandboxRuns.push({ projectId: opts.projectId, userId: opts.userId });
    const exec = { exitCode: 0, stdout: "1\n", stderr: "", durationMs: 1 };
    return fn({ id: "sbx-1221", runCode: async () => exec, commands: { run: async () => exec } });
  },
}));

const { schedulerRouter } = await import("../src/routes/scheduler.js");
const { tasksRouter } = await import("../src/routes/tasks.js");
const { sandboxRouter } = await import("../src/routes/sandbox.js");
const { bootstrapScheduler, getSchedulerBootstrap, __resetSchedulerBootstrap } =
  await import("../src/lib/scheduler/index.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const WS1 = "ws1-1221";
const WS2 = "ws2-1221";
const PA = "proj-a-1221";
const PB = "proj-b-1221";

const USERS: Record<string, { role: RoleKey; ws: string }> = {
  alice: { role: "coordinator", ws: WS1 },
  bob: { role: "coordinator", ws: WS1 },
  rita: { role: "reader", ws: WS1 },
  mallory: { role: "coordinator", ws: WS2 },
};
type Who = keyof typeof USERS;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1221 — scheduler, tasks and sandbox are open to the project's workspace members",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let shutdown: (() => Promise<void>) | undefined;

    const bearer = (who: Who) => {
      const payload: AuthPayload = {
        userId: who,
        username: who,
        role: USERS[who].role,
        permissions: getPermissionsForRole(USERS[who].role),
        workspaces: [USERS[who].ws],
      };
      return `Bearer ${issueTokens(payload).accessToken}`;
    };

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/scheduler", schedulerRouter());
      a.use("/api/tasks", tasksRouter());
      a.use("/api/sandbox", sandboxRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const get = (path: string, who: Who) =>
      request(app()).get(path).set("Authorization", bearer(who));
    const post = (path: string, who: Who, body: object = {}) =>
      request(app()).post(path).set("Authorization", bearer(who)).send(body);
    const patch = (path: string, who: Who, body: object) =>
      request(app()).patch(path).set("Authorization", bearer(who)).send(body);
    const del = (path: string, who: Who) =>
      request(app()).delete(path).set("Authorization", bearer(who));

    let seq = 0;
    const newJob = async (projectId: string, createdById: string) =>
      db.scheduledJob.create({
        data: {
          key: `job-1221-${++seq}`,
          name: `job ${seq}`,
          cron: "*/15 * * * *",
          taskType: "rerun-analysis",
          projectId,
          createdById,
        },
      });
    const newTask = async (projectId: string, status: string) =>
      db.task.create({
        data: {
          type: "rerun-analysis",
          status,
          payload: JSON.stringify({ projectId }),
          projectId,
          maxAttempts: 1,
          ...(status === "failed" ? { completedAt: new Date(), errorMessage: "boom" } : {}),
        },
      });
    const jobRow = (id: string) => db.scheduledJob.findUniqueOrThrow({ where: { id } });
    const taskRow = (id: string) => db.task.findUniqueOrThrow({ where: { id } });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1221-member-access-scheduler");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const id of Object.keys(USERS)) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      for (const ws of [WS1, WS2]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      for (const [userId, u] of Object.entries(USERS)) {
        await db.workspaceMember.create({
          data: { workspaceId: u.ws, userId, role: "member" },
        });
      }
      await db.project.create({
        data: { id: PA, name: "A", slug: PA, createdById: "alice", workspaceId: WS1 },
      });
      await db.project.create({
        data: { id: PB, name: "B", slug: PB, createdById: "mallory", workspaceId: WS2 },
      });
      __resetSchedulerBootstrap();
      shutdown = bootstrapScheduler({
        handlerOverrides: { rerunAnalysis: async () => ({}) },
      }).shutdown;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await shutdown?.();
      __resetSchedulerBootstrap();
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    // ── Scheduled jobs ───────────────────────────────────────────────────────

    describe("scheduled jobs", () => {
      it("both members list and read a job in the project; the non-member sees nothing", async () => {
        const jobA = await newJob(PA, "alice");
        const jobB = await newJob(PB, "mallory");

        for (const who of ["bob", "rita"] as const) {
          const all = await get("/api/scheduler", who);
          expect(all.status).toBe(200);
          const ids = (all.body.data as Array<{ id: string }>).map((j) => j.id);
          expect(ids).toContain(jobA.id);
          expect(ids).not.toContain(jobB.id);

          const filtered = await get(`/api/scheduler?projectId=${PA}`, who);
          expect((filtered.body.data as Array<{ id: string }>).map((j) => j.id)).toContain(jobA.id);

          const one = await get(`/api/scheduler/${jobA.id}`, who);
          expect(one.status).toBe(200);
          expect(one.body.data.id).toBe(jobA.id);

          const history = await get(`/api/scheduler/${jobA.id}/history`, who);
          expect(history.status).toBe(200);
        }

        const outsiderList = await get("/api/scheduler", "mallory");
        expect((outsiderList.body.data as Array<{ id: string }>).map((j) => j.id)).not.toContain(
          jobA.id,
        );
        const outsiderFiltered = await get(`/api/scheduler?projectId=${PA}`, "mallory");
        expect(outsiderFiltered.body.data).toEqual([]);
        expect((await get(`/api/scheduler/${jobA.id}`, "mallory")).status).toBe(404);
        expect((await get(`/api/scheduler/${jobA.id}/history`, "mallory")).status).toBe(404);
        expect(auditSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            actor: { id: "mallory" },
            action: "scheduled-job.read.denied",
          }),
        );
      });

      it("a second member creates a job in the project; a reader member and a non-member cannot", async () => {
        const body = (key: string) => ({
          key,
          name: key,
          cron: "*/15 * * * *",
          taskType: "rerun-analysis",
          projectId: PA,
        });
        const created = await post("/api/scheduler", "bob", body("bob-job-1221"));
        expect(created.status).toBe(201);
        const row = await db.scheduledJob.findUnique({ where: { key: "bob-job-1221" } });
        expect(row?.projectId).toBe(PA);
        expect(row?.createdById).toBe("bob");

        // Reader-role member: refused at the permission layer.
        expect((await post("/api/scheduler", "rita", body("rita-job-1221"))).status).toBe(403);
        // Non-member: the same 404 an unknown project answers.
        const outsider = await post("/api/scheduler", "mallory", body("mallory-job-1221"));
        expect(outsider.status).toBe(404);
        expect(
          await db.scheduledJob.count({
            where: { key: { in: ["rita-job-1221", "mallory-job-1221"] } },
          }),
        ).toBe(0);
      });

      it("a second member updates, pauses and resumes the job; reader and non-member cannot", async () => {
        const job = await newJob(PA, "alice");
        const ok = await patch(`/api/scheduler/${job.id}`, "bob", { name: "renamed by bob" });
        expect(ok.status).toBe(200);
        expect((await jobRow(job.id)).name).toBe("renamed by bob");
        expect((await post(`/api/scheduler/${job.id}/pause`, "bob")).status).toBe(200);
        expect((await jobRow(job.id)).enabled).toBe(false);
        expect((await post(`/api/scheduler/${job.id}/resume`, "bob")).status).toBe(200);
        expect((await jobRow(job.id)).enabled).toBe(true);

        expect((await patch(`/api/scheduler/${job.id}`, "rita", { name: "rita" })).status).toBe(
          403,
        );
        expect(
          (await patch(`/api/scheduler/${job.id}`, "mallory", { name: "mallory" })).status,
        ).toBe(404);
        expect((await post(`/api/scheduler/${job.id}/pause`, "mallory")).status).toBe(404);
        const after = await jobRow(job.id);
        expect(after.name).toBe("renamed by bob");
        expect(after.enabled).toBe(true);
      });

      it("a job cannot be moved across projects the actor cannot reach, in either direction", async () => {
        const jobA = await newJob(PA, "alice");
        const jobB = await newJob(PB, "mallory");
        // Bob may edit project A's job but not move it into project B.
        const out = await patch(`/api/scheduler/${jobA.id}`, "bob", { projectId: PB });
        expect(out.status).toBe(404);
        expect((await jobRow(jobA.id)).projectId).toBe(PA);
        // Mallory may edit project B's job but not move it into project A.
        const into = await patch(`/api/scheduler/${jobB.id}`, "mallory", { projectId: PA });
        expect(into.status).toBe(404);
        expect((await jobRow(jobB.id)).projectId).toBe(PB);
        // Positive control: each may still edit their own project's job.
        expect((await patch(`/api/scheduler/${jobB.id}`, "mallory", { name: "m" })).status).toBe(
          200,
        );
      });

      it("a second member runs the job now; reader and non-member cannot", async () => {
        const job = await newJob(PA, "alice");
        const run = await post(`/api/scheduler/${job.id}/run`, "bob");
        expect(run.status).toBe(202);
        const task = await taskRow(run.body.data.taskId as string);
        expect(task.scheduledJobId).toBe(job.id);
        expect(task.projectId).toBe(PA);
        expect(task.createdById).toBe("bob");

        const before = await db.task.count({ where: { scheduledJobId: job.id } });
        expect((await post(`/api/scheduler/${job.id}/run`, "rita")).status).toBe(403);
        expect((await post(`/api/scheduler/${job.id}/run`, "mallory")).status).toBe(404);
        expect(await db.task.count({ where: { scheduledJobId: job.id } })).toBe(before);
      });

      it("a second member deletes the job; reader and non-member cannot", async () => {
        const kept = await newJob(PA, "alice");
        expect((await del(`/api/scheduler/${kept.id}`, "rita")).status).toBe(403);
        expect((await del(`/api/scheduler/${kept.id}`, "mallory")).status).toBe(404);
        expect((await jobRow(kept.id)).deletedAt).toBeNull();

        expect((await del(`/api/scheduler/${kept.id}`, "bob")).status).toBe(204);
        expect((await jobRow(kept.id)).deletedAt).not.toBeNull();
      });
    });

    // ── Tasks ────────────────────────────────────────────────────────────────

    describe("tasks", () => {
      it("both members list and read the project's tasks; the non-member sees none", async () => {
        const taskA = await newTask(PA, "completed");
        const taskB = await newTask(PB, "completed");

        for (const who of ["bob", "rita"] as const) {
          const all = await get("/api/tasks?take=200", who);
          expect(all.status).toBe(200);
          const ids = (all.body.data.items as Array<{ id: string }>).map((t) => t.id);
          expect(ids).toContain(taskA.id);
          expect(ids).not.toContain(taskB.id);

          const filtered = await get(`/api/tasks?projectId=${PA}&take=200`, who);
          expect((filtered.body.data.items as Array<{ id: string }>).map((t) => t.id)).toContain(
            taskA.id,
          );
          expect((await get(`/api/tasks/${taskA.id}`, who)).status).toBe(200);
        }

        const outsider = await get(`/api/tasks?projectId=${PA}`, "mallory");
        expect(outsider.body.data).toEqual({ items: [], total: 0 });
        const outsiderAll = await get("/api/tasks?take=200", "mallory");
        expect(
          (outsiderAll.body.data.items as Array<{ id: string }>).map((t) => t.id),
        ).not.toContain(taskA.id);
        expect((await get(`/api/tasks/${taskA.id}`, "mallory")).status).toBe(404);
      });

      it("a second member cancels a pending task; reader and non-member cannot", async () => {
        // Enqueued through the real queue, due in an hour, so it sits pending.
        const task = await getSchedulerBootstrap().queue.enqueue({
          type: "rerun-analysis",
          payload: { projectId: PA },
          projectId: PA,
          scheduledFor: new Date(Date.now() + 3_600_000),
        });
        expect((await post(`/api/tasks/${task.id}/cancel`, "rita")).status).toBe(403);
        expect((await post(`/api/tasks/${task.id}/cancel`, "mallory")).status).toBe(409);
        expect((await taskRow(task.id)).status).toBe("pending");

        expect((await post(`/api/tasks/${task.id}/cancel`, "bob")).status).toBe(202);
        expect((await taskRow(task.id)).status).toBe("cancelled");
        expect(auditSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            actor: { id: "bob" },
            action: "task.cancel",
            target: { type: "task", id: task.id },
          }),
        );
      });

      it("a retry by a second member is audited under that member, not the task's creator", async () => {
        const task = await db.task.create({
          data: {
            type: "rerun-analysis",
            status: "failed",
            payload: JSON.stringify({ projectId: PA }),
            projectId: PA,
            maxAttempts: 1,
            createdById: "alice",
            completedAt: new Date(),
            errorMessage: "boom",
          },
        });
        auditSpy.mockClear();
        const res = await post(`/api/tasks/${task.id}/retry`, "bob");
        expect(res.status).toBe(202);
        expect(auditSpy).toHaveBeenCalledWith({
          actor: { id: "bob" },
          action: "task.retry",
          target: { type: "task", id: task.id },
          metadata: {
            retryTaskId: res.body.data.taskId,
            projectId: PA,
            originalCreatedById: "alice",
          },
        });
      });

      it("a second member retries a failed task; reader and non-member cannot", async () => {
        const task = await newTask(PA, "failed");
        const retries = () => db.task.count({ where: { trigger: "retry", projectId: PA } });
        const before = await retries();
        expect((await post(`/api/tasks/${task.id}/retry`, "rita")).status).toBe(403);
        expect((await post(`/api/tasks/${task.id}/retry`, "mallory")).status).toBe(404);
        expect(await retries()).toBe(before);

        expect((await post(`/api/tasks/${task.id}/retry`, "bob")).status).toBe(202);
        expect(await retries()).toBe(before + 1);
      });
    });

    // ── Sandbox ──────────────────────────────────────────────────────────────

    describe("sandbox run-once", () => {
      it("a second member runs a snippet against the project; reader and non-member cannot", async () => {
        const body = { projectId: PA, language: "python", code: "print(1)" };
        const ok = await post("/api/sandbox/run-once", "bob", body);
        expect(ok.status).toBe(200);
        expect(ok.body.data.stdout).toBe("1\n");
        expect(sandboxRuns).toContainEqual({ projectId: PA, userId: "bob" });

        const runs = sandboxRuns.length;
        expect((await post("/api/sandbox/run-once", "rita", body)).status).toBe(403);
        const outsider = await post("/api/sandbox/run-once", "mallory", body);
        expect(outsider.status).toBe(403);
        expect(sandboxRuns.length).toBe(runs);
        expect(auditSpy).toHaveBeenCalledWith(
          expect.objectContaining({ actor: { id: "mallory" }, action: "sandbox.run-once.denied" }),
        );
      });
    });
  },
);
