/**
 * #2189 — the BRD cost estimate: the plan read from the project, the call
 * model, and how it is priced. The check against measured runs is in
 * `cost-estimate.calibration.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const codeSymbolFindMany = vi.hoisted(() => vi.fn());
const factCacheFindMany = vi.hoisted(() => vi.fn());
vi.mock("../prisma.js", () => ({
  prisma: {
    codeSymbol: { findMany: codeSymbolFindMany },
    docsGenFactCache: { findMany: factCacheFindMany },
  },
}));

const includeTests = vi.hoisted(() => ({ value: true }));
vi.mock("./phase1-chunking.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./phase1-chunking.js")>()),
  resolvePhase1IncludeTests: () => includeTests.value,
}));

import {
  RANGE_HIGH_FACTOR,
  RANGE_LOW_FACTOR,
  charsPerToken,
  estimateBrdGenerationCost,
  estimateFromPlan,
  loadCostPlanModules,
  moduleSourceLines,
  planModelCalls,
  pointEstimateUsd,
  type CostModels,
  type CostPlan,
} from "./cost-estimate.js";
import { HAIKU_5_5_LONG_PROMPT_TOKENS } from "../finops/provider-rates.js";

const sonnet = { provider: "anthropic", model: "claude-sonnet-5-5" };
const SONNET: CostModels = { phase1: sonnet, phase2: sonnet, judge: sonnet, claim: sonnet };

const PLAN: CostPlan = {
  modules: [
    { lines: 200, cached: false },
    { lines: 100, cached: true },
  ],
  sections: 7,
  documentMaxChars: 250_000,
  factsCharCap: 150_000,
  phase1ChunkInputChars: 84_000,
};

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_BASE_URL", "");
  vi.stubEnv("MODEL_PRICES", "");
  includeTests.value = true;
  codeSymbolFindMany.mockReset();
  factCacheFindMany.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("planModelCalls", () => {
  it("extracts facts only for modules whose facts are not cached", () => {
    const phase1 = { provider: "anthropic", model: "phase1-model" };
    const { events } = planModelCalls(PLAN, { ...SONNET, phase1 });
    const extraction = events.filter((e) => e.model === "phase1-model");
    // One chunk: the uncached 200-line module.
    expect(extraction).toHaveLength(1);
    const allCached = planModelCalls(
      { ...PLAN, modules: PLAN.modules.map((m) => ({ ...m, cached: true })) },
      { ...SONNET, phase1 },
    );
    expect(allCached.events.filter((e) => e.model === "phase1-model")).toHaveLength(0);
  });

  it("splits a module larger than one Phase-1 chunk into several calls", () => {
    const phase1 = { provider: "anthropic", model: "phase1-model" };
    const { events } = planModelCalls(
      { ...PLAN, modules: [{ lines: 10_000, cached: false }] },
      { ...SONNET, phase1 },
    );
    // 10,000 lines × 22 chars over an 84,000-char chunk budget: 3 chunks.
    expect(events.filter((e) => e.model === "phase1-model")).toHaveLength(3);
  });

  it("writes and judges every section, and makes one claim call per write or more", () => {
    const write = { provider: "anthropic", model: "writer" };
    const judge = { provider: "anthropic", model: "judge" };
    const claim = { provider: "anthropic", model: "claims" };
    const { events } = planModelCalls(PLAN, { phase1: sonnet, phase2: write, judge, claim });
    expect(events.filter((e) => e.model === "writer")).toHaveLength(7);
    expect(events.filter((e) => e.model === "judge")).toHaveLength(7);
    expect(events.filter((e) => e.model === "claims")).toHaveLength(10);
  });

  it("adds batch calls only once the facts outgrow one facts cap", () => {
    const write = { provider: "anthropic", model: "writer" };
    const models = { ...SONNET, phase2: write };
    const small = planModelCalls(PLAN, models).events.filter((e) => e.model === "writer");
    const large = planModelCalls(
      { ...PLAN, modules: Array.from({ length: 50 }, () => ({ lines: 2_000, cached: true })) },
      models,
    ).events.filter((e) => e.model === "writer");
    expect(small).toHaveLength(7);
    expect(large.length).toBeGreaterThan(7);
  });

  it("plans the document against the document cap", () => {
    const big = { ...PLAN, modules: [{ lines: 1_000_000, cached: true }] };
    expect(planModelCalls(big, SONNET).documentChars).toBe(250_000);
    expect(planModelCalls({ ...big, documentMaxChars: 50_000 }, SONNET).documentChars).toBe(50_000);
    // Below the cap: a base per section plus the facts.
    const small = planModelCalls(PLAN, SONNET).documentChars;
    expect(small).toBeGreaterThan(7 * 14_000);
    expect(small).toBeLessThan(250_000);
  });

  it("puts a large project's widest calls over Haiku 5.5's long-prompt threshold", () => {
    const haiku = { provider: "anthropic", model: "claude-haiku-5-5" };
    const { events } = planModelCalls(
      { ...PLAN, modules: Array.from({ length: 100 }, () => ({ lines: 800, cached: true })) },
      { phase1: haiku, phase2: haiku, judge: haiku, claim: haiku },
    );
    expect(events.some((e) => e.inputTokens > HAIKU_5_5_LONG_PROMPT_TOKENS)).toBe(true);
  });
});

describe("charsPerToken", () => {
  it("counts more tokens per character for Claude 5-generation models", () => {
    expect(charsPerToken("claude-sonnet-5-5")).toBeLessThan(charsPerToken("deepseek-flash"));
    expect(charsPerToken("us.anthropic.claude-haiku-5-5-20261007-v1:0")).toBe(2.2);
    expect(charsPerToken("claude-haiku-4-5")).toBe(3.5);
    expect(charsPerToken("claude-sonnet-4-6")).toBe(3.5);
  });
});

describe("estimateFromPlan", () => {
  it("prices a run as a range around the point estimate", () => {
    const point = pointEstimateUsd(PLAN, SONNET)!;
    const estimate = estimateFromPlan(PLAN, SONNET);
    expect(estimate.status).toBe("priced");
    expect(point).toBeGreaterThan(0);
    expect(estimate.lowUsd).toBe(Math.floor(point * RANGE_LOW_FACTOR * 100) / 100);
    expect(estimate.highUsd).toBe(Math.ceil(point * RANGE_HIGH_FACTOR * 100) / 100);
    expect(estimate.lowUsd!).toBeLessThan(estimate.highUsd!);
    expect(estimate.models).toEqual(["anthropic/claude-sonnet-5-5"]);
    expect(estimate.plan).toEqual({
      modules: 2,
      modulesToExtract: 1,
      sourceLines: 300,
      sections: 7,
      modelCalls: planModelCalls(PLAN, SONNET).events.length,
      estimatedDocumentChars: Math.round(planModelCalls(PLAN, SONNET).documentChars),
    });
  });

  it("costs less when the facts are already cached", () => {
    const cold = pointEstimateUsd(
      { ...PLAN, modules: PLAN.modules.map((m) => ({ ...m, cached: false })) },
      SONNET,
    )!;
    const warm = pointEstimateUsd(
      { ...PLAN, modules: PLAN.modules.map((m) => ({ ...m, cached: true })) },
      SONNET,
    )!;
    expect(warm).toBeLessThan(cold);
  });

  it("names an unpriced model instead of showing a figure", () => {
    const unknown = { provider: "anthropic", model: "mystery-model" };
    const estimate = estimateFromPlan(PLAN, { ...SONNET, claim: unknown });
    expect(estimate).toMatchObject({
      status: "unpriced",
      lowUsd: null,
      highUsd: null,
      unpricedModels: ["anthropic/mystery-model"],
    });
    expect(pointEstimateUsd(PLAN, { ...SONNET, claim: unknown })).toBeNull();
  });

  it("says a self-hosted run has no per-token price, never $0", () => {
    const local = { provider: "local-gemma", model: "laguna-s-2.1" };
    const estimate = estimateFromPlan(PLAN, {
      phase1: local,
      phase2: local,
      judge: local,
      claim: local,
    });
    expect(estimate).toMatchObject({
      status: "free",
      lowUsd: null,
      highUsd: null,
      freeModels: ["local-gemma/laguna-s-2.1"],
      unpricedModels: [],
    });
  });

  it("prices the paid models of a mixed run and lists the free one", () => {
    const local = { provider: "local-gemma", model: "laguna-s-2.1" };
    const estimate = estimateFromPlan(PLAN, { ...SONNET, phase1: local });
    expect(estimate.status).toBe("priced");
    expect(estimate.freeModels).toEqual(["local-gemma/laguna-s-2.1"]);
    expect(estimate.lowUsd).toBeGreaterThan(0);
  });
});

describe("moduleSourceLines", () => {
  it("sums each file's last symbol line once", () => {
    expect(
      moduleSourceLines([
        { filePath: "a.ts", endLine: 40 },
        { filePath: "a.ts", endLine: 120 },
        { filePath: "b.ts", endLine: 30 },
      ]),
    ).toBe(150);
  });
});

const sym = (filePath: string, kind: string, endLine: number, i: number) => ({
  id: `${filePath}#${i}`,
  qualifiedName: `${filePath}#${i}`,
  kind,
  language: "ts",
  filePath,
  startLine: Math.max(1, endLine - 10),
  endLine,
  codeGraphId: "graph-1",
});

/** Two documentable directories, a test file and an OS-junk file. */
const SYMBOLS = [
  sym("src/billing/billing.ts", "class", 100, 1),
  sym("src/billing/billing.ts", "method", 110, 2),
  sym("src/billing/billing.ts", "method", 120, 3),
  sym("src/billing/billing.test.ts", "class", 70, 4),
  sym("src/billing/billing.test.ts", "method", 80, 5),
  sym("src/orders/orders.ts", "class", 30, 6),
  sym("src/orders/orders.ts", "method", 40, 7),
  sym("src/orders/orders.ts", "method", 50, 8),
  sym("__MACOSX/src/orders/._orders.ts", "class", 999, 9),
];

describe("loadCostPlanModules", () => {
  it("groups the scope's symbols by the generator's rules and marks cached modules", async () => {
    codeSymbolFindMany.mockResolvedValueOnce(SYMBOLS);
    factCacheFindMany.mockResolvedValueOnce([{ modulePath: "src/orders" }]);
    const modules = await loadCostPlanModules({
      projectId: "proj-1",
      codeGraphId: "graph-1",
      phase1Model: "claude-sonnet-5-5",
      phase1PromptVersion: 5,
    });
    expect(modules).toEqual([
      { lines: 200, cached: false },
      { lines: 50, cached: true },
    ]);
    // Scoped to the project (and the repository's graph).
    expect(codeSymbolFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "proj-1", codeGraphId: "graph-1" } }),
    );
    // Only the project's own cache rows, for the model and prompt Phase 1 would use.
    expect(factCacheFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: "proj-1", model: "claude-sonnet-5-5", promptVersion: 5 },
      }),
    );
  });

  it("leaves test files out when the Phase-1 policy excludes them", async () => {
    includeTests.value = false;
    codeSymbolFindMany.mockResolvedValueOnce(SYMBOLS);
    const modules = await loadCostPlanModules({
      projectId: "proj-1",
      phase1Model: "m",
      phase1PromptVersion: 5,
    });
    expect(modules.map((m) => m.lines)).toEqual([120, 50]);
    expect(codeSymbolFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "proj-1" } }),
    );
  });

  it("keeps only the modules under the path prefixes", async () => {
    codeSymbolFindMany.mockResolvedValueOnce(SYMBOLS);
    const modules = await loadCostPlanModules({
      projectId: "proj-1",
      pathPrefixes: ["src/orders"],
      phase1Model: "m",
      phase1PromptVersion: 5,
    });
    expect(modules).toEqual([{ lines: 50, cached: false }]);
  });

  it("returns no modules for a path scope that matches nothing", async () => {
    codeSymbolFindMany.mockResolvedValueOnce(SYMBOLS);
    const modules = await loadCostPlanModules({
      projectId: "proj-1",
      pathPrefixes: ["docs"],
      phase1Model: "m",
      phase1PromptVersion: 5,
    });
    expect(modules).toEqual([]);
    expect(factCacheFindMany).not.toHaveBeenCalled();
  });
});

describe("estimateBrdGenerationCost", () => {
  const input = {
    projectId: "proj-1",
    sections: 7,
    models: SONNET,
    factsCharCap: 150_000,
    phase1FactsMaxOutputTokens: 8_192,
    phase1PromptVersion: 5,
  };

  it("answers no-code for a scope with nothing to document", async () => {
    codeSymbolFindMany.mockResolvedValueOnce([SYMBOLS[8]]);
    const estimate = await estimateBrdGenerationCost(input);
    expect(estimate).toMatchObject({
      status: "no-code",
      lowUsd: null,
      highUsd: null,
      plan: { modules: 0, sections: 7, modelCalls: 0 },
    });
  });

  it("prices the scope's plan", async () => {
    codeSymbolFindMany.mockResolvedValueOnce(SYMBOLS);
    const estimate = await estimateBrdGenerationCost(input);
    expect(estimate.status).toBe("priced");
    expect(estimate.plan).toMatchObject({ modules: 2, modulesToExtract: 2, sourceLines: 250 });
    expect(estimate.lowUsd).toBeGreaterThan(0);
  });
});
