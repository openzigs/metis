/**
 * Epic #127 — the server-owned chat transcript, as the UI reads it.
 *
 * The server is the only author of these records
 * (`server/src/lib/ai/conversation/`). The browser sends only the new user
 * message on each turn and renders the conversation from
 * `GET /api/ai/sessions/:id/messages`; it never holds history of its own.
 */
import type { SdkReasoningEffort } from "./sdk-alignment.js";

/** The title a chat session carries until its first question names it (#980). */
export const DEFAULT_SESSION_TITLE = "New Chat";
/** The title of a Workbench session created before its first question was known. */
export const WORKBENCH_SESSION_TITLE = "Workbench";
const AUTO_TITLE_MAX_CHARS = 80;
/**
 * #2240 — the most documents one chat question can attach (the Workbench's
 * context chips). The server refuses a longer list, so the UI caps the list at
 * this and never sends more.
 */
export const MAX_ATTACHED_DOCUMENTS = 50;

/**
 * #980 — a session title from its first question: whitespace collapsed, cut at
 * a word boundary to 80 characters with an ellipsis. `null` for a question
 * with no visible text. #1139 (PR #1234 review) — the ONE rule: the server
 * renames a {@link DEFAULT_SESSION_TITLE} session with it on the first stored
 * question, and the UI uses the same function so Recent lists the title the
 * server stored, never a label of its own.
 */
export function titleFromQuestion(text: string): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  if (flat.length <= AUTO_TITLE_MAX_CHARS) return flat;
  const cut = flat.slice(0, AUTO_TITLE_MAX_CHARS - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > AUTO_TITLE_MAX_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** One piece of a transcript message's content. */
export type TranscriptPart =
  | { type: "text"; text: string }
  /** A tool the model called during the turn. */
  | { type: "tool_call"; id: string; name: string; args: unknown }
  /** What that tool returned. Stored in full; only the model's copy is capped. */
  | {
      type: "tool_result";
      toolCallId: string;
      name: string;
      text: string;
      isError?: boolean;
      /** #142 — the approval gate's decision (`auto-approve`, `approve`, `deny`, `expired`, …). */
      decision?: string;
      /** #143 — fixed-vocabulary code when the call was refused or failed. */
      errorCode?: string;
      /** #142 — `false` when the call never ran; absent means it ran. */
      executed?: boolean;
      /** #147 — the sub-agent run this call started (its stored transcript). */
      subAgentRunId?: string;
    };

export type TranscriptRole = "user" | "assistant" | "system";

/**
 * #18 — what a chat reply was grounded in. Retrieval runs only for a session
 * bound to one project, so a reply is either:
 * - `grounded`: project content reached the model — automatic retrieval put
 *   excerpts in the prompt (`sources`), and/or the model read the project
 *   through its project-scoped tools — code search (#439) or the project's
 *   knowledge search, `search-knowledge` (#464) — (`toolReads`);
 * - `no-context`: the session is bound to a project, but neither automatic
 *   retrieval nor a project-scoped tool returned any of it (nothing ingested, retrieval
 *   failed, or no tool found anything). This does NOT mean the answer came from
 *   general knowledge: the model may still have called other tools, such as an
 *   MCP server, whose content is not known to be the project's (PR #437 review);
 * - `unscoped`: the session has no project ("All projects") and no retrieval ran;
 * - `multi` (#2238): the session is scoped to several projects (or a
 *   workspace) and retrieval searched each of them. `projects` lists every
 *   project searched with how many of its excerpts reached the prompt (`0`:
 *   searched, nothing included); `unsearched` the ones that timed out or
 *   failed, by name; `unavailable` how many in the scope the caller can no
 *   longer reach (a count: their names are not disclosed).
 *
 * Recorded on the assistant row as the turn is answered and streamed to the
 * client as a `grounding` event, so a reply says what it was based on both
 * live and after a reload.
 *
 * `sources` (#439) counts the excerpts automatic retrieval SUPPLIED — one per
 * knowledge-base chunk plus one per code symbol in the fused code block (#714).
 * Since #2241 only excerpts that cleared chat's relevance floor are supplied,
 * so the count is of excerpts relevant enough to use. `toolReads` counts the successful
 * project-scoped tool calls (code search, `search-knowledge`) that returned at
 * least one result; it is absent when there were none.
 *
 * #2241 — the label says what the reply rested on and what went wrong:
 * - `sourcesUsed` lists the files and documents those excerpts came from, each
 *   with how many excerpts it gave and its best relevance (dense cosine);
 * - a `no-context` reply says why (`reason`): nothing was found, the matches
 *   were too weak to use (`insufficient-evidence`, with `belowFloor` of them
 *   set aside), or the search failed;
 * - `coverage` is set when only part of the project's knowledge could be
 *   searched (chunks embedded with another model).
 *
 * #2326 — and whether the index itself can be trusted:
 * - `index` gives each repository's last indexed commit and time and how its
 *   last indexing run ended, with the project's worst `state`;
 * - a `retrieval-failed` reply names the class of failure (`failure`), one of
 *   {@link INDEX_ERROR_CLASSES}, never the error's text.
 *
 * `projectName` is the project's name when the reply was answered, and stays
 * so after a rename (#439, deliberate): the label records what the reply was
 * grounded in at the time, and it must still read after the project is
 * deleted, when there is no current name to look up.
 */
export type ChatGrounding =
  | {
      status: "grounded";
      projectId: string;
      projectName: string;
      sources: number;
      toolReads?: number;
      sourcesUsed?: GroundingSource[];
      coverage?: GroundingCoverage;
      index?: GroundingIndex;
    }
  | {
      status: "no-context";
      projectId: string;
      projectName: string;
      reason?: NoContextReason;
      belowFloor?: number;
      coverage?: GroundingCoverage;
      failure?: IndexErrorClass;
      index?: GroundingIndex;
    }
  | { status: "unscoped" }
  | {
      status: "multi";
      projects: ChatGroundingProject[];
      unsearched?: ChatGroundingUnsearched[];
      unavailable?: number;
    };

/** #2238 — one project a multi-product turn searched. */
export interface ChatGroundingProject {
  projectId: string;
  projectName: string;
  sources: number;
}

/** #2238 — one project a multi-product turn could not search, and why. */
export interface ChatGroundingUnsearched {
  projectId: string;
  projectName: string;
  reason: "timeout" | "error";
}

/** #2241 — one file or document a reply's excerpts came from. */
export interface GroundingSource {
  /** The repository path or document name the model was shown. */
  name: string;
  /** How many of the reply's excerpts came from it. */
  excerpts: number;
  /** The best dense cosine among them; absent for keyword-only or carried excerpts. */
  relevance?: number;
}

/** #2241 — only `matchingChunks` of the project's `totalChunks` could be searched. */
export interface GroundingCoverage {
  matchingChunks: number;
  totalChunks: number;
}

/**
 * #2326 — the fixed phrases an index or retrieval error is reduced to. Error
 * text itself (which can carry a path, a host or a token) never reaches the
 * model or the UI.
 */
export const INDEX_ERROR_CLASSES = [
  "timed out",
  "authentication failed",
  "repository not found",
  "network error",
  "embedding model unavailable",
  "vector index unavailable",
  "database error",
  "out of disk space or memory",
  "access check failed",
  "unexpected error",
] as const;
export type IndexErrorClass = (typeof INDEX_ERROR_CLASSES)[number];

/** #2326 — a project's index, worst state first. */
export const INDEX_STATES = [
  "failed",
  "never-indexed",
  "in-progress",
  "partial",
  "healthy",
] as const;
export type IndexState = (typeof INDEX_STATES)[number];

/** #2326 — how a repository's last indexing run ended (`unrecorded`: before #182). */
export const LAST_RUN_STATUSES = [
  "completed",
  "partial",
  "failed",
  "running",
  "interrupted",
  "never",
  "unrecorded",
] as const;
export type LastRunStatus = (typeof LAST_RUN_STATUSES)[number];

/** #2326 — one repository's index, as a reply's grounding label shows it. */
export interface GroundingIndexRepo {
  label: string;
  commitSha?: string;
  /** ISO time it was last indexed. */
  indexedAt?: string;
  lastRun: LastRunStatus;
  error?: IndexErrorClass;
}

/** #2326 — the project's index when the reply was answered. */
export interface GroundingIndex {
  state: IndexState;
  repos: GroundingIndexRepo[];
}

/** #2326 — the most repositories a label lists. */
export const MAX_GROUNDING_INDEX_REPOS = 10;

/** #2241 — why automatic retrieval supplied nothing. */
export const NO_CONTEXT_REASONS = [
  "nothing-found",
  "insufficient-evidence",
  "retrieval-failed",
] as const;
export type NoContextReason = (typeof NO_CONTEXT_REASONS)[number];

/** #2241 — the most sources a label lists; the rest are counted in `sources`. */
export const MAX_GROUNDING_SOURCES = 20;

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** A non-negative whole number. */
function count(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function parseSources(v: unknown): GroundingSource[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: GroundingSource[] = [];
  for (const raw of v.slice(0, MAX_GROUNDING_SOURCES)) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    if (!nonEmpty(s.name) || s.name.length > 500) continue;
    if (!count(s.excerpts) || s.excerpts === 0) continue;
    const relevance =
      typeof s.relevance === "number" && Number.isFinite(s.relevance) ? s.relevance : undefined;
    out.push({
      name: s.name,
      excerpts: s.excerpts,
      ...(relevance !== undefined ? { relevance } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

function parseCoverage(v: unknown): GroundingCoverage | undefined {
  if (!v || typeof v !== "object") return undefined;
  const c = v as Record<string, unknown>;
  return count(c.matchingChunks) && count(c.totalChunks) && c.matchingChunks < c.totalChunks
    ? { matchingChunks: c.matchingChunks, totalChunks: c.totalChunks }
    : undefined;
}

/** An ISO-8601 time that parses; anything else is dropped. */
function isoTime(v: unknown): v is string {
  return typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));
}

/** #2326 — the `index` part, or `undefined` when it is malformed. */
function parseIndex(v: unknown): GroundingIndex | undefined {
  if (!v || typeof v !== "object") return undefined;
  const i = v as Record<string, unknown>;
  const state = INDEX_STATES.find((s) => s === i.state);
  if (!state || !Array.isArray(i.repos)) return undefined;
  const repos: GroundingIndexRepo[] = [];
  for (const raw of i.repos.slice(0, MAX_GROUNDING_INDEX_REPOS)) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const lastRun = LAST_RUN_STATUSES.find((s) => s === r.lastRun);
    if (!nonEmpty(r.label) || r.label.length > 200 || !lastRun) continue;
    const error = INDEX_ERROR_CLASSES.find((c) => c === r.error);
    repos.push({
      label: r.label,
      ...(nonEmpty(r.commitSha) && /^[0-9a-f]{4,64}$/i.test(r.commitSha)
        ? { commitSha: r.commitSha }
        : {}),
      ...(isoTime(r.indexedAt) ? { indexedAt: r.indexedAt } : {}),
      lastRun,
      ...(error ? { error } : {}),
    });
  }
  return { state, repos };
}

/**
 * #18 — accept a {@link ChatGrounding} only in the shape the UI renders. The
 * server reads it back from a row's free-form `meta`, the client from an SSE
 * frame; anything malformed is `null` (not known), never passed through, and
 * extra keys are dropped.
 */
export function parseChatGrounding(value: unknown): ChatGrounding | null {
  if (!value || typeof value !== "object") return null;
  const g = value as Record<string, unknown>;
  switch (g.status) {
    case "unscoped":
      return { status: "unscoped" };
    case "no-context": {
      if (!nonEmpty(g.projectId) || !nonEmpty(g.projectName)) return null;
      // #2241 — an unknown reason, or a count that is not one, is dropped:
      // the label then says only what it said before.
      const reason = NO_CONTEXT_REASONS.find((r) => r === g.reason);
      const coverage = parseCoverage(g.coverage);
      // #2326 — only a phrase from the fixed vocabulary, and only for a failure.
      const failure =
        reason === "retrieval-failed"
          ? INDEX_ERROR_CLASSES.find((c) => c === g.failure)
          : undefined;
      const index = parseIndex(g.index);
      return {
        status: "no-context",
        projectId: g.projectId,
        projectName: g.projectName,
        ...(reason ? { reason } : {}),
        ...(reason === "insufficient-evidence" && count(g.belowFloor) && g.belowFloor > 0
          ? { belowFloor: g.belowFloor }
          : {}),
        ...(coverage ? { coverage } : {}),
        ...(failure ? { failure } : {}),
        ...(index ? { index } : {}),
      };
    }
    case "grounded": {
      // #439 — a present `toolReads` must be a positive count; `sources` may be
      // zero only when the tools read the project, so a label never claims
      // grounding that nothing supplied.
      const hasToolReads = g.toolReads !== undefined;
      if (hasToolReads && !(count(g.toolReads) && (g.toolReads as number) > 0)) return null;
      if (
        !nonEmpty(g.projectId) ||
        !nonEmpty(g.projectName) ||
        !count(g.sources) ||
        !(g.sources > 0 || hasToolReads)
      ) {
        return null;
      }
      const sourcesUsed = parseSources(g.sourcesUsed);
      const coverage = parseCoverage(g.coverage);
      const index = parseIndex(g.index);
      return {
        status: "grounded",
        projectId: g.projectId,
        projectName: g.projectName,
        sources: g.sources,
        ...(hasToolReads ? { toolReads: g.toolReads as number } : {}),
        ...(sourcesUsed ? { sourcesUsed } : {}),
        ...(coverage ? { coverage } : {}),
        ...(index ? { index } : {}),
      };
    }
    case "multi":
      return parseMultiGrounding(g);
    default:
      return null;
  }
}

/** #2238 — the `multi` shape, or `null` when any part of it is malformed. */
function parseMultiGrounding(g: Record<string, unknown>): ChatGrounding | null {
  if (!Array.isArray(g.projects)) return null;
  const projects: ChatGroundingProject[] = [];
  for (const raw of g.projects as unknown[]) {
    const p = (raw ?? {}) as Record<string, unknown>;
    if (!nonEmpty(p.projectId) || !nonEmpty(p.projectName) || !count(p.sources)) return null;
    projects.push({ projectId: p.projectId, projectName: p.projectName, sources: p.sources });
  }
  let unsearched: ChatGroundingUnsearched[] | undefined;
  if (g.unsearched !== undefined) {
    if (!Array.isArray(g.unsearched)) return null;
    unsearched = [];
    for (const raw of g.unsearched as unknown[]) {
      const u = (raw ?? {}) as Record<string, unknown>;
      if (!nonEmpty(u.projectId) || !nonEmpty(u.projectName)) return null;
      if (u.reason !== "timeout" && u.reason !== "error") return null;
      unsearched.push({ projectId: u.projectId, projectName: u.projectName, reason: u.reason });
    }
  }
  if (g.unavailable !== undefined && !(count(g.unavailable) && g.unavailable > 0)) return null;
  return {
    status: "multi",
    projects,
    ...(unsearched && unsearched.length > 0 ? { unsearched } : {}),
    ...(g.unavailable !== undefined ? { unavailable: g.unavailable as number } : {}),
  };
}

/** `summary` rows are written by compaction and stand in for the rows they fold. */
export type TranscriptKind = "message" | "summary";

/**
 * #137 — token accounting for one row. `input`/`output`/`cacheRead`/`cacheWrite`
 * are what the PROVIDER reported for the call that produced the row (assistant
 * replies and summaries); `null` means it reported nothing, never zero.
 * `estimated` is the server's own pre-send estimate of the row's content.
 */
export interface TranscriptTokens {
  estimated: number;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

export interface TranscriptMessageDto {
  id: string;
  ordinal: number;
  role: TranscriptRole;
  kind: TranscriptKind;
  parts: TranscriptPart[];
  tokens: TranscriptTokens;
  provider: string | null;
  model: string | null;
  finishReason: string | null;
  /**
   * #138 — set when compaction folded this row into a summary. The row is kept
   * and still shown; the model sees the summary instead.
   */
  compactedAt: string | null;
  compactedIntoId: string | null;
  /**
   * Summaries only: the ordinal range they stand in for. `truncated` is set when
   * the summariser hit its output cap — the summary is kept but may be missing
   * detail, and the reader is told so.
   */
  summaryOf: {
    fromOrdinal: number;
    toOrdinal: number;
    messageCount: number;
    truncated?: boolean;
  } | null;
  /** Set when a reply ended early (stream error, stop, idle timeout). */
  incomplete: { code: string; message: string } | null;
  /**
   * #18 — assistant replies only: what the reply was grounded in. `null` for
   * other rows and for replies recorded before #18 (not known), and for a
   * semantic-cache hit (generated against another request's retrieval).
   */
  grounding?: ChatGrounding | null;
  createdAt: string;
}

/**
 * #212 — a row at or before the reader's `afterOrdinal` that compaction has
 * since folded into a summary on this page. Compaction changes nothing else
 * about a row, so this is everything the reader needs to bring its copy up to
 * date without downloading the row again.
 */
export interface TranscriptCompactionUpdate {
  ordinal: number;
  compactedAt: string | null;
  compactedIntoId: string | null;
}

/** #212 — the server-side cap on one page of `GET /api/ai/sessions/:id/messages`. */
export const TRANSCRIPT_PAGE_MAX = 500;

/**
 * `GET /api/ai/sessions/:id/messages[?afterOrdinal=N][&limit=M]`
 *
 * #212 — paged: `messages` are the rows with `ordinal > afterOrdinal` (0 when
 * absent), oldest first, at most `limit` (capped at {@link TRANSCRIPT_PAGE_MAX}).
 * `hasMore` is `true` when rows past this page exist — a reader that stops
 * before `hasMore` is `false` is NOT holding the whole transcript; the next page
 * is `afterOrdinal = nextAfterOrdinal`.
 */
export interface TranscriptResponse {
  sessionId: string;
  messages: TranscriptMessageDto[];
  /** Rows at or before `afterOrdinal` folded by a summary on this page. */
  compactionUpdates: TranscriptCompactionUpdate[];
  hasMore: boolean;
  /** The last ordinal this page covers (`afterOrdinal` when it is empty). */
  nextAfterOrdinal: number;
}

/** SSE `compaction` frame on `/api/ai/stream`, and `compaction` on `/api/ai/chat`. */
export interface CompactionEventDto {
  /** Ordinal of the new summary row. */
  summaryOrdinal: number;
  /** How many transcript rows it folded (they are kept, marked compacted). */
  compactedMessages: number;
  fromOrdinal: number;
  toOrdinal: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  contextWindow: number;
  /** `catalog` when the model catalog knew the window; `fallback` otherwise. */
  contextWindowSource: "catalog" | "fallback";
}

/**
 * #139 — `POST /api/ai/sessions/:id/resume`. Everything is read from server
 * data: the transcript table and the session row. No client snapshot is used.
 */
export interface ResumeSessionResponse {
  session: {
    id: string;
    projectId: string | null;
    title: string;
    provider: string;
    model: string;
    currentModel: string | null;
    currentReasoningEffort: SdkReasoningEffort | null;
    agentId: string | null;
    /** #236 — the session's CUSTOM agent (`custom:<id>`), when it has one. */
    agentRef: string | null;
    loadedSkillIds: string[];
    planModeActive: boolean;
    status: string;
    forkedFromSessionId: string | null;
    forkedFromOrdinal: number | null;
    /** #2238 — the 2+ projects a multi-product session searches (`projectId` is null). */
    scopeProjectIds: string[] | null;
    /** #2238 — the workspace a workspace-scoped session searches (`projectId` is null). */
    scopeWorkspaceId: string | null;
    updatedAt: string;
    /**
     * #149 — non-null when the session can be read but can no longer take a
     * turn (it was created on a provider METIS no longer ships). The message is
     * shown to the user as-is.
     */
    readOnlyReason: string | null;
  };
  /**
   * #1445 — non-null when the session's CUSTOM agent can no longer run in its
   * project (switched off, never enabled, or deleted): the chat then runs
   * without the agent's persona, tools and skills. Shown to the user as-is.
   * Optional: older servers do not send it.
   */
  agentNotice?: string | null;
  /**
   * #245 — the FIRST page of the transcript, at most {@link TRANSCRIPT_PAGE_MAX}
   * rows. When `hasMore` is `true` the reader continues with
   * `GET /api/ai/sessions/:id/messages?afterOrdinal=nextAfterOrdinal` until it
   * is `false`; a reader that stops earlier is not holding the whole
   * conversation.
   */
  messages: TranscriptMessageDto[];
  hasMore: boolean;
  /** The last ordinal this page covers (0 when the transcript is empty). */
  nextAfterOrdinal: number;
}

/** `POST /api/ai/sessions/:id/fork` body. */
export interface ForkSessionRequest {
  /** Ordinal of the assistant reply the fork ends at (inclusive). */
  fromOrdinal: number;
}

/** `POST /api/ai/sessions/:id/fork` response. */
export interface ForkSessionResponse {
  session: ResumeSessionResponse["session"];
  /** Rows copied into the new session (ordinals 1..fromOrdinal of the source). */
  copiedMessages: number;
}

/**
 * Epic #128 / #143 — one step of one tool call in a chat turn, streamed as the
 * SSE `tool_event` frame and emitted to the session's socket room as
 * `ai:tool:event`. `awaiting_approval` carries the `approvalId` the session's
 * owner approves or denies (`POST /api/ai/sessions/:id/approvals/:approvalId`).
 * Error text is from a fixed vocabulary — never a raw exception message.
 */
export type AiToolEventPhase = "started" | "awaiting_approval" | "result" | "error";

export interface AiToolEvent {
  type: "tool_event";
  phase: AiToolEventPhase;
  sessionId: string;
  callId: string;
  name: string;
  risk: "low" | "medium" | "high" | null;
  source: "metis" | "mcp" | "code" | "agent" | null;
  argsPreview?: string;
  argsHiddenChars?: boolean;
  approvalId?: string;
  expiresAt?: string;
  resultPreview?: string;
  isError?: boolean;
  code?:
    | "TOOL_DENIED"
    | "TOOL_APPROVAL_EXPIRED"
    | "TOOL_NOT_ALLOWED"
    | "TOOL_UNKNOWN"
    | "TOOL_UNAVAILABLE"
    | "TOOL_INVALID_ARGS"
    | "TOOL_FAILED"
    | "TOOL_CALL_LIMIT";
  message?: string;
  /** #147 — set on `result` when the call ran a sub-agent: its stored run. */
  subAgentRunId?: string;
  /**
   * #147 — set when a SUB-AGENT made this call: the sub-agent's name and the
   * caller's tool-call id it is answering, so a client can nest the activity.
   */
  viaAgent?: { name: string; parentCallId: string; depth: number };
  ts: number;
}

/** #142 — `GET /api/ai/sessions/:id/approvals/pending`. */
export interface PendingToolApprovalDto {
  approvalId: string;
  sessionId: string;
  toolName: string;
  callId: string | null;
  expiresAt: string;
}
