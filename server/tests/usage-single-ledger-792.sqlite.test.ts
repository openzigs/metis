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
const { getTokenTracker } = await import("../src/lib/ai/token-tracker.js");

const PROJECT = "p-792";
const OTHER = "p-792-other";
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
      for (const id of [PROJECT, OTHER]) {
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
  },
);
