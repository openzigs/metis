/**
 * Epic #708 / #800 / #804 — the types and marker constant the generic finding
 * publisher (`./finding-publisher.ts`) is written against. Deep Dive analysis
 * findings and Impact Analysis runs both publish through that engine.
 */

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Publisher = "github" | "jira";

/**
 * Marker injected into published issue bodies for idempotency lookups. The
 * value must stay `metis-finding`: issues already published carry it, and the
 * engine dedups against them by parsing it back out.
 */
export const FINDING_MARKER_PREFIX = "metis-finding";

/**
 * #802 / epic #799 decision 1 — every METIS-published issue carries the
 * umbrella label plus exactly one source label naming where it came from.
 */
export const UMBRELLA_LABEL = "metis";

/** The source labels a caller may publish under. */
export const SOURCE_LABELS = ["metis-analysis", "metis-impact-analysis"] as const;
export type SourceLabel = (typeof SOURCE_LABELS)[number];

/**
 * #804 — the retired bug scanner's source label. Nothing publishes under it
 * any more, but issues filed before the removal carry it, so it stays reserved:
 * a suggested or extra label cannot make a new issue look like scanner output.
 */
export const RETIRED_SOURCE_LABELS = ["metis-scanner"] as const;
