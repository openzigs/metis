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
 *      `mapRequirementToCode` (BM25 over the project's `CodeSymbol` rows) and
 *      expands the transitive `blastRadius` over the code graph, returning the
 *      merged/deduped/sorted affected-symbol list (direct hits first).
 *   3. The affected-code list is rendered into a deterministic, token-budgeted
 *      DATA block that the orchestrator seeds into Winston's gap prompt inside
 *      an untrusted-data fence so gap findings anchor to real symbols/files.
 *
 * Design guarantees (mirroring `./fused-code-chunks.ts`, #729):
 *   - **Env-gated** (`ANALYSIS_AFFECTED_CODE_MAPPING`, ON by default). Off ⇒ a
 *     clean no-op: the prompt + budget are byte-identical to pre-#735.
 *   - **Deterministic**: extractor + BM25 + blast radius are all deterministic,
 *     so the same input yields byte-identical candidates and block across runs.
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
import {
  mapRequirementToCode,
  type RequirementCodeMatch,
} from "../traceability/requirement-code-mapping.js";
import type { CodeGraphDataSource } from "../code-graph/query-service.js";
import { prisma as defaultPrisma } from "../prisma.js";

const log = createChildLogger("affected-code-context");

/** 4 chars ≈ 1 token, matching `estimateFusedBlockTokens` in `./fused-code-chunks.ts`. */
export function estimateAffectedCodeTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

/** Result of the deterministic affected-code computation for one analysis run. */
export interface AffectedCodeContext {
  /**
   * Full per-candidate mapping for persistence + UI. `candidates` is COMPLETE
   * (never truncated); `truncated` flags only that the rendered prompt `block`
   * omitted some symbols/candidates to stay within the token budget.
   */
  result: AnalysisAffectedCode;
  /** Fenced-ready DATA block (token-budgeted; `""` when nothing to show). */
  block: string;
  /** Estimated token cost of `block` (0 when empty) — carve this OUT of the
   * consuming agent's token budget rather than adding it on top (#729). */
  tokens: number;
  /**
   * Every filePath that appears in `result.candidates` (normalised at the
   * caller). Fed into the #734 code-citation provenance set so the code agent
   * may cite a deterministically-mapped file without re-opening it via tools.
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
  /** Requirement→code mapper. Defaults to the BM25 `mapRequirementToCode`. */
  mapRequirement?: MapRequirementFn;
  /** Code-graph data source factory. Defaults to `PrismaCodeGraphDataSource`. */
  dataSourceFor?: (projectId: string) => CodeGraphDataSource;
}

export const DEFAULT_AFFECTED_CODE_TOKEN_BUDGET = 1500;
export const DEFAULT_AFFECTED_CODE_MAX_CANDIDATES = 8;
export const DEFAULT_AFFECTED_CODE_MAX_SYMBOLS = 8;

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

  const prisma = (opts.deps?.prisma ??
    (defaultPrisma as unknown as AffectedCodePrisma)) as AffectedCodePrisma;
  const mapRequirement: MapRequirementFn =
    opts.deps?.mapRequirement ??
    ((req, projectId) => mapRequirementToCode(req, projectId, {}, { prisma }));
  // One data source per project (the graph is project-scoped). `blastRadius`
  // only walks depth ≤ 2, so the per-hop Prisma reads are bounded.
  const dataSourceFor =
    opts.deps?.dataSourceFor ??
    ((projectId: string) => new PrismaCodeGraphDataSource(prisma, projectId));

  const candidates: AffectedCodeCandidate[] = [];
  for (let i = 0; i < Math.min(changes.length, maxCandidates); i++) {
    const change = changes[i];
    // #768 — the SAME id the requirement candidate carries into the code agent's
    // requirement set (`extractNewRequirementCandidates`), so a blast-radius
    // mapping and its requirement entry are traceable to one another.
    const id = newRequirementId(i);
    let symbols: AffectedCodeSymbol[] = [];
    try {
      const impact = await computeProjectImpact(change, opts.projectId, {
        mapRequirement,
        dataSourceFor,
        // We only want the code-symbol impact here — no schema crossing.
        includeSchemaImpact: false,
      });
      symbols = impact.affectedSymbols.slice(0, maxSymbols).map((s) => ({
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
        error: String(err),
      });
    }
    candidates.push({ id, title: change.title, body: change.body, symbols });
  }

  // Degrade cleanly when NOTHING matched across all candidates — the typical
  // no-code-graph case (requirement-grounded mode). We keep today's behaviour:
  // no fence is emitted and nothing is persisted, rather than showing an empty
  // "(no code matched)" block that carries no signal. Per-candidate empty states
  // still render when SOME candidates matched and others did not.
  const hasAnySymbols = candidates.some((c) => c.symbols.length > 0);
  if (!hasAnySymbols) return EMPTY_AFFECTED_CODE_CONTEXT;

  const rendered = renderAffectedCodeBlock(candidates, tokenBudget);
  const filePaths = [...new Set(candidates.flatMap((c) => c.symbols.map((s) => s.filePath)))];
  return {
    result: { candidates, truncated: rendered.truncated },
    block: rendered.block,
    tokens: rendered.tokens,
    filePaths,
  };
}
