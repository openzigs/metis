/**
 * #655 — who may join a `connector:{id}`, `run:{id}` or `job:{id}` room, and
 * (#679) a `presence:{type}:{id}` room.
 *
 * Each room carries reads of the resource it is named after, so joining it
 * takes the same rule as the REST read of that resource: the resource exists,
 * and the caller can reach its project through `assertProjectAccess` (admin
 * bypass, legacy `workspaceId: null` projects open to any authenticated user,
 * otherwise a live member of the project's workspace). Every role holds
 * `connector.read` and `analysis.read`, so the object-level rule is the whole
 * REST rule.
 *
 * Every denial — unknown id, deleted resource, another project — answers
 * `false` (or `null`), so a socket cannot be used as an existence oracle.
 * Anything that is not an `AppError` (a database failure) is rethrown, so the
 * caller logs it and still refuses the socket, as `canJoinAnalysisRoom` does.
 */
import { isSpecKitArtifactName, type AuthPayload, type PresenceArtifactType } from "@metis/shared";
import { prisma } from "../prisma.js";
import { canAccessThread } from "../discussions/access.js";
import { assertProjectAccess } from "../custom-agents/authz.js";
import { AppError } from "../../middleware/error-handler.js";
import { loadAccessibleImpactDetail } from "../impact-analysis/impact-detail-access.js";
import { getJobScope, type JobScope } from "./job-events.js";
import { readJobScope } from "./job-scope-store.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("socket:room-access");

async function passes(check: () => Promise<unknown>): Promise<boolean> {
  try {
    await check();
    return true;
  } catch (err) {
    if (err instanceof AppError) return false;
    throw err;
  }
}

function canReachProject(user: AuthPayload, projectId: string): Promise<boolean> {
  return passes(() => assertProjectAccess(user, projectId));
}

/**
 * `connector:{id}` carries ingest and test progress of a repo or database
 * connector: the rule of `GET /projects/:projectId/connectors/{repos,dbs}/:id`.
 */
export async function canJoinConnectorRoom(
  user: AuthPayload,
  connectorId: string,
): Promise<boolean> {
  const query = { where: { id: connectorId, deletedAt: null }, select: { projectId: true } };
  const [repo, db] = await Promise.all([
    prisma.repoConnection.findFirst(query),
    prisma.databaseConnection.findFirst(query),
  ]);
  const owner = repo ?? db;
  return owner ? canReachProject(user, owner.projectId) : false;
}

/**
 * `run:{id}` carries a background run's steps: the rule of
 * `GET /api/runs/background/:id` (`authorizeBackgroundRun`).
 */
export async function canJoinBgRunRoom(user: AuthPayload, runId: string): Promise<boolean> {
  const run = await prisma.backgroundRun.findUnique({
    where: { id: runId },
    select: { projectId: true },
  });
  return run ? canReachProject(user, run.projectId) : false;
}

/**
 * A job id that no event on this process has named yet is the id of a row for
 * the kinds that have one, so it can still be scoped after a restart or when
 * the client subscribes before the job's first event. A row-less job is scoped
 * from the record its trigger wrote to `job_scopes` (#674), which every
 * replica reads.
 *
 * `job_scopes` is read only once every row lookup has missed, so a job with a
 * row never depends on it. A failure to read it is logged and treated as a
 * miss: the id is then unknown, and the join is refused.
 */
async function lookupJobScope(jobId: string): Promise<JobScope | null> {
  const select = { projectId: true };
  const [analysis, doc, importRun, impact] = await Promise.all([
    prisma.analysis.findFirst({ where: { id: jobId, deletedAt: null }, select }),
    prisma.generatedDocument.findFirst({ where: { id: jobId, deletedAt: null }, select }),
    prisma.importRun.findFirst({ where: { id: jobId }, select }),
    prisma.impactAnalysis.findFirst({ where: { id: jobId }, select: { id: true } }),
  ]);
  if (analysis) return { kind: "analysis", projectId: analysis.projectId };
  if (doc) return { kind: "doc-generation", projectId: doc.projectId };
  if (importRun) return { kind: "import-sync", projectId: importRun.projectId };
  if (impact) return { kind: "impact-analysis", projectId: null };
  try {
    return await readJobScope(jobId);
  } catch (err) {
    log.warn("could not read a recorded job scope; treating the job as unknown", {
      jobId,
      error: (err as Error).message,
    });
    return null;
  }
}

/**
 * `job:{id}` carries a job's lifecycle and doc-section events. A job scoped to
 * a project takes that project's read rule — its events are broadcast to
 * `project:{id}` as well. An impact analysis spans projects and takes the rule
 * of `GET /api/impact-analyses/:id`; any other job without a project is
 * admin-only. Returns the scope the caller was authorized against, or `null`.
 */
export async function resolveJobRoomScope(
  user: AuthPayload,
  jobId: string,
): Promise<JobScope | null> {
  const scope = getJobScope(jobId) ?? (await lookupJobScope(jobId));
  if (!scope) return null;
  let allowed: boolean;
  if (scope.projectId !== null) {
    allowed = await canReachProject(user, scope.projectId);
  } else if (scope.kind === "impact-analysis") {
    allowed = await passes(() =>
      loadAccessibleImpactDetail({ id: user.userId, role: user.role }, jobId),
    );
  } else {
    allowed = user.role === "admin";
  }
  return allowed ? scope : null;
}

/**
 * #679 — `presence:{type}:{id}` lists who is viewing an artifact, so joining it
 * takes the REST read rule of that artifact:
 *
 * - `discussion` (id = thread id): `canAccessThread`, the rule of the thread
 *   reads and of `subscribe:thread`. A soft-deleted thread is refused.
 * - `spec-kit-artifact` (id = `{projectId}:{artifactName}`, as the Spec Kit page
 *   names it): the rule of `GET /projects/:projectId/spec-kit/files/:name` —
 *   project access, and a name that route serves. The artifact need not have
 *   been generated yet: the page shows presence on an empty artifact too.
 */
export async function canJoinPresenceRoom(
  user: AuthPayload,
  artifactType: PresenceArtifactType,
  artifactId: string,
): Promise<boolean> {
  switch (artifactType) {
    case "discussion": {
      const access = await canAccessThread({ id: user.userId, role: user.role }, artifactId);
      return access.ok;
    }
    case "spec-kit-artifact": {
      const sep = artifactId.indexOf(":");
      const projectId = artifactId.slice(0, sep);
      const name = artifactId.slice(sep + 1);
      if (sep <= 0 || !isSpecKitArtifactName(name)) return false;
      return canReachProject(user, projectId);
    }
  }
}
