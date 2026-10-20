/**
 * #1246 — which approved requirements a repository- or path-scoped reader BRD
 * lists.
 *
 * A requirement has no repository or path of its own, so its scope is derived
 * from the code links METIS has recorded for it (option A of #1246): a
 * requirement→code mapping (`RequirementCodeMapping`) or a merged pull request
 * that implemented it (`RequirementImplementation`). A requirement is in a
 * document's scope when at least one of those links points at code in it.
 *
 * UNMAPPED REQUIREMENTS ARE LEFT OUT of a scoped document. An approved
 * requirement with no code link, or linked only to code elsewhere, cannot be
 * said to belong to the repository or paths the document covers, and listing
 * it would make every scoped BRD of a project repeat the same project-wide
 * list. The section's lead-in says so in plain words, and every approved
 * requirement stays listed in an unscoped BRD and under **Requirements**.
 *
 * A link is in a REPOSITORY when:
 *   - a mapping that names a code symbol: the symbol is in that repository's
 *     code graph (so a file path two repositories share is decided by the
 *     symbol, not by the path);
 *   - a merged pull request: its URL names the repository (the connection's
 *     owner and name), or its file is one METIS indexed for that repository;
 *   - a mapping whose symbol is gone (`codeSymbolId` is set null when a
 *     re-ingest deletes it): the file is one METIS indexed for that repository.
 * A link is in a PATH scope when its repository-relative file path is under
 * one of the prefixes, matched segment by segment (`isInPathScope`). A
 * repository document with a path scope needs both.
 *
 * Every read is filtered on `projectId`: a mapping recorded under another
 * project, or a graph of another project's repository, is never counted.
 */
import { prisma } from "../prisma.js";
import { isInPathScope, readStoredPathScope } from "./path-scope.js";
import type { ScopedRequirement } from "./requirements-scope.js";

/** The repository and/or paths a reader BRD is limited to. Empty: the whole project. */
export interface ApprovedRequirementsScope {
  /** A repository-scoped document's repository connection (`scopeFilter.repoConnectorId`). */
  repoConnectorId?: string;
  /** A path-scoped document's repository-relative prefixes (`scopeFilter.pathPrefixes`). */
  pathPrefixes?: readonly string[];
}

/** Whether `scope` limits the list at all. */
export function isScopedApprovedRequirements(scope: ApprovedRequirementsScope): boolean {
  return Boolean(scope.repoConnectorId) || (scope.pathPrefixes?.length ?? 0) > 0;
}

/**
 * The scope of a stored document, read the way generation reads it: the
 * repository of a `repository` document (`resolveEvidencePolicy`) and the
 * stored path prefixes (`readStoredPathScope`). A stored path scope that is
 * invalid throws, as it does for generation: a corrupted scope must never
 * silently widen to the whole project.
 */
export function approvedRequirementsScopeOf(doc: {
  scope: string;
  scopeFilter: string;
}): ApprovedRequirementsScope {
  let filter: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(doc.scopeFilter);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      filter = parsed as Record<string, unknown>;
    }
  } catch {
    filter = {};
  }
  const repoConnectorId =
    doc.scope === "repository" &&
    typeof filter.repoConnectorId === "string" &&
    filter.repoConnectorId.trim()
      ? filter.repoConnectorId.trim()
      : undefined;
  const pathPrefixes = readStoredPathScope(filter) ?? undefined;
  return {
    ...(repoConnectorId ? { repoConnectorId } : {}),
    ...(pathPrefixes ? { pathPrefixes } : {}),
  };
}

/**
 * Whether a pull request URL (`https://<host>/<owner>/<repo>/pull/<n>`) is one
 * of `repository`'s: owner and name compared case-insensitively, as the hosts
 * treat them. False when the connection records no owner or name, or the URL
 * does not parse.
 */
export function prNamesRepository(
  prUrl: string,
  repository: { ownerOrOrg: string | null; repoName: string | null },
): boolean {
  const owner = repository.ownerOrOrg?.trim().toLowerCase();
  const name = repository.repoName?.trim().toLowerCase();
  if (!owner || !name) return false;
  let segments: string[];
  try {
    segments = new URL(prUrl).pathname.split("/").filter(Boolean);
  } catch {
    return false;
  }
  const at = segments.indexOf("pull");
  return (
    at >= 2 &&
    segments[at - 2].toLowerCase() === owner &&
    segments[at - 1].toLowerCase() === name.replace(/\.git$/, "")
  );
}

/** Rows per `IN (...)` list, well under every supported database's bound-parameter limit. */
const IN_CHUNK = 500;

function chunks<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) out.push(values.slice(i, i + IN_CHUNK));
  return out;
}

/**
 * The requirements of `requirements` that are in `scope`, in the order given.
 * An unscoped `scope` returns them all.
 */
export async function requirementsInScope(
  projectId: string,
  requirements: readonly ScopedRequirement[],
  scope: ApprovedRequirementsScope,
): Promise<ScopedRequirement[]> {
  if (!isScopedApprovedRequirements(scope) || requirements.length === 0) return [...requirements];
  const prefixes = scope.pathPrefixes?.length ? scope.pathPrefixes : undefined;
  const inPaths = (filePath: string): boolean => !prefixes || isInPathScope(filePath, prefixes);
  const repoConnectorId = scope.repoConnectorId;

  // A path scope over the whole project: the link's path decides.
  if (!repoConnectorId) {
    return requirements.filter((r) =>
      [...r.codeMappings, ...r.implementations].some((link) => inPaths(link.filePath)),
    );
  }

  // A repository: each mapping's symbol decides where it is; a mapping without
  // one, and a merged pull request's file, are placed by the repository's files.
  const ids = requirements.map((r) => r.id);
  const mappings = (
    await Promise.all(
      chunks(ids).map((chunk) =>
        prisma.requirementCodeMapping.findMany({
          where: { projectId, requirementId: { in: chunk } },
          select: {
            requirementId: true,
            filePath: true,
            codeSymbol: {
              select: { projectId: true, graph: { select: { repoConnectionId: true } } },
            },
          },
        }),
      ),
    )
  ).flat();
  const inScope = new Set<string>();
  const byPath = new Map<string, Set<string>>();
  const placeByPath = (requirementId: string, filePath: string): void => {
    if (!inPaths(filePath)) return;
    const owners = byPath.get(filePath) ?? new Set<string>();
    owners.add(requirementId);
    byPath.set(filePath, owners);
  };
  for (const m of mappings) {
    if (m.codeSymbol) {
      if (
        m.codeSymbol.projectId === projectId &&
        m.codeSymbol.graph.repoConnectionId === repoConnectorId &&
        inPaths(m.filePath)
      ) {
        inScope.add(m.requirementId);
      }
    } else {
      placeByPath(m.requirementId, m.filePath);
    }
  }
  // A merged pull request names its repository in its URL: one of this
  // repository's is in it whether or not the file has been indexed yet (a file
  // the pull request added after the last ingest, or one no parser reads).
  const prRepository = requirements.some((r) => r.implementations.length > 0)
    ? await prisma.repoConnection.findFirst({
        where: { id: repoConnectorId, projectId, deletedAt: null },
        select: { ownerOrOrg: true, repoName: true },
      })
    : null;
  for (const r of requirements) {
    for (const link of r.implementations) {
      if (prRepository && inPaths(link.filePath) && prNamesRepository(link.prUrl, prRepository)) {
        inScope.add(r.id);
      } else {
        placeByPath(r.id, link.filePath);
      }
    }
  }
  const paths = [...byPath.keys()];
  if (paths.length > 0) {
    const found = (
      await Promise.all(
        chunks(paths).map((chunk) =>
          prisma.codeSymbol.findMany({
            where: {
              projectId,
              filePath: { in: chunk },
              graph: {
                projectId,
                repoConnectionId: repoConnectorId,
                repoConnection: { projectId, deletedAt: null },
              },
            },
            select: { filePath: true },
            distinct: ["filePath"],
          }),
        ),
      )
    ).flat();
    for (const { filePath } of found) {
      for (const id of byPath.get(filePath) ?? []) inScope.add(id);
    }
  }
  return requirements.filter((r) => inScope.has(r.id));
}
