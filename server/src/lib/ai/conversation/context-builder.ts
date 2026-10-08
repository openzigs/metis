/**
 * Epic #127 — turn the server-owned transcript into the history a provider is
 * sent.
 *
 *   • Only ACTIVE rows (not folded by compaction) are sent. A summary row
 *     stands in for the rows it folded, pinned ahead of everything else so the
 *     model reads the story in order.
 *   • Past tool activity is NOT replayed: tool results are untrusted data, and
 *     the chat code-tool loop feeds them to the model only within the turn that
 *     ran them (capped there — see `tool-runtime/chat-turn.ts`). Later turns
 *     see the assistant's answer; the full results stay in the transcript.
 *     The answer is prefixed with a capped digest of the tool CALLS (name +
 *     arguments, never results), so the model knows it did read what it cited
 *     and does not retract verified citations (#773).
 *   • A summary is sent in the USER role, never `system`: it is derived from
 *     user-supplied text, and must not gain the authority of the system prompt.
 *   • An assistant row with no text (a reply that failed before its first
 *     token) contributes nothing — there is nothing in it.
 *   • Two user messages are never sent back to back (after a summary, or after
 *     a reply that failed empty): strict-alternation chat templates (Gemma's on
 *     vLLM / LM Studio) reject that, so {@link joinAdjacentUserMessages} joins
 *     them into one — every word is kept.
 *   • {@link capToolResult} is the one truncation rule for tool output handed
 *     to a model outside the live loop (the compaction summariser's input): a
 *     marker says how much was cut and which transcript message holds it all.
 */
import type { ChatMessage } from "../types.js";
import { partsText, type StoredMessage } from "./transcript-store.js";

/** Default cap on one tool result in the model's context, in tokens. */
export const DEFAULT_TOOL_RESULT_MAX_TOKENS = 2_000;

export interface ContextBuildOptions {
  /** Characters kept from one tool result before it is truncated. */
  toolResultMaxChars: number;
}

export function truncationMarker(shown: number, total: number, ordinal: number): string {
  return (
    `\n…[tool result truncated: showing the first ${shown} of ${total} characters. ` +
    `The full result is kept in this conversation's transcript, message #${ordinal}.]`
  );
}

/** Truncate `text` to `maxChars` with a marker, or return it unchanged. */
export function capToolResult(
  text: string,
  maxChars: number,
  ordinal: number,
): { text: string; truncated: boolean } {
  if (maxChars <= 0 || text.length <= maxChars) return { text, truncated: false };
  return {
    text: text.slice(0, maxChars) + truncationMarker(maxChars, text.length, ordinal),
    truncated: true,
  };
}

function summaryHeader(m: StoredMessage): string {
  const { fromOrdinal: from, toOrdinal: to, messageCount: count } = m.meta;
  const span =
    typeof from === "number" && typeof to === "number" && typeof count === "number"
      ? ` (messages #${from}–#${to}, ${count} messages)`
      : "";
  return (
    `[Summary of the earlier conversation${span}. The original messages are kept in ` +
    `the transcript; this summary replaces them in your context.]`
  );
}

/**
 * The provider messages ONE row contributes. Exported so the compactor
 * estimates a row exactly as it will be sent.
 */
export function rowMessages(r: StoredMessage): ChatMessage[] {
  const text = partsText(r.parts);
  if (r.kind === "summary") return [{ role: "user", content: `${summaryHeader(r)}\n${text}` }];
  if (r.role === "user") return [{ role: "user", content: text }];
  if (r.role !== "assistant" || !text) return [];
  const digest = toolCallDigest(r.parts);
  return [{ role: "assistant", content: digest ? `${digest}\n\n${text}` : text }];
}

/** Characters of one call's serialised arguments kept in the digest. */
export const MAX_DIGEST_ARG_CHARS = 200;
/** Calls listed in one turn's digest; the rest are counted. */
export const MAX_DIGEST_CALLS = 20;

/** `args` was parsed from the transcript's JSON column, so it re-serialises. */
function digestArgs(args: unknown): string {
  const json = JSON.stringify(args ?? {});
  return json.length > MAX_DIGEST_ARG_CHARS ? `${json.slice(0, MAX_DIGEST_ARG_CHARS)}…` : json;
}

/**
 * #773 — a compact record of the tools an earlier turn called, so a later turn
 * does not conclude it never read the files it cited. Only the tool NAME and
 * the model's own ARGUMENTS are listed (JSON-serialised, so no raw newlines,
 * and capped); the RESULTS stay out — they are untrusted data (see the module
 * comment). Returns "" when the turn called no tool.
 */
function toolCallDigest(parts: StoredMessage["parts"]): string {
  const calls = parts.filter(
    (p): p is Extract<StoredMessage["parts"][number], { type: "tool_call" }> =>
      p.type === "tool_call",
  );
  if (calls.length === 0) return "";
  const results = new Map<string, boolean>();
  for (const p of parts) if (p.type === "tool_result") results.set(p.toolCallId, !!p.isError);
  const lines = calls.slice(0, MAX_DIGEST_CALLS).map((c) => {
    const failed = results.get(c.id);
    const status = failed === undefined ? " (no result)" : failed ? " (failed)" : "";
    return `- ${c.name} ${digestArgs(c.args)}${status}`;
  });
  const more = calls.length - MAX_DIGEST_CALLS;
  if (more > 0) lines.push(`- …and ${more} more`);
  return (
    "[METIS note: in this turn you called the tools below. Their results were " +
    "verified when you made them and are not repeated here to save context; " +
    "citations you drew from them stand.]\n" +
    lines.join("\n")
  );
}

/** Build the provider history from a session's active transcript rows. */
export function buildHistory(rows: readonly StoredMessage[]): ChatMessage[] {
  const active = rows.filter((r) => r.compactedAt === null);
  // Summaries are pinned first; every other row follows in ordinal order.
  return [
    ...active.filter((r) => r.kind === "summary"),
    ...active.filter((r) => r.kind !== "summary"),
  ].flatMap(rowMessages);
}

/**
 * Join directly adjacent text-only `user` messages into one, separated by a
 * blank line. Nothing is dropped; multimodal messages are left as they are.
 */
export function joinAdjacentUserMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.role === "user" &&
      m.role === "user" &&
      typeof prev.content === "string" &&
      typeof m.content === "string"
    ) {
      out[out.length - 1] = { ...prev, content: `${prev.content}\n\n${m.content}` };
    } else {
      out.push(m);
    }
  }
  return out;
}
