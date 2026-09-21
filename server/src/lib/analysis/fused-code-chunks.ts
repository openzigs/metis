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
import {
  createDefaultCodeSearcher,
  createDefaultSymbolLineLookup,
} from "../code-graph/project-code-searcher.js";
import { getConfigService } from "../config/config-service.js";
import {
  buildFusedCodeBlock,
  type FusedCodeSearcher,
  type FusedRagChunkRef,
  type FusedSymbolHit,
  type SymbolLineLookup,
} from "../rag/fused-code-context.js";
import type { RetrievalContextChunk } from "./agent-runner.js";
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
  const snippet = hit.snippet?.trim();
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
  const metadata = deriveRetrievalQuery({
    projectName: input.projectName,
    projectDescription: input.projectDescription,
    extraInstructions: input.extraInstructions,
    fallback: "",
  });
  const reqText = (input.requirementTexts ?? [])
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .join(". ");
  const composed = [metadata, reqText].filter((s) => s.length > 0).join(". ");
  return composed.length > 0 ? composed : RETRIEVAL_QUERIES.code;
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
  const chunks = await retrieveFusedCodeChunks({
    projectId: opts.projectId,
    query: buildCodeAgentFusedQuery({
      projectName: opts.projectName,
      projectDescription: opts.projectDescription,
      extraInstructions: opts.extraInstructions,
      requirementTexts: opts.requirements.map((r) => r.text),
    }),
    ragChunks: opts.ragChunks,
    enabled: opts.enabled,
    tokenBudget: opts.tokenBudget,
    maxSymbols: opts.maxSymbols,
    deps: opts.deps,
  });
  const block = renderFusedCodeContextBlock(chunks);
  return { chunks, block, tokens: estimateFusedBlockTokens(block) };
}
