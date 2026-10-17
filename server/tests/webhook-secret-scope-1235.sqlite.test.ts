/**
 * #1235 — a scheduled `http-webhook` job may send only a vault secret its
 * author may use, and the rule is re-checked when the job fires.
 *
 * Two workspaces. `ws-a` holds projects PA and PA2; Cora is a coordinator there
 * and Cole a second coordinator. `ws-b` holds PB; Bea is its coordinator and
 * created the B-side connector token. Ada is a system admin. Every request
 * that is judged here is made by a COORDINATOR (`scheduler.manage`, no
 * `vault.reveal`) — an admin bypasses the rule, so an admin request proves
 * nothing about it. Admin appears only to seed a job that a coordinator then
 * tries to move.
 *
 * Real SQLite built by the migration chain, real routers, real JWTs, real vault
 * (encrypted rows), real audit service, the real scheduler bootstrap and the
 * real webhook handler. The only doubles are the network: `fetch` is a spy
 * that answers 204 and DNS is a stub. No request leaves the process, and every
 * secret value is a fake string written by this file.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole, type AuthPayload, type RoleKey } from "@metis/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

const { schedulerRouter } = await import("../src/routes/scheduler.js");
const { tasksRouter } = await import("../src/routes/tasks.js");
const { bootstrapScheduler, __resetSchedulerBootstrap } =
  await import("../src/lib/scheduler/index.js");
const { createHttpWebhookHandler } = await import("../src/lib/scheduler/webhook-handler.js");
const { WEBHOOK_SECRET_REFUSED_MESSAGE } =
  await import("../src/lib/scheduler/webhook-secret-scope.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { getVaultService, __resetVaultSingleton } =
  await import("../src/lib/vault/vault-service.js");
const { getAuditService } = await import("../src/lib/audit/audit-service.js");

type TaskRecord = import("../src/lib/scheduler/types.js").TaskRecord;

const WS_A = "ws-a-1235";
const WS_B = "ws-b-1235";
const PA = "proj-a-1235";
const PA2 = "proj-a2-1235";
const PB = "proj-b-1235";
const HOST = "hooks.example.test";
const FORBIDDEN = "SECRET_BINDING_FORBIDDEN";

const USERS: Record<string, { role: RoleKey; ws: string | null }> = {
  ada: { role: "admin", ws: null },
  cora: { role: "coordinator", ws: WS_A },
  cole: { role: "coordinator", ws: WS_A },
  bea: { role: "coordinator", ws: WS_B },
  // Admins whose standing changes mid-test: Dora is demoted, Ed deprovisioned.
  dora: { role: "admin", ws: WS_A },
  ed: { role: "admin", ws: null },
};
type Who = keyof typeof USERS;

const ref = (body: string) => `\${vault:${body}}`;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1235 — a webhook job sends only a vault secret its author may use",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let shutdown: (() => Promise<void>) | undefined;

    /** Bea's B-side connector token: the secret Cora must never be able to send. */
    let B_SECRET = "";
    const B_LABEL = "b-connector-token-1235";
    /** Cora's own secret. */
    let CORA_SECRET = "";
    /** Cole's own secret. */
    let COLE_SECRET = "";
    /** Ada's secret. */
    let ADMIN_SECRET = "";

    const fetchSpy = vi.fn(
      async (_url: unknown, _init: unknown) =>
        new Response(null, { status: 204, headers: { "content-type": "text/plain" } }),
    );
    const handler = createHttpWebhookHandler({
      config: { allowedHosts: [HOST], maxBytes: 4096, timeoutMs: 2000, requireHttps: false },
      fetchImpl: fetchSpy as unknown as typeof fetch,
      resolveHost: async (hostname: string) => ({ hostname, address: "203.0.113.7", family: 4 }),
      dispatcherFactory: async () => ({ close: async () => undefined }),
    });

    const bearer = (who: Who) => {
      const payload: AuthPayload = {
        userId: who,
        username: who,
        role: USERS[who].role,
        permissions: getPermissionsForRole(USERS[who].role),
        workspaces: USERS[who].ws ? [USERS[who].ws] : [],
      };
      return `Bearer ${issueTokens(payload).accessToken}`;
    };
    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/scheduler", schedulerRouter());
      a.use("/api/tasks", tasksRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const post = (path: string, who: Who, body: object = {}) =>
      request(app()).post(path).set("Authorization", bearer(who)).send(body);
    const patch = (path: string, who: Who, body: object) =>
      request(app()).patch(path).set("Authorization", bearer(who)).send(body);

    let seq = 0;
    const key = () => `hook-1235-${++seq}`;
    const webhook = (authHeader: string, url = `http://${HOST}/in`) => ({
      url,
      authHeader,
      body: { hello: "world" },
    });
    const jobBody = (projectId: string, authHeader: string) => ({
      key: key(),
      name: "webhook",
      cron: "0 3 * * *",
      taskType: "http-webhook",
      projectId,
      enabled: false,
      maxAttempts: 1,
      payload: webhook(authHeader),
    });
    /** A job row as one saved before #1235 would be: written straight to the table. */
    const legacyJob = (createdById: string | null, projectId: string | null, authHeader: string) =>
      db.scheduledJob.create({
        data: {
          key: key(),
          name: "legacy webhook",
          cron: "0 3 * * *",
          taskType: "http-webhook",
          payload: JSON.stringify(webhook(authHeader)),
          projectId,
          enabled: false,
          maxAttempts: 1,
          createdById,
        },
      });
    const taskFor = (
      jobId: string | null,
      projectId: string | null,
      authHeader: string,
      url?: string,
    ): TaskRecord => ({
      id: `task-1235-${++seq}`,
      scheduledJobId: jobId,
      projectId,
      type: "http-webhook",
      trigger: "manual",
      status: "running",
      priority: 5,
      payload: webhook(authHeader, url),
      result: null,
      errorMessage: null,
      progress: null,
      attempts: 1,
      maxAttempts: 1,
      scheduledFor: null,
      startedAt: new Date(),
      completedAt: null,
      createdById: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const fire = (task: TaskRecord) =>
      handler({
        task,
        signal: new AbortController().signal,
        reportProgress: () => undefined,
        log: () => undefined,
      });
    const audits = async (action: string) => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      return db.auditLog.findMany({ where: { action } });
    };
    const jobCount = () => db.scheduledJob.count();
    /**
     * A `scheduled-job.update` audit row as `updateJob` wrote it BEFORE #1235:
     * `changes` only, no `webhookBinding`.
     */
    const legacyEdit = (jobId: string, actorId: string | null, changes: string[]) =>
      db.auditLog.create({
        data: {
          actorId,
          action: "scheduled-job.update",
          targetType: "scheduled-job",
          targetId: jobId,
          metadata: JSON.stringify({ changes }),
        },
      });
    /** Run the job through `POST /:id/run` and the real queue; the finished task row. */
    const runToEnd = async (jobId: string, who: Who) => {
      const run = await post(`/api/scheduler/${jobId}/run`, who);
      expect(run.status).toBe(202);
      const taskId = run.body.data.taskId as string;
      return vi.waitFor(
        async () => {
          const t = await db.task.findUniqueOrThrow({ where: { id: taskId } });
          expect(["completed", "failed"]).toContain(t.status);
          return t;
        },
        { timeout: 10_000, interval: 50 },
      );
    };
    const refusalReasons = async (jobId: string) =>
      (await audits("scheduler.webhook.secret_refused"))
        .filter((r) => r.targetId === jobId)
        .map((r) => JSON.parse(r.metadata ?? "{}").reason as string);
    const setRole = async (userId: string, roleKey: RoleKey) => {
      const role = await db.role.findUniqueOrThrow({ where: { key: roleKey } });
      await db.userRole.deleteMany({ where: { userId } });
      await db.userRole.create({ data: { userId, roleId: role.id } });
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1235-webhook-secret-scope");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      __resetVaultSingleton();
      for (const id of Object.keys(USERS)) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      // Fire time reads the job author's CURRENT role from the database.
      for (const roleKey of ["admin", "coordinator"] as const) {
        const role = await db.role.create({ data: { key: roleKey, name: roleKey } });
        for (const [userId, u] of Object.entries(USERS)) {
          if (u.role === roleKey) await db.userRole.create({ data: { userId, roleId: role.id } });
        }
      }
      for (const ws of [WS_A, WS_B]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      for (const [userId, u] of Object.entries(USERS)) {
        if (u.ws) {
          await db.workspaceMember.create({ data: { workspaceId: u.ws, userId, role: "member" } });
        }
      }
      for (const [id, ws, by] of [
        [PA, WS_A, "cora"],
        [PA2, WS_A, "cora"],
        [PB, WS_B, "bea"],
      ] as const) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById: by, workspaceId: ws },
        });
      }

      const vault = getVaultService();
      B_SECRET = (
        await vault.create(B_LABEL, "fake-b-token-value", "global", { createdById: "bea" })
      ).id;
      CORA_SECRET = (
        await vault.create("cora-hook-token-1235", "fake-cora-value", "global", {
          createdById: "cora",
        })
      ).id;
      COLE_SECRET = (
        await vault.create("cole-hook-token-1235", "fake-cole-value", "global", {
          createdById: "cole",
        })
      ).id;
      ADMIN_SECRET = (
        await vault.create("ada-hook-token-1235", "fake-admin-value", "global", {
          createdById: "ada",
        })
      ).id;

      __resetSchedulerBootstrap();
      shutdown = bootstrapScheduler({ handlerOverrides: { httpWebhookHandler: handler } }).shutdown;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      await shutdown?.();
      __resetSchedulerBootstrap();
      __resetVaultSingleton();
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => fetchSpy.mockClear());

    // ── Create ──────────────────────────────────────────────────────────────

    describe("POST /api/scheduler — create", () => {
      it("a coordinator in workspace A cannot name workspace B's secret, by id or by label", async () => {
        const before = await jobCount();
        for (const body of [B_SECRET, B_LABEL, `global:${B_LABEL}`]) {
          const res = await post("/api/scheduler", "cora", jobBody(PA, ref(body)));
          expect(res.status).toBe(403);
          expect(res.body.error.code).toBe(FORBIDDEN);
          expect(JSON.stringify(res.body)).not.toContain(B_LABEL);
          expect(JSON.stringify(res.body)).not.toContain(B_SECRET);
        }
        expect(await jobCount()).toBe(before);
        const refused = (await audits("vault.binding_refused")).filter(
          (r) => r.actorId === "cora" && r.targetType === "scheduled-job",
        );
        expect(refused.length).toBeGreaterThanOrEqual(3);
      });

      it("refuses a secret that does not exist exactly as it refuses a foreign one", async () => {
        const foreign = await post("/api/scheduler", "cora", jobBody(PA, ref(B_SECRET)));
        const missing = await post("/api/scheduler", "cora", jobBody(PA, ref("no-such-secret")));
        expect(missing.status).toBe(foreign.status);
        expect(missing.body).toEqual(foreign.body);
      });

      it("a coordinator may name a secret they created, and a literal header needs no check", async () => {
        const own = await post("/api/scheduler", "cora", jobBody(PA, ref(CORA_SECRET)));
        expect(own.status).toBe(201);
        const literal = await post("/api/scheduler", "cora", jobBody(PA, "Bearer fake-literal"));
        expect(literal.status).toBe(201);
      });

      it("a coordinator in workspace A cannot place a job in workspace B's project at all", async () => {
        const res = await post("/api/scheduler", "cora", jobBody(PB, ref(CORA_SECRET)));
        expect(res.status).toBe(404);
      });
    });

    // ── Update ──────────────────────────────────────────────────────────────

    describe("PATCH /api/scheduler/:id — update", () => {
      it("cannot swap a job's authHeader to a secret the coordinator did not create", async () => {
        const created = await post("/api/scheduler", "cora", jobBody(PA, ref(CORA_SECRET)));
        expect(created.status).toBe(201);
        const id = created.body.data.id as string;
        const res = await patch(`/api/scheduler/${id}`, "cora", {
          payload: webhook(ref(B_SECRET)),
        });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe(FORBIDDEN);
        const row = await db.scheduledJob.findUniqueOrThrow({ where: { id } });
        expect(row.payload).toContain(CORA_SECRET);
        expect(row.payload).not.toContain(B_SECRET);
      });

      it("cannot move a job holding someone else's secret — new URL, or new project with the authHeader untouched", async () => {
        // Ada (admin) may send her own secret anywhere; Cora may not move it.
        const seeded = await post("/api/scheduler", "ada", jobBody(PA, ref(ADMIN_SECRET)));
        expect(seeded.status).toBe(201);
        const id = seeded.body.data.id as string;

        const newUrl = await patch(`/api/scheduler/${id}`, "cora", {
          payload: webhook(ref(ADMIN_SECRET), "http://attacker.example.test/collect"),
        });
        expect(newUrl.status).toBe(403);
        expect(newUrl.body.error.code).toBe(FORBIDDEN);

        const newProject = await patch(`/api/scheduler/${id}`, "cora", { projectId: PA2 });
        expect(newProject.status).toBe(403);
        expect(newProject.body.error.code).toBe(FORBIDDEN);

        const row = await db.scheduledJob.findUniqueOrThrow({ where: { id } });
        expect(row.projectId).toBe(PA);
        expect(row.payload).toContain(`http://${HOST}/in`);

        // Nothing moves: a rename or a pause of the same job is not a new binding.
        expect((await patch(`/api/scheduler/${id}`, "cora", { name: "renamed" })).status).toBe(200);
        expect((await post(`/api/scheduler/${id}/pause`, "cora")).status).toBe(200);
      });

      it("cannot turn a job of another type into a webhook that sends B's secret", async () => {
        const created = await post("/api/scheduler", "cora", {
          ...jobBody(PA, ref(B_SECRET)),
          taskType: "rerun-analysis",
        });
        // Not a webhook, so nothing is sent and nothing is judged yet.
        expect(created.status).toBe(201);
        const id = created.body.data.id as string;
        const res = await patch(`/api/scheduler/${id}`, "cora", { taskType: "http-webhook" });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe(FORBIDDEN);
        const row = await db.scheduledJob.findUniqueOrThrow({ where: { id } });
        expect(row.taskType).toBe("rerun-analysis");
      });

      it("a coordinator may move a job that names their own secret", async () => {
        const created = await post("/api/scheduler", "cora", jobBody(PA, ref(CORA_SECRET)));
        const id = created.body.data.id as string;
        const res = await patch(`/api/scheduler/${id}`, "cora", { projectId: PA2 });
        expect(res.status).toBe(200);
        expect(res.body.data.projectId).toBe(PA2);
      });
    });

    // ── Fire time ───────────────────────────────────────────────────────────

    describe("fire time — the handler re-checks before it reads the vault", () => {
      it("a job saved before the fix that names B's secret fails closed: no request, a clear error on the task run", async () => {
        const job = await legacyJob("cora", PA, ref(B_SECRET));
        const run = await post(`/api/scheduler/${job.id}/run`, "cora");
        expect(run.status).toBe(202);
        const taskId = run.body.data.taskId as string;
        const task = await vi.waitFor(
          async () => {
            const t = await db.task.findUniqueOrThrow({ where: { id: taskId } });
            expect(t.status).toBe("failed");
            return t;
          },
          { timeout: 10_000, interval: 50 },
        );
        expect(task.errorMessage).toBe(WEBHOOK_SECRET_REFUSED_MESSAGE);
        expect(task.errorMessage).not.toContain(B_SECRET);
        expect(task.errorMessage).not.toContain("fake-b-token-value");
        expect(fetchSpy).not.toHaveBeenCalled();
        const refused = (await audits("scheduler.webhook.secret_refused")).filter(
          (r) => r.targetId === job.id,
        );
        expect(refused).toHaveLength(1);
        expect(refused[0].metadata).toContain("secret_not_owned");
      });

      it("a job naming its author's own secret fires, sending that secret to the job's URL", async () => {
        const job = await legacyJob("cora", PA, ref(CORA_SECRET));
        await expect(fire(taskFor(job.id, PA, ref(CORA_SECRET)))).resolves.toMatchObject({
          status: 204,
        });
        expect(fetchSpy).toHaveBeenCalledOnce();
        const [url, init] = fetchSpy.mock.calls[0] as [string, { headers: Record<string, string> }];
        expect(url).toBe(`http://${HOST}/in`);
        expect(init.headers.authorization).toBe("fake-cora-value");
      });

      it("an admin-authored job naming the admin's secret still fires", async () => {
        const job = await legacyJob("ada", PA, ref(ADMIN_SECRET));
        await expect(fire(taskFor(job.id, PA, ref(ADMIN_SECRET)))).resolves.toMatchObject({
          status: 204,
        });
        expect(fetchSpy).toHaveBeenCalledOnce();
      });

      it("refuses once the author no longer reaches the job's project", async () => {
        const job = await legacyJob("cole", PA, ref(COLE_SECRET));
        await db.workspaceMember.deleteMany({ where: { workspaceId: WS_A, userId: "cole" } });
        try {
          await expect(fire(taskFor(job.id, PA, ref(COLE_SECRET)))).rejects.toThrow(
            WEBHOOK_SECRET_REFUSED_MESSAGE,
          );
          expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
          await db.workspaceMember.create({
            data: { workspaceId: WS_A, userId: "cole", role: "member" },
          });
        }
      });

      it("refuses a task with no job, a deleted job, an authorless job, an unknown or ambiguous reference", async () => {
        const deleted = await legacyJob("cora", PA, ref(CORA_SECRET));
        await db.scheduledJob.update({
          where: { id: deleted.id },
          data: { deletedAt: new Date() },
        });
        const authorless = await legacyJob(null, PA, ref(CORA_SECRET));
        const unknown = await legacyJob("cora", PA, ref("no-such-secret"));
        const vault = getVaultService();
        await vault.create("dup-1235", "fake-dup-1", "global", { createdById: "cora" });
        await vault.create("dup-1235", "fake-dup-2", "project", { createdById: "cora" });
        const ambiguous = await legacyJob("cora", PA, ref("dup-1235"));

        for (const task of [
          taskFor(null, PA, ref(CORA_SECRET)),
          taskFor(deleted.id, PA, ref(CORA_SECRET)),
          taskFor("no-such-job", PA, ref(CORA_SECRET)),
          taskFor(authorless.id, PA, ref(CORA_SECRET)),
          taskFor(unknown.id, PA, ref("no-such-secret")),
          taskFor(ambiguous.id, PA, ref("dup-1235")),
        ]) {
          await expect(fire(task)).rejects.toThrow(WEBHOOK_SECRET_REFUSED_MESSAGE);
        }
        expect(fetchSpy).not.toHaveBeenCalled();
      });

      it("refuses a label two different creators share, and audits it as unresolved", async () => {
        const vault = getVaultService();
        await vault.create("shared-1235", "fake-shared-cora", "global", { createdById: "cora" });
        await vault.create("shared-1235", "fake-shared-bea", "project", { createdById: "bea" });
        // Authored by an admin, so ownership cannot be what refuses it.
        const job = await legacyJob("ada", PA, ref("shared-1235"));
        await expect(fire(taskFor(job.id, PA, ref("shared-1235")))).rejects.toThrow(
          WEBHOOK_SECRET_REFUSED_MESSAGE,
        );
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(await refusalReasons(job.id)).toEqual(["unresolved_reference"]);
      });
    });

    // ── Fire time: whose authority the binding rests on ─────────────────────

    describe("fire time — every principal who set the job's binding is judged", () => {
      it("an admin-authored job a coordinator retargeted or re-keyed before the fix is refused: no request", async () => {
        const tampers = [
          // URL moved, on the allow-listed host so the host check cannot be what refuses it.
          { header: ref(ADMIN_SECRET), url: `http://${HOST}/cora-collects` },
          // authHeader swapped to a secret the coordinator could never name.
          { header: ref(B_SECRET), url: `http://${HOST}/in` },
        ];
        for (const { header, url } of tampers) {
          const job = await legacyJob("ada", PA, ref(ADMIN_SECRET));
          // What a pre-#1235 PATCH by Cora left behind: the row, and its audit.
          await db.scheduledJob.update({
            where: { id: job.id },
            data: { payload: JSON.stringify(webhook(header, url)) },
          });
          await legacyEdit(job.id, "cora", ["payload"]);

          const task = await runToEnd(job.id, "cora");
          expect(task.status).toBe("failed");
          expect(task.errorMessage).toBe(WEBHOOK_SECRET_REFUSED_MESSAGE);
          expect(fetchSpy).not.toHaveBeenCalled();
          expect(await refusalReasons(job.id)).toEqual(["secret_not_owned"]);
        }
      });

      it("pre-fix edits by the author, and pauses by anyone, do not count against the job", async () => {
        const job = await legacyJob("ada", PA, ref(B_SECRET));
        await legacyEdit(job.id, "ada", ["payload"]);
        await legacyEdit(job.id, "cora", ["enabled"]);
        await expect(fire(taskFor(job.id, PA, ref(B_SECRET)))).resolves.toMatchObject({
          status: 204,
        });
        expect(fetchSpy).toHaveBeenCalledOnce();
      });

      it("a binding write after the fix supersedes a pre-fix tamper; a later rename does not; a task of the old binding stays refused", async () => {
        const collects = `http://${HOST}/cora-collects`;
        const checked = `http://${HOST}/ada-checked`;
        const job = await legacyJob("ada", PA, ref(ADMIN_SECRET));
        await db.scheduledJob.update({
          where: { id: job.id },
          data: { payload: JSON.stringify(webhook(ref(ADMIN_SECRET), collects)) },
        });
        await legacyEdit(job.id, "cora", ["payload"]);
        const stale = taskFor(job.id, PA, ref(ADMIN_SECRET), collects);
        await expect(fire(stale)).rejects.toThrow(WEBHOOK_SECRET_REFUSED_MESSAGE);
        // Ada re-points it: she is now the binder, judged on the whole binding.
        const rebound = await patch(`/api/scheduler/${job.id}`, "ada", {
          payload: webhook(ref(ADMIN_SECRET), checked),
        });
        expect(rebound.status).toBe(200);
        expect((await patch(`/api/scheduler/${job.id}`, "cora", { name: "renamed" })).status).toBe(
          200,
        );
        // A task carrying the binding Ada replaced is not sent on her standing.
        await expect(fire(stale)).rejects.toThrow(WEBHOOK_SECRET_REFUSED_MESSAGE);
        expect(fetchSpy).not.toHaveBeenCalled();
        // A task of the job as it is now is sent, to the URL Ada chose.
        await expect(fire(taskFor(job.id, PA, ref(ADMIN_SECRET), checked))).resolves.toMatchObject({
          status: 204,
        });
        expect(fetchSpy).toHaveBeenCalledOnce();
        expect(fetchSpy.mock.calls[0][0]).toBe(checked);
        expect(await refusalReasons(job.id)).toEqual(["secret_not_owned", "binding_stale"]);
      });

      it("a task enqueued before a rebind, retried by a coordinator through the retry route, is refused: no request", async () => {
        const collects = `http://${HOST}/cora-collects`;
        const job = await legacyJob("ada", PA, ref(ADMIN_SECRET));
        // Before the fix Cora retargeted Ada's job at her own endpoint …
        await db.scheduledJob.update({
          where: { id: job.id },
          data: { payload: JSON.stringify(webhook(ref(ADMIN_SECRET), collects)) },
        });
        await legacyEdit(job.id, "cora", ["payload"]);
        // … and a run of it failed, so the task stays retryable for 7 days.
        const failed = await runToEnd(job.id, "cora");
        expect(failed.status).toBe("failed");
        expect(JSON.parse(failed.payload).url).toBe(collects);
        // Ada repairs the job: the URL back, and she is its binder.
        const repaired = await patch(`/api/scheduler/${job.id}`, "ada", {
          payload: webhook(ref(ADMIN_SECRET)),
        });
        expect(repaired.status).toBe(200);
        fetchSpy.mockClear();

        const retry = await post(`/api/tasks/${failed.id}/retry`, "cora");
        expect(retry.status).toBe(202);
        const retriedId = retry.body.data.taskId as string;
        const retried = await vi.waitFor(
          async () => {
            const t = await db.task.findUniqueOrThrow({ where: { id: retriedId } });
            expect(["completed", "failed"]).toContain(t.status);
            return t;
          },
          { timeout: 10_000, interval: 50 },
        );
        expect(retried.status).toBe("failed");
        expect(retried.errorMessage).toBe(WEBHOOK_SECRET_REFUSED_MESSAGE);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(await refusalReasons(job.id)).toEqual(["secret_not_owned", "binding_stale"]);

        // The repaired job itself still runs, to the URL Ada set.
        const fresh = await runToEnd(job.id, "cora");
        expect(fresh.status).toBe("completed");
        expect(fetchSpy).toHaveBeenCalledOnce();
        expect(fetchSpy.mock.calls[0][0]).toBe(`http://${HOST}/in`);
      });

      it("the binder is kept on the job: a lost audit row cannot hand the binding to an earlier binder", async () => {
        const vault = getVaultService();
        const own = (
          await vault.create("cora-n2-token-1235", "fake-cora-n2-value", "global", {
            createdById: "cora",
          })
        ).id;
        // Ada (admin) binds the job first …
        const seeded = await post("/api/scheduler", "ada", jobBody(PA, ref(ADMIN_SECRET)));
        expect(seeded.status).toBe(201);
        const id = seeded.body.data.id as string;
        // … then Cora binds her OWN secret at her own URL: allowed, she is the binder.
        const rebound = await patch(`/api/scheduler/${id}`, "cora", {
          payload: webhook(ref(own), `http://${HOST}/cora-own`),
        });
        expect(rebound.status).toBe(200);
        // Her audit row is lost (an insert failing after the update committed).
        await audits("scheduled-job.update");
        const lost = await db.auditLog.deleteMany({
          where: { action: "scheduled-job.update", targetId: id, actorId: "cora" },
        });
        expect(lost.count).toBe(1);
        // An admin's "Rotate anyway" moves the secret to Ada (#502).
        await db.secret.update({ where: { id: own }, data: { createdById: "ada" } });

        // Judged on Cora, who no longer owns it: refused, nothing sent to her URL.
        const task = await runToEnd(id, "cora");
        expect(task.status).toBe("failed");
        expect(task.errorMessage).toBe(WEBHOOK_SECRET_REFUSED_MESSAGE);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(await refusalReasons(id)).toEqual(["secret_not_owned"]);
      });

      it("a coordinator who edits another's job to send their OWN secret is the binder: write and fire agree", async () => {
        const created = await post("/api/scheduler", "cora", jobBody(PA, ref(CORA_SECRET)));
        expect(created.status).toBe(201);
        const id = created.body.data.id as string;
        // Cole may not take Cora's secret …
        const foreign = await patch(`/api/scheduler/${id}`, "cole", {
          payload: webhook(ref(CORA_SECRET), `http://${HOST}/cole`),
        });
        expect(foreign.status).toBe(403);
        // … but may bind his own, and then it is sent: it rests on Cole, not Cora.
        const own = await patch(`/api/scheduler/${id}`, "cole", {
          payload: webhook(ref(COLE_SECRET)),
        });
        expect(own.status).toBe(200);
        await audits("scheduled-job.update");
        const task = await runToEnd(id, "cole");
        expect(task.status).toBe("completed");
        expect(fetchSpy).toHaveBeenCalledOnce();
        const [, init] = fetchSpy.mock.calls[0] as [string, { headers: Record<string, string> }];
        expect(init.headers.authorization).toBe("fake-cole-value");
      });

      it("re-pointing a reference at the same secret by another name is a binding write too", async () => {
        const seeded = await post("/api/scheduler", "ada", jobBody(PA, ref(ADMIN_SECRET)));
        expect(seeded.status).toBe(201);
        // Same row, by label instead of id: Cora would become its binder, and she
        // may not bind Ada's secret, so it is refused now rather than on every run.
        const res = await patch(`/api/scheduler/${seeded.body.data.id as string}`, "cora", {
          payload: webhook(ref("ada-hook-token-1235")),
        });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe(FORBIDDEN);
      });
    });

    // ── Fire time: the principal's CURRENT standing ─────────────────────────

    describe("fire time — judged at the principal's current role and status", () => {
      it("an admin-authored job naming another user's secret fires; once the admin is demoted it is refused", async () => {
        const ada = await legacyJob("ada", PA, ref(B_SECRET));
        await expect(fire(taskFor(ada.id, PA, ref(B_SECRET)))).resolves.toMatchObject({
          status: 204,
        });
        const [, init] = fetchSpy.mock.calls[0] as [string, { headers: Record<string, string> }];
        expect(init.headers.authorization).toBe("fake-b-token-value");
        fetchSpy.mockClear();

        const job = await legacyJob("dora", PA, ref(B_SECRET));
        await expect(fire(taskFor(job.id, PA, ref(B_SECRET)))).resolves.toMatchObject({
          status: 204,
        });
        fetchSpy.mockClear();
        await setRole("dora", "coordinator");
        try {
          await expect(fire(taskFor(job.id, PA, ref(B_SECRET)))).rejects.toThrow(
            WEBHOOK_SECRET_REFUSED_MESSAGE,
          );
          expect(fetchSpy).not.toHaveBeenCalled();
          // Dora still reaches PA as a workspace member: ownership is what refuses it.
          expect(await refusalReasons(job.id)).toEqual(["secret_not_owned"]);
        } finally {
          await setRole("dora", "admin");
        }
      });

      it("a deprovisioned admin's job is refused — disabled, or soft-deleted", async () => {
        const job = await legacyJob("ed", PA, ref(B_SECRET));
        await expect(fire(taskFor(job.id, PA, ref(B_SECRET)))).resolves.toMatchObject({
          status: 204,
        });
        fetchSpy.mockClear();
        for (const data of [{ status: "disabled" }, { deletedAt: new Date() }]) {
          await db.user.update({ where: { id: "ed" }, data });
          try {
            await expect(fire(taskFor(job.id, PA, ref(B_SECRET)))).rejects.toThrow(
              WEBHOOK_SECRET_REFUSED_MESSAGE,
            );
          } finally {
            await db.user.update({
              where: { id: "ed" },
              data: { status: "active", deletedAt: null },
            });
          }
        }
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(await refusalReasons(job.id)).toEqual(["principal_inactive", "principal_inactive"]);
      });
    });

    // ── Write time agrees with fire time on resolution ──────────────────────

    describe("write time — a reference must resolve to exactly one live secret", () => {
      it("refuses a label reaching two of the caller's own secrets, with the foreign-secret body", async () => {
        const vault = getVaultService();
        await vault.create("cora-twice-1235", "fake-twice-1", "global", { createdById: "cora" });
        await vault.create("cora-twice-1235", "fake-twice-2", "project", { createdById: "cora" });
        const foreign = await post("/api/scheduler", "cora", jobBody(PA, ref(B_SECRET)));
        const before = await jobCount();
        const twice = await post("/api/scheduler", "cora", jobBody(PA, ref("cora-twice-1235")));
        expect(twice.status).toBe(403);
        expect(twice.body).toEqual(foreign.body);
        // The same for an admin, who skips the ownership rule but not resolution.
        const admin = await post("/api/scheduler", "ada", jobBody(PA, ref("cora-twice-1235")));
        expect(admin.status).toBe(403);
        expect(admin.body).toEqual(foreign.body);
        expect(await jobCount()).toBe(before);
        const refused = (await audits("vault.binding_refused")).filter((r) =>
          (r.metadata ?? "").includes("unresolved_reference"),
        );
        expect(refused.map((r) => r.actorId).sort()).toEqual(["ada", "cora"]);
      });
    });
  },
);
