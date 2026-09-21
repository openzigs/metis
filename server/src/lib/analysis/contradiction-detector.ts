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
 */
import { type NliVerdict, nliResponseSchema, nliVerdictSchema } from "@metis/shared";
import type { AIProvider, ChatMessage, TokenUsage } from "../ai/types.js";
import { createChildLogger } from "../logger.js";
import type { DocSegment } from "./cross-doc-validator.js";

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
}

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
 * Parse + validate the LLM NLI response. Mirrors `requirements-extractor.ts`:
 * strip markdown fences → `JSON.parse` → per-verdict Zod validation. Invalid
 * verdicts are dropped individually so one malformed entry never voids the
 * whole batch. Returns an empty result on any unrecoverable parse failure.
 * @internal — exposed for testing.
 */
export function parseNliResponse(content: string): { verdicts: NliVerdict[] } {
  let json: unknown;
  try {
    const cleaned = content
      .replace(/^```(?:json)?\s*\n?/m, "")
      .replace(/\n?```\s*$/m, "")
      .trim();
    json = JSON.parse(cleaned);
  } catch {
    log.warn("Failed to parse NLI response as JSON");
    return { verdicts: [] };
  }

  if (
    !json ||
    typeof json !== "object" ||
    !Array.isArray((json as Record<string, unknown>).verdicts)
  ) {
    return { verdicts: [] };
  }

  // Validate the envelope leniently, then re-validate each verdict so a single
  // bad entry is dropped rather than rejecting the whole array.
  const rawVerdicts = (json as { verdicts: unknown[] }).verdicts;
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
      return { contradictions: [], usage: zeroUsage() };
    }

    const usage = zeroUsage();
    const contradictions: NliVerdict[] = [];

    // ── Self-contradiction pass: one call per document ──────────────────────
    for (const seg of usable) {
      if (opts.signal?.aborted) throw makeAbortError();
      const verdicts = await this.classify([seg], "self", opts.signal, usage);
      contradictions.push(...verdicts);
    }

    // ── Pairwise pass: capped fan-out over distinct document pairs ──────────
    let pairs = 0;
    outer: for (let i = 0; i < usable.length; i++) {
      for (let j = i + 1; j < usable.length; j++) {
        if (pairs >= this.maxPairwise) break outer;
        if (opts.signal?.aborted) throw makeAbortError();
        const verdicts = await this.classify(
          [usable[i]!, usable[j]!],
          "pairwise",
          opts.signal,
          usage,
        );
        contradictions.push(...verdicts);
        pairs += 1;
      }
    }

    log.info("Contradiction detection complete: %d contradiction(s) found", contradictions.length);
    return { contradictions, usage };
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
  ): Promise<NliVerdict[]> {
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

    const response = await this.provider.chat(messages, {
      model: this.model,
      signal,
      disableTools: true,
    });
    addUsage(usage, response.usage);

    const parsed = parseNliResponse(response.content);
    const evidenceFallback = segs.map((s) => s.id);
    return parsed.verdicts
      .filter((v) => v.label === "contradiction")
      .map((v) => ({
        ...v,
        scope,
        evidenceIds: v.evidenceIds.length > 0 ? v.evidenceIds : evidenceFallback,
      }));
  }
}
