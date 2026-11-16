/**
 * #2593 — against a REAL SQLite database built by the migration chain:
 *
 *   - the migration and its committed reverse script: up -> reverse -> up over
 *     a seeded run, whose outcomes survive both directions (the Postgres twin
 *     runs the same round trip in the postgres-migrate-deploy CI job);
 *   - the write path: the real engine records, per searched project, whether
 *     it read the project's database, and the real `GET /api/impact-analyses/:id`
 *     returns it, in a new request after the engine call returned;
 *   - the run's cost on that same route: the ledger's sum for the run's session,
 *     in the run's projects only — a row billed to the same id in another
 *     project is not this run's to show.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
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

const MIGRATION = "20261203002593_issue2593_impact_database_connected";
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

const { executeImpactAnalysis } =
  await import("../src/lib/impact-analysis/impact-analysis-engine.js");
const { LiveSchemaIndex } = await import("../src/lib/impact-analysis/live-schema-ingest.js");
const { impactAnalysisRouter } = await import("../src/routes/impact-analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const WS = "ws-2593";
const PA = "proj-a-2593";
const PB = "proj-b-2593";
const PX = "proj-x-2593";

const ONE_CHANGE = {
  extract: async () => [
    {
      requirementId: null,
      title: "API keys expire",
      body: "Add an expiry to API keys.",
      changeType: "added" as const,
      bodyDelta: 20,
    },
  ],
};

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2593 — whether an impact run read each project's database (real SQLite)",
  () => {
    describe("the migration: up -> reverse -> up", () => {
      let sqlite: MigratedSqlite;
      const rollback = readFileSync(
        path.join(SERVER_ROOT, "prisma", "rollbacks", `${MIGRATION}.sql`),
        "utf-8",
      );
      const pgUp = readFileSync(
        path.join(SERVER_ROOT, "prisma", "postgres", "migrations", MIGRATION, "migration.sql"),
        "utf-8",
      );
      const pgDown = readFileSync(
        path.join(SERVER_ROOT, "prisma", "postgres", "rollbacks", `${MIGRATION}.sql`),
        "utf-8",
      );
      const withDb = <T>(fn: (db: Database.Database) => T): T => {
        const db = new Database(sqlite.dbFile);
        try {
          return fn(db);
        } finally {
          db.close();
        }
      };
      const columns = () =>
        withDb((db) =>
          (
            db.prepare(`PRAGMA table_info("impact_analysis_projects")`).all() as Array<{
              name: string;
            }>
          ).map((c) => c.name),
        );
      const rows = () =>
        withDb(
          (db) =>
            db
              .prepare(`SELECT * FROM "impact_analysis_projects" ORDER BY "projectId"`)
              .all() as Array<Record<string, unknown>>,
        );
      let seeded: Array<Record<string, unknown>>;
      let before: string[];

      beforeAll(() => {
        sqlite = createMigratedSqlite("2593-impact-database-connected-migration", {
          stopBefore: MIGRATION,
        });
        withDb((db) => {
          db.pragma("foreign_keys = OFF");
          db.prepare(
            `INSERT INTO "impact_analyses" ("id","status","startedById","updatedAt")
             VALUES ('ia-old', 'completed', 'u-1', CURRENT_TIMESTAMP)`,
          ).run();
          for (const [projectId, outcome] of [
            ["p-old-1", "affected"],
            ["p-old-2", "checked-none-affected"],
          ]) {
            db.prepare(
              `INSERT INTO "impact_analysis_projects" ("analysisId","projectId","outcome")
               VALUES ('ia-old', ?, ?)`,
            ).run(projectId, outcome);
          }
        });
        seeded = rows();
        before = columns();
      }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

      afterAll(() => sqlite?.cleanup());

      it(
        "up adds the column as NULL on existing rows; reverse drops it; up again re-applies",
        () => {
          expect(before).not.toContain("databaseConnected");

          sqlite.apply(MIGRATION);
          expect(columns()).toEqual([...before, "databaseConnected"]);
          // An existing run reads as one recorded before #2593: unknown, never false.
          expect(rows()).toEqual(seeded.map((r) => ({ ...r, databaseConnected: null })));

          // What the rollback's header says is lost: whether each project's database was read.
          withDb((db) =>
            db.prepare(`UPDATE "impact_analysis_projects" SET "databaseConnected" = 0`).run(),
          );
          withDb((db) => db.exec(rollback));
          expect(columns()).toEqual(before);
          expect(rows()).toEqual(seeded);

          sqlite.applyRemaining();
          expect(rows()).toEqual(seeded.map((r) => ({ ...r, databaseConnected: null })));
        },
        MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
      );

      it("the Postgres twin makes the same change and its reverse, idempotently", () => {
        expect(pgUp).toContain(
          `ALTER TABLE "impact_analysis_projects" ADD COLUMN IF NOT EXISTS "databaseConnected" BOOLEAN;`,
        );
        expect(pgDown).toContain(
          `ALTER TABLE "impact_analysis_projects" DROP COLUMN IF EXISTS "databaseConnected";`,
        );
        expect(pgDown).toContain(
          `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`,
        );
        expect(pgUp).not.toMatch(/\bUPDATE\b/);
      });
    });

    describe("the run records it, and the detail route returns it with the run's cost", () => {
      let sqlite: MigratedSqlite;
      let db: PrismaClient;
      const symbol: Record<string, string> = {};

      const payload: AuthPayload = {
        userId: "alice",
        username: "alice",
        role: "coordinator",
        permissions: getPermissionsForRole("coordinator"),
        workspaces: [WS],
      };
      const getRun = (id: string) => {
        const a = express();
        a.use(express.json());
        a.use("/api/impact-analyses", impactAnalysisRouter());
        a.use(notFoundHandler);
        a.use(errorHandler);
        return request(a)
          .get(`/api/impact-analyses/${id}`)
          .set("Authorization", `Bearer ${issueTokens(payload).accessToken}`);
      };

      async function addSymbol(projectId: string, filePath: string, name: string) {
        const row = await db.codeSymbol.create({
          data: {
            codeGraphId: `g-${projectId}`,
            projectId,
            kind: "function",
            name,
            qualifiedName: `${filePath}::${name}`,
            filePath,
            startLine: 1,
            endLine: 10,
            language: "go",
            contentHash: `${projectId}:${filePath}::${name}`,
          },
        });
        return row.id;
      }

      async function createRun(projectIds: string[]): Promise<string> {
        const row = await db.impactAnalysis.create({
          data: {
            status: "pending",
            sourceText: "API keys expire.",
            startedById: "alice",
            projects: { create: projectIds.map((projectId) => ({ projectId })) },
          },
        });
        return row.id;
      }

      const hit = (projectId: string) => [
        {
          codeSymbolId: symbol[projectId]!,
          filePath: "internal/storage/api_key.go",
          qualifiedName: "internal/storage/api_key.go::CreateAPIKey",
          startLine: 1,
          endLine: 10,
          confidence: 1,
        },
      ];

      beforeAll(async () => {
        sqlite = createMigratedSqlite("2593-impact-database-connected");
        db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
        state.db = db;
        await db.role.create({ data: { id: "role-coordinator", key: "coordinator", name: "c" } });
        await db.user.create({
          data: { id: "alice", username: "alice", displayName: "alice", email: "a@example.test" },
        });
        await db.userRole.create({ data: { userId: "alice", roleId: "role-coordinator" } });
        await db.workspace.create({ data: { id: WS, name: WS, slug: WS } });
        await db.workspaceMember.create({
          data: { workspaceId: WS, userId: "alice", role: "member" },
        });
        for (const id of [PA, PB, PX]) {
          await db.project.create({
            data: {
              id,
              name: id,
              slug: id,
              createdById: "alice",
              workspaceId: WS,
              status: "active",
            },
          });
          await db.codeGraph.create({ data: { id: `g-${id}`, projectId: id } });
          symbol[id] = await addSymbol(id, "internal/storage/api_key.go", "CreateAPIKey");
        }
      }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

      afterAll(async () => {
        await db?.$disconnect();
        sqlite?.cleanup();
      });

      it("returns true for the project whose database was read and false for the other", async () => {
        const id = await createRun([PA, PB]);
        await executeImpactAnalysis(id, [PA, PB], {
          extractor: ONE_CHANGE,
          mapRequirement: async (_req: unknown, projectId: string) => hit(projectId),
          // A's database connector answered; B has none.
          liveIndexIntrospectorFor: async (projectId: string) =>
            projectId === PA ? new LiveSchemaIndex([]) : null,
        });

        const res = await getRun(id);
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe("completed");
        expect(res.body.data.projectOutcomes).toEqual([
          { projectId: PA, outcome: "affected", reason: null, databaseConnected: true },
          { projectId: PB, outcome: "affected", reason: null, databaseConnected: false },
        ]);
      });

      it("returns the ledger's cost for the run's session in its projects, and none for a run with no call", async () => {
        const id = await createRun([PA]);
        await executeImpactAnalysis(id, [PA], {
          extractor: ONE_CHANGE,
          mapRequirement: async (_req: unknown, projectId: string) => hit(projectId),
          includeSchemaImpact: false,
        });

        const none = await getRun(id);
        expect(none.body.data.cost).toEqual({ calls: 0, costUsd: null, unpricedTokens: 0 });

        const row = (projectId: string, costUsd: number) => ({
          projectId,
          sessionId: id,
          provider: "anthropic",
          model: "claude-sonnet-5-5",
          inputTokens: 1000,
          outputTokens: 100,
          totalTokens: 1100,
          costCents: Math.round(costUsd * 100),
          costUsd,
          agentStep: "impact.summary-item",
        });
        await db.tokenUsage.create({ data: row(PA, 0.3) });
        await db.tokenUsage.create({ data: row(PA, 0.17) });
        // Billed to the same id in a project that is not the run's: not counted.
        await db.tokenUsage.create({ data: row(PX, 5) });

        const res = await getRun(id);
        expect(res.status).toBe(200);
        expect(res.body.data.cost.calls).toBe(2);
        expect(res.body.data.cost.costUsd).toBeCloseTo(0.47, 6);
        expect(res.body.data.cost.unpricedTokens).toBe(0);
      });
    });
  },
);
