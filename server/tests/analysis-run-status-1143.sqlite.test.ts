/**
 * Issue #1143 — the run list and the snapshot carry what the run status badge
 * reads (`failedAgents`, `droppedCitations`), against a REAL SQLite database
 * built by the real migration chain.
 *
 * The mocked `analysis-ledger-tokens-1007.test.ts` fixture ignores `select`
 * and always returns `agentResults: []`, so it passed with the list's
 * `agentResults` select removed and with `failedAgents` a constant `[]`. Here
 * the real query must load each run's agent rows, and a run with a failed
 * agent must be named.
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

const state = vi.hoisted(() => ({ db: null as unknown }));
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

const { listAnalysesForProject, getAnalysisSnapshot } =
  await import("../src/lib/analysis/analysis-service.js");

const USER = "u-1143";
const PROJECT = "p-1143";
const ERRORS = "an-errors";
const WARNINGS = "an-warnings";
const CLEAN = "an-clean";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1143 run status fields on the run list and snapshot (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1143-run-status");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@x.test` },
      });
      await db.project.create({
        data: { id: PROJECT, name: PROJECT, slug: PROJECT, createdById: USER },
      });
      const capability = (droppedCitations?: Array<{ agentKey: string; count: number }>) =>
        JSON.stringify({
          capability: {
            codeAnalysisRequested: false,
            databaseAnalysisRequested: false,
            codeGraphPresent: false,
            agentMode: "single-shot",
            repoSourceIngested: false,
            fusedCodeRetrievalEnabled: true,
            schemaContextEnabled: true,
            quarantineFallbackUsed: false,
            skippedRepos: [],
            ...(droppedCitations ? { droppedCitations } : {}),
            reasons: droppedCitations ? ["citations-dropped"] : [],
          },
        });
      const runs: Array<{
        id: string;
        minute: number;
        metadata: string;
        agents: Array<[string, string]>;
      }> = [
        {
          id: ERRORS,
          minute: 30,
          metadata: capability(),
          agents: [
            ["document", "completed"],
            ["code", "failed"],
            ["code", "failed"],
            ["database", "cancelled"],
          ],
        },
        {
          id: WARNINGS,
          minute: 20,
          metadata: capability([{ agentKey: "document", count: 2 }]),
          agents: [
            ["document", "completed"],
            ["code", "completed"],
          ],
        },
        {
          id: CLEAN,
          minute: 10,
          metadata: capability(),
          agents: [
            ["document", "completed"],
            ["code", "completed"],
          ],
        },
      ];
      for (const r of runs) {
        const at = new Date(Date.UTC(2026, 9, 15, 10, r.minute));
        await db.analysis.create({
          data: {
            id: r.id,
            projectId: PROJECT,
            startedById: USER,
            status: "completed",
            startedAt: at,
            completedAt: at,
            metadata: r.metadata,
          },
        });
        for (const [agentKey, status] of r.agents) {
          await db.agentResult.create({
            data: { analysisId: r.id, agentKey, status, startedAt: at, completedAt: at },
          });
        }
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("the run list names each run's failed agents, read from its agent rows", async () => {
      const list = await listAnalysesForProject(PROJECT);
      const byId = new Map(list.map((r) => [r.id, r]));
      expect(byId.get(ERRORS)!.failedAgents).toEqual(["code"]);
      expect(byId.get(WARNINGS)!.failedAgents).toEqual([]);
      expect(byId.get(CLEAN)!.failedAgents).toEqual([]);
      // Summarised, not returned.
      expect(byId.get(ERRORS)).not.toHaveProperty("agentResults");
    });

    it("the run list carries each run's dropped citations from its capability record", async () => {
      const list = await listAnalysesForProject(PROJECT);
      const byId = new Map(list.map((r) => [r.id, r]));
      expect(byId.get(WARNINGS)!.droppedCitations).toEqual([{ agentKey: "document", count: 2 }]);
      expect(byId.get(ERRORS)!.droppedCitations).toEqual([]);
      expect(byId.get(CLEAN)!.droppedCitations).toEqual([]);
    });

    it("the snapshot carries the same two fields as the run's list row", async () => {
      const list = await listAnalysesForProject(PROJECT);
      for (const id of [ERRORS, WARNINGS, CLEAN]) {
        const snap = (await getAnalysisSnapshot(id))!;
        const row = list.find((r) => r.id === id)!;
        expect(snap.failedAgents).toEqual(row.failedAgents);
        expect(snap.droppedCitations).toEqual(row.droppedCitations);
      }
      expect((await getAnalysisSnapshot(ERRORS))!.failedAgents).toEqual(["code"]);
    });
  },
);
