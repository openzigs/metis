/**
 * #2566 — the per-project code exploration setting (`Project.codeExploration`
 * = `auto | explore | fast`), against a REAL SQLite database built by the
 * migration chain:
 *
 *   - the migration and its committed reverse script: up -> reverse -> up over
 *     seeded projects, which survive both directions (the Postgres twin runs
 *     the same round trip in the postgres-migrate-deploy CI job);
 *   - the write path: `PATCH /api/projects/:id/code-exploration` through the
 *     real router, read back by `GET /api/projects/:id` in a new request over
 *     a NEW Prisma client, then a code pass whose capability snapshot (read in
 *     a fresh client) says `fast` / `project-fast`;
 *   - the partition: setting A leaves B's snapshot alone, and a coordinator
 *     of A alone cannot PATCH B (404);
 *   - validation and roles: a value outside the set is a 400 at the route and
 *     a rejection in the service; a role without `project.update` is a 403;
 *     neither writes anything (re-read).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const MIGRATION = "20261201002566_issue2566_project_code_exploration";
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const state = vi.hoisted(() => ({
  db: null as unknown,
  audits: [] as Array<{ action: string; metadata?: unknown }>,
  warnings: [] as string[],
}));
// The orchestrator's warnings, so a degraded read can be seen to say so.
vi.mock("../src/lib/logger.js", async (original) => {
  const actual = await original<typeof import("../src/lib/logger.js")>();
  return {
    ...actual,
    createChildLogger: (module: string) => {
      const child = actual.createChildLogger(module);
      if (module !== "analysis-orchestrator") return child;
      return new Proxy(child, {
        get(target, prop, receiver) {
          if (prop === "warn") {
            return (message: string, ...rest: unknown[]) => {
              state.warnings.push(message);
              return target.warn(message, ...(rest as []));
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    },
  };
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
vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: vi.fn((entry: { action: string; metadata?: unknown }) => {
    state.audits.push(entry);
  }),
}));
vi.mock("../src/lib/analysis/analysis-service.js", async (original) => ({
  ...(await original<typeof import("../src/lib/analysis/analysis-service.js")>()),
  persistAgentResult: vi.fn(async () => ({ id: "ar-2566", findingIds: [] })),
}));
vi.mock("../src/lib/rag/embedder.js", async (original) => ({
  ...(await original<typeof import("../src/lib/rag/embedder.js")>()),
  getEmbedder: () => ({ model: "embed-a", knownIdentity: () => "embed-a|mean" }),
}));

const { projectsRouter } = await import("../src/routes/projects.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { updateProjectCodeExploration } = await import("../src/lib/projects/project-service.js");
const { AnalysisOrchestrator } = await import("../src/lib/analysis/orchestrator.js");
const { createCapabilityTracker, finalizeCapability } =
  await import("../src/lib/analysis/analysis-capability.js");
const { getAnalysisSnapshot, persistAnalysisCapability } =
  await import("../src/lib/analysis/analysis-service.js");
const { __resetConfigSingleton } = await import("../src/lib/config/config-service.js");

const ANA = "u-ana";
const RITA = "u-rita";
const BEN = "u-ben";
const A = "p-2566-a";
const B = "p-2566-b";
const ANSWER = JSON.stringify({ agentKey: "code", summary: "done", findings: [], notes: [] });

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2566 — the per-project code exploration setting (real SQLite)",
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
          (db.prepare(`PRAGMA table_info("projects")`).all() as Array<{ name: string }>).map(
            (c) => c.name,
          ),
        );
      const rows = () =>
        withDb(
          (db) =>
            db.prepare(`SELECT * FROM "projects" ORDER BY "id"`).all() as Array<
              Record<string, unknown>
            >,
        );
      let seeded: Array<Record<string, unknown>>;
      let before: string[];

      beforeAll(() => {
        sqlite = createMigratedSqlite("2566-code-exploration-migration", {
          stopBefore: MIGRATION,
        });
        withDb((db) => {
          db.pragma("foreign_keys = OFF");
          for (const id of ["p-old-1", "p-old-2"]) {
            db.prepare(
              `INSERT INTO "projects" ("id","name","slug","createdById","updatedAt")
               VALUES (?, ?, ?, 'u-1', CURRENT_TIMESTAMP)`,
            ).run(id, id, id);
          }
        });
        seeded = rows();
        before = columns();
      }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

      afterAll(() => sqlite?.cleanup());

      it(
        "up adds the column at auto on existing rows; reverse drops it; up again re-applies",
        () => {
          expect(before).not.toContain("codeExploration");

          sqlite.apply(MIGRATION);
          expect(columns()).toEqual([...before, "codeExploration"]);
          expect(rows()).toEqual(seeded.map((r) => ({ ...r, codeExploration: "auto" })));

          // What the rollback's header says is lost: each project's setting.
          withDb((db) => db.prepare(`UPDATE "projects" SET "codeExploration" = 'fast'`).run());
          withDb((db) => db.exec(rollback));
          expect(columns()).toEqual(before);
          expect(rows()).toEqual(seeded);

          sqlite.applyRemaining();
          expect(rows()).toEqual(seeded.map((r) => ({ ...r, codeExploration: "auto" })));
        },
        MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
      );

      it("the Postgres twin makes the same change and its reverse, idempotently", () => {
        expect(pgUp).toContain(
          `ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "codeExploration" TEXT NOT NULL DEFAULT 'auto';`,
        );
        expect(pgDown).toContain(`ALTER TABLE "projects" DROP COLUMN IF EXISTS "codeExploration";`);
        expect(pgDown).toContain(
          `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`,
        );
        expect(pgUp).not.toMatch(/\bUPDATE\b/);
      });
    });

    describe("the setting: written by the route, read by the project GET and the code pass", () => {
      let sqlite: MigratedSqlite;
      let db: PrismaClient;
      let cloneRoot: string;
      const savedCloneDir = process.env.REPO_CLONE_DIR;

      const app = () => {
        const a = express();
        a.use(express.json());
        a.use("/api/projects", projectsRouter());
        a.use(notFoundHandler);
        a.use(errorHandler);
        return a;
      };
      const token = (userId: string, role: "coordinator" | "reader", workspaces: string[]) =>
        `Bearer ${
          issueTokens({ userId, username: userId, role, permissions: [], workspaces }).accessToken
        }`;
      /** Swap in a NEW Prisma client, so a read cannot be served from the writer's. */
      const freshClient = async () => {
        const old = state.db as PrismaClient;
        state.db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
        await old.$disconnect();
        return state.db as PrismaClient;
      };
      const stored = async (id: string) =>
        (await (state.db as PrismaClient).project.findUniqueOrThrow({ where: { id } }))
          .codeExploration;

      beforeAll(async () => {
        sqlite = createMigratedSqlite("2566-code-exploration");
        db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
        state.db = db;
        for (const id of [ANA, RITA, BEN]) {
          await db.user.create({
            data: { id, username: id, displayName: id, email: `${id}@example.test` },
          });
        }
        for (const ws of ["ws-a", "ws-b"]) {
          await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
        }
        await db.workspaceMember.create({ data: { workspaceId: "ws-a", userId: ANA } });
        await db.workspaceMember.create({ data: { workspaceId: "ws-a", userId: RITA } });
        await db.workspaceMember.create({ data: { workspaceId: "ws-b", userId: BEN } });
        cloneRoot = mkdtempSync(path.join(os.tmpdir(), "metis-2566-"));
        for (const [id, ws, createdById] of [
          [A, "ws-a", ANA],
          [B, "ws-b", BEN],
        ] as const) {
          await db.project.create({
            data: { id, name: id, slug: id, createdById, workspaceId: ws },
          });
          await db.repoConnection.create({
            data: { id: `rc-${id}`, projectId: id, label: "app", isPrimary: true },
          });
          await db.codeGraph.create({
            data: {
              id: `g-${id}`,
              projectId: id,
              repoConnectionId: `rc-${id}`,
              commitSha: "a".repeat(40),
              lastIndexedAt: new Date(),
            },
          });
          mkdirSync(path.join(cloneRoot, `rc-${id}`, "src"), { recursive: true });
          writeFileSync(path.join(cloneRoot, `rc-${id}`, "src", "fee.ts"), "export const f = 1;\n");
        }
      }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

      afterEach(() => {
        delete process.env.ANALYSIS_CODE_EXPLORATION;
        __resetConfigSingleton();
        state.audits.length = 0;
      });

      afterAll(async () => {
        if (savedCloneDir === undefined) delete process.env.REPO_CLONE_DIR;
        else process.env.REPO_CLONE_DIR = savedCloneDir;
        await (state.db as PrismaClient | null)?.$disconnect();
        sqlite?.cleanup();
        if (cloneRoot) rmSync(cloneRoot, { recursive: true, force: true });
      });

      /** One code pass over `projectId` (stub model), its capability persisted and read back in a fresh client. */
      const codePassSnapshot = async (projectId: string) => {
        const analysisId = `an-2566-${projectId}-${Date.now()}`;
        const client = state.db as PrismaClient;
        await client.analysis.create({
          data: { id: analysisId, projectId, status: "completed", startedById: ANA },
        });
        const orch = new AnalysisOrchestrator({
          provider: {
            key: "offline-stub",
            model: "stub",
            offline: true,
            chat: vi.fn(async () => ({
              content: ANSWER,
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              model: "stub",
              provider: "offline-stub",
            })),
          } as never,
          retrieve: async () => [],
          knowledge: { search: async () => ({ hits: [] }) } as never,
          fusedCode: {
            searcher: { search: async () => [] },
            lineLookup: { resolve: async () => new Map() },
          },
          prepareRepoClone: async () => "healthy",
        }) as unknown as {
          capabilities: Map<string, ReturnType<typeof createCapabilityTracker>>;
          runAgenticCodeAgent: (input: Record<string, unknown>) => Promise<unknown>;
        };
        const tracker = createCapabilityTracker({
          static: {
            codeGraphPresent: true,
            repoSourceIngested: true,
            fusedCodeRetrievalEnabled: true,
            schemaContextEnabled: true,
          },
          codeAnalysisRequested: true,
          databaseAnalysisRequested: false,
        });
        orch.capabilities.set(analysisId, tracker);
        process.env.REPO_CLONE_DIR = cloneRoot;
        await orch.runAgenticCodeAgent({
          analysisId,
          projectId,
          projectName: projectId,
          projectDescription: "fees",
          requirements: [{ id: "REQ-1", text: "Compute the fee." }],
          signal: new AbortController().signal,
          connectorId: `rc-${projectId}`,
        });
        await persistAnalysisCapability(analysisId, finalizeCapability(tracker));
        await freshClient();
        return (await getAnalysisSnapshot(analysisId))?.capability;
      };

      it("PATCH fast, then GET in a new request over a new client, then a code pass: all read fast", async () => {
        process.env.ANALYSIS_CODE_EXPLORATION = "explore";
        __resetConfigSingleton();
        const coordinator = token(ANA, "coordinator", ["ws-a"]);
        const patched = await request(app())
          .patch(`/api/projects/${A}/code-exploration`)
          .set("Authorization", coordinator)
          .send({ codeExploration: "fast" });
        expect(patched.status).toBe(200);
        expect(patched.body.data).toMatchObject({
          codeExploration: "fast",
          codeExplorationResolved: { mode: "fast", reason: "project-fast" },
        });
        expect(state.audits).toEqual([
          expect.objectContaining({
            action: "project.codeExploration.update",
            metadata: { previous: "auto", next: "fast" },
          }),
        ]);

        await freshClient();
        const read = await request(app())
          .get(`/api/projects/${A}`)
          .set("Authorization", coordinator);
        expect(read.status).toBe(200);
        expect(read.body.data).toMatchObject({
          codeExploration: "fast",
          codeExplorationResolved: { mode: "fast", reason: "project-fast" },
        });

        expect(await codePassSnapshot(A)).toMatchObject({
          codePassMode: "fast",
          codePassModeReason: "project-fast",
        });
        // The partition: B still follows the platform (explore here).
        expect(await codePassSnapshot(B)).toMatchObject({
          codePassMode: "explore",
          codePassModeReason: "platform-default",
        });
        const readB = await request(app())
          .get(`/api/projects/${B}`)
          .set("Authorization", token(BEN, "coordinator", ["ws-b"]));
        expect(readB.body.data).toMatchObject({
          codeExploration: "auto",
          codeExplorationResolved: { mode: "explore", reason: "platform-default" },
        });
      });

      it("a project's explore setting wins over a fast platform", async () => {
        // #2587 — the platform default is explore now, so a fast platform is set.
        process.env.ANALYSIS_CODE_EXPLORATION = "fast";
        __resetConfigSingleton();
        await (state.db as PrismaClient).project.update({
          where: { id: B },
          data: { codeExploration: "explore" },
        });
        try {
          expect(await codePassSnapshot(B)).toMatchObject({
            codePassMode: "explore",
            codePassModeReason: "project-explore",
          });
        } finally {
          await (state.db as PrismaClient).project.update({
            where: { id: B },
            data: { codeExploration: "auto" },
          });
        }
      });

      it("#2587 — no key and no project setting: the GET and a code pass both read explore", async () => {
        delete process.env.ANALYSIS_CODE_EXPLORATION;
        __resetConfigSingleton();
        await (state.db as PrismaClient).project.update({
          where: { id: B },
          data: { codeExploration: "auto" },
        });
        await freshClient();
        const read = await request(app())
          .get(`/api/projects/${B}`)
          .set("Authorization", token(BEN, "coordinator", ["ws-b"]));
        expect(read.body.data).toMatchObject({
          codeExploration: "auto",
          codeExplorationResolved: { mode: "explore", reason: "platform-default" },
        });
        expect(await codePassSnapshot(B)).toMatchObject({
          codePassMode: "explore",
          codePassModeReason: "platform-default",
          codePassOutcomes: [expect.objectContaining({ mode: "explore" })],
        });
      });

      it("a failed project read degrades to the platform default, not fast, and the pass still runs", async () => {
        process.env.ANALYSIS_CODE_EXPLORATION = "explore";
        __resetConfigSingleton();
        const client = state.db as PrismaClient;
        await client.project.update({ where: { id: A }, data: { codeExploration: "fast" } });
        // Only the orchestrator's read of the setting fails; every other query is the real one.
        const failing = new Proxy(client, {
          get(target, prop) {
            const value = Reflect.get(target, prop) as unknown;
            if (prop === "project") {
              const delegate = value as PrismaClient["project"];
              return new Proxy(delegate, {
                get(d, key) {
                  if (key === "findFirst") {
                    return async (args?: { select?: { codeExploration?: boolean } }) => {
                      if (args?.select?.codeExploration)
                        throw new Error("projects table unreadable");
                      return d.findFirst(args as never);
                    };
                  }
                  return Reflect.get(d, key) as unknown;
                },
              });
            }
            return typeof value === "function" ? (value as () => unknown).bind(target) : value;
          },
        });
        state.db = failing;
        state.warnings.length = 0;
        try {
          expect(await codePassSnapshot(A)).toMatchObject({
            codePassMode: "explore",
            codePassModeReason: "platform-default",
          });
          expect(state.warnings).toContain(
            "Project code exploration setting unreadable; using the platform default",
          );
        } finally {
          if (state.db === failing) state.db = client;
          await (state.db as PrismaClient).project.update({
            where: { id: A },
            data: { codeExploration: "fast" },
          });
        }
      });

      it("a coordinator of A alone gets a 404 for B, and B is unchanged", async () => {
        const res = await request(app())
          .patch(`/api/projects/${B}/code-exploration`)
          .set("Authorization", token(RITA, "coordinator", ["ws-a"]))
          .send({ codeExploration: "fast" });
        expect(res.status).toBe(404);
        await freshClient();
        expect(await stored(B)).toBe("auto");
        expect(state.audits).toEqual([]);
      });

      it("a value outside auto | explore | fast is a 400, and nothing is written", async () => {
        const before = await stored(A);
        for (const body of [
          { codeExploration: "deep" },
          { codeExploration: 1 },
          {},
          { codeExploration: "fast", extra: true },
        ]) {
          const res = await request(app())
            .patch(`/api/projects/${A}/code-exploration`)
            .set("Authorization", token(ANA, "coordinator", ["ws-a"]))
            .send(body);
          expect(res.status).toBe(400);
          // Refused by the route's schema, before the service is reached.
          expect(res.body.error.code).toBe("VALIDATION_ERROR");
        }
        await freshClient();
        expect(await stored(A)).toBe(before);
      });

      it("the service rejects a value outside the set too", async () => {
        const before = await stored(A);
        await expect(
          updateProjectCodeExploration(A, "deep" as never, { id: ANA, role: "coordinator" }),
        ).rejects.toMatchObject({ status: 400, code: "INVALID_CODE_EXPLORATION_SETTING" });
        expect(await stored(A)).toBe(before);
      });

      it("a role without project.update gets a 403, and nothing is written", async () => {
        const before = await stored(A);
        const res = await request(app())
          .patch(`/api/projects/${A}/code-exploration`)
          .set("Authorization", token(ANA, "reader", ["ws-a"]))
          .send({ codeExploration: before === "fast" ? "explore" : "fast" });
        expect(res.status).toBe(403);
        await freshClient();
        expect(await stored(A)).toBe(before);
        expect(state.audits).toEqual([]);
      });
    });
  },
);
