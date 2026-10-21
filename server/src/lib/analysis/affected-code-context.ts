/**
 * Deterministic requirement→code mapping for the analysis "Evaluate new
 * requirements" path (Issue #735, Epic #726).
 *
 * Today the operator's free-text new-requirements input (`extraInstructions`)
 * only rides into the code agent as fenced OPERATOR NOTES and into
 * retrieval-query derivation (#731) — there is no deterministic
 * requirement→code mapping. This module closes that gap by REUSING Impact
 * Analysis's machinery (Epic #159) end-to-end, adding no new traversal:
 *
 *   1. `heuristicChangeExtractor` (LLM-free, deterministic) splits the free
 *      text into discrete requirement candidates — the SAME splitter the impact
 *      engine uses, so parsing stays consistent and offline-safe.
 *   2. `computeProjectImpact` maps each candidate to code with
 *      `mapRequirementToCode` (since #1097 the hybrid search over the
 *      project's symbol embeddings, falling back to BM25 over its `CodeSymbol`
 *      rows; the run records which, `retrievalMode`) and
 *      expands the transitive `blastRadius` over the code graph, returning the
 *      merged/deduped/sorted affected-symbol list (direct hits first).
 *   3. The affected-code list is rendered into a deterministic, token-budgeted
 *      DATA block that the orchestrator seeds into Winston's gap prompt inside
 *      an untrusted-data fence so gap findings anchor to real symbols/files.
 *
 * Design guarantees (mirroring `./fused-code-chunks.ts`, #729):
 *   - **Env-gated** (`ANALYSIS_AFFECTED_CODE_MAPPING`, ON by default). Off ⇒ a
 *     clean no-op: the prompt + budget are byte-identical to pre-#735.
 *   - **Deterministic**: extractor + ranking + blast radius are all
 *     deterministic for a given code graph and set of symbol embeddings, so the
 *     same input yields byte-identical candidates and block across runs.
 *   - **Degrades cleanly**: no code graph / no matches ⇒ empty symbol lists and
 *     an empty block (`""`), never a throw and never an empty fence — the
 *     requirement-grounded mode reaches this path with no graph and stays green.
 *   - **Token-budgeted, carve-OUT**: the block is truncated deterministically at
 *     `ANALYSIS_AFFECTED_CODE_TOKEN_BUDGET`; its cost is carved OUT of the
 *     agent's token budget by the caller rather than added on top (#729's rule).
 */
import type { PrismaClient } from "@prisma/client";
import type {
  AffectedCodeCandidate,
  AffectedCodeSymbol,
  AnalysisAffectedCode,
} from "@metis/shared";
import { getConfigService } from "../config/config-service.js";
import { createChildLogger } from "../logger.js";
import { heuristicChangeExtractor } from "../impact-analysis/extract-changes.js";
import { newRequirementId } from "./new-requirements.js";
import {
  computeProjectImpact,
  PrismaCodeGraphDataSource,
} from "../impact-analysis/impact-analysis-engine.js";
import type { ChangedRequirement } from "../impact-analysis/extract-changes.js";
import {
  ANALYSIS_HYBRID_LINK_SEARCH_OPTIONS,
  ANALYSIS_LINK_SEARCH_OPTIONS,
  mapRequirementToCode,
  type Bm25SearcherOptions,
  type RequirementCodeMatch,
  type RequirementRetrievalMode,
} from "../traceability/requirement-code-mapping.js";
import {
  createRequirementCodeSearcher,
  type HybridCodeSymbolSearcher,
} from "../traceability/requirement-code-searcher.js";
import type { CodeGraphDataSource } from "../code-graph/query-service.js";
import { isTestPath } from "../code-graph/test-conventions.js";
import { prisma as defaultPrisma } from "../prisma.js";

const log = createChildLogger("affected-code-context");

/** 4 chars ≈ 1 token, matching `estimateFusedBlockTokens` in `./fused-code-chunks.ts`. */
export function estimateAffectedCodeTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

/**
 * Result of the deterministic affected-code computation for one analysis run.
 *
 * It serves TWO readers, and since #1063 they do not get the same list:
 *   - a PERSON reads `result` on the analysis page as "this requirement affects
 *     this code". It carries only links that pass the shared-name-terms rule
 *     (`ANALYSIS_LINK_MIN_SHARED_TERMS`) and, since run 9, the subject
 *     rules and no test code at any depth ({@link ANALYSIS_LINK_SEARCH_OPTIONS});
 *     a requirement with none says so.
 *   - the CODE AGENT is seeded with `block` and may cite `filePaths`. Both come
 *     from the mapper WITHOUT that rule, as before #1063: the agent verifies
 *     every seed with its tools, and the rule would have withheld symbols that
 *     are right (`flushSessions`, `user_sessions`, `web_sessions`).
 * With an injected `deps.mapRequirement` there is one mapper and one list.
 */
export interface AffectedCodeContext {
  /**
   * Per-candidate links for persistence + UI (rule applied). `candidates` is
   * COMPLETE (never truncated); `truncated` flags only that the rendered prompt
   * `block` omitted some symbols/candidates to stay within the token budget.
   */
  result: AnalysisAffectedCode;
  /**
   * Fenced-ready DATA block of the code agent's seeds (rule NOT applied;
   * token-budgeted; `""` when nothing to show).
   */
  block: string;
  /** Estimated token cost of `block` (0 when empty) — carve this OUT of the
   * consuming agent's token budget rather than adding it on top (#729). */
  tokens: number;
  /**
   * Every filePath among the code agent's seeds (normalised at the caller). Fed
   * into the #734 code-citation provenance set so the code agent may cite a
   * deterministically-mapped file without re-opening it via tools.
   */
  filePaths: string[];
}

/** Empty, no-op result — the flag-off / no-input / no-graph shape. */
export const EMPTY_AFFECTED_CODE_CONTEXT: AffectedCodeContext = {
  result: { candidates: [], truncated: false },
  block: "",
  tokens: 0,
  filePaths: [],
};

type MapRequirementFn = (
  req: { id: string; title: string; body: string },
  projectId: string,
) => Promise<RequirementCodeMatch[]>;

type AffectedCodePrisma = Pick<
  PrismaClient,
  "codeSymbol" | "codeEdge" | "requirementCodeMapping" | "$transaction"
>;

/** Injectable production seam — mirrors `AnalysisFusedCodeDeps` (#729). */
export interface AffectedCodeDeps {
  prisma?: AffectedCodePrisma;
  /**
   * Requirement→code mapper. Defaults to `mapRequirementToCode` over
   * {@link createRequirementCodeSearcher} (hybrid, BM25 fallback; #1097).
   */
  mapRequirement?: MapRequirementFn;
  /** Code-graph data source factory. Defaults to `PrismaCodeGraphDataSource`. */
  dataSourceFor?: (projectId: string) => CodeGraphDataSource;
  /**
   * #1097 — the requirement→code searcher. Defaults to
   * {@link createRequirementCodeSearcher} over `prisma`. A seam for the
   * replay measurement and tests; production never sets it.
   */
  searcher?: HybridCodeSymbolSearcher;
}

export const DEFAULT_AFFECTED_CODE_TOKEN_BUDGET = 1500;
export const DEFAULT_AFFECTED_CODE_MAX_CANDIDATES = 8;
export const DEFAULT_AFFECTED_CODE_MAX_SYMBOLS = 8;

/**
 * #1097 — a candidate's symbols with each confidence divided by the candidate's
 * best, so the best reads 1.00: the scale the code agent's block has always
 * carried. A candidate whose best is 0 is unchanged.
 */
export function relativeToBestSeed(c: AffectedCodeCandidate): AffectedCodeCandidate {
  const best = c.symbols.reduce((m, s) => Math.max(m, s.confidence), 0);
  if (best <= 0) return c;
  return { ...c, symbols: c.symbols.map((s) => ({ ...s, confidence: s.confidence / best })) };
}

/** Render one affected symbol as a single reference line (pure DATA). */
function renderSymbolLine(s: AffectedCodeSymbol): string {
  const locator = s.startLine != null ? `${s.filePath}:${s.startLine}` : s.filePath;
  return `  - ${s.qualifiedName} (${s.relation}, conf ${s.confidence.toFixed(2)}) — ${locator}`;
}

/**
 * Render the per-candidate affected-code list into a single DATA block,
 * truncating deterministically at `tokenBudget` (≈4 chars/token). Truncation is
 * applied at symbol-line granularity; a candidate header is only emitted when at
 * least its first line also fits, so the block never ends on an orphan header.
 * Returns `{ block: "", tokens: 0, truncated: false }` when there are no
 * candidates, and `truncated: true` when any candidate/symbol was omitted.
 *
 * The block is pure DATA (no instructions) — the code agent's SYSTEM message
 * carries the rule for how to use it, and the prompt builder wraps this block in
 * an untrusted-data fence and escapes it. PURE — no I/O, so the budget boundary
 * is unit-testable in isolation.
 */
export function renderAffectedCodeBlock(
  candidates: AffectedCodeCandidate[],
  tokenBudget: number,
): { block: string; tokens: number; truncated: boolean } {
  if (candidates.length === 0) return { block: "", tokens: 0, truncated: false };

  let assembled = "";
  let truncated = false;
  const fits = (candidate: string): boolean =>
    estimateAffectedCodeTokens(assembled + candidate) <= tokenBudget;

  for (const c of candidates) {
    const headerLine = `${assembled === "" ? "" : "\n"}[${c.id}] ${c.title}`;
    const symbolLines =
      c.symbols.length > 0
        ? c.symbols.map((s) => `\n${renderSymbolLine(s)}`)
        : ["\n  (no code matched — see coverage indicator)"];

    // The candidate is only worth emitting if its header + at least its first
    // line fit; otherwise stop here (deterministic boundary).
    if (!fits(headerLine + symbolLines[0])) {
      truncated = true;
      break;
    }

    let candidateText = headerLine;
    let stopped = false;
    for (const line of symbolLines) {
      if (!fits(candidateText + line)) {
        truncated = true;
        stopped = true;
        break;
      }
      candidateText += line;
    }
    assembled += candidateText;
    if (stopped) break;
  }

  if (assembled === "") {
    // Nothing fit at all — treat as empty so the caller omits the fence.
    return { block: "", tokens: 0, truncated: candidates.length > 0 };
  }
  return { block: assembled, tokens: estimateAffectedCodeTokens(assembled), truncated };
}

/**
 * Compute the deterministic requirement→code mapping for a run's free-text new
 * requirements. Reuses `heuristicChangeExtractor` (candidate parsing) +
 * `computeProjectImpact` (mapper + blast radius). NEVER throws — every failure
 * degrades to fewer/no symbols so the analysis run is unaffected and falls back
 * to today's behaviour.
 */
export async function computeAffectedCodeContext(opts: {
  projectId: string;
  extraInstructions?: string | null;
  enabled?: boolean;
  tokenBudget?: number;
  maxCandidates?: number;
  maxSymbolsPerCandidate?: number;
  deps?: AffectedCodeDeps;
}): Promise<AffectedCodeContext> {
  const cfg = getConfigService();
  const enabled = opts.enabled ?? cfg.getBool("ANALYSIS_AFFECTED_CODE_MAPPING", true);
  if (!enabled) return EMPTY_AFFECTED_CODE_CONTEXT;

  const text = opts.extraInstructions?.trim() ?? "";
  if (text.length === 0) return EMPTY_AFFECTED_CODE_CONTEXT;

  // Deterministic, LLM-free split into discrete requirement candidates. Any
  // parse failure (throw or empty) degrades to today's behaviour.
  let changes;
  try {
    changes = await heuristicChangeExtractor.extract(text);
  } catch (err) {
    log.warn("requirement-candidate extraction failed; skipping affected-code mapping", {
      projectId: opts.projectId,
      error: String(err),
    });
    return EMPTY_AFFECTED_CODE_CONTEXT;
  }
  if (changes.length === 0) return EMPTY_AFFECTED_CODE_CONTEXT;

  const maxCandidates =
    opts.maxCandidates ??
    cfg.getNumber("ANALYSIS_AFFECTED_CODE_MAX_CANDIDATES", DEFAULT_AFFECTED_CODE_MAX_CANDIDATES);
  const maxSymbols =
    opts.maxSymbolsPerCandidate ??
    cfg.getNumber("ANALYSIS_AFFECTED_CODE_MAX_SYMBOLS", DEFAULT_AFFECTED_CODE_MAX_SYMBOLS);
  const tokenBudget =
    opts.tokenBudget ??
    cfg.getNumber("ANALYSIS_AFFECTED_CODE_TOKEN_BUDGET", DEFAULT_AFFECTED_CODE_TOKEN_BUDGET);

  return mapAffectedCodeCandidates({
    projectId: opts.projectId,
    changes: changes.slice(0, maxCandidates),
    maxSymbolsPerCandidate: maxSymbols,
    tokenBudget,
    deps: opts.deps,
  });
}

/**
 * Map already-parsed requirement candidates to affected code and render the
 * agent's block — the second half of {@link computeAffectedCodeContext},
 * exported so the #1097 replay measures exactly what a run does. Candidate
 * `i` is `NR-(i+1)`. NEVER throws.
 */
export async function mapAffectedCodeCandidates(opts: {
  projectId: string;
  changes: readonly ChangedRequirement[];
  maxSymbolsPerCandidate: number;
  tokenBudget: number;
  deps?: AffectedCodeDeps;
  /**
   * The searcher options of the links a person is shown, for the keyword
   * fallback and for the hybrid ranking. Default
   * {@link ANALYSIS_LINK_SEARCH_OPTIONS} and {@link ANALYSIS_HYBRID_LINK_SEARCH_OPTIONS};
   * a seam for the #1097 replay.
   */
  linkOptions?: Readonly<Bm25SearcherOptions>;
  hybridLinkOptions?: Readonly<Bm25SearcherOptions>;
}): Promise<AffectedCodeContext> {
  const { changes } = opts;
  const maxSymbols = opts.maxSymbolsPerCandidate;
  const tokenBudget = opts.tokenBudget;
  const linkOptions = opts.linkOptions ?? ANALYSIS_LINK_SEARCH_OPTIONS;
  const hybridLinkOptions = opts.hybridLinkOptions ?? ANALYSIS_HYBRID_LINK_SEARCH_OPTIONS;
  const prisma = (opts.deps?.prisma ??
    (defaultPrisma as unknown as AffectedCodePrisma)) as AffectedCodePrisma;
  // #1063 — one corpus load, two readings of it (see {@link AffectedCodeContext}):
  // the links a person is shown pass the link rules, because one shared word
  // linked "terminate all sessions" to a Telegram keyboard button; the code
  // agent's seeds do not, because the rules also drop symbols that are right.
  // #1097 — both rank with the hybrid search when the project's symbols are
  // embedded (one query embedding serves both readings), else with BM25.
  const seedSearcher = opts.deps?.searcher ?? createRequirementCodeSearcher(prisma);
  const linkSearcher = seedSearcher.withOptions(linkOptions, hybridLinkOptions);
  const mapLinksExcludesTests =
    linkOptions.excludeTestCode === true && hybridLinkOptions.excludeTestCode === true;
  const injectedMapper = opts.deps?.mapRequirement;
  // #1097 — the ranking that answered, recorded on the run. `hybrid` only when
  // every mapped requirement was answered by the embeddings.
  const modes = new Set<RequirementRetrievalMode>();
  // The ranking that answered the LINKS of the requirement being mapped now.
  let candidateMode: RequirementRetrievalMode | undefined;
  const noteMode = (mode: RequirementRetrievalMode): void => {
    modes.add(mode);
    candidateMode = mode;
  };
  const mapSeeds: MapRequirementFn =
    injectedMapper ??
    ((req, projectId) =>
      mapRequirementToCode(
        req,
        projectId,
        { onRetrievalMode: noteMode },
        { prisma, searcher: seedSearcher },
      ));
  // An injected mapper is the caller's whole mapping: there is no second reading.
  const mapLinks: MapRequirementFn | null = injectedMapper
    ? null
    : (req, projectId) =>
        mapRequirementToCode(
          req,
          projectId,
          { onRetrievalMode: noteMode },
          { prisma, searcher: linkSearcher },
        );
  // One data source per project (the graph is project-scoped). `blastRadius`
  // only walks depth ≤ 2, so the per-hop Prisma reads are bounded.
  const dataSourceFor =
    opts.deps?.dataSourceFor ??
    ((projectId: string) => new PrismaCodeGraphDataSource(prisma, projectId));

  const mapChange = async (
    change: (typeof changes)[number],
    id: string,
    mapRequirement: MapRequirementFn,
    use: "seed" | "link",
  ): Promise<AffectedCodeSymbol[]> => {
    try {
      const impact = await computeProjectImpact(change, opts.projectId, {
        mapRequirement,
        dataSourceFor,
        // We only want the code-symbol impact here — no schema crossing.
        includeSchemaImpact: false,
      });
      // #1063 — a test that calls a linked symbol reaches the blast radius as its
      // caller; the links a person is shown leave test code out at every depth.
      const symbols =
        use === "link" && mapLinksExcludesTests
          ? impact.affectedSymbols.filter((s) => !isTestPath(s.filePath))
          : impact.affectedSymbols;
      return symbols.slice(0, maxSymbols).map((s) => ({
        filePath: s.filePath,
        qualifiedName: s.qualifiedName,
        startLine: s.startLine,
        endLine: s.endLine,
        relation: s.relation,
        depth: s.depth,
        confidence: s.confidence,
      }));
    } catch (err) {
      // A mapping failure for one candidate must never sink the analysis — the
      // candidate is still surfaced (with no symbols) so the UI shows the gap.
      log.warn("affected-code mapping failed for candidate; emitting it with no symbols", {
        projectId: opts.projectId,
        candidateId: id,
        use,
        error: String(err),
      });
      return [];
    }
  };

  /** What the code agent is seeded with (no shared-terms rule). */
  const seeds: AffectedCodeCandidate[] = [];
  /** What is persisted and shown (rule applied); `seeds` itself when injected. */
  const links: AffectedCodeCandidate[] = [];
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    // #768 — the SAME id the requirement candidate carries into the code agent's
    // requirement set (`extractNewRequirementCandidates`), so a blast-radius
    // mapping and its requirement entry are traceable to one another.
    const id = newRequirementId(i);
    const head = { id, title: change.title, body: change.body };
    candidateMode = undefined;
    const seedSymbols = await mapChange(change, id, mapSeeds, "seed");
    seeds.push({ ...head, symbols: seedSymbols });
    const linkSymbols = mapLinks ? await mapChange(change, id, mapLinks, "link") : seedSymbols;
    // #1097 — which ranking (and so which link rule) produced THIS requirement's links.
    const mode = candidateMode as RequirementRetrievalMode | undefined;
    links.push({ ...head, symbols: linkSymbols, ...(mode ? { retrievalMode: mode } : {}) });
  }

  // Degrade cleanly when NOTHING matched across all candidates — the typical
  // no-code-graph case (requirement-grounded mode). We keep today's behaviour:
  // no fence is emitted, rather than an empty "(no code matched)" block that
  // carries no signal. Per-candidate empty states still render when SOME
  // candidates matched and others did not.
  // #1097 — one word for the run, `mixed` when some requirements were answered
  // by the embeddings and others fell back to keywords (each candidate says which).
  const retrievalMode: AnalysisAffectedCode["retrievalMode"] =
    modes.size > 1
      ? "mixed"
      : modes.has("hybrid")
        ? "hybrid"
        : modes.has("bm25-only")
          ? "bm25-only"
          : undefined;
  const withMode = retrievalMode ? { retrievalMode } : {};
  const hasAnySeed = seeds.some((c) => c.symbols.length > 0);
  if (!hasAnySeed) {
    // #1063 — "the project has code and none of it matched" is a result, and the
    // page must say so. Only a project with NO code graph has nothing to report.
    // Read from the corpus the mapper already loaded (no extra query). An
    // injected mapper never loads one, so it reads as "no code" and keeps the
    // old behaviour without a separate check.
    const hasCode = await seedSearcher.hasCodeGraph(opts.projectId);
    if (!hasCode) return EMPTY_AFFECTED_CODE_CONTEXT;
    return {
      result: { candidates: links, truncated: false, ...withMode },
      block: "",
      tokens: 0,
      filePaths: [],
    };
  }

  // The block and the provenance list are the AGENT's: built from the seeds. A
  // requirement the page shows as "No code matched" can still seed the agent.
  // #1097 (review of PR #1325) — the agent keeps the scale it always had: each
  // requirement's confidences relative to its best seed (best = 1.00). The
  // absolute scale is the analyst's; no model run measured feeding it to the
  // agent, and its rule (`AFFECTED_CODE_RULE`) reads "low confidence" on its own terms.
  const rendered = renderAffectedCodeBlock(seeds.map(relativeToBestSeed), tokenBudget);
  const filePaths = [...new Set(seeds.flatMap((c) => c.symbols.map((s) => s.filePath)))];
  return {
    result: { candidates: links, truncated: rendered.truncated, ...withMode },
    block: rendered.block,
    tokens: rendered.tokens,
    filePaths,
  };
}
