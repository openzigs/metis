/**
 * #1609 — a multi-project impact run records an outcome for EVERY project, so a
 * business analyst can tell "checked, nothing affected" from "never checked".
 *
 * Before this, the engine dropped a project with no affected symbols
 * (`if (result.affectedSymbolCount === 0) continue;`) and the run read as if
 * that project had never been looked at.
 *
 * Workspace `ws1` holds projects A (has a hit), B (indexed, no hit) and C (no
 * indexed symbols); Alice is a member. Workspace `ws2` holds project R, which
 * Alice cannot open. Ada is a system admin.
 *
 * Real SQLite built by the migration chain, the real engine (with an injected
 * requirement mapper, so no model is called), the real project-access rule and
 * the real `GET /api/impact-analyses/:id` route the UI reads. Every assertion is
 * made on what that route returns AFTER the engine call has returned — never on
 * the engine's in-memory result.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole, type AuthPayload, type RoleKey } from "@metis/shared";
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

const { executeImpactAnalysis } =
  await import("../src/lib/impact-analysis/impact-analysis-engine.js");
const { impactAnalysisRouter, executionAccessCheck } =
  await import("../src/routes/impact-analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const WS1 = "ws1-1609";
const WS2 = "ws2-1609";
const PA = "proj-a-1609";
const PB = "proj-b-1609";
const PC = "proj-c-1609";
const PR = "proj-r-1609";
/** R's name and symbol: neither may appear anywhere in a run that skipped R. */
const R_NAME = "Restricted Payroll 1609";
const R_SYMBOL = "payroll/secret.ts::computeSalary";

const USERS: Record<string, { role: RoleKey; ws: string }> = {
  alice: { role: "coordinator", ws: WS1 },
  ada: { role: "admin", ws: WS2 },
};
type Who = keyof typeof USERS;

const ONE_CHANGE = {
  extract: async () => [
    {
      requirementId: null,
      title: "Record when an entry was read",
      body: "Add a read timestamp.",
      changeType: "added" as const,
      bodyDelta: 20,
    },
  ],
};

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1609 — a multi-project impact run keeps every project as an explicit outcome",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const symbol: Record<string, string> = {};

    const userPayload = (who: Who): AuthPayload => ({
      userId: who,
      username: who,
      role: USERS[who].role,
      permissions: getPermissionsForRole(USERS[who].role),
      workspaces: [USERS[who].ws],
    });
    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/impact-analyses", impactAnalysisRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const getRun = (id: string, who: Who) =>
      request(app())
        .get(`/api/impact-analyses/${id}`)
        .set("Authorization", `Bearer ${issueTokens(userPayload(who)).accessToken}`);

    async function addSymbol(projectId: string, filePath: string, name: string): Promise<string> {
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
          language: "typescript",
          contentHash: `${projectId}:${filePath}::${name}`,
        },
      });
      return row.id;
    }

    /** A run row exactly as `triggerImpactAnalysis` writes it: the run plus its project rows. */
    async function createRun(projectIds: string[]): Promise<string> {
      const row = await db.impactAnalysis.create({
        data: {
          status: "pending",
          sourceText: "Record when an entry was read.",
          startedById: "alice",
          projects: { create: projectIds.map((projectId) => ({ projectId })) },
        },
      });
      return row.id;
    }

    /** The requirement mapper: A's handler is a hit; nothing else matches. */
    const mapRequirement = vi.fn(async (_req: unknown, projectId: string) =>
      projectId === PA
        ? [
            {
              codeSymbolId: symbol.aHandler,
              filePath: "src/entry.ts",
              qualifiedName: "src/entry.ts::markRead",
              startLine: 1,
              endLine: 10,
              confidence: 0.9,
            },
          ]
        : [],
    );

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1609-impact-project-outcomes");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const key of ["coordinator", "admin"]) {
        await db.role.create({ data: { id: `role-${key}`, key, name: key } });
      }
      for (const [id, u] of Object.entries(USERS)) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
        await db.userRole.create({ data: { userId: id, roleId: `role-${u.role}` } });
      }
      for (const ws of [WS1, WS2]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      for (const [userId, u] of Object.entries(USERS)) {
        await db.workspaceMember.create({ data: { workspaceId: u.ws, userId, role: "member" } });
      }
      for (const [id, name, workspaceId] of [
        [PA, PA, WS1],
        [PB, PB, WS1],
        [PC, PC, WS1],
        [PR, R_NAME, WS2],
      ] as const) {
        await db.project.create({
          data: { id, name, slug: id, createdById: "alice", workspaceId, status: "active" },
        });
      }
      // A and B are indexed; C has no code graph at all. R is indexed too, so a
      // `restricted` outcome cannot be mistaken for a `no-index` one.
      for (const projectId of [PA, PB, PR]) {
        await db.codeGraph.create({ data: { id: `g-${projectId}`, projectId } });
      }
      symbol.aHandler = await addSymbol(PA, "src/entry.ts", "markRead");
      symbol.aCaller = await addSymbol(PA, "src/api.ts", "handleMarkRead");
      await db.codeEdge.create({
        data: {
          codeGraphId: `g-${PA}`,
          projectId: PA,
          fromSymbolId: symbol.aCaller,
          toSymbolId: symbol.aHandler,
          kind: "calls",
          filePath: "src/api.ts",
          line: 5,
        },
      });
      await addSymbol(PB, "src/billing.ts", "chargeCard");
      await addSymbol(PR, "payroll/secret.ts", "computeSalary");
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("lists A affected, B checked-none-affected and C not-checked/no-index on the persisted run", async () => {
      const id = await createRun([PA, PB, PC]);
      await executeImpactAnalysis(id, [PA, PB, PC], {
        extractor: ONE_CHANGE,
        mapRequirement,
        includeSchemaImpact: false,
        projectAccessible: executionAccessCheck({ id: "alice", role: "coordinator" }, [PA, PB, PC]),
      });

      const res = await getRun(id, "alice");
      expect(res.status).toBe(200);
      const detail = res.body.data;
      expect(detail.status).toBe("completed");
      // None is omitted, and the order is the run's project order.
      expect(detail.projectOutcomes).toEqual([
        { projectId: PA, outcome: "affected", reason: null },
        { projectId: PB, outcome: "checked-none-affected", reason: null },
        { projectId: PC, outcome: "not-checked", reason: "no-index" },
      ]);

      // The report stays focused: only A carries an item and symbol rows, and
      // the run's count is A's count alone.
      expect(detail.items.map((i: { projectId: string }) => i.projectId)).toEqual([PA]);
      const [itemA] = detail.items as { affectedSymbolCount: number; affectedSymbols: unknown[] }[];
      expect(itemA.affectedSymbols.length).toBeGreaterThan(0);
      expect(detail.totalImpactedSymbols).toBe(itemA.affectedSymbolCount);
      expect(
        await db.impactItem.count({ where: { impactAnalysisId: id, projectId: { in: [PB, PC] } } }),
      ).toBe(0);
    });

    it("records a project the starter cannot open as not-checked/restricted, naming nothing of it", async () => {
      mapRequirement.mockClear();
      // The route refuses to START a run over R for Alice; this is the run whose
      // access changed before it executed, so the engine's own check decides.
      const id = await createRun([PA, PR]);
      await executeImpactAnalysis(id, [PA, PR], {
        extractor: ONE_CHANGE,
        mapRequirement,
        includeSchemaImpact: false,
        projectAccessible: executionAccessCheck({ id: "alice", role: "coordinator" }, [PA, PR]),
      });

      // R was never searched.
      expect(mapRequirement.mock.calls.map((c) => c[1])).toEqual([PA]);

      // Alice still cannot read a run that spans R (unchanged rule).
      expect((await getRun(id, "alice")).status).toBe(404);

      const res = await getRun(id, "ada");
      expect(res.status).toBe(200);
      const detail = res.body.data;
      const outcomeR = detail.projectOutcomes.find(
        (o: { projectId: string }) => o.projectId === PR,
      );
      // The id, the outcome and the reason: nothing else about R.
      expect(outcomeR).toStrictEqual({
        projectId: PR,
        outcome: "not-checked",
        reason: "restricted",
      });
      expect(detail.items.map((i: { projectId: string }) => i.projectId)).toEqual([PA]);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(R_NAME);
      expect(body).not.toContain(R_SYMBOL);
    });
  },
);
