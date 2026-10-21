/**
 * NLI-style contradiction detection (Epic #203 / Issue #219).
 *
 * Classifies statement pairs as entailment / neutral / contradiction over the
 * ingested-doc set:
 *   - **self-contradictions**: pairs of statements *within a single document*.
 *   - **pairwise contradictions**: pairs of statements *across two documents*.
 *
 * Uses LLM-as-context-validator with structured output via the METIS house
 * pattern: a `provider.chat(messages, { disableTools: true })` call with a
 * JSON-shaped prompt asking for `{ premise, hypothesis, label, evidenceIds }`
 * objects, then a dedicated `parseNliResponse()` validator (strip fences →
 * `JSON.parse` → Zod). Zod is applied AFTER parse, never at the model boundary.
 *
 * #1081 — a classification whose answer cannot be read used to contribute
 * "no contradictions". Each call now goes through `requestStructuredVerdict`
 * (one re-prompt), and the calls that still fail are returned in `unread` so
 * the panel can say the list may be incomplete.
 */
import { z } from "zod";
import { type NliVerdict, nliResponseSchema, nliVerdictSchema } from "@metis/shared";
import type { AIProvider, ChatMessage, TokenUsage } from "../ai/types.js";
import { createChildLogger } from "../logger.js";
import { extractJsonObject } from "./agent-runner.js";
import type { DocSegment } from "./cross-doc-validator.js";
import {
  hasVerdict,
  jsonObjectWhereDeclared,
  requestStructuredVerdict,
} from "./structured-verdict.js";
import { noUsableItem, type UnreadModelReply } from "./unread-reply.js";

const log = createChildLogger("contradiction-detector");

export interface ContradictionDetectorDeps {
  provider: AIProvider;
  model?: string;
  /**
   * Upper bound on cross-document (pairwise) comparisons so a large corpus
   * cannot trigger an O(n²) blow-up of LLM calls. Defaults to
   * {@link DEFAULT_MAX_PAIRWISE}.
   */
  maxPairwiseComparisons?: number;
  /** Per-segment content cap (characters) to bound each prompt. */
  segmentCharCap?: number;
}

export interface DetectOptions {
  signal?: AbortSignal;
}

export interface ContradictionDetectionResult {
  /** Only `label === "contradiction"` verdicts (entailment/neutral discarded). */
  contradictions: NliVerdict[];
  usage: TokenUsage;
  /** #1081 — classification calls made (self + pairwise). */
  calls: number;
  /** #1081 — one entry per call whose answer could not be read. */
  unread: UnreadModelReply[];
}

/** #1081 — the envelope only; each verdict is still validated on its own. */
const envelopeSchema = z.object({ verdicts: z.array(z.unknown()) }).refine(
  // #1081 review — verdicts listed, but not one usable, is not "no contradictions".
  (o) => !noUsableItem(o.verdicts, (v) => nliVerdictSchema.safeParse(v).success),
  { message: "no verdicts entry has the required fields", path: ["verdicts"] },
);

/** The shape quoted back to the model in the re-prompt. */
const NLI_SHAPE =
  '{ "verdicts": [ { "premise": string, "hypothesis": string, ' +
  '"label": "entailment" | "neutral" | "contradiction", "evidenceIds": string[], ' +
  '"scope": "self" | "pairwise" } ] }';

/** Default cap on pairwise (cross-doc) comparisons. */
export const DEFAULT_MAX_PAIRWISE = 20;
/** Default per-segment truncation. */
export const DEFAULT_SEGMENT_CAP = 3000;

const NLI_SYSTEM_PROMPT = [
  "You are a Natural Language Inference (NLI) classifier for a business analyst.",
  "You are given one or two document excerpts. Identify pairs of statements that",
  "make claims about the same thing, and classify each pair using premise/",
  "hypothesis framing:",
  '  - "entailment"     — the hypothesis follows from the premise.',
  '  - "neutral"        — the statements are unrelated or compatible.',
  '  - "contradiction"  — the statements cannot both be true.',
  "",
  "Only report pairs that are genuinely entailment or contradiction; skip",
  "obvious neutral pairs. Respond ONLY with a JSON object of the shape:",
  '{ "verdicts": [ { "premise": "...", "hypothesis": "...",',
  '  "label": "entailment|neutral|contradiction", "evidenceIds": ["<docId>"],',
  '  "scope": "self|pairwise" } ] }',
  "Do not include markdown fences or commentary.",
].join("\n");

function makeAbortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

function zeroUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function addUsage(into: TokenUsage, add: TokenUsage | undefined): void {
  if (!add) return;
  into.promptTokens += add.promptTokens;
  into.completionTokens += add.completionTokens;
  into.totalTokens += add.totalTokens;
}

/**
 * Parse + validate one LLM NLI response. Invalid verdicts are dropped
 * individually so one malformed entry never voids the whole batch.
 *
 * #1081 — returns `null` when the response cannot be read at all (no JSON
 * object, or no `verdicts` array), which is NOT the same as `{ verdicts: [] }`.
 * @internal — exposed for testing.
 */
export function parseNliResponse(content: string): { verdicts: NliVerdict[] } | null {
  let json: unknown;
  try {
    json = extractJsonObject(content);
  } catch {
    return null;
  }
  const envelope = envelopeSchema.safeParse(json);
  return envelope.success ? validVerdicts(envelope.data.verdicts) : null;
}

/** Re-validate each verdict so a single bad entry is dropped, not the array. */
function validVerdicts(rawVerdicts: unknown[]): { verdicts: NliVerdict[] } {
  const verdicts: NliVerdict[] = [];
  for (const raw of rawVerdicts) {
    const parsed = nliVerdictSchema.safeParse(raw);
    if (parsed.success) verdicts.push(parsed.data);
  }
  // Final shape check on the bundle (defensive; defaults already applied).
  const bundle = nliResponseSchema.safeParse({ verdicts });
  return bundle.success ? { verdicts: bundle.data.verdicts } : { verdicts };
}

function truncate(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}\n…[truncated]` : text;
}

export class ContradictionDetector {
  private readonly provider: AIProvider;
  private readonly model: string | undefined;
  private readonly maxPairwise: number;
  private readonly segmentCharCap: number;

  constructor(deps: ContradictionDetectorDeps) {
    this.provider = deps.provider;
    this.model = deps.model;
    this.maxPairwise = deps.maxPairwiseComparisons ?? DEFAULT_MAX_PAIRWISE;
    this.segmentCharCap = deps.segmentCharCap ?? DEFAULT_SEGMENT_CAP;
  }

  /**
   * Detect self + pairwise contradictions across the supplied segments. Returns
   * only `contradiction`-labelled verdicts; entailment/neutral are discarded.
   */
  async detect(
    segments: DocSegment[],
    opts: DetectOptions = {},
  ): Promise<ContradictionDetectionResult> {
    if (opts.signal?.aborted) throw makeAbortError();

    const usable = segments.filter((s) => s.content.trim().length > 0);
    if (usable.length === 0) {
      return { contradictions: [], usage: zeroUsage(), calls: 0, unread: [] };
    }

    const usage = zeroUsage();
    const contradictions: NliVerdict[] = [];
    const unread: UnreadModelReply[] = [];
    let calls = 0;
    const collect = (result: ClassifyResult): void => {
      calls += 1;
      if (result.unread) unread.push(result.unread);
      contradictions.push(...result.verdicts);
    };

    // ── Self-contradiction pass: one call per document ──────────────────────
    for (const seg of usable) {
      if (opts.signal?.aborted) throw makeAbortError();
      collect(await this.classify([seg], "self", opts.signal, usage));
    }

    // ── Pairwise pass: capped fan-out over distinct document pairs ──────────
    let pairs = 0;
    outer: for (let i = 0; i < usable.length; i++) {
      for (let j = i + 1; j < usable.length; j++) {
        if (pairs >= this.maxPairwise) break outer;
        if (opts.signal?.aborted) throw makeAbortError();
        collect(await this.classify([usable[i]!, usable[j]!], "pairwise", opts.signal, usage));
        pairs += 1;
      }
    }

    log.info("Contradiction detection complete", {
      contradictions: contradictions.length,
      calls,
      unreadCalls: unread.length,
    });
    return { contradictions, usage, calls, unread };
  }

  /**
   * Run a single NLI classification over the given segment(s), accumulate token
   * usage, and return only the contradiction verdicts (tagged with `scope`).
   */
  private async classify(
    segs: DocSegment[],
    scope: "self" | "pairwise",
    signal: AbortSignal | undefined,
    usage: TokenUsage,
  ): Promise<ClassifyResult> {
    const blocks = segs.map((s) =>
      [`### ${s.label} (id=${s.id})`, "```", truncate(s.content, this.segmentCharCap), "```"].join(
        "\n",
      ),
    );
    const userPrompt = [
      scope === "self"
        ? "Find contradictions WITHIN this single document:"
        : "Find contradictions BETWEEN these two documents:",
      "",
      ...blocks,
    ].join("\n");

    const messages: ChatMessage[] = [
      { role: "system", content: NLI_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ];

    const outcome = await requestStructuredVerdict(this.provider, {
      label: "contradiction-check",
      schema: envelopeSchema,
      schemaName: "NLI verdicts",
      expectedShape: NLI_SHAPE,
      messages,
      model: this.model,
      signal,
      disableTools: true,
      responseFormat: jsonObjectWhereDeclared(this.provider, this.model),
    });
    addUsage(usage, outcome.usage);
    if (!hasVerdict(outcome)) {
      // A provider failure is not an unreadable answer: rethrow it, as before,
      // rather than paying for every remaining comparison against a dead
      // provider. The caller records the whole pass as not finished.
      if (outcome.reason === "provider-error") throw outcome.cause ?? new Error(outcome.detail);
      log.warn("NLI answer could not be read — recorded as unread, not as no contradictions", {
        scope,
        reason: outcome.reason,
        attempts: outcome.attempts,
      });
      return { verdicts: [], unread: { reason: outcome.reason, detail: outcome.detail } };
    }

    const parsed = validVerdicts(outcome.verdict.verdicts);
    const evidenceFallback = segs.map((s) => s.id);
    return {
      verdicts: parsed.verdicts
        .filter((v) => v.label === "contradiction")
        .map((v) => ({
          ...v,
          scope,
          evidenceIds: v.evidenceIds.length > 0 ? v.evidenceIds : evidenceFallback,
        })),
    };
  }
}

/** One classification: its contradiction verdicts, or why it could not be read. */
interface ClassifyResult {
  verdicts: NliVerdict[];
  unread?: UnreadModelReply;
}
