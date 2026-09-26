/**
 * Epic #127 — turn the server-owned transcript into the history a provider is
 * sent.
 *
 *   • Only ACTIVE rows (not folded by compaction) are sent. A summary row
 *     stands in for the rows it folded, pinned ahead of everything else so the
 *     model reads the story in order.
 *   • Past tool activity is NOT replayed: tool results are untrusted data, and
 *     the chat code-tool loop feeds them to the model only within the turn that
 *     ran them (capped there — see `chat-code-tool-runtime.ts`). Later turns
 *     see the assistant's answer; the full results stay in the transcript.
 *   • A summary is sent in the USER role, never `system`: it is derived from
 *     user-supplied text, and must not gain the authority of the system prompt.
 *   • An assistant row with no text (a reply that failed before its first
 *     token) contributes nothing — there is nothing in it.
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
  return [{ role: "assistant", content: text }];
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
