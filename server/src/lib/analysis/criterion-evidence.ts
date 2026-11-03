/**
 * Issue #1610 — merging per-criterion evidence (`criterionEvidence`).
 *
 * Shared by the two places that fold several requirements' evidence into one:
 * synthesis's same-title merge and the approval checkpoint's join of several
 * items naming one approved requirement (#1636). Both must leave the result
 * inside `synthesizedRequirementSchema`'s caps — a list that overflowed them
 * would be dropped whole by the schema's `.catch(undefined)` if re-validated.
 */
import type { SynthesizedRequirement } from "@metis/shared";

export type CriterionEvidence = NonNullable<SynthesizedRequirement["criterionEvidence"]>;

/** `synthesizedRequirementSchema`'s caps: 50 indexes per criterion, 20 criteria. */
const MAX_EVIDENCE = 50;
const MAX_CRITERIA = 20;

/**
 * Unite `criterionEvidence` lists by criterion text, keeping only indexes in
 * `allowed` (the requirement's own evidence) and, when given, only the criteria
 * the requirement still has. Each criterion appears once, its indexes deduped
 * and capped, and the list is capped at the schema's criterion count.
 * `undefined` when nothing is left.
 */
export function mergeCriterionEvidence(
  lists: readonly CriterionEvidence[],
  allowed: ReadonlySet<number>,
  criteria?: readonly string[],
): CriterionEvidence | undefined {
  const keep = criteria ? new Set(criteria.map((c) => c.trim())) : null;
  const byCriterion = new Map<string, number[]>();
  for (const e of lists.flat()) {
    const key = e.criterion.trim();
    if (keep && !keep.has(key)) continue;
    const list = byCriterion.get(key) ?? [];
    for (const i of e.evidenceFindingIndexes) {
      if (allowed.has(i) && !list.includes(i)) list.push(i);
    }
    byCriterion.set(key, list);
  }
  const out = [...byCriterion].map(([criterion, ix]) => ({
    criterion,
    evidenceFindingIndexes: ix.slice(0, MAX_EVIDENCE),
  }));
  return out.length > 0 ? out.slice(0, MAX_CRITERIA) : undefined;
}
