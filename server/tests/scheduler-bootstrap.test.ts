/**
 * Coverage tests for scheduler/config, scheduler/socket-emitter,
 * scheduler/task-store, scheduler/index bootstrap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const taskRows = new Map<string, Record<string, unknown>>();
let nextTaskId = 0;
function makeRow(input: Record<string, unknown>): Record<string, unknown> {
  nextTaskId += 1;
  const id = `t${nextTaskId}`;
  const row = {
    id,
    scheduledJobId: input.scheduledJobId ?? null,
    projectId: input.projectId ?? null,
    type: input.type ?? "noop",
    trigger: input.trigger ?? "manual",
    status: input.status ?? "pending",
    priority: input.priority ?? 5,
    payload: input.payload ?? "{}",
    result: input.result ?? null,
    errorMessage: input.errorMessage ?? null,
    progress: input.progress ?? null,
    attempts: input.attempts ?? 0,
    maxAttempts: input.maxAttempts ?? 3,
    scheduledFor: input.scheduledFor ?? null,
    startedAt: input.startedAt ?? null,
    completedAt: input.completedAt ?? null,
    createdById: input.createdById ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  taskRows.set(id, row);
  return row;
}

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    task: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => makeRow(data)),
      updateMany: vi.fn(async ({ where, data }) => {
        const row = taskRows.get(where.id);
        const matches =
          typeof where.status === "string"
            ? row?.status === where.status
            : where.status.in.includes(row?.status);
        if (!row || !matches) return { count: 0 };
        const attempts =
          typeof data.attempts === "object"
            ? Number(row.attempts) + data.attempts.increment
            : data.attempts;
        Object.assign(row, data, {
          ...(attempts === undefined ? {} : { attempts }),
          updatedAt: new Date(),
        });
        return { count: 1 };
      }),
      findUniqueOrThrow: vi.fn(async ({ where }) => {
        const row = taskRows.get(where.id);
        if (!row) throw new Error("Task not found");
        return { ...row };
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const r = taskRows.get(where.id) ?? makeRow({ id: where.id });
          Object.assign(r, data, { updatedAt: new Date() });
          return r;
        },
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => taskRows.get(where.id) ?? null,
      ),
    },
    auditLog: { create: vi.fn(async () => ({})) },
    scheduledJob: { findMany: vi.fn(async () => []) },
  },
}));

import { loadSchedulerConfig, SCHEDULER_DEFAULTS } from "../src/lib/scheduler/config.js";
import {
  createSchedulerEmitter,
  NOOP_SCHEDULER_EMITTER,
} from "../src/lib/scheduler/socket-emitter.js";
import { createPrismaTaskStore, readTaskRecord } from "../src/lib/scheduler/task-store.js";
import {
  bootstrapScheduler,
  __resetSchedulerBootstrap,
  getSchedulerBootstrap,
} from "../src/lib/scheduler/index.js";

beforeEach(() => {
  taskRows.clear();
  nextTaskId = 0;
  __resetSchedulerBootstrap();
});

afterEach(() => {
  __resetSchedulerBootstrap();
});

describe("loadSchedulerConfig()", () => {
  it("returns defaults when env is empty", () => {
    const cfg = loadSchedulerConfig({});
    expect(cfg).toEqual(SCHEDULER_DEFAULTS);
  });

  it("parses overrides and clamps to minimums", () => {
    const cfg = loadSchedulerConfig({
      SCHEDULER_CONCURRENCY: "0", // clamped to 1
      SCHEDULER_TICK_MS: "50", // clamped to 100
      SCHEDULER_DEFAULT_TIMEOUT_MS: "100", // clamped to 1000
      SCHEDULER_RETRY_BACKOFF_MS: "10", // clamped to 100
      SCHEDULER_RETRY_BACKOFF_MAX_MS: "999", // clamped to 1000
      SCHEDULER_MIN_CRON_INTERVAL_SEC: "0", // clamped to 1
      SCHEDULER_ENABLED: "off",
    });
    expect(cfg.concurrency).toBe(1);
    expect(cfg.tickMs).toBe(100);
    expect(cfg.defaultTimeoutMs).toBe(1000);
    expect(cfg.retryBackoffMs).toBe(100);
    expect(cfg.retryBackoffMaxMs).toBe(1000);
    expect(cfg.minCronIntervalSec).toBe(1);
    expect(cfg.enabled).toBe(false);
  });

  it("falls back when env var is non-numeric garbage", () => {
    const cfg = loadSchedulerConfig({ SCHEDULER_CONCURRENCY: "abc", SCHEDULER_ENABLED: "1" });
    expect(cfg.concurrency).toBe(SCHEDULER_DEFAULTS.concurrency);
    expect(cfg.enabled).toBe(true);
  });
});

describe("createSchedulerEmitter()", () => {
  it("routes events to the correct rooms", () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const io = { to } as unknown as Parameters<typeof createSchedulerEmitter>[0];
    const e = createSchedulerEmitter(io);
    e.schedulerStatus({ jobId: "j1", status: "registered" });
    expect(to).toHaveBeenLastCalledWith("scheduler:status");
    e.taskStatus({ taskId: "t1", status: "running", attempts: 1 });
    expect(to).toHaveBeenCalledWith("task:t1");
    e.taskProgress({ taskId: "t1", step: "go" });
    expect(to).toHaveBeenLastCalledWith("task:t1");
  });

  it("NOOP_SCHEDULER_EMITTER is a no-op", () => {
    expect(() => {
      NOOP_SCHEDULER_EMITTER.schedulerStatus({ jobId: "j1", status: "registered" });
      NOOP_SCHEDULER_EMITTER.taskStatus({ taskId: "t1", status: "pending", attempts: 0 });
      NOOP_SCHEDULER_EMITTER.taskProgress({ taskId: "t1", step: "x" });
    }).not.toThrow();
  });
});

describe("createPrismaTaskStore()", () => {
  it("round-trips payload and result through JSON", async () => {
    const store = createPrismaTaskStore();
    const created = await store.create({
      type: "noop",
      payload: { foo: "bar" },
      now: new Date(),
    });
    expect(created.payload).toEqual({ foo: "bar" });
    await store.markRunning(created.id, 1, new Date());
    const completed = await store.markCompleted(created.id, { ok: true }, new Date());
    expect(completed.status).toBe("completed");
    expect(completed.result).toEqual({ ok: true });
  });

  it("transitions through running/retry/progress and never revives terminal failures", async () => {
    const store = createPrismaTaskStore();
    const created = await store.create({ type: "noop", payload: {}, now: new Date() });
    await store.markRunning(created.id, 1, new Date());
    await store.updateProgress(created.id, 50);
    await store.markRetrying(created.id, "transient", new Date());
    expect(taskRows.get(created.id)?.status).toBe("pending");
    await store.markRunning(created.id, 2, new Date());
    await store.markFailed(created.id, "boom", new Date());
    await store.markCancelled(created.id, "user-cancel", new Date());
    await store.markRetrying(created.id, "transient", new Date());
    expect(taskRows.get(created.id)?.status).toBe("failed");
  });

  it("readTaskRecord returns null when missing, record when present", async () => {
    expect(await readTaskRecord("missing")).toBeNull();
    const store = createPrismaTaskStore();
    const created = await store.create({ type: "noop", payload: {}, now: new Date() });
    const found = await readTaskRecord(created.id);
    expect(found?.id).toBe(created.id);
  });
});

describe("bootstrapScheduler()", () => {
  it("resumes a persisted regeneration through the real queue/store and forwards cancellation (#1356)", async () => {
    let signal!: AbortSignal;
    let finish!: () => void;
    const regenerateGeneratedDocument = vi.fn(
      async (_payload: Record<string, unknown>, receivedSignal: AbortSignal) => {
        signal = receivedSignal;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    );
    const boot = bootstrapScheduler({ handlerOverrides: { regenerateGeneratedDocument } });
    const payload = {
      projectId: "p1",
      generatedDocumentId: "d1",
      expectedVersion: 1,
      fingerprint: "hash",
    };
    const persisted = await createPrismaTaskStore().create({
      type: "regenerate-generated-document",
      projectId: "p1",
      payload,
      now: new Date(),
    });
    const replay = (await readTaskRecord(persisted.id))!;
    boot.queue.resume(replay);
    boot.queue.resume({ ...replay });
    await new Promise((resolve) => setImmediate(resolve));
    expect(regenerateGeneratedDocument).toHaveBeenCalledExactlyOnceWith(payload, signal);
    expect(taskRows.get(persisted.id)).toMatchObject({ status: "running", attempts: 1 });
    expect(taskRows.size).toBe(1);
    expect(signal.aborted).toBe(false);
    await boot.queue.cancel(persisted.id);
    expect(signal.aborted).toBe(true);
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    expect((await readTaskRecord(persisted.id))?.status).toBe("cancelled");
    await boot.shutdown();
  });

  it("forwards publication overrides and persists the returned result (#1356)", async () => {
    const publishGeneratedDocument = vi.fn(async () => ({ status: "published", chunkCount: 3 }));
    const boot = bootstrapScheduler({ handlerOverrides: { publishGeneratedDocument } });
    const task = await boot.queue.enqueue({
      type: "publish-generated-document",
      projectId: "p1",
      payload: { projectId: "p1", generatedDocumentId: "d1", version: 2, revisionId: "r2" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(publishGeneratedDocument).toHaveBeenCalledExactlyOnceWith(
      "d1",
      "p1",
      2,
      "r2",
      expect.any(AbortSignal),
    );
    expect(await readTaskRecord(task.id)).toMatchObject({
      status: "completed",
      result: { generatedDocumentId: "d1", status: "published", chunkCount: 3 },
    });
    await boot.shutdown();
  });

  it("returns the same instance on subsequent calls", () => {
    const a = bootstrapScheduler({});
    const b = bootstrapScheduler({});
    expect(a).toBe(b);
  });

  it("getSchedulerBootstrap throws before init, returns after init", () => {
    expect(() => getSchedulerBootstrap()).toThrow(/not been initialised/);
    bootstrapScheduler({});
    expect(getSchedulerBootstrap()).toBeDefined();
  });

  it("shutdown clears the singleton", async () => {
    const boot = bootstrapScheduler({});
    await boot.shutdown();
    expect(() => getSchedulerBootstrap()).toThrow();
  });
});
