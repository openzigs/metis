/**
 * Scheduler service — owns ScheduledJob CRUD, croner instance lifecycle, and
 * cron-fired enqueueing. Persists ScheduledJob rows via Prisma; delegates
 * Task lifecycle to TaskQueue.
 *
 * Idempotency:
 *   The `lastFiredAt` column is updated **conditionally**
 *   (`UPDATE ... WHERE id = :id AND (lastFiredAt IS NULL OR lastFiredAt < :instant)`).
 *   If 0 rows matched, another instance — or this same process after a
 *   restart-within-minute — already fired this instant; we skip the enqueue
 *   (review finding H5).
 *
 * RBAC defence-in-depth:
 *   Every mutating method accepts a `SchedulerActor` and re-runs the
 *   project-access check at the service layer (review finding H1). The
 *   route layer also guards each handler — the service exists as a second
 *   barrier so future callers (queue handlers, internal jobs, CLI) can never
 *   accidentally bypass authorization.
 */
import { Cron } from "croner";
import { audit } from "../audit/audit-service.js";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import { readTaskRecord } from "./task-store.js";
import { DURABLE_TASK_TYPES } from "./durable-task-types.js";
import type { ScheduledJob as PrismaScheduledJob } from "@prisma/client";
import type { TaskQueue } from "./task-queue.js";
import { validateCron } from "./cron-validator.js";
import {
  type SchedulerConfig,
  type SchedulerEmitter,
  type SchedulerHealth,
  SchedulerError,
  type TaskHandlerRegistry,
  type TaskRecord,
} from "./types.js";
import {
  actorCanAccessProject,
  buildProjectAccessWhere,
  isAdminActor,
  listAccessibleProjectIds,
  type SchedulerActor,
} from "./project-access.js";

const log = createChildLogger("scheduler-service");

export interface CreateScheduledJobOpts {
  key: string;
  name: string;
  cron: string;
  taskType: string;
  payload?: Record<string, unknown>;
  projectId?: string | null;
  enabled?: boolean;
  maxAttempts?: number;
  createdById?: string | null;
}

export interface UpdateScheduledJobOpts {
  name?: string;
  cron?: string;
  taskType?: string;
  payload?: Record<string, unknown>;
  projectId?: string | null;
  enabled?: boolean;
  maxAttempts?: number;
}

export interface SchedulerServiceDeps {
  queue: TaskQueue;
  registry: TaskHandlerRegistry;
  emitter: SchedulerEmitter;
  config: SchedulerConfig;
}

interface CronEntry {
  job: Cron;
}

export class SchedulerService {
  private crons = new Map<string, CronEntry>();
  private startedAt: Date | null = null;
  private durableRecovery: Cron | null = null;

  constructor(private readonly deps: SchedulerServiceDeps) {}

  // ---------- ScheduledJob CRUD ----------

  async createJob(
    opts: CreateScheduledJobOpts,
    actor?: SchedulerActor,
  ): Promise<PrismaScheduledJob> {
    if (!this.deps.registry.get(opts.taskType)) {
      throw new SchedulerError(400, "UNKNOWN_TASK_TYPE", `unknown task type: ${opts.taskType}`);
    }
    if (actor) {
      const ok = await actorCanAccessProject(actor, opts.projectId ?? null, {
        resource: "scheduled-job",
        resourceId: opts.key,
        action: "scheduled-job.create",
      });
      if (!ok) {
        throw new SchedulerError(404, "JOB_NOT_FOUND", `scheduled job ${opts.key} not found`);
      }
    }
    const validation = validateCron(opts.cron, {
      minIntervalSec: this.deps.config.minCronIntervalSec,
    });
    const row = await prisma.scheduledJob.create({
      data: {
        key: opts.key,
        name: opts.name,
        cron: validation.expression,
        taskType: opts.taskType,
        payload: JSON.stringify(opts.payload ?? {}),
        projectId: opts.projectId ?? null,
        enabled: opts.enabled ?? true,
        maxAttempts: opts.maxAttempts ?? 3,
        nextRunAt: validation.nextRun,
        createdById: opts.createdById ?? actor?.id ?? null,
      },
    });
    audit({
      action: "scheduled-job.create",
      actor: opts.createdById ?? actor?.id ?? null,
      target: { type: "scheduled-job", id: row.id },
      metadata: { key: row.key, taskType: row.taskType, enabled: row.enabled },
    });
    if (row.enabled && this.startedAt) this.registerCron(row);
    this.deps.emitter.schedulerStatus({
      jobId: row.id,
      key: row.key,
      status: "registered",
      enabled: row.enabled,
      nextRunAt: row.nextRunAt?.toISOString() ?? null,
      ts: Date.now(),
    });
    return row;
  }

  async updateJob(
    id: string,
    opts: UpdateScheduledJobOpts,
    actor: SchedulerActor | string | null = null,
  ): Promise<PrismaScheduledJob> {
    const existing = await prisma.scheduledJob.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      throw new SchedulerError(404, "JOB_NOT_FOUND", `scheduled job ${id} not found`);
    }
    const actorObj = normalizeActor(actor);
    if (actorObj) {
      const ok = await actorCanAccessProject(actorObj, existing.projectId, {
        resource: "scheduled-job",
        resourceId: id,
        action: "scheduled-job.update",
      });
      if (!ok) {
        throw new SchedulerError(404, "JOB_NOT_FOUND", `scheduled job ${id} not found`);
      }
      // Disallow re-parenting into a project the actor doesn't control either.
      if (opts.projectId !== undefined && opts.projectId !== existing.projectId) {
        const okNew = await actorCanAccessProject(actorObj, opts.projectId ?? null, {
          resource: "scheduled-job",
          resourceId: id,
          action: "scheduled-job.update",
        });
        if (!okNew) {
          throw new SchedulerError(404, "JOB_NOT_FOUND", `scheduled job ${id} not found`);
        }
      }
    }
    let nextRunAt = existing.nextRunAt;
    let cron = existing.cron;
    if (opts.cron && opts.cron !== existing.cron) {
      const validation = validateCron(opts.cron, {
        minIntervalSec: this.deps.config.minCronIntervalSec,
      });
      cron = validation.expression;
      nextRunAt = validation.nextRun;
    }
    if (opts.taskType && !this.deps.registry.get(opts.taskType)) {
      throw new SchedulerError(400, "UNKNOWN_TASK_TYPE", `unknown task type: ${opts.taskType}`);
    }
    const row = await prisma.scheduledJob.update({
      where: { id },
      data: {
        name: opts.name ?? existing.name,
        cron,
        taskType: opts.taskType ?? existing.taskType,
        payload: opts.payload ? JSON.stringify(opts.payload) : existing.payload,
        projectId: opts.projectId === undefined ? existing.projectId : opts.projectId,
        enabled: opts.enabled ?? existing.enabled,
        maxAttempts: opts.maxAttempts ?? existing.maxAttempts,
        nextRunAt,
      },
    });
    this.unregisterCron(id);
    if (row.enabled && this.startedAt) this.registerCron(row);
    audit({
      action: "scheduled-job.update",
      actor: actorObj?.id ?? null,
      target: { type: "scheduled-job", id: row.id },
      metadata: { changes: Object.keys(opts) },
    });
    this.deps.emitter.schedulerStatus({
      jobId: row.id,
      key: row.key,
      status: row.enabled ? "updated" : "paused",
      enabled: row.enabled,
      nextRunAt: row.nextRunAt?.toISOString() ?? null,
      ts: Date.now(),
    });
    return row;
  }

  async deleteJob(id: string, actor: SchedulerActor | string | null = null): Promise<void> {
    const existing = await prisma.scheduledJob.findUnique({ where: { id } });
    if (!existing) return;
    const actorObj = normalizeActor(actor);
    if (actorObj) {
      const ok = await actorCanAccessProject(actorObj, existing.projectId, {
        resource: "scheduled-job",
        resourceId: id,
        action: "scheduled-job.delete",
      });
      if (!ok) {
        throw new SchedulerError(404, "JOB_NOT_FOUND", `scheduled job ${id} not found`);
      }
    }
    await prisma.scheduledJob.update({
      where: { id },
      data: { deletedAt: new Date(), enabled: false },
    });
    this.unregisterCron(id);
    audit({
      action: "scheduled-job.delete",
      actor: actorObj?.id ?? null,
      target: { type: "scheduled-job", id },
    });
    // M3: cancel any in-flight tasks for this job so a delete doesn't leave
    // hanging work that ignores the cancellation signal.
    try {
      const inflight = await prisma.task.findMany({
        where: { scheduledJobId: id, status: { in: ["pending", "running"] } },
        select: { id: true },
      });
      for (const t of inflight) {
        const ok = await this.deps.queue.cancel(t.id, "job-deleted");
        if (ok) {
          audit({
            action: "task.cancel.cascade",
            actor: actorObj?.id ?? null,
            target: { type: "task", id: t.id },
            metadata: { reason: "scheduled-job-deleted", jobId: id },
          });
        }
      }
    } catch (err) {
      log.warn("Failed to cancel in-flight tasks during deleteJob", {
        id,
        error: (err as Error).message,
      });
    }
    this.deps.emitter.schedulerStatus({
      jobId: id,
      key: existing.key,
      status: "removed",
      enabled: false,
      ts: Date.now(),
    });
  }

  async listJobs(
    filter: { projectId?: string | null; includeDeleted?: boolean } = {},
    actor?: SchedulerActor,
  ): Promise<PrismaScheduledJob[]> {
    const where: Record<string, unknown> = {
      ...(filter.includeDeleted ? {} : { deletedAt: null }),
    };
    if (filter.projectId !== undefined) {
      // Explicit project filter — verify access then narrow to the single id.
      if (actor && !isAdminActor(actor)) {
        const allowedIds = await listAccessibleProjectIds(actor);
        const allowed = filter.projectId === null ? false : allowedIds.includes(filter.projectId);
        if (!allowed) return [];
      }
      where.projectId = filter.projectId;
    } else if (actor) {
      const access = await buildProjectAccessWhere(actor);
      Object.assign(where, access);
    }
    return prisma.scheduledJob.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
  }

  async getJob(id: string, actor?: SchedulerActor): Promise<PrismaScheduledJob | null> {
    const row = await prisma.scheduledJob.findUnique({ where: { id } });
    if (!row) return null;
    if (actor) {
      const ok = await actorCanAccessProject(actor, row.projectId, {
        resource: "scheduled-job",
        resourceId: id,
        action: "scheduled-job.read",
      });
      if (!ok) return null;
    }
    return row;
  }

  // ---------- Manual trigger ----------

  /**
   * Enqueue an immediate run for a scheduled job. The route layer enforces
   * RBAC; the service runs the project-access guard as defence in depth (H1).
   */
  async runNow(
    id: string,
    actor: SchedulerActor | string | null,
    trigger: "manual" = "manual",
  ): Promise<TaskRecord> {
    const job = await prisma.scheduledJob.findUnique({ where: { id } });
    if (!job || job.deletedAt) {
      throw new SchedulerError(404, "JOB_NOT_FOUND", `scheduled job ${id} not found`);
    }
    const actorObj = normalizeActor(actor);
    if (actorObj) {
      const ok = await actorCanAccessProject(actorObj, job.projectId, {
        resource: "scheduled-job",
        resourceId: id,
        action: "scheduled-job.run-now",
      });
      if (!ok) {
        throw new SchedulerError(404, "JOB_NOT_FOUND", `scheduled job ${id} not found`);
      }
    }
    audit({
      action: "scheduled-job.run-now",
      actor: actorObj?.id ?? null,
      target: { type: "scheduled-job", id },
      metadata: { key: job.key, taskType: job.taskType },
    });
    const task = await this.deps.queue.enqueue({
      type: job.taskType,
      trigger,
      priority: 5,
      payload: parsePayload(job.payload),
      maxAttempts: job.maxAttempts,
      scheduledJobId: job.id,
      projectId: job.projectId ?? null,
      createdById: actorObj?.id ?? null,
    });
    this.deps.emitter.schedulerStatus({
      jobId: job.id,
      key: job.key,
      status: "fired",
      enabled: job.enabled,
      message: "manual run",
      nextRunAt: job.nextRunAt?.toISOString() ?? null,
      ts: Date.now(),
    });
    return task;
  }

  // ---------- Lifecycle ----------

  /** Bootstrap — load all enabled jobs and register their cron schedules. */
  async start(): Promise<void> {
    if (!this.deps.config.enabled) {
      log.info("Scheduler disabled via config; skipping cron registration");
      return;
    }
    this.startedAt = new Date();
    const jobs = await prisma.scheduledJob.findMany({
      where: { enabled: true, deletedAt: null },
    });
    for (const job of jobs) this.registerCron(job);
    await this.recoverDurableTasks();
    this.durableRecovery?.stop();
    this.durableRecovery = new Cron("* * * * *", () => {
      void this.recoverDurableTasks().catch((err) =>
        log.error("Durable task recovery failed", { err }),
      );
    });
    log.info("Scheduler started", { registered: jobs.length });
  }

  private async recoverDurableTasks(): Promise<void> {
    // Regeneration keeps its existing two-hour generation lease. Publication
    // (including deletion cleanup) may replay after its handler timeout. Never
    // revive terminal rows, regardless of their cancellation reason text.
    for (const type of DURABLE_TASK_TYPES) {
      const timeoutMs =
        type === "regenerate-generated-document"
          ? 7_200_000
          : (this.deps.registry.get(type)?.defaultTimeoutMs ?? this.deps.config.defaultTimeoutMs);
      const recoveryCutoff = new Date(Date.now() - timeoutMs);
      await prisma.task.updateMany({
        where: { type, status: "running", updatedAt: { lt: recoveryCutoff } },
        data: { status: "pending" },
      });
      const pending = await prisma.task.findMany({
        where: { type, status: "pending" },
        select: { id: true },
      });
      for (const row of pending) {
        const record = await readTaskRecord(row.id);
        if (record) this.deps.queue.resume(record);
      }
    }
  }

  /** Stop — pause all crons (does not modify the DB). */
  async stop(): Promise<void> {
    this.durableRecovery?.stop();
    this.durableRecovery = null;
    for (const [id] of this.crons) this.unregisterCron(id);
    this.startedAt = null;
  }

  health(): SchedulerHealth {
    const snap = this.deps.queue.snapshot();
    const status: SchedulerHealth["status"] = !this.deps.config.enabled
      ? "ok"
      : this.startedAt == null
        ? "degraded"
        : "ok";
    return {
      status,
      enabled: this.deps.config.enabled,
      lastTickAt: snap.lastTickAt,
      queueDepth: snap.queueDepth,
      running: snap.running,
      registeredJobs: this.crons.size,
      message: status === "degraded" ? "scheduler not started" : undefined,
    };
  }

  // ---------- internals ----------

  private registerCron(row: PrismaScheduledJob): void {
    if (this.crons.has(row.id)) this.unregisterCron(row.id);
    const handler = () => {
      void this.fireScheduledJob(row.id);
    };
    let entry: CronEntry;
    try {
      entry = { job: new Cron(row.cron, { name: `scheduled-job:${row.key}` }, handler) };
    } catch (err) {
      log.error("Failed to register cron", { id: row.id, error: (err as Error).message });
      return;
    }
    this.crons.set(row.id, entry);
  }

  private unregisterCron(id: string): void {
    const entry = this.crons.get(id);
    if (!entry) return;
    entry.job.stop();
    this.crons.delete(id);
  }

  /**
   * Persisted, racey-safe firing path (H5). Conditional UPDATE acts as a
   * cross-process mutex: only the first process to set `lastFiredAt` for an
   * instant proceeds with the enqueue.
   */
  private async fireScheduledJob(jobId: string): Promise<void> {
    const job = await prisma.scheduledJob.findUnique({ where: { id: jobId } });
    if (!job || job.deletedAt || !job.enabled) {
      this.unregisterCron(jobId);
      return;
    }
    // Truncate to the second so two ticks arriving microseconds apart for the
    // same scheduled instant collapse to the same key.
    const now = new Date();
    const instant = new Date(Math.floor(now.getTime() / 1000) * 1000);
    const claimed = await this.claimFireSlot(jobId, instant);
    if (!claimed) {
      log.debug("fireScheduledJob skipped — already claimed", {
        id: jobId,
        instant: instant.toISOString(),
      });
      return;
    }
    const nextRunAt = computeNextRun(job.cron, now);
    await prisma.scheduledJob.update({
      where: { id: jobId },
      data: { lastRunAt: now, nextRunAt },
    });
    try {
      await this.deps.queue.enqueue({
        type: job.taskType,
        trigger: "scheduled",
        priority: 5,
        payload: parsePayload(job.payload),
        maxAttempts: job.maxAttempts,
        scheduledJobId: job.id,
        projectId: job.projectId ?? null,
        createdById: null,
      });
      this.deps.emitter.schedulerStatus({
        jobId: job.id,
        key: job.key,
        status: "fired",
        enabled: true,
        nextRunAt: nextRunAt?.toISOString() ?? null,
        ts: Date.now(),
      });
    } catch (err) {
      log.error("Failed to enqueue scheduled task", {
        id: job.id,
        error: (err as Error).message,
      });
      this.deps.emitter.schedulerStatus({
        jobId: job.id,
        key: job.key,
        status: "skipped",
        enabled: true,
        message: (err as Error).message,
        ts: Date.now(),
      });
    }
  }

  /**
   * Conditional update — returns `true` when this process won the claim,
   * `false` when another process already fired the same instant.
   */
  private async claimFireSlot(jobId: string, instant: Date): Promise<boolean> {
    // Prisma's `updateMany` honours `where` clauses on the data row, which
    // is exactly the conditional-update primitive we need.
    const result = await prisma.scheduledJob.updateMany({
      where: {
        id: jobId,
        OR: [{ lastFiredAt: null }, { lastFiredAt: { lt: instant } }],
      },
      data: { lastFiredAt: instant },
    });
    return result.count === 1;
  }
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function computeNextRun(cron: string, from: Date): Date | null {
  try {
    const job = new Cron(cron, { paused: true }, () => {});
    return job.nextRun(from) ?? null;
  } catch {
    return null;
  }
}

function normalizeActor(actor: SchedulerActor | string | null | undefined): SchedulerActor | null {
  if (!actor) return null;
  if (typeof actor === "string") return null;
  return actor;
}
