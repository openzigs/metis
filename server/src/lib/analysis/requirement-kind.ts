/**
 * Issue #1612 — a requirement's KIND (functional / non-functional) and, for a
 * non-functional one, its NFR category.
 *
 * One place decides what reaches the two columns, so every writer (a fresh
 * synthesis, the post-promotion append, a withheld replacement) and the reader
 * agree:
 *
 *   - `kind` is the model's word or nothing. Absent is stored as NULL ("unknown")
 *     and never defaulted: the #1117 lesson is that the deterministic fallback
 *     cannot classify, and a default would publish its guess as a finding.
 *   - `nfrCategory` exists only beside `kind: "non-functional"`; on any other
 *     kind it is dropped, so a stored row can never say "functional, category
 *     performance".
 *
 * Pure; reads tolerate anything (a hand-edited or future value reads as NULL).
 */
import {
  NFR_CATEGORIES,
  REQUIREMENT_KINDS,
  type NfrCategory,
  type RequirementKind,
} from "@metis/shared";

/** The two columns as a writer stores them. */
export interface RequirementKindColumns {
  kind: RequirementKind | null;
  nfrCategory: NfrCategory | null;
}

/** A stored or model value read as a kind; anything else is unknown (null). */
export function coerceRequirementKind(value: unknown): RequirementKind | null {
  return REQUIREMENT_KINDS.includes(value as RequirementKind) ? (value as RequirementKind) : null;
}

/**
 * A stored or model value read as an NFR category — only when `kind` is
 * `non-functional`. Any other kind, or an unknown category, reads as null.
 */
export function coerceNfrCategory(
  value: unknown,
  kind: RequirementKind | null,
): NfrCategory | null {
  if (kind !== "non-functional") return null;
  return NFR_CATEGORIES.includes(value as NfrCategory) ? (value as NfrCategory) : null;
}

/** The columns to write for a synthesized (or reviewed) requirement. */
export function requirementKindColumns(r: {
  kind?: unknown;
  nfrCategory?: unknown;
}): RequirementKindColumns {
  const kind = coerceRequirementKind(r.kind);
  return { kind, nfrCategory: coerceNfrCategory(r.nfrCategory, kind) };
}
