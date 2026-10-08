/**
 * #864 — with no web search provider configured, the web specialist says so
 * once and adds no findings.
 *
 * Run 3 of the #706 walkthrough: web research found nothing for all 15 evidence
 * needs, and the web agent — which has no web access of its own and was served
 * document-RAG only — then cited `internal/reader/icon/finder_test.go`'s
 * licence header at score 0 as evidence. A REAL `AnalysisOrchestrator` runs
 * here over a real migrated SQLite database, and the outcome is read back from
 * the `agent_results` / `findings` rows a consumer reads.
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
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { AnalysisOrchestrator } = await import("../src/lib/analysis/orchestrator.js");
const { NO_WEB_SEARCH_PROVIDER_NOTICE } =
  await import("../src/lib/analysis/web-research-augmenter.js");

const PROJECT = "p-864";
const USER = "u-864";
const MODEL = "claude-sonnet-4-6";

/** The web agent's mandate (`prompts.ts`) — identifies its calls in the prompt. */
const WEB_AGENT_MARKER = "Identify applicable industry standards";

/** The finding run 3 produced: a local test file's licence header. */
const licenceHeaderFinding = JSON.stringify({
  summary: "Cited local files",
  findings: [
    {
      category: "compliance",
      severity: "low",
      title: "Licence header in finder_test.go",
      body: "SPDX-License-Identifier: Apache-2.0",
      tags: [],
      citations: [],
    },
  ],
  notes: [],
});

function recordingProvider(): AIProvider & { webCalls: number } {
  const p = {
    key: "anthropic",
    model: MODEL,
    offline: false,
    webCalls: 0,
    async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> {
      if (JSON.stringify([opts?.systemMessage, messages]).includes(WEB_AGENT_MARKER)) {
        p.webCalls += 1;
      }
      return {
        content: licenceHeaderFinding,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        model: MODEL,
        provider: "anthropic",
      };
    },
    async *stream() {
      throw new Error("unused");
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
  };
  return p as unknown as AIProvider & { webCalls: number };
}

const stubKnowledge = { search: async () => ({ hits: [] }) } as unknown as KnowledgeService;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#864 — the web specialist with no web search provider (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("864-web-no-provider");
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

    async function runToEnd(webSearchConfigured: boolean) {
      const provider = recordingProvider();
      const orch = new AnalysisOrchestrator({
        provider,
        knowledge: stubKnowledge,
        webSearchConfigured: () => webSearchConfigured,
      });
      const { id } = await orch.start({
        projectId: PROJECT,
        startedById: USER,
        agentKeys: ["web"],
      });
      for (let i = 0; i < 400; i++) {
        const row = await db.analysis.findUnique({ where: { id } });
        if (row && ["completed", "failed", "cancelled"].includes(row.status)) {
          const web = await db.agentResult.findFirst({
            where: { analysisId: id, agentKey: "web" },
          });
          const findings = await db.finding.count({ where: { agentResult: { analysisId: id } } });
          return { row, web, findings, webCalls: provider.webCalls };
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`analysis ${id} never settled`);
    }

    it("says so once, adds no findings and makes no model call", async () => {
      const { row, web, findings, webCalls } = await runToEnd(false);
      expect(row.status).toBe("completed");
      expect(webCalls).toBe(0);
      expect(findings).toBe(0);
      expect(web?.status).toBe("completed");
      const output = JSON.parse(web?.output ?? "{}") as { summary?: string; findings?: unknown[] };
      expect(output.summary).toBe(NO_WEB_SEARCH_PROVIDER_NOTICE);
      expect(output.findings).toEqual([]);
    });

    it("still runs the web specialist when a provider is configured", async () => {
      const { web, findings, webCalls } = await runToEnd(true);
      expect(webCalls).toBeGreaterThan(0);
      expect(web?.status).toBe("completed");
      expect(findings).toBe(1);
    });
  },
);
