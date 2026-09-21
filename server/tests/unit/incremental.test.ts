import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@prisma/client";
import { z } from "zod";
import { AppError } from "../../src/middleware/error-handler.js";
import {
  fingerprintInputs,
  inputHash,
  regenerationTaskSchema,
} from "../../src/lib/docs-gen/regeneration-plan.js";
import type { TaskQueue as Queue } from "../../src/lib/scheduler/task-queue.js";

const state = vi.hoisted(() => ({
  tasks: new Map<string, Task>(),
  queue: null as Queue | null,
  findDocs: vi.fn(),
  latestVersion: vi.fn(),
  policy: vi.fn(),
  snapshot: vi.fn(),
  parseManifest: vi.fn(),
  generate: vi.fn(),
  warn: vi.fn(),
  beforeReset: null as (() => void) | null,
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    generatedDocument: { findMany: state.findDocs },
    generatedDocumentVersion: { findFirst: state.latestVersion },
    task: {
      upsert: vi.fn(async ({ where, create }) => {
        if (!state.tasks.has(where.id))
          state.tasks.set(where.id, {
            scheduledJobId: null,
            trigger: "manual",
            status: "pending",
            priority: 5,
            result: null,
            errorMessage: null,
            progress: null,
            attempts: 0,
            scheduledFor: null,
            startedAt: null,
            completedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...create,
          });
        return { ...state.tasks.get(where.id)! };
      }),
      findUnique: vi.fn(async ({ where }) => {
        const row = state.tasks.get(where.id);
        return row ? { ...row } : null;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        if (where.status === "failed") state.beforeReset?.();
        const row = state.tasks.get(where.id);
        if (
          !row ||
          !(typeof where.status === "string"
            ? row.status === where.status
            : where.status.in.includes(row.status))
        )
          return { count: 0 };
        const attempts =
          typeof data.attempts === "object"
            ? row.attempts + data.attempts.increment
            : data.attempts;
        Object.assign(row, data, {
          ...(attempts === undefined ? {} : { attempts }),
          updatedAt: new Date(),
        });
        return { count: 1 };
      }),
      findUniqueOrThrow: vi.fn(async ({ where }) => {
        const row = state.tasks.get(where.id);
        if (!row) throw new Error("Task not found");
        return { ...row };
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = state.tasks.get(where.id)!;
        Object.assign(row, data, { updatedAt: new Date() });
        return { ...row };
      }),
    },
  },
}));
vi.mock("../../src/lib/scheduler/index.js", () => ({
  getSchedulerBootstrap: () => ({ queue: state.queue }),
}));
vi.mock("../../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../../src/lib/logger.js", () => ({ createChildLogger: () => ({ warn: state.warn }) }));
vi.mock("../../src/lib/docs-gen/evidence-policy.js", () => ({
  resolveEvidencePolicy: state.policy,
}));
vi.mock("../../src/lib/docs-gen/generation-inputs.js", () => ({
  captureGenerationInputs: state.snapshot,
}));
vi.mock("../../src/lib/docs-gen/generated-doc-provenance.js", () => ({
  parseGeneratedDocVersionManifest: state.parseManifest,
}));
vi.mock("../../src/routes/generated-docs.js", () => ({ generateDocumentAsync: state.generate }));

import { prisma } from "../../src/lib/prisma.js";
import {
  checkIncrementalRegeneration,
  runRegenerationTask,
  REGENERATE_DOCUMENT_TASK,
} from "../../src/lib/docs-gen/incremental.js";
import { TaskQueue } from "../../src/lib/scheduler/task-queue.js";
import { createPrismaTaskStore, readTaskRecord } from "../../src/lib/scheduler/task-store.js";
import {
  InMemoryTaskHandlerRegistry,
  registerBuiltInHandlers,
} from "../../src/lib/scheduler/task-handlers.js";
import { SCHEDULER_DEFAULTS } from "../../src/lib/scheduler/config.js";

const current = fingerprintInputs({ "repo:r": "new" });
const payload = {
  projectId: "p",
  generatedDocumentId: "d",
  expectedVersion: 1,
  fingerprint: current.fingerprint,
};
const taskId = `docs-regen:${inputHash(payload)}`;
const document = { id: "d", scope: "repository", scopeFilter: '{"repoConnectorId":"r"}' };
const queues: TaskQueue[] = [];

function makeQueue(concurrency = 1) {
  const registry = new InMemoryTaskHandlerRegistry();
  registerBuiltInHandlers(registry, {
    httpWebhookHandler: vi.fn(),
    regenerateGeneratedDocument: runRegenerationTask,
  });
  const queue = new TaskQueue(
    createPrismaTaskStore(),
    registry,
    {
      schedulerStatus: vi.fn(),
      taskStatus: vi.fn(),
      taskProgress: vi.fn(),
    },
    { ...SCHEDULER_DEFAULTS, concurrency, retryBackoffMs: 1, retryBackoffMaxMs: 2 },
  );
  queues.push(queue);
  state.queue = queue;
  return queue;
}

async function settle() {
  await vi.waitFor(() =>
    expect(state.queue!.snapshot()).toMatchObject({ running: 0, queueDepth: 0 }),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  state.tasks.clear();
  state.beforeReset = null;
  state.findDocs.mockResolvedValue([document]);
  state.latestVersion.mockResolvedValue({ version: 1, provenanceManifest: "manifest" });
  state.parseManifest.mockReturnValue({ inputSnapshot: fingerprintInputs({ "repo:r": "old" }) });
  state.policy.mockResolvedValue({ actor: { userId: "u" } });
  state.snapshot.mockResolvedValue(current);
  state.generate.mockResolvedValue(undefined);
  makeQueue();
});

afterEach(async () => {
  for (const queue of queues.splice(0)) await queue.shutdown();
});

describe("regeneration durable payload #1356", () => {
  const valid = {
    projectId: "p",
    generatedDocumentId: "d",
    expectedVersion: 1,
    fingerprint: "sha256",
  };
  it("accepts only revision-fenced identities, never caller-supplied actors or scope", () => {
    expect(regenerationTaskSchema.parse(valid)).toEqual(valid);
    expect(regenerationTaskSchema.safeParse({ ...valid, actorId: "admin" }).success).toBe(false);
    expect(regenerationTaskSchema.safeParse({ ...valid, scope: "full" }).success).toBe(false);
  });
  it.each([
    { projectId: "" },
    { generatedDocumentId: "" },
    { expectedVersion: -1 },
    { expectedVersion: 0.5 },
    { fingerprint: "" },
  ])("rejects invalid fencing fields %j", (bad) => {
    expect(regenerationTaskSchema.safeParse({ ...valid, ...bad }).success).toBe(false);
  });
});

describe("successful ingestion durable regeneration #1356", () => {
  it.each(["cancelled", "completed", "failed"])(
    "task fixture preserves terminal %s against every late store transition",
    async (status) => {
      makeQueue(0);
      await checkIncrementalRegeneration("p", "r");
      const row = state.tasks.get(taskId)!;
      Object.assign(row, { status, attempts: 2, errorMessage: "original", progress: 73 });
      const before = { ...row };
      const store = createPrismaTaskStore();
      expect(await store.markRunning(taskId, 99, new Date())).toBeNull();
      for (const task of [
        await store.markRetrying(taskId, "late retry", new Date()),
        await store.markCompleted(taskId, { late: true }, new Date()),
        await store.markFailed(taskId, "late failure", new Date()),
        await store.markCancelled(taskId, "late cancellation", new Date()),
      ])
        expect(task.status).toBe(status);
      await store.updateProgress(taskId, 99);
      expect(state.tasks.get(taskId)).toEqual(before);
      expect(state.generate).not.toHaveBeenCalled();
    },
  );

  it("task fixture increments persisted attempts and rejects a second running claim", async () => {
    makeQueue(0);
    await checkIncrementalRegeneration("p", "r");
    state.tasks.get(taskId)!.attempts = 2;
    const store = createPrismaTaskStore();
    expect(await store.markRunning(taskId, 1, new Date())).toMatchObject({
      status: "running",
      attempts: 3,
    });
    const before = { ...state.tasks.get(taskId)! };
    expect(await store.markRunning(taskId, 1, new Date())).toBeNull();
    expect(state.tasks.get(taskId)).toEqual(before);
    const snapshot = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    await store.markRetrying(taskId, "retry", new Date());
    expect(snapshot).toMatchObject({ status: "running", attempts: 3 });
    expect(state.tasks.get(taskId)).toMatchObject({ status: "pending", attempts: 3 });
    await expect(store.markRunning("missing", 1, new Date())).rejects.toThrow("Task not found");
    expect(state.tasks.has("missing")).toBe(false);
  });

  it("persists one task and executes through the real queue, store and registry", async () => {
    await checkIncrementalRegeneration("p", "r");
    await settle();
    expect(state.tasks.size).toBe(1);
    expect(await readTaskRecord(taskId)).toMatchObject({
      type: REGENERATE_DOCUMENT_TASK,
      projectId: "p",
      createdById: "u",
      payload,
      status: "completed",
      attempts: 1,
      maxAttempts: 3,
      progress: 100,
    });
    expect(state.generate).toHaveBeenCalledWith("d", "p", {
      ...payload,
      signal: expect.any(AbortSignal),
    });
    expect(prisma.generatedDocument.findMany).toHaveBeenCalledWith({
      select: {
        id: true,
        projectId: true,
        title: true,
        scope: true,
        scopeFilter: true,
        evidencePolicy: true,
      },
      where: {
        projectId: "p",
        autoUpdate: true,
        deletedAt: null,
        status: { in: ["ready", "degraded", "failed", "generating"] },
        scope: { in: ["full", "repository", "module", "symbol"] },
      },
    });
  });

  it("rearms an exhausted failed task on the next successful ingest, resetting durable attempt state", async () => {
    state.generate.mockRejectedValue(new Error("generation unavailable"));
    await checkIncrementalRegeneration("p", "r");
    await settle();
    expect(state.tasks.get(taskId)).toMatchObject({ status: "failed", attempts: 3 });
    expect(state.generate).toHaveBeenCalledTimes(3);

    // The same persisted row must survive replacing the queue (process restart).
    await state.queue!.shutdown();
    makeQueue(0);
    Object.assign(state.tasks.get(taskId)!, { progress: 75, result: '{"stale":true}' });
    await checkIncrementalRegeneration("p", "r");
    expect(await readTaskRecord(taskId)).toMatchObject({
      status: "pending",
      attempts: 0,
      startedAt: null,
      completedAt: null,
      errorMessage: null,
      progress: null,
      result: null,
    });
    expect(prisma.task.updateMany).toHaveBeenCalledWith({
      where: { id: taskId, status: "failed" },
      data: {
        status: "pending",
        attempts: 0,
        startedAt: null,
        completedAt: null,
        errorMessage: null,
        progress: null,
        result: null,
      },
    });
    state.generate.mockResolvedValue(undefined);
    const restarted = makeQueue();
    restarted.resume((await readTaskRecord(taskId))!);
    await settle();
    expect(state.tasks.size).toBe(1);
    expect(state.tasks.get(taskId)).toMatchObject({ status: "completed", attempts: 1 });
    expect(state.generate).toHaveBeenCalledTimes(4);
  });

  it.each(["pending", "running", "completed", "cancelled"])(
    "does not reset an existing %s task",
    async (status) => {
      makeQueue(0);
      await checkIncrementalRegeneration("p", "r");
      Object.assign(state.tasks.get(taskId)!, { status, attempts: 2, errorMessage: "retained" });
      const before = { ...state.tasks.get(taskId)! };
      await Promise.all([
        checkIncrementalRegeneration("p", "r"),
        checkIncrementalRegeneration("p", "r"),
      ]);
      expect(state.tasks.size).toBe(1);
      expect(state.tasks.get(taskId)).toEqual(before);
      expect(prisma.task.updateMany).not.toHaveBeenCalled();
      expect(state.generate).not.toHaveBeenCalled();
      expect(state.queue!.snapshot().queueDepth).toBe(1);
    },
  );

  it.each(["running", "completed", "cancelled"])(
    "does not overwrite a failed task concurrently changed to %s",
    async (status) => {
      makeQueue(0);
      await checkIncrementalRegeneration("p", "r");
      Object.assign(state.tasks.get(taskId)!, { status: "failed", attempts: 3 });
      state.beforeReset = () => {
        state.tasks.get(taskId)!.status = status;
      };
      await checkIncrementalRegeneration("p", "r");
      expect(state.tasks.get(taskId)).toMatchObject({ status, attempts: 3 });
      expect(state.generate).not.toHaveBeenCalled();
    },
  );

  it("concurrent ingest replay reuses the same active task", async () => {
    let complete!: () => void;
    state.generate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    await checkIncrementalRegeneration("p", "r");
    await vi.waitFor(() => expect(state.generate).toHaveBeenCalledTimes(1));
    await Promise.all([
      checkIncrementalRegeneration("p", "r"),
      checkIncrementalRegeneration("p", "r"),
    ]);
    expect(state.tasks.size).toBe(1);
    expect(state.generate).toHaveBeenCalledTimes(1);
    complete();
    await settle();
    await checkIncrementalRegeneration("p", "r");
    expect(state.generate).toHaveBeenCalledTimes(1);
  });

  it("preserves a manual queue cancellation across subsequent successful ingests", async () => {
    state.generate.mockImplementation(
      (_id, _project, options: { signal: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("cancelled by user")), {
            once: true,
          });
        }),
    );
    await checkIncrementalRegeneration("p", "r");
    await vi.waitFor(() => expect(state.generate).toHaveBeenCalledTimes(1));
    expect(await state.queue!.cancel(taskId)).toBe(true);
    await settle();
    expect(await readTaskRecord(taskId)).toMatchObject({ status: "cancelled", attempts: 1 });
    vi.mocked(prisma.task.updateMany).mockClear();
    await checkIncrementalRegeneration("p", "r");
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(prisma.task.updateMany).not.toHaveBeenCalled();
    expect(await readTaskRecord(taskId)).toMatchObject({ status: "cancelled", attempts: 1 });
  });

  it("concurrent successful ingests rearm a failed task only once", async () => {
    state.generate.mockRejectedValue(new Error("unavailable"));
    await checkIncrementalRegeneration("p", "r");
    await settle();
    state.generate.mockResolvedValue(undefined);
    await Promise.all([
      checkIncrementalRegeneration("p", "r"),
      checkIncrementalRegeneration("p", "r"),
    ]);
    await settle();
    expect(state.tasks.size).toBe(1);
    expect(state.generate).toHaveBeenCalledTimes(4);
    expect(await readTaskRecord(taskId)).toMatchObject({ status: "completed", attempts: 1 });
  });

  it("skips an unrelated repository before resolving evidence", async () => {
    await checkIncrementalRegeneration("p", "other");
    expect(state.policy).not.toHaveBeenCalled();
    expect(prisma.task.upsert).not.toHaveBeenCalled();
  });

  it.each(["full", "repository", "module", "symbol"])(
    "supports %s scope with no connector filter",
    async (scope) => {
      state.findDocs.mockResolvedValue([{ ...document, scope }]);
      await checkIncrementalRegeneration("p");
      await settle();
      expect(state.generate).toHaveBeenCalledTimes(1);
    },
  );

  it("skips unchanged inputs and empty document sets", async () => {
    state.parseManifest.mockReturnValue({ inputSnapshot: current });
    await checkIncrementalRegeneration("p", "r");
    state.findDocs.mockResolvedValue([]);
    await checkIncrementalRegeneration("p", "r");
    expect(prisma.task.upsert).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { version: 1, provenanceManifest: null },
    { version: 1, provenanceManifest: "legacy" },
  ])("schedules legacy documents without an input snapshot: %j", async (latest) => {
    state.latestVersion.mockResolvedValue(latest);
    state.parseManifest.mockReturnValue({});
    await checkIncrementalRegeneration("p", "r");
    await settle();
    expect(state.generate).toHaveBeenCalledWith("d", "p", {
      ...payload,
      expectedVersion: latest?.version ?? 0,
      signal: expect.any(AbortSignal),
    });
  });

  it("leaves no in-memory work when the persisted task disappears before readback", async () => {
    vi.mocked(prisma.task.findUnique).mockResolvedValueOnce(null);
    await checkIncrementalRegeneration("p", "r");
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.queue!.snapshot()).toMatchObject({ running: 0, queueDepth: 0 });
    await checkIncrementalRegeneration("p", "r");
    await settle();
    expect(state.generate).toHaveBeenCalledTimes(1);
  });

  it("propagates scheduling failures so successful ingestion can replay", async () => {
    vi.mocked(prisma.task.upsert).mockRejectedValueOnce(new Error("outbox unavailable"));
    await expect(checkIncrementalRegeneration("p", "r")).rejects.toThrow("outbox unavailable");
    expect(state.generate).not.toHaveBeenCalled();
    await checkIncrementalRegeneration("p", "r");
    await settle();
    expect(state.generate).toHaveBeenCalledTimes(1);
  });

  it("forwards the exact signal and propagates production generation errors", async () => {
    const signal = new AbortController().signal;
    state.generate.mockRejectedValueOnce(new Error("generation failed"));
    await expect(runRegenerationTask(payload, signal)).rejects.toThrow("generation failed");
    expect(state.generate).toHaveBeenCalledWith("d", "p", { ...payload, signal });
  });

  it.each([
    new AppError(403, "GENERATION_AUTH_UNAVAILABLE", "secret policy"),
    new AppError(404, "NOT_FOUND", "secret workspace"),
    new AppError(404, "REPOSITORY_GRAPH_UNAVAILABLE", "secret repository"),
  ])("skips permanent authorization failure %s and schedules later documents", async (error) => {
    state.findDocs.mockResolvedValue([{ ...document, id: "denied" }, document]);
    state.policy.mockRejectedValueOnce(error);
    await expect(checkIncrementalRegeneration("p", "r")).resolves.toBeUndefined();
    await settle();
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.generate).toHaveBeenCalledWith("d", "p", expect.anything());
    expect(state.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(state.warn.mock.calls)).not.toContain("secret");
  });

  it.each([
    "{secret",
    "null",
    "[]",
    '"secret"',
    "{}",
    '{"repoConnectorId":3}',
    '{"repoConnectorId":" "}',
  ])("skips malformed repository scope %s before any evidence capture", async (scopeFilter) => {
    state.findDocs.mockResolvedValue([{ ...document, id: "bad", scopeFilter }, document]);
    await expect(checkIncrementalRegeneration("p", "r")).resolves.toBeUndefined();
    await settle();
    expect(state.policy).toHaveBeenCalledTimes(1);
    expect(state.snapshot).toHaveBeenCalledTimes(1);
    expect(state.generate).toHaveBeenCalledWith("d", "p", expect.anything());
    expect(state.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(state.warn.mock.calls)).not.toContain("secret");
  });

  it.each(["full", "module", "symbol"])(
    "validates malformed %s scope even without a connector filter",
    async (scope) => {
      state.findDocs.mockResolvedValue([
        { ...document, id: "bad", scope, scopeFilter: "null" },
        document,
      ]);
      await checkIncrementalRegeneration("p");
      await settle();
      expect(state.snapshot).toHaveBeenCalledTimes(1);
      expect(state.generate).toHaveBeenCalledWith("d", "p", expect.anything());
      expect(state.warn).toHaveBeenCalledTimes(1);
    },
  );

  it.each([new SyntaxError("secret manifest"), z.string().safeParse(null).error!])(
    "skips invalid persisted manifests, not later documents: %s",
    async (error) => {
      state.findDocs.mockResolvedValue([{ ...document, id: "bad" }, document]);
      state.parseManifest.mockImplementationOnce(() => {
        throw error;
      });
      await checkIncrementalRegeneration("p", "r");
      await settle();
      expect(state.generate).toHaveBeenCalledTimes(1);
      expect(state.generate).toHaveBeenCalledWith("d", "p", expect.anything());
      expect(state.warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(state.warn.mock.calls)).not.toContain("secret");
    },
  );

  it.each(["policy", "capture", "version", "enqueue", "readback", "resume"])(
    "attempts remaining documents before propagating retryable %s failure",
    async (stage) => {
      state.findDocs.mockResolvedValue([{ ...document, id: "retry" }, document]);
      const error = new Error("infrastructure unavailable");
      if (stage === "policy") state.policy.mockRejectedValueOnce(error);
      if (stage === "capture") state.snapshot.mockRejectedValueOnce(error);
      if (stage === "version") state.latestVersion.mockRejectedValueOnce(error);
      if (stage === "enqueue") vi.mocked(prisma.task.upsert).mockRejectedValueOnce(error);
      if (stage === "readback") vi.mocked(prisma.task.findUnique).mockRejectedValueOnce(error);
      if (stage === "resume")
        vi.spyOn(state.queue!, "resume").mockImplementationOnce(() => {
          throw error;
        });
      await expect(checkIncrementalRegeneration("p", "r")).rejects.toBe(error);
      await settle();
      expect(state.generate).toHaveBeenCalledWith("d", "p", expect.anything());
      expect(state.warn).not.toHaveBeenCalled();
      await checkIncrementalRegeneration("p", "r");
      await settle();
      expect(state.generate).toHaveBeenCalledWith("retry", "p", expect.anything());
      expect(state.tasks.size).toBe(2);
    },
  );

  it.each([
    new SyntaxError("capture bug"),
    z.string().safeParse(null).error!,
    new AppError(403, "GENERATION_AUTH_UNAVAILABLE", "capture failure"),
  ])("does not classify capture errors as malformed persisted inputs: %s", async (error) => {
    state.findDocs.mockResolvedValue([{ ...document, id: "retry" }, document]);
    state.snapshot.mockRejectedValueOnce(error);
    await expect(checkIncrementalRegeneration("p", "r")).rejects.toBe(error);
    await settle();
    expect(state.generate).toHaveBeenCalledWith("d", "p", expect.anything());
    expect(state.warn).not.toHaveBeenCalled();
  });

  it("keeps the first retryable failure while attempting all remaining documents", async () => {
    const first = new Error("first failure");
    state.findDocs.mockResolvedValue([
      { ...document, id: "first" },
      { ...document, id: "second" },
      document,
    ]);
    state.policy.mockRejectedValueOnce(first).mockRejectedValueOnce(new Error("second failure"));
    await expect(checkIncrementalRegeneration("p", "r")).rejects.toBe(first);
    await settle();
    expect(state.policy).toHaveBeenCalledTimes(3);
    expect(state.generate).toHaveBeenCalledWith("d", "p", expect.anything());
  });

  it("preserves a retryable failure across subsequent permanent skips and valid scheduling", async () => {
    const error = new Error("transient capture");
    state.findDocs.mockResolvedValue([
      { ...document, id: "retry" },
      { ...document, id: "legacy" },
      { ...document, id: "malformed", scopeFilter: "{secret" },
      document,
    ]);
    state.policy
      .mockResolvedValueOnce({ actor: { userId: "u" } })
      .mockRejectedValueOnce(new AppError(403, "GENERATION_AUTH_UNAVAILABLE", "secret policy"));
    state.snapshot.mockRejectedValueOnce(error);
    await expect(checkIncrementalRegeneration("p", "r")).rejects.toBe(error);
    await settle();
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.generate).toHaveBeenCalledWith("d", "p", expect.anything());
    expect(state.warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(state.warn.mock.calls)).not.toContain("secret");
  });
});
