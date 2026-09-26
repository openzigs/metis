/**
 * Scheduler + Tasks — public types (Phase 11).
 *
 * The scheduler owns ScheduledJob CRUD and cron registration; the task queue
 * owns Task lifecycle (queued -> running -> {succeeded,failed,cancelled}). A
 * fired cron enqueues exactly one Task per scheduled instant; manual triggers
 * enqueue a Task with `trigger="manual"`.
 */
import type { SchedulerStatusEvent, TaskProgressEvent, TaskStatusEvent } from "@metis/shared";

/** Task statuses persisted on the Task row. */
export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/** What caused this Task to be enqueued — surfaced in audit + UI. */
export type TaskTrigger = "scheduled" | "manual" | "retry" | "webhook";

/** Snapshot of a queued/running/finished task, used by handlers + UI. */
export interface TaskRecord {
  id: string;
  scheduledJobId: string | null;
  projectId: string | null;
  type: string;
  trigger: TaskTrigger;
  status: TaskStatus;
  priority: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  errorMessage: string | null;
  progress: number | null;
  attempts: number;
  maxAttempts: number;
  scheduledFor: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Inputs to enqueue a new task. */
export interface EnqueueTaskInput {
  type: string;
  trigger?: TaskTrigger;
  priority?: number;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  scheduledFor?: Date;
  scheduledJobId?: string | null;
  projectId?: string | null;
  createdById?: string | null;
}

/** Context passed to a task handler invocation. */
export interface TaskHandlerContext {
  task: TaskRecord;
  /** Aborted when the scheduler asks the handler to cancel. Threaded through
   *  to downstream services (fetch, child processes, etc.). */
  signal: AbortSignal;
  /** Emit progress events during long-running work. */
  reportProgress(progress: { step: string; current?: number; total?: number; pct?: number }): void;
  /** Structured logger scoped to the task id. */
  log(level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>): void;
}

/** A handler returns its result payload or throws. */
export type TaskHandlerFn = (ctx: TaskHandlerContext) => Promise<Record<string, unknown> | void>;

/** A registered handler with metadata used for diagnostics. */
export interface TaskHandlerRegistration {
  type: string;
  description: string;
  /** Default timeout in ms — handler MUST honour the AbortSignal regardless. */
  defaultTimeoutMs?: number;
  handler: TaskHandlerFn;
  /**
   * #201 — called after a task of this type is cancelled while still queued, so
   * the handler never ran. A handler that records an outcome elsewhere (a
   * generated-doc publication's synthetic document) settles it here. Errors are
   * logged, never propagated: the cancellation itself has already been persisted.
   */
  onCancelledBeforeRun?(task: TaskRecord, reason: string): Promise<void>;
}

/** Registry interface — supports registration + lookup. */
export interface TaskHandlerRegistry {
  register(reg: TaskHandlerRegistration): void;
  get(type: string): TaskHandlerRegistration | undefined;
  list(): TaskHandlerRegistration[];
}

/** Scheduler configuration (env-tunable defaults). */
export interface SchedulerConfig {
  /** Maximum simultaneously-running tasks. */
  concurrency: number;
  /** Tick interval (ms) for the queue dispatcher. Default 1000ms. */
  tickMs: number;
  /** Default per-task timeout (ms) when a handler does not specify one. */
  defaultTimeoutMs: number;
  /** Initial retry backoff (ms). */
  retryBackoffMs: number;
  /** Maximum retry backoff (ms). */
  retryBackoffMaxMs: number;
  /** Reject cron expressions whose next interval is shorter than this (s). */
  minCronIntervalSec: number;
  /** Globally enable/disable scheduler (env: SCHEDULER_ENABLED). */
  enabled: boolean;
}

/** Scheduler-emitted lifecycle events bridged to Socket.IO. */
export interface SchedulerEmitter {
  schedulerStatus(event: SchedulerStatusEvent): void;
  taskStatus(event: TaskStatusEvent): void;
  taskProgress(event: TaskProgressEvent): void;
}

/** Health snapshot consumed by /readyz. */
export interface SchedulerHealth {
  status: "ok" | "degraded" | "error";
  enabled: boolean;
  lastTickAt: number | null;
  queueDepth: number;
  running: number;
  registeredJobs: number;
  message?: string;
}

/** Typed error class for scheduler/task failures. */
export class SchedulerError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "SchedulerError";
  }
}
