/**
 * Unit tests for the AWS Cost Explorer integration (Epic #47 / Issue #53).
 *
 * NO live AWS calls and NO credentials — the CostExplorerClient is a fake.
 * Covers GetCostAndUsage request shaping, response parsing, the >10%
 * discrepancy warning, and the env gate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const tokenUsage: Array<{ provider: string; costCents: number; createdAt: Date }> = [];
const alertEvents: Record<string, unknown>[] = [];

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    tokenUsage: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { provider: { startsWith: string }; createdAt: { gte: Date; lt: Date } };
        }) =>
          tokenUsage.filter(
            (r) =>
              r.provider.startsWith(where.provider.startsWith) &&
              r.createdAt >= where.createdAt.gte &&
              r.createdAt < where.createdAt.lt,
          ),
      ),
    },
    alertEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        alertEvents.push(data);
        return { id: `ae_${alertEvents.length}`, ...data };
      }),
    },
  },
}));

import {
  buildCostAndUsageInput,
  parseCostAndUsageResponse,
  reconcileBedrockSpend,
  resolveCostExplorerClient,
  DISCREPANCY_THRESHOLD,
  type CostExplorerClient,
} from "../src/lib/finops/aws-cost-explorer.js";

beforeEach(() => {
  tokenUsage.length = 0;
  alertEvents.length = 0;
});

describe("buildCostAndUsageInput", () => {
  it("filters on the Bedrock service and groups by region", () => {
    const input = buildCostAndUsageInput({ start: "2026-05-01", end: "2026-06-01" });
    expect(input.TimePeriod).toEqual({ Start: "2026-05-01", End: "2026-06-01" });
    expect(input.Granularity).toBe("MONTHLY");
    expect(input.Metrics).toEqual(["UnblendedCost"]);
    expect(input.Filter).toEqual({ Dimensions: { Key: "SERVICE", Values: ["Amazon Bedrock"] } });
    expect(input.GroupBy).toEqual([{ Type: "DIMENSION", Key: "REGION" }]);
  });

  it("ANDs a region dimension filter and adds a TAG group when provided", () => {
    const input = buildCostAndUsageInput({
      start: "2026-05-01",
      end: "2026-06-01",
      region: "us-east-1",
      tagKey: "metis:inferenceProfile",
    });
    expect(input.Filter).toEqual({
      And: [
        { Dimensions: { Key: "SERVICE", Values: ["Amazon Bedrock"] } },
        { Dimensions: { Key: "REGION", Values: ["us-east-1"] } },
      ],
    });
    expect(input.GroupBy).toContainEqual({ Type: "TAG", Key: "metis:inferenceProfile" });
  });
});

describe("parseCostAndUsageResponse", () => {
  it("sums grouped Bedrock costs and normalises keys", () => {
    const result = parseCostAndUsageResponse({
      ResultsByTime: [
        {
          Groups: [
            { Keys: ["us-east-1"], Metrics: { UnblendedCost: { Amount: "12.50", Unit: "USD" } } },
            { Keys: ["us-west-2"], Metrics: { UnblendedCost: { Amount: "7.25", Unit: "USD" } } },
          ],
        },
      ],
    });
    expect(result.totalUsd).toBeCloseTo(19.75, 6);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toEqual({ key: "us-east-1", amountUsd: 12.5 });
  });

  it("falls back to the period Total when there are no groups", () => {
    const result = parseCostAndUsageResponse({
      ResultsByTime: [{ Total: { UnblendedCost: { Amount: "5.00", Unit: "USD" } }, Groups: [] }],
    });
    expect(result.totalUsd).toBe(5);
    expect(result.lines[0].key).toBe("total");
  });

  it("tolerates missing/garbage amounts", () => {
    const result = parseCostAndUsageResponse({
      ResultsByTime: [{ Groups: [{ Keys: ["x"], Metrics: {} }] }],
    });
    expect(result.totalUsd).toBe(0);
  });
});

describe("resolveCostExplorerClient (env gate)", () => {
  it("returns null unless explicitly enabled", () => {
    expect(resolveCostExplorerClient({})).toBeNull();
    expect(resolveCostExplorerClient({ AWS_COST_EXPLORER_ENABLED: "false" })).toBeNull();
  });

  it("returns a client when enabled", () => {
    const c = resolveCostExplorerClient({
      AWS_COST_EXPLORER_ENABLED: "true",
      AWS_COST_EXPLORER_REGION: "eu-west-1",
    });
    expect(c).not.toBeNull();
    expect(typeof c?.getCostAndUsage).toBe("function");
  });
});

function fakeClient(totalUsd: number): CostExplorerClient {
  return {
    getCostAndUsage: vi.fn(async () => ({
      totalUsd,
      lines: [{ key: "us-east-1", amountUsd: totalUsd }],
    })),
  };
}

describe("reconcileBedrockSpend", () => {
  const start = new Date(Date.UTC(2026, 4, 1));
  const end = new Date(Date.UTC(2026, 5, 1));

  it("reports no warning when AWS and METIS agree within 10%", async () => {
    // AWS $100.00 = 10000c; METIS 9500c → 5% discrepancy.
    tokenUsage.push({
      provider: "bedrock-gateway",
      costCents: 9_500,
      createdAt: new Date(Date.UTC(2026, 4, 10)),
    });
    const result = await reconcileBedrockSpend({ client: fakeClient(100), start, end });
    expect(result.awsCents).toBe(10_000);
    expect(result.metisCents).toBe(9_500);
    expect(result.discrepancy).toBeCloseTo(0.05, 4);
    expect(result.warning).toBe(false);
    expect(alertEvents).toHaveLength(0);
  });

  it("triggers a warning when the discrepancy exceeds 10% (AC)", async () => {
    // AWS $100 = 10000c; METIS 8000c → 20% discrepancy.
    tokenUsage.push({
      provider: "bedrock-gateway",
      costCents: 8_000,
      createdAt: new Date(Date.UTC(2026, 4, 10)),
    });
    const result = await reconcileBedrockSpend({
      client: fakeClient(100),
      start,
      end,
      warnWorkspaceId: "w1",
    });
    expect(result.warning).toBe(true);
    expect(result.discrepancy).toBeGreaterThan(DISCREPANCY_THRESHOLD);
    // A reconciliation warning was persisted as an AlertEvent.
    expect(alertEvents).toHaveLength(1);
    expect(alertEvents[0]).toMatchObject({
      workspaceId: "w1",
      ruleId: "aws-reconciliation",
      basis: "aws-reconciliation",
    });
  });

  it("uses a symmetric denominator when METIS spend exceeds AWS (Mi2)", async () => {
    // AWS $50 = 5000c; METIS 10000c. Symmetric ratio = |5000-10000| / max(5000,
    // 10000, 1) = 5000/10000 = 0.5. The old asymmetric form (/awsCents) would
    // have reported 1.0 — inflated because the small side was the denominator.
    tokenUsage.push({
      provider: "bedrock-gateway",
      costCents: 10_000,
      createdAt: new Date(Date.UTC(2026, 4, 10)),
    });
    const result = await reconcileBedrockSpend({ client: fakeClient(50), start, end });
    expect(result.awsCents).toBe(5_000);
    expect(result.metisCents).toBe(10_000);
    expect(result.discrepancy).toBeCloseTo(0.5, 4); // bounded by the larger side
    expect(result.warning).toBe(true); // still flags >10%
  });

  it("only counts bedrock-prefixed providers as METIS Bedrock spend", async () => {
    tokenUsage.push(
      { provider: "openai", costCents: 5_000, createdAt: new Date(Date.UTC(2026, 4, 10)) },
      { provider: "bedrock-gateway", costCents: 100, createdAt: new Date(Date.UTC(2026, 4, 10)) },
    );
    const result = await reconcileBedrockSpend({ client: fakeClient(1), start, end });
    expect(result.metisCents).toBe(100); // openai excluded
  });

  it("does not persist a warning when no workspace is given", async () => {
    tokenUsage.push({
      provider: "bedrock-gateway",
      costCents: 0,
      createdAt: new Date(Date.UTC(2026, 4, 10)),
    });
    const result = await reconcileBedrockSpend({ client: fakeClient(100), start, end });
    expect(result.warning).toBe(true);
    expect(alertEvents).toHaveLength(0);
  });
});
