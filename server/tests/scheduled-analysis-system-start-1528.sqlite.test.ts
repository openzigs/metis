/**
 * #1528 — a scheduled analysis re-run starts.
 *
 * The scheduler's `rerun-analysis` handler started its run with `startedById:
 * "system"`, and `Analysis.startedById` was a required foreign key to `User`.
 * No user has that id, so `createAnalysis` failed the insert ("Foreign key
 * constraint violated on the foreign key") and the scheduled run never started.
 * Reproduced here before the fix, on this database, through this handler.
 *
 * The fix stores a system start as `startedById: NULL` (the orchestrator is
 * still handed `SYSTEM_ACTOR_ID`, so the audit rows read `actorType: "system"`,
 * #1518), and keeps the foreign key's ON DELETE RESTRICT, so NULL never means a
 * deleted user.
 *
 * Real SQLite built by the migration chain, the real scheduler handler, a real
 * `AnalysisOrchestrator` and the real audit service; only the model is a stub.
 * The Postgres twin is `scheduled-analysis-system-start-1528-postgres.integration.test.ts`.
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
import type { KnowledgeService } from "../src/lib/rag/knowledge-service.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
    resolveDatabaseProvider: () => "sqlite" as const,
  };
});

const { AnalysisOrchestrator } = await import("../src/lib/analysis/orchestrator.js");
const { buildSchedulerHandlerOverrides, __setAnalysisOrchestratorForHandlers } =
  await import("../src/lib/scheduler/handler-overrides.js");
const { createAnalysis } = await import("../src/lib/analysis/analysis-service.js");
const { __resetAuditSingleton } = await import("../src/lib/audit/audit-service.js");
const { SYSTEM_ACTOR_ID } = await import("../src/lib/audit/system-actor.js");

const PROJECT = "p-1528";
const AUTOPILOT_PROJECT = "p-1528-autopilot";
const USER = "u-1528";
const MODEL = "claude-sonnet-4-6";

const agentJson = JSON.stringify({
  summary: "summary",
  findings: [
    {
      category: "security",
      severity: "medium",
      title: "A finding",
      body: "Body",
      tags: [],
      citations: [],
    },
  ],
  notes: [],
});

/** Answers every call with one well-formed specialist answer. */
const provider = {
  key: "anthropic",
  model: MODEL,
  offline: false,
  async chat(): Promise<ChatResponse> {
    return {
      content: agentJson,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      model: MODEL,
      provider: "anthropic",
    };
  },
  async *stream() {
    throw new Error("not used");
  },
  async embed() {
    return { vectors: [], dimensions: 0, model: "stub" };
  },
  async models() {
    return [MODEL];
  },
  async ping() {
    return true;
  },
} as unknown as AIProvider;
const stubKnowledge = { search: async () => ({ hits: [] }) } as unknown as KnowledgeService;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1528 — a scheduled analysis re-run starts (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1528-scheduled-analysis");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      __resetAuditSingleton();
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@example.test` },
      });
      await db.project.create({
        data: { id: PROJECT, name: PROJECT, slug: PROJECT, createdById: USER },
      });
      await db.project.create({
        data: {
          id: AUTOPILOT_PROJECT,
          name: AUTOPILOT_PROJECT,
          slug: AUTOPILOT_PROJECT,
          createdById: USER,
          autopilotEnabled: true,
        },
      });
      __setAnalysisOrchestratorForHandlers(
        new AnalysisOrchestrator({
          provider,
          knowledge: stubKnowledge,
          webSearchConfigured: () => false,
        }),
      );
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      __setAnalysisOrchestratorForHandlers(null);
      __resetAuditSingleton();
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    async function settled(id: string) {
      for (let i = 0; i < 400; i++) {
        const row = await db.analysis.findUniqueOrThrow({ where: { id } });
        if (["completed", "failed", "cancelled"].includes(row.status)) return row;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`analysis ${id} never settled`);
    }

    it("starts, records a system start as NULL, and runs to completion", async () => {
      const out = (await buildSchedulerHandlerOverrides().rerunAnalysis!(
        PROJECT,
        new AbortController().signal,
      )) as { analysisId: string };
      const row = await settled(out.analysisId);
      expect(row.projectId).toBe(PROJECT);
      expect(row.startedById).toBeNull();
      expect(row.status, row.errorMessage ?? "").toBe("completed");
    });

    it("starts through the autopilot rails too", async () => {
      const out = (await buildSchedulerHandlerOverrides().rerunAnalysis!(
        AUTOPILOT_PROJECT,
        new AbortController().signal,
      )) as { analysisId: string };
      const row = await settled(out.analysisId);
      expect(row.startedById).toBeNull();
      expect(row.status, row.errorMessage ?? "").toBe("completed");
    });

    it("audits the start as the system, not as a user", async () => {
      let rows: Array<{ actorId: string | null; metadata: string | null }> = [];
      for (let i = 0; i < 200 && rows.length === 0; i++) {
        rows = await db.auditLog.findMany({
          where: { action: "analysis.start", targetType: "analysis" },
          select: { actorId: true, metadata: true },
        });
        if (rows.length === 0) await new Promise((r) => setTimeout(r, 25));
      }
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.actorId).toBeNull();
        expect(JSON.parse(r.metadata ?? "{}")).toMatchObject({ actorType: "system" });
      }
    });

    it("still records the user who started a run, and a user with runs cannot be deleted", async () => {
      // A user whose only tie to anything is the run they started.
      const starter = "u-1528-starter";
      await db.user.create({
        data: { id: starter, username: starter, displayName: starter, email: `${starter}@x.test` },
      });
      const row = await createAnalysis({
        projectId: PROJECT,
        startedById: starter,
        agentKeys: ["document"],
      });
      expect(row.startedById).toBe(starter);
      // ON DELETE RESTRICT is kept, so a NULL starter can only mean the system.
      await expect(db.user.delete({ where: { id: starter } })).rejects.toThrow();
      expect((await db.analysis.findUniqueOrThrow({ where: { id: row.id } })).startedById).toBe(
        starter,
      );
    });

    it("never persists the system id itself", async () => {
      const row = await createAnalysis({
        projectId: PROJECT,
        startedById: SYSTEM_ACTOR_ID,
        agentKeys: ["document"],
      });
      expect(row.startedById).toBeNull();
      expect(await db.analysis.count({ where: { startedById: SYSTEM_ACTOR_ID } })).toBe(0);
    });
  },
);
