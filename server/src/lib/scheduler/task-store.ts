/**
 * Prisma-backed TaskStore — persists `Task` rows and serialises payloads.
 */
import { prisma } from "../prisma.js";
import type { Prisma } from "@prisma/client";
import { audit } from "../audit/audit-service.js";
import type { TaskStore } from "./task-queue.js";
import type { TaskRecord, TaskStatus } from "./types.js";

function parseJson(s: string | null | undefined): Record<string, unknown> | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function fromRow(row: {
  id: string;
  scheduledJobId: string | null;
  projectId: string | null;
  type: string;
  trigger: string;
  status: string;
  priority: number;
  payload: string;
  result: string | null;
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
}): TaskRecord {
  return {
    id: row.id,
    scheduledJobId: row.scheduledJobId,
    projectId: row.projectId,
    type: row.type,
    trigger: row.trigger as TaskRecord["trigger"],
    status: row.status as TaskStatus,
    priority: row.priority,
    payload: parseJson(row.payload) ?? {},
    result: parseJson(row.result),
    errorMessage: row.errorMessage,
    progress: row.progress,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    scheduledFor: row.scheduledFor,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createPrismaTaskStore(): TaskStore {
  // The predicate belongs in the SQL UPDATE, not a read/check/write in this
  // process: another scheduler or cancellation request can own the same row.
  async function transition(
    taskId: string,
    expected: TaskStatus[],
    data: Prisma.TaskUpdateManyMutationInput,
  ) {
    const { count } = await prisma.task.updateMany({
      where: { id: taskId, status: { in: expected } },
      data,
    });
    const row = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    return { changed: count === 1, task: fromRow(row) };
  }
  return {
    async create(input) {
      const row = await prisma.task.create({
        data: {
          scheduledJobId: input.scheduledJobId ?? null,
          projectId: input.projectId ?? null,
          type: input.type,
          trigger: input.trigger ?? "manual",
          priority: input.priority ?? 5,
          payload: JSON.stringify(input.payload ?? {}),
          maxAttempts: input.maxAttempts ?? 3,
          scheduledFor: input.scheduledFor ?? null,
          createdById: input.createdById ?? null,
          status: "pending",
        },
      });
      audit({
        action: "task.enqueue",
        actor: input.createdById ?? null,
        target: { type: "task", id: row.id },
        metadata: {
          type: input.type,
          trigger: input.trigger ?? "manual",
          scheduledJobId: input.scheduledJobId ?? null,
          projectId: input.projectId ?? null,
        },
      });
      return fromRow(row);
    },
    async markRunning(taskId, _attempt, now) {
      const { changed, task } = await transition(taskId, ["pending"], {
        status: "running",
        startedAt: now,
        // A queued snapshot may predate another worker's retries.
        attempts: { increment: 1 },
      });
      // A losing claimant must not dispatch even when the winner is running.
      if (!changed) return null;
      audit({
        action: "task.start",
        target: { type: "task", id: taskId },
        metadata: { attempt: task.attempts },
      });
      return task;
    },
    async markCompleted(taskId, result, now) {
      const { changed, task } = await transition(taskId, ["running"], {
        status: "completed",
        completedAt: now,
        errorMessage: null,
        progress: 100,
        result: result == null ? null : JSON.stringify(result),
      });
      if (changed)
        audit({
          action: "task.complete",
          target: { type: "task", id: taskId },
        });
      return task;
    },
    async markFailed(taskId, error, now) {
      const { changed, task } = await transition(taskId, ["pending", "running"], {
        status: "failed",
        completedAt: now,
        errorMessage: error.slice(0, 4000),
      });
      if (changed)
        audit({
          action: "task.fail",
          target: { type: "task", id: taskId },
          metadata: { error: error.slice(0, 200) },
        });
      return task;
    },
    async markCancelled(taskId, reason, now) {
      const { changed, task } = await transition(taskId, ["pending", "running"], {
        status: "cancelled",
        completedAt: now,
        errorMessage: reason.slice(0, 4000),
      });
      if (changed)
        audit({
          action: "task.cancel",
          target: { type: "task", id: taskId },
          metadata: { reason: reason.slice(0, 200) },
        });
      return task;
    },
    async markRetrying(taskId, error, now) {
      const { changed, task } = await transition(taskId, ["running"], {
        status: "pending",
        startedAt: null,
        completedAt: null,
        errorMessage: error.slice(0, 4000),
        // attempts already incremented in markRunning; keep value.
        updatedAt: now,
      });
      if (changed)
        audit({
          action: "task.retry",
          target: { type: "task", id: taskId },
          metadata: { error: error.slice(0, 200) },
        });
      return task;
    },
    async updateProgress(taskId, progress) {
      await prisma.task.updateMany({
        where: { id: taskId, status: "running" },
        data: { progress: Math.max(0, Math.min(100, Math.round(progress))) },
      });
    },
  };
}

/**
 * Helper exposed for the routes layer — read a Task back out of Prisma in the
 * `TaskRecord` shape used by the queue.
 */
export async function readTaskRecord(taskId: string): Promise<TaskRecord | null> {
  const row = await prisma.task.findUnique({ where: { id: taskId } });
  return row ? fromRow(row) : null;
}
