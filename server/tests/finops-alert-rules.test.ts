/**
 * Unit tests for pure alert-rule evaluation (Epic #47 / Issue #49).
 * Covers thresholds (50/80/100 + custom), basis selection, no-budget skip,
 * disabled skip, and the cooldown-driven idempotency.
 */
import { describe, expect, it } from "vitest";
import {
  BUILTIN_THRESHOLDS,
  evaluateRule,
  evaluateRules,
  type AlertRuleState,
  type SpendSnapshot,
} from "../src/lib/finops/alert-rules.js";

const NOW = new Date("2026-06-15T12:00:00Z");

function rule(over: Partial<AlertRuleState> = {}): AlertRuleState {
  return {
    id: "r1",
    name: "test",
    thresholdPct: 80,
    basis: "projected",
    cooldownSec: 3600,
    enabled: true,
    lastFiredAt: null,
    ...over,
  };
}

const budget: SpendSnapshot = {
  budgetCents: 10_000,
  monthToDateCents: 4_000,
  projectedMonthEndCents: 9_000, // 90% projected
};

describe("evaluateRule", () => {
  it("fires when projected spend reaches the threshold", () => {
    const e = evaluateRule(rule({ thresholdPct: 80 }), budget, NOW);
    expect(e.shouldFire).toBe(true);
    expect(e.ratio).toBeCloseTo(0.9, 6);
    expect(e.spendCents).toBe(9_000);
  });

  it("does not fire below the threshold", () => {
    const e = evaluateRule(rule({ thresholdPct: 100 }), budget, NOW);
    expect(e.shouldFire).toBe(false);
    expect(e.skipReason).toBe("below-threshold");
  });

  it("evaluates the MTD basis when configured", () => {
    // MTD is 4000 / 10000 = 40%; a 50% rule must not fire on MTD.
    const e = evaluateRule(rule({ basis: "mtd", thresholdPct: 50 }), budget, NOW);
    expect(e.spendCents).toBe(4_000);
    expect(e.shouldFire).toBe(false);
    // ...but a 40% rule should.
    expect(evaluateRule(rule({ basis: "mtd", thresholdPct: 40 }), budget, NOW).shouldFire).toBe(
      true,
    );
  });

  it("skips disabled rules", () => {
    const e = evaluateRule(rule({ enabled: false }), budget, NOW);
    expect(e.shouldFire).toBe(false);
    expect(e.skipReason).toBe("disabled");
  });

  it("skips when no budget is configured", () => {
    const e = evaluateRule(rule(), { ...budget, budgetCents: null }, NOW);
    expect(e.shouldFire).toBe(false);
    expect(e.skipReason).toBe("no-budget");
  });

  it("supports custom thresholds above 100%", () => {
    const snap: SpendSnapshot = {
      budgetCents: 10_000,
      monthToDateCents: 0,
      projectedMonthEndCents: 13_000,
    };
    expect(evaluateRule(rule({ thresholdPct: 120 }), snap, NOW).shouldFire).toBe(true);
    expect(evaluateRule(rule({ thresholdPct: 150 }), snap, NOW).shouldFire).toBe(false);
  });
});

describe("cooldown / idempotency", () => {
  it("does not fire within the cooldown window after a recent fire", () => {
    const firedRecently = rule({
      thresholdPct: 80,
      cooldownSec: 3600,
      lastFiredAt: new Date(NOW.getTime() - 30 * 60 * 1000), // 30 min ago
    });
    const e = evaluateRule(firedRecently, budget, NOW);
    expect(e.shouldFire).toBe(false);
    expect(e.skipReason).toBe("cooldown");
  });

  it("fires again once the cooldown has elapsed", () => {
    const old = rule({
      thresholdPct: 80,
      cooldownSec: 3600,
      lastFiredAt: new Date(NOW.getTime() - 2 * 3600 * 1000), // 2h ago
    });
    expect(evaluateRule(old, budget, NOW).shouldFire).toBe(true);
  });
});

describe("evaluateRules", () => {
  it("returns only the rules that should fire", () => {
    const rules = [
      rule({ id: "a", thresholdPct: 50 }), // fires (90% >= 50)
      rule({ id: "b", thresholdPct: 80 }), // fires
      rule({ id: "c", thresholdPct: 100 }), // no
    ];
    const fired = evaluateRules(rules, budget, NOW);
    expect(fired.map((e) => e.ruleId).sort()).toEqual(["a", "b"]);
  });
});

describe("BUILTIN_THRESHOLDS", () => {
  it("exposes the 50/80/100 presets", () => {
    expect([...BUILTIN_THRESHOLDS]).toEqual([50, 80, 100]);
  });
});
