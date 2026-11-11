/**
 * #2240 — conversation-aware retrieval for chat.
 *
 * Before this, chat searched the project with the LAST message only: a business
 * analyst answering the model's own question ("product B") got a search for
 * "product B", and the excerpts the previous answer was built on were gone on
 * the next turn. This module holds the three deterministic pieces the chat
 * routes use instead; none of them calls a model, so retrieval costs no extra
 * tokens and stays testable byte for byte.
 *
 *   1. {@link planRetrievalQueries} — the searches to run for a turn. The user's
 *      own latest words are ALWAYS the first search, unchanged ("the user's
 *      words in charge"). A multi-part question adds one search per part; a
 *      follow-up adds one search of the latest message read with the turn
 *      before it. The caller fuses the ranked lists (reciprocal rank fusion).
 *   2. {@link citedExcerptIds} — which numbered excerpts an answer cited, kept
 *      on the reply row so the next turn can bring them back.
 *   3. {@link retrievalConversation} — the prior turns and those cited excerpt
 *      ids, read from the server-owned transcript.
 */
import type { ChatMessage } from "../types.js";
import { messageText } from "../types.js";
import { partsText, type StoredMessage } from "./transcript-store.js";

/** The retrieval query cap the chat route has always applied (`ai.ts`). */
export const MAX_QUERY_CHARS = 2048;
/** Parts of a multi-part question searched on their own; the rest ride in the whole. */
export const MAX_QUESTION_PARTS = 3;
/** A part shorter than this carries too little to search on its own. */
const MIN_PART_CHARS = 8;
/** How much of the previous question a follow-up's search carries. */
const PREVIOUS_QUESTION_CHARS = 600;
/** How much of the model's own question a follow-up's search carries. */
const ASSISTANT_QUESTION_CHARS = 300;
/** A message this short (in words) reads as a reply to the turn before it. */
const FOLLOW_UP_MAX_WORDS = 6;
/** Excerpts a previous answer can carry into the next turn. */
export const MAX_CARRIED_EXCERPTS = 4;
/** Reply-row `meta` key holding the chunk ids the answer cited. */
export const CITED_EXCERPTS_META_KEY = "citedExcerpts";

/**
 * Words that point back at something said earlier. Their presence makes a
 * message a follow-up even when it is long ("does that also apply to B?").
 */
const REFERRING =
  /\b(it|its|that|this|these|those|they|them|their|there|same|above|previous|earlier|also|instead|former|latter)\b/i;
/** Openings that continue the conversation rather than start a new topic. */
const CONTINUING =
  /^\s*(and|but|so|or|then|also|what about|how about|why not|why|ok|okay|yes|no)\b/i;

export interface RetrievalQueryPlan {
  /** The user's own latest words, cut to {@link MAX_QUERY_CHARS}. Always searched first. */
  primary: string;
  /** The parts of a multi-part question, each searched on its own; empty for one question. */
  parts: string[];
  /** The latest message read with the turn before it, for a follow-up; `null` otherwise. */
  contextual: string | null;
}

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Sentences and lines; a `.` inside a token ("v2.3") does not end a sentence. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[?!.])\s+|\r?\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? t.slice(0, max) : t;
}

/**
 * The sub-questions of a multi-part message: two or more list items (`1.`,
 * `2)`, `-`, `*`, `•`), else two or more sentences ending in `?`. A message
 * with fewer than two usable parts is one question (`[]`).
 */
export function splitQuestionParts(text: string): string[] {
  const listItems = text
    .split(/\r?\n/)
    .map((line) => /^\s*(?:\d+[.)]|[-*•])\s+(.+)$/.exec(line)?.[1]?.trim() ?? "")
    .filter((p) => p.length >= MIN_PART_CHARS);
  if (listItems.length >= 2) return listItems.slice(0, MAX_QUESTION_PARTS);
  const questions = sentences(text).filter((q) => q.endsWith("?") && q.length >= MIN_PART_CHARS);
  if (questions.length >= 2) return questions.slice(0, MAX_QUESTION_PARTS);
  return [];
}

/** The last question the assistant asked in `text`, if its closing lines ask one. */
export function assistantQuestion(text: string): string | null {
  // Only a question the answer ENDS on is put to the user; one asked mid-answer
  // and then answered ("Why? Because …") is not waiting for a reply.
  const all = sentences(text);
  const last = all[all.length - 1];
  return last?.endsWith("?") ? clip(last, ASSISTANT_QUESTION_CHARS) : null;
}

/**
 * Whether `latest` continues the conversation: the model's previous answer
 * ended on a question, or the message is short, opens like a continuation, or
 * refers back ("it", "that", "the same").
 */
export function isFollowUp(latest: string, previousAnswer: string | null): boolean {
  if (previousAnswer && assistantQuestion(previousAnswer)) return true;
  if (words(latest) <= FOLLOW_UP_MAX_WORDS) return true;
  return CONTINUING.test(latest) || REFERRING.test(latest);
}

/**
 * The searches to run for the conversation `messages` (oldest first, the new
 * user message last). `null` when there is no user message with text.
 */
export function planRetrievalQueries(messages: readonly ChatMessage[]): RetrievalQueryPlan | null {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return null;
  const latest = messageText(messages[lastUserIdx]!);
  const primary = latest.slice(0, MAX_QUERY_CHARS);
  if (!primary.trim()) return null;

  const parts = splitQuestionParts(primary);

  const earlier = messages.slice(0, lastUserIdx);
  const previousUser = [...earlier].reverse().find((m) => m.role === "user");
  const previousAnswerMsg = [...earlier].reverse().find((m) => m.role === "assistant");
  const previousAnswer = previousAnswerMsg ? messageText(previousAnswerMsg) : null;
  let contextual: string | null = null;
  if (previousUser && isFollowUp(latest, previousAnswer)) {
    // The user's words lead; the turn before supplies what they refer to.
    const pieces = [clip(latest, MAX_QUERY_CHARS)];
    const asked = previousAnswer ? assistantQuestion(previousAnswer) : null;
    if (asked) pieces.push(asked);
    pieces.push(clip(messageText(previousUser), PREVIOUS_QUESTION_CHARS));
    contextual = pieces.join("\n").slice(0, MAX_QUERY_CHARS);
  }
  return { primary, parts, contextual };
}

/** Every distinct search in `plan`, the user's own words first. */
export function planQueries(plan: RetrievalQueryPlan): string[] {
  const all = [plan.primary, ...plan.parts, ...(plan.contextual ? [plan.contextual] : [])];
  return [...new Set(all.map((q) => q.trim()).filter(Boolean))];
}

/** One numbered excerpt as the model saw it in the retrieved-knowledge block. */
export interface CitableExcerpt {
  /** Its `[n]` number in the block. */
  n: number;
  chunkId: string;
  /** The name the model was shown: the repository path, else the filename. */
  name: string;
  /** `name#position`, as the block printed it. */
  locator: string;
}

/**
 * The chunk ids of the excerpts `answer` cites, in excerpt order, at most
 * {@link MAX_CARRIED_EXCERPTS}. An excerpt is cited when the answer names its
 * number (`[2]`, `[1, 3]`), its locator, or its file (every excerpt of that
 * file then counts, as the answer does not say which part it drew on).
 */
export function citedExcerptIds(answer: string, excerpts: readonly CitableExcerpt[]): string[] {
  if (!answer || excerpts.length === 0) return [];
  const numbers = new Set<number>();
  for (const m of answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    for (const n of m[1]!.split(",")) numbers.add(Number.parseInt(n.trim(), 10));
  }
  const cited: string[] = [];
  for (const e of excerpts) {
    const named =
      numbers.has(e.n) ||
      answer.includes(e.locator) ||
      (e.name.length >= 4 && answer.includes(e.name));
    if (named && !cited.includes(e.chunkId)) cited.push(e.chunkId);
  }
  return cited.slice(0, MAX_CARRIED_EXCERPTS);
}

/** The cited chunk ids a reply row's `meta` carries; anything malformed is ignored. */
function carriedIds(meta: Record<string, unknown>): string[] {
  const raw = meta[CITED_EXCERPTS_META_KEY];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200)
    .slice(0, MAX_CARRIED_EXCERPTS);
}

export interface RetrievalConversation {
  /** The earlier user and assistant messages, oldest first, as plain text. */
  messages: ChatMessage[];
  /** The chunk ids the previous answer cited, to bring back on this turn. */
  carryForward: string[];
}

/**
 * The prior turns of a session's active transcript as retrieval reads them:
 * user and assistant messages with text (summaries, and replies that produced
 * no text, are skipped), plus what the most recent answer cited.
 */
export function retrievalConversation(rows: readonly StoredMessage[]): RetrievalConversation {
  const turns = rows.filter(
    (r) =>
      r.compactedAt === null &&
      r.kind === "message" &&
      (r.role === "user" || r.role === "assistant"),
  );
  const messages: ChatMessage[] = [];
  for (const r of turns) {
    const text = partsText(r.parts);
    if (text.trim()) messages.push({ role: r.role as "user" | "assistant", content: text });
  }
  const lastAnswer = [...turns].reverse().find((r) => r.role === "assistant");
  return { messages, carryForward: lastAnswer ? carriedIds(lastAnswer.meta) : [] };
}

/**
 * The reply-row `meta` entry recording what `answer` cited of `excerpts`;
 * empty when it cited none, so a reply without citations carries nothing.
 */
export function citedExcerptsMeta(
  answer: string,
  excerpts: readonly CitableExcerpt[] | undefined,
): Record<string, string[]> {
  const ids = citedExcerptIds(answer, excerpts ?? []);
  return ids.length > 0 ? { [CITED_EXCERPTS_META_KEY]: ids } : {};
}
