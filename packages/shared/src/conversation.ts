/**
 * Epic #127 — the server-owned chat transcript, as the UI reads it.
 *
 * The server is the only author of these records
 * (`server/src/lib/ai/conversation/`). The browser sends only the new user
 * message on each turn and renders the conversation from
 * `GET /api/ai/sessions/:id/messages`; it never holds history of its own.
 */
import type { SdkReasoningEffort } from "./sdk-alignment.js";

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
  createdAt: string;
}

/** `GET /api/ai/sessions/:id/messages` */
export interface TranscriptResponse {
  sessionId: string;
  messages: TranscriptMessageDto[];
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
    loadedSkillIds: string[];
    planModeActive: boolean;
    status: string;
    forkedFromSessionId: string | null;
    forkedFromOrdinal: number | null;
    updatedAt: string;
    /**
     * #149 — non-null when the session can be read but can no longer take a
     * turn (it was created on a provider METIS no longer ships). The message is
     * shown to the user as-is.
     */
    readOnlyReason: string | null;
  };
  messages: TranscriptMessageDto[];
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
