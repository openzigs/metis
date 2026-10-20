/**
 * #655 — who may join a `connector:{id}`, `run:{id}` or `job:{id}` room,
 * (#679) a `presence:{type}:{id}` room, (#1212) a `project:{id}` room and
 * (#1290) a `session:{id}` room.
 *
 * Each room carries reads of the resource it is named after, so joining it
 * takes the same rule as the REST read of that resource: the resource exists,
 * and the caller can reach its project through `assertProjectAccess` (admin
 * bypass, legacy `workspaceId: null` projects open to any authenticated user,
 * otherwise a live member of the project's workspace). Every role holds
 * `connector.read` and `analysis.read`, so the object-level rule is the whole
 * REST rule.
 *
 * #1290 — the project half is `canReadProject` (`canAccessProjectDiscussions`,
 * the `project:{id}` rule): `assertProjectAccess` plus "the project is not
 * soft-deleted" for a non-admin, with the caller's workspaces read live. It
 * used to be `assertProjectAccess` alone, which ignores `project.deletedAt`, so
 * a member could still join these rooms on a soft-deleted project. The same
 * rules re-judge a socket already in the room (`project-data-rooms.ts`), and
 * each records the room's project (`rememberRoomProject`) so that a project
 * delete re-judges only that project's rooms.
 *
 * Every denial — unknown id, deleted resource, another project — answers
 * `false` (or `null`), so a socket cannot be used as an existence oracle.
 * Anything that is not an `AppError` (a database failure) is rethrown, so the
 * caller logs it and still refuses the socket, as `canJoinAnalysisRoom` does.
 */
import {
  bgRunRoom,
  connectorRoom,
  isSpecKitArtifactName,
  presenceRoom,
  sessionRoom,
  type AuthPayload,
  type PresenceArtifactType,
} from "@metis/shared";
import { prisma } from "../prisma.js";
import { canAccessProjectDiscussions, canAccessThread } from "../discussions/access.js";
import { AppError } from "../../middleware/error-handler.js";
import { loadAccessibleImpactDetail } from "../impact-analysis/impact-detail-access.js";
import { getJobScope, type JobScope } from "./job-events.js";
import { readJobScope } from "./job-scope-store.js";
import { createChildLogger } from "../logger.js";
import { rememberRoomProject } from "./room-scope.js";

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

/**
 * #1290 — may `user` read `projectId`'s data? The rule of `project:{id}`
 * (`canAccessProjectDiscussions`): project access, the caller's workspaces read
 * live, and a soft-deleted project closed to non-admins. Returns `false` on a
 * denial and rethrows a database failure.
 */
export function canReadProject(user: AuthPayload, projectId: string): Promise<boolean> {
  return canAccessProjectDiscussions({ id: user.userId, role: user.role }, projectId);
}

/**
 * #1212 — `project:{id}` carries the project's live job, document, connector,
 * usage, background-run and drift events, so joining it takes the rule of
 * `GET /projects/:id`: `assertProjectAccess` (admins, the members of the
 * project's workspace, anyone for a legacy project with no workspace), plus
 * "the project is not soft-deleted" for a non-admin. It is the same function
 * the project's discussions, comments and mentions use (#734), so a teammate
 * who can open the project gets its live updates and nobody else does. It used
 * to be the scheduler's `actorCanAccessProject`, which admits only the
 * project's creator, so every other member saw a job finish only on reload.
 *
 * Membership is read from the database at join time, not from the handshake's
 * snapshot, and a denial is audited. An unknown project and a project the
 * caller cannot reach both answer `false`. `action` names the denial's audit
 * row: a join, or a re-judgement of a socket already in the room.
 */
export function canJoinProjectRoom(
  user: AuthPayload,
  projectId: string,
  action = "socket.subscribe:project",
): Promise<boolean> {
  return canAccessProjectDiscussions({ id: user.userId, role: user.role }, projectId, {
    resource: "project_room",
    resourceId: projectId,
    action,
  });
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
  if (!owner) return false;
  rememberRoomProject(connectorRoom(connectorId), owner.projectId);
  return canReadProject(user, owner.projectId);
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
  if (!run) return false;
  rememberRoomProject(bgRunRoom(runId), run.projectId);
  return canReadProject(user, run.projectId);
}

/**
 * #1290 — `session:{id}` carries a chat session's tool events and approval
 * prompts (with the tool's arguments): the rule of every session read
 * (`loadAuthorizedSession`) — the caller owns the live session and, when it is
 * bound to a project, can still read that project — with the project half
 * taken from {@link canReadProject}, so a soft-deleted project closes it too.
 */
export async function canJoinSessionRoom(user: AuthPayload, sessionId: string): Promise<boolean> {
  const session = await prisma.aISession.findFirst({
    where: { id: sessionId, userId: user.userId, deletedAt: null },
    select: { projectId: true },
  });
  if (!session) return false;
  rememberRoomProject(sessionRoom(sessionId), session.projectId);
  return session.projectId === null || canReadProject(user, session.projectId);
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
 * miss: the id is then unknown, and the join is refused. With `onStoreError:
 * "throw"` it is rethrown instead (#1251): a re-judgement of a socket already
 * in the room must not read a database error as a revocation.
 */
async function lookupJobScope(
  jobId: string,
  onStoreError: "deny" | "throw",
): Promise<JobScope | null> {
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
    if (onStoreError === "throw") throw err;
    log.warn("could not read a recorded job scope; treating the job as unknown", {
      jobId,
      error: (err as Error).message,
    });
    return null;
  }
}

/**
 * `job:{id}` carries a job's lifecycle and doc-section events. A job scoped to
 * a project takes the rule of that project's room (`project:{id}`, where its
 * events are broadcast as well): project access plus "not soft-deleted". An impact analysis spans projects and takes the rule
 * of `GET /api/impact-analyses/:id`; any other job without a project is
 * admin-only. Returns the scope the caller was authorized against, or `null`.
 *
 * #1251 — the same rule re-judges a socket already in the room
 * (`rejudgeJobRooms`), which passes `onStoreError: "throw"` so that a failed
 * `job_scopes` read reaches its fail-open / fail-closed handling.
 */
export async function resolveJobRoomScope(
  user: AuthPayload,
  jobId: string,
  opts: { onStoreError?: "deny" | "throw" } = {},
): Promise<JobScope | null> {
  const scope = getJobScope(jobId) ?? (await lookupJobScope(jobId, opts.onStoreError ?? "deny"));
  if (!scope) return null;
  let allowed: boolean;
  if (scope.projectId !== null) {
    // #1251 — the rule of `project:{id}`, which carries the same events: a
    // soft-deleted project is closed to non-admins and the caller's workspaces
    // are read live, so a project delete re-judges its job rooms too.
    allowed = await canAccessProjectDiscussions(
      { id: user.userId, role: user.role },
      scope.projectId,
    );
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
      if (access.ok) rememberRoomProject(presenceRoom(artifactType, artifactId), access.projectId);
      return access.ok;
    }
    case "spec-kit-artifact": {
      const sep = artifactId.indexOf(":");
      const projectId = artifactId.slice(0, sep);
      const name = artifactId.slice(sep + 1);
      if (sep <= 0 || !isSpecKitArtifactName(name)) return false;
      rememberRoomProject(presenceRoom(artifactType, artifactId), projectId);
      return canReadProject(user, projectId);
    }
  }
}
