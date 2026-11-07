/**
 * #1969 — the engine's affected-file count keys a file by (repository, path),
 * read through the real graph load (`loadProjectGraph` and the Prisma data
 * source, with their select) against a real SQLite database built by the
 * migration chain.
 *
 * The live check's shape: `src/types/order.ts` exists in both the orders and
 * the billing repository of one project. Keyed by path alone, the run counted
 * one affected file, which the markdown export printed as "Affected files" and
 * the summarizer passed to the model as `affectedFiles=`.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  computeProjectImpact,
  loadProjectGraph,
  PrismaCodeGraphDataSource,
} from "../src/lib/impact-analysis/impact-analysis-engine.js";
import type { RequirementCodeMatch } from "../src/lib/traceability/requirement-code-mapping.js";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const USER = "u-1969";
const PROJ = "p-1969";
const SHARED_PATH = "src/types/order.ts";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1969 — affected files counted per repository (real graph load, real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const repoIds: string[] = [];
    const seeds: RequirementCodeMatch[] = [];

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1969-impact-file-count-by-repo");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@x.test` },
      });
      await db.workspace.create({ data: { id: "ws-1969", name: "ws", slug: "ws-1969" } });
      await db.project.create({
        data: { id: PROJ, name: "Shop", slug: PROJ, createdById: USER, workspaceId: "ws-1969" },
      });
      for (const repoName of ["metis-fixture-orders", "metis-fixture-billing"]) {
        const repo = await db.repoConnection.create({
          data: { projectId: PROJ, label: repoName, ownerOrOrg: "openzigs", repoName },
        });
        repoIds.push(repo.id);
        const graph = await db.codeGraph.create({
          data: { projectId: PROJ, repoConnectionId: repo.id },
        });
        const symbol = await db.codeSymbol.create({
          data: {
            codeGraphId: graph.id,
            projectId: PROJ,
            kind: "interface",
            name: "Order",
            qualifiedName: `${SHARED_PATH}::Order`,
            filePath: SHARED_PATH,
            startLine: 8,
            endLine: 13,
            language: "ts",
            contentHash: `hash-${repoName}`,
          },
        });
        seeds.push({
          codeSymbolId: symbol.id,
          filePath: SHARED_PATH,
          qualifiedName: symbol.qualifiedName,
          startLine: 8,
          endLine: 13,
          confidence: 0.9,
        });
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    const change = {
      requirementId: null,
      title: "Add a currency to the order",
      body: "b",
      changeType: "added" as const,
      bodyDelta: 1,
    };

    it("reads each symbol's repository in the bulk graph load", async () => {
      const graph = await loadProjectGraph(db, PROJ);
      const rows = await graph.getSymbolsByIds(seeds.map((s) => s.codeSymbolId!));
      expect(rows.map((r) => r.repoConnectionId).sort()).toEqual([...repoIds].sort());
    });

    it("counts the path in each repository as its own file (bulk graph load)", async () => {
      const graph = await loadProjectGraph(db, PROJ);
      const result = await computeProjectImpact(change, PROJ, {
        mapRequirement: async () => seeds,
        dataSourceFor: () => graph,
      });
      expect(result.affectedSymbolCount).toBe(2);
      expect(result.affectedFileCount).toBe(2);
    });

    it("counts the path in each repository as its own file (per-query data source)", async () => {
      const result = await computeProjectImpact(change, PROJ, {
        mapRequirement: async () => seeds,
        dataSourceFor: (projectId) => new PrismaCodeGraphDataSource(db, projectId),
      });
      expect(result.affectedFileCount).toBe(2);
    });
  },
);
