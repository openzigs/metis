/**
 * #724 — analysis LLM spend is recorded as PROJECT usage.
 *
 * A 207k-token analysis left `usage-summary` (and so the monthly budget and
 * Settings → Usage & cost) at zero: nothing under `lib/analysis/` wrote a
 * `token_usages` row. Here a REAL `AnalysisOrchestrator` runs over a real
 * migrated SQLite database with a scripted provider that reports usage on every
 * call, and the result is read back through `summarizeUsage` — the function
 * `GET /api/projects/:id/usage-summary` answers with — never through the
 * provider's own counters.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";
import type { AIProvider, ChatResponse } from "../src/lib/ai/types.js";
import type { KnowledgeService } from "../src/lib/rag/knowledge-service.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
// The real module, so `persistRequirements` picks its locking by the real
// provider seam (#779); only the client is swapped.
vi.mock("../src/lib/prisma.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/prisma.js")>()),
  get prisma() {
    return state.db;
  },
}));
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { AnalysisOrchestrator } = await import("../src/lib/analysis/orchestrator.js");
const { summarizeUsage } = await import("../src/lib/finops/budget-enforcer.js");
const { getPendingUsageWrites } = await import("../src/lib/finops/token-tracker.js");

const PROJECT = "p-724";
const OTHER = "p-724-other";
const USER = "u-724";
const MODEL = "claude-sonnet-4-6";
// Exactly 3 cents a call at the Sonnet 4 rate, so per-row and per-run pricing agree to the cent.
const CALL = { promptTokens: 5_000, completionTokens: 1_000, totalTokens: 6_000 };

const agentJson = JSON.stringify({
  summary: "summary",
  findings: [
    {
      category: "security",
      severity: "medium",
      title: "A finding",
      body: "Body",
      tags: [],
      citations: [],
    },
  ],
  notes: [],
});

/** Answers every call with an agent payload and reports the same usage each time. */
function scriptedProvider(): AIProvider & { calls: number } {
  const p = {
    key: "anthropic" as const,
    model: MODEL,
    offline: false,
    calls: 0,
    async chat(): Promise<ChatResponse> {
      p.calls += 1;
      return { content: agentJson, usage: { ...CALL }, model: MODEL, provider: "anthropic" };
    },
    async *stream() {
      yield { type: "done" } as const;
    },
    async embed() {
      return { vectors: [], dimension: 0, model: "stub" };
    },
    async models() {
      return [MODEL];
    },
    async ping() {
      return true;
    },
  };
  return p as AIProvider & { calls: number };
}

/**
 * The client the code under test sees: the real one, except that every
 * `token_usages` insert lands {@link USAGE_WRITE_DELAY_MS} late. `recordUsage`
 * writes asynchronously, so this makes deterministic the race a slow database
 * (Postgres) loses at random — a run that prices itself before its own last
 * writes land reports a low `AgentRun.costCents`.
 */
const USAGE_WRITE_DELAY_MS = 250;
function withSlowUsageWrites(client: PrismaClient): PrismaClient {
  const tokenUsage = new Proxy(client.tokenUsage, {
    get(target, prop) {
      if (prop === "create") {
        return async (args: Parameters<typeof target.create>[0]) => {
          await new Promise((r) => setTimeout(r, USAGE_WRITE_DELAY_MS));
          return target.create(args);
        };
      }
      return Reflect.get(target, prop, target);
    },
  });
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "tokenUsage") return tokenUsage;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

const stubKnowledge = { search: async () => ({ hits: [] }) } as unknown as KnowledgeService;

/**
 * Wait for every queued `token_usages` write, then for the clock to move on:
 * `summarizeUsage` bounds its window with an exclusive `lt: now`, so a row that
 * landed in this very millisecond would otherwise be read as not there yet.
 */
async function drainUsageWrites(): Promise<void> {
  while (getPendingUsageWrites() > 0) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 2));
}

async function settled(db: PrismaClient, analysisId: string): Promise<string> {
  for (let i = 0; i < 400; i++) {
    const row = await db.analysis.findUnique({ where: { id: analysisId } });
    if (row && ["completed", "failed", "cancelled"].includes(row.status)) {
      await drainUsageWrites();
      return row.status;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`analysis ${analysisId} never settled`);
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#724 — analysis spend reaches the project's usage summary (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const savedBaseUrl = process.env.ANTHROPIC_BASE_URL;

    beforeAll(async () => {
      // A first-party Anthropic endpoint, so the model is priced (#22).
      delete process.env.ANTHROPIC_BASE_URL;
      sqlite = createMigratedSqlite("724-analysis-usage");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = withSlowUsageWrites(db);
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@example.test` },
      });
      for (const id of [PROJECT, OTHER]) {
        await db.project.create({ data: { id, name: id, slug: id, createdById: USER } });
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      if (savedBaseUrl !== undefined) process.env.ANTHROPIC_BASE_URL = savedBaseUrl;
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("a run, then a regenerate, each grow usage-summary by exactly what the provider reported", async () => {
      const before = await summarizeUsage(PROJECT);
      expect(before.totalTokens).toBe(0);

      const provider = scriptedProvider();
      // #864 — the web specialist only runs when a web search provider is configured.
      const orch = new AnalysisOrchestrator({
        provider,
        knowledge: stubKnowledge,
        webSearchConfigured: () => true,
      });

      const { id } = await orch.start({
        projectId: PROJECT,
        startedById: USER,
        agentKeys: ["web"],
      });
      expect(await settled(db, id)).toBe("completed");
      const runCalls = provider.calls;
      expect(runCalls).toBeGreaterThan(0);

      const afterRun = await summarizeUsage(PROJECT);
      expect(afterRun.inputTokens).toBe(runCalls * CALL.promptTokens);
      expect(afterRun.outputTokens).toBe(runCalls * CALL.completionTokens);
      expect(afterRun.totalTokens).toBe(runCalls * CALL.totalTokens);
      expect(afterRun.costCents).toBeGreaterThan(0);
      expect(afterRun.unpriced.calls).toBe(0);
      expect(afterRun.byProvider).toEqual([
        expect.objectContaining({ provider: "anthropic", model: MODEL }),
      ]);
      // Every row is the run's: the analysis id is its session, which is what
      // the replay run's cost (`computeRunCost`) reads back.
      const rows = await db.tokenUsage.findMany({ where: { projectId: PROJECT } });
      expect(rows).toHaveLength(runCalls);
      expect(new Set(rows.map((r) => r.sessionId))).toEqual(new Set([id]));
      // …so the Agent Runs view now prices the run instead of showing "Cost —",
      // and prices ALL of it: the run waits for its own (slow) usage writes
      // before reading them back, so its cost is exactly the summary's.
      const replayRun = await db.agentRun.findFirst({ where: { sessionId: id, kind: "analysis" } });
      expect(afterRun.costCents).toBeGreaterThan(0);
      expect(replayRun?.costCents).toBe(afterRun.costCents);

      await orch.regenerateAgent({ analysisId: id, agentKey: "web", actorId: USER });
      await drainUsageWrites();
      const regenCalls = provider.calls - runCalls;
      expect(regenCalls).toBeGreaterThan(0);
      const afterRegen = await summarizeUsage(PROJECT);
      expect(afterRegen.totalTokens).toBe(provider.calls * CALL.totalTokens);

      // Nothing leaked to another project.
      expect((await summarizeUsage(OTHER)).totalTokens).toBe(0);
    });

    it("#943 — a regenerate keeps the analysis and its run `running`, and the run is priced for all of it", async () => {
      const provider = scriptedProvider();
      const orch = new AnalysisOrchestrator({
        provider,
        knowledge: stubKnowledge,
        webSearchConfigured: () => true,
      });
      const { id } = await orch.start({
        projectId: PROJECT,
        startedById: USER,
        agentKeys: ["web"],
      });
      expect(await settled(db, id)).toBe("completed");
      const runCalls = provider.calls;
      const firstRun = await db.agentRun.findFirst({ where: { sessionId: id, kind: "analysis" } });
      expect(firstRun?.status).toBe("completed");

      // What every model call of the regenerate (its agent AND the re-synthesis
      // that rewrites the requirements) sees on the analysis and on its run.
      const seen: Array<{ analysis?: string; run?: string; runCompletedAt?: Date | null }> = [];
      const chat = provider.chat.bind(provider);
      provider.chat = async (...args: Parameters<AIProvider["chat"]>) => {
        const analysis = await db.analysis.findUnique({ where: { id } });
        const run = await db.agentRun.findUnique({ where: { id: firstRun!.id } });
        seen.push({
          analysis: analysis?.status,
          run: run?.status,
          runCompletedAt: run?.completedAt,
        });
        return chat(...args);
      };
      await orch.regenerateAgent({ analysisId: id, agentKey: "web", actorId: USER });
      await drainUsageWrites();

      expect(provider.calls - runCalls).toBeGreaterThan(1);
      expect(seen.length).toBe(provider.calls - runCalls);
      for (const s of seen)
        expect(s).toEqual({ analysis: "running", run: "running", runCompletedAt: null });
      expect((await db.analysis.findUnique({ where: { id } }))?.status).toBe("completed");

      // The run page reads this row: every ledger row of the session is priced,
      // the regenerate's included, and its tokens grew by the regenerate's.
      const run = await db.agentRun.findUnique({ where: { id: firstRun!.id } });
      expect(run?.status).toBe("completed");
      expect(run?.completedAt).not.toBeNull();
      const rows = await db.tokenUsage.findMany({ where: { sessionId: id } });
      expect(rows).toHaveLength(provider.calls);
      // 3 cents a call (see CALL).
      expect(run?.costCents).toBe(provider.calls * 3);
      expect(run?.costCents).toBeGreaterThan(firstRun!.costCents);
      expect(run?.totalTokens).toBe(provider.calls * CALL.totalTokens);
    });

    it("a provider call outside any analysis scope records nothing", async () => {
      const provider = scriptedProvider();
      const orch = new AnalysisOrchestrator({ provider });
      const before = await db.tokenUsage.count();
      await orch.provider.chat([{ role: "user", content: "hi" }]);
      await drainUsageWrites();
      expect(await db.tokenUsage.count()).toBe(before);
    });
  },
);
