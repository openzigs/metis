/**
 * Issue #1204 — turn the join's refusals into the record promotion stores in
 * `Analysis.metadata.promotionMatching`, keyed by the persisted rows.
 *
 * Pure: the refusals come from {@link planApprovedRequirementSet}, which reads
 * them off the shared one-to-one matcher; nothing is re-matched here.
 */
import type { AmbiguousPromotionMatch } from "./approved-requirement-set.js";
import type { AmbiguousPromotionRecord, PromotionMatchingRecord } from "./types/requirements.js";

/**
 * Key each refused requirement by the row it became.
 *
 * `rowIdByApprovedIndex[i]` is the row persisted for the i-th approved
 * requirement, or `undefined` when that requirement was not persisted in this
 * write (an append writes only the new ones); a refused requirement with no row
 * here is left out.
 */
export function ambiguousPromotionRecords(
  ambiguous: readonly AmbiguousPromotionMatch[],
  rowIdByApprovedIndex: ReadonlyArray<string | undefined>,
): AmbiguousPromotionRecord[] {
  const records: AmbiguousPromotionRecord[] = [];
  for (const a of ambiguous) {
    const requirementId = rowIdByApprovedIndex[a.approvedIndex];
    if (requirementId === undefined) continue;
    records.push({ requirementId, structuredId: a.structuredId, candidates: a.candidates });
  }
  return records;
}

/** The record for a freshly written set; `[]` clears an earlier set's. */
export function promotionMatchingRecord(
  ambiguous: AmbiguousPromotionRecord[],
  now: Date = new Date(),
): PromotionMatchingRecord {
  return { ambiguousCount: ambiguous.length, ambiguous, updatedAt: now.toISOString() };
}

/**
 * Read a stored record, tolerating anything malformed (metadata is free JSON,
 * and may have been written by another build). Returns `null` when absent.
 */
export function readPromotionMatchingRecord(raw: unknown): PromotionMatchingRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const ambiguous = (raw as { ambiguous?: unknown }).ambiguous;
  if (!Array.isArray(ambiguous)) return null;
  const valid = ambiguous.filter(
    (a): a is AmbiguousPromotionRecord =>
      !!a &&
      typeof a === "object" &&
      typeof (a as AmbiguousPromotionRecord).requirementId === "string" &&
      Array.isArray((a as AmbiguousPromotionRecord).candidates),
  );
  const updatedAt = (raw as { updatedAt?: unknown }).updatedAt;
  return {
    ambiguousCount: valid.length,
    ambiguous: valid,
    updatedAt: typeof updatedAt === "string" ? updatedAt : new Date(0).toISOString(),
  };
}

/**
 * An append (#723) adds rows to a set already promoted: keep the earlier
 * entries and add the new rows' ones.
 */
export function appendPromotionMatching(
  existing: PromotionMatchingRecord | null,
  added: AmbiguousPromotionRecord[],
  now: Date = new Date(),
): PromotionMatchingRecord {
  const seen = new Set(added.map((a) => a.requirementId));
  const kept = (existing?.ambiguous ?? []).filter((a) => !seen.has(a.requirementId));
  return promotionMatchingRecord([...kept, ...added], now);
}
