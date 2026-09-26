/**
 * Transcript compaction for the multi-turn agent loop (#1225).
 *
 * ## What this module is, and what it used to be
 *
 * It was introduced for Epic #596 / Issue #618 as an "Incremental Context Window
 * Manager": a `ContextWindowManager` class holding a list of free-text
 * *segments*, compacted between orchestrator steps by an LLM summarizer
 * (`createLLMSummarizer`, Epic #647 / Issue #649). That class **never acquired a
 * single production call site** — for over three weeks its only consumers were
 * its own tests — so #1225 removed it rather than wiring it up. Three reasons,
 * recorded here so the approach is not reinvented:
 *
 *   1. **Wrong unit.** It compacted a flat `string[]` of segments and handed the
 *      result back as one concatenated blob (`getContext()`). The thing that
 *      actually grows quadratically is `runAgentLoop`'s `ChatMessage[]`, whose
 *      alternating assistant/tool-result roles and `"Tool result for <tool>:"`
 *      headers are load-bearing — the loop, the eval offline provider and the
 *      orchestrator tests all read that header to decide "have I already
 *      searched?". A blob cannot carry it.
 *   2. **Wrong cost model.** `compactIfNeeded()` was `async` and spent one model
 *      call per segment. Buying token savings with extra model calls, inside the
 *      very loop whose token spend is the defect, is a bad trade at these sizes.
 *      Compaction here is synchronous, deterministic and free.
 *   3. **No prefix discipline.** It had no notion of a caller-seeded, byte-stable
 *      lead, so it could not have preserved the prompt-cache prefix that #385 and
 *      #652 depend on.
 *
 * What survived is {@link estimateTokens} — the repo's shared char/≈4 heuristic,
 * already imported by `agent-loop.ts` and the basis of the #387/#398 cache-floor
 * measurements — and what replaces the class is {@link compactTranscript}, which
 * IS wired into `runAgentLoop`.
 *
 * ## The defect it fixes
 *
 * The loop re-sends the entire transcript every turn, so `promptTokens` grows
 * per turn and cumulative spend is quadratic in turn count rather than linear in
 * the content investigated. At 21 turns a transcript holding only ~35–40k tokens
 * of actual content consumed most of a 100k budget. (The originally reported
 * cause — individual tool results averaging ~19k tokens — was false: per-tool
 * caps hold the largest, `search_knowledge`, to ~7.7k. The ~19k/turn was the
 * whole transcript being re-billed.)
 *
 * ## The three contracts compaction must not break
 *
 * - **#734 — citation grounding.** `AgentLoopResult.toolCalls[].result` must stay
 *   full and untruncated. It is safe by construction: the loop captures that
 *   string when the tool executes, into an array this module never sees. JS
 *   strings are immutable, so rewriting a message's `content` cannot reach it.
 *   `transcript-compaction-loop.test.ts` pins that end to end.
 * - **#385/#652 — the byte-stable prompt prefix.** Compaction never touches the
 *   system prompt (built once, outside the loop) and never touches any message
 *   before `baseLength`, which is the caller-seeded lead (`initialMessages` on
 *   the #713 chat path, or the single task turn carrying the volatile RAG block
 *   on the analysis path). Every message is rewritten AT MOST ONCE — an already
 *   elided body is recognised by {@link TRANSCRIPT_ELISION_MARKER} and skipped —
 *   so the transcript prefix changes only at a compaction event and is byte-
 *   stable across every turn in between. A run pays at most one message-cache
 *   invalidation per compaction event, never one per turn.
 * - **The `"Tool result for <tool>:"` header.** Kept verbatim; only the body is
 *   elided, and a head slice of it survives so the early lines of a search
 *   result — where the `filePath:startLine-endLine` locators are — remain
 *   visible to the model.
 */
import type { ChatMessage } from "../ai/types.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("context-window-manager");

/** Approximate characters per token for estimation. */
const CHARS_PER_TOKEN = 4;

/**
 * Estimate token count from text using character-based approximation.
 *
 * The repo's shared heuristic: the cache-floor assertions in
 * `estimateCachedPrefixTokens` (#398), the graph-context budget and this
 * module's threshold all use it, so they agree on one approximation. A real
 * tokenizer differs slightly; nothing here needs better than that.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** The header every tool-result turn the loop appends begins with. */
const TOOL_RESULT_PREFIX = "Tool result for ";

/**
 * Sentinel written into an elided tool result. Doubles as the idempotency flag:
 * a message already carrying it is never rewritten again, which is what keeps
 * the compacted prefix byte-stable between compaction events (#385/#652).
 */
export const TRANSCRIPT_ELISION_MARKER = "[… transcript compaction (#1225):";

export interface TranscriptCompactionOptions {
  /**
   * Estimated-token ceiling for the COMPACTIBLE region of the transcript, i.e.
   * everything the loop itself appended. The caller-seeded lead and the system
   * prompt are fixed-size and deliberately excluded, so this bounds exactly the
   * part that grows per turn.
   */
  maxTranscriptTokens?: number;
  /**
   * How many of the most recent tool results are kept at full fidelity. The
   * model is usually reasoning about the last couple of results, so these are
   * the expensive ones to lose.
   */
  preserveRecentTurns?: number;
  /**
   * Characters of an elided body kept as a head slice. Search tools emit their
   * strongest hits — and the locators citation grounding harvests — first, so a
   * head slice retains far more signal per token than a tail or a middle.
   */
  headChars?: number;
  /**
   * HYSTERESIS. Once the ceiling trips, compact down to this FRACTION of it
   * rather than to the ceiling itself.
   *
   * Without it, every subsequent turn re-crosses the ceiling by exactly one
   * result and elides exactly one message — a compaction event, and therefore a
   * message-cache invalidation, on every single turn. Measured on the 21-turn
   * workload: 12 events at `targetRatio: 1`, 4 at 0.6, with the cumulative
   * prompt saving going UP because compaction gets ahead of the growth instead
   * of chasing it. Cheaper on both axes, which is why this is not tunable
   * upward past 1.
   */
  targetRatio?: number;
}

/**
 * Defaults. `maxTranscriptTokens` is sized so the per-turn prompt stays bounded
 * while three full results still fit: the largest per-tool cap in the analysis
 * tool set (`search_knowledge`) lands around 7.7k tokens, so 16k comfortably
 * holds the preserved tail plus the elided head slices of everything older.
 */
export const DEFAULT_TRANSCRIPT_COMPACTION: Required<TranscriptCompactionOptions> = {
  maxTranscriptTokens: 16_000,
  preserveRecentTurns: 3,
  headChars: 600,
  targetRatio: 0.6,
};

export interface TranscriptCompactionResult {
  /** Whether any message was rewritten on this pass. */
  compacted: boolean;
  /** How many tool-result messages were elided on this pass. */
  messagesCompacted: number;
  /** Estimated tokens in the compactible region before this pass. */
  tokensBefore: number;
  /** Estimated tokens in the compactible region after this pass. */
  tokensAfter: number;
}

function contentOf(message: ChatMessage): string | null {
  return typeof message.content === "string" ? message.content : null;
}

/** Is this one of the loop's own tool-result turns, not yet elided? */
function isCompactibleToolResult(message: ChatMessage): boolean {
  // #141 — native tool results are `tool` messages; text-protocol ones `user`.
  if (message.role !== "user" && message.role !== "tool") return false;
  const content = contentOf(message);
  if (content === null) return false;
  return content.startsWith(TOOL_RESULT_PREFIX) && !content.includes(TRANSCRIPT_ELISION_MARKER);
}

/**
 * Elide a tool-result body, keeping its header and a head slice.
 *
 * Returns `null` when there is nothing worth eliding — a body already shorter
 * than the head slice would grow, not shrink, once the marker is added.
 */
function elide(content: string, headChars: number): string | null {
  const newline = content.indexOf("\n");
  if (newline < 0) return null;
  const header = content.slice(0, newline + 1);
  const body = content.slice(newline + 1);
  if (body.length <= headChars) return null;
  const kept = body.slice(0, headChars);
  const elidedChars = body.length - kept.length;
  return `${header}${kept}\n${TRANSCRIPT_ELISION_MARKER} ${elidedChars} characters elided. The full result is retained verbatim for citation grounding; re-run the tool only if you need the rest. …]`;
}

/**
 * Bound the growing part of an agent-loop transcript, in place.
 *
 * Walks the compactible tool results oldest-first and elides them until the
 * region fits under `maxTranscriptTokens` — it stops as soon as it fits, so
 * newer results stay whole rather than the whole transcript being flattened.
 *
 * @param messages    the loop's own conversation array; rewritten in place by
 *                    REPLACING message objects, never by mutating one (a caller
 *                    that shares a message object is unaffected).
 * @param baseLength  index of the first loop-appended message. Everything below
 *                    it is the caller-seeded, byte-stable lead and is never
 *                    touched (#385/#652, #713).
 */
export function compactTranscript(
  messages: ChatMessage[],
  baseLength: number,
  options: TranscriptCompactionOptions = {},
): TranscriptCompactionResult {
  const { maxTranscriptTokens, preserveRecentTurns, headChars, targetRatio } = {
    ...DEFAULT_TRANSCRIPT_COMPACTION,
    ...options,
  };
  const targetTokens = Math.floor(maxTranscriptTokens * Math.min(1, Math.max(0, targetRatio)));

  const start = Math.max(0, baseLength);
  const regionTokens = (): number => {
    let total = 0;
    for (let i = start; i < messages.length; i++) {
      total += estimateTokens(contentOf(messages[i]) ?? "");
    }
    return total;
  };

  const tokensBefore = regionTokens();
  if (tokensBefore <= maxTranscriptTokens || start >= messages.length) {
    return { compacted: false, messagesCompacted: 0, tokensBefore, tokensAfter: tokensBefore };
  }

  // Indexes of the loop's own tool results, oldest first, minus the preserved
  // tail. `preserveRecentTurns` counts TOOL RESULTS, which is one per turn.
  const candidates: number[] = [];
  for (let i = start; i < messages.length; i++) {
    if (isCompactibleToolResult(messages[i])) candidates.push(i);
  }
  const eligible =
    preserveRecentTurns > 0 ? candidates.slice(0, -preserveRecentTurns) : candidates.slice();

  let messagesCompacted = 0;
  let tokensAfter = tokensBefore;
  for (const index of eligible) {
    if (tokensAfter <= targetTokens) break;
    const content = contentOf(messages[index]);
    if (content === null) continue;
    const compactedContent = elide(content, headChars);
    if (compactedContent === null) continue;
    tokensAfter -= estimateTokens(content) - estimateTokens(compactedContent);
    messages[index] = { ...messages[index], content: compactedContent };
    messagesCompacted++;
  }

  const result: TranscriptCompactionResult = {
    compacted: messagesCompacted > 0,
    messagesCompacted,
    tokensBefore,
    tokensAfter,
  };
  if (result.compacted) {
    log.info("transcript compacted", compactionLogMeta(result, maxTranscriptTokens, targetTokens));
  }
  return result;
}

/**
 * The log meta for a compaction event.
 *
 * Extracted so a test can assert the REAL keys survive redaction rather than a
 * copy of them.
 *
 * These keys are named for what they measure rather than as `tokensBefore` /
 * `tokensAfter` because at the time of #1225 `logger.ts` tested every meta key
 * against `/token/i` as a secrets guard, and the obvious naming reached the log
 * as `"[REDACTED]"`. **#1263 fixed that guard** — an enumerated token *count*
 * carrying a numeric value is now exempt — so the constraint no longer applies
 * and a `*Tokens` key here would log fine. The names are left alone only to
 * avoid churning a shipped log schema; add new count keys to
 * `TOKEN_COUNT_META_KEYS` in `logger.ts` rather than renaming around the guard.
 */
export function compactionLogMeta(
  result: TranscriptCompactionResult,
  ceiling: number,
  target: number,
): Record<string, number> {
  return {
    messagesCompacted: result.messagesCompacted,
    before: result.tokensBefore,
    after: result.tokensAfter,
    ceiling,
    target,
  };
}
