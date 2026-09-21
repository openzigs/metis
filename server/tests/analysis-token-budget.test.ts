/**
 * Tests for the TokenBudget class (Epic #473 — Issue #481).
 */
import { describe, expect, it } from "vitest";
import { TokenBudget, BudgetExhaustedError } from "../src/lib/analysis/token-budget.js";

describe("TokenBudget", () => {
  it("tracks consumed tokens", () => {
    const budget = new TokenBudget({ maxTokens: 1000 });
    budget.record(200);
    expect(budget.used).toBe(200);
    budget.record(300);
    expect(budget.used).toBe(500);
  });

  it("reports remaining fraction", () => {
    const budget = new TokenBudget({ maxTokens: 1000 });
    expect(budget.remainingFraction).toBe(1);
    budget.record(250);
    expect(budget.remainingFraction).toBe(0.75);
    budget.record(750);
    expect(budget.remainingFraction).toBe(0);
  });

  it("throws BudgetExhaustedError when budget exceeded", () => {
    const budget = new TokenBudget({ maxTokens: 100 });
    budget.record(50);
    expect(() => budget.record(60)).toThrow(BudgetExhaustedError);
  });

  it("BudgetExhaustedError has correct properties", () => {
    const budget = new TokenBudget({ maxTokens: 100 });
    try {
      budget.record(150);
    } catch (err) {
      expect(err).toBeInstanceOf(BudgetExhaustedError);
      const e = err as BudgetExhaustedError;
      expect(e.consumed).toBe(150);
      expect(e.budget).toBe(100);
      expect(e.code).toBe("BUDGET_EXHAUSTED");
    }
  });

  it("hasRemaining returns true when budget available", () => {
    const budget = new TokenBudget({ maxTokens: 100 });
    expect(budget.hasRemaining()).toBe(true);
    budget.record(99);
    expect(budget.hasRemaining()).toBe(true);
  });

  it("hasRemaining returns false when budget consumed", () => {
    const budget = new TokenBudget({ maxTokens: 100 });
    try {
      budget.record(100);
    } catch {
      /* ignore */
    }
    expect(budget.hasRemaining()).toBe(false);
  });

  it("total returns the configured max", () => {
    const budget = new TokenBudget({ maxTokens: 5000 });
    expect(budget.total).toBe(5000);
  });

  it("remainingFraction never goes below 0", () => {
    const budget = new TokenBudget({ maxTokens: 100 });
    try {
      budget.record(200);
    } catch {
      /* ignore */
    }
    expect(budget.remainingFraction).toBe(0);
  });
});
