/**
 * Workspace-level traceability rollup — Epic #610 (#626).
 *
 * The single-requirement spine (`traceability-spine.ts`, #229) is intentionally
 * project-scoped and 404s outside the given project. This module adds a
 * WORKSPACE layer on top of it WITHOUT rewriting the spine:
 *
 *   1. `getRequirementChainWithLinks` — the base project-scoped chain, plus the
 *      chains of requirements reachable by following `RequirementLink` edges
 *      (1 hop by default, `depth` capped at `MAX_TRACEABILITY_LINK_DEPTH`). Each
 *      linked requirement's project is access-checked against the caller; an
 *      inaccessible counterpart is surfaced as `restricted: true` with a null
 *      chain rather than leaking its content, and the walk does NOT expand
 *      through it.
 *
 *   2. `getWorkspaceTraceabilitySummary` — per-project coverage counts plus the
 *      cross-project link map, both confined to the projects the caller can see
 *      WITHIN the workspace (`listAccessibleProjectsInWorkspace` asserts
 *      workspace membership → 404, and intersects with the actor's accessible
 *      project set). Query cost is bounded by the number of accessible projects
 *      — there is no unbounded graph walk.
 *
 * Authorization reuses the SAME seams as the link API (#624): per-project
 * `actorCanAccessProject` (`scheduler/project-access.ts`) and
 * `listAccessibleProjectsInWorkspace` (`cross-project/cross-project-access.ts`).
 * A rollup therefore never surfaces a requirement or link in a project /
 * workspace the caller cannot access.
 */
import type { PrismaClient } from "@prisma/client";
import {
  MAX_TRACEABILITY_LINK_DEPTH,
  type CrossProjectLinkEdge,
  type LinkedRequirementChain,
  type RequirementChainWithLinks,
  type RequirementLinkType,
  type TraceabilityLinkEdge,
  type WorkspaceProjectTraceability,
  type WorkspaceTraceabilitySummary,
} from "@metis/shared";
import { prisma as defaultPrisma } from "../prisma.js";
import { actorCanAccessProject, type SchedulerActor } from "../scheduler/project-access.js";
import { listAccessibleProjectsInWorkspace } from "../cross-project/cross-project-access.js";
import { getRequirementChain } from "./traceability-spine.js";

/**
 * Prisma surface the rollup needs: the spine's four tables plus `requirementLink`
 * (edge traversal), `project` (names) and `workspaceMember` (access checks).
 * Kept narrow so unit tests can supply a hand-rolled mock.
 */
type RollupPrisma = Pick<
  PrismaClient,
  | "requirement"
  | "requirementSpecMapping"
  | "specCodeMapping"
  | "requirementCodeMapping"
  | "requirementLink"
  | "project"
  | "workspaceMember"
>;

export interface RollupDeps {
  prisma?: RollupPrisma;
}

function pickPrisma(deps?: RollupDeps): RollupPrisma {
  return (deps?.prisma ?? (defaultPrisma as unknown as RollupPrisma)) as RollupPrisma;
}

/** Clamp a requested depth into `[1, MAX_TRACEABILITY_LINK_DEPTH]` (default 1). */
export function clampLinkDepth(requested?: number): number {
  if (requested == null || !Number.isFinite(requested)) return 1;
  return Math.min(Math.max(Math.floor(requested), 1), MAX_TRACEABILITY_LINK_DEPTH);
}

// Endpoint context selected for every traversed link edge.
const LINK_ENDPOINT_SELECT = {
  id: true,
  title: true,
  projectId: true,
  project: { select: { name: true } },
} as const;

const LINK_EDGE_SELECT = {
  id: true,
  type: true,
  sourceRequirementId: true,
  targetRequirementId: true,
  source: { select: LINK_ENDPOINT_SELECT },
  target: { select: LINK_ENDPOINT_SELECT },
} as const;

type LinkEndpoint = {
  id: string;
  title: string;
  projectId: string;
  project: { name: string };
};

type LinkEdgeRow = {
  id: string;
  type: string;
  sourceRequirementId: string;
  targetRequirementId: string;
  source: LinkEndpoint;
  target: LinkEndpoint;
};

export interface LinkedChainOptions {
  /** Number of `RequirementLink` hops to follow (default 1, capped). */
  depth?: number;
}

/**
 * The base project-scoped chain for `requirementId`, plus the chains of every
 * requirement reachable within `depth` `RequirementLink` hops. Inaccessible
 * counterparts are flagged `restricted` (null chain) and never expanded through.
 * The base chain 404s if the requirement is not in `projectId` (spine contract,
 * unchanged) — so `includeLinked=false` callers behave exactly as before.
 */
export async function getRequirementChainWithLinks(
  actor: SchedulerActor,
  projectId: string,
  requirementId: string,
  options: LinkedChainOptions = {},
  deps?: RollupDeps,
): Promise<RequirementChainWithLinks> {
  const prisma = pickPrisma(deps);
  const depth = clampLinkDepth(options.depth);

  // Base chain — spine is untouched and still project-scoped (404 if missing).
  const base = await getRequirementChain(projectId, requirementId, { prisma });

  const linkedChains: LinkedRequirementChain[] = [];
  const accessCache = new Map<string, boolean>();
  const canAccess = async (pid: string): Promise<boolean> => {
    const cached = accessCache.get(pid);
    if (cached !== undefined) return cached;
    const allowed = await actorCanAccessProject(actor, pid, {
      resource: "requirement",
      resourceId: requirementId,
      action: "traceability.link.read",
    });
    accessCache.set(pid, allowed);
    return allowed;
  };

  const visited = new Set<string>([requirementId]);
  let frontier: string[] = [requirementId];

  for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
    const edges = (await prisma.requirementLink.findMany({
      where: {
        OR: [{ sourceRequirementId: { in: frontier } }, { targetRequirementId: { in: frontier } }],
      },
      select: LINK_EDGE_SELECT,
    })) as unknown as LinkEdgeRow[];

    const next: string[] = [];
    for (const edge of edges) {
      // The counterpart is whichever endpoint is not already known. If both are
      // visited it is an intra-frontier edge (or a back-edge) — skip.
      const counterpart: LinkEndpoint = visited.has(edge.sourceRequirementId)
        ? edge.target
        : edge.source;
      if (visited.has(counterpart.id)) continue;
      visited.add(counterpart.id);

      const linkEdge: TraceabilityLinkEdge = {
        linkId: edge.id,
        type: edge.type as RequirementLinkType,
        sourceRequirementId: edge.sourceRequirementId,
        targetRequirementId: edge.targetRequirementId,
        requirement: {
          id: counterpart.id,
          title: counterpart.title,
          projectId: counterpart.projectId,
          projectName: counterpart.project.name,
        },
      };

      if (!(await canAccess(counterpart.projectId))) {
        linkedChains.push({ link: linkEdge, chain: null, restricted: true });
        continue; // never expand through an inaccessible node
      }

      const chain = await getRequirementChain(counterpart.projectId, counterpart.id, { prisma });
      linkedChains.push({ link: linkEdge, chain, restricted: false });
      next.push(counterpart.id);
    }
    frontier = next;
  }

  return { ...base, depth, linkedChains };
}

function addToSet(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(value);
  map.set(key, set);
}

type LinkProjectRow = {
  id: string;
  type: string;
  source: { id: string; projectId: string };
  target: { id: string; projectId: string };
};

/**
 * Aggregate a workspace's traceability: per-project coverage counts plus the
 * cross-project link map. Scoped to the caller's accessible projects within the
 * workspace (membership asserted → 404 for non-members). Bounded query cost:
 * one link query + O(#projects) count queries; no unbounded graph traversal.
 */
export async function getWorkspaceTraceabilitySummary(
  actor: SchedulerActor,
  workspaceId: string,
  deps?: RollupDeps,
): Promise<WorkspaceTraceabilitySummary> {
  const prisma = pickPrisma(deps);

  // Asserts workspace membership (404) + intersects with accessible projects.
  const projectIds = await listAccessibleProjectsInWorkspace(actor, workspaceId, prisma);
  if (projectIds.length === 0) {
    return { projects: [], crossProjectLinks: [] };
  }

  // Cross-project links: BOTH endpoints must sit in the accessible set (never
  // leak an inaccessible project) and in DIFFERENT projects. Bounded to the
  // workspace's accessible projects via a relation filter.
  const linkRows = (await prisma.requirementLink.findMany({
    where: {
      source: { projectId: { in: projectIds } },
      target: { projectId: { in: projectIds } },
    },
    select: {
      id: true,
      type: true,
      source: { select: { id: true, projectId: true } },
      target: { select: { id: true, projectId: true } },
    },
  })) as unknown as LinkProjectRow[];

  const crossProjectLinks: CrossProjectLinkEdge[] = [];
  const crossReqByProject = new Map<string, Set<string>>();
  for (const row of linkRows) {
    if (row.source.projectId === row.target.projectId) continue;
    crossProjectLinks.push({
      linkId: row.id,
      type: row.type as RequirementLinkType,
      source: { requirementId: row.source.id, projectId: row.source.projectId },
      target: { requirementId: row.target.id, projectId: row.target.projectId },
    });
    addToSet(crossReqByProject, row.source.projectId, row.source.id);
    addToSet(crossReqByProject, row.target.projectId, row.target.id);
  }

  const projectRows = await prisma.project.findMany({
    where: { id: { in: projectIds } },
    select: { id: true, name: true },
  });
  const nameById = new Map(projectRows.map((p) => [p.id, p.name] as const));

  const projects: WorkspaceProjectTraceability[] = await Promise.all(
    projectIds.map(async (pid): Promise<WorkspaceProjectTraceability> => {
      const [requirements, specMapped, codeMapped] = await Promise.all([
        prisma.requirement.count({ where: { projectId: pid, deletedAt: null } }),
        prisma.requirementSpecMapping.findMany({
          where: { projectId: pid },
          select: { requirementId: true },
          distinct: ["requirementId"],
        }),
        prisma.requirementCodeMapping.findMany({
          where: { projectId: pid },
          select: { requirementId: true },
          distinct: ["requirementId"],
        }),
      ]);
      // Mapping tables can retain rows for soft-deleted requirements, so clamp
      // the fraction to 1 rather than let the numerator exceed the denominator.
      const coverage = (mapped: number): number =>
        requirements === 0 ? 0 : Math.min(1, mapped / requirements);
      return {
        projectId: pid,
        name: nameById.get(pid) ?? pid,
        requirements,
        linkedCrossProject: crossReqByProject.get(pid)?.size ?? 0,
        specCoverage: coverage(specMapped.length),
        codeCoverage: coverage(codeMapped.length),
      };
    }),
  );

  return { projects, crossProjectLinks };
}
