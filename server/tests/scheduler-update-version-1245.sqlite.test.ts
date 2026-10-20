/**
 * #1245 — a scheduled-job edit cannot silently undo a concurrent one.
 *
 * `updateJob` read the row, judged it, then wrote EVERY field from that read.
 * An edit racing a webhook rebind wrote the old URL and `authHeader` back, so a
 * rename could undo the rebind. Now every write is conditional on the job's
 * `version`, which each update bumps: a write whose read is stale answers 409
 * JOB_VERSION_CONFLICT and writes nothing. A client may also send the version
 * it loaded as `expectedVersion`; a stale one is refused the same way. A
 * request without it is judged against the server's own read, as before.
 *
 * Cora and Cole are coordinators (non-admin) in the job's workspace; an admin
 * bypasses the access check, so nobody here is one. Real SQLite built by the
 * migration chain, real routers, real JWTs, real vault, real scheduler.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole, type AuthPayload } from "@metis/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

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

const { schedulerRouter } = await import("../src/routes/scheduler.js");
const { bootstrapScheduler, getSchedulerBootstrap, __resetSchedulerBootstrap } =
  await import("../src/lib/scheduler/index.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { getVaultService, __resetVaultSingleton } =
  await import("../src/lib/vault/vault-service.js");
const { getAuditService } = await import("../src/lib/audit/audit-service.js");

const WS = "ws-1245";
const PA = "proj-a-1245";
const HOST = "hooks.example.test";
const USERS = ["cora", "cole"] as const;
type Who = (typeof USERS)[number];
const actorOf = (who: Who) => ({ id: who, role: "coordinator" as const });

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1245 — a scheduled-job update is conditional on the version it read",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let shutdown: (() => Promise<void>) | undefined;
    let CORA_SECRET = "";
    /** Runs once, right after `updateJob`'s next read of a job: the race window. */
    let afterNextJobRead: (() => Promise<void>) | null = null;

    const bearer = (who: Who) => {
      const payload: AuthPayload = {
        userId: who,
        username: who,
        role: "coordinator",
        permissions: getPermissionsForRole("coordinator"),
        workspaces: [WS],
      };
      return `Bearer ${issueTokens(payload).accessToken}`;
    };
    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/scheduler", schedulerRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const patch = (id: string, who: Who, body: object) =>
      request(app()).patch(`/api/scheduler/${id}`).set("Authorization", bearer(who)).send(body);

    const hook = (path: string) => ({
      url: `http://${HOST}${path}`,
      authHeader: `\${vault:${CORA_SECRET}}`,
      body: { hello: "world" },
    });
    let seq = 0;
    const createJob = async () => {
      const res = await request(app())
        .post("/api/scheduler")
        .set("Authorization", bearer("cora"))
        .send({
          key: `hook-1245-${++seq}`,
          name: "Ledger hook",
          cron: "0 3 * * *",
          taskType: "http-webhook",
          projectId: PA,
          enabled: false,
          maxAttempts: 1,
          payload: hook("/old"),
        });
      expect(res.status).toBe(201);
      return res.body.data as { id: string; version: number };
    };
    const jobRow = (id: string) => db.scheduledJob.findUniqueOrThrow({ where: { id } });
    const urlOf = async (id: string) =>
      (JSON.parse((await jobRow(id)).payload) as { url: string }).url;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1245-scheduler-update-version");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      // The real client, with one seam: a callback run right after `updateJob`
      // reads the job, so a test can land a concurrent write in that window.
      state.db = new Proxy(db, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver) as unknown;
          if (prop !== "scheduledJob") {
            return typeof value === "function" ? value.bind(target) : value;
          }
          const model = value as PrismaClient["scheduledJob"];
          return new Proxy(model, {
            get(m, p) {
              if (p === "findUnique") {
                return async (args: Parameters<typeof m.findUnique>[0]) => {
                  const row = await m.findUnique(args);
                  const run = afterNextJobRead;
                  afterNextJobRead = null;
                  if (run) await run();
                  return row;
                };
              }
              const v = Reflect.get(m, p) as unknown;
              return typeof v === "function" ? v.bind(m) : v;
            },
          });
        },
      });
      __resetVaultSingleton();
      const role = await db.role.create({ data: { key: "coordinator", name: "coordinator" } });
      await db.workspace.create({ data: { id: WS, name: WS, slug: WS } });
      for (const id of USERS) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
        await db.userRole.create({ data: { userId: id, roleId: role.id } });
        await db.workspaceMember.create({ data: { workspaceId: WS, userId: id, role: "member" } });
      }
      await db.project.create({
        data: { id: PA, name: PA, slug: PA, createdById: "cora", workspaceId: WS },
      });
      CORA_SECRET = (
        await getVaultService().create("cora-hook-token-1245", "fake-cora-value", "global", {
          createdById: "cora",
        })
      ).id;
      __resetSchedulerBootstrap();
      shutdown = bootstrapScheduler({
        handlerOverrides: { httpWebhookHandler: async () => ({}) },
      }).shutdown;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      await shutdown?.();
      __resetSchedulerBootstrap();
      __resetVaultSingleton();
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("a new job starts at version 0, and every update bumps it", async () => {
      const job = await createJob();
      expect(job.version).toBe(0);
      const renamed = await patch(job.id, "cole", { name: "Renamed" });
      expect(renamed.status).toBe(200);
      expect(renamed.body.data.version).toBe(1);
      const paused = await request(app())
        .post(`/api/scheduler/${job.id}/pause`)
        .set("Authorization", bearer("cole"));
      expect(paused.status).toBe(200);
      expect(paused.body.data.version).toBe(2);
    });

    it("a rename racing a webhook rebind answers 409 and the rebind survives", async () => {
      const job = await createJob();
      // Cole's rename reads the job; before it writes, Cora's rebind lands.
      afterNextJobRead = async () => {
        await getSchedulerBootstrap().scheduler.updateJob(
          job.id,
          { payload: hook("/new") },
          actorOf("cora"),
        );
      };
      const res = await patch(job.id, "cole", { name: "Renamed by Cole" });
      expect(afterNextJobRead).toBeNull();
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("JOB_VERSION_CONFLICT");

      const row = await jobRow(job.id);
      expect(await urlOf(job.id)).toBe(`http://${HOST}/new`);
      expect(row.webhookBinderId).toBe("cora");
      expect(row.name).toBe("Ledger hook");
      expect(row.version).toBe(1);
    });

    it("a stale expectedVersion from a form loaded before the rebind answers 409 and writes nothing", async () => {
      const job = await createJob();
      const rebind = await patch(job.id, "cora", { payload: hook("/new"), expectedVersion: 0 });
      expect(rebind.status).toBe(200);
      expect(rebind.body.data.version).toBe(1);

      // Cole's form still holds version 0 and the old payload.
      const stale = await patch(job.id, "cole", {
        name: "Renamed by Cole",
        payload: hook("/old"),
        expectedVersion: 0,
      });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe("JOB_VERSION_CONFLICT");
      expect(stale.body.error.message).toMatch(/changed .* since you loaded it/);
      expect(await urlOf(job.id)).toBe(`http://${HOST}/new`);
      expect((await jobRow(job.id)).name).toBe("Ledger hook");

      // With the version he reloaded, the same edit goes through.
      const fresh = await patch(job.id, "cole", { name: "Renamed by Cole", expectedVersion: 1 });
      expect(fresh.status).toBe(200);
      expect(fresh.body.data.version).toBe(2);
      expect(await urlOf(job.id)).toBe(`http://${HOST}/new`);
    });

    it("a request without expectedVersion is still accepted (existing API clients)", async () => {
      const job = await createJob();
      await patch(job.id, "cora", { name: "One" });
      const res = await patch(job.id, "cole", { name: "Two" });
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe("Two");
      expect(res.body.data.version).toBe(2);
    });

    it("the version check runs after the access check: a stranger to the project gets the 404, never the 409", async () => {
      const job = await createJob();
      await db.user.create({
        data: { id: "stray", username: "stray", displayName: "stray", email: "stray@x.test" },
      });
      const token = issueTokens({
        userId: "stray",
        username: "stray",
        role: "coordinator",
        permissions: getPermissionsForRole("coordinator"),
        workspaces: [],
      }).accessToken;
      const res = await request(app())
        .patch(`/api/scheduler/${job.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "x", expectedVersion: 99 });
      expect(res.status).toBe(404);
    });

    it("a job deleted between the read and the write answers 404, not 409", async () => {
      const job = await createJob();
      afterNextJobRead = async () => {
        await db.scheduledJob.update({ where: { id: job.id }, data: { deletedAt: new Date() } });
      };
      const res = await patch(job.id, "cole", { name: "Too late" });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("JOB_NOT_FOUND");
    });

    it("rejects a malformed expectedVersion", async () => {
      const job = await createJob();
      for (const expectedVersion of [-1, 1.5, "1"]) {
        const res = await patch(job.id, "cole", { name: "x", expectedVersion });
        expect(res.status, String(expectedVersion)).toBe(400);
      }
    });
  },
);
