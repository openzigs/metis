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
/** `synthesizedRequirementSchema` caps evidence at 50 and criteria at 20. */
const MAX_EVIDENCE = 50;
const MAX_CRITERIA = 20;

/**
 * The synthesized requirement each approved structured requirement draws its
 * criteria and evidence from.
 *
 * Issue #1033 — by id first. Synthesis names the structured requirements each
 * of its items restates (`structuredIds`). An item may consolidate several of
 * them, and then EVERY requirement it names receives its criteria and evidence:
 * joining on title alone gave such an item to the best-matching requirement and
 * left the others promoted with no criteria and no code link (#706 runs 6, 9).
 * The criteria are not split between them — on the run-6 text no word-overlap
 * score put each criterion on its own requirement, and a wrong criterion reads
 * as authored where a shared one is at least the model's own grouping. Several
 * items naming one requirement are joined into one. An item that names an id
 * of this list belongs to that id alone, even when it names only a rejected or
 * pending requirement, so it is never lent to another by title.
 *
 * The title join is the fallback, for a requirement no item names and over the
 * items that name no id of the list (output from before #1033, a degraded run,
 * a list re-extracted since): one-to-one, best score first, so a guess never
 * puts the same evidence on two rows. `structured` is the whole reviewed list,
 * whose ids are the ones an item can name; it defaults to `approved`.
 *
 * Issue #1129 — exported so the ticked/added split reads the same #1063
 * `sourceIds` this join carries onto the promoted row (and so onto the
 * "Added by the analysis" badge), rather than guessing from words.
 */
export function matchSynthesized(
  approved: ReadonlyArray<Pick<StructuredRequirement, "id" | "title">>,
  synthesized: readonly SynthesizedRequirement[],
  structured: ReadonlyArray<Pick<StructuredRequirement, "id">> = approved,
): Map<string, SynthesizedRequirement> {
  const listIds = new Set(structured.map((r) => r.id));
  const namesListId = synthesized.map((s) => (s.structuredIds ?? []).some((id) => listIds.has(id)));

  const byStructuredId = new Map<string, SynthesizedRequirement>();
  for (const req of approved) {
    const named = synthesized.filter((s) => s.structuredIds?.includes(req.id));
    if (named.length > 0) byStructuredId.set(req.id, joinItems(named));
  }

  const synthTokens = synthesized.map((s) => significantTokens(`${s.title} ${s.body}`));
  const candidates: Array<{ structuredId: string; synthIdx: number; score: number }> = [];
  for (const req of approved) {
    if (byStructuredId.has(req.id)) continue;
    const needle = significantTokens(req.title);
    synthTokens.forEach((tokens, synthIdx) => {
      if (namesListId[synthIdx]) return;
      const score = containmentScore(needle, tokens);
      if (score >= ATTRIBUTION_THRESHOLD) {
        candidates.push({ structuredId: req.id, synthIdx, score });
      }
    });
  }
  candidates.sort((a, b) => b.score - a.score);

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

/** Several items naming one requirement, joined: lists united in order, scalars from the first. */
function joinItems(parts: readonly SynthesizedRequirement[]): SynthesizedRequirement {
  const first = parts[0]!;
  if (parts.length === 1) return first;
  const unite = <T>(pick: (s: SynthesizedRequirement) => readonly T[] | undefined): T[] => [
    ...new Set(parts.flatMap((p) => pick(p) ?? [])),
  ];
  const sourceIds = parts.some((p) => p.sourceIds !== undefined)
    ? unite((p) => p.sourceIds)
    : undefined;
  const storyPoints = parts.find((p) => p.storyPoints !== undefined)?.storyPoints;
  return {
    ...first,
    labels: unite((p) => p.labels).slice(0, MAX_LABELS),
    evidenceFindingIndexes: unite((p) => p.evidenceFindingIndexes).slice(0, MAX_EVIDENCE),
    acceptanceCriteria: unite((p) => p.acceptanceCriteria).slice(0, MAX_CRITERIA),
    ...(storyPoints !== undefined ? { storyPoints } : {}),
    ...(sourceIds !== undefined ? { sourceIds } : {}),
  };
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
  const matches = matchSynthesized(approved, input.synthesis?.requirements ?? [], input.structured);

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
      // #1063 — which imported item it came from, when synthesis said.
      ...(match?.sourceIds !== undefined ? { sourceIds: match.sourceIds } : {}),
    };
  });

  return {
    summary:
      input.synthesis?.summary ??
      `${requirements.length} approved requirement(s) promoted from the approval checkpoint.`,
    requirements,
  };
}
