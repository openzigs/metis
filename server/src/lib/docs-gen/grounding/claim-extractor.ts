/**
 * Claim-level decomposition + citation enforcement (Epic #204 / Issue #223).
 *
 * Decomposes a generated section into ATOMIC claims, each of which MUST cite one
 * or more retrieved `sourceId`s drawn from the grounding context (#222). This is
 * the structural pre-requisite for citation validation (#224): without explicit
 * per-claim `sourceIds`, there is nothing to resolve against the retrieved set.
 *
 * Structured output uses METIS's established pattern (NO Vercel AI SDK, NO
 * `generateObject` / `Output.object` / `response_format`):
 *   1. `provider.chat(messages, { disableTools: true })` with a JSON-shaped
 *      prompt asking for `{ claims: [{ claim, sourceIds }] }`.
 *   2. A dedicated `parseClaims()` validator — strip markdown fences →
 *      `JSON.parse` → shape check — modeled on
 *      `requirements-extractor.ts:67-101`.
 *   3. Zod validation applied AFTER parse (never at the model boundary).
 *
 * The offline stub (`AI_OFFLINE=1`) returns deterministic, parseable output so
 * the test seam stays green without a network call.
 */
import { z } from "zod";
import type { AIProvider, ChatMessage, ResponseFormat } from "../../ai/types.js";
import { createChildLogger } from "../../logger.js";
import { isTruncationFinishReason } from "../truncation.js";
import type { GroundingContext } from "./grounding-context.js";
import { extractFirstJson } from "./json-extract.js";
import {
  CLAIM_DECOMPOSITION_RESPONSE_FORMAT,
  JSON_OBJECT_RESPONSE_FORMAT,
  jsonObjectShapeInstruction,
} from "./structured-output-schemas.js";
import { reportGroundingUsage, type GroundingUsageListener } from "./grounding-usage.js";
import { withTransientRetry, type GroundingRetryOptions } from "./transient-retry.js";

const log = createChildLogger("docs-gen:claim-extractor");

/** A single atomic claim with the source ids that support it. */
export interface GroundedClaim {
  claim: string;
  sourceIds: string[];
}

/** Result of decomposing one section of generated text. */
export interface ClaimDecomposition {
  claims: GroundedClaim[];
  /**
   * #117 — true when the model's reply could not be parsed as a claim list, so
   * the empty `claims` means "not checked", not "nothing to check". The caller
   * surfaces it as a grounding warning on the document.
   *
   * #165 — set too when only SOME passages failed: `claims` then holds the
   * claims of the passages that parsed, and the failed passages are unchecked.
   */
  unparseable?: true;
  /**
   * #152 — set with {@link unparseable} when the reason was the output cap: a
   * reply stopped at `max_tokens` (`finishReason: "length"`) even after the
   * batch was split as far as it would go. The warning then names the cap
   * (`DOCS_GEN_CLAIM_MAX_OUTPUT_TOKENS`) instead of the structured-output mode.
   */
  truncated?: true;
}

/**
 * #152 — the largest passage, in characters, sent to the model in ONE claim
 * extraction call. Run 7's 30,713-character Formulas section asked for its whole
 * claim list in one reply, which ran 3m53s and stopped at the 8,192-token cap
 * with the JSON cut mid-array — so the section was left unverified. A claim list
 * is roughly as long as its passage plus JSON overhead, so 8,000 characters
 * keeps one reply well inside an 8K-token cap. Overridable per-instance.
 */
export const DEFAULT_CLAIM_BATCH_CHARS = 8_000;

/**
 * #152 — the smallest passage a reply cut off at the cap is split down to. Below
 * this a cut-off reply means the cap itself is too small, and splitting further
 * would only multiply calls.
 */
const MIN_SPLIT_CHARS = 500;

/**
 * #152 — split a section into passages of at most `budget` characters for
 * claim extraction, by subsection where it can: a heading starts a new passage
 * once the current one is at least half full, and paragraphs (blank-line
 * separated) and fenced blocks are kept whole when they fit. A block larger than
 * the budget on its own — a paragraph or, since #165, a fenced block — is split
 * by line; a single line longer than the budget is left whole. An UNCLOSED fence
 * no longer swallows the rest of the section as one block: its opener is read
 * as an ordinary line (#165).
 *
 * #165 — a passage that does not start with a heading is prefixed with the
 * heading it sits under, so the model sees its lines in their subsection's
 * context; a piece of a split fence re-opens (and closes) the fence the same
 * way. Those prefixes are counted within the budget. Every line of the text
 * appears in the passages, in order. A non-positive budget, or a text that
 * already fits, returns the text as one passage.
 * @internal — exported for testing.
 */
export function splitForClaimExtraction(text: string, budget: number): string[] {
  if (budget <= 0 || text.length <= budget) return [text];

  const lines = text.split("\n");
  // #165 — an opener with no closer: read it as a plain line, not a fence.
  const unclosedOpener = findUnclosedFenceOpener(lines);

  // Blocks: blank-line separated paragraphs, with fenced blocks kept intact.
  const blocks: string[][] = [];
  let current: string[] = [];
  let fence: string | null = null;
  lines.forEach((line, i) => {
    const marker = FENCE_LINE.exec(line)?.[1];
    if (fence === null && marker && i !== unclosedOpener) fence = marker;
    else if (fence !== null && marker && isClosingMarker(marker, fence)) fence = null;
    if (fence === null && line.trim() === "") {
      if (current.length > 0) blocks.push(current);
      current = [];
      return;
    }
    current.push(line);
  });
  if (current.length > 0) blocks.push(current);

  const chunks: string[] = [];
  let chunk = "";
  let heading: string | null = null;
  const flush = () => {
    if (chunk) chunks.push(chunk);
    chunk = "";
  };
  for (const block of blocks) {
    const blockText = block.join("\n");
    if (HEADING_LINE.test(block[0]) && chunk.length >= budget / 2) flush();
    if (blockText.length <= budget) {
      if (chunk && chunk.length + 2 + blockText.length > budget) flush();
      chunk = chunk ? `${chunk}\n\n${blockText}` : withHeading(heading, blockText, budget);
    } else {
      // An oversized block: pack it line by line. A chunk holding only the
      // headings above it is not sent on its own: it becomes the pieces' prefix.
      const headingsOnly =
        chunk !== "" && chunk.split("\n").every((l) => l.trim() === "" || HEADING_LINE.test(l));
      const context = HEADING_LINE.test(block[0]) ? block[0] : headingsOnly ? chunk : heading;
      if (headingsOnly) chunk = "";
      flush();
      chunks.push(...packLines(block, budget, context));
    }
    if (!block.some((l) => FENCE_LINE.test(l))) {
      heading = [...block].reverse().find((l) => HEADING_LINE.test(l)) ?? heading;
    }
  }
  flush();
  return chunks;
}

const FENCE_LINE = /^\s*(`{3,}|~{3,})/;
const HEADING_LINE = /^#{1,6}\s/;

/**
 * #165 — `piece` prefixed with the heading it sits under, unless it starts
 * with a heading of its own or the prefix would not fit in `budget`.
 */
function withHeading(heading: string | null, piece: string, budget: number): string {
  if (heading === null || HEADING_LINE.test(piece)) return piece;
  const prefixed = `${heading}\n\n${piece}`;
  return prefixed.length <= budget ? prefixed : piece;
}

function isClosingMarker(marker: string, open: string): boolean {
  return marker[0] === open[0] && marker.length >= open.length;
}

/** Index of a fence opener that is never closed, or -1. */
function findUnclosedFenceOpener(lines: readonly string[]): number {
  let open: string | null = null;
  let at = -1;
  lines.forEach((line, i) => {
    const marker = FENCE_LINE.exec(line)?.[1];
    if (!marker) return;
    if (open === null) {
      open = marker;
      at = i;
    } else if (isClosingMarker(marker, open)) open = null;
  });
  return open === null ? -1 : at;
}

/**
 * #165 — pack an oversized block's lines into pieces of at most `budget`
 * characters. A piece after the first is prefixed with `heading` (when that
 * fits), and a piece that starts or ends inside a fence re-opens / closes it,
 * so every piece still reads as code in its subsection. The prefixes and
 * markers are counted within the budget; a single line longer than the budget
 * is left whole.
 */
function packLines(block: readonly string[], budget: number, heading: string | null): string[] {
  const pieces: string[] = [];
  let lines: string[] = [];
  /** Lines added from the block to the current piece (not re-opened markers). */
  let own = 0;
  let fence: { opener: string; marker: string } | null = null;
  const ownHeading = HEADING_LINE.test(block[0]);
  const lead = () =>
    heading !== null && (pieces.length > 0 || !ownHeading) ? `${heading}\n\n` : "";
  const closer = () => (fence ? fence.marker[0].repeat(fence.marker.length) : "");
  const size = (extra: string[]) => {
    const body = [...lines, ...extra].join("\n");
    const close = fence ? `\n${closer()}` : "";
    return lead().length + body.length + close.length;
  };
  const emit = () => {
    const body = [...lines];
    if (fence) body.push(closer());
    const text = body.join("\n");
    const prefixed = lead() + text;
    pieces.push(prefixed.length <= budget ? prefixed : text);
    lines = fence ? [fence.opener] : [];
    own = 0;
  };
  for (const line of block) {
    if (own > 0 && size([line]) > budget) emit();
    lines.push(line);
    own++;
    const marker = FENCE_LINE.exec(line)?.[1];
    if (fence === null && marker) fence = { opener: line.trim(), marker };
    else if (fence !== null && marker && isClosingMarker(marker, fence.marker)) fence = null;
  }
  if (own > 0) {
    // A fence still open here was unclosed in the source: leave it as it was.
    const prefixed = lead() + lines.join("\n");
    pieces.push(prefixed.length <= budget ? prefixed : lines.join("\n"));
  }
  return pieces;
}

// ── Zod schema — applied AFTER JSON.parse + shape check, never at the boundary.
const groundedClaimSchema = z.object({
  claim: z.string().trim().min(1),
  sourceIds: z.array(z.string().trim().min(1)),
});

const decompositionSchema = z.object({
  claims: z.array(groundedClaimSchema),
});

/**
 * Strip markdown blockquote / admonition blocks before claim extraction.
 *
 * The verbose generation prompt explicitly instructs the model to emit GitHub-
 * style callouts (`> **Note:** ...`, `> **Warning:** ...`, `> **Tip:** ...`) and
 * the code-derived sections additionally tell it to flag missing facts in a
 * callout. For SAS projects that produced body-thin facts, the model honestly
 * disclaims its own output ("> **Note:** many modules had empty bodies…"). Those
 * disclaimers are META-COMMENTARY ABOUT EXTRACTION QUALITY — they are NOT
 * documentation claims to be grounded in the source. Feeding them to the claim
 * extractor turned each disclaimer line into an ungrounded "claim", dragging the
 * section's faithfulness ratio down (the Key Workflows 0/7 case was largely
 * these). We therefore drop every blockquote line (any line whose first
 * non-whitespace character is `>`, the GFM blockquote marker) before decomposing.
 *
 * Only blockquote lines are removed; normal prose, bullets, numbered lists,
 * tables, headings, and fenced code blocks are untouched — including a `>`
 * comparison that appears INSIDE a line (e.g. "amount > 1000"), which is not a
 * blockquote because the `>` is not the line's leading token. A blank line left
 * where a multi-line blockquote stood is collapsed so surrounding prose still
 * decomposes the same way.
 * @internal — exported for testing.
 */
export function stripDisclaimerBlocks(markdown: string): string {
  const lines = markdown.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    // A GFM blockquote line starts (after optional leading whitespace) with `>`.
    // This matches `>`, `> text`, and nested `>>` callouts. A mid-line `>`
    // (a numeric/SQL comparison) is NOT matched, so real claims are preserved.
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  // Collapse 3+ consecutive blank lines (possibly created by removing a
  // blockquote between paragraphs) down to a single blank line. Line-based
  // splitting downstream is blank-line tolerant, but this keeps the text tidy.
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

const SYSTEM_PROMPT = `You decompose generated documentation into ATOMIC, verifiable claims and attach citations.

You are given (a) a passage of generated documentation and (b) a list of retrieved SOURCES, each with a stable \`id\`. Break the passage into atomic factual claims. For EACH claim, list the \`id\`(s) of the source(s) that directly support it.

Rules:
- Each claim is a single, self-contained factual statement (one fact per claim).
- \`sourceIds\` MUST be drawn ONLY from the provided source ids. NEVER invent an id.
- If a claim is not supported by any provided source, return it with an EMPTY \`sourceIds\` array (do NOT fabricate a citation).
- Ignore pure formatting, headings, and diagram syntax — only extract substantive claims.

Respond ONLY with a JSON object of the shape:
{ "claims": [ { "claim": "string", "sourceIds": ["id", ...] } ] }
Do not include markdown fences or commentary.`;

export interface ClaimExtractorDeps {
  provider: AIProvider;
  model?: string;
  /**
   * When true, request prompt caching on each `chat` call: the shared system
   * prompt (reused across every section's decomposition) and the large stable
   * passage/source-id prefix in the user turn. Providers that support it (e.g.
   * the native Anthropic provider) cache those prefixes; others ignore it.
   * Defaults to false (back-compat — un-flagged requests are unchanged).
   */
  promptCaching?: boolean;
  /**
   * #1226 — OUTPUT cap for each `chat` call, resolved against THIS extractor's
   * {@link model}. Without it the request inherits the provider's
   * `defaultMaxTokens`, which was sized for the Phase-2 section model — a
   * different, potentially much larger-ceiling model than the claim model.
   */
  maxTokens?: number;
  /**
   * #336 — optional OpenAI-compatible `response_format`. When set (the
   * local/vLLM path with `DOCS_GEN_LOCAL_STRUCTURED_OUTPUT`), each `chat` call
   * requests structured output of the `{ claims: [...] }` shape. The provider
   * degrades gracefully if the runtime rejects it, and {@link parseClaims}
   * still runs, so setting this is safe on any runtime. Undefined = unchanged
   * request (the default).
   *
   * #117 — `json_schema` asks for schema-constrained decoding; a reply that
   * still does not parse (a runtime that accepted the field and ignored it) is
   * retried once in `json_object` mode. `json_object` sends JSON mode with the
   * schema stated in the system prompt.
   */
  responseFormat?: ResponseFormat;
  /**
   * #152 — the largest passage sent in one call (default
   * {@link DEFAULT_CLAIM_BATCH_CHARS}). A larger section is split with
   * {@link splitForClaimExtraction} and its claim lists concatenated in order.
   * A non-positive value falls back to the default.
   */
  batchChars?: number;
  /**
   * #247 — send `disableThinking` on every claim-extraction call. A model that
   * thinks by default (DeepSeek on its Anthropic-compatible endpoint) otherwise
   * draws its reasoning from the claim list's output cap. Default false:
   * unchanged request.
   */
  disableThinking?: boolean;
  /** #180 — told the usage of every claim-extraction call that returned a response. */
  onUsage?: GroundingUsageListener;
  /** #246 — retry of transient provider failures (defaults in `transient-retry.ts`). */
  retry?: GroundingRetryOptions;
}

/** One passage's claims, and why part of it yielded none (#165). */
interface PassageOutcome {
  claims: GroundedClaim[];
  failure: "truncated" | "unparseable" | null;
}

/**
 * #165 — a passage cut off at the cap is split at most this many times. Run 7's
 * chain (8,036 → 3,994 → 2,023 → 1,001 chars) spent four full-cap calls on a
 * model stuck repeating itself; one split is enough to tell "too big for the
 * cap" from "stuck".
 */
const MAX_SPLIT_DEPTH = 1;

/**
 * #165 — passages in a row that yield no usable claim list before the rest of
 * the section is abandoned. One failed passage no longer costs the section its
 * other passages' claims; two in a row mean the model is not producing claim
 * lists at all.
 */
const MAX_CONSECUTIVE_FAILED_PASSAGES = 2;

/** One claim-extraction call's outcome (#152). */
type BatchOutcome =
  | { kind: "parsed"; decomposition: ClaimDecomposition }
  | { kind: "truncated" }
  | { kind: "unparseable" };

export class ClaimExtractor {
  private readonly provider: AIProvider;
  private readonly model: string | undefined;
  private readonly promptCaching: boolean;
  private readonly maxTokens: number | undefined;
  private readonly responseFormat: ResponseFormat | undefined;
  private readonly batchChars: number;
  private readonly disableThinking: boolean;
  private readonly onUsage: GroundingUsageListener | undefined;
  private readonly retry: GroundingRetryOptions | undefined;

  constructor(deps: ClaimExtractorDeps) {
    this.provider = deps.provider;
    this.model = deps.model;
    this.promptCaching = deps.promptCaching ?? false;
    this.maxTokens = deps.maxTokens;
    this.responseFormat = deps.responseFormat;
    this.batchChars =
      deps.batchChars && deps.batchChars > 0
        ? Math.floor(deps.batchChars)
        : DEFAULT_CLAIM_BATCH_CHARS;
    this.disableThinking = deps.disableThinking ?? false;
    this.onUsage = deps.onUsage;
    this.retry = deps.retry;
  }

  /**
   * Decompose a section of generated text into grounded claims. The grounding
   * context supplies the legal source-id universe; the prompt enumerates the
   * source ids so the model cites real ids.
   */
  async decompose(
    sectionText: string,
    ctx: GroundingContext,
    signal?: AbortSignal,
  ): Promise<ClaimDecomposition> {
    // Drop disclaimer/admonition blockquotes (e.g. "> **Note:** empty bodies…")
    // BEFORE extraction so they never become ungrounded "claims" on either the
    // offline or the LLM path. See {@link stripDisclaimerBlocks}.
    const text = stripDisclaimerBlocks(sectionText).trim();
    if (!text) return { claims: [] };

    // Offline / no-grounding: deterministic, parseable, never invents citations.
    if (this.provider.offline) {
      return this.offlineDecomposition(text);
    }

    const idList = ctx.sources.map((s) => `- ${s.sourceId} (${s.kind}): ${s.label}`).join("\n");

    const batches = splitForClaimExtraction(text, this.batchChars);
    log.info("Decomposing section into grounded claims", {
      chars: text.length,
      batches: batches.length,
    });

    // #117 — once a runtime has been seen to ignore `json_schema`, every later
    // batch of the section goes straight to `json_object`.
    const state = { format: this.responseFormat };
    const claims: GroundedClaim[] = [];
    let failed: "truncated" | "unparseable" | null = null;
    let failedPassages = 0;
    let consecutiveFailures = 0;
    for (const batch of batches) {
      if (signal?.aborted) break;
      const outcome = await this.decomposeBatch(batch, idList, state, signal, 0);
      // #165 — the claims a passage did yield are kept, even when part of it
      // failed; only the failed part goes unchecked.
      claims.push(...outcome.claims);
      if (outcome.failure === null) {
        consecutiveFailures = 0;
        continue;
      }
      failedPassages += 1;
      consecutiveFailures += 1;
      // A cut-off reply outranks an unparseable one: it names the cap to raise.
      if (failed !== "truncated") failed = outcome.failure;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILED_PASSAGES) {
        // Two passages in a row gave no usable claim list: the model is stuck
        // (e.g. a repetition loop), and asking the rest would only spend more.
        log.warn("Claim decomposition stopped after consecutive failed passages", {
          failedPassages,
          batches: batches.length,
        });
        break;
      }
    }
    if (failed !== null) {
      log.warn("Claim decomposition incomplete; the failed passages are unverified", {
        cause: failed,
        failedPassages,
        batches: batches.length,
        claimsKept: claims.length,
        mode: state.format?.type ?? "off",
      });
      return failed === "truncated"
        ? { claims, unparseable: true, truncated: true }
        : { claims, unparseable: true };
    }
    if (state.format) log.info("Claim decomposition parsed", { mode: state.format.type });
    return { claims };
  }

  /**
   * #152 — decompose one passage. A reply stopped at the output cap is never
   * parsed and never re-asked in `json_object` mode (the same prompt would be
   * cut off the same way); the passage is split and each part asked on its own.
   *
   * #165 — split at most ONCE (`depth`), and stop at the first part that is
   * cut off too: a model that runs to the cap on half the passage is stuck (a
   * repetition loop), not short of room, and halving again only multiplies
   * full-cap calls. A passage cut off on every reply therefore costs 2 calls.
   * The claims of parts that did parse are returned with the failure.
   */
  private async decomposeBatch(
    passage: string,
    idList: string,
    state: { format: ResponseFormat | undefined },
    signal: AbortSignal | undefined,
    depth: number,
  ): Promise<PassageOutcome> {
    let outcome = await this.ask(passage, idList, state.format, signal);
    // #117 — a runtime can accept `json_schema` with HTTP 200 and ignore it, so
    // an unparseable (NOT cut-off) reply in that mode is retried once in JSON mode.
    if (
      outcome.kind === "unparseable" &&
      state.format?.type === "json_schema" &&
      !signal?.aborted
    ) {
      log.warn("Claim decomposition ignored json_schema; retrying once in json_object mode");
      state.format = JSON_OBJECT_RESPONSE_FORMAT;
      outcome = await this.ask(passage, idList, state.format, signal);
    }
    if (outcome.kind === "parsed") return { claims: outcome.decomposition.claims, failure: null };
    if (outcome.kind === "unparseable") return { claims: [], failure: "unparseable" };

    const halves = splitForClaimExtraction(passage, Math.ceil(passage.length / 2));
    if (
      depth >= MAX_SPLIT_DEPTH ||
      passage.length < MIN_SPLIT_CHARS * 2 ||
      halves.length < 2 ||
      signal?.aborted
    ) {
      log.warn("Claim list exceeded the output cap; the passage is not split further", {
        chars: passage.length,
        depth,
        maxTokens: this.maxTokens,
      });
      return { claims: [], failure: "truncated" };
    }
    log.warn("Claim list exceeded the output cap; splitting the passage and asking again", {
      chars: passage.length,
      parts: halves.length,
      maxTokens: this.maxTokens,
    });
    const claims: GroundedClaim[] = [];
    for (const half of halves) {
      const part = await this.decomposeBatch(half, idList, state, signal, depth + 1);
      claims.push(...part.claims);
      if (part.failure !== null) return { claims, failure: part.failure };
    }
    return { claims, failure: null };
  }

  private async ask(
    passage: string,
    idList: string,
    format: ResponseFormat | undefined,
    signal: AbortSignal | undefined,
  ): Promise<BatchOutcome> {
    const userContent = `AVAILABLE SOURCE IDS (cite only these):\n${idList || "(none)"}\n\n=== PASSAGE ===\n${passage}\n=== END PASSAGE ===`;
    // #117 — JSON mode enforces JSON but not the shape, so state the schema.
    const system =
      format?.type === "json_object"
        ? SYSTEM_PROMPT + jsonObjectShapeInstruction(CLAIM_DECOMPOSITION_RESPONSE_FORMAT)
        : SYSTEM_PROMPT;
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ];
    // #246 — a dropped stream, 5xx, 429 or timeout is asked again with
    // backoff; a 4xx or a cancelled run is thrown at once.
    const response = await withTransientRetry(
      async () => {
        const r = await this.provider.chat(messages, {
          model: this.model,
          signal,
          disableTools: true,
          // #1226 — cap sized for THIS extractor's model, never inherited from the
          // provider's section-model default.
          ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
          // #390/#701 — tag prompt-cache hit-ratio telemetry by workload. Claim
          // extraction has its OWN bucket (split from the faithfulness judge's
          // "grounding") so its input:output ratio + hit rate surface distinctly in
          // the #699 admin telemetry endpoint, validating the Sonnet-vs-Haiku call.
          callType: "claim-extraction",
          ...(this.promptCaching ? { promptCaching: { system: true, messages: true } } : {}),
          // #336 — structured output on the local/vLLM path when enabled.
          ...(format ? { responseFormat: format } : {}),
          // #247 — structured, extractive: no reasoning spend on the output cap.
          ...(this.disableThinking ? { disableThinking: true } : {}),
        });
        // #180 — every call that answered is billed, parsed or not.
        reportGroundingUsage(this.onUsage, "claims", r, {
          provider: this.provider.key,
          model: this.model ?? this.provider.model,
        });
        return r;
      },
      { stage: "claims", signal },
      this.retry,
    );
    // #152 — checked BEFORE parsing: a reply stopped at the cap is an
    // incomplete claim list even when the prefix happens to parse.
    if (isTruncationFinishReason(response.finishReason)) return { kind: "truncated" };
    const parsed = this.tryParseClaims(response.content);
    return parsed === null ? { kind: "unparseable" } : { kind: "parsed", decomposition: parsed };
  }

  /**
   * Deterministic offline decomposition: one claim per non-empty line that is
   * not a heading/fence, with empty citations (the validator will then flag
   * them as ungrounded — which is the correct, honest behaviour offline).
   * @internal — exposed for testing.
   */
  offlineDecomposition(text: string): ClaimDecomposition {
    const claims: GroundedClaim[] = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("```"))
      .map((l) => l.replace(/^[-*]\s+/, ""))
      .filter((l) => l.length > 0)
      .map((l) => ({ claim: l, sourceIds: [] as string[] }));
    return { claims };
  }

  /**
   * Parse + validate the LLM response into a {@link ClaimDecomposition}.
   * Mirrors `requirements-extractor.ts`: strip fences → JSON.parse → shape
   * check → Zod (post-parse). Never throws; an unparseable response yields an
   * empty decomposition.
   * @internal — exposed for testing.
   */
  parseClaims(content: string): ClaimDecomposition {
    return this.tryParseClaims(content) ?? { claims: [] };
  }

  /**
   * {@link parseClaims}, but `null` when the response is not a claim list at
   * all (no recoverable JSON, or no `claims` array), so {@link decompose} can
   * tell "unparseable" from "no claims" (#117). Tolerant: recovers the claims
   * JSON even when the model wraps it in prose or a mid-response ```json fence
   * (see {@link extractFirstJson}). We never fabricate claims.
   * @internal — exposed for testing.
   */
  tryParseClaims(content: string): ClaimDecomposition | null {
    const json = extractFirstJson(content);
    if (json === null) return null;

    // Coarse shape check before Zod (mirrors requirements-extractor).
    if (
      !json ||
      typeof json !== "object" ||
      !Array.isArray((json as Record<string, unknown>).claims)
    ) {
      log.warn("Claim decomposition missing 'claims' array");
      return null;
    }

    // Zod AFTER parse. Drop malformed entries individually rather than failing
    // the whole decomposition.
    const rawClaims = (json as { claims: unknown[] }).claims;
    const claims: GroundedClaim[] = [];
    for (const raw of rawClaims) {
      const result = groundedClaimSchema.safeParse(raw);
      if (!result.success) continue;
      claims.push({
        claim: result.data.claim,
        // De-duplicate while preserving order.
        sourceIds: Array.from(new Set(result.data.sourceIds)),
      });
    }

    // Final validation of the assembled object (post-parse Zod on the whole).
    const validated = decompositionSchema.safeParse({ claims });
    return validated.success ? validated.data : { claims: [] };
  }
}
