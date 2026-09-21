/**
 * Tests for the project-level sandbox cost rollup (Epic #395 #418).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxCostRepo } from "../../../../src/lib/sandbox/pricing/cost-repo.js";

vi.mock("../../../../src/lib/prisma.js", () => {
  const groupBy = vi.fn();
  return {
    prisma: {
      sandboxSession: {
        groupBy,
      },
    },
    __mocks: { groupBy },
  };
});

const { prisma } = await import("../../../../src/lib/prisma.js");
const groupByMock = (prisma.sandboxSession as unknown as { groupBy: ReturnType<typeof vi.fn> })
  .groupBy;

beforeEach(() => {
  groupByMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("SandboxCostRepo.getProjectSandboxCost", () => {
  it("returns zero totals when no sessions exist", async () => {
    groupByMock.mockResolvedValueOnce([]);
    const repo = new SandboxCostRepo();
    const out = await repo.getProjectSandboxCost("p-1");
    expect(out.totalMicroUsd).toBe(0);
    expect(out.totalUsd).toBe(0);
    expect(out.sessionCount).toBe(0);
    expect(out.providerBreakdown).toEqual([]);
  });

  it("sums micro-USD across providers and computes totalUsd", async () => {
    groupByMock.mockResolvedValueOnce([
      { provider: "e2b", _sum: { costMicroUsd: 1_500_000 }, _count: { _all: 3 } },
      { provider: "daytona", _sum: { costMicroUsd: 500_000 }, _count: { _all: 2 } },
    ]);
    const repo = new SandboxCostRepo();
    const out = await repo.getProjectSandboxCost("p-1");
    expect(out.totalMicroUsd).toBe(2_000_000);
    expect(out.totalUsd).toBe(2);
    expect(out.sessionCount).toBe(5);
    expect(out.providerBreakdown[0].provider).toBe("e2b");
    expect(out.providerBreakdown[1].provider).toBe("daytona");
  });

  it("treats null _sum.costMicroUsd as zero (sessions before the cost meter shipped)", async () => {
    groupByMock.mockResolvedValueOnce([
      { provider: "noop", _sum: { costMicroUsd: null }, _count: { _all: 7 } },
    ]);
    const repo = new SandboxCostRepo();
    const out = await repo.getProjectSandboxCost("p-1");
    expect(out.totalMicroUsd).toBe(0);
    expect(out.providerBreakdown[0].sessionCount).toBe(7);
  });

  it("forwards the createdAt range filter to Prisma when supplied", async () => {
    groupByMock.mockResolvedValueOnce([]);
    const repo = new SandboxCostRepo();
    const from = new Date("2024-01-01T00:00:00.000Z");
    const to = new Date("2024-02-01T00:00:00.000Z");
    await repo.getProjectSandboxCost("p-1", { from, to });
    expect(groupByMock).toHaveBeenCalledTimes(1);
    const args = groupByMock.mock.calls[0][0] as { where: Record<string, unknown> };
    const where = args.where as { createdAt: { gte: Date; lt: Date } };
    expect(where.createdAt.gte).toEqual(from);
    expect(where.createdAt.lt).toEqual(to);
  });
});
