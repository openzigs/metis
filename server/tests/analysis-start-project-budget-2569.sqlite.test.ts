/**
 * #2569 — an analysis is refused while its project is over its own monthly
 * token budget, as chat and discussions are (`assertWithinBudget`). Proven
 * through the real analysis router and the real `AnalysisOrchestrator.start`
 * over a real SQLite database (only the background pipeline is stubbed, so no
 * agent runs): the over-budget project gets a 402 `BUDGET_EXCEEDED` and no
 * `Analysis` row; a project with budget left still starts. Regenerate,
 * Continue and resume are refused the same way.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return { db: null as unknown };
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
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: vi.fn(),
}));

const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { AnalysisOrchestrator } = await import("../src/lib/analysis/orchestrator.js");
const { BudgetExceededError } = await import("../src/lib/finops/budget-enforcer.js");
const { isPermanentTaskFailure } = await import("../src/lib/scheduler/permanent-failure.js");

const WS = "ws-2569";
const OVER = "proj-2569-over";
const UNDER = "proj-2569-under";
const OVER_RUN = "ana-2569-over-done";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2569 — the project's own budget at analysis start (real router, real orchestrator)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let DEV = "";
    const pipeline = vi.fn(async () => undefined);
    let orchestrator: InstanceType<typeof AnalysisOrchestrator>;

    const app = () => {
      const a = express();
      a.use(express.json());
      const routers = initAnalysisRouter({ orchestrator });
      a.use("/api/projects/:projectId/analyses", routers.projectScoped);
      a.use("/api/analyses", routers.topLevel);
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const start = (projectId: string) =>
      request(app())
        .post(`/api/projects/${projectId}/analyses`)
        .set("Authorization", `Bearer ${DEV}`)
        .send({ agentKeys: ["document"], extraInstructions: "Add a refund button." });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2569-project-budget");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: "u-dev", username: "u-dev", displayName: "dev", email: "dev@example.test" },
      });
      await db.workspace.create({ data: { id: WS, name: "ws", slug: WS } });
      await db.workspaceMember.create({
        data: { workspaceId: WS, userId: "u-dev", role: "member" },
      });
      // Both projects have a 1,000-token monthly budget: one has spent it.
      for (const id of [OVER, UNDER]) {
        await db.project.create({
          data: {
            id,
            name: id,
            slug: id,
            createdById: "u-dev",
            workspaceId: WS,
            monthlyTokenBudget: 1000,
          },
        });
      }
      const usage = (projectId: string, totalTokens: number) =>
        db.tokenUsage.create({
          data: {
            projectId,
            provider: "offline-stub",
            model: "offline-stub",
            inputTokens: totalTokens,
            outputTokens: 0,
            totalTokens,
          },
        });
      await usage(OVER, 1000);
      await usage(UNDER, 10);
      await db.analysis.create({
        data: { id: OVER_RUN, projectId: OVER, startedById: "u-dev", status: "completed" },
      });
      DEV = issueTokens({
        userId: "u-dev",
        username: "u-dev",
        role: "developer",
        permissions: [],
        workspaces: [WS],
      }).accessToken;
      orchestrator = new AnalysisOrchestrator({
        provider: { key: "offline-stub", model: "offline-stub", offline: true } as never,
      });
      // No agent runs: the run's pipeline is the only thing stubbed.
      (orchestrator as unknown as { runPipeline: typeof pipeline }).runPipeline = pipeline;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("a project over its monthly budget gets 402 BUDGET_EXCEEDED, and no Analysis row", async () => {
      const before = await db.analysis.count({ where: { projectId: OVER } });
      const res = await start(OVER);
      expect(res.status).toBe(402);
      expect(res.body.error).toMatchObject({
        code: "BUDGET_EXCEEDED",
        details: { usedTokens: 1000, budget: 1000 },
      });
      expect(await db.analysis.count({ where: { projectId: OVER } })).toBe(before);
      expect(pipeline).not.toHaveBeenCalled();
    });

    it("the scheduler's re-run of an over-budget project fails permanently, so it is not retried", async () => {
      // `rerunAnalysis` (scheduler/handler-overrides.ts) calls `start` as this does.
      const err = await orchestrator.start({ projectId: OVER, startedById: "system" }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(BudgetExceededError);
      expect(isPermanentTaskFailure(err)).toBe(true);
    });

    it("a project with budget left still starts", async () => {
      const res = await start(UNDER);
      expect(res.status).toBe(202);
      const row = await db.analysis.findFirst({ where: { id: res.body.data.id } });
      expect(row?.projectId).toBe(UNDER);
      expect(pipeline).toHaveBeenCalledTimes(1);
    });

    it("regenerate, Continue and resume are refused while the project is over budget", async () => {
      await expect(orchestrator.assertCanRegenerate(OVER_RUN)).rejects.toBeInstanceOf(
        BudgetExceededError,
      );
      await expect(orchestrator.assertCanResumeRepos(OVER_RUN)).rejects.toBeInstanceOf(
        BudgetExceededError,
      );
      const res = await request(app())
        .post(`/api/analyses/${OVER_RUN}/agents/code/regenerate`)
        .set("Authorization", `Bearer ${DEV}`)
        .send({});
      expect(res.status).toBe(402);
      expect(res.body.error.code).toBe("BUDGET_EXCEEDED");
    });
  },
);
