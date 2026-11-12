/**
 * #2242 — the citations a chat answer makes, each checked against what the
 * turn actually retrieved or read.
 *
 * Chat, the Workbench and discussions are told to cite `file:line` (#715), but
 * before #2242 nothing checked a citation, so a fabricated path or line range
 * read exactly like a real one. The server now parses every citation in a
 * reply and records whether it resolves:
 *
 * - `verified`: the file or document is one the turn retrieved or read, and
 *   any cited line range lies within lines that were read;
 * - `verified-earlier`: the file and lines were read by a tool in an earlier
 *   turn of the same conversation, still in the model's context — the #773
 *   history digest tells the model those citations stand;
 * - `span-unverified`: the file was retrieved or read, but not the cited
 *   lines (or it was read as a document excerpt, which has no line numbers);
 * - `ambiguous`: a short path that names more than one file read, none of
 *   whose read lines cover the citation;
 * - `not-read`: nothing the turn retrieved or read is that file or document.
 *
 * Recorded on the assistant row (`meta.citations`) and streamed as a
 * `citations` event, so the label is the same live and after a reload.
 */
import { RETRIEVAL_MATCHERS, type RetrievalMatcher } from "./project.js";

export const CHAT_CITATION_STATUSES = [
  "verified",
  "verified-earlier",
  "span-unverified",
  "ambiguous",
  "not-read",
] as const;
export type ChatCitationStatus = (typeof CHAT_CITATION_STATUSES)[number];

/** Whether a status means the citation checked out (this turn or an earlier one). */
export function isVerifiedCitation(status: ChatCitationStatus): boolean {
  return status === "verified" || status === "verified-earlier";
}

/** Where a cited file came from: a repository the project connects, or a document. */
export const CHAT_CITATION_SOURCES = ["repo", "document"] as const;
export type ChatCitationSource = (typeof CHAT_CITATION_SOURCES)[number];

export interface ChatCitation {
  /** The citation as the answer wrote it (`internal/model/feed.go:120-150`, `[2]`). */
  text: string;
  /** The file or document it resolved to; the cited path when it resolved to nothing. */
  path: string;
  /** The cited line range, when the answer gave one. */
  lines?: [number, number];
  status: ChatCitationStatus;
  /** Set when the citation resolved to something the turn read. */
  source?: ChatCitationSource;
  /**
   * #2325 — the indexed commit the cited code was read at, for a citation that
   * resolved to repository code. `null`: read, but the index records no commit.
   * Absent: not code, or recorded before #2325 — "version unknown", never
   * "current".
   */
  commitSha?: string | null;
  /**
   * #2325 — what was read is the repository's working tree, which has moved on
   * from the indexed commit: the index is behind the repository. Still a
   * citation, still shown and counted.
   */
  stale?: boolean;
}

/**
 * #2325 — the citation contract every chat code and knowledge tool result
 * carries, one per location it returns: which file and lines, at which
 * version of the code, and how it was found.
 *
 * - `commitSha` is the commit the project's index was built from (`null` when
 *   the connector records none, as for an uploaded archive);
 * - `permalink` is a link pinned to that commit, built from the connector's
 *   stored coordinates; `null` for a connector type with no link scheme, and
 *   never guessed;
 * - `matchedBy` is the retrievers that found it, as for knowledge hits
 *   (`RetrievedChunk.matchedBy`); absent when no retriever ranked it (a read,
 *   a graph lookup);
 * - `truncated` / `totalLines` / `next`: a result a line or byte cap cut says
 *   so, how long the file is when known, and the range to ask for next;
 * - `stale`: the content was read from a working tree whose commit is not the
 *   indexed one. A stale citation is flagged, never dropped;
 * - `repoConnectionId`: the repository the file is in. A file is its
 *   repository AND its path, never the path alone (#1965, `impactFileKey`):
 *   two repositories of one project can both hold `src/index.ts`. `null` when
 *   the producer does not know the repository (a legacy graph with no
 *   connection, the analysis surface's directory read).
 *
 * `startLine` / `endLine` are `null` for a knowledge excerpt, which is a chunk
 * of a file and has no line numbers. `totalLines` counts the unit the result
 * was cut from: the file, for a read; the symbol, for a search hit whose
 * snippet a cap cut (whose `next` is then the symbol's whole span).
 */
export interface CodeCitationRef {
  repoConnectionId: string | null;
  path: string;
  startLine: number | null;
  endLine: number | null;
  commitSha: string | null;
  permalink: string | null;
  matchedBy?: RetrievalMatcher[];
  truncated: boolean;
  totalLines: number | null;
  /** The next range to request, when `truncated` and there is more to read. */
  next?: { startLine: number; endLine: number };
  stale: boolean;
  /** When `stale`: the commit of the working tree that was read (`null`: not readable). */
  workingTreeSha?: string | null;
}

/** The most citation refs one tool result carries. */
export const MAX_CODE_CITATION_REFS = 50;
const MAX_PATH = 1024;
const SHA_RE = /^[0-9a-f]{7,64}$/i;
/** A connector id as METIS writes them (cuids, eval fixture slugs). */
const REPO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function repoId(v: unknown): string | null {
  return typeof v === "string" && REPO_ID_RE.test(v) ? v : null;
}

function sha(v: unknown): string | null {
  return typeof v === "string" && SHA_RE.test(v) ? v : null;
}

function lineOrNull(v: unknown): number | null {
  return line(v) ? v : null;
}

/** A link is kept only as an https URL with no whitespace, quote, angle bracket or backslash. */
const HTTPS_URL_RE = /^https:\/\/[^\s"'<>\\]+$/;

function httpsUrl(v: unknown): string | null {
  return typeof v === "string" && v.length <= 2048 && HTTPS_URL_RE.test(v) ? v : null;
}

/**
 * #2325 — accept a tool result's stored citation refs only in the contract's
 * shape (they are read back from a transcript row's free-form JSON): a
 * malformed entry is dropped, extra keys are dropped.
 */
export function parseCodeCitationRefs(value: unknown): CodeCitationRef[] {
  if (!Array.isArray(value)) return [];
  const out: CodeCitationRef[] = [];
  for (const raw of value.slice(0, MAX_CODE_CITATION_REFS)) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    if (typeof c.path !== "string" || c.path.length === 0 || c.path.length > MAX_PATH) continue;
    const startLine = lineOrNull(c.startLine);
    const endLine = lineOrNull(c.endLine);
    const lines = startLine !== null && endLine !== null && startLine <= endLine;
    const matchedBy = Array.isArray(c.matchedBy)
      ? RETRIEVAL_MATCHERS.filter((m) => (c.matchedBy as unknown[]).includes(m))
      : [];
    const next =
      c.next && typeof c.next === "object" ? (c.next as Record<string, unknown>) : undefined;
    const stale = c.stale === true;
    out.push({
      repoConnectionId: repoId(c.repoConnectionId),
      path: c.path,
      startLine: lines ? startLine : null,
      endLine: lines ? endLine : null,
      commitSha: sha(c.commitSha),
      permalink: httpsUrl(c.permalink),
      ...(matchedBy.length > 0 ? { matchedBy } : {}),
      truncated: c.truncated === true,
      totalLines: lineOrNull(c.totalLines),
      ...(next && line(next.startLine) && line(next.endLine) && next.startLine <= next.endLine
        ? { next: { startLine: next.startLine, endLine: next.endLine } }
        : {}),
      stale,
      ...(stale && "workingTreeSha" in c ? { workingTreeSha: sha(c.workingTreeSha) } : {}),
    });
  }
  return out;
}

/** The first 12 characters of a commit SHA, as model-facing text names it. */
export function shortCommitSha(commitSha: string, length = 12): string {
  return commitSha.slice(0, length);
}

/** The most citations a reply records; an answer citing more keeps the first ones. */
export const MAX_CHAT_CITATIONS = 50;
const MAX_TEXT = 300;

function line(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

/**
 * Accept a reply's citations only in the shape the UI renders. Read from a
 * row's free-form `meta` and from an SSE frame: a malformed entry is dropped,
 * extra keys are dropped, and anything that is not a list is `[]`.
 */
export function parseChatCitations(value: unknown): ChatCitation[] {
  if (!Array.isArray(value)) return [];
  const out: ChatCitation[] = [];
  for (const raw of value.slice(0, MAX_CHAT_CITATIONS)) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    if (typeof c.text !== "string" || c.text.length === 0 || c.text.length > MAX_TEXT) continue;
    if (typeof c.path !== "string" || c.path.length > MAX_TEXT) continue;
    const status = CHAT_CITATION_STATUSES.find((s) => s === c.status);
    if (!status) continue;
    const source = CHAT_CITATION_SOURCES.find((s) => s === c.source);
    const lines =
      Array.isArray(c.lines) &&
      c.lines.length === 2 &&
      line(c.lines[0]) &&
      line(c.lines[1]) &&
      c.lines[0] <= c.lines[1]
        ? ([c.lines[0], c.lines[1]] as [number, number])
        : undefined;
    out.push({
      text: c.text,
      path: c.path,
      ...(lines ? { lines } : {}),
      status,
      ...(source ? { source } : {}),
      // #2325 — absent stays absent (version unknown); a malformed SHA reads as null.
      ...("commitSha" in c ? { commitSha: sha(c.commitSha) } : {}),
      ...(c.stale === true ? { stale: true } : {}),
    });
  }
  return out;
}
