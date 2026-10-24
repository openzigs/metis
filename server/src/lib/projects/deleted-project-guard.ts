/**
 * #1438 — background work never runs for a soft-deleted project.
 *
 * #1430 closed a soft-deleted project to members' requests; this closes it to
 * the work nobody is present for: webhook triggers, scheduled jobs, queued
 * tasks and background runs, and PR auto-review. Each firing path asks this
 * module at FIRE time, rather than `deleteProject` disabling or detaching the
 * project's triggers and jobs:
 *
 * - A soft delete keeps every row so the project can be restored. Flipping
 *   `enabled` off on delete would lose which triggers and jobs the owner had
 *   switched on, and a restore could not tell them apart from ones that were
 *   off before.
 * - Work already queued before the delete (a `BackgroundRun`, a scheduler task,
 *   a PR-review job) is not reached by a write at delete time at all; only a
 *   check at the moment it would run catches it.
 *
 * So the firing-time check is the single guard, and `deleteProject` leaves the
 * project's triggers and scheduled jobs exactly as they were.
 */
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { AppError } from "../../middleware/error-handler.js";

const log = createChildLogger("deleted-project-guard");

/**
 * The subset of `projectIds` naming a soft-deleted project, in one query.
 * A project that does not exist at all is not in the set: a hard-deleted
 * project's triggers and jobs cascade away with it.
 */
export async function softDeletedProjectIds(
  projectIds: Iterable<string | null | undefined>,
): Promise<Set<string>> {
  const ids = [...new Set([...projectIds].filter((id): id is string => !!id))];
  if (ids.length === 0) return new Set();
  const rows = await prisma.project.findMany({
    where: { id: { in: ids }, deletedAt: { not: null } },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

/** Whether `projectId` names a soft-deleted project. `null` (a system row) never does. */
export async function isProjectSoftDeleted(projectId: string | null | undefined): Promise<boolean> {
  if (!projectId) return false;
  return (await softDeletedProjectIds([projectId])).has(projectId);
}

/**
 * #1438 — refuse, at submit time, work an administrator asks to start for a
 * soft-deleted project (#1430 keeps the project open to admins, so the access
 * check alone admits it). Without this the request would be accepted (202) and
 * then cancelled by the firing-time guard, which reads as success.
 */
export async function assertProjectNotSoftDeleted(
  projectId: string | null | undefined,
): Promise<void> {
  if (await isProjectSoftDeleted(projectId)) {
    throw new AppError(410, "PROJECT_DELETED", "The project has been deleted");
  }
}

/** What the scheduler knows about a unit of work: a task row, or a job about to enqueue one. */
export interface TaskProjectRef {
  type: string;
  projectId: string | null | undefined;
  payload: Record<string, unknown> | null | undefined;
}

function payloadString(payload: Record<string, unknown> | null | undefined, key: string): string {
  const v = payload?.[key];
  return typeof v === "string" ? v.trim() : "";
}

/**
 * #1438 — every project a scheduler task acts for. The `projectId` column is
 * optional, and several task types name their project only through their
 * payload: `rerun-analysis` falls back to `payload.projectId`, the connector
 * refreshes to the connector's project, `publish-batch` to the batch's,
 * `import.run` to the import source's. Every one of them is returned, so a
 * gate that refuses when ANY is soft-deleted cannot be bypassed by a task
 * whose column is null or disagrees with what its handler will act on.
 */
export async function taskProjectIds(task: TaskProjectRef): Promise<string[]> {
  const ids = new Set<string>();
  if (task.projectId) ids.add(task.projectId);
  const fromPayload = payloadString(task.payload, "projectId");
  if (fromPayload) ids.add(fromPayload);
  const connectorId = payloadString(task.payload, "connectorId");
  const batchId = payloadString(task.payload, "batchId");
  const importSourceId = payloadString(task.payload, "importSourceId");
  let owner: { projectId: string } | null = null;
  if (task.type === "refresh-repo-connector" && connectorId) {
    owner = await prisma.repoConnection.findUnique({
      where: { id: connectorId },
      select: { projectId: true },
    });
  } else if (task.type === "refresh-db-connector-schema" && connectorId) {
    owner = await prisma.databaseConnection.findUnique({
      where: { id: connectorId },
      select: { projectId: true },
    });
  } else if (task.type === "publish-batch" && batchId) {
    owner = await prisma.publishBatch.findUnique({
      where: { id: batchId },
      select: { projectId: true },
    });
  } else if (task.type === "import.run" && importSourceId) {
    owner = await prisma.importSource.findUnique({
      where: { id: importSourceId },
      select: { projectId: true },
    });
  }
  if (owner?.projectId) ids.add(owner.projectId);
  return [...ids];
}

/**
 * #1438 — the soft-deleted project a scheduler task (or job) would act for,
 * or `null` when every project it names is live. The single check behind
 * both the job-firing gate and the task-queue gate.
 */
export async function deletedProjectOfTask(task: TaskProjectRef): Promise<string | null> {
  const ids = await taskProjectIds(task);
  if (ids.length === 0) return null;
  const deleted = await softDeletedProjectIds(ids);
  return ids.find((id) => deleted.has(id)) ?? null;
}

/** The background paths that consult this guard — the `path` field of every skip log line. */
export type BackgroundPath =
  | "trigger.webhook"
  | "trigger.github"
  | "trigger.slack"
  | "scheduler.fire"
  | "scheduler.task"
  | "async-runner"
  | "pr-review"
  | "mcp-health"
  | "notification"
  | "spec-kit.issue-sync"
  | "drift.reconcile";

/** One structured log line per skipped unit of work, so a skip is never silent. */
export function logDeletedProjectSkip(input: {
  path: BackgroundPath;
  projectId: string;
  sourceType: string;
  sourceId: string;
}): void {
  log.warn("background_work.skipped_deleted_project", input);
}
