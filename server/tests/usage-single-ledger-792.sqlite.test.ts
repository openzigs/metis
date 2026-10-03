/**
 * #792 — one ledger behind every number on the project usage page.
 *
 * The walkthrough found the cards (`usage-summary`, budget, MTD) at 10.8M
 * tokens / $5.57 from `token_usages`, while "Detailed Usage Analytics" and the
 * CSV export showed 290k / $0.14 from `ai_token_usages` — and impact-analysis
 * spend reached only the latter, so it never counted against the budget.
 *
 * Here REAL code paths write over a REAL migrated SQLite database (so the new
 * `token_usages.userId` / `agentStep` columns come from the migration chain):
 * a chat-shaped `recordUsage` row plus an impact-analysis LLM call metered by
 * the real `createImpactLlmRuntime` with the real token trackers. Everything is
 * then read back through the functions the routes answer with —
 * `summarizeUsage` (`GET /usage-summary`) and `UsageService.projectUsage` +
 * `toCSV` (`GET /usage`, `GET /usage/csv`) — and they must agree.
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

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});

const { summarizeUsage } = await import("../src/lib/finops/budget-enforcer.js");
const { recordUsage, getPendingUsageWrites } = await import("../src/lib/finops/token-tracker.js");
const { createImpactLlmRuntime, IMPACT_LLM_AGENT_STEP } =
  await import("../src/lib/impact-analysis/impact-llm-runtime.js");
const { runInImpactProjectScope } = await import("../src/lib/impact-analysis/impact-llm-scope.js");
const { UsageService } = await import("../src/lib/usage/usage-service.js");
const { TokenBudgetController } = await import("../src/lib/ai/token-budget-controller.js");
const { getTokenTracker } = await import("../src/lib/ai/token-tracker.js");
const { createApplyDiffTool, APPLY_DIFF_AGENT_STEP } =
  await import("../src/lib/ai/tools/apply-diff.js");

const PROJECT = "p-792";
const OTHER = "p-792-other";
const MORPH = "p-792-morph";
const DAILY = "p-792-daily";
const MONTHLY = "p-792-monthly";
const USER = "u-792";
const MODEL = "claude-sonnet-4-6";

function impactProvider(): AIProvider {
  return {
    key: "anthropic",
    model: MODEL,
    offline: false,
    async chat(): Promise<ChatResponse> {
      return {
        content: "{}",
        usage: { promptTokens: 5_000, completionTokens: 1_000, totalTokens: 6_000 },
        model: MODEL,
        provider: "anthropic",
      };
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
  } as unknown as AIProvider;
}

/** `summarizeUsage` bounds its window with an exclusive `lt: now`. */
async function drain(): Promise<void> {
  while (getPendingUsageWrites() > 0 || getTokenTracker().inFlight > 0) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await new Promise((r) => setTimeout(r, 2));
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#792 — the usage page's cards, analytics and CSV read one ledger (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const savedBaseUrl = process.env.ANTHROPIC_BASE_URL;

    beforeAll(async () => {
      delete process.env.ANTHROPIC_BASE_URL; // first-party Anthropic ⇒ priced (#22)
      sqlite = createMigratedSqlite("792-single-ledger");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@example.test` },
      });
      for (const id of [PROJECT, OTHER, MORPH, DAILY, MONTHLY]) {
        await db.project.create({ data: { id, name: id, slug: id, createdById: USER } });
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      if (savedBaseUrl !== undefined) process.env.ANTHROPIC_BASE_URL = savedBaseUrl;
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("impact spend reaches usage-summary, and analytics + CSV add up to the cards", async () => {
      // A chat turn's project row, as the chat routes write it.
      recordUsage({
        projectId: PROJECT,
        sessionId: "chat-sess",
        userId: USER,
        agentStep: "chat",
        provider: "anthropic",
        model: MODEL,
        inputTokens: 20_000,
        outputTokens: 2_000,
      });
      // Another project's spend must not leak in.
      recordUsage({
        projectId: OTHER,
        sessionId: "x",
        provider: "anthropic",
        model: MODEL,
        inputTokens: 999,
        outputTokens: 1,
      });

      // An impact run's LLM call, through the real runtime and real trackers.
      const runtime = createImpactLlmRuntime({ actorId: USER, projectIds: [PROJECT] });
      const provider = runtime.instrument(impactProvider(), "table-filter");
      await runInImpactProjectScope(PROJECT, () => provider.chat([]));
      await runtime.flush();
      await drain();

      const cards = await summarizeUsage(PROJECT);
      // 22,000 chat + 6,000 impact — impact is in the budget's ledger now.
      expect(cards.totalTokens).toBe(28_000);
      expect(cards.costCents).toBeGreaterThan(0);

      const svc = new UsageService();
      const byStep = await svc.projectUsage(PROJECT, { range: "7d", groupBy: "agentStep" });
      expect(byStep.totalTokens).toBe(cards.totalTokens);
      expect(byStep.totalCostUsd * 100).toBeCloseTo(cards.costCents, 10);
      expect(
        Object.fromEntries(byStep.rows.map((r) => [r.agentStep ?? "unknown", r.totalTokens])),
      ).toEqual({ chat: 22_000, [IMPACT_LLM_AGENT_STEP["table-filter"]]: 6_000 });

      const byUser = await svc.projectUsage(PROJECT, { range: "7d", groupBy: "user" });
      expect(byUser.rows).toEqual([expect.objectContaining({ userId: USER, totalTokens: 28_000 })]);

      const byDay = await svc.projectUsage(PROJECT, { range: "7d", groupBy: "day" });
      const csv = svc.toCSV(byDay.rows).split("\n");
      expect(csv).toHaveLength(2);
      const cells = csv[1].split(",");
      expect(cells[4]).toBe(PROJECT); // projectId filled
      expect(Number(cells[7])).toBe(cards.totalTokens);
      expect(Number(cells[8]) * 100).toBeCloseTo(cards.costCents, 6);

      // The per-user store still gets its row (the runtime's #1021 contract).
      const perUser = await db.aITokenUsage.findMany({ where: { projectId: PROJECT } });
      expect(perUser.map((r) => r.agentStep)).toEqual([IMPACT_LLM_AGENT_STEP["table-filter"]]);
    });

    it("the budget gauge counts the same ledger as the cards", async () => {
      // Written directly to the per-user store only: the gauge must NOT see it.
      await db.aISession.create({
        data: { id: "legacy", userId: USER, provider: "anthropic", model: MODEL },
      });
      await db.aITokenUsage.create({
        data: {
          sessionId: "legacy",
          userId: USER,
          provider: "anthropic",
          model: MODEL,
          totalTokens: 500_000,
          dayBucket: new Date().toISOString().slice(0, 10),
          projectId: PROJECT,
        },
      });
      await db.tokenBudget.create({
        data: { projectId: PROJECT, dailyTokenLimit: 100_000, monthlyTokenLimit: 1_000_000 },
      });
      const cards = await summarizeUsage(PROJECT);
      const gauge = await new TokenBudgetController().check(PROJECT);
      // Daily limit 100k; ledger holds 28k (impact included) => 28% used.
      expect(cards.totalTokens).toBe(28_000);
      expect(gauge.remainingTokens).toBe(100_000 - 28_000);
      expect(gauge.percentUsed).toBeCloseTo(0.28, 10);
    });
    it("apply_diff (morph) spend reaches the session project's analytics and CSV", async () => {
      // A chat session in MORPH; the tool context carries no projectId, as the
      // chat tool runtime builds it — the project comes from the session.
      await db.aISession.create({
        data: { id: "morph-sess", userId: USER, projectId: MORPH, provider: "openai", model: "x" },
      });
      const apply = vi.fn(async () => ({
        content: "patched",
        provider: "morph" as const,
        model: "morph-v3",
        usage: { promptTokens: 700, completionTokens: 300, totalTokens: 1_000 },
        durationMs: 1,
      }));
      const tool = createApplyDiffTool({ isEnabled: () => true, client: { apply } as never });
      await tool.exec({ original: "a", patch: "b" }, { sessionId: "morph-sess", userId: USER });
      await drain();

      const svc = new UsageService();
      const byStep = await svc.projectUsage(MORPH, { range: "7d", groupBy: "agentStep" });
      expect(byStep.totalTokens).toBe(1_000);
      expect(byStep.rows).toEqual([
        expect.objectContaining({ agentStep: APPLY_DIFF_AGENT_STEP, totalTokens: 1_000 }),
      ]);
      const byUser = await svc.projectUsage(MORPH, { range: "7d", groupBy: "user" });
      expect(byUser.rows).toEqual([expect.objectContaining({ userId: USER, totalTokens: 1_000 })]);

      const byDay = await svc.projectUsage(MORPH, { range: "7d", groupBy: "day" });
      const csv = svc.toCSV(byDay.rows).split("\n");
      expect(csv).toHaveLength(2);
      const cells = csv[1].split(",");
      expect(cells[2]).toBe("morph:morph-v3");
      expect(cells[4]).toBe(MORPH);
      expect(Number(cells[7])).toBe(1_000);

      // Counted once on each ledger: one project row, one per-user row.
      expect(await db.tokenUsage.count({ where: { projectId: MORPH } })).toBe(1);
      expect(await db.aITokenUsage.count({ where: { sessionId: "morph-sess" } })).toBe(1);
      expect((await summarizeUsage(MORPH)).totalTokens).toBe(1_000);
    });

    describe("project budget window (token-budget-controller createdAt bounds)", () => {
      // Fixed clock: mid-day 2026-03-15 UTC. Only `Date` is faked, so the
      // database driver's timers keep running.
      const NOW = new Date("2026-03-15T12:00:00.000Z");
      const row = (projectId: string, iso: string, totalTokens: number) =>
        db.tokenUsage.create({
          data: {
            projectId,
            provider: "anthropic",
            model: MODEL,
            totalTokens,
            createdAt: new Date(iso),
          },
        });

      it("the daily sum counts only today's rows, with an exclusive day+24h bound", async () => {
        await row(DAILY, "2026-02-15T12:00:00.000Z", 1); // last month
        await row(DAILY, "2026-03-14T23:59:59.999Z", 10); // yesterday, last ms
        await row(DAILY, "2026-03-15T00:00:00.000Z", 100); // today, first ms
        await row(DAILY, "2026-03-15T11:00:00.000Z", 1_000); // today
        await row(DAILY, "2026-03-16T00:00:00.000Z", 10_000); // day+24h — excluded
        await db.tokenBudget.create({ data: { projectId: DAILY, dailyTokenLimit: 1_000_000 } });

        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(NOW);
        try {
          const gauge = await new TokenBudgetController().check(DAILY);
          expect(gauge.remainingTokens).toBe(1_000_000 - 1_100);
        } finally {
          vi.useRealTimers();
        }
      });

      it("the monthly sum counts month-to-date rows only, not last month's", async () => {
        await row(MONTHLY, "2026-02-28T23:59:59.999Z", 1); // last month, last ms
        await row(MONTHLY, "2026-02-10T09:00:00.000Z", 1); // last month
        await row(MONTHLY, "2026-03-01T00:00:00.000Z", 10); // month start, first ms
        await row(MONTHLY, "2026-03-14T08:00:00.000Z", 100); // yesterday
        await row(MONTHLY, "2026-03-15T08:00:00.000Z", 1_000); // today
        await db.tokenBudget.create({
          data: { projectId: MONTHLY, monthlyTokenLimit: 1_000_000 },
        });

        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(NOW);
        try {
          const gauge = await new TokenBudgetController().check(MONTHLY);
          expect(gauge.remainingTokens).toBe(1_000_000 - 1_110);
        } finally {
          vi.useRealTimers();
        }
      });
    });
  },
);
