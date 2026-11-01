/**
 * Epic #1608 (#1623) — how badly a downstream product is hit, from the coupling
 * the impact crosses. Pure and LLM-free; the derivation is returned with the
 * severity so a business analyst can see *why*.
 *
 * One scale for BAs: the existing `CHANGE_SEVERITIES` (critical > high > medium
 * > low).
 *
 *   base     intrusive = high, functional = high, model = medium, contract = low
 *            (an edge written before #1618 has no strength: medium, flagged)
 *   +1 step  the provider's contract changed in a breaking way (an item removed,
 *            a field or parameter removed or retyped, a required parameter
 *            added) — not on an intrusive edge: a shared-table write is already
 *            at the top of the scale, so it is not counted twice
 *   -1 step  the edge's confidence is below 0.5
 *   capped   at critical and at low
 *
 * A path of several hops is as severe as its weakest hop: a product two hops
 * away is hit no harder than the looser of the two couplings lets it be.
 */
import {
  CHANGE_SEVERITIES,
  type ChangeSeverity,
  type ProductCouplingStrength,
} from "@metis/shared";

/** The severity each coupling strength starts from. */
export const STRENGTH_BASE_SEVERITY: Record<ProductCouplingStrength, ChangeSeverity> = {
  intrusive: "high",
  functional: "high",
  model: "medium",
  contract: "low",
};

/** The base of an edge with no recorded strength (written before #1618). */
export const UNCLASSIFIED_BASE_SEVERITY: ChangeSeverity = "medium";

/** Below this an edge is a weak signal, and the severity drops one step. */
export const LOW_CONFIDENCE_THRESHOLD = 0.5;

export type SeverityModifier =
  { kind: "breaking-contract"; step: 1 } | { kind: "low-confidence"; step: -1; confidence: number };

/** One hop's severity and how it was reached. */
export interface HopSeverity {
  severity: ChangeSeverity;
  strength: ProductCouplingStrength | null;
  base: ChangeSeverity;
  modifiers: SeverityModifier[];
}

export interface HopSeverityInput {
  strength: ProductCouplingStrength | null;
  /** Whether the provider's contract changed in a breaking way on this hop. */
  breakingContract: boolean;
  confidence: number;
}

/** `severity` moved `steps` towards critical (positive) or low (negative), capped at both ends. */
export function stepSeverity(severity: ChangeSeverity, steps: number): ChangeSeverity {
  // CHANGE_SEVERITIES runs critical first, so a step up is a lower index.
  const i = CHANGE_SEVERITIES.indexOf(severity) - steps;
  return CHANGE_SEVERITIES[Math.min(CHANGE_SEVERITIES.length - 1, Math.max(0, i))];
}

/** Whether `a` is more severe than `b`. */
export function moreSevere(a: ChangeSeverity, b: ChangeSeverity): boolean {
  return CHANGE_SEVERITIES.indexOf(a) < CHANGE_SEVERITIES.indexOf(b);
}

/** The less severe of two. */
export function weaker(a: ChangeSeverity, b: ChangeSeverity): ChangeSeverity {
  return moreSevere(a, b) ? b : a;
}

/** One hop's severity from the coupling it crosses. */
export function deriveHopSeverity(input: HopSeverityInput): HopSeverity {
  const base =
    input.strength === null ? UNCLASSIFIED_BASE_SEVERITY : STRENGTH_BASE_SEVERITY[input.strength];
  const modifiers: SeverityModifier[] = [];
  if (input.breakingContract && input.strength !== "intrusive") {
    modifiers.push({ kind: "breaking-contract", step: 1 });
  }
  if (input.confidence < LOW_CONFIDENCE_THRESHOLD) {
    modifiers.push({ kind: "low-confidence", step: -1, confidence: input.confidence });
  }
  const severity = stepSeverity(
    base,
    modifiers.reduce((sum, m) => sum + m.step, 0),
  );
  return { severity, strength: input.strength, base, modifiers };
}

/** A path's severity: its weakest hop. Null for no hops (a direct change). */
export function pathSeverity(hops: readonly { severity: ChangeSeverity }[]): ChangeSeverity | null {
  if (hops.length === 0) return null;
  return hops.map((h) => h.severity).reduce(weaker);
}
