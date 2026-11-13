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
 * #2314 — and outside chat: the analysis code agent's tools and its fused
 * symbol context, and Spec Kit's fused symbol block, as a shared audience
 * ({@link loadSharedCodeAccess}); chat auto-RAG's fused symbol block as the
 * turn's actor (`buildFusedCodeBlock`'s `hiddenSymbols`).
 *
 * Paths are matched per repository connection: a restriction on `src/a.ts` in
 * one repository hides nothing in another. A code graph with no repository
 * connection (legacy) is matched against every repository's restrictions.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "../../prisma.js";
import { SYSTEM_ACTOR_ID } from "../../audit/system-actor.js";
import {
  isVisibleTo,
  parseAclSubjects,
  resolveAclActor,
  sharedAudienceActor,
  type AclActor,
} from "../../rag/acl.js";
import type { HiddenSymbolsLookup } from "../../rag/fused-code-context.js";

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
   * Whether `filePath` is hidden in `repoConnectionId`. Normalised, then
   * compared exactly, as the code graph is: on a case-sensitive clone
   * `src/Config.ts` and `src/config.ts` are different files. A case variant
   * read on a case-insensitive filesystem is caught by `read_file_slice`
   * checking the path the read really resolves to, which carries the on-disk
   * case.
   */
  isHidden(repoConnectionId: string | null, filePath: string): boolean;
  /**
   * #2437 — how many files are hidden, over every repository: a path hidden in
   * two repositories is two files. Counted, never listed, on what a run left out.
   */
  readonly hiddenFileCount: number;
}

/** The filter for a caller nothing is hidden from. */
export const UNRESTRICTED_CODE_ACCESS: CodeAccessFilter = {
  unrestricted: true,
  hiddenPaths: () => [],
  isHidden: () => false,
  hiddenFileCount: 0,
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
  const byRepo = new Map<string, Set<string>>();
  for (const h of hidden) {
    let paths = byRepo.get(h.connectorId);
    if (!paths) byRepo.set(h.connectorId, (paths = new Set()));
    paths.add(h.path);
  }
  const pick = (repo: string | null): Set<string> => {
    if (repo !== null) return byRepo.get(repo) ?? new Set();
    return new Set([...byRepo.values()].flatMap((s) => [...s]));
  };
  return {
    unrestricted: false,
    hiddenPaths: (repo) => [...pick(repo)],
    isHidden: (repo, filePath) => pick(repo).has(normalizeRepoPath(filePath)),
    hiddenFileCount: [...byRepo.values()].reduce((n, paths) => n + paths.size, 0),
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
export function loadCodeAccessFilter(caller: CodeAccessCaller): Promise<CodeAccessFilter> {
  return loadCodeAccessFilterFor(caller.projectId, () =>
    caller.aclAudience === "shared"
      ? Promise.resolve(sharedAudienceActor(caller.userId))
      : resolveAclActor(caller.userId),
  );
}

/**
 * #2314 — the code-access filter of output a whole project reads: a shared
 * audience (#2248), which sees no restricted file. Used for an analysis (its
 * findings, citations and snippets are persisted and read by every member
 * with `analysis.read`) and for a Spec Kit artifact. Deliberately NOT the
 * requester's own access: a file only they may see would otherwise be quoted
 * into output the rest of the project reads. This supersedes, for persisted
 * output, the #2262 "runs as the requester" rule the document reader follows,
 * and is the rule the discussion responder uses (`aclAudience: "shared"`).
 * No actor is resolved, so it never rejects for an inactive requester.
 */
export function loadSharedCodeAccess(projectId: string): Promise<CodeAccessFilter> {
  return loadCodeAccessFilter({ projectId, userId: SYSTEM_ACTOR_ID, aclAudience: "shared" });
}

/**
 * #2314 — the code-access filter for `actor` in `projectId`, for a caller that
 * already holds the actor (chat's auto-RAG, a shared audience). A function is
 * called only when the project has a restricted repository document, so an
 * unrestricted project reads no role. Rejects when the actor cannot be
 * resolved: the caller must then show no code at all.
 */
export async function loadCodeAccessFilterFor(
  projectId: string,
  actor: AclActor | (() => Promise<AclActor>),
): Promise<CodeAccessFilter> {
  const rows = await prisma.document.findMany({
    where: {
      projectId,
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
  const resolved = typeof actor === "function" ? await actor() : actor;
  return codeAccessFilterOf(
    restricted
      .filter((r) => !isVisibleTo({ subjects: r.subjects }, resolved))
      .map((r) => r.named as { connectorId: string; path: string }),
  );
}

/**
 * #2243 — whether `filePath` in the clone of `repoId` is a hidden file. Checked
 * on the path as asked AND on where it really resolves, so a symlink inside the
 * repository (`public.ts -> secret.ts`) cannot read a hidden file under
 * another name. #2314 — `repoId` `null`: a clone of unknown repository,
 * matched against every repository's restrictions.
 */
export async function isHiddenInClone(
  access: CodeAccessFilter,
  repoId: string | null,
  cloneDir: string,
  filePath: string,
): Promise<boolean> {
  const asked = path.relative(path.resolve(cloneDir), path.resolve(cloneDir, filePath));
  if (access.isHidden(repoId, asked)) return true;
  try {
    const [real, root] = await Promise.all([
      fs.realpath(path.resolve(cloneDir, filePath)),
      fs.realpath(cloneDir),
    ]);
    return access.isHidden(repoId, path.relative(root, real));
  } catch {
    return false; // not on disk: the read reports it as not found
  }
}

/**
 * #2437 — what one access check left out: how many files the filter hides,
 * and the ids of the symbols it dropped (an id, never a path or a name).
 */
export interface RestrictedLeftOut {
  files: number;
  symbolIds: string[];
}

/**
 * #2314 — `buildFusedCodeBlock`'s `hiddenSymbols` for the filter `load`
 * resolves. `load` runs at most once, and only when the searcher returned a
 * hit, so a fused block with nothing to filter costs no query. Each hit is
 * judged on the file and repository its line lookup already resolved, so no
 * symbol is read twice; a hit whose repository is unknown is matched against
 * every repository's restrictions, as a legacy graph is.
 *
 * #2437 — `onLeftOut` is told, on each check under a restricted filter, how
 * many files it hides and which hits it dropped, so a run can say how much it
 * left out.
 */
export function hiddenSymbolsFor(
  load: () => Promise<CodeAccessFilter>,
  onLeftOut?: (left: RestrictedLeftOut) => void,
): HiddenSymbolsLookup {
  let filter: Promise<CodeAccessFilter> | undefined;
  return async (hits) => {
    filter ??= load();
    const f = await filter;
    if (f.unrestricted) return new Set();
    const hidden = hits
      .filter((h) => f.isHidden(h.repoConnectionId ?? null, h.filePath))
      .map((h) => h.symbolId);
    onLeftOut?.({ files: f.hiddenFileCount, symbolIds: hidden });
    return new Set(hidden);
  };
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
