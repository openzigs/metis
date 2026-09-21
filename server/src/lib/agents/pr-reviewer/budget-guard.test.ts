/**
 * Epic #394 (#401) — budget-guard tests.
 */
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  checkBudget,
  PR_REVIEW_SESSION_PREFIX,
  recordPrReviewSpend,
  usdToCents,
} from "./budget-guard.js";

interface PrismaStub {
  project: {
    findUnique: ReturnType<typeof vi.fn>;
  };
  tokenUsage: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
}

function mkPrisma(opts: { cap?: number | null; rows?: Array<{ costCents: number }> }): {
  prisma: PrismaClient;
  stub: PrismaStub;
} {
  const stub: PrismaStub = {
    project: {
      findUnique: vi.fn(async () => ({
        prReviewMonthlyBudgetCents: opts.cap === undefined ? null : opts.cap,
      })),
    },
    tokenUsage: {
      findMany: vi.fn(async () => opts.rows ?? []),
      create: vi.fn(async () => ({})),
    },
  };
  return { prisma: stub as unknown as PrismaClient, stub };
}

describe("usdToCents", () => {
  it("rounds half-away-from-zero", () => {
    expect(usdToCents(0.123)).toBe(12);
    expect(usdToCents(0.125)).toBe(13);
    expect(usdToCents(0)).toBe(0);
    expect(usdToCents(-1)).toBe(0);
    expect(usdToCents(Number.NaN)).toBe(0);
  });
});

describe("checkBudget", () => {
  const NOW = new Date("2026-04-15T12:00:00Z");

  it("allows when project has no cap", async () => {
    const { prisma, stub } = mkPrisma({ cap: null });
    const out = await checkBudget("p1", prisma, NOW);
    expect(out.allowed).toBe(true);
    expect(out.capCents).toBeNull();
    // Spend query should be skipped on the no-cap fast path.
    expect(stub.tokenUsage.findMany).not.toHaveBeenCalled();
  });

  it("allows when spend is below cap", async () => {
    const { prisma } = mkPrisma({
      cap: 1000,
      rows: [{ costCents: 250 }, { costCents: 250 }],
    });
    const out = await checkBudget("p1", prisma, NOW);
    expect(out.allowed).toBe(true);
    expect(out.spentCents).toBe(500);
    expect(out.capCents).toBe(1000);
  });

  it("blocks when spend equals cap (exact-budget)", async () => {
    const { prisma } = mkPrisma({
      cap: 500,
      rows: [{ costCents: 500 }],
    });
    const out = await checkBudget("p1", prisma, NOW);
    expect(out.allowed).toBe(false);
    expect(out.spentCents).toBe(500);
  });

  it("blocks when spend exceeds cap (over-budget)", async () => {
    const { prisma } = mkPrisma({
      cap: 500,
      rows: [{ costCents: 600 }],
    });
    const out = await checkBudget("p1", prisma, NOW);
    expect(out.allowed).toBe(false);
    expect(out.spentCents).toBe(600);
  });

  it("returns the correct UTC month bucket and reset boundary", async () => {
    const { prisma } = mkPrisma({ cap: null });
    const out = await checkBudget("p1", prisma, new Date("2026-12-30T23:59:59Z"));
    expect(out.monthBucket).toBe("2026-12");
    expect(out.resetAt).toBe("2027-01-01T00:00:00.000Z");
  });

  it("filters spend rows by sessionId prefix", async () => {
    const { prisma, stub } = mkPrisma({
      cap: 1000,
      rows: [{ costCents: 100 }],
    });
    await checkBudget("p1", prisma, NOW);
    const args = stub.tokenUsage.findMany.mock.calls[0][0];
    expect(args.where.sessionId).toEqual({ startsWith: PR_REVIEW_SESSION_PREFIX });
    expect(args.where.projectId).toBe("p1");
  });
});

describe("recordPrReviewSpend", () => {
  it("creates a TokenUsage row with normalised tokens + cost", async () => {
    const { prisma, stub } = mkPrisma({});
    await recordPrReviewSpend(
      {
        projectId: "p1",
        sessionId: "pr-review-7-12345",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        inputTokens: 1234.7,
        outputTokens: 500,
        costUsd: 0.0042,
      },
      prisma,
    );
    expect(stub.tokenUsage.create).toHaveBeenCalledTimes(1);
    const data = stub.tokenUsage.create.mock.calls[0][0].data;
    expect(data.projectId).toBe("p1");
    expect(data.sessionId).toBe("pr-review-7-12345");
    expect(data.inputTokens).toBe(1234);
    expect(data.outputTokens).toBe(500);
    expect(data.totalTokens).toBe(1734);
    expect(data.costCents).toBe(0); // 0.0042 USD → 0 cents (sub-cent floor)
  });

  it("falls back to unknown provider/model when blank", async () => {
    const { prisma, stub } = mkPrisma({});
    await recordPrReviewSpend(
      {
        projectId: "p1",
        sessionId: "pr-review-x",
        provider: "",
        model: "",
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 1.5,
      },
      prisma,
    );
    const data = stub.tokenUsage.create.mock.calls[0][0].data;
    expect(data.provider).toBe("unknown");
    expect(data.model).toBe("unknown");
    expect(data.costCents).toBe(150);
  });
});
