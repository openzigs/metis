/**
 * In-process priority task queue with concurrency cap, retry/backoff, and
 * AbortController-based cancellation.
 *
 * Persistence is delegated to the caller through `TaskStore` so the queue
 * stays unit-testable without a database. The production implementation in
 * `task-store.ts` writes through to Prisma.
 *
 * Priority semantics:
 *   - Lower number = higher priority (1 highest, 10 lowest).
 *   - Higher-priority tasks pre-empt lower-priority tasks at the queue head;
 *     in-flight tasks are NOT pre-empted (cooperative cancellation only).
 *
 * Concurrency:
 *   - The queue runs at most `config.concurrency` tasks at a time; any extra
 *     work waits in the priority queue until a slot frees.
 *
 * Retries:
 *   - On handler throw, the task is retried up to `maxAttempts` with
 *     exponential backoff: `min(retryBackoffMs * 2^(attempt-1), retryBackoffMaxMs)`.
 *   - Final failure (attempts === maxAttempts) emits `task:status` with
 *     status="failed" plus `errorMessage` set.
 */
import { createChildLogger } from "../logger.js";
import { isDurableTask } from "./durable-task-types.js";
import {
  type EnqueueTaskInput,
  type SchedulerConfig,
  type SchedulerEmitter,
  SchedulerError,
  type TaskHandlerContext,
  type TaskHandlerRegistry,
  type TaskRecord,
  type TaskStatus,
} from "./types.js";

const log = createChildLogger("task-queue");

/** Persistence boundary — the queue does not import Prisma directly. */
export interface TaskStore {
  /** Insert a freshly-enqueued task. */
  create(input: EnqueueTaskInput & { now: Date }): Promise<TaskRecord>;
  /**
   * Atomically claim pending work and increment persisted attempts; null means
   * another transition won. The attempt argument is a legacy hint for injected
   * stores; the returned record's attempts is authoritative.
   */
  markRunning(taskId: string, attempt: number, now: Date): Promise<TaskRecord | null>;
  /** Persist a successful run. */
  markCompleted(
    taskId: string,
    result: Record<string, unknown> | null,
    now: Date,
  ): Promise<TaskRecord>;
  /** Persist a failed run (terminal — exhausted retries OR explicit fail-fast). */
  markFailed(taskId: string, error: string, now: Date): Promise<TaskRecord>;
  /** Persist a cancellation. */
  markCancelled(taskId: string, reason: string, now: Date): Promise<TaskRecord>;
  /** Reset to pending after a transient failure that will be retried. */
  markRetrying(taskId: string, error: string, now: Date): Promise<TaskRecord>;
  /** Update the persisted progress integer (0-100). */
  updateProgress(taskId: string, progress: number): Promise<void>;
}

interface RunningEntry {
  task: TaskRecord;
  controller: AbortController;
  abortSource?: "user" | "shutdown" | "timeout";
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

interface PendingEntry {
  task: TaskRecord;
  /** Timer that fires the task — used for retry backoff and `scheduledFor`. */
  timer?: ReturnType<typeof setTimeout>;
  readyAt: number; // Date.now() at which this task becomes runnable.
}

export class TaskQueue {
  private pending: PendingEntry[] = []; // Sorted by priority asc, createdAt asc.
  private running = new Map<string, RunningEntry>();
  private dispatching = false;
  private stopped = false;
  private lastTickAt: number | null = null;

  constructor(
    private readonly store: TaskStore,
    private readonly registry: TaskHandlerRegistry,
    private readonly emitter: SchedulerEmitter,
    private readonly config: SchedulerConfig,
  ) {}

  /** Enqueue a new task. Persists immediately and dispatches if a slot is free. */
  async enqueue(input: EnqueueTaskInput): Promise<TaskRecord> {
    if (this.stopped) {
      throw new SchedulerError(503, "QUEUE_STOPPED", "task queue is shutting down");
    }
    if (!this.registry.get(input.type)) {
      // Fail-fast on unknown task type — record the attempt so audit captures it.
      const now = new Date();
      const failed = await this.store.create({ ...input, now });
      const persisted = await this.store.markFailed(
        failed.id,
        `unknown task type: ${input.type}`,
        new Date(),
      );
      this.emitStatus(persisted);
      throw new SchedulerError(400, "UNKNOWN_TASK_TYPE", `unknown task type: ${input.type}`);
    }
    const now = new Date();
    const task = await this.store.create({ ...input, now });
    const readyAt = task.scheduledFor ? task.scheduledFor.getTime() : Date.now();
    this.insertPending({ task, readyAt });
    this.emitStatus(task);
    void this.dispatch();
    return task;
  }

  /** Dispatch an already-persisted task; replay must not create another row. */
  resume(task: TaskRecord): void {
    if (
      this.stopped ||
      this.running.has(task.id) ||
      this.pending.some((p) => p.task.id === task.id)
    )
      return;
    if (task.status !== "pending" || !this.registry.get(task.type)) return;
    this.insertPending({ task, readyAt: task.scheduledFor?.getTime() ?? Date.now() });
    void this.dispatch();
  }

  /** Cancel a queued or running task. Idempotent; returns true if cancelled. */
  async cancel(taskId: string, reason = "cancelled by user"): Promise<boolean> {
    // Pending — drop from queue.
    const pendingIdx = this.pending.findIndex((p) => p.task.id === taskId);
    if (pendingIdx >= 0) {
      const entry = this.pending.splice(pendingIdx, 1)[0];
      if (entry.timer) clearTimeout(entry.timer);
      const updated = await this.store.markCancelled(taskId, reason, new Date());
      this.emitStatus(updated);
      return updated.status === "cancelled";
    }
    // Running — abort + cleanup happens when the handler returns.
    const running = this.running.get(taskId);
    if (running) {
      running.abortSource = "user";
      running.controller.abort(new Error(reason));
      // Persist intent before acknowledging cancellation: a crash must not turn
      // explicitly cancelled durable work into a recoverable running row.
      if (isDurableTask(running.task.type)) {
        const updated = await this.store.markCancelled(taskId, reason, new Date());
        this.emitStatus(updated);
        return updated.status === "cancelled";
      }
      return true;
    }
    return false;
  }

  /** Re-enqueue a previously-failed task as a brand-new attempt. */
  async retry(taskId: string, original: TaskRecord): Promise<TaskRecord> {
    if (original.status !== "failed" && original.status !== "cancelled") {
      throw new SchedulerError(
        409,
        "TASK_NOT_RETRYABLE",
        `task ${taskId} is in status ${original.status}; only failed/cancelled tasks may be retried`,
      );
    }
    return this.enqueue({
      type: original.type,
      trigger: "retry",
      priority: original.priority,
      payload: original.payload,
      maxAttempts: original.maxAttempts,
      scheduledJobId: original.scheduledJobId,
      projectId: original.projectId,
      createdById: original.createdById,
    });
  }

  /** Health snapshot for /readyz. */
  snapshot(): { lastTickAt: number | null; queueDepth: number; running: number } {
    return {
      lastTickAt: this.lastTickAt,
      queueDepth: this.pending.length,
      running: this.running.size,
    };
  }

  /** Stop the queue from accepting new tasks and abort everything in flight. */
  async shutdown(reason = "scheduler shutdown"): Promise<void> {
    this.stopped = true;
    for (const entry of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      // Durable outboxes are replayed from the same row on startup.
      if (isDurableTask(entry.task.type)) continue;
      await this.store.markCancelled(entry.task.id, reason, new Date()).catch(() => {});
    }
    this.pending = [];
    for (const [, running] of this.running) {
      if (!running.controller.signal.aborted) running.abortSource = "shutdown";
      running.controller.abort(new Error(reason));
    }
  }

  // ---------- internals ----------

  private insertPending(entry: PendingEntry): void {
    // Stable insertion-sort by priority then enqueue order.
    const idx = this.pending.findIndex(
      (p) =>
        p.task.priority > entry.task.priority ||
        (p.task.priority === entry.task.priority && p.readyAt > entry.readyAt),
    );
    if (idx < 0) this.pending.push(entry);
    else this.pending.splice(idx, 0, entry);
  }

  private async dispatch(): Promise<void> {
    if (this.dispatching || this.stopped) return;
    this.dispatching = true;
    try {
      this.lastTickAt = Date.now();
      while (this.running.size < this.config.concurrency) {
        const idx = this.pending.findIndex((p) => p.readyAt <= Date.now());
        if (idx < 0) break;
        const entry = this.pending.splice(idx, 1)[0];
        if (entry.timer) clearTimeout(entry.timer);
        // Reserve the slot synchronously so the loop respects the cap even
        // before the async handler chain reaches `running.set` below.
        const placeholder: RunningEntry = {
          task: entry.task,
          controller: new AbortController(),
        };
        this.running.set(entry.task.id, placeholder);
        // Fire-and-forget — execute() replaces the placeholder once it has
        // marked the task running.
        void this.execute(entry.task, placeholder);
      }
    } finally {
      this.dispatching = false;
    }
  }

  private async execute(task: TaskRecord, placeholder?: RunningEntry): Promise<void> {
    const reg = this.registry.get(task.type);
    if (!reg) {
      // Defence in depth — should already be filtered at enqueue time.
      this.running.delete(task.id);
      const updated = await this.store.markFailed(
        task.id,
        `unknown task type: ${task.type}`,
        new Date(),
      );
      this.emitStatus(updated);
      return;
    }
    let running: TaskRecord | null;
    try {
      running = await this.store.markRunning(task.id, task.attempts + 1, new Date());
    } catch (err) {
      // M2: if the persistence layer rejects markRunning we MUST still
      // release the slot we reserved in `dispatch()`, otherwise the queue
      // leaks concurrency capacity until restart.
      this.running.delete(task.id);
      log.error("markRunning failed; releasing slot", {
        taskId: task.id,
        error: (err as Error).message,
      });
      // Trigger another dispatch so the next pending task can take the slot.
      void this.dispatch();
      throw err;
    }
    if (!running || running.status !== "running") {
      if (running) this.emitStatus(running);
      this.running.delete(task.id);
      void this.dispatch();
      return;
    }
    const controller = placeholder?.controller ?? new AbortController();
    const entry: RunningEntry = placeholder ?? { task: running, controller };
    entry.task = running;
    // Cancellation/shutdown can win while the running claim is in flight.
    // Do not call a handler even once with an already-aborted signal.
    if (controller.signal.aborted || this.stopped) {
      try {
        await this.persistInterruption(entry, "aborted before dispatch");
      } finally {
        this.running.delete(task.id);
        void this.dispatch();
      }
      return;
    }
    const ctx: TaskHandlerContext = {
      task: running,
      signal: controller.signal,
      reportProgress: (progress) => {
        const pct =
          progress.pct ??
          (typeof progress.current === "number" &&
          typeof progress.total === "number" &&
          progress.total > 0
            ? Math.min(100, Math.max(0, Math.round((progress.current / progress.total) * 100)))
            : undefined);
        if (typeof pct === "number") {
          void this.store.updateProgress(running.id, pct).catch(() => {});
        }
        this.emitter.taskProgress({
          taskId: running.id,
          step: progress.step,
          current: progress.current,
          total: progress.total,
          progress: pct,
          ts: Date.now(),
        });
      },
      log: (level, message, meta) => log[level](message, { taskId: running.id, ...meta }),
    };

    const timeoutMs = reg.defaultTimeoutMs ?? this.config.defaultTimeoutMs;
    const timeoutHandle = setTimeout(() => {
      if (!controller.signal.aborted) entry.abortSource = "timeout";
      controller.abort(new Error(`task timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    timeoutHandle.unref?.();

    // Keep cancellation provenance even if shutdown/cancel raced markRunning.
    entry.timeoutHandle = timeoutHandle;
    this.running.set(running.id, entry);
    this.emitStatus(running);

    try {
      const result = (await reg.handler(ctx)) ?? null;
      clearTimeout(timeoutHandle);
      if (controller.signal.aborted) {
        if (entry.abortSource === "timeout") throw controller.signal.reason;
        await this.persistInterruption(entry, "aborted");
      } else {
        const completed = await this.store.markCompleted(running.id, result, new Date());
        this.emitStatus(completed);
      }
    } catch (err) {
      clearTimeout(timeoutHandle);
      const message = err instanceof Error ? err.message : String(err);
      // Shutdown interruptions remain durable; user cancellation stays terminal.
      if (
        (controller.signal.aborted && entry.abortSource !== "timeout") ||
        (this.stopped && isDurableTask(running.type) && entry.abortSource !== "timeout")
      ) {
        await this.persistInterruption(entry, message);
      } else if (running.attempts < running.maxAttempts) {
        // Schedule a retry with exponential backoff.
        const backoff = Math.min(
          this.config.retryBackoffMs * Math.pow(2, running.attempts - 1),
          this.config.retryBackoffMaxMs,
        );
        const updated = await this.store.markRetrying(running.id, message, new Date());
        // A cancel may have been acknowledged during the persistence await,
        // including after the SQL write but before its stale result returns.
        if (
          controller.signal.aborted &&
          (entry.abortSource === "user" ||
            (entry.abortSource === "shutdown" && !isDurableTask(running.type)))
        ) {
          await this.persistInterruption(entry, message);
          return;
        }
        this.emitStatus(updated);
        // shutdown may have raced the handler failure or the persistence await.
        if (this.stopped || updated.status !== "pending") return;
        const retryEntry: PendingEntry = {
          task: updated,
          readyAt: Date.now() + backoff,
        };
        const wakeRetry = (): void => {
          if (this.stopped) return;
          const remaining = retryEntry.readyAt - Date.now();
          // A timer can wake before the wall clock reaches readyAt.
          if (remaining > 0) {
            retryEntry.timer = setTimeout(wakeRetry, remaining);
            retryEntry.timer.unref?.();
            return;
          }
          void this.dispatch();
        };
        retryEntry.timer = setTimeout(wakeRetry, backoff);
        retryEntry.timer.unref?.();
        this.insertPending(retryEntry);
      } else {
        const failed = await this.store.markFailed(running.id, message, new Date());
        this.emitStatus(failed);
      }
    } finally {
      this.running.delete(running.id);
      // Trigger another dispatch in case more pending tasks became runnable.
      void this.dispatch();
    }
  }

  private async persistInterruption(entry: RunningEntry, message: string): Promise<void> {
    const preserve =
      isDurableTask(entry.task.type) &&
      (entry.abortSource === "shutdown" || (this.stopped && !entry.controller.signal.aborted));
    const updated = preserve
      ? await this.store.markRetrying(entry.task.id, message, new Date())
      : await this.store.markCancelled(entry.task.id, message, new Date());
    this.emitStatus(updated);
  }

  private emitStatus(task: TaskRecord): void {
    const status: TaskStatus = task.status;
    this.emitter.taskStatus({
      taskId: task.id,
      scheduledJobId: task.scheduledJobId,
      projectId: task.projectId,
      type: task.type,
      status,
      attempts: task.attempts,
      maxAttempts: task.maxAttempts,
      errorMessage: task.errorMessage,
      ts: Date.now(),
    });
  }
}
