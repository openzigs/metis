/**
 * #2338 — `get_change_history`: "when did this change, and why", for chat.
 *
 * Takes a file (optionally a line range) or a symbol, and returns the commits
 * that touched it, newest first, at most {@link HISTORY_PAGE_SIZE} per call,
 * each with its SHA, committer date, author name, subject, a body excerpt and
 * a link to the commit. Read from the connector's history repository
 * (`connectors/repo/history-repo.ts`, ADR 0023) locally: no network, no
 * credential, no shell.
 *
 * Never an empty list that reads as "never changed". Every result states its
 * coverage (ADR 0023): `cap` (more commits; a cursor fetches them), `bound`
 * (the window was reached: nothing before it is available to this tool), or
 * `none` (the whole history is shown). When history cannot be read at all the
 * result says why, in the manner of #2326: `no_history_for_source` (a `local`
 * or `upload` connector), `history_not_fetched`, `history_too_large`.
 *
 * Inputs are validated before git runs: the path is repository-relative,
 * normalised, with no `..`, no leading `-` or `:` and no control character,
 * and must be a file the index knows for the connection; a line range is two
 * positive integers; a symbol is resolved through the code graph to its file
 * and lines at the indexed commit (an ambiguous name returns its candidates).
 * The revision is always the stored indexed SHA, never one the model gives.
 *
 * Access (A01): connections are read by project, never by id alone; a file
 * the caller may not read (#2243) or a credential file gets the reply a
 * missing file gets. Commit text (A02): subject, body excerpt and author name
 * pass the shared redaction (#2333) and the connector redactor's PII patterns,
 * which remove e-mail addresses (`Signed-off-by:` trailers); the git format
 * never asks for an e-mail.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { REPO_PROVIDER_LOCAL, REPO_PROVIDER_UPLOAD, shortCommitSha } from "@metis/shared";
import { prisma } from "../../prisma.js";
import { redactString } from "../../connectors/pii-redactor.js";
import { resolveRepoHistoryPath } from "../../connectors/repo/clone-path.js";
import {
  historyReadArgs,
  historyReadEnv,
  readHistoryState,
  runGit,
  type GitRunner,
  type HistoryState,
} from "../../connectors/repo/history-repo.js";
import {
  readHistoryLog,
  type HistoryCommit,
  type HistoryLogResult,
  type HistoryQuery,
} from "../../connectors/repo/history-log.js";
import {
  buildCommitPermalink,
  codeCitationRef,
  formatCodeVersionLine,
  loadCodeVersions,
  type CodeVersionIndex,
  type PermalinkRepoSource,
} from "../../code-graph/code-version.js";
import { missingParamError } from "./arg-errors.js";
import { normalizeRepoPath, UNRESTRICTED_CODE_ACCESS } from "./code-access.js";
import { checkRepoGlob, isSensitiveRepoPath, notAccessible, repoPathError } from "./repo-paths.js";
import type { AgentTool, JSONSchema, ToolContext, ToolResult } from "./types.js";

export const CHANGE_HISTORY_TOOL_NAME = "get_change_history";
/** ADR 0023: at most 20 commits per call. */
export const HISTORY_PAGE_SIZE = 20;
/** The furthest a cursor may page. */
export const MAX_HISTORY_CURSOR = 500;
/** Characters of a commit body shown. */
export const BODY_EXCERPT_CHARS = 400;
/** Symbols listed when a name is ambiguous. */
const MAX_CANDIDATES = 10;
const MAX_SYMBOL_CHARS = 300;

const TOOL = CHANGE_HISTORY_TOOL_NAME;

const parameters: JSONSchema = {
  type: "object",
  properties: {
    filePath: {
      type: "string",
      description:
        "Repository-relative path of the file, e.g. `internal/model/feed.go`. Required unless `symbol` is given.",
    },
    startLine: {
      type: "integer",
      description: "Optional: first line of a range, to ask about those lines only.",
    },
    endLine: { type: "integer", description: "Optional: last line of the range." },
    symbol: {
      type: "string",
      description:
        "Optional, instead of filePath: a function, class or method name (or its qualified name) from the code search tools; its lines' history is returned.",
    },
    cursor: {
      type: "integer",
      description: "Optional: the cursor a previous result gave, for the next, older page.",
    },
  },
};

export type UnavailableReason =
  "no_history_for_source" | "history_not_fetched" | "history_too_large";

/** A connection of the session's project, with what a link is built from. */
export interface HistoryRepo extends PermalinkRepoSource {
  id: string;
  label: string;
}

export interface ChangeHistoryDeps {
  listRepos?: (projectId: string) => Promise<HistoryRepo[]>;
  /** Whether the index knows `filePath` for the connection (a source document or a symbol in it). */
  isIndexedFile?: (projectId: string, repoId: string, filePath: string) => Promise<boolean>;
  /** Symbols named `symbol`, filtered by `keep` before any limit is applied. */
  findSymbols?: (
    projectId: string,
    repoIds: string[],
    symbol: string,
    keep: (hit: SymbolHit) => boolean,
  ) => Promise<SymbolHit[]>;
  loadVersions?: (projectId: string) => Promise<CodeVersionIndex>;
  readState?: (repoId: string) => Promise<HistoryState | null>;
  historyDir?: (repoId: string) => string;
  run?: GitRunner;
  readLog?: (q: HistoryQuery) => Promise<HistoryLogResult>;
}

export interface SymbolHit {
  repoId: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

interface Target {
  repo: HistoryRepo;
  path: string;
  lines?: { start: number; end: number };
  /** How the target was named, for the result's header. */
  symbol?: string;
}

type Parsed =
  | {
      ok: true;
      filePath?: string;
      symbol?: string;
      lines?: { start: number; end: number };
      cursor: number;
    }
  | { ok: false; result: ToolResult };

const err = (content: string): { ok: false; result: ToolResult } => ({
  ok: false,
  result: { content, isError: true },
});

function positiveInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null;
}

/**
 * A history path: a repository-relative file path, normalised; or why not.
 * Exported for tests.
 */
export function checkHistoryPath(
  raw: string,
): { ok: true; value: string } | { ok: false; reason: string } {
  const base = checkRepoGlob(raw);
  if (!base.ok) return base;
  const value = normalizeRepoPath(base.value);
  if (value === "" || value.endsWith("/")) return { ok: false, reason: "it names no file" };
  if (value.startsWith("-") || value.startsWith(":")) {
    return { ok: false, reason: "it starts with '-' or ':'" };
  }
  if (value.split("/").some((s) => s === "..")) {
    return { ok: false, reason: "it contains '..'; paths cannot leave the repository" };
  }
  return { ok: true, value };
}

/** The call's arguments, or the error to return. Exported for tests. */
export function parseChangeHistoryArgs(args: unknown): Parsed {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const hasPath = typeof a.filePath === "string" && a.filePath.trim() !== "";
  const hasSymbol = typeof a.symbol === "string" && a.symbol.trim() !== "";
  if (!hasPath && !hasSymbol) {
    return err(
      missingParamError({
        tool: TOOL,
        param: "filePath",
        expected: "a repository-relative file path, or `symbol` instead",
        args,
        example: "internal/model/feed.go",
      }),
    );
  }
  let cursor = 0;
  if (a.cursor !== undefined && a.cursor !== null) {
    if (typeof a.cursor !== "number" || !Number.isInteger(a.cursor) || a.cursor < 0) {
      return err(repoPathError(TOOL, "cursor", "it is not a cursor a previous result gave"));
    }
    if (a.cursor > MAX_HISTORY_CURSOR) {
      return err(repoPathError(TOOL, "cursor", `it is past ${MAX_HISTORY_CURSOR} commits`));
    }
    cursor = a.cursor;
  }
  if (hasSymbol) {
    const symbol = (a.symbol as string).trim();
    if (symbol.length > MAX_SYMBOL_CHARS || /[\u0000-\u001f\u007f]/.test(symbol)) {
      return err(repoPathError(TOOL, "symbol", "it is not a symbol name"));
    }
    return { ok: true, symbol, cursor };
  }
  const p = checkHistoryPath(a.filePath as string);
  if (!p.ok) return err(repoPathError(TOOL, "filePath", p.reason));
  const hasStart = a.startLine !== undefined && a.startLine !== null;
  const hasEnd = a.endLine !== undefined && a.endLine !== null;
  if (!hasStart && !hasEnd) return { ok: true, filePath: p.value, cursor };
  const start = positiveInt(hasStart ? a.startLine : a.endLine);
  const end = positiveInt(hasEnd ? a.endLine : a.startLine);
  if (start === null || end === null) {
    return err(repoPathError(TOOL, "startLine/endLine", "a line number is not a positive integer"));
  }
  if (start > end) return err(repoPathError(TOOL, "startLine/endLine", "the range runs backwards"));
  return { ok: true, filePath: p.value, lines: { start, end }, cursor };
}

// ---- default dependencies ----------------------------------------------------

async function projectRepos(projectId: string): Promise<HistoryRepo[]> {
  return prisma.repoConnection.findMany({
    where: { projectId, deletedAt: null },
    select: {
      id: true,
      label: true,
      provider: true,
      ownerOrOrg: true,
      repoName: true,
      apiBaseUrl: true,
    },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
  });
}

async function indexedFile(projectId: string, repoId: string, filePath: string): Promise<boolean> {
  const doc = await prisma.document.findFirst({
    where: { projectId, filename: `connector:repo:${repoId}:src/${filePath}` },
    select: { id: true },
  });
  if (doc) return true;
  const sym = await prisma.codeSymbol.findFirst({
    where: { projectId, filePath, graph: { projectId, repoConnectionId: repoId } },
    select: { id: true },
  });
  return sym !== null;
}

/** Rows read per page while looking for symbols the caller may see. */
const SYMBOL_SCAN_PAGE = 100;
/** Pages read at most: past them, a name hidden this often reads as not found. */
const SYMBOL_SCAN_PAGES = 10;

/**
 * Up to `MAX_CANDIDATES + 1` symbols named `symbol` that pass `keep` (the
 * caller's ACL and sensitive-path check). The filter runs BEFORE the limit
 * (#2484 review): limiting first let eleven same-named symbols in hidden files
 * push a visible one out, a false "not found" for a restricted user.
 */
async function symbolsNamed(
  projectId: string,
  repoIds: string[],
  symbol: string,
  keep: (hit: SymbolHit) => boolean = () => true,
): Promise<SymbolHit[]> {
  const kept: SymbolHit[] = [];
  for (let page = 0; page < SYMBOL_SCAN_PAGES; page++) {
    const rows = await prisma.codeSymbol.findMany({
      where: {
        projectId,
        OR: [{ qualifiedName: symbol }, { name: symbol }],
        graph: { projectId, repoConnectionId: { in: repoIds } },
      },
      select: {
        qualifiedName: true,
        kind: true,
        filePath: true,
        startLine: true,
        endLine: true,
        graph: { select: { repoConnectionId: true } },
      },
      orderBy: [{ qualifiedName: "asc" }, { id: "asc" }],
      skip: page * SYMBOL_SCAN_PAGE,
      take: SYMBOL_SCAN_PAGE,
    });
    for (const r of rows) {
      if (r.graph.repoConnectionId === null) continue;
      const hit: SymbolHit = {
        repoId: r.graph.repoConnectionId,
        qualifiedName: r.qualifiedName,
        kind: r.kind,
        filePath: r.filePath,
        startLine: r.startLine,
        endLine: r.endLine,
      };
      if (keep(hit)) kept.push(hit);
      if (kept.length > MAX_CANDIDATES) return kept;
    }
    if (rows.length < SYMBOL_SCAN_PAGE) break;
  }
  return kept;
}

// ---- formatting --------------------------------------------------------------

const UNAVAILABLE_TEXT: Record<UnavailableReason, string> = {
  no_history_for_source:
    "this repository was added as a local folder or an uploaded archive, which carry no commit history",
  history_not_fetched:
    "commit history has not been fetched for the indexed commit (the history tool was off, the fetch failed, or the repository has not been synced since)",
  history_too_large:
    "this repository's history is larger than the history size cap (REPO_HISTORY_MAX_BYTES), so it is not kept",
};

/** The #2326-style reply when history cannot be read. Exported for tests. */
export function unavailableResult(reason: UnavailableReason, filePath: string): ToolResult {
  return {
    content:
      `History unavailable (${reason}) for ${filePath}: ${UNAVAILABLE_TEXT[reason]}. ` +
      "This says nothing about whether or when the file changed; do not answer as if it never did.",
    isError: true,
  };
}

/** Commit text with secrets and personal data (e-mail addresses) removed. */
function clean(text: string): string {
  return redactString(text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ""));
}

function excerpt(body: string): string {
  // Trailers carry people, not reasons: `Signed-off-by:`, `Co-authored-by:` …
  const kept = body
    .split("\n")
    .filter((l) => !/^[A-Za-z][A-Za-z-]*-by:\s/i.test(l.trim()))
    .join("\n")
    .trim();
  const text = clean(kept);
  return text.length > BODY_EXCERPT_CHARS ? `${text.slice(0, BODY_EXCERPT_CHARS)}…` : text;
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

function formatCommit(i: number, c: HistoryCommit, link: string | null): string {
  const lines = [
    `${i}. ${c.sha} — committed ${day(c.committedAt)} — ${clean(c.subject)}`,
    `   Author: ${clean(c.authorName) || "(unknown)"}`,
  ];
  const body = excerpt(c.body);
  if (body) lines.push(...body.split("\n").map((l) => `   | ${l}`));
  lines.push(`   Link: ${link ?? "(no link for this repository type)"}`);
  return lines.join("\n");
}

function coverageLine(
  more: "cap" | "bound" | "none",
  shown: number,
  cursor: number,
  windowStart: string,
): string {
  const since = day(windowStart);
  if (more === "cap") {
    return (
      `[more: cap — commits ${cursor + 1}-${cursor + shown} shown; older commits exist. ` +
      `Call again with cursor: ${cursor + shown} for the next page.]`
    );
  }
  if (more === "bound") {
    return (
      `[more: bound — no history before ${since} is available to this tool; ` +
      "the file may have changed before then.]"
    );
  }
  return `[more: none — this is the whole history: it starts inside the window (since ${since}).]`;
}

// ---- the tool ---------------------------------------------------------------

export function createChangeHistoryTool(deps: ChangeHistoryDeps = {}): AgentTool {
  const listRepos = deps.listRepos ?? projectRepos;
  const isIndexedFile = deps.isIndexedFile ?? indexedFile;
  const findSymbols = deps.findSymbols ?? symbolsNamed;
  const loadVersions = deps.loadVersions ?? loadCodeVersions;
  const readState = deps.readState ?? readHistoryState;
  const historyDir = deps.historyDir ?? resolveRepoHistoryPath;
  const run = deps.run ?? runGit;
  const readLog = deps.readLog ?? ((q: HistoryQuery) => readHistoryLog({ run, ...q }));

  /** The file (or symbol) the call is about, or the reply. */
  async function resolveTarget(
    parsed: Extract<Parsed, { ok: true }>,
    ctx: ToolContext,
  ): Promise<Target | ToolResult> {
    const access = ctx.codeAccess ?? UNRESTRICTED_CODE_ACCESS;
    const repos = await listRepos(ctx.projectId);
    const visible = (repoId: string, p: string): boolean =>
      !isSensitiveRepoPath(p) && (access.unrestricted || !access.isHidden(repoId, p));
    if (parsed.symbol) {
      const byId = new Map(repos.map((r) => [r.id, r] as const));
      const keep = (h: SymbolHit): boolean => byId.has(h.repoId) && visible(h.repoId, h.filePath);
      const hits = (await findSymbols(ctx.projectId, [...byId.keys()], parsed.symbol, keep)).filter(
        keep,
      );
      if (hits.length === 0) {
        return {
          content:
            `No indexed symbol is named ${parsed.symbol}. Find it with search_code_symbols, ` +
            "then ask with its qualified name or its filePath and lines.",
          resultCount: 0,
        };
      }
      if (hits.length > 1) {
        const shown = hits.slice(0, MAX_CANDIDATES);
        return {
          content:
            `${parsed.symbol} names ${hits.length > MAX_CANDIDATES ? "more than " : ""}` +
            `${shown.length} symbols; ask again with one qualified name, or with filePath and lines:\n` +
            shown
              .map(
                (h) => `- ${h.qualifiedName} (${h.kind}) ${h.filePath}:${h.startLine}-${h.endLine}`,
              )
              .join("\n"),
          resultCount: 0,
          zeroResultKind: "ambiguous-name",
        };
      }
      const h = hits[0]!;
      const checked = checkHistoryPath(h.filePath);
      if (!checked.ok) return { content: notAccessible(h.filePath), isError: true };
      return {
        repo: byId.get(h.repoId)!,
        path: checked.value,
        lines: { start: h.startLine, end: Math.max(h.startLine, h.endLine) },
        symbol: h.qualifiedName,
      };
    }
    const filePath = parsed.filePath!;
    // A missing, hidden and refused file all get the same reply: it must not
    // confirm that a restricted file exists.
    if (isSensitiveRepoPath(filePath)) return { content: notAccessible(filePath), isError: true };
    for (const repo of repos) {
      if (!visible(repo.id, filePath)) continue;
      if (await isIndexedFile(ctx.projectId, repo.id, filePath)) {
        return { repo, path: filePath, ...(parsed.lines ? { lines: parsed.lines } : {}) };
      }
    }
    return { content: notAccessible(filePath), isError: true };
  }

  /** Whether `p` is a file (a blob) at `sha` in the history repository: trees only, no network. */
  async function isFileAt(gitDir: string, sha: string, p: string): Promise<boolean> {
    const r = await run([...historyReadArgs(gitDir), "cat-file", "-t", `${sha}:${p}`], {
      env: historyReadEnv(),
      timeoutMs: 10_000,
      maxOutputBytes: 64,
    });
    return r.code === 0 && r.stdout.trim() === "blob";
  }

  async function execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const parsed = parseChangeHistoryArgs(args);
    if (!parsed.ok) return parsed.result;
    if (!ctx.projectId) {
      return { content: "Error: change history needs a project-scoped session.", isError: true };
    }
    const target = await resolveTarget(parsed, ctx);
    if (!("repo" in target)) return target;
    const { repo } = target;
    if (repo.provider === REPO_PROVIDER_LOCAL || repo.provider === REPO_PROVIDER_UPLOAD) {
      return unavailableResult("no_history_for_source", target.path);
    }
    const version = (await loadVersions(ctx.projectId)).forRepo(repo.id);
    const state = await readState(repo.id);
    if (state?.status === "too_large") return unavailableResult("history_too_large", target.path);
    if (!version.commitSha || state?.status !== "ready" || state.commitSha !== version.commitSha) {
      return unavailableResult("history_not_fetched", target.path);
    }
    const gitDir = historyDir(repo.id);
    // ADR 0023 finding 1: a shallow boundary reads as a change. Never read one.
    if (
      await fs.access(path.join(gitDir, "shallow")).then(
        () => true,
        () => false,
      )
    ) {
      return unavailableResult("history_not_fetched", target.path);
    }
    if (!(await isFileAt(gitDir, version.commitSha, target.path))) {
      return { content: notAccessible(target.path), isError: true };
    }
    const log = await readLog({
      gitDir,
      commitSha: version.commitSha,
      path: target.path,
      ...(target.lines ? { lines: target.lines } : {}),
      windowStart: state.windowStart,
      cuts: state.cuts ?? null,
      skip: parsed.cursor,
      cap: HISTORY_PAGE_SIZE,
    });
    if (!log.ok) {
      if (log.reason === "line-range") {
        return {
          content: repoPathError(
            TOOL,
            "startLine/endLine",
            "the range is past the end of the file",
          ),
          isError: true,
        };
      }
      return {
        content:
          `Error: the change history of ${target.path} could not be read (${log.reason === "timeout" ? "it took too long" : "git failed"}). ` +
          "This says nothing about whether the file changed.",
        isError: true,
      };
    }
    const subject = target.symbol
      ? `${target.symbol} (${target.path}, lines ${target.lines!.start}-${target.lines!.end})`
      : target.lines
        ? `${target.path}, lines ${target.lines.start}-${target.lines.end}`
        : target.path;
    const citation = codeCitationRef({
      repoConnectionId: repo.id,
      path: target.path,
      startLine: target.lines?.start ?? null,
      endLine: target.lines?.end ?? null,
      version,
      truncated: log.more === "cap",
    });
    const header = [
      `Change history of ${subject} in ${repo.label.replace(/[\r\n]/g, " ")}, newest first, ` +
        `walking back from the indexed commit ${shortCommitSha(version.commitSha)}. ` +
        `Window: commits committed since ${day(state.windowStart)}.`,
      formatCodeVersionLine([citation]),
    ];
    const body =
      log.commits.length > 0
        ? log.commits.map((c, i) =>
            formatCommit(parsed.cursor + i + 1, c, buildCommitPermalink(repo, c.sha)),
          )
        : [
            parsed.cursor > 0
              ? "No further commits inside the window."
              : `No commit inside the window (since ${day(state.windowStart)}) changed it.`,
          ];
    return {
      content: [
        ...header,
        ...body,
        coverageLine(log.more, log.commits.length, parsed.cursor, state.windowStart),
      ].join("\n"),
      resultCount: log.commits.length,
      truncated: log.more === "cap",
      citations: [citation],
    };
  }

  return {
    name: TOOL,
    description:
      "When did this code change, and why: the commits that changed a file, a line range of it, or a " +
      `symbol, newest first (up to ${HISTORY_PAGE_SIZE} per call), each with its date, subject, a ` +
      "message excerpt and a link. Covers a bounded window before the indexed commit, and says when " +
      "older history exists or is not available. Use it for questions about when or why something changed.",
    parameters,
    execute,
  };
}
