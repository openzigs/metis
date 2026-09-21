/** Queue races against real SQLite writes, not an in-memory persistence model. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import type { TaskHandlerFn } from "../src/lib/scheduler/types.js";

const state = vi.hoisted(() => ({ db: null as PrismaClient | null }));
vi.mock("../src/lib/prisma.js", () => ({
  get prisma() {
    return state.db;
  },
}));
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
import { createPrismaTaskStore } from "../src/lib/scheduler/task-store.js";
import { TaskQueue } from "../src/lib/scheduler/task-queue.js";
import { InMemoryTaskHandlerRegistry } from "../src/lib/scheduler/task-handlers.js";
import { SCHEDULER_DEFAULTS } from "../src/lib/scheduler/config.js";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe.runIf(readGeneratedClientProvider() === "sqlite")(
  "durable task SQL transition races",
  () => {
    let db: PrismaClient;
    let peer: PrismaClient;
    let directory: string;
    const queues: TaskQueue[] = [];
    const releases: Array<() => void> = [];
    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "metis-task-races-"));
      const url = `file:${join(directory, "tasks.db")}`;
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
      peer = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
      state.db = db;
      await db.$executeRawUnsafe(
        `CREATE TABLE tasks (id TEXT PRIMARY KEY, scheduledJobId TEXT, projectId TEXT, type TEXT NOT NULL, trigger TEXT DEFAULT 'manual', status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 5, payload TEXT DEFAULT '{}', result TEXT, errorMessage TEXT, progress INTEGER, attempts INTEGER DEFAULT 0, maxAttempts INTEGER DEFAULT 3, scheduledFor DATETIME, startedAt DATETIME, completedAt DATETIME, createdById TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL)`,
      );
    });
    beforeEach(async () => {
      await db.task.deleteMany();
    });
    afterEach(async () => {
      releases.splice(0).forEach((release) => release());
      for (const queue of queues.splice(0)) {
        await queue.shutdown();
        await idle(queue);
      }
      vi.restoreAllMocks();
    });
    afterAll(async () => {
      await peer?.$disconnect();
      await db?.$disconnect();
      if (directory) await rm(directory, { recursive: true, force: true });
    });
    function setup(handler: TaskHandlerFn = async () => ({}), timeout = 30_000) {
      const store = createPrismaTaskStore();
      const registry = new InMemoryTaskHandlerRegistry();
      const run = vi.fn(handler);
      registry.register({ type: "publish-generated-document", description: "", handler: run });
      const emitter = { taskStatus: vi.fn(), taskProgress: vi.fn(), schedulerStatus: vi.fn() };
      const queue = new TaskQueue(store, registry, emitter, {
        ...SCHEDULER_DEFAULTS,
        concurrency: 1,
        retryBackoffMs: 1,
        retryBackoffMaxMs: 2,
        defaultTimeoutMs: timeout,
      });
      queues.push(queue);
      return { store, queue, run, emitter };
    }
    async function idle(queue: TaskQueue) {
      await vi.waitFor(() => expect(queue.snapshot()).toMatchObject({ running: 0, queueDepth: 0 }));
    }
    function pause(
      store: ReturnType<typeof createPrismaTaskStore>,
      method: "markRetrying" | "markRunning" | "markCompleted",
      afterWrite = false,
    ) {
      const entered = barrier();
      const resume = barrier();
      releases.push(resume.release);
      // The original store still performs every SQL operation; only its await is gated.
      async function gated<T>(write: () => Promise<T>): Promise<T> {
        if (afterWrite) {
          const result = await write();
          entered.release();
          await resume.promise;
          return result;
        }
        entered.release();
        await resume.promise;
        return write();
      }
      if (method === "markRunning") {
        const original = store.markRunning.bind(store);
        vi.spyOn(store, method).mockImplementationOnce((...args) => gated(() => original(...args)));
      } else if (method === "markRetrying") {
        const original = store.markRetrying.bind(store);
        vi.spyOn(store, method).mockImplementationOnce((...args) => gated(() => original(...args)));
      } else {
        const original = store.markCompleted.bind(store);
        vi.spyOn(store, method).mockImplementationOnce((...args) => gated(() => original(...args)));
      }
      return { entered: entered.promise, release: resume.release };
    }
    const input = { type: "publish-generated-document", maxAttempts: 2 };

    it.each([1, 2])(
      "a stale queue snapshot preserves attempts and the retry budget after %s peer attempts",
      async (priorAttempts) => {
        const attempts: number[] = [];
        const fail: TaskHandlerFn = async ({ task }) => {
          attempts.push(task.attempts);
          throw new Error("retry me");
        };
        const stale = setup(fail);
        const active = setup(fail);
        const staleClaim = pause(stale.store, "markRunning");
        const retryWritten = barrier();
        const finishRetry = barrier();
        releases.push(finishRetry.release);
        const markRetrying = active.store.markRetrying.bind(active.store);
        vi.spyOn(active.store, "markRetrying").mockImplementation(async (...args) => {
          const task = await markRetrying(...args);
          if (task.attempts === priorAttempts) {
            retryWritten.release();
            await finishRetry.promise;
          }
          return task;
        });
        const maxAttempts = priorAttempts + 1;
        const snapshot = await stale.queue.enqueue({ ...input, maxAttempts });
        await staleClaim.entered;
        expect(snapshot.attempts).toBe(0);

        // A retains its original pending snapshot while B really executes/retries
        // against another connection. Only the return from the last write is gated.
        state.db = peer;
        active.queue.resume(snapshot);
        await retryWritten.promise;
        expect(await peer.task.findUniqueOrThrow({ where: { id: snapshot.id } })).toMatchObject({
          status: "pending",
          attempts: priorAttempts,
        });
        await active.queue.shutdown();
        finishRetry.release();
        await idle(active.queue);
        state.db = db;

        staleClaim.release();
        await idle(stale.queue);
        expect.soft(attempts).toEqual(Array.from({ length: maxAttempts }, (_, index) => index + 1));
        expect.soft(stale.run).toHaveBeenCalledTimes(1);
        expect(await db.task.findUniqueOrThrow({ where: { id: snapshot.id } })).toMatchObject({
          status: "failed",
          attempts: maxAttempts,
        });
      },
    );

    it("a lost claim cannot dispatch another store's already-running task", async () => {
      const { store, queue, run } = setup();
      const gate = pause(store, "markRunning");
      const task = await queue.enqueue(input);
      await gate.entered;
      state.db = peer;
      try {
        expect(await createPrismaTaskStore().markRunning(task.id, 1, new Date())).toMatchObject({
          status: "running",
          attempts: 1,
        });
      } finally {
        state.db = db;
        gate.release();
      }
      await idle(queue);
      expect(run).not.toHaveBeenCalled();
      expect(await db.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
        status: "running",
        attempts: 1,
      });
    });

    it.each(["cancelled", "completed", "failed"])(
      "all late store transitions preserve terminal %s",
      async (status) => {
        const { store } = setup();
        const task = await store.create({ ...input, now: new Date() });
        await peer.task.update({
          where: { id: task.id },
          data: {
            status,
            completedAt: new Date(),
            result: '{"original":true}',
            errorMessage: "original",
            progress: 73,
          },
        });
        const before = await peer.task.findUniqueOrThrow({ where: { id: task.id } });
        expect(await store.markRunning(task.id, 2, new Date())).toBeNull();
        for (const result of [
          await store.markRetrying(task.id, "late retry", new Date()),
          await store.markCancelled(task.id, "late cancel", new Date()),
          await store.markCompleted(task.id, { late: true }, new Date()),
          await store.markFailed(task.id, "late failure", new Date()),
        ])
          expect(result.status).toBe(status);
        await store.updateProgress(task.id, 99);
        expect(await peer.task.findUniqueOrThrow({ where: { id: task.id } })).toEqual(before);
      },
    );

    it.each([false, true])(
      "acknowledged cancellation during retry persistence (afterWrite=%s) never requeues",
      async (afterWrite) => {
        const { store, queue, run } = setup(async () => {
          throw new Error("retry me");
        });
        const gate = pause(store, "markRetrying", afterWrite);
        const task = await queue.enqueue(input);
        await gate.entered;
        expect(await queue.cancel(task.id)).toBe(true);
        expect(await peer.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
          status: "cancelled",
        });
        gate.release();
        await idle(queue);
        expect(run).toHaveBeenCalledTimes(1);
        expect(await db.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
          status: "cancelled",
          attempts: 1,
        });
      },
    );

    it.each(["cancelled", "completed", "failed"])(
      "another connection's %s prevents retry insertion without a local abort",
      async (status) => {
        const { store, queue, run, emitter } = setup(async () => {
          throw new Error("retry me");
        });
        const gate = pause(store, "markRetrying");
        const task = await queue.enqueue(input);
        await gate.entered;
        await peer.task.update({
          where: { id: task.id },
          data: { status, completedAt: new Date() },
        });
        gate.release();
        await idle(queue);
        expect(run).toHaveBeenCalledTimes(1);
        expect(emitter.taskStatus).toHaveBeenLastCalledWith(expect.objectContaining({ status }));
        expect(await db.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
          status,
          attempts: 1,
        });
      },
    );

    it.each(["cancelled", "completed", "failed"])(
      "another connection's %s wins over a queued running claim",
      async (status) => {
        const { store, queue, run } = setup();
        const gate = pause(store, "markRunning");
        const task = await queue.enqueue(input);
        await gate.entered;
        await peer.task.update({
          where: { id: task.id },
          data: { status, completedAt: new Date() },
        });
        gate.release();
        await idle(queue);
        expect(run).not.toHaveBeenCalled();
        expect(await db.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
          status,
          attempts: 0,
        });
      },
    );

    it.each([false, true])(
      "local cancellation during markRunning (afterWrite=%s) prevents handler dispatch",
      async (afterWrite) => {
        const { store, queue, run } = setup();
        const gate = pause(store, "markRunning", afterWrite);
        const task = await queue.enqueue(input);
        await gate.entered;
        await queue.cancel(task.id);
        gate.release();
        await idle(queue);
        expect(run).not.toHaveBeenCalled();
        expect(await db.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
          status: "cancelled",
        });
      },
    );

    it.each(["cancelled", "completed"])(
      "shutdown retry persistence preserves a concurrent terminal %s",
      async (status) => {
        const started = barrier();
        const { store, queue } = setup(async ({ signal }) => {
          started.release();
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          signal.throwIfAborted();
        });
        const gate = pause(store, "markRetrying");
        const task = await queue.enqueue(input);
        await started.promise;
        await queue.shutdown();
        await gate.entered;
        await peer.task.update({
          where: { id: task.id },
          data: { status, completedAt: new Date() },
        });
        gate.release();
        await idle(queue);
        expect(await db.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
          status,
        });
      },
    );

    it("cancel acknowledgement cannot be overwritten by an awaiting completion", async () => {
      const { store, queue } = setup();
      const gate = pause(store, "markCompleted");
      const task = await queue.enqueue(input);
      await gate.entered;
      await queue.cancel(task.id);
      gate.release();
      await idle(queue);
      expect(await db.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
        status: "cancelled",
      });
    });

    it("shutdown while claiming preserves pending durable work without starting a handler", async () => {
      const { store, queue, run } = setup();
      const gate = pause(store, "markRunning");
      const task = await queue.enqueue(input);
      await gate.entered;
      await queue.shutdown();
      gate.release();
      await idle(queue);
      expect(run).not.toHaveBeenCalled();
      expect(await db.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
        status: "pending",
      });
    });

    it("settled timeouts retain bounded retries against the real store", async () => {
      const { queue, run } = setup(async ({ signal }) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        signal.throwIfAborted();
      }, 5);
      const task = await queue.enqueue(input);
      await idle(queue);
      expect(run).toHaveBeenCalledTimes(2);
      expect(await db.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
        status: "failed",
        attempts: 2,
      });
    });
  },
);
