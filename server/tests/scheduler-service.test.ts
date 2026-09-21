/**
 * SchedulerService — CRUD + manual trigger + cron lifecycle.
 *
 * Prisma is mocked with an in-memory store. Croner is real but every job is
 * created via `paused: true` semantics in the validator so no timers fire
 * during the tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ScheduledJobRow {
  id: string;
  key: string;
  name: string;
  cron: string;
  taskType: string;
  payload: string;
  projectId: string | null;
  enabled: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  maxAttempts: number;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

const jobsTable = new Map<string, ScheduledJobRow>();
let idCounter = 0;
const schedulerLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../src/lib/logger.js", () => ({ createChildLogger: () => schedulerLog }));

function taskRows(): Array<Record<string, unknown>> {
  return (globalThis as { __taskRows?: Array<Record<string, unknown>> }).__taskRows ?? [];
}

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    scheduledJob: {
      create: vi.fn(async ({ data }: { data: Partial<ScheduledJobRow> }) => {
        idCounter += 1;
        const row: ScheduledJobRow = {
          id: `job${idCounter}`,
          key: data.key!,
          name: data.name!,
          cron: data.cron!,
          taskType: data.taskType ?? "http-webhook",
          payload: data.payload ?? "{}",
          projectId: data.projectId ?? null,
          enabled: data.enabled ?? true,
          lastRunAt: data.lastRunAt ?? null,
          nextRunAt: data.nextRunAt ?? null,
          maxAttempts: data.maxAttempts ?? 3,
          createdById: data.createdById ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        };
        jobsTable.set(row.id, row);
        return row;
      }),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => jobsTable.get(where.id) ?? null,
      ),
      findMany: vi.fn(
        async (args: { where?: { deletedAt?: null; projectId?: string | null } } = {}) => {
          return Array.from(jobsTable.values()).filter((j) => {
            if (args.where?.deletedAt === null && j.deletedAt) return false;
            if (args.where?.projectId !== undefined && args.where.projectId !== j.projectId)
              return false;
            return true;
          });
        },
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<ScheduledJobRow> }) => {
          const r = jobsTable.get(where.id);
          if (!r) throw new Error("not found");
          Object.assign(r, data, { updatedAt: new Date() });
          return r;
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; OR: Array<{ lastFiredAt: null | { lt: Date } }> };
          data: { lastFiredAt: Date };
        }) => {
          const r = jobsTable.get(where.id);
          if (!r) return { count: 0 };
          const lf = (r as ScheduledJobRow & { lastFiredAt?: Date | null }).lastFiredAt ?? null;
          // Mirror the Prisma OR: lastFiredAt IS NULL OR lastFiredAt < instant.
          const matches = where.OR.some((cond) => {
            if ("lastFiredAt" in cond && cond.lastFiredAt === null) return lf === null;
            if (
              cond.lastFiredAt &&
              typeof cond.lastFiredAt === "object" &&
              "lt" in cond.lastFiredAt
            ) {
              return lf !== null && lf.getTime() < cond.lastFiredAt.lt.getTime();
            }
            return false;
          });
          if (!matches) return { count: 0 };
          (r as ScheduledJobRow & { lastFiredAt?: Date | null }).lastFiredAt = data.lastFiredAt;
          return { count: 1 };
        },
      ),
    },
    project: { findMany: vi.fn(async () => []) },
    task: {
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { type: string; status: string; updatedAt: { lt: Date } };
          data: { status: string };
        }) => {
          const matching = taskRows().filter(
            (row) =>
              row.type === where.type &&
              row.status === where.status &&
              row.updatedAt instanceof Date &&
              row.updatedAt < where.updatedAt.lt,
          );
          matching.forEach((row) => Object.assign(row, data));
          return { count: matching.length };
        },
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          taskRows().find((row) => row.id === where.id) ?? null,
      ),
      findMany: vi.fn(
        async (
          args: {
            where?: { scheduledJobId?: string; type?: string; status?: string | { in: string[] } };
          } = {},
        ) => {
          const all =
            (globalThis as { __taskRows?: Array<Record<string, unknown>> }).__taskRows ?? [];
          return all.filter((t) => {
            if (args.where?.type && t.type !== args.where.type) return false;
            if (args.where?.scheduledJobId && t.scheduledJobId !== args.where.scheduledJobId) {
              return false;
            }
            if (
              args.where?.status &&
              !(typeof args.where.status === "string"
                ? t.status === args.where.status
                : args.where.status.in.includes(String(t.status)))
            ) {
              return false;
            }
            return true;
          });
        },
      ),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  },
}));

import { SchedulerService } from "../src/lib/scheduler/scheduler-service.js";
import { prisma } from "../src/lib/prisma.js";
import { InMemoryTaskHandlerRegistry } from "../src/lib/scheduler/task-handlers.js";
import { TaskQueue, type TaskStore } from "../src/lib/scheduler/task-queue.js";
import {
  SchedulerError,
  type SchedulerConfig,
  type SchedulerEmitter,
  type TaskRecord,
} from "../src/lib/scheduler/types.js";

const baseConfig: SchedulerConfig = {
  concurrency: 4,
  tickMs: 1000,
  defaultTimeoutMs: 30_000,
  retryBackoffMs: 100,
  retryBackoffMaxMs: 1000,
  minCronIntervalSec: 60,
  enabled: true,
};

function makeStub(): {
  registry: InMemoryTaskHandlerRegistry;
  queue: TaskQueue;
  emitter: SchedulerEmitter;
  events: Array<{ jobId: string; status: string }>;
  enqueued: TaskRecord[];
} {
  const registry = new InMemoryTaskHandlerRegistry();
  registry.register({ type: "noop", description: "", handler: async () => ({}) });
  registry.register({ type: "http-webhook", description: "", handler: async () => ({}) });
  const enqueued: TaskRecord[] = [];
  const inMemoryStore: TaskStore = {
    async create(input) {
      const r: TaskRecord = {
        id: `t${enqueued.length + 1}`,
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
      enqueued.push(r);
      return r;
    },
    async markRunning(id, attempt, now) {
      const r = enqueued.find((x) => x.id === id)!;
      return { ...r, status: "running", attempts: attempt, startedAt: now };
    },
    async markCompleted(id, _result, now) {
      const r = enqueued.find((x) => x.id === id)!;
      return { ...r, status: "completed", completedAt: now };
    },
    async markFailed(id, error, now) {
      const r = enqueued.find((x) => x.id === id)!;
      return { ...r, status: "failed", errorMessage: error, completedAt: now };
    },
    async markCancelled(id, reason, now) {
      const r = enqueued.find((x) => x.id === id)!;
      return { ...r, status: "cancelled", errorMessage: reason, completedAt: now };
    },
    async markRetrying(id, error, now) {
      const r = enqueued.find((x) => x.id === id)!;
      return { ...r, status: "pending", errorMessage: error, updatedAt: now };
    },
    async updateProgress() {},
  };
  const events: Array<{ jobId: string; status: string }> = [];
  const emitter: SchedulerEmitter = {
    schedulerStatus(e) {
      events.push({ jobId: e.jobId, status: e.status });
    },
    taskStatus() {},
    taskProgress() {},
  };
  const queue = new TaskQueue(inMemoryStore, registry, emitter, baseConfig);
  return { registry, queue, emitter, events, enqueued };
}

beforeEach(() => {
  jobsTable.clear();
  idCounter = 0;
  (globalThis as { __taskRows?: Array<Record<string, unknown>> }).__taskRows = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("SchedulerService regeneration recovery (#1356)", () => {
  function seed(id: string, status = "pending", ageMs = 0, type = "regenerate-generated-document") {
    const row = {
      id,
      type,
      status,
      projectId: "p1",
      scheduledJobId: null,
      trigger: "scheduled",
      payload: JSON.stringify({
        projectId: "p1",
        generatedDocumentId: id,
        expectedVersion: 2,
        fingerprint: "hash",
      }),
      result: null,
      priority: 5,
      errorMessage: null,
      progress: null,
      attempts: 1,
      maxAttempts: 3,
      scheduledFor: null,
      startedAt: null,
      completedAt: null,
      createdById: null,
      createdAt: new Date(),
      updatedAt: new Date(Date.now() - ageMs),
    };
    taskRows().push(row);
    return row;
  }

  it("recovers pending and strictly expired running regeneration rows only", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T12:00:00Z"));
    seed("pending");
    seed("expired", "running", 7_200_001);
    seed("boundary", "running", 7_200_000);
    seed("active", "running", 60_000);
    seed("completed", "completed", 9_000_000);
    seed("failed", "failed", 9_000_000);
    seed("cancelled", "cancelled", 9_000_000);
    seed("other-pending", "pending", 0, "http-webhook");
    seed("other-running", "running", 9_000_000, "http-webhook");
    const deps = makeStub();
    const resume = vi.spyOn(deps.queue, "resume").mockImplementation(() => {});
    const svc = new SchedulerService({ ...deps, config: baseConfig });
    try {
      await svc.start();
      expect(prisma.task.updateMany).toHaveBeenCalledWith({
        where: {
          type: "regenerate-generated-document",
          status: "running",
          updatedAt: { lt: new Date("2026-09-18T10:00:00Z") },
        },
        data: { status: "pending" },
      });
      expect(prisma.task.findMany).toHaveBeenCalledWith({
        where: { type: "regenerate-generated-document", status: "pending" },
        select: { id: true },
      });
      expect(resume.mock.calls.map(([record]) => record.id)).toEqual(["pending", "expired"]);
      expect(resume.mock.calls[1][0]).toMatchObject({
        status: "pending",
        attempts: 1,
        payload: {
          projectId: "p1",
          generatedDocumentId: "expired",
          expectedVersion: 2,
          fingerprint: "hash",
        },
      });
      expect(
        taskRows()
          .filter((row) => row.status === "running")
          .map((row) => row.id),
      ).toEqual(["boundary", "active", "other-running"]);
    } finally {
      await svc.stop();
    }
  });

  it("skips a row deleted between the pending listing and record lookup", async () => {
    seed("deleted-during-read");
    vi.mocked(prisma.task.findUnique).mockResolvedValueOnce(null);
    const deps = makeStub();
    const resume = vi.spyOn(deps.queue, "resume").mockImplementation(() => {});
    const svc = new SchedulerService({ ...deps, config: baseConfig });
    try {
      await svc.start();
      expect(prisma.task.findUnique).toHaveBeenCalledWith({ where: { id: "deleted-during-read" } });
      expect(resume).not.toHaveBeenCalled();
    } finally {
      await svc.stop();
    }
  });

  it("recovers on each minute, replaces old recovery crons on restart, and stops them", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T12:00:00Z"));
    const deps = makeStub();
    const resume = vi.spyOn(deps.queue, "resume").mockImplementation(() => {});
    const svc = new SchedulerService({ ...deps, config: baseConfig });
    try {
      await svc.start();
      await svc.start();
      expect(prisma.task.updateMany).toHaveBeenCalledTimes(4);
      seed("arrived-after-start");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(prisma.task.updateMany).toHaveBeenCalledTimes(6);
      expect(resume).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: "arrived-after-start" }),
      );
      await svc.stop();
      await svc.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(prisma.task.updateMany).toHaveBeenCalledTimes(6);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await svc.stop();
    }
  });

  it("logs periodic recovery failures and retries on the next cron tick", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T12:00:00Z"));
    const deps = makeStub();
    const resume = vi.spyOn(deps.queue, "resume").mockImplementation(() => {});
    const svc = new SchedulerService({ ...deps, config: baseConfig });
    try {
      await svc.start();
      const error = new Error("database unavailable");
      vi.mocked(prisma.task.updateMany).mockRejectedValueOnce(error);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(schedulerLog.error).toHaveBeenCalledWith("Durable task recovery failed", {
        err: error,
      });
      seed("retry-on-next-tick");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(resume).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: "retry-on-next-tick" }),
      );
    } finally {
      await svc.stop();
    }
  });

  it("keeps scheduled-job crons working alongside recovery and stops both on shutdown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T12:00:00Z"));
    const deps = makeStub();
    const enqueue = vi.spyOn(deps.queue, "enqueue");
    const svc = new SchedulerService({ ...deps, config: baseConfig });
    try {
      await svc.start();
      const job = await svc.createJob({
        key: "with-recovery",
        name: "With recovery",
        cron: "* * * * *",
        taskType: "noop",
      });
      await svc.updateJob(job.id, { name: "Updated alongside recovery" });
      await svc.start();
      expect(svc.health().registeredJobs).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ scheduledJobId: job.id, trigger: "scheduled" }),
      );
      expect(prisma.task.updateMany).toHaveBeenCalledTimes(6);
      await svc.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(prisma.task.updateMany).toHaveBeenCalledTimes(6);
      expect(svc.health().registeredJobs).toBe(0);
    } finally {
      await svc.stop();
      await deps.queue.shutdown();
    }
  });

  it("propagates startup recovery failure and does not install a recovery timer", async () => {
    vi.useFakeTimers();
    const error = new Error("startup database unavailable");
    vi.mocked(prisma.task.updateMany).mockRejectedValueOnce(error);
    const svc = new SchedulerService({ ...makeStub(), config: baseConfig });
    try {
      await expect(svc.start()).rejects.toBe(error);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await svc.stop();
    }
  });

  it("does not recover or create timers while disabled", async () => {
    vi.useFakeTimers();
    const svc = new SchedulerService({ ...makeStub(), config: { ...baseConfig, enabled: false } });
    await svc.start();
    expect(prisma.task.updateMany).not.toHaveBeenCalled();
    expect(prisma.task.findMany).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await svc.stop();
  });
});

describe("SchedulerService.createJob", () => {
  it("validates cron, persists row, and emits a registered event", async () => {
    const { registry, queue, emitter, events } = makeStub();
    const svc = new SchedulerService({ registry, queue, emitter, config: baseConfig });
    const row = await svc.createJob({
      key: "every-15-min",
      name: "Every 15 min",
      cron: "*/15 * * * *",
      taskType: "noop",
      createdById: "user1",
    });
    expect(row.key).toBe("every-15-min");
    expect(row.nextRunAt).toBeInstanceOf(Date);
    expect(events.some((e) => e.status === "registered")).toBe(true);
  });

  it("rejects an unknown task type", async () => {
    const { registry, queue, emitter } = makeStub();
    const svc = new SchedulerService({ registry, queue, emitter, config: baseConfig });
    await expect(
      svc.createJob({
        key: "x",
        name: "x",
        cron: "*/15 * * * *",
        taskType: "does-not-exist",
      }),
    ).rejects.toBeInstanceOf(SchedulerError);
  });

  it("rejects a too-frequent cron expression", async () => {
    const { registry, queue, emitter } = makeStub();
    const svc = new SchedulerService({ registry, queue, emitter, config: baseConfig });
    await expect(
      svc.createJob({ key: "fast", name: "fast", cron: "* * * * * *", taskType: "noop" }),
    ).rejects.toBeInstanceOf(SchedulerError);
  });
});

describe("SchedulerService.runNow", () => {
  it("enqueues a task with trigger=manual when called", async () => {
    const { registry, queue, emitter, enqueued } = makeStub();
    const svc = new SchedulerService({ registry, queue, emitter, config: baseConfig });
    const job = await svc.createJob({
      key: "k",
      name: "k",
      cron: "*/15 * * * *",
      taskType: "noop",
    });
    const task = await svc.runNow(job.id, "user1");
    expect(task.trigger).toBe("manual");
    expect(enqueued.find((t) => t.id === task.id)?.scheduledJobId).toBe(job.id);
  });

  it("returns 404 when job does not exist", async () => {
    const { registry, queue, emitter } = makeStub();
    const svc = new SchedulerService({ registry, queue, emitter, config: baseConfig });
    await expect(svc.runNow("nope", null)).rejects.toBeInstanceOf(SchedulerError);
  });

  it("refuses to fire a soft-deleted job", async () => {
    const { registry, queue, emitter } = makeStub();
    const svc = new SchedulerService({ registry, queue, emitter, config: baseConfig });
    const job = await svc.createJob({
      key: "k",
      name: "k",
      cron: "*/15 * * * *",
      taskType: "noop",
    });
    await svc.deleteJob(job.id, "user1");
    await expect(svc.runNow(job.id, null)).rejects.toBeInstanceOf(SchedulerError);
  });
});

describe("SchedulerService.updateJob + pause/resume", () => {
  it("toggles enabled flag without deleting the job", async () => {
    const { registry, queue, emitter } = makeStub();
    const svc = new SchedulerService({ registry, queue, emitter, config: baseConfig });
    const job = await svc.createJob({
      key: "k",
      name: "k",
      cron: "*/15 * * * *",
      taskType: "noop",
    });
    const paused = await svc.updateJob(job.id, { enabled: false });
    expect(paused.enabled).toBe(false);
    const resumed = await svc.updateJob(job.id, { enabled: true });
    expect(resumed.enabled).toBe(true);
  });

  it("revalidates cron when expression changes", async () => {
    const { registry, queue, emitter } = makeStub();
    const svc = new SchedulerService({ registry, queue, emitter, config: baseConfig });
    const job = await svc.createJob({
      key: "k",
      name: "k",
      cron: "*/15 * * * *",
      taskType: "noop",
    });
    await expect(svc.updateJob(job.id, { cron: "* * * * * *" })).rejects.toBeInstanceOf(
      SchedulerError,
    );
  });

  it("rejects update with unknown task type", async () => {
    const { registry, queue, emitter } = makeStub();
    const svc = new SchedulerService({ registry, queue, emitter, config: baseConfig });
    const job = await svc.createJob({
      key: "k",
      name: "k",
      cron: "*/15 * * * *",
      taskType: "noop",
    });
    await expect(svc.updateJob(job.id, { taskType: "missing" })).rejects.toBeInstanceOf(
      SchedulerError,
    );
  });
});

describe("SchedulerService.health", () => {
  it("reports degraded when not started, ok when scheduler is disabled", () => {
    const { registry, queue, emitter } = makeStub();
    const disabled = new SchedulerService({
      registry,
      queue,
      emitter,
      config: { ...baseConfig, enabled: false },
    });
    expect(disabled.health().status).toBe("ok");
    const enabled = new SchedulerService({ registry, queue, emitter, config: baseConfig });
    expect(enabled.health().status).toBe("degraded");
  });
});

describe("SchedulerService.listJobs", () => {
  it("filters by projectId and excludes deleted by default", async () => {
    const { registry, queue, emitter } = makeStub();
    const svc = new SchedulerService({ registry, queue, emitter, config: baseConfig });
    await svc.createJob({
      key: "a",
      name: "a",
      cron: "*/15 * * * *",
      taskType: "noop",
      projectId: "p1",
    });
    const j2 = await svc.createJob({
      key: "b",
      name: "b",
      cron: "*/15 * * * *",
      taskType: "noop",
      projectId: "p2",
    });
    await svc.deleteJob(j2.id);
    const p1 = await svc.listJobs({ projectId: "p1" });
    expect(p1.length).toBe(1);
    const all = await svc.listJobs({});
    // p2 was deleted so it's filtered out by default.
    expect(all.find((j) => j.key === "b")).toBeUndefined();
  });
});

describe("SchedulerService — RBAC + idempotency (review fixes)", () => {
  it("createJob denies a non-admin actor for a project they don't own", async () => {
    const { registry, queue, emitter } = makeStub();
    const svc = new SchedulerService({ registry, queue, emitter, config: baseConfig });
    await expect(
      svc.createJob(
        { key: "k", name: "k", cron: "*/15 * * * *", taskType: "noop", projectId: "other" },
        { id: "u1", role: "developer" },
      ),
    ).rejects.toBeInstanceOf(SchedulerError);
  });

  it("createJob allows a non-admin for a system-wide job (projectId=null) only when admin", async () => {
    const { registry, queue, emitter } = makeStub();
    const svc = new SchedulerService({ registry, queue, emitter, config: baseConfig });
    await expect(
      svc.createJob(
        { key: "k", name: "k", cron: "*/15 * * * *", taskType: "noop", projectId: null },
        { id: "u1", role: "developer" },
      ),
    ).rejects.toBeInstanceOf(SchedulerError);
  });

  it("admin can create system-wide jobs", async () => {
    const { registry, queue, emitter } = makeStub();
    const svc = new SchedulerService({ registry, queue, emitter, config: baseConfig });
    const row = await svc.createJob(
      { key: "sys", name: "sys", cron: "*/15 * * * *", taskType: "noop" },
      { id: "admin1", role: "admin" },
    );
    expect(row.key).toBe("sys");
  });

  it("runNow denies non-admin actor for a job they cannot access", async () => {
    const { registry, queue, emitter } = makeStub();
    const svc = new SchedulerService({ registry, queue, emitter, config: baseConfig });
    const job = await svc.createJob(
      {
        key: "k",
        name: "k",
        cron: "*/15 * * * *",
        taskType: "noop",
        projectId: "p1",
        createdById: "owner",
      },
      { id: "owner", role: "admin" },
    );
    await expect(svc.runNow(job.id, { id: "intruder", role: "developer" })).rejects.toBeInstanceOf(
      SchedulerError,
    );
  });

  it("getJob returns null when actor cannot access the job", async () => {
    const { registry, queue, emitter } = makeStub();
    const svc = new SchedulerService({ registry, queue, emitter, config: baseConfig });
    const job = await svc.createJob(
      {
        key: "k",
        name: "k",
        cron: "*/15 * * * *",
        taskType: "noop",
        projectId: "p1",
        createdById: "owner",
      },
      { id: "owner", role: "admin" },
    );
    const got = await svc.getJob(job.id, { id: "intruder", role: "developer" });
    expect(got).toBeNull();
  });

  it("deleteJob cascades cancellation to in-flight tasks (M3)", async () => {
    const { registry, queue, emitter } = makeStub();
    const svc = new SchedulerService({ registry, queue, emitter, config: baseConfig });
    const job = await svc.createJob({
      key: "k",
      name: "k",
      cron: "*/15 * * * *",
      taskType: "noop",
    });
    // Seed an in-flight task on the global stash that the prisma mock reads.
    (globalThis as { __taskRows?: Array<Record<string, unknown>> }).__taskRows = [
      { id: "t-running", scheduledJobId: job.id, status: "running" },
    ];
    const cancelSpy = vi.spyOn(queue, "cancel").mockResolvedValue(true);
    await svc.deleteJob(job.id);
    expect(cancelSpy).toHaveBeenCalledWith("t-running", "job-deleted");
    (globalThis as { __taskRows?: Array<Record<string, unknown>> }).__taskRows = [];
  });

  it("fireScheduledJob is idempotent within the same instant (H5)", async () => {
    const { registry, queue, emitter } = makeStub();
    const svc = new SchedulerService({ registry, queue, emitter, config: baseConfig });
    const job = await svc.createJob({
      key: "k",
      name: "k",
      cron: "*/15 * * * *",
      taskType: "noop",
    });
    const enqueueSpy = vi.spyOn(queue, "enqueue");
    // Call the private firing path twice — only the first should claim.
    const fire = (svc as unknown as { fireScheduledJob: (id: string) => Promise<void> })
      .fireScheduledJob;
    await fire.call(svc, job.id);
    await fire.call(svc, job.id);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
  });
});

describe("SchedulerService — lifecycle", () => {
  it("start() registers all enabled non-deleted jobs", async () => {
    const { registry, queue, emitter } = makeStub();
    const svc = new SchedulerService({ registry, queue, emitter, config: baseConfig });
    await svc.createJob({ key: "a", name: "a", cron: "*/15 * * * *", taskType: "noop" });
    await svc.createJob({ key: "b", name: "b", cron: "*/15 * * * *", taskType: "noop" });
    await svc.start();
    expect(svc.health().status).toBe("ok");
    expect(svc.health().registeredJobs).toBe(2);
    await svc.stop();
    expect(svc.health().status).toBe("degraded");
    expect(svc.health().registeredJobs).toBe(0);
  });

  it("start() is a no-op when scheduler config disabled", async () => {
    const { registry, queue, emitter } = makeStub();
    const svc = new SchedulerService({
      registry,
      queue,
      emitter,
      config: { ...baseConfig, enabled: false },
    });
    await svc.start();
    expect(svc.health().registeredJobs).toBe(0);
  });

  it("updateJob denies non-admin actor on a foreign-project job (H1)", async () => {
    const { registry, queue, emitter } = makeStub();
    const svc = new SchedulerService({ registry, queue, emitter, config: baseConfig });
    const job = await svc.createJob(
      {
        key: "k",
        name: "k",
        cron: "*/15 * * * *",
        taskType: "noop",
        projectId: "p1",
      },
      { id: "owner", role: "admin" },
    );
    await expect(
      svc.updateJob(job.id, { enabled: false }, { id: "intruder", role: "developer" }),
    ).rejects.toBeInstanceOf(SchedulerError);
  });

  it("deleteJob denies non-admin actor on a foreign-project job", async () => {
    const { registry, queue, emitter } = makeStub();
    const svc = new SchedulerService({ registry, queue, emitter, config: baseConfig });
    const job = await svc.createJob(
      {
        key: "k",
        name: "k",
        cron: "*/15 * * * *",
        taskType: "noop",
        projectId: "p1",
      },
      { id: "owner", role: "admin" },
    );
    await expect(
      svc.deleteJob(job.id, { id: "intruder", role: "developer" }),
    ).rejects.toBeInstanceOf(SchedulerError);
  });

  it("listJobs returns empty when explicit projectId is outside the actor's scope", async () => {
    const { registry, queue, emitter } = makeStub();
    const svc = new SchedulerService({ registry, queue, emitter, config: baseConfig });
    await svc.createJob(
      {
        key: "k",
        name: "k",
        cron: "*/15 * * * *",
        taskType: "noop",
        projectId: "p1",
      },
      { id: "admin", role: "admin" },
    );
    const out = await svc.listJobs({ projectId: "p1" }, { id: "intruder", role: "developer" });
    expect(out).toEqual([]);
  });
});
