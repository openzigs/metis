/**
 * Epic #475 (Phase 4) — discussions client API.
 *
 * Thin typed wrapper over the `/api/discussions` REST surface (Phases 1–3),
 * reusing the shared `apiFetch` envelope (401-refresh, error normalization) and
 * `streamFetch` for the SSE AI-reply path. The `thread:{id}` realtime fan-out is
 * consumed via the socket client (`@/lib/socket-client`), not here.
 */
import { apiFetch, ApiError, streamFetch } from "./api-client";

/** The 3-state AI participation mode (mirrors the server `ai-gate.ts` enum). */
export const AI_RESPONSE_MODES = ["off", "on_mention", "auto"] as const;
export type AiResponseMode = (typeof AI_RESPONSE_MODES)[number];

/** A discussion thread as returned by the REST surface. */
export interface DiscussionThread {
  id: string;
  projectId: string;
  title: string | null;
  aiResponseMode: AiResponseMode;
  requirementId: string | null;
  analysisId: string | null;
  specKitFeatureId: string | null;
  createdById: string;
  createdAt: string;
  updatedAt?: string;
}

/** A discussion message with full human/AI attribution. */
export interface DiscussionMessage {
  id: string;
  threadId: string;
  /** `human` | `ai` — author discriminator. */
  authorKind: string;
  /** Set iff `authorKind === "human"`. */
  authorUserId: string | null;
  /** Set iff `authorKind === "ai"`. */
  aiProvider: string | null;
  aiModel: string | null;
  aiSessionId: string | null;
  body: string;
  createdAt: string;
  editedAt: string | null;
}

export interface PromoteResult {
  requirementId: string;
  analysisId: string;
}

/** SSE events yielded by {@link streamAiReply}. */
export type AiRespondEvent =
  | { type: "delta"; content: string }
  | { type: "usage"; usage: unknown }
  | { type: "done" }
  | { type: "error"; message: string; code?: string };

// ---- Threads ---------------------------------------------------------------

/** List a project's discussion threads (newest first). */
export async function listThreads(projectId: string): Promise<DiscussionThread[]> {
  return (
    (await apiFetch<DiscussionThread[]>(
      `/discussions/threads?projectId=${encodeURIComponent(projectId)}`,
    )) ?? []
  );
}

export async function createThread(input: {
  projectId: string;
  title?: string;
  anchor?: { requirementId?: string; analysisId?: string; specKitFeatureId?: string };
}): Promise<DiscussionThread> {
  return apiFetch<DiscussionThread>("/discussions/threads", {
    method: "POST",
    body: input,
  });
}

/** A thread anchor — at most one of these is set per update. */
export interface ThreadAnchor {
  requirementId?: string;
  analysisId?: string;
  specKitFeatureId?: string;
}

/**
 * Update thread settings: the `aiResponseMode` (#483) and/or an optional anchor
 * (#488). At least one field must be supplied; the server validates an anchor
 * belongs to the thread's project.
 */
export async function updateThreadSettings(
  threadId: string,
  patch: { aiResponseMode?: AiResponseMode; anchor?: ThreadAnchor },
): Promise<DiscussionThread> {
  return apiFetch<DiscussionThread>(`/discussions/threads/${encodeURIComponent(threadId)}`, {
    method: "PATCH",
    body: patch,
  });
}

// ---- Messages --------------------------------------------------------------

/** Fetch a page of message history (oldest → newest). */
export async function listMessages(
  threadId: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<DiscussionMessage[]> {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.cursor) params.set("cursor", opts.cursor);
  const qs = params.toString();
  const path = `/discussions/threads/${encodeURIComponent(threadId)}/messages${qs ? `?${qs}` : ""}`;
  return (await apiFetch<DiscussionMessage[]>(path)) ?? [];
}

/** Post a human message. The server fans it out over `thread:{id}` too. */
export async function postMessage(threadId: string, body: string): Promise<DiscussionMessage> {
  return apiFetch<DiscussionMessage>(
    `/discussions/threads/${encodeURIComponent(threadId)}/messages`,
    { method: "POST", body: { body } },
  );
}

/** Promote a message into a tracked Requirement, preserving provenance. */
export async function promoteMessage(
  threadId: string,
  messageId: string,
  input: { title: string; type?: string; priority?: string },
): Promise<PromoteResult> {
  return apiFetch<PromoteResult>(
    `/discussions/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(
      messageId,
    )}/promote`,
    { method: "POST", body: input },
  );
}

// ---- AI reply (SSE) --------------------------------------------------------

/**
 * Trigger an AI reply for a human message and stream the result. Yields each
 * parsed SSE event in order. When the thread's `aiResponseMode` gate declines
 * (e.g. `off`, or a plain statement in `on_mention`), the server returns a JSON
 * `{ responded: false }` body (not an event stream) — surfaced here as a single
 * terminal `done` event so callers can treat "no reply" uniformly.
 */
export async function* streamAiReply(
  threadId: string,
  messageId: string,
  signal?: AbortSignal,
): AsyncGenerator<AiRespondEvent> {
  const res = await streamFetch(`/discussions/threads/${encodeURIComponent(threadId)}/ai-respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ messageId }),
    signal,
  });

  if (!res.ok) {
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

  // The gate-declined path returns JSON, not an SSE stream. Detect it and end.
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    yield { type: "done" };
    return;
  }
  if (!res.body) {
    yield { type: "done" };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);
      const ev = parseDiscussionSseFrame(frame);
      if (ev) yield ev;
    }
  }
}

/** Parse one SSE frame from the ai-respond stream into an {@link AiRespondEvent}. */
export function parseDiscussionSseFrame(frame: string): AiRespondEvent | null {
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
      const p = payload as { content?: string };
      return { type: "delta", content: p.content ?? "" };
    }
    case "usage":
      return { type: "usage", usage: (payload as { usage?: unknown }).usage ?? payload };
    case "done":
      return { type: "done" };
    case "error": {
      const p = payload as { message?: string; code?: string };
      return { type: "error", message: p.message ?? "AI reply failed", code: p.code };
    }
    default:
      return null;
  }
}

/** True when the message body explicitly mentions the AI participant (`@AI`). */
export function mentionsAi(body: string): boolean {
  // Word-boundary, case-insensitive `@ai`, mirroring the server gate's
  // `detectAIMention`. Kept intentionally simple — the server is the source of
  // truth; this is a client-side optimisation to only call ai-respond when a
  // mention is present in `on_mention` mode.
  return /(^|[^\w@])@ai\b/i.test(body);
}
