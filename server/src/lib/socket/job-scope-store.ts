/**
 * #674 — the durable scope of a job id that names no row of its own.
 *
 * `subscribe:job` (#655) authorizes a `job:{id}` join against the job's kind
 * and project. A job with a row (analysis, generated document, import run,
 * impact analysis) is scoped from it. Repo ingest, spec-kit, overview
 * regenerate, embeddings reindex and PR review have none, and the scope their
 * events and `rememberJobScope` leave in process memory is lost on another
 * cluster replica, after a restart, and once the 500-entry store evicts it —
 * refusing the job's own initiator.
 *
 * {@link recordJobScope} writes the scope to `job_scopes` as well, and the
 * trigger routes AWAIT it before they hand the job id to the client. So by the
 * time any client can send `subscribe:job` for the id, the record is committed
 * and every replica reads the same answer: there is no subscribe-before-relay
 * window to cover.
 */
import type { JobKind } from "@metis/shared";
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { JOB_KINDS, rememberJobScope, type JobScope } from "./job-events.js";

const log = createChildLogger("socket:job-scope");

/**
 * How long a recorded scope authorizes a join. Long enough for the slowest
 * row-less job (a corpus reindex or a large repo ingest) and a client's
 * re-subscribe after a reconnect; past it the id is unknown, as it would be
 * for a job that never existed.
 */
export const JOB_SCOPE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Record a job's scope in this process and in `job_scopes`. Call it, and await
 * it, before the job id leaves the server. A database failure is logged, not
 * thrown: the job still runs, and a subscriber on this replica is still
 * authorized from memory.
 */
export async function recordJobScope(
  jobId: string,
  kind: JobKind,
  projectId: string | null,
  now: Date = new Date(),
): Promise<void> {
  rememberJobScope(jobId, kind, projectId);
  const expiresAt = new Date(now.getTime() + JOB_SCOPE_TTL_MS);
  try {
    await prisma.jobScopeRecord.upsert({
      where: { jobId },
      create: { jobId, kind, projectId, expiresAt },
      update: { kind, projectId, expiresAt },
    });
  } catch (err) {
    log.warn("could not persist a job scope", { jobId, kind, error: (err as Error).message });
    return;
  }
  // Prune lapsed records; nothing waits on it.
  prisma.jobScopeRecord.deleteMany({ where: { expiresAt: { lt: now } } }).catch((err: unknown) => {
    log.warn("could not prune lapsed job scopes", { error: (err as Error).message });
  });
}

/**
 * The recorded, unexpired scope of a job, or `null`. A row whose kind is not a
 * known {@link JobKind} is treated as absent.
 */
export async function readJobScope(
  jobId: string,
  now: Date = new Date(),
): Promise<JobScope | null> {
  const row = await prisma.jobScopeRecord.findFirst({
    where: { jobId, expiresAt: { gt: now } },
    select: { kind: true, projectId: true },
  });
  if (!row || !(JOB_KINDS as readonly string[]).includes(row.kind)) return null;
  return { kind: row.kind as JobKind, projectId: row.projectId };
}
