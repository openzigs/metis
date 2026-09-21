/**
 * Requirement-to-requirement typed links — Epic #610 (#623).
 *
 * Shared, transport-neutral vocabulary for the `RequirementLink` model: the set
 * of allowed link types and a runtime type guard. The relational model that
 * backs these lives in `server/prisma/schema.prisma` (`requirement_links`); the
 * service + API that consume this enum land in #624.
 *
 * A link is DIRECTIONAL (source → target) and allowed across projects within
 * the SAME workspace (same-workspace invariant enforced in the API sub-issue,
 * #624). Self-links (source === target) are never valid.
 */

/**
 * Allowed link types between two requirements.
 *
 * - `relates_to`  — a loose, undirected-in-meaning association.
 * - `duplicates`  — source is a duplicate of target.
 * - `depends_on`  — source depends on target (target must land first).
 * - `derived_from`— source was derived/decomposed from target.
 */
export const REQUIREMENT_LINK_TYPES = [
  "relates_to",
  "duplicates",
  "depends_on",
  "derived_from",
] as const;

/** Union of the allowed {@link REQUIREMENT_LINK_TYPES}. */
export type RequirementLinkType = (typeof REQUIREMENT_LINK_TYPES)[number];

/** Runtime guard: is `value` one of the allowed {@link RequirementLinkType}s? */
export function isRequirementLinkType(value: unknown): value is RequirementLinkType {
  return typeof value === "string" && (REQUIREMENT_LINK_TYPES as readonly string[]).includes(value);
}

/**
 * Whether a proposed link is a self-link (source === target). Self-links are
 * always rejected — a requirement cannot be typed-linked to itself. This is the
 * pure predicate the service layer (#624) uses to reject before touching the DB.
 */
export function isSelfLink(sourceRequirementId: string, targetRequirementId: string): boolean {
  return sourceRequirementId === targetRequirementId;
}
