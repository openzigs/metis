/**
 * #335 — human-readable report for the hybrid A/B rollout gate.
 *
 * Pure string builder (no console/IO) so the table is unit-testable. The CLI
 * prints this and separately emits {@link AbEvalResult} as JSON.
 */
import { TIERS } from "./aggregate.js";
import type { AbEvalResult, ArmAggregate, FaithfulnessAggregate } from "./types.js";

function pct(n: number | null): string {
  return n == null ? "  n/a" : `${(n * 100).toFixed(1)}%`;
}

function signedPct(n: number | null): string {
  if (n == null) return "  n/a";
  const s = (n * 100).toFixed(1);
  return n >= 0 ? `+${s}%` : `${s}%`;
}

function meanCell(agg: FaithfulnessAggregate): string {
  if (agg.mean == null) return `n/a (${agg.unverifiedCount} unverified)`;
  return `${pct(agg.mean)} (n=${agg.verifiedCount})`;
}

function armColumn(arm: ArmAggregate): string {
  const lines = [
    `  overall:       ${meanCell(arm.overall)}`,
    ...TIERS.map((t) => `  ${t.padEnd(14)} ${meanCell(arm.byTier[t])}`),
    `  escalation:    ${pct(arm.escalationRate)}`,
    `  local tokens:  ${arm.localTokens}`,
    `  cloud tokens:  ${arm.cloudTokens}`,
    `  cost proxy:    ${arm.costProxy}`,
  ];
  return lines.join("\n");
}

/** Render the full A/B comparison + gate verdict as a plain-text report. */
export function renderAbReport(result: AbEvalResult): string {
  const { baseline, candidate } = result.arms;
  const lines: string[] = [];
  lines.push("=".repeat(72));
  lines.push("Hybrid A/B rollout gate — local+escalation vs all-Sonnet (#335)");
  lines.push("=".repeat(72));
  lines.push(`items=${result.itemCount}  sections=${result.sectionCount}`);
  lines.push("");
  lines.push("Arm A — all-Sonnet (baseline):");
  lines.push(armColumn(baseline));
  lines.push("");
  lines.push("Arm B — local+escalation (candidate):");
  lines.push(armColumn(candidate));
  lines.push("");
  lines.push("Deltas (candidate − baseline):");
  lines.push(`  overall:       ${signedPct(result.deltas.overall)}`);
  for (const t of TIERS) {
    lines.push(`  ${t.padEnd(14)} ${signedPct(result.deltas.byTier[t])}`);
  }
  lines.push(`  cost reduction ${signedPct(result.deltas.costReduction)}`);
  lines.push("");
  lines.push("Gate criteria:");
  for (const c of result.verdict.checks) {
    lines.push(`  [${c.passed ? "PASS" : "FAIL"}] ${c.label}`);
    lines.push(`         ${c.detail}`);
  }
  lines.push("");
  lines.push("-".repeat(72));
  lines.push(
    `VERDICT: ${result.verdict.passed ? "PASS — rollout gate met" : "FAIL — do NOT flip defaults"}`,
  );
  lines.push("-".repeat(72));
  return lines.join("\n");
}
