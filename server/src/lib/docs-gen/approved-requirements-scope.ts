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
 * A MAPPING is in a repository when the code symbol it names is in that
 * repository's code graph (so a file path two repositories share is decided by
 * the symbol, not by the path); a mapping whose symbol is gone (`codeSymbolId`
 * is set null when a re-ingest deletes it) when its file is one METIS indexed
 * for that repository.
 *
 * A MERGED PULL REQUEST counts only when its URL names one of THIS project's
 * live repository connections (owner and name), and it is in a repository
 * when its URL names that repository. Never by its file path alone:
 *   - two repositories of a project often share a path (`src/index.ts`), and a
 *     pull request of one must not place a requirement in the other's BRD;
 *   - `RequirementImplementation` rows carry no project, and the webhook that
 *     writes them matches a pull request to a requirement by issue number
 *     alone, so a row can come from another project's repository entirely.
 *     Such a row never decides this project's list.
 *
 * A link is in a PATH scope when its repository-relative file path is under
 * one of the prefixes, matched segment by segment (`isInPathScope`). A
 * repository document with a path scope needs both.
 *
 * Every read is filtered on `projectId`: a mapping recorded under another
 * project, a graph or symbol of another project, or a deleted connection, is
 * never counted.
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
 * invalid throws `InvalidStoredPathScopeError`, as it does for generation: a
 * corrupted scope must never silently widen to the whole project.
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

/** A repository named by owner and name, lower-cased, without a `.git` suffix. */
export interface NamedRepository {
  owner: string;
  name: string;
}

function repositoryKey(owner: string, name: string): string | null {
  const o = owner.trim().toLowerCase();
  const n = name
    .trim()
    .toLowerCase()
    .replace(/\.git$/, "");
  return o && n ? `${o}/${n}` : null;
}

/**
 * The repository a pull request URL (`https://<host>/<owner>/<repo>/pull/<n>`)
 * names, or null when it names none (it does not parse, or has no
 * `<owner>/<repo>/pull` shape).
 */
export function repositoryOfPrUrl(prUrl: string): NamedRepository | null {
  let segments: string[];
  try {
    segments = new URL(prUrl).pathname.split("/").filter(Boolean);
  } catch {
    return null;
  }
  // Read from the end, by position: `<owner>/<repo>/pull/<number>`. An owner or
  // repository named `pull` is then still read correctly.
  const n = segments.length;
  if (n < 4 || segments[n - 2] !== "pull" || !/^\d+$/.test(segments[n - 1])) return null;
  const key = repositoryKey(segments[n - 4], segments[n - 3]);
  if (!key) return null;
  const [owner, name] = key.split("/");
  return { owner, name };
}

/**
 * The ids of the `connections` a pull request URL names: owner and name
 * compared case-insensitively, as the hosts treat them, a `.git` suffix on
 * either side ignored. A connection that records no owner or name is never
 * named.
 */
export function connectionsNamedByPrUrl(
  prUrl: string,
  connections: ReadonlyArray<{ id: string; ownerOrOrg: string | null; repoName: string | null }>,
): string[] {
  const named = repositoryOfPrUrl(prUrl);
  if (!named) return [];
  const key = `${named.owner}/${named.name}`;
  return connections
    .filter((c) => c.ownerOrOrg && c.repoName && repositoryKey(c.ownerOrOrg, c.repoName) === key)
    .map((c) => c.id);
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
  const inScope = new Set<string>();

  // Merged pull requests: by the repository their URL names, among this
  // project's live connections only.
  if (requirements.some((r) => r.implementations.length > 0)) {
    const connections = await prisma.repoConnection.findMany({
      where: { projectId, deletedAt: null },
      select: { id: true, ownerOrOrg: true, repoName: true },
    });
    for (const r of requirements) {
      for (const link of r.implementations) {
        if (!inPaths(link.filePath)) continue;
        const named = connectionsNamedByPrUrl(link.prUrl, connections);
        if (repoConnectorId ? named.includes(repoConnectorId) : named.length > 0) {
          inScope.add(r.id);
        }
      }
    }
  }

  // A path scope over the whole project: a mapping's path decides.
  if (!repoConnectorId) {
    for (const r of requirements) {
      if (r.codeMappings.some((link) => inPaths(link.filePath))) inScope.add(r.id);
    }
    return requirements.filter((r) => inScope.has(r.id));
  }

  // A repository: each mapping's symbol decides where it is; a mapping whose
  // symbol is gone is placed by the repository's indexed files.
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
  const byPath = new Map<string, Set<string>>();
  for (const m of mappings) {
    if (!inPaths(m.filePath)) continue;
    if (m.codeSymbol) {
      if (
        m.codeSymbol.projectId === projectId &&
        m.codeSymbol.graph.repoConnectionId === repoConnectorId
      ) {
        inScope.add(m.requirementId);
      }
    } else {
      const owners = byPath.get(m.filePath) ?? new Set<string>();
      owners.add(m.requirementId);
      byPath.set(m.filePath, owners);
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
