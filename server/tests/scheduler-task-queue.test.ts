/**
 * TaskQueue — concurrency, priority, retry, cancellation, progress.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));

import { TaskQueue, type TaskStore } from "../src/lib/scheduler/task-queue.js";
import { InMemoryTaskHandlerRegistry } from "../src/lib/scheduler/task-handlers.js";
import {
  SchedulerError,
  type EnqueueTaskInput,
  type SchedulerConfig,
  type SchedulerEmitter,
  type TaskHandlerFn,
  type TaskRecord,
  type TaskStatus,
} from "../src/lib/scheduler/types.js";

let counter = 0;
function makeStore(): { store: TaskStore; rows: Map<string, TaskRecord> } {
  const rows = new Map<string, TaskRecord>();
  const store: TaskStore = {
    async create(input: EnqueueTaskInput & { now: Date }) {
      counter += 1;
      const id = `t${counter}`;
      const r: TaskRecord = {
        id,
        scheduledJobId: input.scheduledJobId ?? null,
        projectId: input.projectId ?? null,
        type: input.type,
        trigger: input.trigger ?? "manual",
        status: "pending",
        priority: input.priority ?? 5,
        payload: input.payload ?? {},
        result: null,
        errorMessage: null,
        progress: null,
        attempts: 0,
        maxAttempts: input.maxAttempts ?? 3,
        scheduledFor: input.scheduledFor ?? null,
        startedAt: null,
        completedAt: null,
        createdById: input.createdById ?? null,
        createdAt: input.now,
        updatedAt: input.now,
      };
      rows.set(id, r);
      return r;
    },
    async markRunning(id, attempt, now) {
      const r = rows.get(id)!;
      r.status = "running";
      r.attempts = attempt;
      r.startedAt = now;
      r.updatedAt = now;
      return r;
    },
    async markCompleted(id, result, now) {
      const r = rows.get(id)!;
      r.status = "completed";
      r.result = result;
      r.completedAt = now;
      r.errorMessage = null;
      r.progress = 100;
      r.updatedAt = now;
      return r;
    },
    async markFailed(id, error, now) {
      const r = rows.get(id)!;
      r.status = "failed";
      r.errorMessage = error;
      r.completedAt = now;
      r.updatedAt = now;
      return r;
    },
    async markCancelled(id, reason, now) {
      const r = rows.get(id)!;
      r.status = "cancelled";
      r.errorMessage = reason;
      r.completedAt = now;
      r.updatedAt = now;
      return r;
    },
    async markRetrying(id, error, now) {
      const r = rows.get(id)!;
      r.status = "pending";
      r.errorMessage = error;
      r.startedAt = null;
      r.completedAt = null;
      r.updatedAt = now;
      return r;
    },
    async updateProgress(id, p) {
      const r = rows.get(id);
      if (r) r.progress = p;
    },
  };
  return { store, rows };
}

function makeEmitter(): {
  emitter: SchedulerEmitter;
  status: Array<{ taskId: string; status: TaskStatus; attempts: number }>;
  progress: Array<{ taskId: string; step: string; pct?: number }>;
} {
  const status: Array<{ taskId: string; status: TaskStatus; attempts: number }> = [];
  const progress: Array<{ taskId: string; step: string; pct?: number }> = [];
  return {
    status,
    progress,
    emitter: {
      schedulerStatus() {},
      taskStatus(e) {
        status.push({ taskId: e.taskId, status: e.status as TaskStatus, attempts: e.attempts });
      },
      taskProgress(e) {
        progress.push({ taskId: e.taskId, step: e.step, pct: e.progress });
      },
    },
  };
}

const baseConfig: SchedulerConfig = {
  concurrency: 2,
  tickMs: 1000,
  defaultTimeoutMs: 30_000,
  retryBackoffMs: 100,
  retryBackoffMaxMs: 1000,
  minCronIntervalSec: 60,
  enabled: true,
};

beforeEach(() => {
  counter = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TaskQueue.resume (#1356)", () => {
  it("shutdown after timeout preserves bounded retry rather than cancellation", async () => {
    vi.useFakeTimers();
    const { store, rows } = makeStore();
    const registry = new InMemoryTaskHandlerRegistry();
    let release!: () => void;
    registry.register({
      type: "publish-generated-document",
      description: "",
      handler: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        throw new Error("settled after timeout");
      },
    });
    const queue = new TaskQueue(store, registry, makeEmitter().emitter, {
      ...baseConfig,
      defaultTimeoutMs: 10,
    });
    const task = await queue.enqueue({ type: "publish-generated-document", maxAttempts: 2 });
    await vi.advanceTimersByTimeAsync(10);
    await queue.shutdown();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(rows.get(task.id)).toMatchObject({ status: "pending", attempts: 1 });
    expect(queue.snapshot()).toMatchObject({ running: 0, queueDepth: 0 });
  });

  it.each(["publish-generated-document", "ordinary"])(
    "retries settled %s timeouts with bounded attempts",
    async (type) => {
      vi.useFakeTimers();
      const { store, rows } = makeStore();
      const registry = new InMemoryTaskHandlerRegistry();
      const handler = vi.fn(async ({ signal }) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        signal.throwIfAborted();
      });
      registry.register({ type, description: "", handler });
      const queue = new TaskQueue(store, registry, makeEmitter().emitter, {
        ...baseConfig,
        defaultTimeoutMs: 10,
      });
      const task = await queue.enqueue({ type, maxAttempts: 2 });
      await vi.advanceTimersByTimeAsync(10);
      expect(rows.get(task.id)?.status).toBe("pending");
      await vi.advanceTimersByTimeAsync(110);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(rows.get(task.id)).toMatchObject({ status: "failed", attempts: 2 });
      await queue.shutdown();
    },
  );

  it("deduplicates pending and running replays without creating another durable row", async () => {
    const { store, rows } = makeStore();
    const registry = new InMemoryTaskHandlerRegistry();
    let release!: () => void;
    const handler = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { resumed: true };
    });
    registry.register({ type: "regenerate-generated-document", description: "", handler });
    const { emitter } = makeEmitter();
    const queue = new TaskQueue(store, registry, emitter, { ...baseConfig, concurrency: 1 });
    const blocker = await queue.enqueue({ type: "regenerate-generated-document" });
    await new Promise((resolve) => setImmediate(resolve));
    const releaseBlocker = release;
    const persisted = await store.create({
      type: "regenerate-generated-document",
      now: new Date(),
    });
    const create = vi.spyOn(store, "create");
    const markRunning = vi.spyOn(store, "markRunning");
    const replay = { ...persisted };
    queue.resume(replay);
    queue.resume({ ...replay });
    expect(queue.snapshot()).toMatchObject({ running: 1, queueDepth: 1 });
    releaseBlocker();
    await new Promise((resolve) => setImmediate(resolve));
    // A stale pending snapshot must also be ignored while this id is running.
    queue.resume({ ...replay });
    expect(queue.snapshot()).toMatchObject({ running: 1, queueDepth: 0 });
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(handler).toHaveBeenCalledTimes(2);
    expect(markRunning).toHaveBeenCalledExactlyOnceWith(persisted.id, 1, expect.any(Date));
    expect(create).not.toHaveBeenCalled();
    expect(rows.size).toBe(2);
    expect(rows.get(blocker.id)?.status).toBe("completed");
    expect(rows.get(persisted.id)).toMatchObject({
      status: "completed",
      result: { resumed: true },
    });
    await queue.shutdown();
  });

  it.each(["running", "completed", "failed", "cancelled"] as const)(
    "ignores persisted %s tasks",
    async (status) => {
      const { store } = makeStore();
      const registry = new InMemoryTaskHandlerRegistry();
      const handler = vi.fn();
      registry.register({ type: "ok", description: "", handler });
      const task = await store.create({ type: "ok", now: new Date() });
      const queue = new TaskQueue(store, registry, makeEmitter().emitter, baseConfig);
      queue.resume({ ...task, status });
      expect(queue.snapshot()).toMatchObject({ queueDepth: 0, running: 0, lastTickAt: null });
      expect(handler).not.toHaveBeenCalled();
      await queue.shutdown();
    },
  );

  it("ignores unknown handlers and stopped queues without changing persisted state", async () => {
    const { store, rows } = makeStore();
    const registry = new InMemoryTaskHandlerRegistry();
    const task = await store.create({ type: "unknown", now: new Date() });
    const queue = new TaskQueue(store, registry, makeEmitter().emitter, baseConfig);
    queue.resume(task);
    expect(queue.snapshot()).toMatchObject({ queueDepth: 0, running: 0 });
    const handler = vi.fn();
    registry.register({ type: "unknown", description: "", handler });
    await queue.shutdown();
    queue.resume(task);
    expect(queue.snapshot()).toMatchObject({ queueDepth: 0, running: 0 });
    expect(rows.get(task.id)?.status).toBe("pending");
    expect(handler).not.toHaveBeenCalled();
  });

  it("respects scheduledFor on replay rather than executing future tasks early", async () => {
    const { store, rows } = makeStore();
    const registry = new InMemoryTaskHandlerRegistry();
    const handler = vi.fn();
    registry.register({ type: "ok", description: "", handler });
    const task = await store.create({
      type: "ok",
      now: new Date(),
      scheduledFor: new Date(Date.now() + 60_000),
    });
    const queue = new TaskQueue(store, registry, makeEmitter().emitter, baseConfig);
    queue.resume(task);
    queue.resume({ ...task });
    expect(queue.snapshot()).toMatchObject({ queueDepth: 1, running: 0 });
    expect(handler).not.toHaveBeenCalled();
    expect(rows.get(task.id)?.status).toBe("pending");
    await queue.shutdown();
  });
});

describe.each(["regenerate-generated-document", "publish-generated-document"])(
  "TaskQueue durable %s shutdown",
  (type) => {
    it("preserves pending durable work for one restart replay, without changing ordinary cancellation", async () => {
      const { store, rows } = makeStore();
      const registry = new InMemoryTaskHandlerRegistry();
      const handler = vi.fn(async () => ({ resumed: true }));
      registry.register({ type, description: "", handler });
      registry.register({ type: "ordinary", description: "", handler });
      const queue = new TaskQueue(store, registry, makeEmitter().emitter, {
        ...baseConfig,
        concurrency: 0,
      });
      const task = await queue.enqueue({ type });
      const publication = await queue.enqueue({ type: "ordinary" });
      const cancelled = vi.spyOn(store, "markCancelled");
      await queue.shutdown();
      expect(rows.get(task.id)?.status).toBe("pending");
      expect(rows.get(publication.id)?.status).toBe("cancelled");
      expect(cancelled).toHaveBeenCalledExactlyOnceWith(
        publication.id,
        "scheduler shutdown",
        expect.any(Date),
      );
      expect(queue.snapshot()).toMatchObject({ queueDepth: 0, running: 0 });

      const create = vi.spyOn(store, "create");
      const restarted = new TaskQueue(store, registry, makeEmitter().emitter, baseConfig);
      const replay = { ...rows.get(task.id)! };
      restarted.resume(replay);
      restarted.resume({ ...replay });
      await new Promise((resolve) => setImmediate(resolve));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(rows.get(task.id)).toMatchObject({ status: "completed", attempts: 1 });
      expect(create).not.toHaveBeenCalled();
      expect(rows.size).toBe(2);
      await restarted.shutdown();
    });

    it.each(["resolve", "reject"])(
      "returns shutdown-aborted running work to pending when the handler %ss",
      async (outcome) => {
        vi.useFakeTimers();
        const { store, rows } = makeStore();
        const registry = new InMemoryTaskHandlerRegistry();
        const handler = vi.fn<TaskHandlerFn>(async ({ signal }) => {
          await new Promise<void>((resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => (outcome === "reject" ? reject(new Error("interrupted")) : resolve()),
              { once: true },
            );
          });
        });
        registry.register({ type, description: "", handler });
        const { emitter, status } = makeEmitter();
        const queue = new TaskQueue(store, registry, emitter, baseConfig);
        const cancelled = vi.spyOn(store, "markCancelled");
        const retrying = vi.spyOn(store, "markRetrying");
        const task = await queue.enqueue({ type, maxAttempts: 1 });
        await vi.advanceTimersByTimeAsync(0);
        await queue.shutdown();
        await vi.advanceTimersByTimeAsync(0);
        expect(rows.get(task.id)).toMatchObject({ status: "pending", attempts: 1 });
        expect(retrying).toHaveBeenCalledTimes(1);
        expect(cancelled).not.toHaveBeenCalled();
        expect(status.map((event) => event.status)).toEqual(["pending", "running", "pending"]);
        expect(queue.snapshot()).toMatchObject({ queueDepth: 0, running: 0 });
        expect(vi.getTimerCount()).toBe(0);

        handler.mockImplementation(async () => ({ resumed: true }));
        const create = vi.spyOn(store, "create");
        const restarted = new TaskQueue(store, registry, emitter, baseConfig);
        const replay = { ...rows.get(task.id)! };
        restarted.resume(replay);
        restarted.resume({ ...replay });
        await vi.advanceTimersByTimeAsync(0);
        expect(handler).toHaveBeenCalledTimes(2);
        expect(rows.get(task.id)).toMatchObject({ status: "completed", attempts: 2 });
        expect(create).not.toHaveBeenCalled();
        await restarted.shutdown();
      },
    );

    it.each(["before", "after"])(
      "keeps explicit running cancellation terminal %s shutdown",
      async (order) => {
        const { store, rows } = makeStore();
        const registry = new InMemoryTaskHandlerRegistry();
        let release!: () => void;
        const handler = vi.fn(
          async () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        );
        registry.register({ type, description: "", handler });
        const queue = new TaskQueue(store, registry, makeEmitter().emitter, baseConfig);
        const task = await queue.enqueue({ type });
        await new Promise((resolve) => setImmediate(resolve));
        if (order === "before") await queue.cancel(task.id);
        await queue.shutdown();
        if (order === "after") await queue.cancel(task.id);
        release();
        await new Promise((resolve) => setImmediate(resolve));
        expect(rows.get(task.id)?.status).toBe("cancelled");
        const restarted = new TaskQueue(store, registry, makeEmitter().emitter, baseConfig);
        restarted.resume({ ...rows.get(task.id)! });
        expect(handler).toHaveBeenCalledTimes(1);
        await restarted.shutdown();
      },
    );

    it("keeps explicit pending cancellation terminal across shutdown", async () => {
      const { store, rows } = makeStore();
      const registry = new InMemoryTaskHandlerRegistry();
      const handler = vi.fn();
      registry.register({ type, description: "", handler });
      const queue = new TaskQueue(store, registry, makeEmitter().emitter, {
        ...baseConfig,
        concurrency: 0,
      });
      const task = await queue.enqueue({ type });
      await queue.cancel(task.id);
      await queue.shutdown();
      expect(rows.get(task.id)?.status).toBe("cancelled");
      const restarted = new TaskQueue(store, registry, makeEmitter().emitter, baseConfig);
      restarted.resume({ ...rows.get(task.id)! });
      expect(handler).not.toHaveBeenCalled();
      await restarted.shutdown();
    });

    it("preserves shutdown provenance while markRunning is still pending", async () => {
      const { store, rows } = makeStore();
      const registry = new InMemoryTaskHandlerRegistry();
      registry.register({
        type,
        description: "",
        handler: async ({ signal }) => {
          signal.throwIfAborted();
        },
      });
      const markRunning = store.markRunning.bind(store);
      let release!: () => void;
      vi.spyOn(store, "markRunning").mockImplementation(async (...args) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return markRunning(...args);
      });
      const cancelled = vi.spyOn(store, "markCancelled");
      const queue = new TaskQueue(store, registry, makeEmitter().emitter, baseConfig);
      const task = await queue.enqueue({ type });
      await queue.shutdown();
      release();
      await new Promise((resolve) => setImmediate(resolve));
      expect(rows.get(task.id)?.status).toBe("pending");
      expect(cancelled).not.toHaveBeenCalled();
      expect(queue.snapshot()).toMatchObject({ running: 0, queueDepth: 0 });
    });

    it("preserves a failure during shutdown before running tasks are aborted, even at maxAttempts", async () => {
      vi.useFakeTimers();
      const { store, rows } = makeStore();
      const registry = new InMemoryTaskHandlerRegistry();
      let fail!: (error: Error) => void;
      registry.register({
        type,
        description: "",
        handler: async () =>
          new Promise<void>((_, reject) => {
            fail = reject;
          }),
      });
      registry.register({ type: "other", description: "", handler: async () => {} });
      const markCancelled = store.markCancelled.bind(store);
      let release!: () => void;
      vi.spyOn(store, "markCancelled").mockImplementation(async (...args) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return markCancelled(...args);
      });
      const queue = new TaskQueue(store, registry, makeEmitter().emitter, {
        ...baseConfig,
        concurrency: 1,
      });
      const task = await queue.enqueue({ type, maxAttempts: 1 });
      await queue.enqueue({ type: "other" });
      await vi.advanceTimersByTimeAsync(0);
      const shutdown = queue.shutdown();
      fail(new Error("shutdown failure"));
      await vi.advanceTimersByTimeAsync(0);
      expect(rows.get(task.id)?.status).toBe("pending");
      expect(vi.getTimerCount()).toBe(0);
      release();
      await shutdown;
      expect(queue.snapshot()).toMatchObject({ running: 0, queueDepth: 0 });
    });

    it.each(["regenerate-generated-document", "publish-generated-document"])(
      "clears existing retry timers on shutdown for %s",
      async (taskType) => {
        vi.useFakeTimers();
        const { store, rows } = makeStore();
        const registry = new InMemoryTaskHandlerRegistry();
        const handler = vi.fn(async () => {
          throw new Error("transient");
        });
        registry.register({ type: taskType, description: "", handler });
        const queue = new TaskQueue(store, registry, makeEmitter().emitter, baseConfig);
        const task = await queue.enqueue({ type: taskType });
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(1);
        await queue.shutdown();
        expect(rows.get(task.id)?.status).toBe("pending");
        expect(vi.getTimerCount()).toBe(0);
        expect(queue.snapshot()).toMatchObject({ running: 0, queueDepth: 0 });
        expect(handler).toHaveBeenCalledTimes(1);
      },
    );

    it("does not install a retry timer if shutdown occurs during retry persistence", async () => {
      vi.useFakeTimers();
      const { store, rows } = makeStore();
      const registry = new InMemoryTaskHandlerRegistry();
      const handler = vi.fn(async () => {
        throw new Error("transient");
      });
      registry.register({ type, description: "", handler });
      const markRetrying = store.markRetrying.bind(store);
      let release!: () => void;
      vi.spyOn(store, "markRetrying").mockImplementation(async (...args) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return markRetrying(...args);
      });
      const queue = new TaskQueue(store, registry, makeEmitter().emitter, baseConfig);
      const task = await queue.enqueue({ type });
      await vi.advanceTimersByTimeAsync(0);
      await queue.shutdown();
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(rows.get(task.id)?.status).toBe("pending");
      expect(queue.snapshot()).toMatchObject({ queueDepth: 0, running: 0 });
      expect(vi.getTimerCount()).toBe(0);
      expect(handler).toHaveBeenCalledTimes(1);
    });
  },
);

describe("TaskQueue.enqueue", () => {
  it("rejects unknown task types and persists a failed row", async () => {
    const { store, rows } = makeStore();
    const registry = new InMemoryTaskHandlerRegistry();
    const { emitter } = makeEmitter();
    const queue = new TaskQueue(store, registry, emitter, baseConfig);
    await expect(queue.enqueue({ type: "missing", payload: {} })).rejects.toBeInstanceOf(
      SchedulerError,
    );
    const row = Array.from(rows.values()).at(0);
    expect(row?.status).toBe("failed");
    expect(row?.errorMessage).toContain("unknown task type: missing");
  });

  it("runs a registered handler to completion and emits status events", async () => {
    const { store } = makeStore();
    const registry = new InMemoryTaskHandlerRegistry();
    registry.register({
      type: "ok",
      description: "ok",
      handler: async () => ({ done: true }),
    });
    const { emitter, status } = makeEmitter();
    const queue = new TaskQueue(store, registry, emitter, baseConfig);
    const task = await queue.enqueue({ type: "ok" });
    // Allow microtasks and one event loop tick for the dispatch chain.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const final = status.filter((s) => s.taskId === task.id).at(-1);
    expect(final?.status).toBe("completed");
  });
});

describe("TaskQueue concurrency + priority", () => {
  it("does not run more than `config.concurrency` tasks simultaneously", async () => {
    const { store } = makeStore();
    const registry = new InMemoryTaskHandlerRegistry();
    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const handler: TaskHandlerFn = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => release.push(resolve));
      active -= 1;
    };
    registry.register({ type: "slow", description: "slow", handler });
    const { emitter } = makeEmitter();
    const queue = new TaskQueue(store, registry, emitter, { ...baseConfig, concurrency: 2 });
    await queue.enqueue({ type: "slow" });
    await queue.enqueue({ type: "slow" });
    await queue.enqueue({ type: "slow" });
    await queue.enqueue({ type: "slow" });
    await new Promise((r) => setImmediate(r));
    expect(peak).toBe(2);
    // Drain remaining tasks.
    while (release.length > 0) release.shift()!();
    await new Promise((r) => setImmediate(r));
    while (release.length > 0) release.shift()!();
    await new Promise((r) => setImmediate(r));
  });

  it("higher-priority tasks pre-empt lower-priority ones at the queue head", async () => {
    const { store } = makeStore();
    const registry = new InMemoryTaskHandlerRegistry();
    const order: string[] = [];
    let release: (() => void) | null = null;
    registry.register({
      type: "blocker",
      description: "",
      handler: async () => {
        await new Promise<void>((r) => {
          release = r;
        });
      },
    });
    registry.register({
      type: "ranked",
      description: "",
      handler: async (ctx) => {
        order.push(`${ctx.task.priority}:${ctx.task.id}`);
      },
    });
    const { emitter } = makeEmitter();
    const queue = new TaskQueue(store, registry, emitter, { ...baseConfig, concurrency: 1 });
    // Block the only worker.
    await queue.enqueue({ type: "blocker" });
    await new Promise((r) => setImmediate(r));
    // Now stack two waiting tasks: low priority enqueued first.
    await queue.enqueue({ type: "ranked", priority: 9 });
    await queue.enqueue({ type: "ranked", priority: 1 });
    // Free the blocker.
    release?.();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(order[0]?.startsWith("1:")).toBe(true);
    expect(order[1]?.startsWith("9:")).toBe(true);
  });
});

describe("TaskQueue retry semantics", () => {
  it.each(["dispatch", "cancel", "shutdown"] as const)(
    "re-arms an early retry wake and respects %s (#1356)",
    async (outcome) => {
      vi.useFakeTimers();
      const now = vi.spyOn(Date, "now").mockReturnValue(1000);
      const { store, rows } = makeStore();
      const registry = new InMemoryTaskHandlerRegistry();
      const handler = vi
        .fn<TaskHandlerFn>()
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValue({ retried: true });
      const type = "regenerate-generated-document";
      registry.register({ type, description: "", handler });
      const queue = new TaskQueue(store, registry, makeEmitter().emitter, {
        ...baseConfig,
        retryBackoffMs: 1,
      });
      try {
        const task = await queue.enqueue({ type });
        await vi.advanceTimersByTimeAsync(0);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(1);

        // Fire the timer while the wall clock still precedes readyAt (1001).
        await vi.advanceTimersByTimeAsync(1);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(queue.snapshot()).toMatchObject({ running: 0, queueDepth: 1 });
        expect(vi.getTimerCount()).toBe(1);

        if (outcome === "cancel") expect(await queue.cancel(task.id)).toBe(true);
        if (outcome === "shutdown") await queue.shutdown();
        if (outcome !== "dispatch") expect(vi.getTimerCount()).toBe(0);

        now.mockReturnValue(1001);
        await vi.advanceTimersByTimeAsync(1);
        expect(handler).toHaveBeenCalledTimes(outcome === "dispatch" ? 2 : 1);
        expect(rows.get(task.id)).toMatchObject({
          status:
            outcome === "dispatch" ? "completed" : outcome === "cancel" ? "cancelled" : "pending",
          attempts: outcome === "dispatch" ? 2 : 1,
        });
        expect(queue.snapshot()).toMatchObject({ running: 0, queueDepth: 0 });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await queue.shutdown();
        now.mockRestore();
      }
    },
  );

  it("retries up to maxAttempts with exponential backoff and emits final failure", async () => {
    vi.useFakeTimers();
    const { store, rows } = makeStore();
    const registry = new InMemoryTaskHandlerRegistry();
    let attempts = 0;
    registry.register({
      type: "flaky",
      description: "",
      handler: async () => {
        attempts += 1;
        throw new Error(`boom ${attempts}`);
      },
    });
    const { emitter, status } = makeEmitter();
    const queue = new TaskQueue(store, registry, emitter, {
      ...baseConfig,
      retryBackoffMs: 100,
      retryBackoffMaxMs: 1000,
    });
    const task = await queue.enqueue({ type: "flaky", maxAttempts: 3 });
    // Initial attempt + 2 retries scheduled at 100, 200ms.
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(attempts).toBe(3);
    expect(rows.get(task.id)?.status).toBe("failed");
    // Final emission must carry the error.
    const final = status.filter((s) => s.taskId === task.id).at(-1);
    expect(final?.status).toBe("failed");
  }, 10_000);

  it("succeeds without retry when handler resolves", async () => {
    const { store, rows } = makeStore();
    const registry = new InMemoryTaskHandlerRegistry();
    registry.register({ type: "ok", description: "", handler: async () => ({ k: 1 }) });
    const { emitter } = makeEmitter();
    const queue = new TaskQueue(store, registry, emitter, baseConfig);
    const task = await queue.enqueue({ type: "ok" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(rows.get(task.id)?.status).toBe("completed");
    expect(rows.get(task.id)?.attempts).toBe(1);
  });
});

describe("TaskQueue cancellation", () => {
  it("cancels a queued task before it runs", async () => {
    const { store, rows } = makeStore();
    const registry = new InMemoryTaskHandlerRegistry();
    let release: (() => void) | null = null;
    registry.register({
      type: "blocker",
      description: "",
      handler: async () => {
        await new Promise<void>((r) => {
          release = r;
        });
      },
    });
    registry.register({
      type: "ok",
      description: "",
      handler: async () => ({}),
    });
    const { emitter } = makeEmitter();
    const queue = new TaskQueue(store, registry, emitter, { ...baseConfig, concurrency: 1 });
    await queue.enqueue({ type: "blocker" });
    await new Promise((r) => setImmediate(r));
    const queued = await queue.enqueue({ type: "ok" });
    const ok = await queue.cancel(queued.id, "drop");
    expect(ok).toBe(true);
    expect(rows.get(queued.id)?.status).toBe("cancelled");
    release?.();
    await new Promise((r) => setImmediate(r));
  });

  it("cancels a running task by aborting the signal", async () => {
    const { store, rows } = makeStore();
    const registry = new InMemoryTaskHandlerRegistry();
    let aborted = false;
    registry.register({
      type: "long",
      description: "",
      handler: async (ctx) => {
        await new Promise<void>((resolve, reject) => {
          ctx.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        });
      },
    });
    const { emitter } = makeEmitter();
    const queue = new TaskQueue(store, registry, emitter, baseConfig);
    const task = await queue.enqueue({ type: "long" });
    await new Promise((r) => setImmediate(r));
    const ok = await queue.cancel(task.id, "user");
    expect(ok).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(aborted).toBe(true);
    expect(rows.get(task.id)?.status).toBe("cancelled");
  });

  it("returns false when cancelling an unknown task", async () => {
    const { store } = makeStore();
    const registry = new InMemoryTaskHandlerRegistry();
    const { emitter } = makeEmitter();
    const queue = new TaskQueue(store, registry, emitter, baseConfig);
    expect(await queue.cancel("nope")).toBe(false);
  });
});

describe("TaskQueue retry()", () => {
  it("re-enqueues a failed task with trigger=retry", async () => {
    const { store, rows } = makeStore();
    const registry = new InMemoryTaskHandlerRegistry();
    registry.register({
      type: "fail",
      description: "",
      handler: async () => {
        throw new Error("nope");
      },
    });
    registry.register({
      type: "ok",
      description: "",
      handler: async () => ({}),
    });
    const { emitter } = makeEmitter();
    const queue = new TaskQueue(store, registry, emitter, {
      ...baseConfig,
      retryBackoffMs: 1,
      retryBackoffMaxMs: 5,
    });
    const original = await queue.enqueue({ type: "ok", maxAttempts: 1 });
    await new Promise((r) => setImmediate(r));
    rows.get(original.id)!.status = "failed";
    const retry = await queue.retry(original.id, rows.get(original.id)!);
    expect(retry.trigger).toBe("retry");
  });

  it("rejects retry of non-terminal tasks", async () => {
    const { store, rows } = makeStore();
    const registry = new InMemoryTaskHandlerRegistry();
    registry.register({
      type: "ok",
      description: "",
      handler: async () => ({}),
    });
    const { emitter } = makeEmitter();
    const queue = new TaskQueue(store, registry, emitter, baseConfig);
    const t = await queue.enqueue({ type: "ok" });
    rows.get(t.id)!.status = "running";
    await expect(queue.retry(t.id, rows.get(t.id)!)).rejects.toBeInstanceOf(SchedulerError);
  });
});

describe("TaskQueue progress + shutdown", () => {
  it("emits progress events and updates persisted progress", async () => {
    const { store, rows } = makeStore();
    const registry = new InMemoryTaskHandlerRegistry();
    registry.register({
      type: "progress",
      description: "",
      handler: async (ctx) => {
        ctx.reportProgress({ step: "a", current: 1, total: 4 });
        ctx.reportProgress({ step: "b", current: 4, total: 4 });
        return {};
      },
    });
    const { emitter, progress } = makeEmitter();
    const queue = new TaskQueue(store, registry, emitter, baseConfig);
    const task = await queue.enqueue({ type: "progress" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(progress.filter((p) => p.taskId === task.id).length).toBeGreaterThanOrEqual(2);
    expect(rows.get(task.id)?.progress).toBe(100);
  });

  it("rejects new enqueues after shutdown", async () => {
    const { store } = makeStore();
    const registry = new InMemoryTaskHandlerRegistry();
    registry.register({ type: "ok", description: "", handler: async () => ({}) });
    const { emitter } = makeEmitter();
    const queue = new TaskQueue(store, registry, emitter, baseConfig);
    await queue.shutdown();
    await expect(queue.enqueue({ type: "ok" })).rejects.toBeInstanceOf(SchedulerError);
  });

  it("snapshot reports queue depth and running count", async () => {
    const { store } = makeStore();
    const registry = new InMemoryTaskHandlerRegistry();
    registry.register({
      type: "blocker",
      description: "",
      handler: async () => new Promise(() => {}),
    });
    const { emitter } = makeEmitter();
    const queue = new TaskQueue(store, registry, emitter, { ...baseConfig, concurrency: 1 });
    await queue.enqueue({ type: "blocker" });
    await queue.enqueue({ type: "blocker" });
    await new Promise((r) => setImmediate(r));
    const snap = queue.snapshot();
    expect(snap.running).toBe(1);
    expect(snap.queueDepth).toBe(1);
  });
});
