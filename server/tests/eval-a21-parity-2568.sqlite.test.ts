/**
 * #2568 — the localization eval's A21 arm runs the pass production runs in
 * explore mode, so the eval cannot drift from it.
 *
 * The same requirements, project and clone go through BOTH:
 *   - production: the real `runAgenticCodeAgent` with
 *     `ANALYSIS_CODE_EXPLORATION=explore`, over a real SQLite database;
 *   - the eval: `createMaterializedAgentPass` with the `production-explore`
 *     tool set (A21), seeded by production's `assembleAgenticPassSeeds`.
 * Every `runAgentLoop` call is recorded, and the two are compared: the same
 * system and user messages, the same tools, and the same loop options
 * (`maxTurns`, `maxTokens`, transcript compaction, prompt caching, the
 * final-answer retry, the continuation's nudge budget), with the continuation
 * driven to show it nudges the same way. Two options are production's alone and
 * left out: the abort `signal` (the eval has no deadline) and `model` (the
 * orchestrator passes `input.model`, unset here; the eval names the provider's).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";
import type { FusedCodeSearcher, SymbolLineLookup } from "../src/lib/rag/fused-code-context.js";

const state = vi.hoisted(() => ({
  db: null as unknown,
  loopCalls: [] as unknown[][],
}));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
    resolveDatabaseProvider: () => "sqlite",
  };
});
vi.mock("../src/lib/analysis/analysis-service.js", async (original) => ({
  ...(await original<typeof import("../src/lib/analysis/analysis-service.js")>()),
  persistAgentResult: vi.fn(async () => ({ id: "ar-2568", findingIds: [] })),
}));
vi.mock("../src/lib/rag/embedder.js", async (original) => ({
  ...(await original<typeof import("../src/lib/rag/embedder.js")>()),
  getEmbedder: () => ({ model: "embed-a", knownIdentity: () => "embed-a|mean" }),
}));
// Every `runAgentLoop` call is recorded, production's and the eval's; the loop runs for real.
vi.mock("../src/lib/analysis/agent-loop.js", async (original) => {
  const real = await original<typeof import("../src/lib/analysis/agent-loop.js")>();
  return {
    ...real,
    runAgentLoop: async (...args: Parameters<typeof real.runAgentLoop>) => {
      state.loopCalls.push(args);
      return real.runAgentLoop(...args);
    },
  };
});

const { AnalysisOrchestrator } = await import("../src/lib/analysis/orchestrator.js");
const { createCapabilityTracker } = await import("../src/lib/analysis/analysis-capability.js");
const { __resetConfigSingleton } = await import("../src/lib/config/config-service.js");
const { assembleAgenticPassSeeds, resolveAgenticMaxTurns } =
  await import("../src/lib/analysis/agentic-pass-context.js");
const { EXPLORER_NUDGE } = await import("../src/lib/analysis/code-pass-variant.js");
const { createSearchSymbolsTool } = await import("../src/lib/analysis/tools/search-symbols.js");
const { searchCodeGraphTool } = await import("../src/lib/analysis/tools/search-code-graph.js");
const { createMaterializedAgentPass } = await import("../src/lib/eval/localization/agent-pass.js");

const USER = "u-2568";
const PROJECT = "p-2568";
const REPO = "rc-2568";
const GRAPH = "g-2568";
const ANSWER = JSON.stringify({ agentKey: "code", summary: "done", findings: [], notes: [] });
const TEXT = "Compute the fee.";

type LoopCall = [
  unknown,
  {
    systemMessage: string;
    userMessage: string;
    tools: Array<{ name: string; description: string; parameters: unknown }>;
  },
  Record<string, unknown> & {
    continuation: {
      maxNudges: number;
      nudge: (reply: string, state: Record<string, number>) => string | null;
    };
    onToolCall: (call: unknown) => void;
  },
];

/** A loop call's input and options, functions named rather than serialised; `signal` and `model` left out. */
function describeLoopCall(call: unknown[]): unknown {
  const [, input, options] = call as LoopCall;
  const { signal: _signal, model: _model, ...rest } = options;
  return {
    systemMessage: input.systemMessage,
    userMessage: input.userMessage,
    tools: input.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
    options: JSON.parse(
      JSON.stringify(rest, (_key, value: unknown) =>
        typeof value === "function" ? "[function]" : value,
      ),
    ) as unknown,
  };
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2568 — A21 runs production's explore-mode pass (real SQLite, real clone)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let cloneRoot: string;
    const savedCloneDir = process.env.REPO_CLONE_DIR;
    const searcher: FusedCodeSearcher = {
      search: async () => [
        {
          symbolId: "s-fee",
          filePath: "src/fee.ts",
          name: "computeFee",
          kind: "function",
          score: 0.8,
        },
      ],
    };
    const lineLookup: SymbolLineLookup = {
      resolve: async (ids) =>
        new Map(ids.map((id) => [id, { filePath: "src/fee.ts", startLine: 1, endLine: 3 }])),
    };
    const fusedCode = { searcher, lineLookup };
    const provider = {
      key: "offline-stub",
      model: "stub",
      offline: true,
      chat: vi.fn(async () => ({
        content: ANSWER,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "stub",
        provider: "offline-stub",
      })),
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("eval-a21-parity-2568");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: "ana", displayName: "ana", email: "ana@example.test" },
      });
      await db.project.create({
        data: { id: PROJECT, name: "Fees", slug: PROJECT, createdById: USER },
      });
      await db.repoConnection.create({
        data: { id: REPO, projectId: PROJECT, label: "app", isPrimary: true },
      });
      await db.codeGraph.create({
        data: {
          id: GRAPH,
          projectId: PROJECT,
          repoConnectionId: REPO,
          commitSha: "a".repeat(40),
          lastIndexedAt: new Date(),
        },
      });
      cloneRoot = mkdtempSync(path.join(os.tmpdir(), "metis-2568-"));
      mkdirSync(path.join(cloneRoot, REPO, "src"), { recursive: true });
      writeFileSync(
        path.join(cloneRoot, REPO, "src", "fee.ts"),
        "export function computeFee() {}\n",
      );
      process.env.REPO_CLONE_DIR = cloneRoot;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterEach(() => {
      state.loopCalls.length = 0;
      delete process.env.ANALYSIS_CODE_EXPLORATION;
      __resetConfigSingleton();
    });

    afterAll(async () => {
      if (savedCloneDir === undefined) delete process.env.REPO_CLONE_DIR;
      else process.env.REPO_CLONE_DIR = savedCloneDir;
      await db?.$disconnect();
      sqlite?.cleanup();
      if (cloneRoot) rmSync(cloneRoot, { recursive: true, force: true });
    });

    /** Production's explore pass over `requirements`: its one `runAgentLoop` call. */
    async function production(requirements: Array<{ id: string; text: string }>) {
      process.env.ANALYSIS_CODE_EXPLORATION = "explore";
      __resetConfigSingleton();
      const analysisId = `an-2568-${requirements.length}`;
      await db.analysis.upsert({
        where: { id: analysisId },
        create: { id: analysisId, projectId: PROJECT, status: "completed", startedById: USER },
        update: {},
      });
      const orch = new AnalysisOrchestrator({
        provider: provider as never,
        retrieve: async () => [],
        knowledge: { search: async () => ({ hits: [] }) } as never,
        fusedCode,
        prepareRepoClone: async () => "healthy",
      }) as unknown as {
        capabilities: Map<string, ReturnType<typeof createCapabilityTracker>>;
        runAgenticCodeAgent: (input: Record<string, unknown>) => Promise<unknown>;
      };
      orch.capabilities.set(
        analysisId,
        createCapabilityTracker({
          static: {
            codeGraphPresent: true,
            repoSourceIngested: true,
            fusedCodeRetrievalEnabled: true,
            schemaContextEnabled: true,
          },
          codeAnalysisRequested: true,
          databaseAnalysisRequested: false,
        }),
      );
      const before = state.loopCalls.length;
      await orch.runAgenticCodeAgent({
        analysisId,
        projectId: PROJECT,
        projectName: "Fees",
        projectDescription: "fees",
        extraInstructions: TEXT,
        requirements,
        signal: new AbortController().signal,
        connectorId: REPO,
      });
      expect(state.loopCalls.length - before).toBe(1);
      return state.loopCalls.at(-1)!;
    }

    /** A21's pass over the same requirements, project and clone: its one `runAgentLoop` call. */
    async function a21(requirements: Array<{ id: string; text: string }>) {
      // The platform default is what production read above; A21 does not read it.
      delete process.env.ANALYSIS_CODE_EXPLORATION;
      __resetConfigSingleton();
      const pass = createMaterializedAgentPass({
        provider: provider as never,
        states: new Map([
          [
            "c",
            {
              version: 1,
              corpus: "c",
              databaseUrl: sqlite.url,
              cloneRoot,
              lancedbPath: path.join(cloneRoot, "lancedb"),
              embedModel: "embed-a",
              materializedAt: "t",
              repos: [
                {
                  name: "app",
                  url: "u",
                  sha: "a".repeat(40),
                  projectId: PROJECT,
                  connectorId: REPO,
                  cloneDir: path.join(cloneRoot, REPO),
                  symbols: 1,
                },
              ],
            },
          ],
        ]),
        loadProject: async () => ({ name: "Fees", description: "fees", databaseAware: false }),
        assembleSeeds: (input) => assembleAgenticPassSeeds({ ...input, deps: { fusedCode } }),
        graphTools: () => {
          throw new Error("A21 never reads the graph tool set");
        },
        explorerSearchTools: () => ({
          searchCodeGraph: searchCodeGraphTool,
          searchCodeSymbols: createSearchSymbolsTool(fusedCode, { filters: true }),
        }),
        extractRequirements: async () => requirements,
      });
      const before = state.loopCalls.length;
      const result = await pass({
        corpus: "c",
        repo: "app",
        text: TEXT,
        toolset: "production-explore",
      });
      expect(state.loopCalls.length - before).toBe(1);
      expect(result.answered).toBe(true);
      return state.loopCalls.at(-1)!;
    }

    const requirementsOf = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `NR-${i + 1}`, text: `${TEXT} (${i + 1})` }));

    it.each([1, 6])(
      "with %i requirement(s): the same prompt, tools, turn cap, budget, compaction and retry",
      async (n) => {
        const requirements = requirementsOf(n);
        const prod = await production(requirements);
        const eval21 = await a21(requirements);
        expect(describeLoopCall(eval21)).toEqual(describeLoopCall(prod));
        // Spelled out, so a failure names the bound that drifted.
        const [, , p] = prod as LoopCall;
        const [, , e] = eval21 as LoopCall;
        expect(e.maxTurns).toBe(p.maxTurns);
        expect(e.maxTurns).toBe(resolveAgenticMaxTurns(n));
        expect(e.maxTokens).toBe(p.maxTokens);
        expect(e.transcriptCompaction).toEqual(p.transcriptCompaction);
        expect((prod as LoopCall)[1].tools.map((t) => t.name)).toEqual([
          "grep_files",
          "list_files",
          "read_file_slice",
          "search_code_graph",
          "search_code_symbols",
        ]);
      },
    );

    // The eval reads production's settings, not A20's constants: an operator's
    // read cap, transcript ceiling, turn floor and token budget reach both.
    it("follows production's settings, not the eval's own constants", async () => {
      const settings = {
        ANALYSIS_EXPLORE_READ_MAX_LINES: "400",
        ANALYSIS_EXPLORE_TRANSCRIPT_TOKENS: "12000",
        ANALYSIS_AGENTIC_MAX_TURNS: "14",
        ANALYSIS_AGENT_TOKEN_BUDGET: "50000",
      };
      Object.assign(process.env, settings);
      try {
        const requirements = requirementsOf(2);
        const prod = await production(requirements);
        const eval21 = await a21(requirements);
        expect(describeLoopCall(eval21)).toEqual(describeLoopCall(prod));
        const [, input, options] = eval21 as LoopCall;
        expect(options.maxTurns).toBe(14);
        expect(options.maxTokens).toBeLessThanOrEqual(50_000);
        expect(options.transcriptCompaction).toMatchObject({ maxTranscriptTokens: 12_000 });
        expect(input.tools.find((t) => t.name === "read_file_slice")!.description).toMatch(
          /max 400 lines/,
        );
      } finally {
        for (const key of Object.keys(settings)) delete process.env[key];
      }
    });

    it("the same continuation: the explorer nudge once before any tool call, then #1388's", async () => {
      const requirements = requirementsOf(2);
      /** The nudges a pass's model was sent: the user turns after the first, call by call. */
      const nudgesOf = async (run: () => Promise<unknown>) => {
        const from = provider.chat.mock.calls.length;
        const call = await run();
        const calls = provider.chat.mock.calls.slice(from) as unknown as Array<
          [Array<{ role: string; content: unknown }>]
        >;
        const last = calls.at(-1)![0];
        return {
          maxNudges: (call as LoopCall)[2].continuation.maxNudges,
          modelCalls: calls.length,
          nudges: last
            .filter((m) => m.role === "user")
            .map((m) => m.content)
            .slice(1),
        };
      };
      // The stub answers at once, before any tool call, on every turn.
      const prod = await nudgesOf(() => production(requirements));
      const eval21 = await nudgesOf(() => a21(requirements));
      expect(eval21).toEqual(prod);
      expect(prod.nudges[0]).toBe(EXPLORER_NUDGE);
      expect(prod.nudges.filter((n) => n === EXPLORER_NUDGE)).toHaveLength(1);
      // …and #1388's continuation sent the tool-less answers back after it.
      expect(prod.nudges.length).toBeGreaterThan(1);
    });
  },
);
