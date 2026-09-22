/**
 * Unit tests for the budget enforcer (Epic #164).
 *
 * Verifies the 402 throw contract, MTD aggregation, the cost projection
 * pro-rata math, and the usage summary endpoint helper.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface MockUsageRow {
  projectId: string;
  totalTokens: number;
  costCents: number | null;
  inputTokens: number;
  outputTokens: number;
  provider: string;
  model: string;
  createdAt: Date;
}

const usageRows: MockUsageRow[] = [];
const projects = new Map<string, { monthlyTokenBudget: number | null }>();

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    project: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = projects.get(where.id);
        return row ? { id: where.id, ...row } : null;
      }),
    },
    tokenUsage: {
      findMany: vi.fn(
        async ({
          where,
          select: _select,
        }: {
          where: {
            projectId: string;
            createdAt?: { gte?: Date; lt?: Date };
          };
          select?: Record<string, boolean>;
          orderBy?: unknown;
        }) =>
          usageRows.filter((r) => {
            if (r.projectId !== where.projectId) return false;
            if (where.createdAt?.gte && r.createdAt < where.createdAt.gte) return false;
            if (where.createdAt?.lt && r.createdAt >= where.createdAt.lt) return false;
            return true;
          }),
      ),
    },
  },
}));

import {
  assertWithinBudget,
  BudgetExceededError,
  projectMonthlyCostForCeiling,
  projectMonthlyFromMtd,
  summarizeUsage,
} from "../src/lib/finops/budget-enforcer.js";

beforeEach(() => {
  usageRows.length = 0;
  projects.clear();
});

describe("assertWithinBudget", () => {
  it("returns a snapshot when no budget is set", async () => {
    projects.set("p1", { monthlyTokenBudget: null });
    const snap = await assertWithinBudget("p1");
    expect(snap.budget).toBeNull();
    expect(snap.usedTokens).toBe(0);
    expect(snap.remainingTokens).toBe(0);
  });

  it("returns a snapshot when usage is below budget", async () => {
    projects.set("p1", { monthlyTokenBudget: 1000 });
    usageRows.push({
      projectId: "p1",
      totalTokens: 100,
      costCents: 5,
      inputTokens: 60,
      outputTokens: 40,
      provider: "openai",
      model: "gpt-4o",
      createdAt: new Date(),
    });
    const snap = await assertWithinBudget("p1");
    expect(snap.budget).toBe(1000);
    expect(snap.usedTokens).toBe(100);
    expect(snap.remainingTokens).toBe(900);
  });

  it("throws BudgetExceededError (402) when usage hits the cap", async () => {
    projects.set("p1", { monthlyTokenBudget: 100 });
    usageRows.push({
      projectId: "p1",
      totalTokens: 120,
      costCents: 5,
      inputTokens: 60,
      outputTokens: 60,
      provider: "openai",
      model: "gpt-4o",
      createdAt: new Date(),
    });
    await expect(assertWithinBudget("p1")).rejects.toBeInstanceOf(BudgetExceededError);
    try {
      await assertWithinBudget("p1");
    } catch (e) {
      expect((e as BudgetExceededError).status).toBe(402);
      expect((e as BudgetExceededError).code).toBe("BUDGET_EXCEEDED");
      expect((e as BudgetExceededError).usedTokens).toBe(120);
      expect((e as BudgetExceededError).budget).toBe(100);
    }
  });
});

describe("projectMonthlyFromMtd", () => {
  it("pro-rates linearly: half a month → 2x projection", () => {
    // June has 30 days. Day 15 with 1500c spent → projects to ~3000c.
    const fixedNow = new Date(Date.UTC(2026, 5, 15, 12, 0, 0));
    expect(projectMonthlyFromMtd(1500, fixedNow)).toBe(3000);
  });

  it("returns MTD on day 1 (no pro-rata)", () => {
    const fixedNow = new Date(Date.UTC(2026, 5, 1, 12, 0, 0));
    expect(projectMonthlyFromMtd(100, fixedNow)).toBe(3000); // 100 * 30 / 1
  });

  it("returns 0 for zero MTD", () => {
    const fixedNow = new Date(Date.UTC(2026, 5, 15, 12, 0, 0));
    expect(projectMonthlyFromMtd(0, fixedNow)).toBe(0);
  });
});

describe("summarizeUsage", () => {
  it("aggregates by provider + day and reports MTD", async () => {
    projects.set("p1", { monthlyTokenBudget: 5000 });
    // Use a fixed "now" at end of month so both day1 and day2 are always in the past
    const fixedNow = new Date(Date.UTC(2026, 4, 28, 23, 59, 59));
    const day1 = new Date(Date.UTC(2026, 4, 1, 12, 0, 0));
    const day2 = new Date(Date.UTC(2026, 4, 2, 12, 0, 0));
    usageRows.push(
      {
        projectId: "p1",
        provider: "openai",
        model: "gpt-4o",
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        costCents: 5,
        createdAt: day1,
      },
      {
        projectId: "p1",
        provider: "openai",
        model: "gpt-4o-mini",
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
        costCents: 1,
        createdAt: day2,
      },
    );
    const summary = await summarizeUsage("p1", {}, fixedNow);
    expect(summary.totalTokens).toBe(450);
    expect(summary.costCents).toBe(6);
    expect(summary.byProvider).toHaveLength(2);
    expect(summary.byProvider[0]).toMatchObject({ provider: "openai" });
    expect(summary.byDay.length).toBeGreaterThanOrEqual(1);
    expect(summary.monthlyTokenBudget).toBe(5000);
  });
});

describe("summarizeUsage — the projection the ceiling enforces (PR #41 re-review)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("re-prices rows priced since they were recorded, exactly as the ceiling does", async () => {
    projects.set("p1", { monthlyTokenBudget: null });
    const fixedNow = new Date(Date.UTC(2026, 4, 10, 12, 0, 0));
    usageRows.push(
      {
        projectId: "p1",
        provider: "openai",
        model: "gpt-4o",
        inputTokens: 1_000_000,
        outputTokens: 0,
        totalTokens: 1_000_000,
        costCents: 250,
        createdAt: new Date(Date.UTC(2026, 4, 2, 12, 0, 0)),
      },
      {
        // Recorded while unpriced (#22); the administrator has priced it since.
        projectId: "p1",
        provider: "anthropic",
        model: "deepseek-v4-pro",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        totalTokens: 2_000_000,
        costCents: null,
        createdAt: new Date(Date.UTC(2026, 4, 3, 12, 0, 0)),
      },
    );
    vi.stubEnv(
      "MODEL_PRICES",
      JSON.stringify({ "deepseek-v4-pro": { inputPerMTok: 1.32, outputPerMTok: 3.96 } }),
    );

    const summary = await summarizeUsage("p1", {}, fixedNow);
    const ceiling = await projectMonthlyCostForCeiling("p1", fixedNow);
    // 250 + 528 cents month-to-date, pro-rated over 31 days from day 10.
    expect(ceiling.projectedCents).toBe(Math.ceil(((250 + 528) * 31) / 10));
    expect(summary.projectedMonthlyCostCents).toBe(ceiling.projectedCents);
    expect(summary.monthToDateUnpricedTokens).toBe(0);
  });

  it("still reports usage that no price source covers as unpriced", async () => {
    projects.set("p1", { monthlyTokenBudget: null });
    const fixedNow = new Date(Date.UTC(2026, 4, 10, 12, 0, 0));
    usageRows.push({
      projectId: "p1",
      provider: "anthropic",
      model: "deepseek-v4-pro",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      costCents: null,
      createdAt: new Date(Date.UTC(2026, 4, 3, 12, 0, 0)),
    });
    const summary = await summarizeUsage("p1", {}, fixedNow);
    expect(summary.projectedMonthlyCostCents).toBe(0);
    expect(summary.monthToDateUnpricedTokens).toBe(15);
  });
});
