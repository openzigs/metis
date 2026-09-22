/**
 * Issue #428 (Epic #407) — aggregate-vs-detail usage consistency.
 *
 * The Usage page draws its KPI cards + "By provider" table from
 * `summarizeUsage` (TokenUsage table) and its "Detailed Usage Analytics" +
 * "by Agent Step" sections from `UsageService.projectUsage` (AITokenUsage
 * table). A single provider call writes ONE row to each table:
 *
 *   • TokenUsage   — projectId ALWAYS set (cost in costCents via provider-rates)
 *   • AITokenUsage — projectId null, linked to the project via session only
 *                    (cost in estimatedCostUsd via the model-pricing map)
 *
 * Before #428 the detail query filtered AITokenUsage by the direct `projectId`
 * column, so the session-only rows were invisible and the detail sections
 * showed "No data" while the aggregates showed data. This suite drives the
 * SAME fixture traffic through BOTH code paths and asserts they agree:
 *
 *   1. populated window  → both views report the same total tokens, both non-empty
 *   2. empty window      → both views are empty (consistent "No data")
 *   3. anthropic cost    → non-zero tokens yield non-zero cost in the aggregate
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tokenUsageFindMany = vi.fn();
const aiTokenUsageFindMany = vi.fn();
const projectFindUnique = vi.fn();

vi.mock("../prisma.js", () => ({
  prisma: {
    tokenUsage: { findMany: (...a: unknown[]) => tokenUsageFindMany(...a) },
    aITokenUsage: { findMany: (...a: unknown[]) => aiTokenUsageFindMany(...a) },
    project: { findUnique: (...a: unknown[]) => projectFindUnique(...a) },
  },
}));

import { summarizeUsage } from "../finops/budget-enforcer.js";
import { UsageService } from "./usage-service.js";
import { getRate, computeCostCents } from "../finops/provider-rates.js";

const PROJECT_ID = "proj-1";
const NOW = new Date("2026-06-25T12:00:00.000Z");

/**
 * A single logical provider call rendered into BOTH table row shapes.
 * `provider`/`model`/token split are shared so the two views describe the
 * same underlying traffic.
 */
function call(opts: {
  provider: string;
  model: string;
  input: number;
  output: number;
  createdAt: Date;
  agentStep?: string;
}) {
  const total = opts.input + opts.output;
  const costCents = computeCostCents(getRate(opts.provider, opts.model), {
    inputTokens: opts.input,
    outputTokens: opts.output,
  });
  return {
    // TokenUsage shape (aggregate / KPI / by-provider source)
    tokenUsage: {
      provider: opts.provider,
      model: opts.model,
      inputTokens: opts.input,
      outputTokens: opts.output,
      totalTokens: total,
      costCents,
      createdAt: opts.createdAt,
    },
    // AITokenUsage shape (detail / by-agent-step source). projectId null —
    // associated to the project purely via the session relation.
    aiTokenUsage: {
      dayBucket: opts.createdAt.toISOString().slice(0, 10),
      provider: opts.provider,
      model: opts.model,
      userId: "user-1",
      projectId: null as string | null,
      agentStep: opts.agentStep ?? "chat",
      promptTokens: opts.input,
      completionTokens: opts.output,
      totalTokens: total,
      // #22 — an unpriced call is null in BOTH tables.
      estimatedCostUsd: costCents === null ? null : costCents / 100,
    },
  };
}

describe("usage aggregate-vs-detail consistency (#428)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectFindUnique.mockResolvedValue({ monthlyTokenBudget: null });
  });
  afterEach(() => vi.restoreAllMocks());

  it("populated window: aggregate and detail report the same total tokens", async () => {
    const calls = [
      call({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        input: 80_000,
        output: 20_000,
        createdAt: new Date("2026-06-24T10:00:00.000Z"),
        agentStep: "chat",
      }),
      call({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        input: 30_000,
        output: 7_514,
        createdAt: new Date("2026-06-25T09:00:00.000Z"),
        agentStep: "analysis",
      }),
    ];
    const expectedTotal = calls.reduce((s, c) => s + c.tokenUsage.totalTokens, 0);

    tokenUsageFindMany.mockResolvedValue(calls.map((c) => c.tokenUsage));
    aiTokenUsageFindMany.mockResolvedValue(calls.map((c) => c.aiTokenUsage));

    const aggregate = await summarizeUsage(PROJECT_ID, {}, NOW);
    const detail = await new UsageService().projectUsage(PROJECT_ID, {
      range: "7d",
      groupBy: "agentStep",
    });

    // Same underlying traffic ⇒ identical token totals across both sources.
    expect(aggregate.totalTokens).toBe(expectedTotal);
    expect(detail.totalTokens).toBe(expectedTotal);
    expect(aggregate.totalTokens).toBe(detail.totalTokens);

    // Neither view is "No data" when there is data — the core #428 invariant.
    expect(aggregate.byProvider.length).toBeGreaterThan(0);
    expect(detail.rows.length).toBeGreaterThan(0);
  });

  it("the detail query selects session-only rows (no top-level projectId equality)", async () => {
    tokenUsageFindMany.mockResolvedValue([]);
    aiTokenUsageFindMany.mockResolvedValue([]);
    await new UsageService().projectUsage(PROJECT_ID, { range: "7d" });
    const where = aiTokenUsageFindMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ projectId: PROJECT_ID }, { session: { projectId: PROJECT_ID } }]);
    expect(where.projectId).toBeUndefined();
  });

  it("empty window: aggregate and detail are BOTH empty (consistent No data)", async () => {
    tokenUsageFindMany.mockResolvedValue([]);
    aiTokenUsageFindMany.mockResolvedValue([]);

    const aggregate = await summarizeUsage(PROJECT_ID, {}, NOW);
    const detail = await new UsageService().projectUsage(PROJECT_ID, { range: "7d" });

    expect(aggregate.totalTokens).toBe(0);
    expect(aggregate.byProvider).toHaveLength(0);
    expect(aggregate.byDay).toHaveLength(0);
    expect(detail.totalTokens).toBe(0);
    expect(detail.rows).toHaveLength(0);
  });

  it("anthropic cost attribution: non-zero tokens ⇒ non-zero cost in the aggregate", async () => {
    // The #428 walkthrough: anthropic showed 137,514 tokens but $0.00.
    const c = call({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      input: 100_000,
      output: 37_514,
      createdAt: new Date("2026-06-25T08:00:00.000Z"),
    });
    tokenUsageFindMany.mockResolvedValue([c.tokenUsage]);
    aiTokenUsageFindMany.mockResolvedValue([c.aiTokenUsage]);

    const aggregate = await summarizeUsage(PROJECT_ID, {}, NOW);
    const anthropicRow = aggregate.byProvider.find((r) => r.provider === "anthropic");
    expect(anthropicRow).toBeDefined();
    expect(anthropicRow!.totalTokens).toBe(137_514);
    expect(anthropicRow!.costCents).toBeGreaterThan(0);
    expect(aggregate.costCents).toBeGreaterThan(0);
  });

  it("unpriced usage is reported separately with its tokens, never summed as $0 (#22)", async () => {
    const priced = call({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      input: 1_000_000,
      output: 1_000_000,
      createdAt: new Date("2026-06-25T08:00:00.000Z"),
      agentStep: "chat",
    });
    const unpriced = call({
      provider: "anthropic",
      model: "deepseek-v4-pro",
      input: 1_334_017,
      output: 1_297_372,
      createdAt: new Date("2026-06-25T09:00:00.000Z"),
      agentStep: "docs",
    });
    expect(unpriced.tokenUsage.costCents).toBeNull();
    tokenUsageFindMany.mockResolvedValue([priced.tokenUsage, unpriced.tokenUsage]);
    aiTokenUsageFindMany.mockResolvedValue([priced.aiTokenUsage, unpriced.aiTokenUsage]);

    const aggregate = await summarizeUsage(PROJECT_ID, {}, NOW);
    // Cost is the PRICED portion only; the unpriced tokens are reported apart.
    expect(aggregate.costCents).toBe(1800);
    expect(aggregate.unpriced).toEqual({
      inputTokens: 1_334_017,
      outputTokens: 1_297_372,
      totalTokens: 2_631_389,
      calls: 1,
    });
    const ds = aggregate.byProvider.find((r) => r.model === "deepseek-v4-pro");
    expect(ds?.costCents).toBeNull();
    expect(ds?.unpricedTokens).toBe(2_631_389);
    const sonnet = aggregate.byProvider.find((r) => r.model === "claude-sonnet-4-6");
    expect(sonnet?.costCents).toBe(1800);
    expect(sonnet?.unpricedTokens).toBe(0);
    const day = aggregate.byDay.find((d) => d.day === "2026-06-25");
    expect(day?.costCents).toBe(1800);
    expect(day?.unpricedTokens).toBe(2_631_389);
    // PR #41 review — the projection covers priced usage only, so the summary
    // says how much month-to-date usage it leaves out.
    expect(aggregate.monthToDateUnpricedTokens).toBe(2_631_389);

    const detail = await new UsageService().projectUsage(PROJECT_ID, {
      range: "7d",
      groupBy: "agentStep",
    });
    expect(detail.totalCostUsd).toBeCloseTo(18, 10);
    expect(detail.unpriced).toEqual({
      promptTokens: 1_334_017,
      completionTokens: 1_297_372,
      totalTokens: 2_631_389,
      count: 1,
    });
    const docs = detail.rows.find((r) => r.agentStep === "docs");
    expect(docs?.estimatedCostUsd).toBeNull();
    expect(docs?.unpricedTokens).toBe(2_631_389);
    const csv = new UsageService().toCSV(detail.rows);
    // Unknown cost is an EMPTY cell, never 0.000000.
    const dsLine = csv.split("\n").find((l) => l.includes("deepseek-v4-pro"));
    expect(dsLine).toBe(
      "2026-06-25,anthropic,deepseek-v4-pro,user-1,,1334017,1297372,2631389,,1,2631389",
    );
  });

  it("a group mixing priced and unpriced rows keeps the priced cost and counts the rest", async () => {
    const svc = new UsageService();
    aiTokenUsageFindMany.mockResolvedValue([
      {
        ...call({ provider: "p", model: "m", input: 10, output: 0, createdAt: NOW }).aiTokenUsage,
        estimatedCostUsd: 0.5,
      },
      {
        ...call({ provider: "p", model: "m", input: 20, output: 0, createdAt: NOW }).aiTokenUsage,
        estimatedCostUsd: null,
      },
      {
        ...call({ provider: "p", model: "m", input: 30, output: 0, createdAt: NOW }).aiTokenUsage,
        estimatedCostUsd: 0.25,
      },
    ]);
    const out = await svc.projectUsage(PROJECT_ID, { groupBy: "model" });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].estimatedCostUsd).toBeCloseTo(0.75, 10);
    expect(out.rows[0].unpricedTokens).toBe(20);
    expect(out.unpriced.count).toBe(1);
  });
});
