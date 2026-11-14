/**
 * #2290 — an AI discussion reply's checked citations, on its row and off it.
 *
 * A reply's citations are checked when it is written (`ai-responder.ts`, with
 * #2242's verifier) and stored in the row's `meta` column as JSON text
 * (`{"citations":[...]}`, the shape a chat reply's `meta` carries). Every
 * reader goes through {@link citationsFromMeta}: the column is free-form text,
 * so only the shape the UI renders (`parseChatCitations`) leaves the server.
 */
import { parseChatCitations, type ChatCitation } from "@metis/shared";
import { citationsMeta } from "../ai/citation-verification.js";

/** The `meta` column for a reply's citations; `null` when it cited nothing. */
export function discussionMessageMeta(citations: readonly ChatCitation[]): string | null {
  const meta = citationsMeta(citations);
  return Object.keys(meta).length > 0 ? JSON.stringify(meta) : null;
}

/** The citations recorded in a row's `meta`; `[]` when none or unreadable. */
export function citationsFromMeta(meta: string | null | undefined): ChatCitation[] {
  if (!meta) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(meta);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  return parseChatCitations((parsed as { citations?: unknown }).citations);
}

/** `{ citations }` for a reply that has some, else nothing: absent stays absent on the wire. */
export function citationsField(citations: readonly ChatCitation[]): { citations?: ChatCitation[] } {
  return citations.length > 0 ? { citations: [...citations] } : {};
}
