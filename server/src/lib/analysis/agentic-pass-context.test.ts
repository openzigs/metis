/**
 * #141 / #214 — the agentic pass's shared context assembly and budget. The
 * orchestrator and the tool-protocol harness both call these, so what is pinned
 * here is what #214 measures.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ hasSchemaData: vi.fn() }));
const retrievers = vi.hoisted(() => ({
  fused: vi.fn(),
  affectedCode: vi.fn(),
  affectedSchema: vi.fn(),
}));

vi.mock("../prisma.js", () => ({ prisma: {} }));
vi.mock("./database-aware-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./database-aware-resolver.js")>()),
  hasSchemaData: probe.hasSchemaData,
}));
vi.mock("./fused-code-chunks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./fused-code-chunks.js")>()),
  retrieveFusedCodeContext: retrievers.fused,
}));
vi.mock("./affected-code-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./affected-code-context.js")>()),
  computeAffectedCodeContext: retrievers.affectedCode,
}));
vi.mock("./affected-schema-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./affected-schema-context.js")>()),
  computeRunAffectedSchemaContext: retrievers.affectedSchema,
}));

import {
  agenticPassEffectiveBudget,
  assembleAgenticPassSeeds,
  buildAgenticPassPrompt,
  DEFAULT_AGENT_TOKEN_BUDGET,
  resolveAgentTokenBudget,
  resolveDatabaseAwareDecision,
  type AgenticPassSeeds,
} from "./agentic-pass-context.js";

const EMPTY: AgenticPassSeeds = {
  fused: { block: "", tokens: 0 },
  affectedCode: { block: "", tokens: 0 },
  affectedSchema: { block: "", tokens: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ANALYSIS_AGENT_TOKEN_BUDGET;
});

describe("agenticPassEffectiveBudget", () => {
  it("carves every seed's tokens out of the pass budget", () => {
    const seeds: AgenticPassSeeds = {
      fused: { block: "f", tokens: 1_000 },
      affectedCode: { block: "c", tokens: 2_000 },
      affectedSchema: { block: "s", tokens: 500 },
    };
    expect(agenticPassEffectiveBudget(10_000, seeds)).toBe(6_500);
  });

  it("never goes below half the pass budget", () => {
    const seeds: AgenticPassSeeds = { ...EMPTY, fused: { block: "f", tokens: 9_000 } };
    expect(agenticPassEffectiveBudget(10_001, seeds)).toBe(5_000);
  });

  it("is the pass budget untouched when nothing is seeded", () => {
    expect(agenticPassEffectiveBudget(10_000, EMPTY)).toBe(10_000);
  });
});

describe("buildAgenticPassPrompt", () => {
  const base = {
    projectName: "Rates",
    projectDescription: "rate engine",
    requirements: [{ id: "R1", text: "add a surcharge" }],
    fileToolsAvailable: true,
  };

  it("renders all three seeded blocks", () => {
    const { userMessage } = buildAgenticPassPrompt({
      ...base,
      seeds: {
        fused: { block: "FUSED-CTX", tokens: 1 },
        affectedCode: { block: "AFFECTED-CODE-CTX", tokens: 1 },
        affectedSchema: { block: "AFFECTED-SCHEMA-CTX", tokens: 1 },
      },
    });
    expect(userMessage).toContain("FUSED-CTX");
    expect(userMessage).toContain("AFFECTED-CODE-CTX");
    expect(userMessage).toContain("AFFECTED-SCHEMA-CTX");
  });

  it("omits empty blocks and states a missing working tree", () => {
    const withTree = buildAgenticPassPrompt({ ...base, seeds: EMPTY });
    const noTree = buildAgenticPassPrompt({ ...base, seeds: EMPTY, fileToolsAvailable: false });
    expect(withTree.systemMessage).toContain("read_file_slice");
    expect(noTree.systemMessage).toContain("NO WORKING TREE IS AVAILABLE");
  });
});

describe("resolveAgentTokenBudget", () => {
  it("defaults to 100k and honours ANALYSIS_AGENT_TOKEN_BUDGET", () => {
    expect(resolveAgentTokenBudget()).toBe(DEFAULT_AGENT_TOKEN_BUDGET);
    expect(DEFAULT_AGENT_TOKEN_BUDGET).toBe(100_000);
    process.env.ANALYSIS_AGENT_TOKEN_BUDGET = "40000";
    expect(resolveAgentTokenBudget()).toBe(40_000);
  });
});

describe("resolveDatabaseAwareDecision", () => {
  it("enables an `on` project that has schema data", async () => {
    probe.hasSchemaData.mockResolvedValue(true);
    const r = await resolveDatabaseAwareDecision("p1", "on");
    expect(r).toMatchObject({ setting: "on", enabled: true });
    expect(probe.hasSchemaData).toHaveBeenCalledWith({}, "p1");
  });

  it("disables an `off` project", async () => {
    probe.hasSchemaData.mockResolvedValue(true);
    expect(await resolveDatabaseAwareDecision("p1", "off")).toMatchObject({
      setting: "off",
      enabled: false,
    });
  });

  it("treats an unrecognised setting as the default and a failed probe as no schema data", async () => {
    probe.hasSchemaData.mockRejectedValue(new Error("db down"));
    const r = await resolveDatabaseAwareDecision("p1", "bogus", { analysisId: "a1" });
    expect(r.setting).toBe("auto");
    expect(r.ran).toBe(false);
  });
});

describe("assembleAgenticPassSeeds", () => {
  const input = {
    projectId: "p1",
    projectName: "Rates",
    projectDescription: "rate engine",
    extraInstructions: "add a surcharge column",
    requirements: [{ id: "R1", text: "add a surcharge" }],
    databaseAware: true,
  };

  it("calls the orchestrator's three retrievers with the run's inputs", async () => {
    retrievers.fused.mockResolvedValue({ chunks: [], block: "F", tokens: 3 });
    retrievers.affectedCode.mockResolvedValue({
      result: { candidates: [], truncated: false },
      block: "C",
      tokens: 4,
      filePaths: [],
    });
    retrievers.affectedSchema.mockResolvedValue({
      rows: [],
      block: "S",
      tokens: 5,
      truncated: false,
    });
    const seeds = await assembleAgenticPassSeeds(input);
    expect(seeds.fused).toMatchObject({ block: "F", tokens: 3 });
    expect(seeds.affectedCode).toMatchObject({ block: "C", tokens: 4 });
    expect(seeds.affectedSchema).toMatchObject({ block: "S", tokens: 5 });
    expect(retrievers.fused).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        extraInstructions: "add a surcharge column",
        requirements: input.requirements,
        ragChunks: [],
      }),
    );
    expect(retrievers.affectedCode).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", extraInstructions: "add a surcharge column" }),
    );
    expect(retrievers.affectedSchema).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        extraInstructions: "add a surcharge column",
        enabled: true,
      }),
    );
  });

  it("degrades a failing affected-code or affected-schema mapping to empty", async () => {
    retrievers.fused.mockResolvedValue({ chunks: [], block: "", tokens: 0 });
    retrievers.affectedCode.mockRejectedValue(new Error("graph down"));
    retrievers.affectedSchema.mockRejectedValue(new Error("schema down"));
    const seeds = await assembleAgenticPassSeeds({ ...input, databaseAware: false });
    // The project's database-aware decision reaches the schema mapping as-is.
    expect(retrievers.affectedSchema).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, extraInstructions: "add a surcharge column" }),
    );
    expect(seeds.affectedCode).toMatchObject({ block: "", tokens: 0 });
    expect(seeds.affectedSchema).toMatchObject({ block: "", tokens: 0 });
  });
});
