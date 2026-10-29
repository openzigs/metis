/**
 * #1528 — a scheduled analysis re-run starts, on a REAL Postgres.
 *
 * The Postgres twin of `scheduled-analysis-system-start-1528.sqlite.test.ts`:
 * the real scheduler `rerun-analysis` handler and a real `AnalysisOrchestrator`
 * (stub model) against the `postgres-adapter` job's database, whose schema is
 * pushed from `server/prisma/postgres/schema.prisma`. Before #1528 the run's
 * `analyses` insert failed the `startedById` foreign key; the system start is
 * now stored as NULL. (`postgres-migrate-deploy` proves the migration chain
 * reaches the same schema.)
 *
 * Its rows use ids unique to this run and are removed afterwards, since the job's
 * suites share the database. Gated like the other `*-postgres.integration.test.ts`
 * suites: runs only when `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is
 * Postgres-shaped.
 */
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatResponse } from "../src/lib/ai/types.js";
import type { KnowledgeService } from "../src/lib/rag/knowledge-service.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgres;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
    resolveDatabaseProvider: () => "postgresql" as const,
  };
});
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: vi.fn(),
}));

const MODEL = "claude-sonnet-4-6";
const agentJson = JSON.stringify({
  summary: "summary",
  findings: [
    { category: "security", severity: "medium", title: "A finding", body: "Body", tags: [] },
  ],
  notes: [],
});
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
} as unknown as AIProvider;
const stubKnowledge = { search: async () => ({ hits: [] }) } as unknown as KnowledgeService;

describe.runIf(enabled)("#1528 a scheduled analysis re-run starts on real Postgres", () => {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const USER = `u-1528-${suffix}`;
  const PROJECT = `p-1528-${suffix}`;
  let db: PrismaClient;
  let handlers: typeof import("../src/lib/scheduler/handler-overrides.js");

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    state.db = db;
    await db.user.create({
      data: { id: USER, username: USER, displayName: USER, email: `${USER}@example.test` },
    });
    await db.project.create({
      data: { id: PROJECT, name: PROJECT, slug: PROJECT, createdById: USER },
    });
    handlers = await import("../src/lib/scheduler/handler-overrides.js");
    const { AnalysisOrchestrator } = await import("../src/lib/analysis/orchestrator.js");
    handlers.__setAnalysisOrchestratorForHandlers(
      new AnalysisOrchestrator({
        provider,
        knowledge: stubKnowledge,
        webSearchConfigured: () => false,
      }),
    );
  });

  afterAll(async () => {
    handlers?.__setAnalysisOrchestratorForHandlers(null);
    if (db) {
      // The project's analyses (and what hangs off them) cascade with it.
      await db.project.deleteMany({ where: { id: PROJECT } });
      await db.user.deleteMany({ where: { id: USER } });
      await db.$disconnect();
    }
  });

  it("starts, records the system start as NULL, and settles", async () => {
    const out = (await handlers.buildSchedulerHandlerOverrides().rerunAnalysis!(
      PROJECT,
      new AbortController().signal,
    )) as { analysisId: string };
    let row = await db.analysis.findUniqueOrThrow({ where: { id: out.analysisId } });
    expect(row.startedById).toBeNull();
    for (let i = 0; i < 400 && row.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 25));
      row = await db.analysis.findUniqueOrThrow({ where: { id: out.analysisId } });
    }
    expect(row.status, row.errorMessage ?? "").toBe("completed");
  });
});
