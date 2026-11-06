/**
 * #1832 (epic #1827) — impact analysis does not lead with a code citation that
 * re-validation found out of date, and the run says how many it set aside.
 *
 * Real SQLite built from the migration chain. The impact engine runs for real
 * (`executeImpactAnalysis`, `IMPACT_AGENT_SEEDS` on, the production Prisma
 * code-graph data source and citation lookups); only the hybrid code search is
 * a double that finds nothing, so every edit file comes from the stored
 * citations. The result is read back through `GET /api/impact-analyses/:id`,
 * the route the UI reads: the counts must survive the response schema, not only
 * the function's return.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole, type AuthPayload } from "@metis/shared";
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
  const actual =
    await vi.importActual<typeof import("../src/lib/prisma.js")>("../src/lib/prisma.js");
  return {
    ...actual,
    get prisma() {
      return state.db;
    },
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
// The hybrid search finds nothing: the stored citations are the only seeds.
vi.mock("../src/lib/code-graph/project-code-searcher.js", () => ({
  createDefaultCodeSearcher: () => ({ search: async () => [] }),
  createRunScopedSymbolIndex: () => ({}),
}));

const { executeImpactAnalysis } =
  await import("../src/lib/impact-analysis/impact-analysis-engine.js");
const { impactAnalysisRouter } = await import("../src/routes/impact-analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const USER = "u-1832";
const PROJ = "proj-1832";
const REQ = "req-1832-xxxxxxx";
const FRESH = "internal/reader/age.go";
const STALE = "internal/reader/removed_logic.go";
const LEGACY = "internal/reader/legacy.go";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1832 — stale citations are set aside and counted, through the impact API",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let runId = "";

    const user: AuthPayload = {
      userId: USER,
      username: USER,
      role: "admin",
      permissions: getPermissionsForRole("admin"),
      workspaces: [],
    };
    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/impact-analyses", impactAnalysisRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1832-impact-stale-citations");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.role.create({ data: { id: "role-admin", key: "admin", name: "admin" } });
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@example.test` },
      });
      await db.userRole.create({ data: { userId: USER, roleId: "role-admin" } });
      await db.project.create({
        data: { id: PROJ, name: PROJ, slug: PROJ, createdById: USER, status: "active" },
      });
      await db.analysis.create({
        data: { id: "an-1832", projectId: PROJ, startedById: USER, status: "completed" },
      });
      const graph = await db.codeGraph.create({ data: { projectId: PROJ, commitSha: "abc1234" } });
      // Every cited file is still in the graph: only the freshness verdict differs.
      for (const [i, filePath] of [FRESH, STALE, LEGACY].entries()) {
        await db.codeSymbol.create({
          data: {
            codeGraphId: graph.id,
            projectId: PROJ,
            kind: "function",
            name: `fn${i}`,
            qualifiedName: `${filePath}::fn${i}`,
            filePath,
            startLine: 10,
            endLine: 40,
            language: "go",
            contentHash: `h${i}`,
          },
        });
      }
      await db.requirement.create({
        data: {
          id: REQ,
          projectId: PROJ,
          analysisId: "an-1832",
          title: "Mark entries older than X as read",
          body: "Let a reader mark every entry older than a chosen age as read.",
        },
      });
      for (const [filePath, freshness, confidence] of [
        // The surest citation is the stale one: demotion, not confidence, keeps it out.
        [STALE, "stale", 0.95],
        [FRESH, "fresh", 0.5],
        [LEGACY, "unverified", 0.9],
      ] as const) {
        await db.requirementCodeMapping.create({
          data: {
            requirementId: REQ,
            projectId: PROJ,
            filePath,
            startLine: 10,
            endLine: 40,
            confidence,
            source: "analysis-grounding",
            codeGraphId: graph.id,
            freshness,
            ...(freshness === "stale" ? { staleReason: "content-changed" } : {}),
          },
        });
      }
      const run = await db.impactAnalysis.create({
        data: { status: "pending", startedById: USER, requirementIds: JSON.stringify([REQ]) },
      });
      await db.impactAnalysisProject.create({ data: { analysisId: run.id, projectId: PROJ } });
      runId = run.id;
      await executeImpactAnalysis(runId, [PROJ], {
        prisma: db,
        includeSchemaImpact: false,
        agentSeeds: true,
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("GET /api/impact-analyses/:id returns demotedStaleCitations and unverifiedCitations", async () => {
      const res = await request(app())
        .get(`/api/impact-analyses/${runId}`)
        .set("Authorization", `Bearer ${issueTokens(user).accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("completed");
      const evidence = res.body.data.items[0].seedEvidence;
      expect(evidence.agentCitations).toEqual({
        used: 2,
        stale: 0,
        led: 2,
        demotedStaleCitations: 1,
        unverifiedCitations: 1,
      });
      // Fresh first, the never-checked one after it, the stale one nowhere.
      const editFiles = evidence.editCandidates.map((e: { filePath: string }) => e.filePath);
      expect(editFiles).toEqual([FRESH, LEGACY]);
      expect(res.body.data.summary).toContain(
        "1 code-agent citation was set aside: the code it cites changed since the analysis.",
      );
    });
  },
);
