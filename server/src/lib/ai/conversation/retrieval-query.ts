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
 *      before it. {@link fuseRetrievalHits} merges the ranked lists, the
 *      user's own searches weighted above the conversational one, which never
 *      fills a majority of the slots.
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
 * A referring message with at most this many content words of its own leans on
 * the turn before it; one with more names its own subject.
 */
const FOLLOW_UP_MAX_CONTENT_WORDS = 3;
/** Weight of the conversational search in the fusion; the user's own searches weigh 1. */
export const CONTEXTUAL_WEIGHT = 0.95;
/** The reciprocal-rank-fusion damping constant, as `rag/bm25-index.ts` uses it. */
const RRF_K = 60;

/**
 * Words that point back at something said earlier ("does that also apply
 * here?"). On their own they prove nothing — "Are there any GDPR requirements
 * in the onboarding spec?" refers to nothing — so a message with them is a
 * follow-up only when it has few content words of its own.
 */
const REFERRING =
  /\b(it|its|that|this|these|those|they|them|their|there|same|above|previous|earlier|also|instead|former|latter)\b/i;
/** Openings that continue the conversation rather than start a new topic. */
const CONTINUING = /^\s*(and|but|so|or|then|also|what about|how about|why not|ok|okay|yes|no)\b/i;
/**
 * Words that carry no subject of their own: function words, the referring
 * words above, and the generic verbs of a question ("does that apply", "tell
 * me more"). Whatever is left is the message's own subject.
 */
const NON_CONTENT = new Set(
  (
    "a an the and or but so then if of to in on at by for with from into onto about as " +
    "is are was were be been being am do does did done doing have has had having " +
    "can could would should will shall may might must " +
    "i me my we us our you your he him his she her it its they them their there " +
    "this that these those what which who whom whose when where why how " +
    "not no yes ok okay any some all each every more most other else same such " +
    "just only also too very really please thanks thank " +
    "above previous earlier instead former latter here " +
    "apply applies applied work works mean means meant say says said tell told " +
    "explain describe show give get go happen happens mention mentioned detail details " +
    "one ones thing things way case"
  ).split(" "),
);

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

/** The words of `text` that name a subject: not function, referring or generic words. */
export function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu) ?? []).filter(
    (w) => w.length >= 2 && !NON_CONTENT.has(w),
  );
}

/**
 * Whether `latest` continues the conversation rather than asking something
 * self-contained: it is short (an answer to the model's question, "product
 * B"), opens like a continuation ("and for annual plans?"), or refers back
 * ("does that also apply here?") without naming a subject of its own. A
 * question that names its own subject is NOT a follow-up, whatever came
 * before — a previous answer ending on a question included — so the earlier
 * topic is not searched for it.
 */
export function isFollowUp(latest: string): boolean {
  if (words(latest) <= FOLLOW_UP_MAX_WORDS) return true;
  if (CONTINUING.test(latest)) return true;
  return REFERRING.test(latest) && contentWords(latest).length <= FOLLOW_UP_MAX_CONTENT_WORDS;
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
  if (previousUser && isFollowUp(latest)) {
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

/**
 * The searches of `plan` split by whose words they are: the user's own (the
 * whole message, then each part) and the conversational one — `null` when
 * there is none, or it repeats one of the user's own.
 */
export function planSearches(plan: RetrievalQueryPlan): {
  user: string[];
  contextual: string | null;
} {
  const user = planQueries({ ...plan, contextual: null });
  const contextual = plan.contextual?.trim() || null;
  return { user, contextual: contextual && !user.includes(contextual) ? contextual : null };
}

/**
 * One ranked list of at most `k` hits from a turn's searches. A single search
 * is returned as it ranked. Several are merged by weighted reciprocal rank
 * fusion: the user's own searches weigh 1 and the conversational one
 * {@link CONTEXTUAL_WEIGHT}, so a tie goes to the user's words. Hits that only
 * the conversational search found — the earlier topic — are then held to a
 * minority of the `k` slots, at most `floor((k - 1) / 2)`, whatever their
 * scores: the user's own words stay in charge of what the model reads.
 */
export function fuseRetrievalHits<T extends { chunkId: string }>(
  userLists: readonly T[][],
  contextualList: readonly T[] | null,
  k: number,
): T[] {
  if (!contextualList && userLists.length === 1) return userLists[0]!.slice(0, k);
  const weighted: Array<[readonly T[], number]> = [
    ...userLists.map((l): [readonly T[], number] => [l, 1]),
    ...(contextualList ? [[contextualList, CONTEXTUAL_WEIGHT] as [readonly T[], number]] : []),
  ];
  // Weighted reciprocal rank fusion (Cormack et al. 2009): score = Σ w / (K + rank).
  // Insertion order is the user's lists first, and the sort is stable, so a
  // tie goes to the user's words.
  const scored = new Map<string, { hit: T; score: number }>();
  for (const [list, weight] of weighted) {
    list.forEach((hit, idx) => {
      const entry = scored.get(hit.chunkId) ?? { hit, score: 0 };
      entry.score += weight / (RRF_K + idx + 1);
      scored.set(hit.chunkId, entry);
    });
  }
  const ranked = [...scored.values()].sort((a, b) => b.score - a.score);
  const userFound = new Set(userLists.flatMap((l) => l.map((h) => h.chunkId)));
  const maxContextualOnly = Math.floor((k - 1) / 2);
  const out: T[] = [];
  let contextualOnly = 0;
  for (const { hit } of ranked) {
    if (out.length >= k) break;
    if (!userFound.has(hit.chunkId)) {
      if (contextualOnly >= maxContextualOnly) continue;
      contextualOnly++;
    }
    out.push(hit);
  }
  return out;
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
  /** #2242 — the hit's `documents.source` (`repo`, `upload`, …), so a citation of it can link. */
  source?: string;
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
