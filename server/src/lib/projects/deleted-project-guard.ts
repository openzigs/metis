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

/** The background paths that consult this guard — the `path` field of every skip log line. */
export type BackgroundPath =
  | "trigger.webhook"
  | "trigger.github"
  | "trigger.slack"
  | "scheduler.fire"
  | "scheduler.task"
  | "async-runner"
  | "pr-review";

/** One structured log line per skipped unit of work, so a skip is never silent. */
export function logDeletedProjectSkip(input: {
  path: BackgroundPath;
  projectId: string;
  sourceType: string;
  sourceId: string;
}): void {
  log.warn("background_work.skipped_deleted_project", input);
}
