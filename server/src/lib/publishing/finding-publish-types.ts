/**
 * Epic #708 / #800 — the types and marker constant the generic finding
 * publisher (`./finding-publisher.ts`) is written against. They live here, not
 * in the bug scanner's module, so that Deep Dive and Impact Analysis publishing
 * do not depend on the scanner; the scanner's `types.ts` re-uses these.
 */

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Publisher = "github" | "jira";

/**
 * Marker injected into published issue bodies for idempotency lookups. The
 * value must stay `metis-finding`: issues already published carry it, and the
 * engine dedups against them by parsing it back out.
 */
export const SCANNER_PUBLISH_MARKER_PREFIX = "metis-finding";
