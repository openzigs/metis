/**
 * Issue #1204 — turn the join's refusals into the record promotion stores in
 * `Analysis.metadata.promotionMatching`, keyed by the persisted rows.
 *
 * Pure: the refusals come from {@link planApprovedRequirementSet}, which reads
 * them off the shared one-to-one matcher; nothing is re-matched here.
 */
import { readSharedCriteriaRecords, type SharedCriteriaRecord } from "@metis/shared";
import type { AmbiguousPromotionMatch, SharedPromotionMatch } from "./approved-requirement-set.js";
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

/**
 * Issue #1204 review — drop every option that is a synthesis item in `given`
 * (one an existing row already carries), and any refusal left with no option.
 * An append re-plans over the enlarged approved set, so a new row can be
 * refused among items the first promotion gave an existing row; listing those
 * would invite copying another requirement's criteria onto it.
 */
export function withoutGivenItems(
  ambiguous: readonly AmbiguousPromotionMatch[],
  given: ReadonlySet<number>,
): AmbiguousPromotionMatch[] {
  const out: AmbiguousPromotionMatch[] = [];
  for (const a of ambiguous) {
    const keep = a.synthesizedIndexes.flatMap((idx, k) => (given.has(idx) ? [] : [k]));
    if (keep.length === 0) continue;
    out.push({
      ...a,
      candidates: keep.map((k) => a.candidates[k]!),
      synthesizedIndexes: keep.map((k) => a.synthesizedIndexes[k]!),
    });
  }
  return out;
}

/**
 * Issue #1203 — key each requirement whose criteria were shared by the row it
 * became, and each sibling by its row when it has one.
 *
 * `rowIdByApprovedIndex` is aligned as for {@link ambiguousPromotionRecords}:
 * an entry whose requirement is not written here is left out. A sibling that is
 * not written here either is looked up in `rowByStructuredId` (the rows an
 * earlier promotion of the same set recorded), else it has no row.
 *
 * An append onto a set promoted before #1203 has no earlier `shared` record, so
 * a sibling from that promotion is named (by its reviewed title) without a row
 * or link. That is deliberate: do not "fix" it with a lookup of the rows by
 * title — titles are not unique, and guessing a row is what #1204 removed.
 */
export function sharedCriteriaRecords(
  shared: readonly SharedPromotionMatch[],
  rowIdByApprovedIndex: ReadonlyArray<string | undefined>,
  rowByStructuredId: ReadonlyMap<string, string> = new Map(),
): SharedCriteriaRecord[] {
  const records: SharedCriteriaRecord[] = [];
  for (const s of shared) {
    const requirementId = rowIdByApprovedIndex[s.approvedIndex];
    if (requirementId === undefined) continue;
    records.push({
      requirementId,
      structuredId: s.structuredId,
      sharedWith: s.sharedWith.map((sib) => ({
        structuredId: sib.structuredId,
        title: sib.title,
        requirementId:
          (sib.approvedIndex !== null ? rowIdByApprovedIndex[sib.approvedIndex] : undefined) ??
          rowByStructuredId.get(sib.structuredId) ??
          null,
        // #1255 — a sibling found only in `rowByStructuredId` would read false
        // here, but none can be: its row was promoted from an approval, an
        // approval is final once `approved` (only `pending` is decided, only
        // `rejected` reopens), and an append runs within the same extraction
        // run, so that sibling is in the approved set and has an index.
        approved: sib.approvedIndex !== null,
      })),
      sharedCriteria: s.sharedCriteria,
      promotedCriteria: s.promotedCriteria,
    });
  }
  return records;
}

/** The record for a freshly written set; `[]` clears an earlier set's. */
export function promotionMatchingRecord(
  ambiguous: AmbiguousPromotionRecord[],
  shared: SharedCriteriaRecord[] = [],
  now: Date = new Date(),
): PromotionMatchingRecord {
  return { ambiguousCount: ambiguous.length, ambiguous, shared, updatedAt: now.toISOString() };
}

/**
 * Issue #1203 — the rows an earlier promotion recorded, by structured id, so an
 * append can link its rows to siblings promoted before it.
 */
export function sharedRowsByStructuredId(
  existing: PromotionMatchingRecord | null,
): Map<string, string> {
  const rows = new Map<string, string>();
  for (const r of existing?.shared ?? []) {
    rows.set(r.structuredId, r.requirementId);
    for (const sib of r.sharedWith) {
      if (sib.requirementId) rows.set(sib.structuredId, sib.requirementId);
    }
  }
  return rows;
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
    shared: readSharedCriteriaRecords(raw),
    updatedAt: typeof updatedAt === "string" ? updatedAt : new Date(0).toISOString(),
  };
}

/**
 * An append (#723) adds rows to a set already promoted: keep the earlier
 * entries and add the new rows' ones.
 *
 * #1203 — an earlier row's note already names a sibling that was not approved
 * then (its criteria were shared with it all along); when that sibling is the
 * row appended now, the earlier note gains the link to it.
 */
export function appendPromotionMatching(
  existing: PromotionMatchingRecord | null,
  added: {
    ambiguous: AmbiguousPromotionRecord[];
    shared?: SharedCriteriaRecord[];
    /** The rows this append wrote, by structured id. */
    rowsByStructuredId?: ReadonlyMap<string, string>;
  },
  now: Date = new Date(),
): PromotionMatchingRecord {
  const seen = new Set(added.ambiguous.map((a) => a.requirementId));
  const kept = (existing?.ambiguous ?? []).filter((a) => !seen.has(a.requirementId));
  const addedShared = added.shared ?? [];
  const newRows = added.rowsByStructuredId ?? new Map<string, string>();
  const seenShared = new Set(addedShared.map((r) => r.requirementId));
  const keptShared = (existing?.shared ?? [])
    .filter((r) => !seenShared.has(r.requirementId))
    .map((r) => ({
      ...r,
      sharedWith: r.sharedWith.map((sib) => {
        const row = sib.requirementId ?? newRows.get(sib.structuredId) ?? null;
        return row === sib.requirementId ? sib : { ...sib, requirementId: row, approved: true };
      }),
    }));
  return promotionMatchingRecord(
    [...kept, ...added.ambiguous],
    [...keptShared, ...addedShared],
    now,
  );
}
