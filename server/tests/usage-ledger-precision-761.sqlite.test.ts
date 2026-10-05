/**
 * #761 / #854 — the usage ledger against a REAL SQLite database built by the
 * real migration chain.
 *
 *   - #761: `token_usages.costCents` is rounded per row, so N sub-cent calls
 *     summed to 0. The `costUsd` column holds each row's unrounded cost, every
 *     reader sums it, and the migration backfills existing rows from
 *     `costCents / 100`.
 *   - #854: the platform ("All projects") scope and `GET /api/admin/usage` read
 *     `ai_token_usages`, which held ~1% of the spend `token_usages` did. They
 *     read the ledger now, and never sum the two tables.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

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

const { recordUsageAndFlush } = await import("../src/lib/finops/token-tracker.js");
const { assertWithinBudget, summarizeUsage, projectMonthlyCostForCeiling } =
  await import("../src/lib/finops/budget-enforcer.js");
const { UsageService } = await import("../src/lib/usage/usage-service.js");
const { rollupWorkspaceUsage } = await import("../src/lib/workspaces/usage-rollup.js");
const { loadProjectWindow } = await import("../src/lib/finops/forecast-service.js");

const MIGRATION = "20261014000761_issue761_token_usage_cost_usd";
const USER = "u-761";

/** gpt-4o-mini: 1,000 in + 1,000 out = 0.015 + 0.06 = 0.075¢, which rounds to 0. */
const SUB_CENT_CALL = {
  provider: "openai",
  model: "gpt-4o-mini",
  inputTokens: 1_000,
  outputTokens: 1_000,
};
const CALLS = 67;
const EXACT_CENTS = CALLS * 0.075; // 5.025¢

async function seedProject(db: PrismaClient, id: string, workspaceId?: string): Promise<void> {
  await db.project.create({
    data: {
      id,
      name: id,
      slug: id,
      createdById: USER,
      ...(workspaceId ? { workspaceId } : {}),
    },
  });
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#761 migration — backfills costUsd from costCents (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("761-backfill", { stopBefore: MIGRATION });
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@x.test` },
      });
      await seedProject(db, "p-legacy");
      await db.$disconnect();
      // Rows in the pre-#761 shape: one priced, one unpriced (#22).
      sqlite.exec(
        `INSERT INTO "token_usages" ("id","projectId","provider","model","totalTokens","costCents") VALUES (?,?,?,?,?,?)`,
        ["t-priced", "p-legacy", "openai", "gpt-4o", 5000, 7],
      );
      sqlite.exec(
        `INSERT INTO "token_usages" ("id","projectId","provider","model","totalTokens","costCents") VALUES (?,?,?,?,?,?)`,
        ["t-unpriced", "p-legacy", "anthropic", "deepseek-v4-pro", 900, null],
      );
      sqlite.apply(MIGRATION);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it("sets costUsd = costCents / 100 on a priced row, and leaves an unpriced row NULL", () => {
      const raw = new Database(sqlite.dbFile, { readonly: true });
      try {
        const rows = raw
          .prepare(`SELECT "id", "costCents", "costUsd" FROM "token_usages" ORDER BY "id"`)
          .all() as Array<{ id: string; costCents: number | null; costUsd: number | null }>;
        expect(rows).toEqual([
          { id: "t-priced", costCents: 7, costUsd: 0.07 },
          { id: "t-unpriced", costCents: null, costUsd: null },
        ]);
      } finally {
        raw.close();
      }
    });
  },
);

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#761 / #854 — sub-cent calls and the platform scope (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("761-ledger");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@x.test` },
      });
      await db.workspace.create({ data: { id: "ws-761", name: "ws", slug: "ws-761" } });
      await seedProject(db, "p-a", "ws-761");
      await seedProject(db, "p-b");
      for (let i = 0; i < CALLS; i += 1) {
        await recordUsageAndFlush({
          projectId: "p-a",
          sessionId: "s-a",
          userId: USER,
          agentStep: "analysis",
          ...SUB_CENT_CALL,
        });
      }
      await recordUsageAndFlush({
        projectId: "p-b",
        sessionId: "s-b",
        provider: "openai",
        model: "gpt-4o",
        inputTokens: 4_000,
        outputTokens: 1_000,
      });
      // Chat also writes every call to `ai_token_usages` with identical tokens
      // (#854). This one must never be added on top of the ledger.
      await db.aISession.create({
        data: { id: "chat-1", userId: USER, projectId: "p-b", provider: "openai", model: "gpt-4o" },
      });
      await db.aITokenUsage.create({
        data: {
          sessionId: "chat-1",
          userId: USER,
          provider: "openai",
          model: "gpt-4o",
          promptTokens: 4_000,
          completionTokens: 1_000,
          totalTokens: 5_000,
          dayBucket: new Date().toISOString().slice(0, 10),
          projectId: "p-b",
          estimatedCostUsd: 0.02,
        },
      });
      // `apply_diff` writes its `ai_token_usages` row with NO projectId while
      // mirroring the call into `token_usages` for the session's project. Its
      // session is project-scoped, so the platform scope must not add it.
      await db.aITokenUsage.create({
        data: {
          sessionId: "chat-1",
          userId: USER,
          provider: "openai",
          model: "morph:v3",
          promptTokens: 200,
          completionTokens: 100,
          totalTokens: 300,
          dayBucket: new Date().toISOString().slice(0, 10),
          estimatedCostUsd: 0.001,
        },
      });
      // A chat session with no project (multi-project or stale-project scope):
      // `token_usages` cannot hold its spend, because projectId is required
      // there, so this is the only record of it.
      await db.aISession.create({
        data: { id: "chat-free", userId: USER, provider: "openai", model: "gpt-4o" },
      });
      await db.aITokenUsage.create({
        data: {
          sessionId: "chat-free",
          userId: USER,
          provider: "openai",
          model: "gpt-4o",
          promptTokens: 500,
          completionTokens: 200,
          totalTokens: 700,
          dayBucket: new Date().toISOString().slice(0, 10),
          estimatedCostUsd: 0.003,
        },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("stores each sub-cent call's exact cost, while costCents still rounds it to 0", async () => {
      const rows = await db.tokenUsage.findMany({ where: { projectId: "p-a" } });
      expect(rows).toHaveLength(CALLS);
      for (const r of rows) {
        expect(r.costCents).toBe(0);
        expect(r.costUsd).toBeCloseTo(0.00075, 12);
      }
    });

    it("the project summary and budget snapshot sum the exact cost: 67 × 0.075¢ = 5¢, not 0¢", async () => {
      const summary = await summarizeUsage("p-a");
      expect(summary.costCents).toBe(Math.round(EXACT_CENTS));
      expect(summary.byProvider[0].costCents).toBe(Math.round(EXACT_CENTS));
      expect(summary.byDay[0].costCents).toBe(Math.round(EXACT_CENTS));
      const snap = await assertWithinBudget("p-a");
      expect(snap.monthToDateCostCents).toBe(Math.round(EXACT_CENTS));
      const ceiling = await projectMonthlyCostForCeiling("p-a");
      expect(ceiling.projectedCents).toBeGreaterThanOrEqual(Math.round(EXACT_CENTS));
    });

    it("the project usage view reports the exact USD total", async () => {
      const usage = await new UsageService().projectUsage("p-a");
      expect(usage.totalCostUsd).toBeCloseTo(EXACT_CENTS / 100, 10);
    });

    it("#854 — the platform scope reads token_usages, once: both projects, chat not double-counted", async () => {
      const usage = await new UsageService().adminUsage({ groupBy: "project" });
      expect(usage.totalTokens).toBe(CALLS * 2_000 + 5_000 + 700);
      expect(usage.totalCostUsd).toBeCloseTo((EXACT_CENTS + 2 + 0.3) / 100, 10);
      const byProject = Object.fromEntries(usage.rows.map((r) => [r.projectId ?? "-", r]));
      expect(byProject["p-a"].count).toBe(CALLS);
      expect(byProject["p-b"].totalTokens).toBe(5_000);
    });

    it("#854 — chat spend from a session with no project stays in the platform scope, as 'unassigned'", async () => {
      const usage = await new UsageService().adminUsage({ groupBy: "project" });
      const unassigned = usage.rows.filter((r) => r.projectId === undefined);
      expect(unassigned).toHaveLength(1);
      expect(unassigned[0].totalTokens).toBe(700);
      expect(unassigned[0].estimatedCostUsd).toBeCloseTo(0.003, 10);
    });

    it("#854 — the platform scope filters both sources by userId", async () => {
      const usage = await new UsageService().adminUsage({ userId: USER, groupBy: "user" });
      expect(usage.totalTokens).toBe(CALLS * 2_000 + 700);
      expect(usage.rows.map((r) => r.userId)).toEqual([USER]);
      const other = await new UsageService().adminUsage({ userId: "someone-else" });
      expect(other.totalTokens).toBe(0);
    });

    it("the workspace daily rollup and the project forecast window carry the sub-cent spend", async () => {
      await rollupWorkspaceUsage(new Date());
      const daily = await db.workspaceUsageDaily.findMany({ where: { workspaceId: "ws-761" } });
      expect(daily).toHaveLength(1);
      expect(daily[0].costCents).toBe(Math.round(EXACT_CENTS));
      const window = await loadProjectWindow("p-a");
      const total = window.reduce((s, p) => s + p.costCents, 0);
      expect(total).toBeCloseTo(EXACT_CENTS, 9);
    });
  },
);
