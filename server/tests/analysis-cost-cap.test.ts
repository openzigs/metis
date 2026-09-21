/**
 * Tests for analysis cost-cap enforcement (Phase 7).
 *
 * Mocks Prisma's `analysis.findMany` to return arbitrary token totals so we
 * can exercise the cap at, below, and above the threshold without booting a
 * real database. Cap=0 must disable enforcement entirely.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface AnalysisRow {
  startedAt: Date;
  totalTokens: number;
  deletedAt: Date | null;
}

const rows: AnalysisRow[] = [];
let lastWhere: unknown = null;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    analysis: {
      findMany: vi.fn(async (args: { where: unknown; select: unknown }) => {
        lastWhere = args.where;
        return rows.filter((r) => r.deletedAt === null);
      }),
    },
  },
}));

import {
  CostCapExceededError,
  assertCanStartAnalysis,
  getCostCapStatus,
  getMonthlyTokenCap,
  getMonthlyTokenUsage,
} from "../src/lib/analysis/cost-cap.js";

const REF_DATE = new Date(Date.UTC(2026, 3, 24, 12)); // 2026-04-24 noon UTC

beforeEach(() => {
  rows.length = 0;
  lastWhere = null;
  delete process.env.ANALYSIS_MONTHLY_TOKEN_CAP;
  delete process.env.ANALYSIS_AGENT_TOKEN_CAP;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("getMonthlyTokenCap", () => {
  it("returns the configured default when env is unset", () => {
    expect(getMonthlyTokenCap()).toBe(5_000_000);
  });

  it("honours numeric overrides", () => {
    process.env.ANALYSIS_MONTHLY_TOKEN_CAP = "12345";
    expect(getMonthlyTokenCap()).toBe(12_345);
  });

  it("falls back to the default when given garbage", () => {
    process.env.ANALYSIS_MONTHLY_TOKEN_CAP = "not-a-number";
    expect(getMonthlyTokenCap()).toBe(5_000_000);
  });

  it("permits 0 to disable enforcement", () => {
    process.env.ANALYSIS_MONTHLY_TOKEN_CAP = "0";
    expect(getMonthlyTokenCap()).toBe(0);
  });
});

describe("getMonthlyTokenUsage", () => {
  it("queries the current month bucket", async () => {
    rows.push({ startedAt: REF_DATE, totalTokens: 1000, deletedAt: null });
    rows.push({ startedAt: REF_DATE, totalTokens: 250, deletedAt: null });
    const used = await getMonthlyTokenUsage(REF_DATE);
    expect(used).toBe(1250);
    expect(lastWhere).toMatchObject({ deletedAt: null });
  });
});

describe("assertCanStartAnalysis", () => {
  it("permits when usage is below cap", async () => {
    process.env.ANALYSIS_MONTHLY_TOKEN_CAP = "1000";
    rows.push({ startedAt: REF_DATE, totalTokens: 500, deletedAt: null });
    await expect(assertCanStartAnalysis(REF_DATE)).resolves.toBeUndefined();
  });

  it("throws CostCapExceededError when usage hits the cap", async () => {
    process.env.ANALYSIS_MONTHLY_TOKEN_CAP = "1000";
    rows.push({ startedAt: REF_DATE, totalTokens: 1000, deletedAt: null });
    await expect(assertCanStartAnalysis(REF_DATE)).rejects.toBeInstanceOf(CostCapExceededError);
  });

  it("is a no-op when the cap is 0", async () => {
    process.env.ANALYSIS_MONTHLY_TOKEN_CAP = "0";
    rows.push({ startedAt: REF_DATE, totalTokens: 999_999_999, deletedAt: null });
    await expect(assertCanStartAnalysis(REF_DATE)).resolves.toBeUndefined();
  });
});

describe("getCostCapStatus", () => {
  it("reports remaining tokens and exceeded flag", async () => {
    process.env.ANALYSIS_MONTHLY_TOKEN_CAP = "1000";
    rows.push({ startedAt: REF_DATE, totalTokens: 750, deletedAt: null });
    const s = await getCostCapStatus(REF_DATE);
    expect(s.monthlyCap).toBe(1000);
    expect(s.monthlyUsed).toBe(750);
    expect(s.monthlyRemaining).toBe(250);
    expect(s.exceeded).toBe(false);
    expect(s.monthBucket).toBe("2026-04");
  });

  it("returns Infinity remaining when the cap is disabled", async () => {
    process.env.ANALYSIS_MONTHLY_TOKEN_CAP = "0";
    const s = await getCostCapStatus(REF_DATE);
    expect(s.monthlyRemaining).toBe(Number.POSITIVE_INFINITY);
    expect(s.exceeded).toBe(false);
  });
});
