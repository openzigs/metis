/**
 * Issue #428 (Epic #407), superseded by #792 — aggregate-vs-detail usage
 * consistency.
 *
 * The Usage page draws its KPI cards + "By provider" table from
 * `summarizeUsage` and its "Detailed Usage Analytics", "by Agent Step" and CSV
 * export from `UsageService.projectUsage`. Until #792 those read two different
 * tables (`token_usages` and `ai_token_usages`), which in practice held
 * disjoint traffic: one project page showed 10.8M tokens / $5.57 in its cards
 * and 290k / $0.14 in its analytics and CSV. Both now read `token_usages`, so
 * this suite drives ONE set of ledger rows through BOTH code paths and asserts
 * they agree on tokens AND cost:
 *
 *   1. populated window  → same total tokens and same cost, both non-empty
 *   2. empty window      → both views are empty (consistent "No data")
 *   3. anthropic cost    → non-zero tokens yield non-zero cost in the aggregate
 *   4. unpriced usage    → reported apart in both views, never as $0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tokenUsageFindMany = vi.fn();
const aiTokenUsageFindMany = vi.fn((..._args: unknown[]) => {
  throw new Error("#792 — the project usage page must not read ai_token_usages");
});
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

/** One provider call as the `token_usages` row both views read. */
function call(opts: {
  provider: string;
  model: string;
  input: number;
  output: number;
  createdAt: Date;
  agentStep?: string;
}) {
  const costCents = computeCostCents(getRate(opts.provider, opts.model), {
    inputTokens: opts.input,
    outputTokens: opts.output,
  });
  return {
    provider: opts.provider,
    model: opts.model,
    userId: "user-1",
    agentStep: opts.agentStep ?? "chat",
    inputTokens: opts.input,
    outputTokens: opts.output,
    totalTokens: opts.input + opts.output,
    costCents,
    createdAt: opts.createdAt,
  };
}

describe("usage aggregate-vs-detail consistency (#428, #792)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectFindUnique.mockResolvedValue({ monthlyTokenBudget: null });
  });
  afterEach(() => vi.restoreAllMocks());

  const detailOf = (groupBy: "day" | "model" | "agentStep" = "agentStep") =>
    new UsageService().projectUsage(PROJECT_ID, { range: "7d", groupBy });

  it("populated window: aggregate and detail report the same tokens AND the same cost", async () => {
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
        agentStep: "impact.table-filter",
      }),
    ];
    const expectedTotal = calls.reduce((s, c) => s + c.totalTokens, 0);
    tokenUsageFindMany.mockResolvedValue(calls);

    const aggregate = await summarizeUsage(PROJECT_ID, {}, NOW);
    const detail = await detailOf();

    expect(aggregate.totalTokens).toBe(expectedTotal);
    expect(detail.totalTokens).toBe(expectedTotal);
    // #792 — the analytics card and CSV showed $0.14 against the cards' $5.57.
    expect(aggregate.costCents).toBeGreaterThan(0);
    expect(detail.totalCostUsd * 100).toBeCloseTo(aggregate.costCents, 10);
    expect(aggregate.byProvider.length).toBeGreaterThan(0);
    expect(detail.rows.map((r) => r.agentStep).sort()).toEqual(["chat", "impact.table-filter"]);
    expect(aiTokenUsageFindMany).not.toHaveBeenCalled();
  });

  it("both views query the same table with the same project filter", async () => {
    tokenUsageFindMany.mockResolvedValue([]);
    await summarizeUsage(PROJECT_ID, {}, NOW);
    const aggregateCalls = tokenUsageFindMany.mock.calls.length;
    await detailOf("day");
    expect(aggregateCalls).toBeGreaterThan(0);
    expect(tokenUsageFindMany.mock.calls.length).toBe(aggregateCalls + 1);
    for (const [arg] of tokenUsageFindMany.mock.calls) {
      expect(arg.where.projectId).toBe(PROJECT_ID);
    }
  });

  it("empty window: aggregate and detail are BOTH empty (consistent No data)", async () => {
    tokenUsageFindMany.mockResolvedValue([]);

    const aggregate = await summarizeUsage(PROJECT_ID, {}, NOW);
    const detail = await detailOf("day");

    expect(aggregate.totalTokens).toBe(0);
    expect(aggregate.byProvider).toHaveLength(0);
    expect(aggregate.byDay).toHaveLength(0);
    expect(detail.totalTokens).toBe(0);
    expect(detail.rows).toHaveLength(0);
  });

  it("anthropic cost attribution: non-zero tokens ⇒ non-zero cost in the aggregate", async () => {
    // The #428 walkthrough: anthropic showed 137,514 tokens but $0.00.
    tokenUsageFindMany.mockResolvedValue([
      call({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        input: 100_000,
        output: 37_514,
        createdAt: new Date("2026-06-25T08:00:00.000Z"),
      }),
    ]);

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
    expect(unpriced.costCents).toBeNull();
    tokenUsageFindMany.mockResolvedValue([priced, unpriced]);

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

    const detail = await detailOf();
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
    // Unknown cost is an EMPTY cell, never 0.000000; the project is named.
    const dsLine = csv.split("\n").find((l) => l.includes("deepseek-v4-pro"));
    expect(dsLine).toBe(
      `2026-06-25,anthropic,deepseek-v4-pro,user-1,${PROJECT_ID},1334017,1297372,2631389,,1,2631389`,
    );
  });

  it("a group mixing priced and unpriced rows keeps the priced cost and counts the rest", async () => {
    const base = call({ provider: "p", model: "m", input: 10, output: 0, createdAt: NOW });
    tokenUsageFindMany.mockResolvedValue([
      { ...base, totalTokens: 10, costCents: 50 },
      { ...base, totalTokens: 20, costCents: null },
      { ...base, totalTokens: 30, costCents: 25 },
    ]);
    const out = await new UsageService().projectUsage(PROJECT_ID, { groupBy: "model" });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].estimatedCostUsd).toBeCloseTo(0.75, 10);
    expect(out.rows[0].unpricedTokens).toBe(20);
    expect(out.unpriced.count).toBe(1);
  });
});
