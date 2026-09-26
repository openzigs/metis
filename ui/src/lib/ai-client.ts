/**
 * AI engine client — wraps the `/api/ai` HTTP surface for the UI.
 *
 * Uses the same `apiFetch` envelope as the rest of the app so 401-refresh
 * and error handling stay consistent. Streaming is done via the Fetch API
 * (`response.body.getReader()`) parsing SSE frames inline so we don't pull
 * a dedicated EventSource polyfill.
 */
import type {
  CompactionEventDto,
  ForkSessionResponse,
  ResumeSessionResponse,
  TranscriptMessageDto,
  TranscriptResponse,
} from "@metis/shared";
import { apiFetch, ApiError, streamFetch } from "./api-client";
import { stripToolTags } from "./strip-tool-tags";

export type RiskLevel = "low" | "medium" | "high";
export type ApprovalDecision = "auto" | "prompt-once" | "always-prompt" | "deny";
export interface ApprovalPolicy {
  low: ApprovalDecision;
  medium: ApprovalDecision;
  high: ApprovalDecision;
}

export interface AISession {
  id: string;
  title: string;
  provider: string;
  model: string;
  policy: ApprovalPolicy;
  status: string;
  projectId: string | null;
  agentId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type StreamEvent =
  | { type: "delta"; content: string }
  /** #138 — older turns were summarised before this answer (kept in the transcript). */
  | { type: "compaction"; compaction: CompactionEventDto }
  | { type: "tool_call"; name: string; arguments: unknown; risk: RiskLevel }
  | { type: "usage"; usage: TokenUsage }
  | { type: "done" }
  | { type: "error"; message: string; code?: string };

/**
 * Issue #607 — scope metadata echoed by POST /ai/sessions. When the applied
 * scope differs from what the client requested (multi-project selection, or
 * a stale project id), `degraded` is true and `reason` says why, so the UI
 * can tell the user instead of silently chatting unscoped.
 */
export type SessionScopeDegradationReason = "multi-project-unsupported" | "stale-project";

export interface SessionScope {
  requestedProjectIds: string[];
  appliedProjectId: string | null;
  degraded: boolean;
  reason?: SessionScopeDegradationReason;
}

export interface CreateSessionInput {
  title?: string;
  projectId?: string;
  projectIds?: string[];
  policy?: Partial<ApprovalPolicy>;
  agentId?: string;
  agentKey?: string;
}

export interface CreateSessionResult {
  session: AISession;
  /** Null when the server predates the #607 scope-metadata contract. */
  scope: SessionScope | null;
}

export async function createSessionWithScope(
  input: CreateSessionInput,
): Promise<CreateSessionResult> {
  const res = await apiFetch<{ session: AISession; scope?: SessionScope }>("/ai/sessions", {
    method: "POST",
    body: input,
  });
  return { session: res.session, scope: res.scope ?? null };
}

export async function createSession(input: CreateSessionInput): Promise<AISession> {
  return (await createSessionWithScope(input)).session;
}

export async function getSession(id: string): Promise<AISession> {
  const res = await apiFetch<{ session: AISession }>(`/ai/sessions/${encodeURIComponent(id)}`);
  return res.session;
}

/**
 * #1367 — the chat page used to create a brand-new session on every mount, so a
 * reload reset the transcript to the empty state and the conversation was
 * unrecoverable. This rehydrates one instead.
 *
 * #139 — the conversation now comes from the SERVER transcript
 * (`POST /ai/sessions/:id/resume`), never from a client snapshot.
 *
 * Returns `null` for any failure — an expired 24-hour window, a deleted session,
 * a session id left over from another environment — so the caller can fall back
 * to creating a fresh session rather than showing an error for a stale id the
 * user never typed.
 */
export interface ResumedChat {
  session: AISession;
  messages: DisplayTurn[];
}

/**
 * One transcript row as the chat page renders it. `ordinal` is the server's
 * position — what "fork from here" sends back. Summaries render as a note;
 * compacted rows stay visible, flagged.
 */
export interface DisplayTurn {
  role: "user" | "assistant" | "summary";
  content: string;
  ordinal: number;
  compacted: boolean;
  /** The reply ended early; the partial text is kept and labelled. */
  incomplete?: string;
  /** Summaries only: the range of messages they stand in for. */
  summaryOf?: {
    fromOrdinal: number;
    toOrdinal: number;
    messageCount: number;
    truncated?: boolean;
  };
  /** Tools the assistant used for this reply. */
  tools?: string[];
}

export function transcriptToDisplay(rows: readonly TranscriptMessageDto[]): DisplayTurn[] {
  const out: DisplayTurn[] = [];
  for (const r of rows) {
    const text = r.parts
      .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    if (r.kind === "summary") {
      out.push({
        role: "summary",
        content: text,
        ordinal: r.ordinal,
        compacted: r.compactedAt !== null,
        ...(r.summaryOf ? { summaryOf: r.summaryOf } : {}),
      });
      continue;
    }
    if (r.role !== "user" && r.role !== "assistant") continue;
    const tools = r.parts
      .filter((p) => p.type === "tool_call")
      .map((p) => (p as { name: string }).name);
    out.push({
      role: r.role,
      content: text,
      ordinal: r.ordinal,
      compacted: r.compactedAt !== null,
      ...(r.incomplete ? { incomplete: r.incomplete.message || r.incomplete.code } : {}),
      ...(tools.length > 0 ? { tools } : {}),
    });
  }
  return out;
}

export async function getTranscript(sessionId: string): Promise<DisplayTurn[]> {
  const res = await apiFetch<TranscriptResponse>(
    `/ai/sessions/${encodeURIComponent(sessionId)}/messages`,
  );
  return transcriptToDisplay(res.messages);
}

export async function resumeChatSession(id: string): Promise<ResumedChat | null> {
  try {
    // Encoded: `id` reaches here from a `?sessionId=` query param, and an
    // unencoded value could otherwise steer the request at a different route.
    const encoded = encodeURIComponent(id);
    const res = await apiFetch<ResumeSessionResponse>(`/ai/sessions/${encoded}/resume`, {
      method: "POST",
    });
    const session = await getSession(id);
    return { session, messages: transcriptToDisplay(res.messages ?? []) };
  } catch {
    return null;
  }
}

/** #139 — start a new session from an earlier assistant reply. */
export async function forkChatSession(
  id: string,
  fromOrdinal: number,
): Promise<ForkSessionResponse> {
  return apiFetch<ForkSessionResponse>(`/ai/sessions/${encodeURIComponent(id)}/fork`, {
    method: "POST",
    body: { fromOrdinal },
  });
}

const ACTIVE_SESSION_KEY = "metis.chat.activeSessionId";

/** Remember which session the chat page is showing, so a reload can resume it. */
export function storeActiveSessionId(id: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (id) window.localStorage.setItem(ACTIVE_SESSION_KEY, id);
    else window.localStorage.removeItem(ACTIVE_SESSION_KEY);
  } catch {
    /* Safari private mode */
  }
}

export function loadActiveSessionId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(ACTIVE_SESSION_KEY);
  } catch {
    return null;
  }
}

export async function updateSession(
  id: string,
  patch: { title?: string; policy?: Partial<ApprovalPolicy> },
): Promise<AISession> {
  const res = await apiFetch<{ session: AISession }>(`/ai/sessions/${id}`, {
    method: "PATCH",
    body: patch,
  });
  return res.session;
}

/** #136 — send only the new user message; the server holds the history. */
export async function chat(
  sessionId: string,
  message: string,
): Promise<{ content: string; usage: TokenUsage }> {
  const res = await apiFetch<{ response: { content: string; usage: TokenUsage } }>("/ai/chat", {
    method: "POST",
    body: { sessionId, message },
  });
  return res.response;
}

/**
 * #1366 — client-side idle budget. The observed hang produced no toast, no
 * console error and no failed request: `reader.read()` simply never resolved
 * again, and `Send` stayed disabled forever.
 *
 * Deliberately larger than the server's own idle cap so the server's diagnosed,
 * logged error normally wins; this is the backstop for the case where the
 * connection itself wedges and no frame — not even an error — ever arrives.
 * Overridable via `NEXT_PUBLIC_AI_STREAM_IDLE_TIMEOUT_MS` so a deployment that
 * raises or disables the server cap (`AI_STREAM_IDLE_TIMEOUT_MS`) is not then
 * cut off by an unconfigurable client constant; `0` disables it.
 *
 * Crucially the clock is reset by PARSED EVENTS, not by raw bytes: the server
 * writes a `: ping\n\n` keep-alive comment every 15s, so a byte-level timer
 * would be reset forever by a server that is alive but producing no tokens.
 */
export const STREAM_IDLE_TIMEOUT_MS = ((): number => {
  const raw = process.env.NEXT_PUBLIC_AI_STREAM_IDLE_TIMEOUT_MS;
  const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 120_000;
})();
export const STREAM_IDLE_TIMEOUT_CODE = "STREAM_IDLE_TIMEOUT";

/** Distinguishable from any `ReadableStreamReadResult`. */
const IDLE = Symbol("idle");

/**
 * Stream a chat completion. Yields each parsed SSE event in order. The caller
 * may abort by passing an `AbortSignal` — the server will cancel the upstream
 * provider call within one chunk.
 *
 * Routed through {@link streamFetch} so an expired access token transparently
 * triggers a `/auth/refresh` (single-flight, shared with `apiFetch`) and the
 * stream request is retried once. If the refresh fails the configured
 * `onRefreshFailure` handler runs (boots the user back to /login) and the
 * caller sees a 401 `ApiError`.
 *
 * #1366 — if no event arrives for {@link STREAM_IDLE_TIMEOUT_MS} the generator
 * yields a terminal `error` event and returns, so the caller's `finally` runs
 * and the composer is re-enabled. Everything streamed before the stall has
 * already been yielded, so partial content is preserved.
 */
export async function* streamChat(
  sessionId: string,
  message: string,
  signal?: AbortSignal,
  idleTimeoutMs: number = STREAM_IDLE_TIMEOUT_MS,
): AsyncGenerator<StreamEvent> {
  // #136 — only the new user message goes up; the server owns the history.
  const res = await streamFetch("/ai/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ sessionId, message }),
    signal,
  });
  if (!res.ok || !res.body) {
    let message = `HTTP ${res.status}`;
    let code: string | undefined;
    try {
      const j = (await res.json()) as { error?: { message?: string; code?: string } };
      if (j.error?.message) message = j.error.message;
      code = j.error?.code;
    } catch {
      /* non-JSON error body — fall back to the status line */
    }
    throw new ApiError(res.status, message, code);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const guard = idleTimeoutMs > 0;
  let buffer = "";
  // The budget is a DEADLINE advanced only by a parsed event, never by a raw
  // read. Re-arming a fresh timer per `read()` would let the 15s `: ping`
  // keep-alive hold the stream open forever — which is the exact state this
  // exists to escape.
  let deadline = Date.now() + idleTimeoutMs;
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = guard
      ? await Promise.race([
          reader.read(),
          new Promise<typeof IDLE>((resolve) => {
            timer = setTimeout(() => resolve(IDLE), Math.max(deadline - Date.now(), 0));
          }),
        ])
      : await reader.read();
    if (timer !== undefined) clearTimeout(timer);
    if (read === IDLE) {
      await reader.cancel().catch(() => {});
      yield {
        type: "error",
        message: `The response stalled — nothing was received for ${Math.round(idleTimeoutMs / 1000)}s. Any partial answer above is incomplete.`,
        code: STREAM_IDLE_TIMEOUT_CODE,
      };
      return;
    }
    const { value, done } = read;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);
      const ev = parseSseFrame(frame);
      // A heartbeat comment parses to null and deliberately does NOT push the
      // deadline — the whole point is to notice a live socket with no tokens.
      if (ev) {
        deadline = Date.now() + idleTimeoutMs;
        yield ev;
      }
    }
  }
}

export function parseSseFrame(frame: string): StreamEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  let payload: unknown = null;
  try {
    payload = JSON.parse(dataLines.join("\n"));
  } catch {
    return null;
  }
  switch (event) {
    case "delta": {
      // #718 — defense-in-depth: strip any residual tool-tag markup that slipped
      // past the provider-layer parser so raw XML never renders as literal text.
      const p = payload as { content?: string };
      return { type: "delta", content: stripToolTags(p.content ?? "") };
    }
    case "tool_call": {
      const p = payload as { name?: string; arguments?: unknown; risk?: RiskLevel };
      return {
        type: "tool_call",
        name: p.name ?? "(unknown)",
        arguments: p.arguments,
        risk: p.risk ?? "low",
      };
    }
    case "usage":
      return { type: "usage", usage: payload as TokenUsage };
    case "compaction":
      return { type: "compaction", compaction: payload as CompactionEventDto };
    case "done":
      return { type: "done" };
    case "error": {
      const p = payload as { message?: string; code?: string };
      return { type: "error", message: p.message ?? "stream error", code: p.code };
    }
    default:
      return null;
  }
}
