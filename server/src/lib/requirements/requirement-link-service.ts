/**
 * Requirement-link service — Epic #610 (#624).
 *
 * Owns the create / delete / list / search logic for typed cross-project
 * requirement links (`RequirementLink`, landed in #623). The security-critical
 * invariant this module enforces is DUAL-PROJECT authorization: a caller may
 * only create, delete, or read a link when they can access the projects of
 * BOTH endpoints (source AND target requirement). A single-sided check would
 * let an actor with access to one project learn about, or wire into, a
 * requirement in a project they cannot see (OWASP A01 / IDOR).
 *
 * The per-project check reuses the EXISTING `actorCanAccessProject` mechanism
 * (`lib/scheduler/project-access.ts`) — the same ownership-intersection guard
 * the scheduler/tasks routes use — rather than inventing a new authz path. It
 * emits an audit row on denial. Workspace scoping for search reuses
 * `listAccessibleProjectsInWorkspace` (`lib/cross-project/cross-project-access.ts`),
 * which asserts workspace membership (404, no existence leak) and intersects
 * the workspace's projects with the actor's accessible set.
 *
 * Workspace boundary for a link: source and target must be in the SAME project,
 * or in two projects that share a non-null `workspaceId`. Two projects that both
 * have a NULL workspaceId are NOT considered a shared workspace (null is not a
 * tenant), so a cross-project link between them is rejected. This mirrors the
 * `RequirementLink` model doc contract (#623).
 */
import type { PrismaClient } from "@prisma/client";
import { isRequirementLinkType, isSelfLink, type RequirementLinkType } from "@metis/shared";
import { AppError } from "../../middleware/error-handler.js";
import { Prisma, prisma as defaultPrisma, resolveDatabaseProvider } from "../prisma.js";
import { audit } from "../audit/audit-service.js";
import { actorCanAccessProject, type SchedulerActor } from "../scheduler/project-access.js";
import { listAccessibleProjectsInWorkspace } from "../cross-project/cross-project-access.js";

/**
 * Minimal Prisma surface the link service needs. Kept narrow so unit tests can
 * supply a hand-rolled mock without standing up the whole client.
 */
export type LinkPrisma = Pick<PrismaClient, "requirement" | "requirementLink">;

/** Serialised counterpart context returned alongside every link. */
export interface LinkedRequirementContext {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
}

export interface RequirementLinkView {
  id: string;
  type: RequirementLinkType;
  createdAt: Date;
  /** Direction relative to the requirement being viewed / the source. */
  sourceRequirementId: string;
  targetRequirementId: string;
  /** The OTHER endpoint's rendering context. */
  requirement: LinkedRequirementContext;
}

export interface RequirementLinksResult {
  outgoing: RequirementLinkView[];
  incoming: RequirementLinkView[];
}

export interface SearchResult {
  items: LinkedRequirementContext[];
  page: number;
  pageSize: number;
  total: number;
}

type RequirementWithProject = {
  id: string;
  title: string;
  projectId: string;
  project: { id: string; name: string; workspaceId: string | null };
};

const REQUIREMENT_SELECT = {
  id: true,
  title: true,
  projectId: true,
  project: { select: { id: true, name: true, workspaceId: true } },
} as const;

function toContext(r: RequirementWithProject): LinkedRequirementContext {
  return { id: r.id, title: r.title, projectId: r.projectId, projectName: r.project.name };
}

/**
 * Detect a Prisma unique-constraint violation without importing the Prisma
 * error class (keeps the module light + testable): Prisma throws code `P2002`,
 * and a raw sqlite/pg error surfaces the phrase in its message.
 */
function isUniqueConstraintError(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "code" in err) {
    if ((err as { code?: unknown }).code === "P2002") return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /unique constraint/i.test(message);
}

/**
 * Assert the actor can access `projectId`, reusing the shared per-project
 * ownership check. Throws 403 on denial (the underlying check emits its own
 * audit row). This is the single place the dual-project rule is applied — every
 * mutating / reading path funnels both endpoints through it.
 */
async function assertProjectAccessible(
  actor: SchedulerActor,
  projectId: string,
  context: { resource: string; resourceId: string; action: string },
): Promise<void> {
  const allowed = await actorCanAccessProject(actor, projectId, context);
  if (!allowed) {
    throw new AppError(403, "FORBIDDEN", "You do not have access to one of the linked projects");
  }
}

/**
 * Run `run`, collapsing an access-denied (403) outcome into `notFound` so a
 * DIRECT-BY-ID lookup returns an identical status whether the id does not exist
 * or exists in a project the caller cannot access (#649). The differing
 * 404-vs-403 status was an existence oracle over the (server-generated) id space.
 *
 * A caller who DOES have access never reaches the catch, so legitimate behaviour
 * is byte-for-byte unchanged — only the not-found-vs-denied distinction collapses
 * for UNAUTHORIZED callers. Non-authz failures (DB faults, etc.) are re-thrown
 * untouched so a real error is never masked as a 404. The underlying access check
 * still writes its own denial audit row before the 403 is remapped, so the audit
 * trail is intact.
 */
async function assertAccessibleOrNotFound(
  notFound: AppError,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 403) {
      throw notFound;
    }
    throw err;
  }
}

/**
 * Enforce the workspace-boundary rule for a proposed link. Same project is
 * always allowed; otherwise both projects must share a non-null workspace.
 */
function assertSameWorkspace(source: RequirementWithProject, target: RequirementWithProject): void {
  if (source.projectId === target.projectId) return;
  const sourceWs = source.project.workspaceId;
  const targetWs = target.project.workspaceId;
  if (sourceWs != null && targetWs != null && sourceWs === targetWs) return;
  throw new AppError(
    409,
    "CROSS_WORKSPACE_LINK",
    "Requirements can only be linked within the same workspace",
  );
}

/**
 * True when following `depends_on` edges out of `startId` transitively reaches
 * `goalId`. Used to reject a new `source depends_on target` link that would
 * close a dependency cycle (target already depends on source). Bounded BFS with
 * a visited set so a corrupt graph cannot loop forever.
 */
async function dependsOnReaches(db: LinkPrisma, startId: string, goalId: string): Promise<boolean> {
  const visited = new Set<string>([startId]);
  let frontier: string[] = [startId];
  while (frontier.length > 0) {
    const edges = await db.requirementLink.findMany({
      where: { sourceRequirementId: { in: frontier }, type: "depends_on" },
      select: { targetRequirementId: true },
    });
    const next: string[] = [];
    for (const e of edges) {
      const t = e.targetRequirementId;
      if (t === goalId) return true;
      if (!visited.has(t)) {
        visited.add(t);
        next.push(t);
      }
    }
    frontier = next;
  }
  return false;
}

async function loadRequirementPair(
  db: LinkPrisma,
  sourceRequirementId: string,
  targetRequirementId: string,
): Promise<{ source: RequirementWithProject; target: RequirementWithProject }> {
  const rows = (await db.requirement.findMany({
    where: { id: { in: [sourceRequirementId, targetRequirementId] }, deletedAt: null },
    select: REQUIREMENT_SELECT,
  })) as unknown as RequirementWithProject[];
  const source = rows.find((r) => r.id === sourceRequirementId);
  const target = rows.find((r) => r.id === targetRequirementId);
  if (!source || !target) {
    throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Source or target requirement not found");
  }
  return { source, target };
}

export interface CreateLinkInput {
  sourceRequirementId: string;
  targetRequirementId: string;
  type: string;
}

/**
 * Create a typed link `source → target`. Enforces, in order: self-link
 * rejection, link-type validation, existence of both requirements, DUAL-PROJECT
 * access (both endpoints), workspace boundary, dependency-cycle guard (for
 * `depends_on`), and uniqueness. Writes a `requirement.link.create` audit row.
 */
export async function createRequirementLink(
  db: LinkPrisma,
  actor: SchedulerActor,
  input: CreateLinkInput,
): Promise<RequirementLinkView> {
  const { sourceRequirementId, targetRequirementId, type } = input;

  if (isSelfLink(sourceRequirementId, targetRequirementId)) {
    throw new AppError(400, "SELF_LINK", "A requirement cannot be linked to itself");
  }
  if (!isRequirementLinkType(type)) {
    throw new AppError(400, "INVALID_LINK_TYPE", "Unknown requirement link type");
  }

  const { source, target } = await loadRequirementPair(
    db,
    sourceRequirementId,
    targetRequirementId,
  );

  // DUAL-PROJECT authz: BOTH endpoints' projects must be accessible.
  await assertProjectAccessible(actor, source.projectId, {
    resource: "requirement_link",
    resourceId: sourceRequirementId,
    action: "requirement.link.create",
  });
  await assertProjectAccessible(actor, target.projectId, {
    resource: "requirement_link",
    resourceId: targetRequirementId,
    action: "requirement.link.create",
  });

  assertSameWorkspace(source, target);

  if (
    type === "depends_on" &&
    (await dependsOnReaches(db, targetRequirementId, sourceRequirementId))
  ) {
    throw new AppError(409, "DEPENDENCY_CYCLE", "This link would create a dependency cycle");
  }

  const existing = await db.requirementLink.findUnique({
    where: {
      sourceRequirementId_targetRequirementId_type: {
        sourceRequirementId,
        targetRequirementId,
        type,
      },
    },
    select: { id: true },
  });
  if (existing) {
    throw new AppError(409, "DUPLICATE_LINK", "This link already exists");
  }

  // The findUnique check above is best-effort: a concurrent create can slip
  // between it and this insert. The DB unique constraint is the real guard —
  // map its P2002 to the same 409 so a race yields DUPLICATE_LINK, not a 500.
  let link: {
    id: string;
    type: string;
    createdAt: Date;
    sourceRequirementId: string;
    targetRequirementId: string;
  };
  try {
    link = await db.requirementLink.create({
      data: { sourceRequirementId, targetRequirementId, type, createdById: actor.id },
      select: {
        id: true,
        type: true,
        createdAt: true,
        sourceRequirementId: true,
        targetRequirementId: true,
      },
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw new AppError(409, "DUPLICATE_LINK", "This link already exists");
    }
    throw err;
  }

  audit({
    actor: { id: actor.id },
    action: "requirement.link.create",
    target: { type: "requirement_link", id: link.id },
    metadata: {
      sourceRequirementId,
      targetRequirementId,
      type,
      sourceProjectId: source.projectId,
      targetProjectId: target.projectId,
    },
  });

  return {
    id: link.id,
    type: link.type as RequirementLinkType,
    createdAt: link.createdAt,
    sourceRequirementId: link.sourceRequirementId,
    targetRequirementId: link.targetRequirementId,
    requirement: toContext(target),
  };
}

/**
 * Delete a link by id. Requires DUAL-PROJECT access (both endpoints) so a
 * caller with access to only one side cannot sever a cross-project link. Writes
 * a `requirement.link.delete` audit row.
 */
export async function deleteRequirementLink(
  db: LinkPrisma,
  actor: SchedulerActor,
  linkId: string,
): Promise<void> {
  const link = (await db.requirementLink.findUnique({
    where: { id: linkId },
    select: {
      id: true,
      type: true,
      sourceRequirementId: true,
      targetRequirementId: true,
      source: { select: { projectId: true } },
      target: { select: { projectId: true } },
    },
  })) as {
    id: string;
    type: string;
    sourceRequirementId: string;
    targetRequirementId: string;
    source: { projectId: string };
    target: { projectId: string };
  } | null;

  if (!link) {
    throw new AppError(404, "LINK_NOT_FOUND", "Requirement link not found");
  }

  // DUAL-PROJECT authz. Access-denied is remapped to the SAME 404 as a missing
  // link so an unauthorized caller cannot tell the two apart (#649).
  await assertAccessibleOrNotFound(
    new AppError(404, "LINK_NOT_FOUND", "Requirement link not found"),
    async () => {
      await assertProjectAccessible(actor, link.source.projectId, {
        resource: "requirement_link",
        resourceId: linkId,
        action: "requirement.link.delete",
      });
      await assertProjectAccessible(actor, link.target.projectId, {
        resource: "requirement_link",
        resourceId: linkId,
        action: "requirement.link.delete",
      });
    },
  );

  await db.requirementLink.delete({ where: { id: linkId } });

  audit({
    actor: { id: actor.id },
    action: "requirement.link.delete",
    target: { type: "requirement_link", id: linkId },
    metadata: {
      sourceRequirementId: link.sourceRequirementId,
      targetRequirementId: link.targetRequirementId,
      type: link.type,
    },
  });
}

/**
 * List a requirement's outgoing + incoming links with counterpart context.
 * Requires access to the requirement's own project. Links whose COUNTERPART
 * project the caller cannot access are omitted so listing never leaks a
 * requirement in an inaccessible project (defence in depth beyond create-time
 * dual authz — the caller set may differ from who created the link).
 */
export async function listRequirementLinks(
  db: LinkPrisma,
  actor: SchedulerActor,
  requirementId: string,
): Promise<RequirementLinksResult> {
  const requirement = (await db.requirement.findUnique({
    where: { id: requirementId },
    select: { id: true, projectId: true, deletedAt: true },
  })) as { id: string; projectId: string; deletedAt: Date | null } | null;

  if (!requirement || requirement.deletedAt) {
    throw new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found");
  }

  // Access-denied on this direct-by-id read is remapped to the SAME 404 as a
  // missing requirement so the two are indistinguishable (#649).
  await assertAccessibleOrNotFound(
    new AppError(404, "REQUIREMENT_NOT_FOUND", "Requirement not found"),
    () =>
      assertProjectAccessible(actor, requirement.projectId, {
        resource: "requirement",
        resourceId: requirementId,
        action: "requirement.link.read",
      }),
  );

  const [outgoingRows, incomingRows] = await Promise.all([
    db.requirementLink.findMany({
      where: { sourceRequirementId: requirementId },
      select: {
        id: true,
        type: true,
        createdAt: true,
        sourceRequirementId: true,
        targetRequirementId: true,
        target: { select: REQUIREMENT_SELECT },
      },
      orderBy: { createdAt: "asc" },
    }),
    db.requirementLink.findMany({
      where: { targetRequirementId: requirementId },
      select: {
        id: true,
        type: true,
        createdAt: true,
        sourceRequirementId: true,
        targetRequirementId: true,
        source: { select: REQUIREMENT_SELECT },
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  // Cache per-project access decisions so a fan of links to the same project
  // only costs one check.
  const accessCache = new Map<string, boolean>();
  const canAccess = async (projectId: string): Promise<boolean> => {
    const cached = accessCache.get(projectId);
    if (cached !== undefined) return cached;
    const allowed = await actorCanAccessProject(actor, projectId, {
      resource: "requirement",
      resourceId: requirementId,
      action: "requirement.link.read",
    });
    accessCache.set(projectId, allowed);
    return allowed;
  };

  const outgoing: RequirementLinkView[] = [];
  for (const row of outgoingRows as unknown as Array<{
    id: string;
    type: string;
    createdAt: Date;
    sourceRequirementId: string;
    targetRequirementId: string;
    target: RequirementWithProject;
  }>) {
    if (!(await canAccess(row.target.projectId))) continue;
    outgoing.push({
      id: row.id,
      type: row.type as RequirementLinkType,
      createdAt: row.createdAt,
      sourceRequirementId: row.sourceRequirementId,
      targetRequirementId: row.targetRequirementId,
      requirement: toContext(row.target),
    });
  }

  const incoming: RequirementLinkView[] = [];
  for (const row of incomingRows as unknown as Array<{
    id: string;
    type: string;
    createdAt: Date;
    sourceRequirementId: string;
    targetRequirementId: string;
    source: RequirementWithProject;
  }>) {
    if (!(await canAccess(row.source.projectId))) continue;
    incoming.push({
      id: row.id,
      type: row.type as RequirementLinkType,
      createdAt: row.createdAt,
      sourceRequirementId: row.sourceRequirementId,
      targetRequirementId: row.targetRequirementId,
      requirement: toContext(row.source),
    });
  }

  return { outgoing, incoming };
}

export interface SearchInput {
  workspaceId: string;
  query?: string;
  excludeProjectId?: string;
  page: number;
  pageSize: number;
}

/**
 * Escape SQL `LIKE`/`ILIKE` metacharacters so a user-supplied `%` or `_` matches
 * literally instead of acting as a wildcard — preserving the literal-substring
 * semantics of Prisma's `contains`. `\` is the default Postgres escape char.
 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Postgres variant of the title search. The SQLite-generated Prisma client
 * cannot express `mode: "insensitive"`, so the case-fold is done with a
 * parameterised `ILIKE` (the term is a BOUND value — never interpolated into
 * SQL). Result shape, ordering, and pagination mirror the builder path exactly
 * so callers observe identical results across backends (#649).
 */
async function searchWorkspaceRequirementsPostgres(
  database: LinkPrisma,
  input: { projectIds: string[]; query: string; page: number; pageSize: number },
): Promise<SearchResult> {
  const { projectIds, query, page, pageSize } = input;
  const raw = database as unknown as {
    $queryRaw: <T = unknown>(sql: Prisma.Sql) => Promise<T>;
  };
  const projectList = Prisma.join(projectIds);
  const pattern = `%${escapeLike(query)}%`;

  const countRows = await raw.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT COUNT(*) AS "count"
    FROM "requirements"
    WHERE "projectId" IN (${projectList})
      AND "deletedAt" IS NULL
      AND "title" ILIKE ${pattern}
  `);
  const total = Number(countRows[0]?.count ?? 0);

  const rows = await raw.$queryRaw<
    Array<{ id: string; title: string; projectId: string; projectName: string }>
  >(Prisma.sql`
    SELECT r."id", r."title", r."projectId", p."name" AS "projectName"
    FROM "requirements" r
    JOIN "projects" p ON p."id" = r."projectId"
    WHERE r."projectId" IN (${projectList})
      AND r."deletedAt" IS NULL
      AND r."title" ILIKE ${pattern}
    ORDER BY r."title" ASC
    LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
  `);

  return {
    items: rows.map((r) => ({
      id: r.id,
      title: r.title,
      projectId: r.projectId,
      projectName: r.projectName,
    })),
    page,
    pageSize,
    total,
  };
}

/**
 * Workspace-scoped requirement search powering the link picker. Results are
 * confined to projects the caller can access WITHIN the given workspace —
 * `listAccessibleProjectsInWorkspace` asserts membership (404 for non-members,
 * no existence leak) and intersects with the actor's accessible project set, so
 * a caller can never surface a requirement from another workspace or from a
 * sibling project they cannot access. Soft-deleted requirements are excluded.
 */
export async function searchWorkspaceRequirements(
  actor: SchedulerActor,
  input: SearchInput,
  db?: Parameters<typeof listAccessibleProjectsInWorkspace>[2] & LinkPrisma,
): Promise<SearchResult> {
  const { workspaceId, query, excludeProjectId, page, pageSize } = input;

  const accessibleProjectIds = await listAccessibleProjectsInWorkspace(actor, workspaceId, db);
  const projectIds = accessibleProjectIds.filter((id) => id !== excludeProjectId);

  if (projectIds.length === 0) {
    return { items: [], page, pageSize, total: 0 };
  }

  // The route may hand us the client explicitly; fall back to the default so a
  // missing wiring argument degrades to the real client instead of a 500 on an
  // `undefined` dereference.
  const database = (db ?? defaultPrisma) as unknown as LinkPrisma;

  // Case-insensitive title search differs by backend. SQLite `LIKE` is already
  // case-insensitive for ASCII, so a plain `contains` filter matches. Postgres
  // `LIKE` is case-SENSITIVE and the SQLite-generated Prisma client has no
  // `mode: "insensitive"` field, so — following the repo's adapter-by-scheme seam
  // (`resolveDatabaseProvider`, same split as notifications/preferences.ts) — the
  // Postgres path expresses the case-fold with a parameterised `ILIKE` raw query
  // (#649). Only taken when there IS a term; the term-less query is identical on
  // both backends.
  if (query && resolveDatabaseProvider() === "postgresql") {
    return searchWorkspaceRequirementsPostgres(database, { projectIds, query, page, pageSize });
  }

  const where = {
    projectId: { in: projectIds },
    deletedAt: null,
    // SQLite `LIKE` is case-insensitive for ASCII, so a plain `contains` filter
    // matches without the Postgres-only `mode: "insensitive"`. The term is a
    // bound parameter — never interpolated into SQL.
    ...(query ? { title: { contains: query } } : {}),
  };

  const [total, rows] = await Promise.all([
    database.requirement.count({ where }),
    database.requirement.findMany({
      where,
      select: { id: true, title: true, projectId: true, project: { select: { name: true } } },
      orderBy: { title: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  const items = (
    rows as unknown as Array<{
      id: string;
      title: string;
      projectId: string;
      project: { name: string };
    }>
  ).map((r) => ({
    id: r.id,
    title: r.title,
    projectId: r.projectId,
    projectName: r.project.name,
  }));

  return { items, page, pageSize, total };
}
