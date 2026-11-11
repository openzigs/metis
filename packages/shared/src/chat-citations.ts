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
    });
  }
  return out;
}
