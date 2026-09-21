/** Real queue + service startup + built-in publication handler; external stores are in memory. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@prisma/client";
import type { SchedulerConfig, TaskHandlerFn } from "../src/lib/scheduler/types.js";

const state = vi.hoisted(() => ({
  tasks: new Map<string, Task>(),
  documents: new Map<string, Record<string, unknown>>(),
  quarantine: new Set<string>(),
  sql: new Set<string>(),
  vectors: new Set<string>(),
  sparse: new Set<string>(),
  deleted: false,
  publicationCalls: 0,
}));

type TaskFilter = {
  id?: string;
  type?: string;
  status?: string | { in: string[] };
  updatedAt?: { lt: Date };
};
function matches(row: Task, where: TaskFilter): boolean {
  return (
    (!where.id || row.id === where.id) &&
    (!where.type || row.type === where.type) &&
    (!where.status ||
      (typeof where.status === "string"
        ? row.status === where.status
        : where.status.in.includes(row.status))) &&
    (!where.updatedAt || row.updatedAt < where.updatedAt.lt)
  );
}

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    scheduledJob: { findMany: async () => [] },
    task: {
      create: async ({ data }: { data: Partial<Task> }) => {
        const row = {
          id: `task-${state.tasks.size + 1}`,
          scheduledJobId: null,
          projectId: null,
          type: "",
          trigger: "manual",
          status: "pending",
          priority: 5,
          payload: "{}",
          result: null,
          errorMessage: null,
          progress: null,
          attempts: 0,
          maxAttempts: 3,
          scheduledFor: null,
          startedAt: null,
          completedAt: null,
          createdById: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        } as Task;
        state.tasks.set(row.id, row);
        return { ...row };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Task> }) => {
        const row = state.tasks.get(where.id)!;
        Object.assign(row, data, { updatedAt: new Date() });
        return { ...row };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: TaskFilter;
        data: Omit<Partial<Task>, "attempts"> & { attempts?: number | { increment: number } };
      }) => {
        const rows = [...state.tasks.values()].filter((row) => matches(row, where));
        rows.forEach((row) => {
          const attempts =
            typeof data.attempts === "object"
              ? row.attempts + data.attempts.increment
              : data.attempts;
          Object.assign(row, data, {
            ...(attempts === undefined ? {} : { attempts }),
            updatedAt: new Date(),
          });
        });
        return { count: rows.length };
      },
      findMany: async ({ where }: { where: TaskFilter }) =>
        [...state.tasks.values()].filter((row) => matches(row, where)).map((row) => ({ ...row })),
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = state.tasks.get(where.id);
        return row ? { ...row } : null;
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const row = state.tasks.get(where.id);
        if (!row) throw new Error("Task not found");
        return { ...row };
      },
    },
    generatedDocument: {
      findFirst: async () => ({
        id: "doc",
        projectId: "project",
        title: "Example",
        scope: "full",
        scopeFilter: "{}",
        deletedAt: state.deleted ? new Date() : null,
        evidencePolicy: "{}",
      }),
    },
    generatedDocumentVersion: {
      findFirst: async () => ({
        version: 1,
        revisionId: "revision",
        content: "# Example\n\nEvidence.",
      }),
      findMany: async () => [],
    },
    document: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = state.documents.get(where.id);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { id: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const row = state.documents.get(where.id);
        state.documents.set(where.id, row ? { ...row, ...update } : create);
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        state.documents.set(where.id, { ...state.documents.get(where.id), ...data });
      },
    },
    quarantineChunk: {
      deleteMany: async ({ where }: { where: { documentId: string } }) => {
        state.quarantine.delete(where.documentId);
      },
    },
    knowledgeChunk: {
      deleteMany: async ({ where }: { where: { documentId: string } }) => {
        state.sql.delete(where.documentId);
      },
    },
  },
}));
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/logger.js", () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../src/lib/scheduler/index.js", () => ({ getSchedulerBootstrap: vi.fn() }));
vi.mock("../src/lib/docs-gen/evidence-policy.js", () => ({
  resolveEvidencePolicy: async () => ({ actor: { userId: "actor" }, aclSubjects: [] }),
}));
vi.mock("../src/lib/documents/storage.js", () => ({
  getDocumentStorage: () => ({
    write: async () => ({ storagePath: "doc.md", checksum: "hash", sizeBytes: 20 }),
  }),
}));
vi.mock("../src/lib/rag/embedder.js", () => ({
  getEmbedder: () => ({ embed: async () => ({ model: "test", vectors: [[1, 0]] }) }),
}));
vi.mock("../src/lib/rag/quarantine.js", () => ({
  writeQuarantine: async ({ documentId }: { documentId: string }) => {
    state.quarantine.add(documentId);
  },
  shouldAutoApprove: async () => true,
  approveDocument: async (id: string) => {
    state.sql.add(id);
    state.vectors.add(id);
    state.sparse.add(id);
    state.quarantine.delete(id);
    Object.assign(state.documents.get(id)!, { status: "ready", indexState: "indexed" });
    return { chunkCount: 1 };
  },
}));
vi.mock("../src/lib/rag/vector-store.js", () => ({
  getVectorStore: () => ({
    deleteByDocument: async (_project: string, id: string) => {
      state.vectors.delete(id);
    },
  }),
}));
vi.mock("../src/lib/rag/bm25-index.js", () => ({
  getBM25Index: () => ({
    removeDocument: async (_project: string, id: string) => {
      state.sparse.delete(id);
    },
  }),
}));

import { TaskQueue } from "../src/lib/scheduler/task-queue.js";
import { SchedulerService } from "../src/lib/scheduler/scheduler-service.js";
import { createPrismaTaskStore } from "../src/lib/scheduler/task-store.js";
import {
  InMemoryTaskHandlerRegistry,
  registerBuiltInHandlers,
} from "../src/lib/scheduler/task-handlers.js";
import { publishGeneratedDocRevision } from "../src/lib/docs-gen/generated-doc-publication.js";

const config: SchedulerConfig = {
  concurrency: 1,
  tickMs: 1000,
  defaultTimeoutMs: 30_000,
  retryBackoffMs: 100,
  retryBackoffMaxMs: 1000,
  minCronIntervalSec: 60,
  enabled: true,
};
const input = {
  type: "publish-generated-document",
  projectId: "project",
  createdById: "actor",
  payload: { generatedDocumentId: "doc", projectId: "project", version: 1, revisionId: "revision" },
};
const instances: Array<{ queue: TaskQueue; service: SchedulerService }> = [];
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function runtime(handler?: TaskHandlerFn, concurrency = 1) {
  const registry = new InMemoryTaskHandlerRegistry();
  registerBuiltInHandlers(registry, {
    httpWebhookHandler: async () => {},
    publishGeneratedDocument: async (
      generatedDocumentId,
      projectId,
      version,
      revisionId,
      signal,
    ) => {
      signal.throwIfAborted();
      state.publicationCalls++;
      const result = await publishGeneratedDocRevision({
        generatedDocumentId,
        projectId,
        version,
        revisionId,
      });
      signal.throwIfAborted();
      return result;
    },
  });
  if (handler)
    registry.register({ type: input.type, description: "controlled interruption", handler });
  const emitter = { taskStatus() {}, taskProgress() {}, schedulerStatus() {} };
  const queue = new TaskQueue(createPrismaTaskStore(), registry, emitter, {
    ...config,
    concurrency,
  });
  const service = new SchedulerService({ queue, registry, emitter, config });
  const instance = { queue, service, registry };
  instances.push(instance);
  return instance;
}

function expectConverged(cleanup: boolean) {
  expect([...state.tasks.values()]).toHaveLength(1);
  expect([...state.tasks.values()][0]).toMatchObject({
    status: "completed",
    projectId: input.projectId,
    createdById: input.createdById,
    payload: JSON.stringify(input.payload),
  });
  expect(state.documents.get(cleanup ? "gendoc-doc" : "gendoc-doc:revision")).toMatchObject(
    cleanup
      ? { indexState: "rejected", status: "failed" }
      : { indexState: "indexed", status: "ready" },
  );
  expect(state.quarantine.size).toBe(0);
  for (const index of [state.sql, state.vectors, state.sparse]) {
    expect([...index]).toEqual(cleanup ? [] : ["gendoc-doc:revision"]);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-18T12:00:00Z"));
  state.tasks.clear();
  state.documents.clear();
  for (const index of [state.quarantine, state.sql, state.vectors, state.sparse]) index.clear();
  state.deleted = false;
  state.publicationCalls = 0;
});
afterEach(async () => {
  for (const { service, queue } of instances.splice(0)) {
    await service.stop();
    await queue.shutdown();
  }
  await vi.advanceTimersByTimeAsync(0);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe.each([false, true])("durable publication recovery (cleanup=%s)", (cleanup) => {
  beforeEach(() => {
    state.deleted = cleanup;
    if (cleanup) {
      state.documents.set("gendoc-doc", { status: "ready", indexState: "indexed" });
      for (const index of [state.quarantine, state.sql, state.vectors, state.sparse])
        index.add("gendoc-doc");
    }
  });

  it.each(["pending", "running", "retry"])(
    "replays %s work after graceful shutdown through the actual handler",
    async (phase) => {
      const barrier = deferred();
      const first = runtime(
        async ({ signal }) => {
          if (phase === "retry") throw new Error("transient");
          await barrier.promise;
          signal.throwIfAborted();
        },
        phase === "pending" ? 0 : 1,
      );
      const task = await first.queue.enqueue(input);
      await vi.advanceTimersByTimeAsync(0);
      expect(state.tasks.get(task.id)?.status).toBe(phase === "running" ? "running" : "pending");
      await first.queue.shutdown();
      barrier.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(state.tasks.get(task.id)?.status).toBe("pending");
      expect(vi.getTimerCount()).toBe(0);
      const second = runtime();
      await second.service.start();
      await vi.advanceTimersByTimeAsync(0);
      expectConverged(cleanup);
      expect(state.publicationCalls).toBe(1);
      await second.service.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(state.publicationCalls).toBe(1);
    },
  );

  it.each(["pending", "running", "retry"])(
    "recovers a crash snapshot with %s work to convergence",
    async (phase) => {
      const barrier = deferred();
      const first = runtime(
        async () => {
          if (phase === "retry") throw new Error("transient");
          // Simulate a side effect committed before the process died / task completion persisted.
          if (phase === "running") {
            await publishGeneratedDocRevision(input.payload);
            await barrier.promise;
          }
        },
        phase === "pending" ? 0 : 1,
      );
      const task = await first.queue.enqueue(input);
      await vi.advanceTimersByTimeAsync(0);
      const snapshot = structuredClone(state.tasks.get(task.id)!);
      expect(snapshot.status).toBe(phase === "running" ? "running" : "pending");
      // Dispose the old process's timers, then restore exactly the durable pre-crash image.
      await first.queue.shutdown();
      barrier.resolve();
      await vi.advanceTimersByTimeAsync(0);
      state.tasks.set(task.id, snapshot);
      const second = runtime();
      await second.service.start();
      await vi.advanceTimersByTimeAsync(0);
      if (phase === "running") {
        expect(state.publicationCalls).toBe(0); // Do not steal a fresh running attempt.
        await vi.advanceTimersByTimeAsync(60_000);
      }
      expectConverged(cleanup);
      expect(state.publicationCalls).toBe(1);
      expect(state.tasks.get(task.id)?.attempts).toBe(phase === "pending" ? 1 : 2);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(state.publicationCalls).toBe(1);
    },
  );

  it.each(["before", "after"])(
    "never revives explicit running cancellation %s shutdown",
    async (order) => {
      const barrier = deferred();
      const first = runtime(async () => barrier.promise);
      const task = await first.queue.enqueue(input);
      await vi.advanceTimersByTimeAsync(0);
      if (order === "before") await first.queue.cancel(task.id);
      await first.queue.shutdown();
      if (order === "after") await first.queue.cancel(task.id);
      // Cancellation must already be durable even if the process dies before the handler settles.
      const snapshot = structuredClone(state.tasks.get(task.id)!);
      barrier.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(snapshot.status).toBe("cancelled");
      state.tasks.set(task.id, snapshot);
      const second = runtime();
      await second.service.start();
      await vi.advanceTimersByTimeAsync(180_000);
      expect(state.tasks.get(task.id)?.status).toBe("cancelled");
      expect(state.publicationCalls).toBe(0);
    },
  );

  it("does not revive cancelled pending work or terminal failures", async () => {
    const first = runtime(undefined, 0);
    const task = await first.queue.enqueue(input);
    await first.queue.cancel(task.id);
    await first.queue.shutdown();
    const failed = await createPrismaTaskStore().create({ ...input, now: new Date() });
    await createPrismaTaskStore().markFailed(failed.id, "exhausted", new Date());
    const second = runtime();
    await second.service.start();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(state.tasks.get(task.id)?.status).toBe("cancelled");
    expect(state.tasks.get(failed.id)?.status).toBe("failed");
    expect(state.publicationCalls).toBe(0);
  });

  it("deduplicates recovery while work is running and while it waits for a slot", async () => {
    const barrier = deferred();
    const first = runtime(undefined, 0);
    const task = await first.queue.enqueue(input);
    const other = await first.queue.enqueue(input);
    await first.queue.shutdown();
    const calls: string[] = [];
    const second = runtime(async ({ task: record }) => {
      calls.push(record.id);
      await barrier.promise;
      await publishGeneratedDocRevision(input.payload);
    });
    await second.service.start();
    await second.service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([task.id]);
    expect(second.queue.snapshot()).toMatchObject({ running: 1, queueDepth: 1 });
    barrier.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([task.id, other.id]);
    expect([...state.tasks.values()].map((row) => row.status)).toEqual(["completed", "completed"]);
    await second.service.start();
    expect(calls).toHaveLength(2);
  });

  it("uses a strict handler-timeout cutoff for crash recovery, leaving fresh work untouched", async () => {
    const task = await createPrismaTaskStore().create({ ...input, now: new Date() });
    await createPrismaTaskStore().markRunning(task.id, 1, new Date());
    const second = runtime();
    const registration = second.registry.get(input.type)!;
    second.registry.register({ ...registration, defaultTimeoutMs: 120_000 });
    await second.service.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(state.tasks.get(task.id)?.status).toBe("running");
    expect(state.publicationCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expectConverged(cleanup);
    expect(state.publicationCalls).toBe(1);
  });

  it("retries a handler failure after startup with the existing backoff and same row", async () => {
    const task = await createPrismaTaskStore().create({ ...input, now: new Date() });
    let attempts = 0;
    const second = runtime(async () => {
      attempts++;
      if (attempts === 1) throw new Error("transient on recovery");
      await publishGeneratedDocRevision(input.payload);
    });
    await second.service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.tasks.get(task.id)).toMatchObject({ status: "pending", attempts: 1 });
    await vi.advanceTimersByTimeAsync(99);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2);
    expectConverged(cleanup);
  });
});
