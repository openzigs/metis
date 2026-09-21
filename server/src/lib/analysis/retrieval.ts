/**
 * Grounded retrieval for the analysis pipeline (Epic #912).
 *
 * This module isolates the *pure, testable* retrieval logic that used to live
 * inline in the orchestrator's `retrieveContext`. The orchestrator delegates to
 * these functions so that query derivation, multi-query fusion, per-requirement
 * grounding, and cross-encoder reranking can be unit-tested against a mock
 * `KnowledgeService` without going through the full pipeline.
 *
 * Design constraints (epic hard requirements):
 *   - No new dependencies — reuses `vectordb` + `@huggingface/transformers` via the
 *     existing `KnowledgeService`, `reciprocalRankFusion`, and `getReranker`.
 *   - Offline-safe — every function works under `AI_OFFLINE`: query derivation
 *     is plain string composition, HyDE is gated behind a provider check, and
 *     the reranker degrades to a no-op that preserves input order.
 *   - Bounded cost — query count, requirement fan-out, and candidate pool size
 *     are all capped via documented constants in `@metis/shared`.
 */
import {
  ANALYSIS_FUSION_POOL_SIZE,
  ANALYSIS_RETRIEVE_K,
  type AnalysisSpecialistAgentKey,
  MAX_ANALYSIS_RETRIEVAL_QUERIES,
  MAX_REQUIREMENTS_FOR_RETRIEVAL,
  REQUIREMENT_RETRIEVAL_CONCURRENCY,
} from "@metis/shared";
import type { AIProvider } from "../ai/types.js";
import { reciprocalRankFusion } from "../rag/bm25-index.js";
import type { KnowledgeService } from "../rag/knowledge-service.js";
import { getReranker, isRerankEnabled, type Reranker } from "../rag/reranker.js";
import type { RetrievalContextChunk } from "./agent-runner.js";

/**
 * Static keyword bags per specialist agent. Used as a *fallback* when project
 * metadata is empty (#914) and as one of several fused queries otherwise
 * (#917). Previously the sole retrieval query — the root cause of ungrounded
 * findings the epic fixes.
 */
export const RETRIEVAL_QUERIES: Record<AnalysisSpecialistAgentKey, string> = {
  document:
    "business goals stakeholders rules constraints regulations user stories success metrics",
  code: "class interface service controller repository module import package implements extends public void function method",
  database:
    "data model entities tables columns relationships indexes migrations schema constraints",
  web: "industry standards regulations compliance comparable products risks best practices",
};

/** Static query used to pull the *requirements* half of the code-agent context. */
export const CODE_REQUIREMENTS_QUERY = "requirements goals changes features scope project charter";

/**
 * Derive a retrieval query from project metadata + operator notes (#914/#915).
 *
 * Plain string composition (offline-safe). Only non-empty fields contribute.
 * When every field is empty the caller's `fallback` (typically the static
 * keyword bag) is returned so retrieval never runs on an empty query.
 */
export function deriveRetrievalQuery(input: {
  projectName?: string | null;
  projectDescription?: string | null;
  extraInstructions?: string | null;
  fallback: string;
}): string {
  const parts = [input.projectName, input.projectDescription, input.extraInstructions]
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0);
  const composed = parts.join(". ").trim();
  return composed.length > 0 ? composed : input.fallback;
}

/**
 * Build the ordered, de-duplicated, capped list of retrieval queries fused on
 * the analysis path (#917).
 *
 * Order reflects specificity (most specific first, used as the rerank anchor):
 *   1. Derived query (project metadata + operator notes)
 *   2. Operator notes (`extraInstructions`) on their own (#915)
 *   3. Per-requirement texts (#916)
 *   4. Static keyword bag (safety net / metadata-empty fallback, #914)
 *
 * The result is capped at {@link MAX_ANALYSIS_RETRIEVAL_QUERIES} to bound the
 * number of embedding + search round-trips.
 */
export function buildRetrievalQueries(input: {
  agentKey: AnalysisSpecialistAgentKey;
  projectName?: string | null;
  projectDescription?: string | null;
  extraInstructions?: string | null;
  requirementTexts?: string[];
  /** Override the default static bag (e.g. the code-requirements query). */
  staticBag?: string;
  maxQueries?: number;
}): string[] {
  const staticBag = input.staticBag ?? RETRIEVAL_QUERIES[input.agentKey];
  const derived = deriveRetrievalQuery({
    projectName: input.projectName,
    projectDescription: input.projectDescription,
    extraInstructions: input.extraInstructions,
    fallback: "",
  });

  const queries: string[] = [];
  const push = (raw?: string | null): void => {
    const t = (raw ?? "").trim();
    if (t.length === 0) return;
    if (queries.some((existing) => existing.toLowerCase() === t.toLowerCase())) return;
    queries.push(t);
  };

  push(derived);
  push(input.extraInstructions);
  for (const r of input.requirementTexts ?? []) push(r);
  push(staticBag);

  const max = Math.max(1, input.maxQueries ?? MAX_ANALYSIS_RETRIEVAL_QUERIES);
  // Guarantee at least one query even when everything above was empty.
  if (queries.length === 0) push(staticBag || RETRIEVAL_QUERIES[input.agentKey]);
  return queries.slice(0, max);
}

/** Internal hydrated-chunk shape used while fusing/reranking. */
interface HydratedChunk {
  chunkId: string;
  documentId: string;
  filename: string;
  position: number;
  text: string;
  score: number;
}

const toContextChunk = (m: HydratedChunk): RetrievalContextChunk => ({
  documentId: m.documentId,
  chunkIndex: m.position,
  filename: m.filename,
  text: m.text,
  score: m.score,
});

export interface GroundedRetrievalOptions {
  projectId: string;
  queries: string[];
  documentIds?: string[];
  /** Final number of chunks returned after fusion + rerank. */
  k?: number;
  /** Wide candidate pool size fed to each search + RRF + rerank. */
  fusionPoolSize?: number;
  /**
   * Whether to run the cross-encoder rerank. Defaults to {@link isRerankEnabled}
   * (honours `RAG_RERANK`). Explicitly settable for tests.
   */
  rerank?: boolean;
  /** Test seam — inject a reranker instead of {@link getReranker}. */
  reranker?: Reranker;
}

/**
 * Run multi-query grounded retrieval: search each query against a wide pool,
 * fuse the ranked lists via RRF (#917), optionally rerank the fused pool with
 * the cross-encoder (#919), de-duplicate by `documentId:position`, and trim to
 * the final top-k (#918).
 *
 * A single query degenerates to "search → (rerank) → trim", preserving the
 * original ordering. Offline-safe: the no-op reranker returns input unchanged.
 */
export async function runGroundedRetrieval(
  knowledge: KnowledgeService,
  opts: GroundedRetrievalOptions,
): Promise<RetrievalContextChunk[]> {
  const k = opts.k ?? ANALYSIS_RETRIEVE_K;
  const poolSize = opts.fusionPoolSize ?? ANALYSIS_FUSION_POOL_SIZE;
  const queries = opts.queries.map((q) => q.trim()).filter((q) => q.length > 0);
  if (queries.length === 0) return [];

  const meta = new Map<string, HydratedChunk>();
  const lists: { chunkId: string }[][] = [];

  for (const q of queries) {
    const res = await knowledge.search(opts.projectId, q, {
      k: poolSize,
      documentIds: opts.documentIds,
      fusionPoolSize: poolSize,
    });
    const list: { chunkId: string }[] = [];
    for (const h of res.hits) {
      if (!meta.has(h.chunkId)) meta.set(h.chunkId, h);
      list.push({ chunkId: h.chunkId });
    }
    lists.push(list);
  }

  // Fuse the per-query ranked lists. A single list is returned in its original
  // order (RRF is rank-monotonic), so single-query callers are unaffected.
  const fused = reciprocalRankFusion(lists, { topK: poolSize });
  let ordered: HydratedChunk[] = fused
    .map((f) => meta.get(f.chunkId))
    .filter((m): m is HydratedChunk => Boolean(m));

  // Optional cross-encoder rerank over the wide fused pool (#919). Anchored on
  // the most specific (derived) query. Offline/failure → original order.
  const wantRerank = opts.rerank ?? isRerankEnabled();
  if (wantRerank && ordered.length > 1) {
    const reranker = opts.reranker ?? getReranker();
    if (reranker.enabled) {
      try {
        const reordered = await reranker.rerank(
          queries[0],
          ordered.map((m) => ({ chunkId: m.chunkId, text: m.text, score: m.score })),
        );
        const byId = new Map(ordered.map((m) => [m.chunkId, m]));
        const next = reordered
          .map((r) => byId.get(r.chunkId))
          .filter((m): m is HydratedChunk => Boolean(m));
        if (next.length > 0) ordered = next;
      } catch {
        // Keep the fused order — reranking is a best-effort precision boost.
      }
    }
  }

  // De-duplicate by chunk identity and trim to k.
  const seen = new Set<string>();
  const out: RetrievalContextChunk[] = [];
  for (const m of ordered) {
    const key = `${m.documentId}:${m.position}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(toContextChunk(m));
    if (out.length >= k) break;
  }
  return out;
}

/** Evidence retrieved for a single extracted requirement (#916). */
export interface RequirementEvidence {
  requirementId: string;
  text: string;
  chunks: RetrievalContextChunk[];
}

/**
 * Retrieve evidence per requirement (#916): for each extracted requirement,
 * search the knowledge base with the requirement text itself as the query,
 * filtered to the user-selected `documentIds`. The fan-out is bounded by
 * {@link MAX_REQUIREMENTS_FOR_RETRIEVAL} and runs with a fixed
 * {@link REQUIREMENT_RETRIEVAL_CONCURRENCY} worker pool.
 *
 * Offline-safe: the requirement text is the query (no LLM dependency). Result
 * order matches the input requirement order.
 */
export async function retrievePerRequirement(
  knowledge: KnowledgeService,
  input: {
    projectId: string;
    requirements: Array<{ id: string; text: string }>;
    documentIds?: string[];
    k?: number;
    maxRequirements?: number;
    concurrency?: number;
    fusionPoolSize?: number;
  },
): Promise<RequirementEvidence[]> {
  const k = input.k ?? ANALYSIS_RETRIEVE_K;
  const max = input.maxRequirements ?? MAX_REQUIREMENTS_FOR_RETRIEVAL;
  const concurrency = Math.max(1, input.concurrency ?? REQUIREMENT_RETRIEVAL_CONCURRENCY);
  const poolSize = input.fusionPoolSize ?? ANALYSIS_FUSION_POOL_SIZE;

  const reqs = input.requirements.filter((r) => r.text.trim().length > 0).slice(0, max);
  const results = new Array<RequirementEvidence>(reqs.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= reqs.length) return;
      const req = reqs[i];
      const res = await knowledge.search(input.projectId, req.text, {
        k,
        documentIds: input.documentIds,
        fusionPoolSize: poolSize,
      });
      results[i] = {
        requirementId: req.id,
        text: req.text,
        chunks: res.hits.slice(0, k).map((h) => ({
          documentId: h.documentId,
          chunkIndex: h.position,
          filename: h.filename,
          text: h.text,
          score: h.score,
        })),
      };
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, reqs.length) }, () => worker()));
  return results;
}

/**
 * HyDE (Hypothetical Document Embeddings) query expansion (#917), gated behind
 * an online provider. When the provider is offline (`AI_OFFLINE`) this returns
 * `null` and the caller falls back to the requirement/derived text as the query
 * — never a hard failure.
 */
export async function maybeGenerateHydeQuery(
  provider: AIProvider,
  seed: string,
  opts?: { signal?: AbortSignal; model?: string },
): Promise<string | null> {
  if (provider.offline) return null;
  const trimmed = seed.trim();
  if (trimmed.length === 0) return null;
  try {
    const response = await provider.chat(
      [
        {
          role: "user",
          content: `Write a short, factual hypothetical passage (2-3 sentences) that would directly answer or satisfy the following requirement or topic. Output only the passage, no preamble.\n\n${trimmed}`,
        },
      ],
      {
        systemMessage:
          "You generate concise hypothetical documents for retrieval (HyDE). Respond with prose only.",
        model: opts?.model,
        signal: opts?.signal,
      },
    );
    const text = response.content.trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}
