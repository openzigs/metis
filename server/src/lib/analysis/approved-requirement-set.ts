/**
 * Issue #730 — promote the requirements the user APPROVED, not a different set.
 *
 * The approval checkpoint raises one `requirement` approval per STRUCTURED
 * requirement (`metadata.structuredRequirements`, ids like `REQ-3`), so that is
 * the list a reviewer reads, edits through clarification, and approves. The
 * promotion path, however, persisted the SYNTHESIS agent's output — a disjoint
 * set, and on a degraded run the deterministic keyword fallback, titled after
 * findings ("Could not verify: …") with no acceptance criteria. Approving 27
 * requirements produced 28 unrelated ones that then needed approving again.
 *
 * This pure module builds the set to persist from the approved structured
 * requirements. Synthesis still contributes what only it has — acceptance
 * criteria, the finding evidence that drives coverage/verdicts, labels and
 * story points — but only by joining onto an approved requirement, never by
 * adding rows nobody reviewed. The join is on the structured TITLE, the same
 * containment match #1116 uses to place clarification answers.
 */
import type { SynthesisOutput, SynthesizedRequirement } from "@metis/shared";
import {
  ATTRIBUTION_THRESHOLD,
  containmentScore,
  significantTokens,
} from "./clarification-enrichment.js";
import type { StructuredRequirement } from "./types/requirements.js";

const PRIORITY_BY_STRUCTURED: Record<string, SynthesizedRequirement["priority"]> = {
  "must-have": "high",
  "should-have": "medium",
  "nice-to-have": "low",
};

const MAX_TITLE = 255;
const MAX_BODY = 4096;
/** `synthesizedRequirementSchema.labels` caps the list at 16. */
const MAX_LABELS = 16;

/**
 * Pair each approved structured requirement with at most one synthesized
 * requirement (and each synthesized requirement with at most one structured
 * one), best score first, so evidence and criteria are never duplicated onto
 * two rows.
 */
function matchSynthesized(
  approved: StructuredRequirement[],
  synthesized: SynthesizedRequirement[],
): Map<string, SynthesizedRequirement> {
  const synthTokens = synthesized.map((s) => significantTokens(`${s.title} ${s.body}`));
  const candidates: Array<{ structuredId: string; synthIdx: number; score: number }> = [];
  for (const req of approved) {
    const needle = significantTokens(req.title);
    synthTokens.forEach((tokens, synthIdx) => {
      const score = containmentScore(needle, tokens);
      if (score >= ATTRIBUTION_THRESHOLD) {
        candidates.push({ structuredId: req.id, synthIdx, score });
      }
    });
  }
  candidates.sort((a, b) => b.score - a.score);

  const byStructuredId = new Map<string, SynthesizedRequirement>();
  const usedSynth = new Set<number>();
  for (const c of candidates) {
    if (byStructuredId.has(c.structuredId) || usedSynth.has(c.synthIdx)) continue;
    const match = synthesized[c.synthIdx];
    if (!match) continue;
    byStructuredId.set(c.structuredId, match);
    usedSynth.add(c.synthIdx);
  }
  return byStructuredId;
}

export interface RequirementApprovalRow {
  itemId: string;
  status: string;
  createdAt?: Date | null;
  reviewedAt?: Date | null;
}

/**
 * Issue #909 — the deciding approval per structured id. Approval rows are never
 * deleted, and the extractor numbers every run from `REQ-001`, so after a
 * re-run one id carries an approval from each run. The most recently CREATED
 * row belongs to the current list; an older run's verdict must not decide it
 * (an earlier approval would otherwise promote a requirement just rejected).
 */
export function latestRequirementApprovals<T extends RequirementApprovalRow>(
  approvals: readonly T[],
): Map<string, T> {
  const latest = new Map<string, T>();
  for (const a of approvals) {
    const seen = latest.get(a.itemId);
    if (!seen || (a.createdAt?.getTime() ?? 0) >= (seen.createdAt?.getTime() ?? 0)) {
      latest.set(a.itemId, a);
    }
  }
  return latest;
}

/**
 * The requirement set to persist for an analysis whose requirements went
 * through the approval checkpoint: exactly the approved structured
 * requirements, in their reviewed order, with the reviewed title and
 * description. Rejected and still-pending ones are left out.
 */
export function buildApprovedRequirementSet(input: {
  structured: StructuredRequirement[];
  approvedIds: ReadonlySet<string>;
  synthesis: SynthesisOutput | null;
}): SynthesisOutput {
  const approved = input.structured.filter((r) => input.approvedIds.has(r.id));
  const matches = matchSynthesized(approved, input.synthesis?.requirements ?? []);

  const requirements: SynthesizedRequirement[] = approved.map((req) => {
    const match = matches.get(req.id);
    const title = (req.title.trim() || req.id).slice(0, MAX_TITLE);
    const body = (req.description.trim() || title).slice(0, MAX_BODY);
    return {
      type: match?.type ?? "feature",
      title,
      body,
      priority: PRIORITY_BY_STRUCTURED[req.priority] ?? match?.priority ?? "medium",
      // Issue #909 — the reviewed classification (functional, non-functional,
      // constraint, …) has no counterpart in the row's `type` enum, so it rides
      // as a label rather than being dropped.
      labels: [...new Set([req.type, ...(match?.labels ?? [])].filter(Boolean))].slice(
        0,
        MAX_LABELS,
      ),
      ...(match?.storyPoints !== undefined ? { storyPoints: match.storyPoints } : {}),
      evidenceFindingIndexes: match?.evidenceFindingIndexes ?? [],
      acceptanceCriteria: match?.acceptanceCriteria ?? [],
    };
  });

  return {
    summary:
      input.synthesis?.summary ??
      `${requirements.length} approved requirement(s) promoted from the approval checkpoint.`,
    requirements,
  };
}
