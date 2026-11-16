/**
 * #2565 — the analysis code pass's explore-first mode, driven through the real
 * `runAgenticCodeAgent` over a real SQLite database and a real clone:
 *
 *   - `fast` hands `runAgentLoop` exactly what `main` handed it before #2565
 *     (the snapshot below was written from `main`, before the change);
 *   - a connector with no clone runs `fast`, and the run's capability record,
 *     persisted and read back through the analysis snapshot in a fresh
 *     client, says so (`no-working-tree`).
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
  loopResults: [] as unknown[],
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
  persistAgentResult: vi.fn(async () => ({ id: "ar-2565", findingIds: [] })),
}));
vi.mock("../src/lib/rag/embedder.js", async (original) => ({
  ...(await original<typeof import("../src/lib/rag/embedder.js")>()),
  getEmbedder: () => ({ model: "embed-a", knownIdentity: () => "embed-a|mean" }),
}));
// Every `runAgentLoop` call and result is recorded; the loop runs for real.
vi.mock("../src/lib/analysis/agent-loop.js", async (original) => {
  const real = await original<typeof import("../src/lib/analysis/agent-loop.js")>();
  return {
    ...real,
    runAgentLoop: async (...args: Parameters<typeof real.runAgentLoop>) => {
      state.loopCalls.push(args);
      const result = await real.runAgentLoop(...args);
      state.loopResults.push(result);
      return result;
    },
  };
});

const { AnalysisOrchestrator } = await import("../src/lib/analysis/orchestrator.js");
const { createCapabilityTracker, finalizeCapability } =
  await import("../src/lib/analysis/analysis-capability.js");
const { getAnalysisSnapshot, persistAnalysisCapability } =
  await import("../src/lib/analysis/analysis-service.js");
const { __resetConfigSingleton } = await import("../src/lib/config/config-service.js");
const { resolveAgenticMaxTurns } = await import("../src/lib/analysis/agentic-pass-context.js");
const { EXPLORER_NUDGE, EXPLORER_STEPS } = await import("../src/lib/analysis/code-pass-variant.js");
type AgentLoopResult = import("../src/lib/analysis/agent-loop.js").AgentLoopResult;

const USER = "u-2565";
const PROJECT = "p-2565";
const REPO = "rc-2565";
const GRAPH = "g-2565";
const ANSWER = JSON.stringify({ agentKey: "code", summary: "done", findings: [], notes: [] });

/** What a `runAgentLoop` call was handed, with functions and the signal named, not serialised. */
function describeLoopCall(call: unknown[]): unknown {
  const [, input, options] = call as [
    unknown,
    {
      systemMessage: string;
      userMessage: string;
      tools: Array<{ name: string; description: string; parameters: unknown }>;
    },
    Record<string, unknown>,
  ];
  return {
    systemMessage: input.systemMessage,
    userMessage: input.userMessage,
    tools: input.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
    options: JSON.parse(
      JSON.stringify(options, (key, value: unknown) =>
        key === "signal" ? "[signal]" : typeof value === "function" ? "[function]" : value,
      ),
    ) as unknown,
  };
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2565 — the code pass mode (real SQLite, real clone)",
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

    beforeAll(async () => {
      sqlite = createMigratedSqlite("code-pass-mode-2565");
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
      cloneRoot = mkdtempSync(path.join(os.tmpdir(), "metis-2565-"));
      mkdirSync(path.join(cloneRoot, REPO, "src"), { recursive: true });
      writeFileSync(
        path.join(cloneRoot, REPO, "src", "fee.ts"),
        "export function computeFee() {}\n",
      );
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterEach(() => {
      state.loopCalls.length = 0;
      state.loopResults.length = 0;
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

    type Orch = {
      capabilities: Map<string, ReturnType<typeof createCapabilityTracker>>;
      runAgenticCodeAgent: (input: Record<string, unknown>) => Promise<unknown>;
    };

    /** The messages of every model call, in order. */
    const sent: Array<Array<{ role: string; content: unknown }>> = [];
    /** A model reply: the stub's script is `(call number) => reply`. */
    type Script = (call: number) => string;
    const ALWAYS_ANSWER: Script = () => ANSWER;

    /** An orchestrator whose stub model follows `script`, and a tracker for `analysisId`. */
    const orchestratorFor = async (
      analysisId: string,
      clone: "healthy" | "unusable",
      script: Script = ALWAYS_ANSWER,
      opts: { tokensPerCall?: number; onCall?: (call: number) => void } = {},
    ) => {
      sent.length = 0;
      await db.analysis.upsert({
        where: { id: analysisId },
        create: { id: analysisId, projectId: PROJECT, status: "completed", startedById: USER },
        update: { metadata: null },
      });
      let calls = 0;
      const tokens = opts.tokensPerCall ?? 2;
      const orch = new AnalysisOrchestrator({
        provider: {
          key: "offline-stub",
          model: "stub",
          offline: true,
          chat: vi.fn(async (messages: Array<{ role: string; content: unknown }>) => {
            sent.push(messages.map((m) => ({ ...m })));
            const n = calls++;
            opts.onCall?.(n);
            return {
              content: script(n),
              usage: {
                promptTokens: tokens / 2,
                completionTokens: tokens / 2,
                totalTokens: tokens,
              },
              model: "stub",
              provider: "offline-stub",
            };
          }),
        } as never,
        retrieve: async () => [],
        knowledge: { search: async () => ({ hits: [] }) } as never,
        fusedCode: { searcher, lineLookup },
        prepareRepoClone: async () => clone,
      }) as unknown as Orch;
      const tracker = createCapabilityTracker({
        static: {
          codeGraphPresent: true,
          repoSourceIngested: true,
          fusedCodeRetrievalEnabled: true,
          schemaContextEnabled: true,
        },
        codeAnalysisRequested: true,
        databaseAnalysisRequested: false,
      });
      orch.capabilities.set(analysisId, tracker);
      return { orch, tracker };
    };

    const run = (orch: Orch, analysisId: string, extra: Record<string, unknown> = {}) => {
      process.env.REPO_CLONE_DIR = cloneRoot;
      return orch.runAgenticCodeAgent({
        analysisId,
        projectId: PROJECT,
        projectName: "Fees",
        projectDescription: "fees",
        requirements: [{ id: "REQ-1", text: "Compute the fee." }],
        signal: new AbortController().signal,
        connectorId: REPO,
        ...extra,
      });
    };

    const setMode = (mode: "explore" | "fast") => {
      process.env.ANALYSIS_CODE_EXPLORATION = mode;
      __resetConfigSingleton();
    };
    type LoopArgs = [
      unknown,
      { systemMessage: string; tools: Array<{ name: string }> },
      { maxTurns: number; maxTokens: number; transcriptCompaction?: unknown },
    ];
    const loopCall = (i = 0) => state.loopCalls[i] as LoopArgs;
    const loopResult = (i = 0) => state.loopResults[i] as AgentLoopResult;
    const toolNames = (i = 0) => loopCall(i)[1].tools.map((t) => t.name);
    /** A model that never answers: a tool call on every turn. */
    const NEVER_ANSWERS: Script = (n) => JSON.stringify({ tool: "grep_files", text: `fee${n}` });
    /** How many times the model was told {@link EXPLORER_NUDGE}, over the run's last loop call. */
    const explorerNudges = () =>
      (sent.at(-1) ?? []).filter((m) => m.role === "user" && m.content === EXPLORER_NUDGE).length;

    it("fast: the system message, tools and loop options are byte-identical to main", async () => {
      setMode("fast");
      const { orch } = await orchestratorFor("an-2565-fast", "healthy");
      await run(orch, "an-2565-fast");
      expect(state.loopCalls).toHaveLength(1);
      expect(describeLoopCall(state.loopCalls[0]!)).toMatchSnapshot();
    });

    it("explore: A20's five tools and steps, under production's turn cap and token budget", async () => {
      setMode("fast");
      const fast = await orchestratorFor("an-2565-bounds-fast", "healthy");
      await run(fast.orch, "an-2565-bounds-fast");
      const fastOptions = loopCall(0)[2];
      setMode("explore");
      const explore = await orchestratorFor("an-2565-bounds", "healthy");
      await run(explore.orch, "an-2565-bounds");
      expect(toolNames(1)).toEqual([
        "grep_files",
        "list_files",
        "read_file_slice",
        "search_code_graph",
        "search_code_symbols",
      ]);
      expect(loopCall(1)[1].systemMessage).toContain(EXPLORER_STEPS);
      const options = loopCall(1)[2];
      expect(options.maxTurns).toBe(resolveAgenticMaxTurns(1));
      expect(options.maxTurns).toBe(fastOptions.maxTurns);
      expect(options.maxTokens).toBe(fastOptions.maxTokens);
      expect(options.transcriptCompaction).toMatchObject({ maxTranscriptTokens: 16_384 });
    });

    it("explore: a model that never answers stops at production's maxTurns, not at A20's 30", async () => {
      setMode("explore");
      const { orch, tracker } = await orchestratorFor("an-2565-turns", "healthy", NEVER_ANSWERS);
      await run(orch, "an-2565-turns");
      expect(loopResult().turnsUsed).toBe(resolveAgenticMaxTurns(1));
      expect(loopResult().turnsExhausted).toBe(true);
      expect(tracker.codePassOutcomes).toEqual([
        expect.objectContaining({ mode: "explore", maxTurns: 10, degradation: "turn-limit" }),
      ]);
    });

    it("explore: a model that never answers stops at ANALYSIS_AGENT_TOKEN_BUDGET", async () => {
      process.env.ANALYSIS_AGENT_TOKEN_BUDGET = "4000";
      setMode("explore");
      try {
        const { orch, tracker } = await orchestratorFor(
          "an-2565-budget",
          "healthy",
          NEVER_ANSWERS,
          { tokensPerCall: 1000 },
        );
        await run(orch, "an-2565-budget");
        expect(loopResult().budgetExhausted).toBe(true);
        expect(loopResult().turnsUsed).toBeLessThan(resolveAgenticMaxTurns(1));
        const [outcome] = tracker.codePassOutcomes ?? [];
        expect(outcome).toMatchObject({ mode: "explore", degradation: "token-budget" });
        expect(outcome!.tokenBudget).toBe(loopCall()[2].maxTokens);
        expect(outcome!.tokenBudget).toBeLessThanOrEqual(4000);
        expect(outcome!.tokensUsed).toBeGreaterThan(outcome!.tokenBudget);
        // Every call repeats nothing: each grep has its own text.
        expect(outcome!.repeatedToolCalls).toBe(0);
      } finally {
        delete process.env.ANALYSIS_AGENT_TOKEN_BUDGET;
      }
    });

    it("explore: an answer before any tool call is sent back once to explore, and only once", async () => {
      setMode("explore");
      const { orch } = await orchestratorFor("an-2565-nudge", "healthy");
      await run(orch, "an-2565-nudge");
      expect(explorerNudges()).toBe(1);
      const result = loopResult();
      expect(result.continuationNudges).toBeGreaterThanOrEqual(1);
      expect(result.continuationNudges).toBeLessThanOrEqual(3);
      // Nudged turns are ordinary turns: they count against maxTurns.
      expect(result.turnsUsed).toBe((result.continuationNudges ?? 0) + 1);
    });

    it("explore: a model that calls a tool first is never sent the explorer nudge", async () => {
      setMode("explore");
      const toolFirst: Script = (n) =>
        n === 0 ? JSON.stringify({ tool: "grep_files", text: "fee" }) : ANSWER;
      const { orch } = await orchestratorFor("an-2565-tool-first", "healthy", toolFirst);
      await run(orch, "an-2565-tool-first");
      expect(loopResult().toolCalls.map((c) => c.tool)).toEqual(["grep_files"]);
      expect(explorerNudges()).toBe(0);
    });

    it("fast: the explorer nudge is never sent", async () => {
      setMode("fast");
      const { orch } = await orchestratorFor("an-2565-fast-nudge", "healthy");
      await run(orch, "an-2565-fast-nudge");
      expect(explorerNudges()).toBe(0);
    });

    it("an aborted signal stops an explore pass the way it stops a fast pass", async () => {
      const outcomes: Record<string, { settled: string; calls: number }> = {};
      for (const mode of ["fast", "explore"] as const) {
        setMode(mode);
        const controller = new AbortController();
        const { orch } = await orchestratorFor(
          `an-2565-abort-${mode}`,
          "healthy",
          () => JSON.stringify({ tool: "list_files", pattern: "src/*.ts" }),
          { onCall: () => controller.abort() },
        );
        const settled = await run(orch, `an-2565-abort-${mode}`, {
          signal: controller.signal,
        }).then(
          () => "resolved",
          (err: Error) => err.name,
        );
        outcomes[mode] = { settled, calls: sent.length };
      }
      expect(outcomes.explore).toEqual(outcomes.fast);
      expect(outcomes.explore!.calls).toBe(1);
      expect(outcomes.explore!.settled).toBe("AbortError");
    });

    it("explore: an escalated run's deep and standard passes both explore", async () => {
      setMode("explore");
      const { orch, tracker } = await orchestratorFor("an-2565-escalation", "healthy");
      await run(orch, "an-2565-escalation", {
        requirements: [
          { id: "REQ-1", text: "Compute the fee." },
          { id: "REQ-2", text: "Round the fee." },
        ],
        escalation: {
          decisions: [
            { requirementId: "REQ-1", depth: "deep" },
            { requirementId: "REQ-2", depth: "standard" },
          ],
        },
      });
      expect(state.loopCalls).toHaveLength(2);
      for (const i of [0, 1]) {
        expect(toolNames(i)).toContain("grep_files");
        expect(loopCall(i)[1].systemMessage).toContain(EXPLORER_STEPS);
      }
      expect(tracker.codePassOutcomes?.map((o) => o.mode)).toEqual(["explore", "explore"]);
    });

    /** Persist the run's capability as the pipeline does, then read the snapshot in a fresh client. */
    const snapshotCapability = async (
      analysisId: string,
      tracker: ReturnType<typeof createCapabilityTracker>,
    ) => {
      await persistAnalysisCapability(analysisId, finalizeCapability(tracker));
      const fresh = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = fresh;
      try {
        return (await getAnalysisSnapshot(analysisId))?.capability;
      } finally {
        state.db = db;
        await fresh.$disconnect();
      }
    };

    it("no working tree: the pass runs fast, and the snapshot says no-working-tree", async () => {
      setMode("explore");
      const { orch, tracker } = await orchestratorFor("an-2565-no-tree", "unusable");
      await run(orch, "an-2565-no-tree");
      expect(toolNames()).not.toContain("grep_files");
      expect(toolNames()).not.toContain("read_file_slice");
      expect(loopCall()[1].systemMessage).not.toContain(EXPLORER_STEPS);
      const capability = await snapshotCapability("an-2565-no-tree", tracker);
      expect(capability).toMatchObject({
        codePassMode: "fast",
        codePassModeReason: "no-working-tree",
        codePassOutcomes: [expect.objectContaining({ mode: "fast" })],
      });
    });

    it("with a working tree: the snapshot says explore, from the platform default", async () => {
      setMode("explore");
      const { orch, tracker } = await orchestratorFor("an-2565-tree", "healthy");
      await run(orch, "an-2565-tree");
      const capability = await snapshotCapability("an-2565-tree", tracker);
      expect(capability).toMatchObject({
        codePassMode: "explore",
        codePassModeReason: "platform-default",
        codePassOutcomes: [expect.objectContaining({ mode: "explore", maxTurns: 10 })],
      });
    });
  },
);
