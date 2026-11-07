import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AIProvider } from "../../ai/types.js";
import type { runAgentLoop } from "../../analysis/agent-loop.js";
import { buildAgenticPassPrompt } from "../../analysis/agentic-pass-context.js";
import type { AgentTool } from "../../analysis/tools/types.js";
import {
  assertA3NClones,
  citationsFromAnswer,
  citationsOfLoop,
  createMaterializedAgentPass,
  FILE_ONLY_TOOLS,
  filesOnlySystemMessage,
  NO_SEEDS,
  type MaterializedAgentPassDeps,
} from "./agent-pass.js";
import type { MaterializedState } from "./materialize.js";

const answer = (findings: unknown[]) => JSON.stringify({ summary: "s", findings });

describe("citationsFromAnswer", () => {
  it("reads every finding's code and repository-source citations, with the finding's confidence", () => {
    const text = answer([
      {
        confidence: 0.9,
        citations: [
          { filePath: "./internal/a.go", startLine: 9, endLine: 3 },
          { filename: "connector:repo:c1:src/internal/b.go" },
          { filename: "Live database schema" },
        ],
      },
      { citations: [{ filePath: "c.go", startLine: 1, endLine: 2 }] },
      { confidence: 7, citations: [{ filePath: "d.go", startLine: 1, endLine: 1 }] },
      null,
    ]);
    expect(citationsFromAnswer(`Here it is:\n${text}`)).toEqual([
      { filePath: "internal/a.go", startLine: 3, endLine: 9, confidence: 0.9 },
      // #1830 — the repository the source key names rides along.
      { filePath: "internal/b.go", repoConnectionId: "c1", confidence: 0.9 },
      { filePath: "c.go", startLine: 1, endLine: 2, confidence: 0.5 },
      { filePath: "d.go", startLine: 1, endLine: 1, confidence: 1 },
    ]);
  });

  it("is empty for no answer, no JSON, or no findings", () => {
    expect(citationsFromAnswer(undefined)).toEqual([]);
    expect(citationsFromAnswer("I could not finish.")).toEqual([]);
    expect(citationsFromAnswer('{"summary":"s"}')).toEqual([]);
  });

  it("falls back to the salvage source when the answer cites nothing", () => {
    const salvage = answer([{ citations: [{ filePath: "x.go", startLine: 1, endLine: 1 }] }]);
    expect(citationsOfLoop({ finalResponse: "no json", salvageSource: salvage })).toHaveLength(1);
    expect(citationsOfLoop({ finalResponse: salvage, salvageSource: "no json" })).toHaveLength(1);
    expect(citationsOfLoop({ finalResponse: "no json" })).toEqual([]);
  });
});

describe("filesOnlySystemMessage", () => {
  it("swaps production's investigation steps for the file tools, and nothing else", () => {
    const { systemMessage } = buildAgenticPassPrompt({
      projectName: "p",
      projectDescription: "d",
      requirements: [{ id: "NR-1", text: "t" }],
      seeds: NO_SEEDS,
      fileToolsAvailable: true,
    });
    const files = filesOnlySystemMessage(systemMessage);
    expect(files).toContain("grep_files");
    expect(files).not.toMatch(/search_knowledge|searching the code graph/);
    expect(files.split("\n").length).toBe(systemMessage.split("\n").length - 1);
  });

  it("refuses a prompt whose steps changed", () => {
    expect(() => filesOnlySystemMessage("something else")).toThrow(/investigation steps changed/);
  });
});

describe("createMaterializedAgentPass", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "agent-pass-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const state = (cloneDir: string): MaterializedState => ({
    version: 1,
    corpus: "c",
    databaseUrl: "file:/x/eval.db",
    cloneRoot: "/x",
    lancedbPath: "/x/lancedb",
    embedModel: "m",
    materializedAt: "t",
    repos: [
      {
        name: "r",
        url: "u",
        sha: "s",
        projectId: "proj-r",
        connectorId: "conn-r",
        cloneDir,
        symbols: 3,
      },
    ],
  });
  const provider = { key: "anthropic", model: "claude-sonnet-5-5", offline: false } as AIProvider;
  const graphTool = { name: "search_code_graph" } as AgentTool;
  const seeds = {
    fused: { block: "FUSED", tokens: 10 },
    affectedCode: { block: "AFFECTED", tokens: 5 },
    affectedSchema: { block: "", tokens: 0 },
  };

  function depsWith(
    cloneDir: string,
    overrides: Partial<MaterializedAgentPassDeps> = {},
  ): MaterializedAgentPassDeps & { runLoop: ReturnType<typeof vi.fn> } {
    const runLoop = vi.fn(async () => ({
      finalResponse: answer([{ citations: [{ filePath: "a.go", startLine: 1, endLine: 2 }] }]),
      hasFinalAnswer: true,
      turnsUsed: 4,
      toolCalls: [{}, {}, {}],
    })) as unknown as ReturnType<typeof vi.fn> & typeof runAgentLoop;
    return {
      provider,
      states: new Map([["c", state(cloneDir)]]),
      loadProject: vi.fn(async () => ({ name: "Proj", description: "Desc", databaseAware: false })),
      assembleSeeds: vi.fn(async () => seeds),
      graphTools: vi.fn(() => [graphTool]),
      extractRequirements: vi.fn(async () => [{ id: "NR-1", text: "Change the total" }]),
      runLoop,
      ...overrides,
    } as MaterializedAgentPassDeps & { runLoop: ReturnType<typeof vi.fn> };
  }

  it("runs production's seeded pass on the graph tools, on the repository's project and clone", async () => {
    const deps = depsWith(root);
    const result = await createMaterializedAgentPass(deps)({
      corpus: "c",
      repo: "r",
      text: "Change the total",
      toolset: "graph",
    });
    expect(result).toEqual({
      citations: [{ filePath: "a.go", startLine: 1, endLine: 2, confidence: 0.5 }],
      turns: 4,
      toolCalls: 3,
      answered: true,
    });
    expect(deps.assembleSeeds).toHaveBeenCalledWith({
      projectId: "proj-r",
      projectName: "Proj",
      projectDescription: "Desc",
      extraInstructions: "Change the total",
      requirements: [{ id: "NR-1", text: "Change the total" }],
      databaseAware: false,
    });
    expect(deps.graphTools).toHaveBeenCalledWith(root);
    const [, input, options] = deps.runLoop.mock.calls[0]!;
    expect(input.tools).toEqual([graphTool]);
    expect(input.toolContext).toEqual({
      projectId: "proj-r",
      connectorId: "conn-r",
      cloneDir: root,
    });
    expect(input.userMessage).toContain("AFFECTED");
    expect(input.systemMessage).toContain("searching the code graph");
    expect(options).toMatchObject({ maxTurns: 10, model: "claude-sonnet-5-5" });
  });

  it("gives A3N the file tools, no seeds and the file-tools prompt", async () => {
    const deps = depsWith(root);
    await createMaterializedAgentPass(deps)({
      corpus: "c",
      repo: "r",
      text: "t",
      toolset: "files",
    });
    expect(deps.assembleSeeds).not.toHaveBeenCalled();
    expect(deps.graphTools).not.toHaveBeenCalled();
    const [, input] = deps.runLoop.mock.calls[0]!;
    expect(input.tools.map((t: AgentTool) => t.name)).toEqual(FILE_ONLY_TOOLS.map((t) => t.name));
    expect(input.systemMessage).toContain("grep_files");
    expect(input.userMessage).not.toContain("FUSED");
  });

  it("offers no clone that is not on disk, and passes the text as one requirement when none is extracted", async () => {
    const missing = path.join(root, "absent");
    const deps = depsWith(missing, { extractRequirements: vi.fn(async () => []) });
    await createMaterializedAgentPass(deps)({
      corpus: "c",
      repo: "r",
      text: "Just this",
      toolset: "graph",
    });
    expect(deps.graphTools).toHaveBeenCalledWith(undefined);
    const [, input] = deps.runLoop.mock.calls[0]!;
    expect(input.toolContext).toEqual({ projectId: "proj-r", connectorId: "conn-r" });
    expect(input.userMessage).toContain("[NR-1] Just this");
    expect(input.systemMessage).toContain("NO WORKING TREE");
  });

  it("refuses an A3N pass with no clone on disk instead of scoring about 0 at full cost (#1810)", async () => {
    const missing = path.join(root, "absent");
    const deps = depsWith(missing);
    await expect(
      createMaterializedAgentPass(deps)({ corpus: "c", repo: "r", text: "t", toolset: "files" }),
    ).rejects.toThrow(
      new RegExp(
        `A3N needs the clone of c/r, and ${missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is not a directory: run pnpm eval:materialize c`,
      ),
    );
    expect(deps.runLoop).not.toHaveBeenCalled();
    expect(deps.extractRequirements).not.toHaveBeenCalled();
  });

  it("fails the A3N preflight before any pass when a clone is missing, naming every one (#1819)", async () => {
    const missing = path.join(root, "gone");
    const two = state(root);
    two.repos.push({ ...two.repos[0]!, name: "s", cloneDir: missing });
    await expect(assertA3NClones(new Map([["c", state(root)]]))).resolves.toBeUndefined();
    await expect(
      assertA3NClones(
        new Map([
          ["c", two],
          ["d", state(path.join(root, "also-gone"))],
        ]),
      ),
    ).rejects.toThrow(
      /A3N needs every repository's clone[\s\S]*c\/s \(.*gone\): run pnpm eval:materialize c[\s\S]*d\/r \(.*also-gone\): run pnpm eval:materialize d/,
    );
    // The clone that is on disk is not listed.
    await expect(assertA3NClones(new Map([["c", two]]))).rejects.not.toThrow(/c\/r /);
  });

  it("refuses a corpus or a repository that is not materialized", async () => {
    const pass = createMaterializedAgentPass(depsWith(root));
    await expect(pass({ corpus: "other", repo: "r", text: "t", toolset: "graph" })).rejects.toThrow(
      /other is not materialized: run pnpm eval:materialize other/,
    );
    await expect(pass({ corpus: "c", repo: "zz", text: "t", toolset: "graph" })).rejects.toThrow(
      /repository zz is not materialized/,
    );
  });
});
