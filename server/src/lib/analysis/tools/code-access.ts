/**
 * #2243 — document access restrictions, applied to chat's code tools.
 *
 * A repository's source files are ingested as `Document` rows
 * (`connector:repo:<connectorId>:src/<path>`, plus the README and manifests as
 * `connector:repo:<connectorId>:<name>`, `connector-ingest.ts`), and an owner
 * can restrict one with `PATCH /api/documents/:id/acl`. Document search and
 * auto-RAG honour that (#2225). The code tools read the same file through
 * other routes — the clone on disk (`read_file_slice`), the symbol index
 * (`search_code_symbols`) and the code graph (`search_code_graph`) — so they
 * must honour it too, or a user restricted out of a file reads it through chat.
 *
 * The rule is RAG's: {@link resolveAclActor} for the caller and
 * {@link isVisibleTo} per document; a shared audience (#2248: a discussion
 * thread, a Teams reply) is {@link sharedAudienceActor}, which sees no
 * restricted document at all. A file with no `Document` row, or one whose ACL
 * is empty, is visible. When the project has no restricted repository document
 * the filter is {@link UNRESTRICTED_CODE_ACCESS} and the caller's role is not
 * even read, so an unrestricted repository behaves exactly as before.
 *
 * Paths are matched per repository connection: a restriction on `src/a.ts` in
 * one repository hides nothing in another. A code graph with no repository
 * connection (legacy) is matched against every repository's restrictions.
 */
import path from "node:path";
import { prisma } from "../../prisma.js";
import {
  isVisibleTo,
  parseAclSubjects,
  resolveAclActor,
  sharedAudienceActor,
} from "../../rag/acl.js";

const REPO_DOC_PREFIX = "connector:repo:";
/** The source-file unit's prefix after the connector id. */
const SOURCE_PREFIX = "src/";
/** Synthetic repository documents that name no file in the tree. */
const SYNTHETIC_DOCS: ReadonlySet<string> = new Set(["OVERVIEW.md"]);

export interface CodeAccessFilter {
  /** Nothing is hidden from this caller: every check passes and no query is needed. */
  readonly unrestricted: boolean;
  /**
   * The repository-relative paths hidden from this caller in the repository
   * `repoConnectionId` (`null`: a graph with no connection, so every
   * repository's), exactly as ingested.
   */
  hiddenPaths(repoConnectionId: string | null): string[];
  /**
   * Whether `filePath` is hidden in `repoConnectionId`. Normalised and compared
   * case-insensitively: a case-insensitive filesystem reads `SRC/A.ts` as
   * `src/a.ts`, so a restriction must not be stepped around by changing case.
   */
  isHidden(repoConnectionId: string | null, filePath: string): boolean;
}

/** The filter for a caller nothing is hidden from. */
export const UNRESTRICTED_CODE_ACCESS: CodeAccessFilter = {
  unrestricted: true,
  hiddenPaths: () => [],
  isHidden: () => false,
};

/** A repository-relative path in its ingested form: `/`-separated, no `./` or leading `/`. */
export function normalizeRepoPath(filePath: string): string {
  const p = path.posix
    .normalize(filePath.replace(/\\/g, "/"))
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+/, "");
  return p === "." ? "" : p;
}

/** `connector:repo:<id>:<rest>` → the connector id and the file it names, or `null`. */
export function repoDocumentPath(filename: string): { connectorId: string; path: string } | null {
  if (!filename.startsWith(REPO_DOC_PREFIX)) return null;
  const rest = filename.slice(REPO_DOC_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  const connectorId = rest.slice(0, sep);
  const name = rest.slice(sep + 1);
  if (name.startsWith(SOURCE_PREFIX)) {
    const p = normalizeRepoPath(name.slice(SOURCE_PREFIX.length));
    return p ? { connectorId, path: p } : null;
  }
  if (SYNTHETIC_DOCS.has(name) || name === "") return null;
  return { connectorId, path: normalizeRepoPath(name) };
}

/** Build a filter from the hidden `(connectorId, path)` pairs. */
export function codeAccessFilterOf(
  hidden: ReadonlyArray<{ connectorId: string; path: string }>,
): CodeAccessFilter {
  if (hidden.length === 0) return UNRESTRICTED_CODE_ACCESS;
  const exact = new Map<string, Set<string>>();
  const folded = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, k: string, v: string) => {
    let s = m.get(k);
    if (!s) m.set(k, (s = new Set()));
    s.add(v);
  };
  for (const h of hidden) {
    add(exact, h.connectorId, h.path);
    add(folded, h.connectorId, h.path.toLowerCase());
  }
  const pick = (m: Map<string, Set<string>>, repo: string | null): Set<string> => {
    if (repo !== null) return m.get(repo) ?? new Set();
    return new Set([...m.values()].flatMap((s) => [...s]));
  };
  return {
    unrestricted: false,
    hiddenPaths: (repo) => [...pick(exact, repo)],
    isHidden: (repo, filePath) => pick(folded, repo).has(normalizeRepoPath(filePath).toLowerCase()),
  };
}

export interface CodeAccessCaller {
  projectId: string;
  userId: string;
  /** #2248 — `"shared"`: the result is read by a whole audience, not `userId`. */
  aclAudience?: "shared";
}

/**
 * The code-access filter for one tool call. Rejects when the caller's ACL actor
 * cannot be resolved (an inactive user): the call then fails as a tool error,
 * never reading without the caller's restrictions — as `search-knowledge` does.
 */
export async function loadCodeAccessFilter(caller: CodeAccessCaller): Promise<CodeAccessFilter> {
  const rows = await prisma.document.findMany({
    where: {
      projectId: caller.projectId,
      source: "repo",
      deletedAt: null,
      filename: { startsWith: REPO_DOC_PREFIX },
      NOT: { aclSubjects: "[]" },
    },
    select: { filename: true, aclSubjects: true },
  });
  const restricted = rows
    .map((r) => ({
      named: repoDocumentPath(r.filename),
      subjects: parseAclSubjects(r.aclSubjects),
    }))
    .filter((r) => r.named !== null && r.subjects.length > 0);
  if (restricted.length === 0) return UNRESTRICTED_CODE_ACCESS;
  const actor =
    caller.aclAudience === "shared"
      ? sharedAudienceActor(caller.userId)
      : await resolveAclActor(caller.userId);
  return codeAccessFilterOf(
    restricted
      .filter((r) => !isVisibleTo({ subjects: r.subjects }, actor))
      .map((r) => r.named as { connectorId: string; path: string }),
  );
}

/**
 * The ids among `symbolIds` (all in `projectId`) whose file is hidden by
 * `filter`. No query when nothing is hidden.
 */
export async function hiddenSymbolIds(
  filter: CodeAccessFilter,
  projectId: string,
  symbolIds: readonly string[],
): Promise<Set<string>> {
  if (filter.unrestricted || symbolIds.length === 0) return new Set();
  const rows = await prisma.codeSymbol.findMany({
    where: { projectId, id: { in: [...symbolIds] } },
    select: { id: true, filePath: true, graph: { select: { repoConnectionId: true } } },
  });
  const known = new Set(rows.map((r) => r.id));
  const hidden = new Set(
    rows.filter((r) => filter.isHidden(r.graph.repoConnectionId, r.filePath)).map((r) => r.id),
  );
  // A hit whose symbol row is gone cannot be placed in a repository: drop it
  // rather than show a file nobody can check.
  for (const id of symbolIds) if (!known.has(id)) hidden.add(id);
  return hidden;
}
