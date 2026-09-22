/**
 * Epic #856 — Issue #863 — LLM judge for AMBIGUOUS coverage cells.
 *
 * Takes the AMBIGUOUS bucket emitted by {@link matchRequirements}, batches it
 * into groups of 8 (req, case) pairs per call, asks a fast model (Haiku via
 * {@link ModelRouter}) for a JSON verdict per pair, and writes a
 * `judgeConfidence ∈ [0,1]` back onto each cell. Cells then flip to COVERED
 * (`confidence ≥ 0.5`) or UNCOVERED.
 *
 * Caching: every batch prompt is looked up in the {@link SemanticResponseCache}
 * before a model call. Repeat runs over the same fixture produce zero model
 * calls. Token usage is recorded against the run via {@link TokenTracker} so
 * the cost-tracker (#878) can surface a budget endpoint.
 */
import { createHash } from "node:crypto";

import { z } from "zod";

import { getEmbedder } from "../rag/embedder.js";
import { getSemanticCache } from "../ai/semantic-cache.js";
import { HAIKU_MODEL_ID } from "../ai/model-router.js";
import { getTokenTracker } from "../ai/token-tracker.js";
import type { ProviderKey } from "../ai/types.js";
import { createChildLogger } from "../logger.js";
import type { MatcherCell } from "./coverage-matcher.js";

const log = createChildLogger("testcoverage/judge");

/** Default batch size — research §6.3 recommends 8 to stay within Haiku context. */
export const DEFAULT_BATCH_SIZE = 8;

/** Default decision threshold for promoting an AMBIGUOUS cell to COVERED. */
export const DEFAULT_COVERAGE_CONFIDENCE = 0.5;

const JudgeItemSchema = z.object({
  idx: z.number().int().nonnegative(),
  isCovered: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(280).optional(),
});

const JudgeResponseSchema = z.object({
  verdicts: z.array(JudgeItemSchema),
});

export type JudgeVerdict = z.infer<typeof JudgeItemSchema>;

/** Hydrated input for the judge — same id pairs as the matcher cells. */
export interface JudgePair {
  cell: MatcherCell;
  /** Full requirement text (title + body). */
  requirementText: string;
  /** Full test-case text — what `caseText(tc)` produced for the indexer. */
  testCaseText: string;
}

/** Caller-supplied LLM bridge — injectable so tests do not need Bedrock. */
export interface JudgeModelCaller {
  /**
   * Returns the raw JSON string the model produced and the token usage so we
   * can record cost. Implementations should *not* parse the response.
   */
  call(input: {
    modelId: string;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<JudgeCallResult>;
}

/** One model call's output, usage, and what served it. */
export interface JudgeCallResult {
  raw: string;
  promptTokens: number;
  completionTokens: number;
  /**
   * #43 — the provider and model that SERVED the call (`ChatResponse.provider`
   * / `.model`), which may differ from the requested `modelId` (an
   * Anthropic-compatible endpoint maps `claude-haiku-*` onto its own model).
   * Usage is recorded and priced under these.
   */
  provider: ProviderKey;
  model: string;
}

/**
 * Minimal budget guard the judge consults between batches so a large run can
 * never overspend the per-run cap (Epic #880 / #883). The
 * `CoverageCostTracker` satisfies this structurally; tests can pass a stub.
 *
 * When provided, the judge records each batch's spend through `record` and
 * checks `exceeded()` *before* every batch — stopping the loop (no further LLM
 * calls) the moment the budget is reached.
 */
export interface JudgeBudgetGuard {
  /** Record token usage for one batch so cumulative spend advances. */
  record(input: {
    phase: "judge";
    provider: ProviderKey;
    modelId: string;
    promptTokens?: number;
    completionTokens?: number;
  }): void;
  /** True once cumulative spend has reached the per-run cap. */
  exceeded(): boolean;
}

export interface JudgeOptions {
  batchSize?: number;
  /** Confidence below which the cell flips to UNCOVERED (default 0.5). */
  coverageConfidence?: number;
  caller: JudgeModelCaller;
  /** TokenTracker session id — usually the runId. */
  sessionId: string;
  userId: string;
  projectId?: string;
  /**
   * Optional per-run cost guard. When supplied, the judge records each batch's
   * token spend through it and aborts the batch loop as soon as `exceeded()`
   * returns true (Epic #880 / #883). When omitted, the judge records its total
   * spend to the global {@link TokenTracker} once at the end (legacy path).
   */
  cost?: JudgeBudgetGuard;
}

export interface JudgeResult {
  /** Mutated copy of input pairs with `judgeConfidence` populated. */
  pairs: JudgePair[];
  /** Counts for telemetry / smoke assertions. */
  batches: number;
  modelCalls: number;
  cacheHits: number;
  promptTokens: number;
  completionTokens: number;
  /**
   * True when the batch loop stopped early because the cost guard's budget was
   * exhausted (Epic #880 / #883). Pairs after the cut-off keep their AMBIGUOUS
   * status.
   */
  budgetExceeded: boolean;
}

const SYSTEM_PROMPT = `You are a senior QA reviewer judging whether a test case verifies a software requirement.

For each (requirement, test case) pair you will respond ONLY with a JSON object of shape:
{"verdicts":[{"idx":0,"isCovered":true|false,"confidence":0.0-1.0,"reason":"…"}]}

Rules:
- Use idx exactly as given.
- isCovered=true ⇔ the test case directly exercises the behaviour described by the requirement.
- confidence ∈ [0,1]; ≥0.8 = strong evidence, ≤0.3 = strong evidence against.
- Be terse — reason ≤ 1 short sentence.
- Output NOTHING other than the JSON object.`;

const SYSTEM_PROMPT_HASH = createHash("sha256").update(SYSTEM_PROMPT).digest("hex");

/** Build the user prompt for one batch. Deterministic for cache hits. */
export function buildUserPrompt(pairs: readonly JudgePair[]): string {
  const lines: string[] = ["Judge the following pairs:"];
  pairs.forEach((p, idx) => {
    lines.push(
      "",
      `--- idx=${idx} ---`,
      "REQUIREMENT:",
      p.requirementText.trim().slice(0, 1500),
      "TEST CASE:",
      p.testCaseText.trim().slice(0, 1500),
    );
  });
  lines.push("", "Respond with the JSON object now.");
  return lines.join("\n");
}

/** Parse the model output, retrying once with a stricter framing on failure. */
async function parseWithRetry(
  raw: string,
  retry: () => Promise<{ raw: string; promptTokens: number; completionTokens: number }>,
): Promise<{
  verdicts: JudgeVerdict[];
  extraPromptTokens: number;
  extraCompletionTokens: number;
}> {
  // Cheap recovery — strip code-fence noise the model sometimes adds.
  const candidate = raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    const parsed = JudgeResponseSchema.parse(JSON.parse(candidate));
    return {
      verdicts: parsed.verdicts,
      extraPromptTokens: 0,
      extraCompletionTokens: 0,
    };
  } catch (err) {
    log.warn("judge response failed to parse, retrying once", {
      error: (err as Error).message,
      preview: candidate.slice(0, 120),
    });
    const second = await retry();
    const cleaned = second.raw
      .trim()
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/, "")
      .trim();
    const parsed = JudgeResponseSchema.parse(JSON.parse(cleaned));
    return {
      verdicts: parsed.verdicts,
      extraPromptTokens: second.promptTokens,
      extraCompletionTokens: second.completionTokens,
    };
  }
}

/**
 * Judge a batch of AMBIGUOUS pairs. Returns the same pairs with each
 * `cell.judgeConfidence` populated and `cell.status` flipped accordingly.
 *
 * Idempotent on cache hit — re-running with identical inputs makes zero
 * model calls.
 */
export async function judgeAmbiguous(
  pairs: readonly JudgePair[],
  options: JudgeOptions,
): Promise<JudgeResult> {
  if (pairs.length === 0) {
    return {
      pairs: [],
      batches: 0,
      modelCalls: 0,
      cacheHits: 0,
      promptTokens: 0,
      completionTokens: 0,
      budgetExceeded: false,
    };
  }

  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const coverageConfidence = options.coverageConfidence ?? DEFAULT_COVERAGE_CONFIDENCE;
  const cache = getSemanticCache();
  const tracker = getTokenTracker();
  const embedder = getEmbedder();

  let batches = 0;
  let modelCalls = 0;
  let cacheHits = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let budgetExceeded = false;
  /** What served the most recent model call (#43). */
  let servedBy: { provider: ProviderKey; model: string } | null = null;

  const results: JudgePair[] = pairs.map((p) => ({
    ...p,
    cell: { ...p.cell, judgeConfidence: p.cell.judgeConfidence, status: p.cell.status },
  }));

  for (let start = 0; start < results.length; start += batchSize) {
    // Budget hard-stop between batches (Epic #880 / #883): once the per-run cap
    // is reached, stop issuing model calls so a large run cannot overspend.
    if (options.cost?.exceeded()) {
      budgetExceeded = true;
      log.warn("token budget exceeded mid-judge; stopping batch loop", {
        sessionId: options.sessionId,
        processedBatches: batches,
      });
      break;
    }

    const batch = results.slice(start, start + batchSize);
    const userPrompt = buildUserPrompt(batch);
    const { vectors } = await embedder.embed([userPrompt]);
    const cacheKey = vectors[0];

    let raw: string | null = null;
    let batchPromptTokens = 0;
    let batchCompletionTokens = 0;
    const hit = await cache.lookup(cacheKey, HAIKU_MODEL_ID, SYSTEM_PROMPT_HASH, options.projectId);
    if (hit) {
      raw = hit.response;
      cacheHits += 1;
    } else {
      const out = await options.caller.call({
        modelId: HAIKU_MODEL_ID,
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
      });
      raw = out.raw;
      modelCalls += 1;
      batchPromptTokens += out.promptTokens;
      batchCompletionTokens += out.completionTokens;
      servedBy = { provider: out.provider, model: out.model };
      await cache.store(cacheKey, HAIKU_MODEL_ID, SYSTEM_PROMPT_HASH, raw, options.projectId);
    }

    const parsed = await parseWithRetry(raw, async () => {
      const retry = await options.caller.call({
        modelId: HAIKU_MODEL_ID,
        systemPrompt: SYSTEM_PROMPT + "\n\nIMPORTANT: Reply ONLY with valid JSON, no prose.",
        userPrompt,
      });
      modelCalls += 1;
      batchPromptTokens += retry.promptTokens;
      batchCompletionTokens += retry.completionTokens;
      servedBy = { provider: retry.provider, model: retry.model };
      return retry;
    });

    promptTokens += batchPromptTokens;
    completionTokens += batchCompletionTokens;
    batches += 1;

    // Record this batch's spend immediately so the budget guard reflects it
    // before the next iteration's `exceeded()` check.
    if (options.cost && servedBy && (batchPromptTokens > 0 || batchCompletionTokens > 0)) {
      options.cost.record({
        phase: "judge",
        provider: servedBy.provider,
        modelId: servedBy.model,
        promptTokens: batchPromptTokens,
        completionTokens: batchCompletionTokens,
      });
    }

    for (const verdict of parsed.verdicts) {
      const pair = batch[verdict.idx];
      if (!pair) continue;
      pair.cell.judgeConfidence = verdict.confidence;
      pair.cell.status = verdict.confidence >= coverageConfidence ? "COVERED" : "UNCOVERED";
    }
  }

  // Persist token usage in one shot per run-judge phase only when no cost guard
  // is wired in. With a cost guard, each batch is already recorded above (which
  // delegates to the TokenTracker), so a final aggregate write would
  // double-count. We use the existing TokenTracker.record API so the
  // cost-tracker (#878) can scope by `agentStep="testcoverage.judge"`.
  if (!options.cost && servedBy && modelCalls > 0) {
    tracker.record({
      sessionId: options.sessionId,
      userId: options.userId,
      provider: servedBy.provider,
      model: servedBy.model,
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      projectId: options.projectId,
      agentStep: "testcoverage.judge",
      breakdown: { judge: promptTokens + completionTokens },
    });
  }

  return {
    pairs: results,
    batches,
    modelCalls,
    cacheHits,
    promptTokens,
    completionTokens,
    budgetExceeded,
  };
}
