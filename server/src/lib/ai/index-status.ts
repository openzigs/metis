/**
 * #2326 — tell "the code does not do this" apart from "the index is stale,
 * half-built or failed", for the chat model and for the analyst.
 *
 * Before #2326 an empty retrieval read to the model as "nothing relevant
 * exists", which is how a failed index turned into a confident wrong "no"
 * (epic #2228, audit item 8). This module reads what METIS already records
 * about a project's index — each repository connection's last source ingest
 * (`sourceIngestState`, #182), its code graph (`commitSha`, `lastIndexedAt`,
 * `symbolCount`) and the project's knowledge documents — and turns it into:
 *
 *   - {@link loadProjectIndexStatus}: the facts, for the `get_index_status`
 *     chat tool and the reply's grounding label;
 *   - {@link indexStatusLine}: one sentence for the model's context when the
 *     index is failed, empty, partial or still being built;
 *   - {@link classifyIndexError} / {@link classifyRetrievalError}: a fixed
 *     summary of an error. Error text recorded by an ingest or thrown by a
 *     search can carry a path, a host or a token, so neither the model nor the
 *     UI ever sees it: they get one of a fixed set of phrases, and the full
 *     error stays in the server log (A09).
 *
 * Read-only. The caller passes the project the session is already bound to;
 * nothing here takes a project from the model.
 */
import {
  INDEX_STATES,
  MAX_GROUNDING_INDEX_REPOS,
  type GroundingIndex,
  type IndexErrorClass,
  type IndexState,
  type LastRunStatus,
} from "@metis/shared";
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { getConfigService } from "../config/config-service.js";
import { isConnectorIngestActive } from "../connectors/ingest-guard.js";
import {
  effectiveSourceIngestStatus,
  indexedCount,
  parseSourceIngestState,
  type SourceIngestState,
} from "../connectors/source-ingest-state.js";
import { repoDocumentPath, type CodeAccessFilter } from "../analysis/tools/code-access.js";
import { parseAclSubjects } from "../rag/acl.js";
import { isConsistent, type IndexConsistencySummary } from "../code-graph/index-consistency.js";

/** The filename prefix of a repository's documents (`connector-ingest.ts`). */
const REPO_DOC_PREFIX = "connector:repo:";

const log = createChildLogger("index-status");

/**
 * The registry key for the two model-facing parts: the `get_index_status`
 * tool and the status line in the retrieved-knowledge block. The grounding
 * label, the classified retrieval error and the coverage note are always on.
 */
export const INDEX_STATUS_KEY = "CHAT_INDEX_STATUS";

/**
 * #2326 — ON: with a failed or partial index recorded (`eval:ba-qa
 * --index-fault`), answers named the index problem 7/9 and 8/9 times with it
 * and 0/9 without; the line is only added when the index is unhealthy
 * (eval-data/README.md).
 */
export const INDEX_STATUS_DEFAULT = true;

/** Whether the index-status tool and context line are on. */
export function indexStatusEnabled(): boolean {
  return getConfigService().getBool(INDEX_STATUS_KEY, INDEX_STATUS_DEFAULT);
}

/** The most repositories one status lists; the rest are counted. */
export const MAX_INDEX_REPOS = MAX_GROUNDING_INDEX_REPOS;

/**
 * Ordered: the first rule whose pattern matches wins. A classifier, not a
 * redaction list (#1268): it never strips text, it replaces all of it.
 *
 * "Repository not found" is last: a LanceDB "Table … was not found" or a
 * Prisma "Record not found" names the vector index or the database, not a
 * repository, so those rules must see the text first.
 */
const ERROR_RULES: ReadonlyArray<{ cls: IndexErrorClass; pattern: RegExp }> = [
  { cls: "timed out", pattern: /\b(ETIMEDOUT|timed? ?out|timeout|AbortError|deadline)\b/i },
  {
    cls: "out of disk space or memory",
    pattern: /\b(ENOSPC|ENOMEM|no space left|out of memory|heap out of memory)\b/i,
  },
  {
    cls: "authentication failed",
    pattern:
      /\b(401|403|unauthori[sz]ed|forbidden|authentication|bad credentials|invalid token|permission denied)\b/i,
  },
  {
    cls: "network error",
    pattern:
      /\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|socket hang up|network|fetch failed)\b/i,
  },
  { cls: "access check failed", pattern: /\b(acl|actor|role)\b/i },
  { cls: "embedding model unavailable", pattern: /\b(embed\w*|onnx\w*|xenova|tokeni[sz]er)\b/i },
  {
    cls: "vector index unavailable",
    pattern: /\b(lance\w*|vector|arrow)\b|\btable\b.*\bnot found\b/i,
  },
  {
    cls: "database error",
    pattern:
      /\b(prisma\w*|sqlite|postgres\w*|database|SQLITE_\w+|P\d{4})\b|\brecords?\b.*\bnot found\b|\bno record\b/i,
  },
  {
    cls: "repository not found",
    pattern: /\b(404|not found|repository .*does not exist|no such repository)\b/i,
  },
];

/**
 * Reduce an error (an ingest's recorded message, or what a search threw) to
 * one {@link IndexErrorClass}. Never echoes the input.
 */
export function classifyIndexError(raw: unknown): IndexErrorClass {
  const text =
    raw instanceof Error
      ? `${raw.name} ${raw.message} ${String((raw as { code?: unknown }).code ?? "")}`
      : typeof raw === "string"
        ? raw
        : "";
  for (const { cls, pattern } of ERROR_RULES) if (pattern.test(text)) return cls;
  return "unexpected error";
}

export interface RepoIndexStatus {
  /** The connection's label (what the project's settings page shows), never a path. */
  label: string;
  /** Last indexed commit (code graph, else the connector's last ingest). */
  commitSha: string | null;
  /** When it was last indexed, ISO. */
  indexedAt: string | null;
  lastRun: LastRunStatus;
  /** A classified summary of why the last run or the connector failed. */
  error?: IndexErrorClass;
  /**
   * Code-graph symbols. `null` when withheld: the repository has a file under
   * a document restriction (#2243), and the symbol count includes it.
   */
  symbols: number | null;
  /**
   * Source files: eligible, indexed, and skipped by reason. `null` when not
   * recorded, or withheld as `symbols` is.
   */
  coverage: {
    eligible: number;
    indexed: number;
    failed: number;
    skipped: { limit: number; tooLarge: number; unreadable: number; policy: number };
  } | null;
  inProgress: boolean;
  /**
   * #2243 — the counts are withheld because a file in this repository is
   * restricted: they would count it whoever asks, so a caller it is hidden
   * from could learn of it.
   */
  countsWithheld?: true;
}

export interface ProjectIndexStatus {
  projectId: string;
  projectName: string;
  state: IndexState;
  /** Knowledge documents indexed for the project and visible to the caller. */
  documents: number;
  repos: RepoIndexStatus[];
  /** Repositories past {@link MAX_INDEX_REPOS}, not listed. */
  moreRepos: number;
  /** #2346 — set only when the caller asked for the check ({@link LoadIndexStatusOptions.consistency}). */
  consistency?: IndexConsistencyStatus;
}

/**
 * #2346 — the symbol index's consistency check, as a status reports it:
 * `counts` is `null` when withheld (the project has an access-restricted
 * repository file, as {@link RepoIndexStatus.countsWithheld}).
 */
export type IndexConsistencyStatus =
  | { state: "consistent" | "inconsistent"; counts: IndexConsistencySummary | null }
  | { state: "unchecked" };

function repoLastRun(
  state: SourceIngestState | null,
  hasIndex: boolean,
  now: number,
): LastRunStatus {
  if (!state) return hasIndex ? "unrecorded" : "never";
  return effectiveSourceIngestStatus(state, now);
}

function coverageOf(state: SourceIngestState | null): RepoIndexStatus["coverage"] {
  if (!state) return null;
  const s = state.skipped;
  return {
    eligible: state.eligible,
    indexed: indexedCount(state),
    failed: state.failed,
    skipped: {
      limit: s.cap,
      tooLarge: s.tooLarge,
      unreadable: s.unreadable,
      policy: s.excludedTests + (s.excludedGenerated ?? 0),
    },
  };
}

/** The repository's own state, for the project's worst-first {@link IndexState}. */
function repoState(r: RepoIndexStatus): IndexState {
  if (r.inProgress || r.lastRun === "running") return "in-progress";
  if (r.lastRun === "failed" || r.error) return "failed";
  if (r.lastRun === "partial" || r.lastRun === "interrupted") return "partial";
  if (r.lastRun === "never") return "never-indexed";
  return "healthy";
}

export interface LoadIndexStatusOptions {
  /** #2243 — the caller's code access: a document hidden from them is not counted. */
  access?: CodeAccessFilter;
  now?: number;
  /** Test seam for the in-process ingest lease. */
  ingestActive?: (connectorId: string) => boolean;
  /**
   * #2346 — run the symbol index's consistency check and report it. Only the
   * `get_index_status` tool asks: it reads every symbol vector id, so the
   * per-turn status line does not. Resolves `null` when the check could not run.
   */
  consistency?: () => Promise<IndexConsistencySummary | null>;
}

/** #2346 — a consistency check's status, its counts withheld where any repository's are. */
function consistencyStatus(
  summary: IndexConsistencySummary | null,
  withheld: boolean,
): IndexConsistencyStatus {
  if (!summary) return { state: "unchecked" };
  return {
    state: isConsistent(summary) ? "consistent" : "inconsistent",
    counts: withheld ? null : summary,
  };
}

/**
 * The index status of `projectId`, the project the session is bound to.
 * `null` when the project is gone.
 */
export async function loadProjectIndexStatus(
  projectId: string,
  opts: LoadIndexStatusOptions = {},
): Promise<ProjectIndexStatus | null> {
  const now = opts.now ?? Date.now();
  const active = opts.ingestActive ?? isConnectorIngestActive;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true },
  });
  if (!project) return null;
  // Rows from before #157 never moved off `pending`, so "not rejected" rather
  // than "indexed": an older project is not reported as empty.
  const indexedDocs = {
    projectId,
    deletedAt: null,
    indexState: { not: "rejected" },
  } as const;
  const [connections, graphs, documentCount, restrictedDocs, consistency] = await Promise.all([
    prisma.repoConnection.findMany({
      where: { projectId, deletedAt: null },
      select: {
        id: true,
        label: true,
        status: true,
        errorMessage: true,
        lastIngestAt: true,
        lastCommitSha: true,
        sourceIngestState: true,
      },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    }),
    prisma.codeGraph.findMany({
      where: { projectId },
      select: { repoConnectionId: true, commitSha: true, lastIndexedAt: true, symbolCount: true },
    }),
    // A count, not the rows: a project can hold thousands of documents.
    prisma.document.count({ where: indexedDocs }),
    // Only the restricted repository documents (#2243): which repositories'
    // counts to withhold, and which documents the caller cannot see.
    prisma.document.findMany({
      where: {
        ...indexedDocs,
        filename: { startsWith: REPO_DOC_PREFIX },
        NOT: { aclSubjects: "[]" },
      },
      select: { filename: true, aclSubjects: true },
    }),
    opts.consistency ? opts.consistency() : Promise.resolve(undefined),
  ]);
  const restricted = restrictedDocs
    .filter((d) => parseAclSubjects(d.aclSubjects).length > 0)
    .map((d) => repoDocumentPath(d.filename))
    .filter((f): f is { connectorId: string; path: string } => f !== null);
  const restrictedRepos = new Set(restricted.map((f) => f.connectorId));
  const graphByRepo = new Map(graphs.map((g) => [g.repoConnectionId, g]));
  const repos: RepoIndexStatus[] = connections.map((c) => {
    const state = parseSourceIngestState(c.sourceIngestState);
    const graph = graphByRepo.get(c.id);
    const indexedAt = graph?.lastIndexedAt ?? c.lastIngestAt ?? null;
    const lastRun = repoLastRun(state, Boolean(graph || c.lastIngestAt), now);
    // The connector's own error (a failed clone or pull) or the last run's.
    const rawError =
      c.status === "error"
        ? (c.errorMessage ?? "error")
        : lastRun === "failed"
          ? state?.error
          : null;
    const withheld = restrictedRepos.has(c.id);
    return {
      label: c.label,
      commitSha: graph?.commitSha ?? c.lastCommitSha ?? null,
      indexedAt: indexedAt ? indexedAt.toISOString() : null,
      lastRun,
      ...(rawError !== null && rawError !== undefined
        ? { error: classifyIndexError(rawError) }
        : {}),
      symbols: withheld ? null : (graph?.symbolCount ?? 0),
      coverage: withheld ? null : coverageOf(state),
      inProgress: active(c.id) || lastRun === "running",
      ...(withheld ? { countsWithheld: true as const } : {}),
    };
  });
  const access = opts.access;
  const hiddenDocs =
    access?.unrestricted === false
      ? restricted.filter((f) => access.isHidden(f.connectorId, f.path)).length
      : 0;
  const visibleDocs = Math.max(0, documentCount - hiddenDocs);
  // Something is indexed: a document (of any visibility — a hidden one is
  // still indexed), a code graph, or a repository that has run at all.
  const anyIndexed =
    documentCount > 0 || graphs.length > 0 || repos.some((r) => r.lastRun !== "never");
  const states = repos.map((r) => {
    const s = repoState(r);
    // One repository not indexed yet, beside documents or other repositories
    // that are, makes the project partial — not "nothing indexed" (#2384).
    return s === "never-indexed" && anyIndexed ? "partial" : s;
  });
  let state: IndexState =
    INDEX_STATES.find((s) => s !== "healthy" && states.includes(s)) ?? "healthy";
  if (!anyIndexed && state === "healthy") state = "never-indexed";
  return {
    projectId,
    projectName: project.name?.trim() || "this project",
    state,
    documents: visibleDocs,
    repos: repos.slice(0, MAX_INDEX_REPOS),
    moreRepos: Math.max(0, repos.length - MAX_INDEX_REPOS),
    ...(consistency !== undefined
      ? { consistency: consistencyStatus(consistency, restrictedRepos.size > 0) }
      : {}),
  };
}

/** Best-effort {@link loadProjectIndexStatus}: a failed read is logged and yields `null`. */
export async function readProjectIndexStatus(
  projectId: string,
  opts: LoadIndexStatusOptions = {},
): Promise<ProjectIndexStatus | null> {
  try {
    return await loadProjectIndexStatus(projectId, opts);
  } catch (err) {
    log.warn("Index status unreadable", {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * A server-held name (a project's or a repository's) as a quoted, escaped
 * string: an owner chose it, so a quote or a newline in it must not break out
 * of the sentence it is placed in and read as an instruction (A03).
 */
export function quoteName(name: string): string {
  return JSON.stringify(name.slice(0, 200));
}

function repoProblem(r: RepoIndexStatus): string | null {
  const name = `repository ${quoteName(r.label)}`;
  const s = repoState(r);
  if (s === "in-progress") return `${name} is still being indexed`;
  if (s === "failed")
    return `the last indexing of ${name} failed (${r.error ?? "unexpected error"})`;
  if (s === "never-indexed") return `${name} has never been indexed`;
  if (s === "partial") {
    const c = r.coverage;
    const counts = c ? `: ${c.indexed} of ${c.eligible} source files indexed` : "";
    const how = r.lastRun === "interrupted" ? "was interrupted" : "is partial";
    return `the index of ${name} ${how}${counts}`;
  }
  return null;
}

/**
 * One sentence for the model's context when the project's index is not
 * healthy, or `null` when it is. Fixed wording around server-held facts: the
 * project's and repositories' names, counts and a classified error.
 */
export function indexStatusLine(status: ProjectIndexStatus): string | null {
  if (status.state === "healthy") return null;
  const problems = status.repos.map(repoProblem).filter((p): p is string => p !== null);
  if (status.state === "never-indexed" && problems.length === 0) {
    problems.push("nothing in it has been indexed yet");
  }
  return (
    `## Index status\n` +
    `The index of project ${quoteName(status.projectName)} is not complete: ${problems.join("; ")}. ` +
    `Code and documents may be missing or out of date, so if a search finds nothing, say the ` +
    `index may be incomplete; do not conclude the project lacks it.`
  );
}

/** The `get_index_status` tool's text: one block per repository. */
export function formatIndexStatus(status: ProjectIndexStatus): string {
  const lines = [
    `Project ${quoteName(status.projectName)}: index ${status.state}; ${status.documents} knowledge document(s).`,
  ];
  if (status.repos.length === 0) lines.push("No repository is connected.");
  for (const r of status.repos) {
    const c = r.coverage;
    const coverage = r.countsWithheld
      ? "source-file counts not shown (the repository has access-restricted files)"
      : c
        ? `${c.indexed} of ${c.eligible} eligible source files indexed; ${c.failed} failed; skipped: ` +
          `${c.skipped.limit} past the file limit, ${c.skipped.tooLarge} too large, ` +
          `${c.skipped.unreadable} unreadable, ${c.skipped.policy} by policy (tests, generated)`
        : "coverage not recorded";
    lines.push(
      [
        `- Repository ${quoteName(r.label)}:`,
        `  last indexed commit ${r.commitSha ?? "unknown"} at ${r.indexedAt ?? "never"}`,
        `  last run: ${r.lastRun}${r.error ? ` (${r.error})` : ""}${r.inProgress ? "; a run is in progress" : ""}`,
        `  ${r.symbols === null ? "code symbol count not shown" : `${r.symbols} code symbol(s)`}; ${coverage}`,
      ].join("\n"),
    );
  }
  if (status.moreRepos > 0) lines.push(`(${status.moreRepos} more repositories not listed)`);
  const consistency = formatConsistency(status.consistency);
  if (consistency) lines.push(consistency);
  return lines.join("\n");
}

/** #2346 — the consistency check's line in the `get_index_status` text; `null` when not run. */
export function formatConsistency(c: IndexConsistencyStatus | undefined): string | null {
  if (!c) return null;
  if (c.state === "unchecked") return "Symbol index consistency: could not be checked.";
  const n = c.counts;
  const pending =
    n && n.pendingEmbeddings > 0
      ? ` ${n.pendingEmbeddings} code symbol(s) are not embedded yet: semantic search cannot find them until they are, keyword search can.`
      : "";
  if (c.state === "consistent") return `Symbol index consistency: consistent.${pending}`;
  if (!n) {
    return (
      "Symbol index consistency: inconsistent (counts not shown: the project has access-restricted " +
      "files). Semantic code search may miss symbols; keyword search still finds them."
    );
  }
  const parts: string[] = [];
  if (n.missingVectors > 0) parts.push(`${n.missingVectors} code symbol(s) have no vector`);
  if (n.orphanVectors > 0) parts.push(`${n.orphanVectors} vector(s) belong to no code symbol`);
  if (n.driftedGraphs > 0) {
    parts.push(
      `${n.driftedSymbols} code symbol(s) in ${n.driftedGraphs} repository index(es) were built from ` +
        `a commit other than the repository's last indexed one`,
    );
  }
  return (
    `Symbol index consistency: inconsistent: ${parts.join("; ")}. Semantic code search may miss ` +
    `symbols without a vector; keyword search still finds them.${pending}`
  );
}

/** The part of a status a reply's grounding label records (#2326). */
export function toGroundingIndex(status: ProjectIndexStatus): GroundingIndex {
  return {
    state: status.state,
    repos: status.repos.map((r) => ({
      label: r.label,
      ...(r.commitSha ? { commitSha: r.commitSha } : {}),
      ...(r.indexedAt ? { indexedAt: r.indexedAt } : {}),
      lastRun: r.lastRun,
      ...(r.error ? { error: r.error } : {}),
    })),
  };
}
