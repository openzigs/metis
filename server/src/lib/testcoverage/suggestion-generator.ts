/**
 * Epic #856 — Issue #870 — AI suggestion generator.
 *
 * Operates over the UNCOVERED requirements emitted by the matcher:
 *   1. Cluster requirements via cosine k-means (k = ⌈N/8⌉).
 *   2. For each cluster, prompt the LLM with the requirement set + the most
 *      relevant document excerpts.
 *   3. Validate the JSON output via {@link SuggestionResponseSchema}.
 *   4. Score grounding via {@link scoreGrounding}; any suggestion below
 *      {@link FAITHFULNESS_THRESHOLD} flips to `lowConfidence=true` and is
 *      blocked from export.
 *   5. Dedup against existing {@link TestCaseDoc} via {@link isDuplicateOfExisting}.
 *
 * #57 — with a {@link SuggestionBudgetGuard}, each model call is recorded as it
 * happens and the budget is checked before every cluster, the way the judge
 * checks between batches: the phase stops part-way once the budget is reached,
 * or after the first call served by a model METIS has no price for.
 *
 * The generator is pure of Prisma — callers persist via the service layer.
 * A pluggable {@link JudgeModelCaller} is reused so tests need not boot a
 * real provider.
 */
import { createHash } from "node:crypto";

import { getEmbedder } from "../rag/embedder.js";
import { getSemanticCache } from "../ai/semantic-cache.js";
import { HAIKU_MODEL_ID } from "../ai/model-router.js";
import { scoreGrounding } from "../judge/hallucination-scorer.js";
import { redactString } from "../connectors/pii-redactor.js";
import { createChildLogger } from "../logger.js";

import {
  SUGGESTION_SYSTEM_PROMPT,
  SuggestionResponseSchema,
  buildClusterPrompt,
  type SuggestionItem,
} from "./suggestion-prompt.js";
import {
  type ExistingCaseVector,
  type SuggestionVector,
  dedupeWithinBatch,
  isDuplicateOfExisting,
} from "./dedup.js";
export type { ExistingCaseVector } from "./dedup.js";
import type { ProviderKey } from "../ai/types.js";
import type { JudgeModelCaller } from "./judge.js";

const log = createChildLogger("testcoverage/suggestion-generator");

/** Faithfulness gate — below this the suggestion is flagged `lowConfidence`. */
export const FAITHFULNESS_THRESHOLD = 0.6;

/** Hard caps required by the AC. */
export const MAX_SUGGESTIONS_PER_REQUIREMENT = 5;
export const MAX_STEPS_PER_SUGGESTION = 3;

const SYSTEM_PROMPT_HASH = createHash("sha256").update(SUGGESTION_SYSTEM_PROMPT).digest("hex");

export interface RequirementForSuggestion {
  id: string;
  title: string;
  body: string;
  priority: "low" | "medium" | "high" | "critical";
  embedding: number[];
}

export interface SourceExcerpt {
  chunkId: string;
  excerpt: string;
}

/**
 * #57 — the per-run cost guard the generator records each call through and
 * consults before each cluster. `CoverageCostTracker` satisfies it.
 */
export interface SuggestionBudgetGuard {
  record(input: {
    phase: "suggestion";
    provider: ProviderKey;
    modelId: string;
    promptTokens?: number;
    completionTokens?: number;
  }): void;
  /** True once the per-run cap is reached, or any usage is unpriced. */
  exceeded(): boolean;
}

export interface GenerateInput {
  requirements: readonly RequirementForSuggestion[];
  /** Optional document chunks to ground the suggestions. */
  sourceExcerpts?: readonly SourceExcerpt[];
  /** Existing tests — used for dedup. */
  existingCases?: readonly ExistingCaseVector[];
  caller: JudgeModelCaller;
  sessionId: string;
  userId: string;
  projectId?: string;
  /** Cluster size hint — default 8 per the research doc. */
  clusterSize?: number;
  /**
   * #57 — optional per-run cost guard. When supplied, every model call is
   * recorded through it (under the provider and model that served THAT call)
   * and no cluster starts once `exceeded()` is true. When omitted, the caller
   * records the returned totals itself.
   */
  cost?: SuggestionBudgetGuard;
}

export interface GeneratedSuggestion {
  item: SuggestionItem;
  /** Grounding score from the hallucination scorer (0..1, higher = grounded). */
  faithfulness: number;
  lowConfidence: boolean;
  duplicateOf?: string;
}

export interface GenerateResult {
  suggestions: GeneratedSuggestion[];
  modelCalls: number;
  cacheHits: number;
  clusters: number;
  promptTokens: number;
  completionTokens: number;
  rejectedDuplicates: number;
  /**
   * #43 — the provider and model that served the model calls, or `null` when
   * none was made (every cluster a cache hit). Usage is recorded under these.
   */
  servedBy: { provider: ProviderKey; model: string } | null;
  /**
   * #57 — true when the cost guard stopped the phase before a cluster, so some
   * clusters got no suggestions.
   */
  budgetExceeded: boolean;
}

/**
 * Lightweight cosine k-means. Deterministic seed → reproducible clusters.
 * Returns the cluster assignment per requirement (parallel to input order).
 */
export function clusterRequirements(
  reqs: readonly RequirementForSuggestion[],
  k: number,
  maxIters = 20,
): number[][] {
  if (reqs.length === 0) return [];
  const numClusters = Math.max(1, Math.min(k, reqs.length));
  const dim = reqs[0].embedding.length;
  // Deterministic init: pick every ⌈N/k⌉-th requirement as a seed.
  const stride = Math.max(1, Math.floor(reqs.length / numClusters));
  const centroids: number[][] = [];
  for (let i = 0; i < numClusters; i += 1) {
    const seed = reqs[Math.min(i * stride, reqs.length - 1)].embedding;
    centroids.push([...seed]);
  }

  const assignment = new Array<number>(reqs.length).fill(0);
  for (let iter = 0; iter < maxIters; iter += 1) {
    let changed = false;
    for (let i = 0; i < reqs.length; i += 1) {
      let best = 0;
      let bestScore = -Infinity;
      for (let c = 0; c < numClusters; c += 1) {
        const score = dot(reqs[i].embedding, centroids[c]);
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      if (assignment[i] !== best) {
        assignment[i] = best;
        changed = true;
      }
    }
    if (!changed) break;
    // Re-compute centroids = L2-normalised mean of assigned vectors.
    const next: number[][] = Array.from({ length: numClusters }, () =>
      new Array<number>(dim).fill(0),
    );
    const counts = new Array<number>(numClusters).fill(0);
    for (let i = 0; i < reqs.length; i += 1) {
      const c = assignment[i];
      counts[c] += 1;
      for (let d = 0; d < dim; d += 1) next[c][d] += reqs[i].embedding[d];
    }
    for (let c = 0; c < numClusters; c += 1) {
      if (counts[c] === 0) {
        // Empty cluster — re-seed from the first req to keep partitions live.
        next[c] = [...reqs[0].embedding];
        continue;
      }
      for (let d = 0; d < dim; d += 1) next[c][d] /= counts[c];
      normalise(next[c]);
      centroids[c] = next[c];
    }
  }

  const buckets: number[][] = Array.from({ length: numClusters }, () => []);
  for (let i = 0; i < reqs.length; i += 1) buckets[assignment[i]].push(i);
  return buckets.filter((b) => b.length > 0);
}

function dot(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

function normalise(v: number[]): void {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return;
  for (let i = 0; i < v.length; i += 1) v[i] /= norm;
}

function parseSuggestionPayload(raw: string): SuggestionItem[] {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const parsed = SuggestionResponseSchema.parse(JSON.parse(cleaned));
  return parsed.suggestions.map((s) => ({
    ...s,
    // Hard caps applied even if the model ignored them.
    steps: s.steps.slice(0, MAX_STEPS_PER_SUGGESTION),
  }));
}

/**
 * Generate suggestions for a set of UNCOVERED requirements.
 */
export async function generateSuggestions(input: GenerateInput): Promise<GenerateResult> {
  if (input.requirements.length === 0) {
    return {
      suggestions: [],
      modelCalls: 0,
      cacheHits: 0,
      clusters: 0,
      promptTokens: 0,
      completionTokens: 0,
      rejectedDuplicates: 0,
      servedBy: null,
      budgetExceeded: false,
    };
  }

  const clusterSize = Math.max(1, input.clusterSize ?? 8);
  const k = Math.max(1, Math.ceil(input.requirements.length / clusterSize));
  const buckets = clusterRequirements(input.requirements, k);
  const cache = getSemanticCache();
  const embedder = getEmbedder();

  let modelCalls = 0;
  let cacheHits = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let rejectedDuplicates = 0;
  let servedBy: GenerateResult["servedBy"] = null;
  let budgetExceeded = false;
  const all: GeneratedSuggestion[] = [];

  for (const [clustersDone, bucket] of buckets.entries()) {
    // #57 — budget hard-stop before each cluster, as the judge does between
    // batches: the previous call's spend (or its unpriced model) is already
    // recorded, so a run cannot make every call before the budget sees one.
    if (input.cost?.exceeded()) {
      budgetExceeded = true;
      log.warn("token budget exceeded mid-suggestion; stopping cluster loop", {
        sessionId: input.sessionId,
        clustersDone,
        clusters: buckets.length,
      });
      break;
    }
    const reqs = bucket.map((idx) => input.requirements[idx]);
    const userPrompt = buildClusterPrompt({
      requirements: reqs.map((r) => ({
        id: r.id,
        title: redactString(r.title) ?? r.title,
        body: redactString(r.body) ?? r.body,
        priority: r.priority,
      })),
      sourceExcerpts: (input.sourceExcerpts ?? []).slice(0, 8).map((e) => ({
        chunkId: e.chunkId,
        excerpt: redactString(e.excerpt) ?? e.excerpt,
      })),
    });

    const { vectors } = await embedder.embed([userPrompt]);
    const cacheKey = vectors[0];
    let raw: string | null = null;
    const hit = await cache.lookup(cacheKey, HAIKU_MODEL_ID, SYSTEM_PROMPT_HASH, input.projectId);
    if (hit) {
      raw = hit.response;
      cacheHits += 1;
    } else {
      const out = await input.caller.call({
        modelId: HAIKU_MODEL_ID,
        systemPrompt: SUGGESTION_SYSTEM_PROMPT,
        userPrompt,
      });
      raw = out.raw;
      modelCalls += 1;
      promptTokens += out.promptTokens;
      completionTokens += out.completionTokens;
      servedBy = { provider: out.provider, model: out.model };
      input.cost?.record({
        phase: "suggestion",
        provider: out.provider,
        modelId: out.model,
        promptTokens: out.promptTokens,
        completionTokens: out.completionTokens,
      });
      await cache.store(cacheKey, HAIKU_MODEL_ID, SYSTEM_PROMPT_HASH, raw, input.projectId);
    }

    let items: SuggestionItem[];
    try {
      items = parseSuggestionPayload(raw);
    } catch (err) {
      log.warn("suggestion payload failed to parse, skipping cluster", {
        error: (err as Error).message,
        cluster: bucket,
      });
      continue;
    }

    // Faithfulness gate. We score against the supplied requirement bodies
    // plus any source excerpts — these are the *only* legal sources.
    const sources = [
      ...reqs.map((r) => `${r.title}\n${r.body}`),
      ...(input.sourceExcerpts ?? []).map((e) => e.excerpt),
    ];

    // Embed the suggestion text once per item so we can dedup against
    // existing cases AND within-batch in a single pass.
    const suggestionTexts = items.map(
      (s) => `${s.title}\n${s.steps.map((st) => `${st.action} -> ${st.expected}`).join("; ")}`,
    );
    const { vectors: sugVectors } = await embedder.embed(suggestionTexts);
    const candidates: SuggestionVector<GeneratedSuggestion>[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const groundingText = `${item.title}\n${item.bdd.given.concat(item.bdd.when, item.bdd.then).join("\n")}\n${item.steps
        .map((s) => `${s.action} -> ${s.expected}`)
        .join("\n")}`;
      const grounding = await scoreGrounding({ output: groundingText, sources });
      const lowConfidence = grounding.groundingScore < FAITHFULNESS_THRESHOLD;
      candidates.push({
        suggestion: {
          item,
          faithfulness: grounding.groundingScore,
          lowConfidence,
        },
        embedding: sugVectors[i],
        confidence: item.confidence,
      });
    }

    // Within-batch dedup, then cross-check against existing cases.
    const collapsed = dedupeWithinBatch(candidates);
    for (const cand of collapsed) {
      const dup = isDuplicateOfExisting(cand.embedding, input.existingCases ?? []);
      if (dup.duplicate) {
        rejectedDuplicates += 1;
        log.info("suggestion rejected as duplicate of existing test", {
          testCaseDocId: dup.testCaseDocId,
          cosine: dup.cosine,
        });
        continue;
      }
      all.push(cand.suggestion);
    }
  }

  // Enforce per-requirement caps as a final pass — sort suggestions per req
  // by confidence desc and slice.
  const perReq = new Map<string, GeneratedSuggestion[]>();
  for (const s of all) {
    for (const reqId of s.item.mappedRequirementIds) {
      const existing = perReq.get(reqId) ?? [];
      existing.push(s);
      perReq.set(reqId, existing);
    }
  }
  const keep = new Set<GeneratedSuggestion>();
  for (const list of perReq.values()) {
    list
      .sort((a, b) => b.item.confidence - a.item.confidence)
      .slice(0, MAX_SUGGESTIONS_PER_REQUIREMENT)
      .forEach((s) => keep.add(s));
  }
  const final = all.filter((s) => keep.has(s));

  return {
    suggestions: final,
    modelCalls,
    cacheHits,
    clusters: buckets.length,
    promptTokens,
    completionTokens,
    rejectedDuplicates,
    servedBy,
    budgetExceeded,
  };
}
