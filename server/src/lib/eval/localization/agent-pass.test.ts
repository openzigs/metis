import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AIProvider } from "../../ai/types.js";
import type { runAgentLoop } from "../../analysis/agent-loop.js";
import { buildAgenticPassPrompt } from "../../analysis/agentic-pass-context.js";
import type { AgentTool } from "../../analysis/tools/types.js";
import {
  assertClonesFor,
  citationsFromAnswer,
  citationsOfLoop,
  createMaterializedAgentPass,
  EXPLORER_NUDGE,
  explorerSystemMessage,
  explorerTools,
  FILE_ONLY_TOOLS,
  filesOnlySystemMessage,
  NO_SEEDS,
  withSearchPrimitives,
  type MaterializedAgentPassDeps,
} from "./agent-pass.js";
import { grepFilesTool } from "../../analysis/tools/grep-files.js";
import {
  buildExploreCodePass,
  EXPLORER_STEPS as PRODUCTION_EXPLORER_STEPS,
} from "../../analysis/code-pass-variant.js";
import { EXPLORER_MAX_TURNS, EXPLORER_TRANSCRIPT_TOKENS } from "./arm-core.js";
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
    expect(deps.graphTools).toHaveBeenCalledWith(root, false);
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

  it("gives A3P production's seeded pass with the search primitives asked for (#2327)", async () => {
    const deps = depsWith(root);
    await createMaterializedAgentPass(deps)({
      corpus: "c",
      repo: "r",
      text: "t",
      toolset: "graph-primitives",
    });
    expect(deps.assembleSeeds).toHaveBeenCalled();
    expect(deps.graphTools).toHaveBeenCalledWith(root, true);
    const [, input] = deps.runLoop.mock.calls[0]!;
    // Production's prompt, not the file-tools one.
    expect(input.systemMessage).toContain("searching the code graph");
  });

  it("withSearchPrimitives swaps in the filtered symbol tool and adds grep_files with a clone (#2327)", () => {
    const tool = (name: string, description = name): AgentTool => ({
      name,
      description,
      parameters: { type: "object" },
      execute: vi.fn(),
    });
    const graph = [tool("search_code_graph"), tool("search_code_symbols", "plain")];
    const filtered = tool("search_code_symbols", "filtered");
    const withClone = withSearchPrimitives(graph, root, filtered);
    expect(withClone.map((t) => t.description)).toEqual([
      "search_code_graph",
      "filtered",
      grepFilesTool.description,
    ]);
    expect(withSearchPrimitives(graph, undefined, filtered).map((t) => t.name)).toEqual([
      "search_code_graph",
      "search_code_symbols",
    ]);
    // grep_files is never offered twice.
    expect(
      withSearchPrimitives([...graph, grepFilesTool], root, filtered).filter(
        (t) => t.name === "grep_files",
      ),
    ).toHaveLength(1);
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
    expect(deps.graphTools).toHaveBeenCalledWith(undefined, false);
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
    await expect(assertClonesFor(new Map([["c", state(root)]]), "A3N")).resolves.toBeUndefined();
    await expect(
      assertClonesFor(
        new Map([
          ["c", two],
          ["d", state(path.join(root, "also-gone"))],
        ]),
        "A3N",
      ),
    ).rejects.toThrow(
      /A3N needs every repository's clone[\s\S]*c\/s \(.*gone\): run pnpm eval:materialize c[\s\S]*d\/r \(.*also-gone\): run pnpm eval:materialize d/,
    );
    // The clone that is on disk is not listed.
    await expect(assertClonesFor(new Map([["c", two]]), "A3N")).rejects.not.toThrow(/c\/r /);
  });

  describe("the explorer pass (A20, #2560)", () => {
    const searchCodeGraph = { name: "search_code_graph" } as AgentTool;
    const searchCodeSymbols = { name: "search_code_symbols" } as AgentTool;
    const explorerDeps = (overrides: Partial<MaterializedAgentPassDeps> = {}) =>
      depsWith(root, {
        explorerSearchTools: () => ({ searchCodeGraph, searchCodeSymbols }),
        spentUsd: () => 0,
        ...overrides,
      });

    it("explores with the file tools and the searches, the seeds as hints, 30 turns and no token budget", async () => {
      const deps = explorerDeps();
      const result = await createMaterializedAgentPass(deps)({
        corpus: "c",
        repo: "r",
        text: "Change the total",
        toolset: "explorer",
        costCapUsd: 1,
      });
      expect(result.answered).toBe(true);
      expect(result.citations).toHaveLength(1);
      expect(deps.assembleSeeds).toHaveBeenCalled();
      expect(deps.graphTools).not.toHaveBeenCalled();
      const [, input, options] = deps.runLoop.mock.calls[0]!;
      expect(input.tools.map((t: AgentTool) => t.name)).toEqual([
        "grep_files",
        "list_files",
        "read_file_slice",
        "search_code_graph",
        "search_code_symbols",
      ]);
      expect(input.tools[2].description).toMatch(
        /whole file; max 1000 lines and 80000 characters per call/,
      );
      expect(input.userMessage).toContain("AFFECTED");
      expect(input.systemMessage).toMatch(/HINTS from a search, not an answer/);
      expect(input.systemMessage).not.toContain("search_knowledge");
      expect(options.maxTurns).toBe(EXPLORER_MAX_TURNS);
      expect(options).not.toHaveProperty("maxTokens");
      expect(options.transcriptCompaction).toMatchObject({
        maxTranscriptTokens: EXPLORER_TRANSCRIPT_TOKENS,
      });
    });

    // #2565 — A20 is built from production's explore pass, so the two cannot drift.
    it("runs production's explore-mode steps and tools, not a copy of them", async () => {
      const deps = explorerDeps();
      await createMaterializedAgentPass(deps)({
        corpus: "c",
        repo: "r",
        text: "Change the total",
        toolset: "explorer",
        costCapUsd: 1,
      });
      const [, input] = deps.runLoop.mock.calls[0]!;
      expect(input.systemMessage).toContain(PRODUCTION_EXPLORER_STEPS);
      const production = buildExploreCodePass({
        search: { searchCodeGraph, searchCodeSymbols },
        providerKey: "offline-stub",
        model: "stub",
      });
      const shape = (tools: AgentTool[]) =>
        tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
      expect(shape(input.tools)).toEqual(shape(production.tools));
    });

    it("sends an answer given before any tool call back once, to explore first", async () => {
      const deps = explorerDeps();
      await createMaterializedAgentPass(deps)({
        corpus: "c",
        repo: "r",
        text: "t",
        toolset: "explorer",
      });
      const [, , options] = deps.runLoop.mock.calls[0]!;
      const state = { turnsUsed: 1, turnsLeft: 29, nudgesSent: 0 };
      expect(options.continuation.maxNudges).toBe(1);
      expect(options.continuation.nudge("{}", state)).toBe(EXPLORER_NUDGE);
      options.onToolCall({ tool: "grep_files", args: {}, resultPreview: "" });
      expect(options.continuation.nudge("{}", state)).toBeNull();
    });

    it("gives the production passes no nudge, no model caller and their token budget", async () => {
      const deps = explorerDeps();
      await createMaterializedAgentPass(deps)({
        corpus: "c",
        repo: "r",
        text: "t",
        toolset: "graph",
      });
      const [, , options] = deps.runLoop.mock.calls[0]!;
      expect(options).not.toHaveProperty("continuation");
      expect(options).not.toHaveProperty("callModel");
      expect(options.maxTokens).toBeGreaterThan(0);
    });

    it("calls the model until the pass's cap is spent, then stops with no answer", async () => {
      let spent = 0;
      const chat = vi.fn(async () => {
        spent += 0.4;
        return { content: "x", model: "m" };
      });
      const runLoop = vi.fn(async (_p: unknown, _i: unknown, options: Record<string, unknown>) => {
        const call = options.callModel as (m: unknown[], o: unknown) => Promise<unknown>;
        const onToolCall = options.onToolCall as () => void;
        // Bounded, so a cap that never fires fails the count below instead of hanging.
        for (let turn = 0; turn < 10; turn++) {
          await call([], {});
          onToolCall();
        }
        return { finalResponse: answer([]), hasFinalAnswer: true, turnsUsed: 10, toolCalls: [] };
      }) as unknown as typeof runAgentLoop;
      const deps = explorerDeps({
        provider: { ...provider, chat } as unknown as AIProvider,
        spentUsd: () => spent,
        runLoop,
      });
      const result = await createMaterializedAgentPass(deps)({
        corpus: "c",
        repo: "r",
        text: "t",
        toolset: "explorer",
        costCapUsd: 1,
      });
      // 0.4, 0.8, 1.2: the third call crosses the cap, the fourth never starts.
      expect(chat).toHaveBeenCalledTimes(3);
      expect(result).toEqual({ citations: [], turns: 3, toolCalls: 3, answered: false });
    });

    it("stops with no answer when the cap is reached at the real loop's final-answer retry", async () => {
      // The real runAgentLoop: its final-answer retry catches and degrades on
      // any error, so the cap there must still end the pass with no answer.
      const valid = JSON.stringify({
        agentKey: "code",
        summary: "s",
        findings: [
          {
            category: "architecture",
            severity: "medium",
            title: "t",
            body: "b",
            tags: [],
            citations: [{ filePath: "a.go", startLine: 1, endLine: 2 }],
          },
        ],
        notes: [],
      });
      // Turn 1 answers before any tool call (the nudge sends it back), turn 2
      // answers with prose, so the loop reaches its retry with $1.00 spent.
      const replies = [valid, "no json"];
      let spent = 0;
      const chat = vi.fn(async () => {
        spent += 0.5;
        return { content: replies.shift() ?? "never", model: "m" };
      });
      const { runLoop: _stub, ...rest } = explorerDeps({
        provider: { ...provider, chat } as unknown as AIProvider,
        spentUsd: () => spent,
      });
      const result = await createMaterializedAgentPass(rest)({
        corpus: "c",
        repo: "r",
        text: "t",
        toolset: "explorer",
        costCapUsd: 1,
      });
      expect(chat).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ citations: [], turns: 2, toolCalls: 0, answered: false });
    });

    it("reads the cap against what the meter had spent when the pass began", async () => {
      let spent = 5;
      const chat = vi.fn(async () => {
        spent += 0.4;
        return { content: "x", model: "m" };
      });
      const runLoop = vi.fn(async (_p: unknown, _i: unknown, options: Record<string, unknown>) => {
        const call = options.callModel as (m: unknown[], o: unknown) => Promise<unknown>;
        await call([], {});
        return {
          finalResponse: answer([]),
          hasFinalAnswer: true,
          turnsUsed: 1,
          toolCalls: [],
        };
      }) as unknown as typeof runAgentLoop;
      const deps = explorerDeps({
        provider: { ...provider, chat } as unknown as AIProvider,
        spentUsd: () => spent,
        runLoop,
      });
      const result = await createMaterializedAgentPass(deps)({
        corpus: "c",
        repo: "r",
        text: "t",
        toolset: "explorer",
        costCapUsd: 1,
      });
      expect(chat).toHaveBeenCalledTimes(1);
      expect(result.answered).toBe(true);
    });

    it("rethrows a provider failure that is not the cap", async () => {
      const runLoop = vi.fn(async () => {
        throw new Error("provider down");
      }) as unknown as typeof runAgentLoop;
      await expect(
        createMaterializedAgentPass(explorerDeps({ runLoop }))({
          corpus: "c",
          repo: "r",
          text: "t",
          toolset: "explorer",
        }),
      ).rejects.toThrow(/provider down/);
    });

    it("refuses to run without its clone, its search tools or the meter", async () => {
      const missing = path.join(root, "absent");
      const noClone = depsWith(missing, {
        explorerSearchTools: () => ({ searchCodeGraph, searchCodeSymbols }),
        spentUsd: () => 0,
      });
      const request = { corpus: "c", repo: "r", text: "t", toolset: "explorer" } as const;
      await expect(createMaterializedAgentPass(noClone)(request)).rejects.toThrow(
        /A20 needs the clone of c\/r/,
      );
      await expect(createMaterializedAgentPass(depsWith(root))(request)).rejects.toThrow(
        /A20 needs the explorer's search tools and the run meter/,
      );
      expect(noClone.runLoop).not.toHaveBeenCalled();
    });

    it("names A20 in the clone preflight", async () => {
      const missing = state(path.join(root, "nowhere"));
      await expect(assertClonesFor(new Map([["c", missing]]), "A20")).rejects.toThrow(
        /^A20 needs every repository's clone/,
      );
    });

    it("explorerSystemMessage swaps in the exploring steps and refuses a changed prompt", () => {
      const { systemMessage } = buildAgenticPassPrompt({
        projectName: "p",
        projectDescription: "d",
        requirements: [{ id: "NR-1", text: "t" }],
        seeds: NO_SEEDS,
        fileToolsAvailable: true,
      });
      const explored = explorerSystemMessage(systemMessage);
      expect(explored).toContain("grep_files");
      expect(explored).not.toMatch(/search_knowledge|searching the code graph/);
      expect(() => explorerSystemMessage("something else")).toThrow(
        /explore: the agentic code prompt/,
      );
    });

    it("explorerTools puts the file tools first, then the searches", () => {
      expect(explorerTools({ searchCodeGraph, searchCodeSymbols }).map((t) => t.name)).toEqual([
        "grep_files",
        "list_files",
        "read_file_slice",
        "search_code_graph",
        "search_code_symbols",
      ]);
    });
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
