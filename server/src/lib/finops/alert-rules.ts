/**
 * Pure alert-rule evaluation logic (Epic #47 / Issue #49).
 *
 * Separated from the DB-bound engine so the threshold + cooldown + idempotency
 * math is trivially unit-testable. A rule fires when:
 *
 *   1. it is enabled, AND
 *   2. the relevant spend figure (MTD or projected, per `basis`) reaches the
 *      configured percentage of the workspace budget, AND
 *   3. it is outside its cooldown window (now - lastFiredAt >= cooldownSec).
 *
 * Idempotency: because firing advances `lastFiredAt`, re-running the tick
 * within the cooldown window is a no-op — the same threshold cannot re-fire.
 */

export interface AlertRuleState {
  id: string;
  name: string;
  thresholdPct: number;
  basis: string; // "mtd" | "projected"
  cooldownSec: number;
  enabled: boolean;
  lastFiredAt: Date | null;
}

export interface SpendSnapshot {
  /** Workspace monthly budget in cents (null = no budget configured). */
  budgetCents: number | null;
  /** Month-to-date actual spend in cents. */
  monthToDateCents: number;
  /** Projected month-end spend in cents. */
  projectedMonthEndCents: number;
}

export interface RuleEvaluation {
  ruleId: string;
  shouldFire: boolean;
  /** Spend figure used (cents) per the rule basis. */
  spendCents: number;
  budgetCents: number;
  /** spend/budget ratio (fraction). */
  ratio: number;
  basis: string;
  /** Human-readable reason a rule did NOT fire (for diagnostics). */
  skipReason?: "disabled" | "no-budget" | "below-threshold" | "cooldown";
}

function spendForBasis(snapshot: SpendSnapshot, basis: string): number {
  return basis === "mtd" ? snapshot.monthToDateCents : snapshot.projectedMonthEndCents;
}

/**
 * Evaluate a single rule against a spend snapshot at time `now`.
 */
export function evaluateRule(
  rule: AlertRuleState,
  snapshot: SpendSnapshot,
  now: Date = new Date(),
): RuleEvaluation {
  const spendCents = spendForBasis(snapshot, rule.basis);
  const budgetCents = snapshot.budgetCents ?? 0;
  const ratio = budgetCents > 0 ? spendCents / budgetCents : 0;
  const base: RuleEvaluation = {
    ruleId: rule.id,
    shouldFire: false,
    spendCents,
    budgetCents,
    ratio,
    basis: rule.basis,
  };

  if (!rule.enabled) return { ...base, skipReason: "disabled" };
  if (snapshot.budgetCents == null || snapshot.budgetCents <= 0) {
    return { ...base, skipReason: "no-budget" };
  }
  if (ratio * 100 < rule.thresholdPct) {
    return { ...base, skipReason: "below-threshold" };
  }
  if (rule.lastFiredAt) {
    const elapsedSec = (now.getTime() - rule.lastFiredAt.getTime()) / 1000;
    if (elapsedSec < rule.cooldownSec) {
      return { ...base, skipReason: "cooldown" };
    }
  }
  return { ...base, shouldFire: true };
}

/**
 * Evaluate every rule for a workspace and return only those that should fire.
 */
export function evaluateRules(
  rules: AlertRuleState[],
  snapshot: SpendSnapshot,
  now: Date = new Date(),
): RuleEvaluation[] {
  return rules.map((r) => evaluateRule(r, snapshot, now)).filter((e) => e.shouldFire);
}

/** The three built-in budget threshold presets (percent of monthly budget). */
export const BUILTIN_THRESHOLDS = [50, 80, 100] as const;
