/**
 * #755 — a run whose every specialist failed must end `failed`, not `completed`.
 *
 * The orchestrator's non-sequenced phase answered each agent the parallel
 * phase had already run with a zero-usage placeholder that settled
 * `fulfilled`, so every failure was cancelled out by a phantom success and the
 * all-failed gate never fired unless document AND code were both selected.
 * Here a REAL `AnalysisOrchestrator` runs over a real migrated SQLite database
 * with a provider that fails on demand, and the final status is read back from
 * the `analyses` row.
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
import type { AIProvider, ChatMessage, ChatOptions, ChatResponse } from "../src/lib/ai/types.js";
import type { AnalysisSpecialistAgentKey } from "@metis/shared";
import type { KnowledgeService } from "../src/lib/rag/knowledge-service.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
    // #779 — `persistRequirements` picks its row locking by provider; this
    // suite runs a real SQLite client, so it pins the SQLite path.
    resolveDatabaseProvider: () => "sqlite" as const,
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { AnalysisOrchestrator } = await import("../src/lib/analysis/orchestrator.js");

const PROJECT = "p-755";
const USER = "u-755";
const MODEL = "claude-sonnet-4-6";
const USAGE = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

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

/** The web agent's mandate (`prompts.ts`) — identifies its calls in the prompt. */
const WEB_AGENT_MARKER = "Identify applicable industry standards";

/** Fails every call, or (`"web"`) only the web agent's calls. */
function provider(failing: "all" | "web"): AIProvider {
  const fails = (messages: ChatMessage[], opts?: ChatOptions) =>
    failing === "all" || JSON.stringify([opts?.systemMessage, messages]).includes(WEB_AGENT_MARKER);
  return {
    key: "anthropic",
    model: MODEL,
    offline: false,
    async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> {
      if (fails(messages, opts)) throw new Error("provider exploded");
      return { content: agentJson, usage: { ...USAGE }, model: MODEL, provider: "anthropic" };
    },
    async *stream() {
      throw new Error("provider exploded");
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
}

const stubKnowledge = { search: async () => ({ hits: [] }) } as unknown as KnowledgeService;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#755 — an analysis whose every specialist failed is marked failed (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("755-all-agents-failed");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@example.test` },
      });
      await db.project.create({
        data: { id: PROJECT, name: PROJECT, slug: PROJECT, createdById: USER },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    async function runToEnd(
      agentKeys: AnalysisSpecialistAgentKey[],
      p: AIProvider,
    ): Promise<{ status: string; errorMessage: string | null }> {
      const orch = new AnalysisOrchestrator({ provider: p, knowledge: stubKnowledge });
      const { id } = await orch.start({ projectId: PROJECT, startedById: USER, agentKeys });
      for (let i = 0; i < 400; i++) {
        const row = await db.analysis.findUnique({ where: { id } });
        if (row && ["completed", "failed", "cancelled"].includes(row.status)) {
          return { status: row.status, errorMessage: row.errorMessage };
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`analysis ${id} never settled`);
    }

    it("a single failing web agent ends the run failed, naming the cause", async () => {
      const row = await runToEnd(["web"], provider("all"));
      expect(row.status).toBe("failed");
      expect(row.errorMessage).toContain("All 1 specialist agent(s) failed");
      expect(row.errorMessage).toContain("provider exploded");
    });

    it("web and database both failing ends the run failed", async () => {
      const row = await runToEnd(["web", "database"], provider("all"));
      expect(row.status).toBe("failed");
      expect(row.errorMessage).toContain("All 2 specialist agent(s) failed");
    });

    it("is not web-specific: a single failing document agent ends the run failed", async () => {
      const row = await runToEnd(["document"], provider("all"));
      expect(row.status).toBe("failed");
    });

    it("partial success still completes — one agent succeeding is useful output", async () => {
      const row = await runToEnd(["web", "database"], provider("web"));
      expect(row.status).toBe("completed");
    });
  },
);
