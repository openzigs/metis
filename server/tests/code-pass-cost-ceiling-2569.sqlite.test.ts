/**
 * #2569 — the code pass's dollar ceiling and its spend record, driven through
 * the real `runAgenticCodeAgent` over a real SQLite database and a real clone,
 * with a stub model priced through `MODEL_PRICES` at $0.10 a call:
 *
 *   - under a $0.25 ceiling the pass makes three model calls (the third starts
 *     at $0.20 and ends at $0.30); the fourth turn and the final-answer retry
 *     are refused, in both modes;
 *   - a requirement the capped pass never searched for is stored
 *     could-not-verify, never a gap, read back through the snapshot;
 *   - the evidence-only salvage call is refused at the ceiling too;
 *   - each call's spend is readable on the usage summary while the pass is
 *     still running, and stays readable after the run is cancelled;
 *   - an unpriced model is bounded by tokens only and says so.
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
  loopResults: [] as unknown[],
  /** The provider each post-loop model step was handed, by step (#2569 review). */
  stepProviders: {} as Record<"salvageWithRepair" | "supportPanel" | "faithfulness", unknown>,
}));
// #2569 review — the salvage repair, support panel and faithfulness steps run
// for real; the provider each is handed is recorded so a test can show it is
// the pass's guarded one, never the bare adapter.
vi.mock("../src/lib/analysis/agentic-degradation.js", async (original) => {
  const real = await original<typeof import("../src/lib/analysis/agentic-degradation.js")>();
  return {
    ...real,
    salvageWithRepair: (...args: Parameters<typeof real.salvageWithRepair>) => {
      state.stepProviders.salvageWithRepair = args[0];
      return real.salvageWithRepair(...args);
    },
  };
});
vi.mock("../src/lib/analysis/support-panel.js", async (original) => {
  const real = await original<typeof import("../src/lib/analysis/support-panel.js")>();
  return {
    ...real,
    applySupportPanel: (...args: Parameters<typeof real.applySupportPanel>) => {
      state.stepProviders.supportPanel = args[0];
      return real.applySupportPanel(...args);
    },
  };
});
vi.mock("../src/lib/analysis/finding-faithfulness.js", async (original) => {
  const real = await original<typeof import("../src/lib/analysis/finding-faithfulness.js")>();
  return {
    ...real,
    applyFindingFaithfulness: (...args: Parameters<typeof real.applyFindingFaithfulness>) => {
      state.stepProviders.faithfulness = args[0];
      return real.applyFindingFaithfulness(...args);
    },
  };
});
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
vi.mock("../src/lib/rag/embedder.js", async (original) => ({
  ...(await original<typeof import("../src/lib/rag/embedder.js")>()),
  getEmbedder: () => ({ model: "embed-a", knownIdentity: () => "embed-a|mean" }),
}));
// Every `runAgentLoop` result is recorded; the loop runs for real.
vi.mock("../src/lib/analysis/agent-loop.js", async (original) => {
  const real = await original<typeof import("../src/lib/analysis/agent-loop.js")>();
  return {
    ...real,
    runAgentLoop: async (...args: Parameters<typeof real.runAgentLoop>) => {
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
const { runInAnalysisUsageScope, flushAnalysisUsage } =
  await import("../src/lib/analysis/analysis-usage.js");
const { summarizeUsage } = await import("../src/lib/finops/budget-enforcer.js");
const { CodePassCostCeiling, CostCeilingReachedError } =
  await import("../src/lib/analysis/code-pass-cost-ceiling.js");
type AIProvider = import("../src/lib/ai/types.js").AIProvider;
const { __resetConfigSingleton } = await import("../src/lib/config/config-service.js");
type AgentLoopResult = import("../src/lib/analysis/agent-loop.js").AgentLoopResult;
type Tracker = ReturnType<typeof createCapabilityTracker>;

const USER = "u-2569";
const PROJECT = "p-2569";
const REPO = "rc-2569";
const GRAPH = "g-2569";
const PRICED = { provider: "priced-stub", model: "stub-priced" };
const UNPRICED = { provider: "unpriced-stub", model: "who-knows" };
/** $1000 per million tokens, so a 50 + 50-token call is $0.10. */
const PRICES = JSON.stringify({
  [`${PRICED.provider}:${PRICED.model}`]: { inputPerMTok: 1000, outputPerMTok: 1000 },
});
const REQ_FEE = { id: "REQ-1", text: "Compute the fee." };
const REQ_STATEMENT = {
  id: "REQ-2",
  text: "Email a monthly statement to every customer.",
};

/** A model reply, by call number. */
type Script = (call: number) => string;
const grep = (text: string) => JSON.stringify({ tool: "grep_files", text });
const NEVER_ANSWERS: Script = (n) => grep(`fee${n}`);
/**
 * The third reply is an answer the findings schema rejects as a whole (its
 * `notes` is not a list), so only its findings are salvaged; the one finding
 * claims REQ-2, which the pass never searched for, is a confirmed gap.
 */
const REJECTED_ANSWER = JSON.stringify({
  agentKey: "code",
  summary: "partial",
  notes: "not a list",
  findings: [
    {
      category: "other",
      severity: "high",
      title: "Monthly statement emails are missing",
      body: "No code sends a monthly statement email.",
      requirementId: REQ_STATEMENT.id,
      verdict: "gap-confirmed",
      citations: [],
      tags: [],
    },
  ],
});

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2569 — the code pass's dollar ceiling (real SQLite, real clone)",
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
      sqlite = createMigratedSqlite("code-pass-cost-ceiling-2569");
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
      cloneRoot = mkdtempSync(path.join(os.tmpdir(), "metis-2569-"));
      mkdirSync(path.join(cloneRoot, REPO, "src"), { recursive: true });
      writeFileSync(
        path.join(cloneRoot, REPO, "src", "fee.ts"),
        "export function computeFee() {}\n",
      );
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    const setEnv = (values: Record<string, string | undefined>) => {
      for (const [k, v] of Object.entries(values)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      __resetConfigSingleton();
    };

    afterEach(() => {
      state.loopResults.length = 0;
      state.stepProviders = {} as typeof state.stepProviders;
      setEnv({
        ANALYSIS_CODE_EXPLORATION: undefined,
        ANALYSIS_CODE_PASS_MAX_USD: undefined,
        ANALYSIS_AGENT_TOKEN_BUDGET: undefined,
        MODEL_PRICES: undefined,
      });
    });

    afterAll(async () => {
      if (savedCloneDir === undefined) delete process.env.REPO_CLONE_DIR;
      else process.env.REPO_CLONE_DIR = savedCloneDir;
      await db?.$disconnect();
      sqlite?.cleanup();
      if (cloneRoot) rmSync(cloneRoot, { recursive: true, force: true });
    });

    type Orch = {
      capabilities: Map<string, Tracker>;
      runAgenticCodeAgent: (input: Record<string, unknown>) => Promise<unknown>;
    };

    /** An orchestrator whose stub model follows `script` at $0.10 a call, and a tracker. */
    const orchestratorFor = async (
      analysisId: string,
      script: Script,
      opts: {
        ids?: { provider: string; model: string };
        onCall?: (call: number, signal: AbortSignal | undefined) => Promise<void> | void;
      } = {},
    ) => {
      await db.analysis.upsert({
        where: { id: analysisId },
        create: { id: analysisId, projectId: PROJECT, status: "running", startedById: USER },
        update: { metadata: null },
      });
      const ids = opts.ids ?? PRICED;
      let calls = 0;
      const chat = vi.fn(async (_messages: unknown, chatOpts?: { signal?: AbortSignal }) => {
        const n = calls++;
        await opts.onCall?.(n, chatOpts?.signal);
        return {
          content: script(n),
          usage: { promptTokens: 50, completionTokens: 50, totalTokens: 100 },
          model: ids.model,
          provider: ids.provider,
        };
      });
      const orch = new AnalysisOrchestrator({
        provider: { key: ids.provider, model: ids.model, offline: true, chat } as never,
        retrieve: async () => [],
        knowledge: { search: async () => ({ hits: [] }) } as never,
        fusedCode: { searcher, lineLookup },
        prepareRepoClone: async () => "healthy",
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
      return { orch, tracker, chat };
    };

    const run = (orch: Orch, analysisId: string, extra: Record<string, unknown> = {}) => {
      process.env.REPO_CLONE_DIR = cloneRoot;
      return runInAnalysisUsageScope({ projectId: PROJECT, sessionId: analysisId }, () =>
        orch.runAgenticCodeAgent({
          analysisId,
          projectId: PROJECT,
          projectName: "Fees",
          projectDescription: "fees",
          requirements: [REQ_FEE],
          signal: new AbortController().signal,
          connectorId: REPO,
          ...extra,
        }),
      );
    };

    const loopResult = (i = 0) => state.loopResults[i] as AgentLoopResult;

    /** Persist the run's capability as the pipeline does, then read the snapshot in a fresh client. */
    const freshSnapshot = async (analysisId: string, tracker?: Tracker) => {
      if (tracker) await persistAnalysisCapability(analysisId, finalizeCapability(tracker));
      const fresh = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = fresh;
      try {
        return await getAnalysisSnapshot(analysisId);
      } finally {
        state.db = db;
        await fresh.$disconnect();
      }
    };

    /** The project's usage summary, read in a fresh client as a separate request would. */
    const freshUsage = async () => {
      const fresh = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = fresh;
      try {
        return await summarizeUsage(PROJECT, {
          from: new Date(0),
          to: new Date(Date.now() + 60_000),
        });
      } finally {
        state.db = db;
        await fresh.$disconnect();
      }
    };

    for (const mode of ["fast", "explore"] as const) {
      it(`${mode}: $0.10 calls under $0.25 — three calls, the fourth turn and the retry refused; an unsearched requirement is could-not-verify`, async () => {
        setEnv({
          MODEL_PRICES: PRICES,
          ANALYSIS_CODE_EXPLORATION: mode,
          // Two requirements at $0.125 each: a $0.25 ceiling for the pass.
          ANALYSIS_CODE_PASS_MAX_USD: "0.125",
        });
        const analysisId = `an-2569-cap-${mode}`;
        const script: Script = (n) =>
          n === 0 ? grep("fee") : n === 1 ? grep("computeFee") : REJECTED_ANSWER;
        const { orch, tracker, chat } = await orchestratorFor(analysisId, script);
        await run(orch, analysisId, { requirements: [REQ_FEE, REQ_STATEMENT] });

        expect(chat).toHaveBeenCalledTimes(3);
        const result = loopResult();
        expect(result.costCeilingReached).toBe(true);
        expect(result.finalAnswerRetry).toMatchObject({ attempted: true, succeeded: false });
        expect(tracker.codePassOutcomes).toEqual([
          expect.objectContaining({ mode, degradation: "cost-ceiling" }),
        ]);

        const snap = await freshSnapshot(analysisId, tracker);
        // The overshoot is at most one call: $0.30 against $0.25.
        expect(snap?.capability?.codePassCostCeiling).toEqual({
          limitUsd: 0.25,
          spentUsd: 0.3,
          reached: true,
          pricing: "priced",
        });
        expect(snap?.capability?.reasons).toEqual(
          expect.arrayContaining([
            "code-pass-cost-ceiling",
            "code-agent-degraded",
            "code-investigation-cut-short",
          ]),
        );
        const code = (
          snap?.agents as unknown as Array<{
            agentKey: string;
            findings: Array<Record<string, unknown>>;
          }>
        ).find((a) => a.agentKey === "code");
        const statement = code?.findings.find((f) => f.requirementId === REQ_STATEMENT.id);
        expect(statement).toBeDefined();
        expect(statement?.verdict).toBe("could-not-verify");
        expect(code?.findings.some((f) => f.verdict === "gap-confirmed")).toBe(false);
      });
    }

    it("refuses the evidence-only salvage call at the ceiling (and makes it without one)", async () => {
      // The loop spends its 10 turns ($1.00) under a $1.05 ceiling; the retry
      // answers in prose and takes the spend to $1.10, so the salvage's one
      // tool-free call over the evidence is refused.
      const read = JSON.stringify({ tool: "read_file_slice", filePath: "src/fee.ts" });
      const script: Script = (n) => (n < 10 ? read : "I could not finish.");
      const counts: Record<string, number> = {};
      for (const ceiling of ["1.05", "0"]) {
        setEnv({ MODEL_PRICES: PRICES, ANALYSIS_CODE_PASS_MAX_USD: ceiling });
        const analysisId = `an-2569-salvage-${ceiling}`;
        const { orch, tracker, chat } = await orchestratorFor(analysisId, script);
        await run(orch, analysisId);
        counts[ceiling] = chat.mock.calls.length;
        if (ceiling !== "0") {
          expect(tracker.codePassCostCeiling).toMatchObject({ reached: true, limitUsd: 1.05 });
        } else {
          expect(tracker.codePassCostCeiling).toBeUndefined();
        }
      }
      // 10 turns + the retry; without the ceiling, the evidence salvage too.
      expect(counts).toEqual({ "1.05": 11, "0": 12 });
    });

    it("a ceiling shared by two passes: the second pass's first call is refused", async () => {
      setEnv({ MODEL_PRICES: PRICES });
      const shared = new CodePassCostCeiling(0.25);
      const { orch, chat } = await orchestratorFor("an-2569-shared", NEVER_ANSWERS);
      await run(orch, "an-2569-shared", { costCeiling: shared });
      expect(chat).toHaveBeenCalledTimes(3);
      await run(orch, "an-2569-shared", { costCeiling: shared });
      expect(chat).toHaveBeenCalledTimes(3);
      expect(loopResult(1)).toMatchObject({ turnsUsed: 0, costCeilingReached: true });
    });

    it("a Continue (turnMultiplier 2) gets twice the dollar ceiling: five calls where a plain pass gets three", async () => {
      const counts: Record<string, number> = {};
      for (const multiplier of [undefined, 2]) {
        setEnv({ MODEL_PRICES: PRICES, ANALYSIS_CODE_PASS_MAX_USD: "0.25" });
        const analysisId = `an-2569-continue-${multiplier ?? 1}`;
        const { orch, tracker, chat } = await orchestratorFor(analysisId, NEVER_ANSWERS);
        await run(orch, analysisId, multiplier ? { turnMultiplier: multiplier } : {});
        counts[String(multiplier ?? 1)] = chat.mock.calls.length;
        expect(tracker.codePassCostCeiling).toMatchObject({
          limitUsd: 0.25 * (multiplier ?? 1),
          reached: true,
        });
      }
      // $0.25: calls start at $0, $0.10, $0.20. $0.50: also at $0.30 and $0.40.
      expect(counts).toEqual({ "1": 3, "2": 5 });
    });

    /** One $0.10 call through `provider`: true when `ceiling` counted it. */
    const spendsAgainst = async (provider: unknown, ceiling: { spentUsd: number }) => {
      const before = ceiling.spentUsd;
      await (provider as AIProvider).chat([{ role: "user", content: "q" }]);
      return ceiling.spentUsd - before > 0.09;
    };

    it("the salvage repair call goes through the pass's ceiling", async () => {
      setEnv({ MODEL_PRICES: PRICES });
      const ceiling = new CodePassCostCeiling(100);
      const { orch, chat } = await orchestratorFor("an-2569-repair", NEVER_ANSWERS);
      await run(orch, "an-2569-repair", { costCeiling: ceiling });
      const repair = state.stepProviders.salvageWithRepair;
      expect(repair).toBeDefined();
      expect(repair).not.toBe((orch as unknown as { deps: { provider: unknown } }).deps.provider);
      const calls = chat.mock.calls.length;
      expect(await spendsAgainst(repair, ceiling)).toBe(true);
      expect(chat).toHaveBeenCalledTimes(calls + 1);
    });

    it("the support panel and faithfulness calls spend against the ceiling, and a refusal of one is not the pass stopping", async () => {
      setEnv({ MODEL_PRICES: PRICES });
      // The pass answers cleanly, well under a $1 ceiling.
      const answer = JSON.stringify({ agentKey: "code", summary: "ok", findings: [], notes: [] });
      const ceiling = new CodePassCostCeiling(1);
      const { orch, tracker, chat } = await orchestratorFor("an-2569-grading", () => answer);
      await run(orch, "an-2569-grading", { costCeiling: ceiling });
      expect(loopResult().hasFinalAnswer).toBe(true);
      expect(ceiling.spentUsd).toBeLessThan(1);
      const { supportPanel, faithfulness } = state.stepProviders;
      expect(supportPanel).toBeDefined();
      expect(faithfulness).toBeDefined();
      // Grading calls spend against the pass's ceiling, up to it ...
      while (ceiling.spentUsd < 1) expect(await spendsAgainst(supportPanel, ceiling)).toBe(true);
      const calls = chat.mock.calls.length;
      // ... and the next is refused, without marking the pass stopped.
      await expect(
        (faithfulness as AIProvider).chat([{ role: "user", content: "q" }]),
      ).rejects.toBeInstanceOf(CostCeilingReachedError);
      expect(chat).toHaveBeenCalledTimes(calls);
      expect(ceiling.reached).toBe(false);
      // The run itself said nothing: a clean pass is not stopped by its ceiling.
      expect(tracker.codePassCostCeiling).toBeUndefined();
    });

    it("each finished call is on the usage summary while the pass runs, and after it is cancelled", async () => {
      setEnv({ MODEL_PRICES: PRICES });
      const analysisId = "an-2569-in-flight";
      const controller = new AbortController();
      let pausedAtThirdCall!: () => void;
      const paused = new Promise<void>((resolve) => {
        pausedAtThirdCall = resolve;
      });
      const { orch } = await orchestratorFor(analysisId, NEVER_ANSWERS, {
        onCall: (n, signal) => {
          if (n < 2) return;
          pausedAtThirdCall();
          // The third call is in flight until the run is cancelled.
          return new Promise<void>((_resolve, reject) => {
            const abort = () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            };
            if (signal?.aborted) abort();
            else signal?.addEventListener("abort", abort, { once: true });
          });
        },
      });
      await flushAnalysisUsage();
      const before = await freshUsage();
      const settled = run(orch, analysisId, { signal: controller.signal }).then(
        () => "resolved",
        (err: Error) => err.name,
      );
      await paused;
      await flushAnalysisUsage(analysisId);
      const during = await freshUsage();
      // The project's summary also holds the earlier tests' runs: compare to before.
      expect(during.totalTokens - before.totalTokens).toBe(200);
      expect(during.costCents - before.costCents).toBe(20);
      expect(await Promise.race([settled, Promise.resolve("pending")])).toBe("pending");

      controller.abort();
      expect(await settled).toBe("AbortError");
      await flushAnalysisUsage(analysisId);
      const after = await freshUsage();
      expect(after.totalTokens - before.totalTokens).toBe(200);
      expect(after.costCents - before.costCents).toBe(20);
      const rows = await db.tokenUsage.findMany({ where: { sessionId: analysisId } });
      expect(rows).toHaveLength(2);
    });

    it("an unpriced model is bounded by its token budget only, and the record says cost-ceiling-unpriced", async () => {
      // 100 tokens a call: the token budget, not the turn cap, ends the pass.
      setEnv({ ANALYSIS_CODE_PASS_MAX_USD: "0.25", ANALYSIS_AGENT_TOKEN_BUDGET: "700" });
      const analysisId = "an-2569-unpriced";
      const { orch, tracker } = await orchestratorFor(analysisId, NEVER_ANSWERS, {
        ids: UNPRICED,
      });
      await run(orch, analysisId);
      // Far past what $0.25 would allow at $0.10 a call, had the calls been priced.
      expect(loopResult().turnsUsed).toBeGreaterThan(3);
      expect(loopResult().budgetExhausted).toBe(true);
      expect(loopResult().costCeilingReached).toBeUndefined();
      const snap = await freshSnapshot(analysisId, tracker);
      expect(snap?.capability?.codePassCostCeiling).toEqual({
        limitUsd: 0.25,
        spentUsd: 0,
        reached: false,
        pricing: "cost-ceiling-unpriced",
      });
      expect(snap?.capability?.reasons).not.toContain("code-pass-cost-ceiling");
    });
  },
);
