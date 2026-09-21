/**
 * Requirement escalation policy — pure scoring + routing (Issue #739, Epic #727).
 *
 * Today an agentic analysis run spends the SAME loop budget/turn cap on every
 * requirement, regardless of how hard each one is. This module scores each
 * extracted requirement for **ambiguity** and **impact** and routes only the
 * high scorers to a DEEPER multi-hop pass (a higher turn cap), keeping cheap
 * requirements cheap. It is a cost/quality lever.
 *
 * Everything here is PURE and LLM-FREE, so the same inputs always yield the same
 * decision and the whole policy is trivially unit-testable:
 *
 *   - **Ambiguity** is a deterministic requirement-text heuristic — vagueness
 *     markers ("appropriately", "as needed", "etc") and cross-cutting keywords
 *     ("all", "every", "system-wide") plus a brevity bump for under-specified
 *     one-liners. We deliberately do NOT reuse the LLM-based clarify/ambiguity-
 *     grounding pipeline (`ambiguity-grounding.ts`): that runs a retrieval + a
 *     completion per question and needs clarifying questions to already exist,
 *     whereas the routing decision must be made cheaply and BEFORE the agentic
 *     pass runs. B3's `no_evidence` coverage would be a good ambiguity signal but
 *     is only known at synthesis time (after the code agent runs), so it cannot
 *     feed a pre-pass routing decision either.
 *
 *   - **Impact** reuses B2's blast-radius (#726/#735): the number of code symbols
 *     a requirement maps to (direct mapper hits + transitive blast radius). A
 *     bigger blast radius ⇒ a broader, riskier change ⇒ more impact. The raw size
 *     is normalised against a saturation constant.
 *
 * The combined score is a weighted sum of the two sub-scores (both 0–1), so it is
 * itself 0–1. A requirement escalates when its score `>= threshold` AND it is
 * within the per-run escalation cap (top-N by score) — the cap bounds how much of
 * the shared token budget can be diverted to deep passes (see
 * {@link splitEscalationBudget}).
 */
import type { AnalysisDepth, RequirementEscalation } from "@metis/shared";

/** Weight of the ambiguity sub-score in the combined score. */
export const AMBIGUITY_WEIGHT = 0.5;
/** Weight of the impact sub-score in the combined score. */
export const IMPACT_WEIGHT = 0.5;

/** Blast-radius size at which the impact sub-score saturates to 1.0. */
export const DEFAULT_IMPACT_SATURATION = 8;
/** Combined-score threshold at/above which a requirement is eligible for deep routing. */
export const DEFAULT_ESCALATION_THRESHOLD = 0.5;
/** Max requirements escalated to a deep pass per run (bounds diverted budget). */
export const DEFAULT_MAX_ESCALATIONS = 3;
/** Turn cap for a standard (non-escalated) agentic pass — matches today's default. */
export const DEFAULT_STANDARD_MAX_TURNS = 10;
/** Turn cap for a deep (escalated) agentic pass — the "multi-hop" depth. */
export const DEFAULT_DEEP_MAX_TURNS = 16;

/** Number of vagueness/cross-cutting markers at which the marker component saturates. */
const MARKER_SATURATION = 3;
/** Max chars of requirement text retained on the persisted decision (display only). */
const MAX_TEXT_LEN = 280;

/**
 * Vagueness markers — words/phrases that signal an under-specified requirement.
 * Lower-cased; single words are matched on word boundaries, phrases as substrings.
 */
const VAGUENESS_MARKERS = [
  "etc",
  "and so on",
  "appropriate",
  "appropriately",
  "reasonable",
  "reasonably",
  "as needed",
  "as appropriate",
  "as required",
  "if possible",
  "where possible",
  "and/or",
  "handle",
  "support",
  "flexible",
  "robust",
  "user-friendly",
  "user friendly",
  "fast",
  "scalable",
  "efficient",
  "seamless",
  "seamlessly",
  "intuitive",
  "some",
  "several",
  "various",
  "tbd",
  "somehow",
  "maybe",
  "better",
  "improve",
  "optimize",
  "simple",
  "easy",
] as const;

/**
 * Cross-cutting keywords — words that signal a broad, system-wide requirement
 * (which is both harder to pin down and higher impact).
 */
const CROSS_CUTTING_MARKERS = [
  "all",
  "every",
  "everything",
  "everywhere",
  "across",
  "globally",
  "global",
  "system-wide",
  "system wide",
  "throughout",
  "entire",
  "each",
  "any",
  "anywhere",
  "end-to-end",
  "end to end",
] as const;

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Deterministic input to the pure scorer for one requirement. */
export interface RequirementEscalationInput {
  id: string;
  text: string;
  /** Blast-radius size (# code symbols mapped): the raw impact signal. */
  blastRadiusSize: number;
}

/** The three sub-scores produced for one requirement. */
export interface EscalationScore {
  ambiguityScore: number;
  impactScore: number;
  score: number;
}

/** Tunable policy configuration (defaults mirror the exported constants). */
export interface EscalationPolicyConfig {
  threshold: number;
  maxEscalations: number;
  standardMaxTurns: number;
  deepMaxTurns: number;
  impactSaturation: number;
}

/** The default policy configuration. */
export const DEFAULT_ESCALATION_POLICY: EscalationPolicyConfig = {
  threshold: DEFAULT_ESCALATION_THRESHOLD,
  maxEscalations: DEFAULT_MAX_ESCALATIONS,
  standardMaxTurns: DEFAULT_STANDARD_MAX_TURNS,
  deepMaxTurns: DEFAULT_DEEP_MAX_TURNS,
  impactSaturation: DEFAULT_IMPACT_SATURATION,
};

/**
 * Count how many of `markers` occur in `text`. Single-word markers are matched
 * against `words` (a Set of the text's word tokens) so a marker only counts as a
 * whole word — "install" must NOT match "all", "everything" must NOT match
 * "every". Multi-word / punctuated markers (containing a space, `/`, or `-`) are
 * matched as a plain substring of the normalised `text`. No dynamic `RegExp` is
 * built (avoids the ReDoS foot-gun), and every marker counts at most once.
 */
function countMarkers(
  text: string,
  words: ReadonlySet<string>,
  markers: readonly string[],
): number {
  let hits = 0;
  for (const marker of markers) {
    const isPhrase = marker.includes(" ") || marker.includes("/") || marker.includes("-");
    if (isPhrase ? text.includes(marker) : words.has(marker)) hits += 1;
  }
  return hits;
}

/**
 * Deterministic ambiguity sub-score (0–1) from requirement text. Combines a
 * marker density component (vagueness + cross-cutting keyword hits, saturating at
 * {@link MARKER_SATURATION}) with a brevity component (very short requirements are
 * usually under-specified). Empty/whitespace text scores 0.
 */
export function scoreAmbiguity(text: string): number {
  const normalized = text.toLowerCase();
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;

  // Word tokens (literal split — no dynamic regex) for whole-word marker matching.
  const words = new Set(normalized.split(/[^a-z0-9]+/u).filter(Boolean));
  const markerHits =
    countMarkers(normalized, words, VAGUENESS_MARKERS) +
    countMarkers(normalized, words, CROSS_CUTTING_MARKERS);
  const markerComponent = clamp01(markerHits / MARKER_SATURATION);

  const wordCount = trimmed.split(/\s+/u).length;
  const brevityComponent = wordCount <= 4 ? 1 : wordCount <= 8 ? 0.5 : 0;

  return clamp01(0.75 * markerComponent + 0.25 * brevityComponent);
}

/**
 * Deterministic impact sub-score (0–1) from the blast-radius size. Linear up to
 * `saturation` symbols, then clamped to 1.0. A negative/NaN size scores 0.
 */
export function scoreImpact(
  blastRadiusSize: number,
  saturation: number = DEFAULT_IMPACT_SATURATION,
): number {
  if (!Number.isFinite(blastRadiusSize) || blastRadiusSize <= 0) return 0;
  const denom = saturation > 0 ? saturation : DEFAULT_IMPACT_SATURATION;
  return clamp01(blastRadiusSize / denom);
}

/**
 * Score one requirement: ambiguity (text heuristics) + impact (blast-radius
 * size), combined as a weighted sum. Pure.
 */
export function scoreRequirementEscalation(
  input: RequirementEscalationInput,
  config: EscalationPolicyConfig = DEFAULT_ESCALATION_POLICY,
): EscalationScore {
  const ambiguityScore = scoreAmbiguity(input.text);
  const impactScore = scoreImpact(input.blastRadiusSize, config.impactSaturation);
  const score = clamp01(AMBIGUITY_WEIGHT * ambiguityScore + IMPACT_WEIGHT * impactScore);
  return { ambiguityScore, impactScore, score };
}

function truncateText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_TEXT_LEN ? trimmed : `${trimmed.slice(0, MAX_TEXT_LEN - 1)}…`;
}

/**
 * Score every requirement and decide which get the deep pass. A requirement is
 * routed `deep` when its score `>= threshold` AND it is within the top
 * `maxEscalations` scorers (deterministic tie-break: score desc, then id asc).
 * Everything else is `standard`.
 *
 * The returned list is sorted most-escalated first (deep before standard, then by
 * score desc, then id asc) so the persisted record + UI render in priority order.
 */
export function decideEscalations(
  inputs: RequirementEscalationInput[],
  config: EscalationPolicyConfig = DEFAULT_ESCALATION_POLICY,
): RequirementEscalation[] {
  const scored = inputs.map((input) => {
    const { ambiguityScore, impactScore, score } = scoreRequirementEscalation(input, config);
    return { input, ambiguityScore, impactScore, score };
  });

  // Rank eligible requirements (score >= threshold) and take the top-N as deep.
  const eligibleRanked = scored
    .filter((s) => s.score >= config.threshold)
    .sort((a, b) => b.score - a.score || (a.input.id < b.input.id ? -1 : 1));
  const deepIds = new Set(
    eligibleRanked.slice(0, Math.max(0, config.maxEscalations)).map((s) => s.input.id),
  );

  const decisions: RequirementEscalation[] = scored.map((s) => ({
    requirementId: s.input.id,
    text: truncateText(s.input.text),
    ambiguityScore: s.ambiguityScore,
    impactScore: s.impactScore,
    score: s.score,
    blastRadiusSize: Math.max(0, Math.floor(s.input.blastRadiusSize) || 0),
    depth: (deepIds.has(s.input.id) ? "deep" : "standard") as AnalysisDepth,
  }));

  return decisions.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth === "deep" ? -1 : 1;
    return b.score - a.score || (a.requirementId < b.requirementId ? -1 : 1);
  });
}

/**
 * Split an agentic run's token budget between the deep and standard passes,
 * proportional to how many requirements each pass carries. The two shares ALWAYS
 * sum EXACTLY to `effectiveBudget`, so escalation NEVER grows the overall token
 * budget — it only reallocates within it. When one side is empty the whole
 * budget goes to the other (a single pass).
 *
 * Turns — not tokens — are the depth lever: a deep pass gets a higher turn cap
 * but still stops at its token share, so more turns can never blow the ceiling.
 */
export function splitEscalationBudget(
  effectiveBudget: number,
  deepCount: number,
  standardCount: number,
): { deepBudget: number; standardBudget: number } {
  const budget = Math.max(0, Math.floor(effectiveBudget));
  if (deepCount <= 0) return { deepBudget: 0, standardBudget: budget };
  if (standardCount <= 0) return { deepBudget: budget, standardBudget: 0 };
  const total = deepCount + standardCount;
  const deepBudget = Math.floor((budget * deepCount) / total);
  return { deepBudget, standardBudget: budget - deepBudget };
}
