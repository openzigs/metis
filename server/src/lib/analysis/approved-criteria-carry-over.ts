/**
 * Issue #1389 — a re-synthesis must not silently take content away from an
 * approved requirement.
 *
 * A Regenerate (or resume) re-runs synthesis and REPLACES the analysis's
 * requirement set (#57): every row is hard-deleted and re-created from the new
 * synthesis output. On the approval-checkpoint path the title, body and
 * priority come from the approved STRUCTURED requirement, which a regenerate
 * does not change; the acceptance criteria come from the synthesis item, which
 * it does. The model is free to answer with none: on analysis
 * `cmviuhc12000icg9kaf5jho38` it decided "Minimalist, fast, lightweight feed
 * reader" deserved no criteria, and the approved row's two criteria were gone,
 * with no version row to say they had ever existed (the new row starts at
 * version 0).
 *
 * The rule, per re-created row that the previous set promoted from the same
 * structured requirement of the same extraction run:
 *
 *   - the new synthesis gave **no** criteria → keep the approved ones, and say so
 *     in the row's history ({@link KEPT_APPROVED_CRITERIA_REASON});
 *   - it gave **different** criteria → take them, but write the row with the
 *     approved criteria first and move to the new ones through the history
 *     writer ({@link REVISED_APPROVED_CRITERIA_REASON}), so what was dropped is
 *     one Restore away instead of nowhere;
 *   - it gave the **same** criteria, or there was no earlier row → nothing to record.
 *
 * Pure: no database access. The writer is `replaceRequirementSet`.
 */
import { parseAcceptanceCriteria } from "@metis/shared";

/** History reason when the approved criteria were kept over an empty re-synthesis. */
export const KEPT_APPROVED_CRITERIA_REASON =
  "Re-synthesis returned no acceptance criteria; the approved criteria were kept";

/** History reason when re-synthesis replaced the approved criteria with others. */
export const REVISED_APPROVED_CRITERIA_REASON =
  "Re-synthesis revised the approved acceptance criteria";

/** How a re-created row is written: inserted with `initial`, then moved to `final` with history. */
export interface CriteriaCarryOver {
  /** The criteria the row is inserted with. */
  initial: string[];
  /** The criteria the row ends with; equal to `initial` when there is nothing to record. */
  final: string[];
  /** The version reason for the `initial` → `final` write, or null when there is none. */
  reason: string | null;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Decide how a re-created row's criteria are written.
 *
 * @param approved the stored `acceptanceCriteria` JSON of the row this one
 *   replaces, or null when the previous set had no row for this structured
 *   requirement (a first promotion, another extraction run, or a row promoted
 *   before #1202 recorded its pairing).
 * @param fresh the criteria the new synthesis gave this requirement.
 */
export function planCriteriaCarryOver(
  approved: string | null,
  fresh: readonly string[],
): CriteriaCarryOver {
  const next = [...fresh];
  const kept = approved === null ? [] : parseAcceptanceCriteria(approved);
  if (kept.length === 0 || sameList(kept, next)) {
    return { initial: next, final: next, reason: null };
  }
  if (next.length === 0) {
    return { initial: [], final: kept, reason: KEPT_APPROVED_CRITERIA_REASON };
  }
  return { initial: kept, final: next, reason: REVISED_APPROVED_CRITERIA_REASON };
}
