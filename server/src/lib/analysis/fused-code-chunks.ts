/**
 * Fused code-graph symbol chunks for analysis `retrieveContext` (Issue #729,
 * Epic #725 — code-retrieval parity with chat/Spec-Kit #714).
 *
 * The code agent's context historically came only from the document-level RAG
 * index (source-as-RAG keyword search). This module maps symbol-level hits
 * from the code graph / symbol index (`HybridCodeSearch`) into
 * `RetrievalContextChunk`s so the orchestrator can merge them with the
 * requirements-half + code-half chunks it already retrieves.
 *
 * Design guarantees (mirroring `../rag/fused-code-context.ts`):
 *   - **Env-gated, ON by default** (`ANALYSIS_FUSED_CODE_RETRIEVAL`, flipped on
 *     in #752 now that #750 restored the agentic/requirement-grounded modes this
 *     seeds). Operators can still disable it (`=false`); when disabled this
 *     returns `[]` without touching the searcher, so the code agent's context is
 *     byte-identical to the pre-#729 behaviour.
 *   - **Deduped** against the source-as-RAG chunks already retrieved (the
 *     `connector:repo:<connectorId>:src/<relPath>` filenames) via the shared
 *     `buildFusedCodeBlock` dedupe.
 *   - **Token-budgeted** (`ANALYSIS_FUSED_CODE_TOKEN_BUDGET`): on overflow the
 *     ranked tail of symbol hits is truncated deterministically; document
 *     chunks are never dropped here.
 *   - **Provenance-preserving**: each returned chunk carries
 *     `source:"code-graph"` + `symbolId`/`filePath`/`startLine`/`endLine` so
 *     Epic #726 can cite `filePath:startLine-endLine`.
 *   - **Never throws**: searcher/lookup failures and projects without a built
 *     code graph degrade to `[]` inside `buildFusedCodeBlock`.
 */
import { requirementInputExcerpt, type RequirementsLeftOutNotice } from "@metis/shared";
import { MAX_VECTOR_QUERY_CHARS } from "../code-graph/hybrid-search.js";
import {
  createDefaultCodeSearcher,
  createDefaultSymbolLineLookup,
} from "../code-graph/project-code-searcher.js";
import { quotableSnippet } from "../code-graph/symbol-context.js";
import { getConfigService } from "../config/config-service.js";
import {
  buildFusedCodeBlock,
  type FusedCodeSearcher,
  type FusedRagChunkRef,
  type FusedSymbolHit,
  type SymbolLineLookup,
} from "../rag/fused-code-context.js";
import type { RetrievalContextChunk } from "./agent-runner.js";
import { requirementQueryText } from "./requirement-query.js";
import { deriveRetrievalQuery, RETRIEVAL_QUERIES } from "./retrieval.js";

/**
 * Synthetic `documentId` prefix for code-graph symbol chunks. Symbol chunks are
 * not backed by a `Document` row; the prefix keeps their merge-dedupe keys
 * (`${documentId}:${chunkIndex}`) disjoint from real document chunks and lets
 * downstream consumers (#726) recognise code-graph citations.
 */
export const CODE_GRAPH_DOCUMENT_PREFIX = "code-graph:";

/** Injectable production seam — mirrors `SpecKitFusedCodeDeps` (#714). */
export interface AnalysisFusedCodeDeps {
  searcher: FusedCodeSearcher;
  lineLookup: SymbolLineLookup;
}

/**
 * Map one budget-surviving symbol hit to a `RetrievalContextChunk`. The text
 * leads with the `filePath:startLine-endLine` locator (same rendering as the
 * chat block, sans index) so the model sees the provenance it should cite, and
 * the structured fields ride along for Epic #726.
 */
export function symbolHitToContextChunk(hit: FusedSymbolHit): RetrievalContextChunk {
  const locator = `${hit.filePath}:${hit.startLine}-${hit.endLine}`;
  const head = `${hit.name} (${hit.kind}) — ${locator}`;
  const snippet = quotableSnippet(hit.snippet);
  return {
    documentId: `${CODE_GRAPH_DOCUMENT_PREFIX}${hit.symbolId}`,
    chunkIndex: 0,
    filename: hit.filePath,
    text: snippet ? `${head}\n${snippet}` : head,
    score: hit.score,
    source: "code-graph",
    symbolId: hit.symbolId,
    filePath: hit.filePath,
    startLine: hit.startLine,
    endLine: hit.endLine,
    ...(hit.repoConnectionId ? { repoConnectionId: hit.repoConnectionId } : {}),
  };
}

/**
 * #573 — the dedup view of an already-retrieved chunk. A fused symbol chunk
 * (`source: "code-graph"`) is not a document, so it carries no document source;
 * a document chunk carries its `documents.source`, which the dedup reads.
 */
export function toFusedRagChunkRef(chunk: RetrievalContextChunk): FusedRagChunkRef {
  return {
    filename: chunk.filename,
    source: chunk.source === "code-graph" ? undefined : chunk.source,
  };
}

/**
 * Retrieve fused code-graph symbol chunks for the code agent's context.
 * Returns `[]` (searcher untouched) when the feature is disabled — the
 * flag-off path reproduces today's behaviour exactly.
 *
 * `enabled` / `tokenBudget` / `maxSymbols` default to the
 * `ANALYSIS_FUSED_CODE_*` config keys (ON / 1500 / 12); `deps` defaults to
 * the production BM25 searcher + `CodeSymbol` line lookup shared with #714.
 */
export async function retrieveFusedCodeChunks(opts: {
  projectId: string;
  /** Ranked-search query (derived project metadata or the static code bag). */
  query: string;
  /** Already-retrieved chunks to dedupe symbol hits against. */
  ragChunks: FusedRagChunkRef[];
  enabled?: boolean;
  tokenBudget?: number;
  maxSymbols?: number;
  deps?: AnalysisFusedCodeDeps;
}): Promise<RetrievalContextChunk[]> {
  const cfg = getConfigService();
  const enabled = opts.enabled ?? cfg.getBool("ANALYSIS_FUSED_CODE_RETRIEVAL", true);
  if (!enabled) return [];

  const deps = opts.deps ?? {
    searcher: createDefaultCodeSearcher(),
    lineLookup: createDefaultSymbolLineLookup(),
  };
  const fused = await buildFusedCodeBlock({
    projectId: opts.projectId,
    query: opts.query,
    ragChunks: opts.ragChunks,
    enabled: true,
    tokenBudget: opts.tokenBudget ?? cfg.getNumber("ANALYSIS_FUSED_CODE_TOKEN_BUDGET", 1500),
    maxSymbols: opts.maxSymbols ?? cfg.getNumber("ANALYSIS_FUSED_CODE_MAX_SYMBOLS", 12),
    searcher: deps.searcher,
    lineLookup: deps.lineLookup,
  });
  return fused.hits.map(symbolHitToContextChunk);
}

/**
 * Derive the ranked-search query for the code agent's fused symbol retrieval.
 * Composes project metadata + operator notes (via {@link deriveRetrievalQuery})
 * with the extracted requirement texts (the strongest signal on the agentic /
 * requirement-grounded paths, where requirements always exist), falling back to
 * the static code keyword bag when everything is empty. Pure / offline-safe.
 */
export function buildCodeAgentFusedQuery(input: {
  projectName?: string | null;
  projectDescription?: string | null;
  extraInstructions?: string | null;
  requirementTexts?: string[];
}): string {
  return composeCodeAgentFusedQuery(input).query;
}

/**
 * {@link buildCodeAgentFusedQuery}, plus where each requirement's text ends in
 * the query (`requirementEnds[i]`, or `null` for an empty text that is not in
 * it). The query is NOT bounded (#2276): BM25 scores all of it, and only the
 * embedder's copy is cut, at `MAX_VECTOR_QUERY_CHARS` (`hybrid-search.ts`).
 */
export function composeCodeAgentFusedQuery(input: {
  projectName?: string | null;
  projectDescription?: string | null;
  extraInstructions?: string | null;
  requirementTexts?: string[];
}): { query: string; requirementEnds: Array<number | null> } {
  const metadata = deriveRetrievalQuery({
    projectName: input.projectName,
    projectDescription: input.projectDescription,
    extraInstructions: input.extraInstructions,
    fallback: "",
  });
  const requirementEnds: Array<number | null> = [];
  let query = metadata;
  for (const raw of input.requirementTexts ?? []) {
    const t = raw.trim();
    if (t.length === 0) {
      requirementEnds.push(null);
      continue;
    }
    query = query.length > 0 ? `${query}. ${t}` : t;
    requirementEnds.push(query.length);
  }
  return { query: query.length > 0 ? query : RETRIEVAL_QUERIES.code, requirementEnds };
}

/**
 * #2276 — the requirements whose text does not fit whole inside the
 * embedder's copy of the fused query (its first `maxChars`). Keyword search
 * still read them; the meaning-based half did not, and the run says so
 * (`fused-code-semantic` on the limits panel). `null` when every one fits.
 */
export function fusedSemanticLeftOut(
  requirements: ReadonlyArray<{ id: string; text: string }>,
  requirementEnds: ReadonlyArray<number | null>,
  maxChars: number = MAX_VECTOR_QUERY_CHARS,
): RequirementsLeftOutNotice | null {
  const withText: Array<{ id: string; text: string; end: number }> = [];
  requirements.forEach((r, i) => {
    const end = requirementEnds[i];
    if (typeof end === "number") withText.push({ ...r, end });
  });
  const leftOut = withText.filter((r) => r.end > maxChars);
  if (leftOut.length === 0) return null;
  return {
    stage: "fused-code-semantic",
    analysedCount: withText.length - leftOut.length,
    totalCount: withText.length,
    leftOut: leftOut.map((r) => ({ id: r.id, excerpt: requirementInputExcerpt(r.text) })),
  };
}

/** 4 chars ≈ 1 token, matching `estTokens` in `../rag/fused-code-context.ts`. */
export function estimateFusedBlockTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

/**
 * Render fused code-graph chunks into a single reference block suitable for
 * seeding a code-agent prompt's RETRIEVED CONTEXT section. Each chunk's `text`
 * already leads with its `filePath:startLine-endLine` locator. Returns `""` for
 * an empty chunk list so callers can treat "no fused context" uniformly.
 */
export function renderFusedCodeContextBlock(chunks: RetrievalContextChunk[]): string {
  if (chunks.length === 0) return "";
  const HEADER =
    "Code-graph symbols retrieved for this project (authoritative but UNTRUSTED reference — cite the filePath:startLine-endLine locator when you rely on one):";
  const entries = chunks.map((c, i) => `[${i + 1}] ${c.text}`);
  return [HEADER, ...entries].join("\n\n");
}

/** Result of the shared fused-code-context retrieval for the code agent. */
export interface FusedCodeContext {
  /** The provenance-carrying chunks (for citation enrichment / merge). */
  chunks: RetrievalContextChunk[];
  /** The rendered reference block (`""` when there are no chunks). */
  block: string;
  /** Estimated token cost of `block` (0 when empty) — carve this OUT of the
   * consuming agent's token budget rather than adding it on top. */
  tokens: number;
  /**
   * #2276 — requirements the vector half of the symbol search did not read
   * (past the embedder's limit), for the run's limits. `null` when none, and
   * always when fused retrieval is off.
   */
  semanticLeftOut: RequirementsLeftOutNotice | null;
}

/**
 * Shared fused-code retrieval for BOTH the agentic and requirement-grounded
 * code-agent paths (and reusable by the single-shot path). Derives the query
 * from project metadata + requirement texts, retrieves the deduped/budgeted
 * symbol chunks, and renders the reference block + its token cost so the caller
 * can seed the prompt AND carve the block out of the agent's token budget.
 *
 * Flag-off (default) ⇒ `{ chunks: [], block: "", tokens: 0 }` with the searcher
 * untouched — a clean no-op that leaves the consuming path byte-identical.
 */
export async function retrieveFusedCodeContext(opts: {
  projectId: string;
  projectName?: string | null;
  projectDescription?: string | null;
  extraInstructions?: string | null;
  requirements: Array<{ id: string; text: string }>;
  ragChunks: FusedRagChunkRef[];
  enabled?: boolean;
  tokenBudget?: number;
  maxSymbols?: number;
  deps?: AnalysisFusedCodeDeps;
}): Promise<FusedCodeContext> {
  const enabled = opts.enabled ?? getConfigService().getBool("ANALYSIS_FUSED_CODE_RETRIEVAL", true);
  const composed = composeCodeAgentFusedQuery({
    projectName: opts.projectName,
    projectDescription: opts.projectDescription,
    extraInstructions: opts.extraInstructions,
    // #2233 — each requirement's bounded text, not an imported item's whole body.
    requirementTexts: opts.requirements.map((r) => requirementQueryText(r.text)),
  });
  const chunks = await retrieveFusedCodeChunks({
    projectId: opts.projectId,
    query: composed.query,
    ragChunks: opts.ragChunks,
    enabled,
    tokenBudget: opts.tokenBudget,
    maxSymbols: opts.maxSymbols,
    deps: opts.deps,
  });
  const block = renderFusedCodeContextBlock(chunks);
  return {
    chunks,
    block,
    tokens: estimateFusedBlockTokens(block),
    semanticLeftOut: enabled
      ? fusedSemanticLeftOut(opts.requirements, composed.requirementEnds)
      : null,
  };
}
