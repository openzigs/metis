/**
 * Per-requirement coverage classification (Epic #726 / #736).
 *
 * At synthesis time each generated requirement is linked to the merged findings
 * it was grounded in (`evidenceFindingIndexes`). This module turns that linkage
 * into a single, deterministic coverage label the API + UI can surface, so the
 * "is this requirement backed by CODE, only by DOCS, or by nothing?" signal is a
 * queryable field instead of prose buried in a placeholder finding's body.
 *
 * The classification is PURE and LLM-free — it reads only the citation shapes on
 * the linked findings, so the same evidence always yields the same label and the
 * whole rule is trivially unit-testable.
 *
 * Decision rule (first match wins), for a requirement's aggregated linked-finding
 * citations:
 *   1. any CODE citation (`filePath:startLine-endLine`, #734)  → `grounded_in_code`
 *   2. else any DOCUMENT citation                              → `grounded_in_docs_only`
 *   3. else (no linked findings, or only citation-free/placeholder findings)
 *                                                              → `no_evidence`
 *
 * #735 note — the deterministic requirement→code mapping folds into
 * `grounded_in_code` TRANSITIVELY, not via a separate signal: the mapper's
 * affected file paths are seeded into the code-citation provenance set
 * (`buildCodeProvenance`, orchestrator requirement-grounded path), so a mapped
 * file the code agent cites survives citation-grounding as a real CODE citation
 * and is picked up by rule (1). A #735 candidate that maps to code but that the
 * agent never cites produces no requirement→finding linkage at all (its `NR-*`
 * id space is disjoint from the synthesized requirements), so it never silently
 * upgrades a requirement's coverage.
 */
import {
  isCodeCitation,
  isDocumentCitation,
  type Citation,
  type RequirementCoverage,
} from "@metis/shared";

/** The linked-finding evidence for a single requirement (citations only). */
export interface RequirementCoverageEvidence {
  /** Citations aggregated across every finding the requirement is grounded in. */
  citations: Citation[];
}

/**
 * Classify a single requirement's coverage from its aggregated linked-finding
 * citations. Pure — see the module doc for the exact rule.
 */
export function classifyRequirementCoverage(
  evidence: RequirementCoverageEvidence,
): RequirementCoverage {
  const citations = evidence.citations ?? [];
  if (citations.some(isCodeCitation)) return "grounded_in_code";
  if (citations.some(isDocumentCitation)) return "grounded_in_docs_only";
  return "no_evidence";
}

/** A finding as seen by the coverage computation — only its citations matter. */
export interface CoverageFlatFinding {
  citations: Citation[];
}

/** A synthesized requirement as seen by the coverage computation. */
export interface CoverageRequirement {
  /**
   * Indices into `flatFindings` this requirement is grounded in. Optional: the
   * validated synthesis schema defaults it to `[]`, but a fallback-synthesised
   * object may omit it — a missing list means "no linked evidence".
   */
  evidenceFindingIndexes?: number[];
}

/**
 * Compute the coverage label for every requirement in a synthesis result,
 * returned index-aligned with `requirements`. Out-of-range / missing evidence
 * indexes are ignored (defensive against a stale index), so a requirement whose
 * indexes resolve to nothing classifies as `no_evidence`.
 */
export function computeCoverageForRequirements(
  requirements: CoverageRequirement[],
  flatFindings: CoverageFlatFinding[],
): RequirementCoverage[] {
  return requirements.map((r) => {
    // `evidenceFindingIndexes` is `.default([])` on the validated synthesis
    // schema, but a fallback/synthesised output object may reach here without
    // it — treat a missing list as no linked evidence rather than throwing.
    const indexes = r.evidenceFindingIndexes ?? [];
    const citations = indexes.flatMap((i) => flatFindings[i]?.citations ?? []);
    return classifyRequirementCoverage({ citations });
  });
}
