/**
 * #1965 — an impact result on a project with several repositories keys its files
 * by (repository, path), through the real read path: `GET /api/impact-analyses/:id`
 * on the real router, real auth and project-access check, real
 * `getImpactAnalysisDetail` and its Prisma include, against a real SQLite
 * database built by the migration chain.
 *
 * The live check's shape: `src/types/order.ts` exists in both the orders and the
 * billing repository of one project. Keyed by path alone, the two files merged
 * into one and no row named its repository.
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

const state = vi.hoisted(() => {
  // The route limiters read their caps at module load.
  process.env.RATE_LIMIT_MAX = "100000";
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

import express from "express";
import request from "supertest";
import { getPermissionsForRole, type ImpactAnalysisDetail } from "@metis/shared";

const { impactAnalysisRouter } = await import("../src/routes/impact-analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const USER = "u-1965";
const PROJ = "p-1965";
const RUN = "ia-1965";
const SHARED_PATH = "src/types/order.ts";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1965 — multi-repo impact files on GET /api/impact-analyses/:id (real router, real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let token: string;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/impact-analyses", impactAnalysisRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };

    /** One connected repository with its code graph and one symbol at `filePath`. */
    async function repoWithSymbol(repoName: string, filePath: string): Promise<string> {
      const repo = await db.repoConnection.create({
        data: { projectId: PROJ, label: `${repoName} connector`, ownerOrOrg: "openzigs", repoName },
      });
      const graph = await db.codeGraph.create({
        data: { projectId: PROJ, repoConnectionId: repo.id },
      });
      const symbol = await db.codeSymbol.create({
        data: {
          codeGraphId: graph.id,
          projectId: PROJ,
          kind: "interface",
          name: "OrderCreatedEvent",
          qualifiedName: `${filePath}::OrderCreatedEvent`,
          filePath,
          startLine: 16,
          endLine: 21,
          language: "ts",
          contentHash: `hash-${repoName}`,
        },
      });
      return symbol.id;
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1965-impact-multi-repo-files");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;

      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@x.test` },
      });
      await db.workspace.create({ data: { id: "ws-1965", name: "ws", slug: "ws-1965" } });
      await db.workspaceMember.create({ data: { workspaceId: "ws-1965", userId: USER } });
      await db.project.create({
        data: { id: PROJ, name: "Shop", slug: PROJ, createdById: USER, workspaceId: "ws-1965" },
      });
      const ordersSymbol = await repoWithSymbol("metis-fixture-orders", SHARED_PATH);
      const billingSymbol = await repoWithSymbol("metis-fixture-billing", SHARED_PATH);

      await db.impactAnalysis.create({
        data: {
          id: RUN,
          status: "completed",
          sourceText: "Add a currency to the order-created event",
          startedById: USER,
          projects: { create: [{ projectId: PROJ }] },
        },
      });
      const item = await db.impactItem.create({
        data: { impactAnalysisId: RUN, projectId: PROJ, requirementTitle: "Order currency" },
      });
      for (const codeSymbolId of [ordersSymbol, billingSymbol]) {
        await db.impactAffectedSymbol.create({
          data: {
            impactItemId: item.id,
            codeSymbolId,
            filePath: SHARED_PATH,
            qualifiedName: `${SHARED_PATH}::OrderCreatedEvent`,
            relation: "direct",
            depth: 0,
          },
        });
      }

      token = issueTokens({
        userId: USER,
        username: USER,
        role: "developer",
        permissions: getPermissionsForRole("developer"),
        workspaces: ["ws-1965"],
      }).accessToken;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("lists the shared path once per repository, and each symbol names its repository", async () => {
      const res = await request(app())
        .get(`/api/impact-analyses/${RUN}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const [item] = (res.body.data as ImpactAnalysisDetail).items;

      const repos = item.affectedSymbols.map((s) => s.repo?.name).sort();
      expect(repos).toEqual(["metis-fixture-billing", "metis-fixture-orders"]);
      expect(item.editCandidateFiles).toHaveLength(2);
      expect(item.blastRadiusFiles).toHaveLength(2);
      expect(new Set(item.editCandidateFiles.map((f) => f.repoConnectionId)).size).toBe(2);
      expect(item.editCandidateFiles.every((f) => f.filePath === SHARED_PATH)).toBe(true);
      // Each file's repository is the one its symbol names.
      const symbolRepoIds = item.affectedSymbols.map((s) => s.repo?.id).sort();
      expect(item.editCandidateFiles.map((f) => f.repoConnectionId).sort()).toEqual(symbolRepoIds);
    });
  },
);
