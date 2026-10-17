/**
 * Issue #1203 — acceptance criteria one synthesis item wrote for several
 * requirements at once.
 *
 * Synthesis can group several reviewed requirements under one item, naming
 * them in its `structuredIds`. Since #1187 every approved requirement the item
 * names receives ALL of the item's criteria, so some of them were written for
 * a sibling. Promotion records that per row in
 * `Analysis.metadata.promotionMatching.shared`; this module is the one place
 * that reads the record and decides whether the note still applies, so the
 * requirement card, the review card and the published issue agree.
 *
 * The note applies while the requirement's criteria are still the ones it was
 * promoted with. Once the analyst has changed the list (edited, added or
 * removed a criterion) the criteria are theirs, and no surface marks them.
 * Content is compared rather than version history: a null `actorId` does not
 * mean no person, and nothing but an edit writes this column after promotion.
 */

/** One requirement the shared criteria were also given to (or written for). */
export interface SharedCriteriaSibling {
  /** The reviewed (structured) requirement id, e.g. `REQ-3`. */
  structuredId: string;
  /** Its reviewed title when promotion ran. */
  title: string;
  /** The row it became, or `null` when it has none (not approved, or unknown). */
  requirementId: string | null;
  /** It was approved when the record was written (a row with no id is then legacy). */
  approved: boolean;
}

/** Issue #1203 — one promoted requirement whose criteria were shared. */
export interface SharedCriteriaRecord {
  /** The persisted `Requirement` row id. */
  requirementId: string;
  /** The reviewed (structured) requirement id it was promoted from. */
  structuredId: string;
  /** The other requirements the same synthesis item named, in reviewed order. */
  sharedWith: SharedCriteriaSibling[];
  /** The criteria that came from an item naming a sibling. */
  sharedCriteria: string[];
  /** Every criterion the row was promoted with; a different list means edited. */
  promotedCriteria: string[];
}

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((v) => typeof v === "string");
}

function readSibling(raw: unknown): SharedCriteriaSibling | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.structuredId !== "string" || typeof s.title !== "string") return null;
  return {
    structuredId: s.structuredId,
    title: s.title,
    requirementId: typeof s.requirementId === "string" ? s.requirementId : null,
    approved: s.approved === true,
  };
}

/** Validate one stored entry; anything malformed reads as no entry. */
export function readSharedCriteriaRecord(raw: unknown): SharedCriteriaRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.requirementId !== "string" || typeof r.structuredId !== "string") return null;
  if (!Array.isArray(r.sharedWith)) return null;
  if (!isStringArray(r.sharedCriteria) || !isStringArray(r.promotedCriteria)) return null;
  const sharedWith = r.sharedWith
    .map(readSibling)
    .filter((s): s is SharedCriteriaSibling => s !== null);
  if (sharedWith.length === 0 || r.sharedCriteria.length === 0) return null;
  return {
    requirementId: r.requirementId,
    structuredId: r.structuredId,
    sharedWith,
    sharedCriteria: r.sharedCriteria,
    promotedCriteria: r.promotedCriteria,
  };
}

/** Every valid entry of `promotionMatching.shared`; `[]` for an older or malformed record. */
export function readSharedCriteriaRecords(promotionMatching: unknown): SharedCriteriaRecord[] {
  if (!promotionMatching || typeof promotionMatching !== "object") return [];
  const shared = (promotionMatching as { shared?: unknown }).shared;
  if (!Array.isArray(shared)) return [];
  return shared.map(readSharedCriteriaRecord).filter((r): r is SharedCriteriaRecord => r !== null);
}

/** The entry for one row, read from `Analysis.metadata` (an object). */
export function findSharedCriteria(
  metadata: unknown,
  requirementId: string,
): SharedCriteriaRecord | null {
  if (!metadata || typeof metadata !== "object") return null;
  const record = (metadata as { promotionMatching?: unknown }).promotionMatching;
  return readSharedCriteriaRecords(record).find((r) => r.requirementId === requirementId) ?? null;
}

const normalize = (list: readonly string[]): string[] =>
  list.map((c) => c.trim()).filter((c) => c.length > 0);

/**
 * The criteria are still exactly the ones the row was promoted with. `false`
 * once the analyst has edited, added, removed or reordered any of them.
 */
export function criteriaAsPromoted(
  record: Pick<SharedCriteriaRecord, "promotedCriteria">,
  current: readonly string[],
): boolean {
  const a = normalize(record.promotedCriteria);
  const b = normalize(current);
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

/**
 * The entry to mark the row with, given its current criteria: `null` when it
 * has none, or when the analyst has since edited the criteria.
 */
export function sharedCriteriaToMark(
  metadata: unknown,
  requirementId: string,
  current: readonly string[],
): SharedCriteriaRecord | null {
  const record = findSharedCriteria(metadata, requirementId);
  return record && criteriaAsPromoted(record, current) ? record : null;
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** How a sibling is named in a note: its title, quoted, and whether it was approved. */
export function sharedSiblingLabel(sibling: SharedCriteriaSibling, title = sibling.title): string {
  return sibling.approved || sibling.requirementId ? `“${title}”` : `“${title}” (not approved)`;
}

/** The analyst's note: what happened, and what to do about it. */
export const SHARED_CRITERIA_ANALYST_HINT =
  "the analysis wrote these acceptance criteria for the group; edit any that don't apply.";

/** The published issue's note: a developer reads it, so it says what it means for them. */
export const SHARED_CRITERIA_ISSUE_HINT =
  "the analysis wrote these acceptance criteria for the group, so some may belong to those requirements rather than this one.";

/**
 * The note for a published issue, or `null` when nothing is marked. Siblings
 * are named by their current title when `titleOf` knows the row.
 */
export function renderSharedCriteriaIssueNote(
  record: SharedCriteriaRecord,
  titleOf: (requirementId: string) => string | undefined = () => undefined,
): string {
  const names = record.sharedWith.map((s) =>
    sharedSiblingLabel(s, (s.requirementId && titleOf(s.requirementId)) || s.title),
  );
  const partial = record.sharedCriteria.length < normalize(record.promotedCriteria).length;
  const lead = partial ? "The criteria marked _(shared)_ are shared" : "Shared";
  return `> ${lead} with ${joinNames(names)}: ${SHARED_CRITERIA_ISSUE_HINT}`;
}
