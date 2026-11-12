/**
 * #2325 — which version of the code a chat tool result describes.
 *
 * A project's code index is built per repository connection at one commit
 * (`CodeGraph.commitSha`, written by the ingest with the connector's
 * `lastCommitSha`, #758). Every chat code and knowledge tool states that
 * commit on each location it returns ({@link CodeCitationRef}), with a link
 * pinned to it where the connector type has one.
 *
 * PERMALINKS are built only from the connector's STORED coordinates (provider,
 * owner, repository, API base URL) and the indexed commit — never from model
 * or user text — and only for the connector types that have a link scheme:
 *
 *   - `github`            → `https://github.com/<owner>/<repo>/blob/<sha>/<path>#L<a>-L<b>`
 *   - `github_enterprise` → the same on the Enterprise web origin
 *                           (`githubWebOrigin`, shared with issue drafts)
 *
 * Every other type (`gitlab`, which METIS does not clone, `local`, `upload`)
 * gets `null`, as does a connector with no commit: a link is pinned to the
 * indexed commit or it is not written. `URL.origin` drops any userinfo, so a
 * credential embedded in a stored base URL never reaches a link.
 */
import type { CodeCitationRef, RetrievalMatcher } from "@metis/shared";
import { shortCommitSha } from "@metis/shared";
import { prisma } from "../prisma.js";
import { githubWebOrigin } from "../publishing/draft-code-links.js";

/** The stored connector coordinates a permalink is built from. */
export interface PermalinkRepoSource {
  provider: string;
  ownerOrOrg: string | null;
  repoName: string | null;
  apiBaseUrl: string | null;
}

const SHA_RE = /^[0-9a-f]{7,64}$/i;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Repository-relative path segments, or `null` if the path is not safe to link. */
function safePathSegments(filePath: string): string[] | null {
  if (!filePath || CONTROL_RE.test(filePath) || filePath.includes("\\")) return null;
  if (filePath.startsWith("/") || SCHEME_RE.test(filePath)) return null;
  const segments = filePath.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  return segments;
}

function lineFragment(startLine: number | null, endLine: number | null): string {
  if (startLine === null || !Number.isInteger(startLine) || startLine < 1) return "";
  if (endLine === null || !Number.isInteger(endLine) || endLine <= startLine) {
    return `#L${startLine}`;
  }
  return `#L${startLine}-L${endLine}`;
}

/**
 * A link to `filePath` at `commitSha`, or `null` when the connector type has
 * no link scheme, the coordinates or the commit are not safe, or the path is
 * not a plain repository-relative one.
 */
export function buildCodePermalink(
  repo: PermalinkRepoSource | null | undefined,
  commitSha: string | null,
  filePath: string,
  startLine: number | null,
  endLine: number | null,
): string | null {
  if (!repo || !commitSha || !SHA_RE.test(commitSha)) return null;
  if (repo.provider !== "github" && repo.provider !== "github_enterprise") return null;
  const origin = githubWebOrigin(repo.provider, repo.apiBaseUrl);
  const owner = repo.ownerOrOrg ?? "";
  const name = repo.repoName ?? "";
  if (!origin || !NAME_RE.test(owner) || !NAME_RE.test(name)) return null;
  const segments = safePathSegments(filePath);
  if (!segments) return null;
  return (
    `${origin}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}` +
    `/blob/${commitSha}/${segments.map(encodeURIComponent).join("/")}` +
    lineFragment(startLine, endLine)
  );
}

/** One repository's indexed version. */
export interface RepoCodeVersion {
  commitSha: string | null;
  repo: PermalinkRepoSource | null;
}

/** The indexed version of each of a project's repositories. */
export interface CodeVersionIndex {
  /**
   * The version of the repository `repoConnectionId`. An id the index does
   * not hold is "unknown", never another repository's version: a project
   * whose second repository is still indexing (or failed to) must not lend
   * the first one's commit, staleness or permalink to the second's files.
   * Only a `null`/absent id (a legacy graph with no connection, a hit whose
   * repository was not read) resolves to the project's only graph, when it
   * has exactly one.
   */
  forRepo(repoConnectionId: string | null | undefined): RepoCodeVersion;
}

const UNKNOWN: RepoCodeVersion = { commitSha: null, repo: null };

/** An index over already-read rows (exported for tests and callers that hold them). */
export function codeVersionIndexOf(
  rows: ReadonlyArray<{ repoConnectionId: string | null } & RepoCodeVersion>,
): CodeVersionIndex {
  const byRepo = new Map<string, RepoCodeVersion>();
  for (const r of rows) {
    if (r.repoConnectionId && !byRepo.has(r.repoConnectionId)) {
      byRepo.set(r.repoConnectionId, { commitSha: r.commitSha, repo: r.repo });
    }
  }
  const only = rows.length === 1 ? rows[0]! : null;
  return {
    forRepo(repoConnectionId) {
      if (repoConnectionId) return byRepo.get(repoConnectionId) ?? UNKNOWN;
      return only ? { commitSha: only.commitSha, repo: only.repo } : UNKNOWN;
    },
  };
}

/** A project with no index: every location's version is unknown. */
export const NO_CODE_VERSIONS: CodeVersionIndex = codeVersionIndexOf([]);

/** The `select` that reads a code graph's version: its commit and its connector's coordinates. */
export const GRAPH_VERSION_SELECT = {
  repoConnectionId: true,
  commitSha: true,
  repoConnection: {
    select: {
      provider: true,
      ownerOrOrg: true,
      repoName: true,
      apiBaseUrl: true,
      deletedAt: true,
      projectId: true,
    },
  },
} as const;

/** A code graph row read with {@link GRAPH_VERSION_SELECT}. */
export interface GraphVersionRow {
  repoConnectionId?: string | null;
  commitSha?: string | null;
  repoConnection?: {
    provider: string;
    ownerOrOrg: string | null;
    repoName: string | null;
    apiBaseUrl: string | null;
    deletedAt: Date | null;
    projectId: string;
  } | null;
}

/**
 * A graph row's version. A deleted connector, or one in another project, lends
 * no coordinates (so no link); a commit that is not a SHA is unknown.
 */
export function versionOfGraph(row: GraphVersionRow, projectId: string): RepoCodeVersion {
  const c = row.repoConnection;
  const live = c && !c.deletedAt && c.projectId === projectId;
  return {
    commitSha: row.commitSha && SHA_RE.test(row.commitSha) ? row.commitSha : null,
    repo: live
      ? {
          provider: c.provider,
          ownerOrOrg: c.ownerOrOrg,
          repoName: c.repoName,
          apiBaseUrl: c.apiBaseUrl,
        }
      : null,
  };
}

/** Read a project's indexed versions: one row per code graph, filtered on `projectId`. */
export async function loadCodeVersions(projectId: string): Promise<CodeVersionIndex> {
  const rows = await prisma.codeGraph.findMany({
    where: { projectId },
    select: GRAPH_VERSION_SELECT,
    orderBy: { lastIndexedAt: "desc" },
  });
  return codeVersionIndexOf(
    rows.map((r) => ({ repoConnectionId: r.repoConnectionId, ...versionOfGraph(r, projectId) })),
  );
}

/** One location's citation ref at `version`. */
export function codeCitationRef(input: {
  /** The repository the file is in (`null`: not known); see {@link CodeCitationRef}. */
  repoConnectionId: string | null | undefined;
  path: string;
  startLine: number | null;
  endLine: number | null;
  version: RepoCodeVersion;
  matchedBy?: readonly RetrievalMatcher[];
  truncated?: boolean;
  totalLines?: number | null;
  next?: { startLine: number; endLine: number };
  stale?: boolean;
  workingTreeSha?: string | null;
}): CodeCitationRef {
  const { version } = input;
  return {
    repoConnectionId: input.repoConnectionId ?? null,
    path: input.path,
    startLine: input.startLine,
    endLine: input.endLine,
    commitSha: version.commitSha,
    permalink: buildCodePermalink(
      version.repo,
      version.commitSha,
      input.path,
      input.startLine,
      input.endLine,
    ),
    ...(input.matchedBy && input.matchedBy.length > 0 ? { matchedBy: [...input.matchedBy] } : {}),
    truncated: input.truncated === true,
    totalLines: input.totalLines ?? null,
    ...(input.next ? { next: input.next } : {}),
    stale: input.stale === true,
    ...(input.stale ? { workingTreeSha: input.workingTreeSha ?? null } : {}),
  };
}

/**
 * The line a tool result ends with, telling the model which version of the
 * code the locations above describe: `Code version: indexed commit <sha>`
 * (several, comma-separated, when the result spans repositories), or that the
 * index records none. `""` for a result with no locations.
 */
export function formatCodeVersionLine(refs: readonly CodeCitationRef[]): string {
  if (refs.length === 0) return "";
  const shas = [...new Set(refs.map((r) => r.commitSha).filter((s): s is string => !!s))];
  const unknown = refs.some((r) => !r.commitSha);
  if (shas.length === 0) return "Code version: unknown (the index records no commit).";
  const list = shas.map((s) => shortCommitSha(s)).join(", ");
  const noun = shas.length === 1 ? "commit" : "commits";
  return `Code version: indexed ${noun} ${list}${unknown ? " (some locations: unknown)" : ""}.`;
}
