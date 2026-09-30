/**
 * #574 — `POST /api/tasks/:id/retry` through the real `TaskQueue.retry`.
 *
 * Real SQLite built by the migration chain, the real tasks router, the real
 * scheduler bootstrap with its Prisma-backed task store. The only stubs are the
 * two task handlers, so an accepted retry runs without doing any work. Every
 * assertion reads the Task rows back from the database.
 *
 * The retry window bounds `http-webhook` Tasks alone — the one type whose
 * payload names a vault secret. Every other type stays retryable however long
 * ago it ended.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import express from "express";
import request from "supertest";
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

const { tasksRouter } = await import("../src/routes/tasks.js");
const { bootstrapScheduler, __resetSchedulerBootstrap } =
  await import("../src/lib/scheduler/index.js");
const { TASK_RETRY_WINDOW_MS, VAULT_REFERENCING_TASK_TYPE } =
  await import("../src/lib/scheduler/task-retry-window.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const ADMIN = "admin-574-retry";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#574 — POST /api/tasks/:id/retry bounds only webhook Tasks (real SQLite, real TaskQueue)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let token = "";
    let shutdown: (() => Promise<void>) | undefined;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/tasks", tasksRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const retry = (id: string) =>
      request(app()).post(`/api/tasks/${id}/retry`).set("Authorization", `Bearer ${token}`);

    /** A failed Task of `type` that ended `agoMs` ago. */
    async function failedTask(type: string, agoMs: number) {
      const ended = new Date(Date.now() - agoMs);
      return db.task.create({
        data: {
          type,
          status: "failed",
          payload: JSON.stringify({ projectId: "p1" }),
          errorMessage: "boom",
          maxAttempts: 1,
          completedAt: ended,
          createdAt: ended,
        },
      });
    }
    const retriesOf = () => db.task.count({ where: { trigger: "retry" } });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("574-task-retry");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: ADMIN, username: ADMIN, displayName: ADMIN, email: `${ADMIN}@x.test` },
      });
      await db.project.create({ data: { id: "p1", name: "P", slug: "p1", createdById: ADMIN } });
      __resetSchedulerBootstrap();
      shutdown = bootstrapScheduler({
        handlerOverrides: {
          httpWebhookHandler: async () => ({}),
          rerunAnalysis: async () => ({}),
        },
      }).shutdown;
      token = issueTokens({
        userId: ADMIN,
        username: ADMIN,
        role: "admin",
        permissions: [],
        workspaces: [],
      }).accessToken;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await shutdown?.();
      __resetSchedulerBootstrap();
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("an http-webhook Task that ended before the window is refused with 409, and nothing is enqueued", async () => {
      const t = await failedTask(VAULT_REFERENCING_TASK_TYPE, TASK_RETRY_WINDOW_MS + 60_000);
      const before = await retriesOf();

      const res = await retry(t.id);

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error.code).toBe("TASK_RETRY_EXPIRED");
      expect(await retriesOf()).toBe(before);
    });

    it("an http-webhook Task that ended inside the window is retried with 202", async () => {
      const t = await failedTask(VAULT_REFERENCING_TASK_TYPE, TASK_RETRY_WINDOW_MS - 60_000);

      const res = await retry(t.id);

      expect(res.status, JSON.stringify(res.body)).toBe(202);
      const row = await db.task.findUniqueOrThrow({ where: { id: res.body.data.taskId } });
      expect(row.trigger).toBe("retry");
      expect(row.type).toBe(VAULT_REFERENCING_TASK_TYPE);
    });

    it("a Task of another type that ended long before the window is still retried with 202", async () => {
      const t = await failedTask("rerun-analysis", 10 * TASK_RETRY_WINDOW_MS);

      const res = await retry(t.id);

      expect(res.status, JSON.stringify(res.body)).toBe(202);
      const row = await db.task.findUniqueOrThrow({ where: { id: res.body.data.taskId } });
      expect(row.trigger).toBe("retry");
      expect(row.type).toBe("rerun-analysis");
    });
  },
);
