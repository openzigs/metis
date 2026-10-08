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

/**
 * A model that cites every chunk it was shown, one finding each — the most a
 * compliant model can do with its context, so whatever reaches the web agent's
 * prompt reaches its findings.
 */
function citeEverythingShown(prompt: string): string {
  const findings = [...prompt.matchAll(/documentId=(\S+) chunk=(\d+) file=(\S+?)\\n/g)].map(
    ([, documentId, chunk, file]) => ({
      category: "compliance",
      severity: "low",
      title: `Evidence from ${file}`,
      body: `Cited ${file}`,
      tags: [],
      citations: [{ documentId, chunkIndex: Number(chunk), filename: file }],
    }),
  );
  return JSON.stringify({ summary: "Cited what I was shown", findings, notes: [] });
}

function recordingProvider(
  failAll = false,
  citeContext = false,
): AIProvider & { webCalls: number; webPrompts: string[] } {
  const p = {
    key: "anthropic",
    model: MODEL,
    offline: false,
    webCalls: 0,
    webPrompts: [] as string[],
    async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> {
      const prompt = JSON.stringify([opts?.systemMessage, messages]);
      const isWeb = prompt.includes(WEB_AGENT_MARKER);
      if (isWeb) {
        p.webCalls += 1;
        p.webPrompts.push(prompt);
      }
      if (failAll) throw new Error("provider exploded");
      return {
        content: citeContext && isWeb ? citeEverythingShown(prompt) : licenceHeaderFinding,
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
  return p as unknown as AIProvider & { webCalls: number; webPrompts: string[] };
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

    async function runToEnd(
      webSearchConfigured: boolean,
      agentKeys: Array<"web" | "database"> = ["web"],
      failAll = false,
      opts: { knowledge?: KnowledgeService; documentIds?: string[]; citeContext?: boolean } = {},
    ) {
      const provider = recordingProvider(failAll, opts.citeContext ?? false);
      const orch = new AnalysisOrchestrator({
        provider,
        knowledge: opts.knowledge ?? stubKnowledge,
        webSearchConfigured: () => webSearchConfigured,
      });
      const { id } = await orch.start({
        projectId: PROJECT,
        startedById: USER,
        agentKeys,
        documentIds: opts.documentIds,
      });
      for (let i = 0; i < 400; i++) {
        const row = await db.analysis.findUnique({ where: { id } });
        if (row && ["completed", "failed", "cancelled"].includes(row.status)) {
          const web = await db.agentResult.findFirst({
            where: { analysisId: id, agentKey: "web" },
          });
          const findings = await db.finding.count({ where: { agentResult: { analysisId: id } } });
          const webFindings = await db.finding.findMany({
            where: { agentResult: { analysisId: id, agentKey: "web" } },
            select: { title: true, evidence: true },
          });
          return {
            row,
            web,
            findings,
            webFindings,
            webCalls: provider.webCalls,
            webPrompts: provider.webPrompts,
          };
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

    it("a skipped web specialist does not rescue a run whose other specialists all failed (#755)", async () => {
      const { row, webCalls } = await runToEnd(false, ["web", "database"], true);
      expect(webCalls).toBe(0);
      expect(row.status).toBe("failed");
      expect(row.errorMessage).toContain("All 1 specialist agent(s) failed");
    });

    /** A document row of the given connector source, for real foreign keys and ids. */
    async function seedDocument(filename: string, source: string): Promise<string> {
      const doc = await db.document.create({
        data: {
          projectId: PROJECT,
          filename,
          mimeType: "text/plain",
          sizeBytes: 1,
          storagePath: `/tmp/${filename}`,
          checksum: filename,
          status: "ready",
          source,
          uploadedById: USER,
        },
      });
      return doc.id;
    }

    function knowledgeReturning(
      hits: Array<{ documentId: string; filename: string; score: number; source: string }>,
    ): KnowledgeService {
      return {
        search: async () => ({
          hits: hits.map((h, i) => ({
            chunkId: `chunk-${h.documentId}-${i}`,
            documentId: h.documentId,
            filename: h.filename,
            position: 0,
            text: `${h.filename} body. SPDX-License-Identifier: Apache-2.0`,
            score: h.score,
            source: h.source,
          })),
        }),
      } as unknown as KnowledgeService;
    }

    function citedFilenames(webFindings: Array<{ evidence: string | null }>): string[] {
      return webFindings.flatMap(
        (f) =>
          (
            JSON.parse(f.evidence ?? "{}") as { citations?: Array<{ filename?: string }> }
          ).citations?.map((c) => c.filename ?? "") ?? [],
      );
    }

    it("still runs the web specialist on an uploaded document when a provider is configured", async () => {
      const policy = await seedDocument("security-policy.md", "upload");
      const { web, webFindings, webCalls } = await runToEnd(true, ["web"], false, {
        knowledge: knowledgeReturning([
          { documentId: policy, filename: "security-policy.md", score: 0.8, source: "upload" },
        ]),
        citeContext: true,
      });
      expect(webCalls).toBe(1);
      expect(web?.status).toBe("completed");
      expect(citedFilenames(webFindings)).toEqual(["security-policy.md"]);
    });

    // The #864 case with a provider configured: the selected document is a
    // repository file whose only chunks are in quarantine, and the score-0
    // quarantine fallback fed it to the web agent, which cited it.
    it("with a provider configured, never grounds on the score-0 quarantine fallback", async () => {
      const finder = await seedDocument("internal/reader/icon/finder_test.go", "repo");
      await db.quarantineChunk.create({
        data: {
          documentId: finder,
          projectId: PROJECT,
          ord: 0,
          text: "// SPDX-License-Identifier: Apache-2.0",
          embedding: "[]",
        },
      });
      const { row, webFindings, webCalls, webPrompts } = await runToEnd(true, ["web"], false, {
        documentIds: [finder],
        citeContext: true,
      });
      expect(row.status).toBe("completed");
      // The agent still ran — the provider is configured — but was shown nothing
      // it could mistake for evidence.
      expect(webCalls).toBe(1);
      const prompt = webPrompts.join("\n");
      expect(prompt).not.toContain("finder_test.go");
      expect(prompt).not.toContain("SPDX-License-Identifier");
      expect(citedFilenames(webFindings)).toEqual([]);
    });

    it("with a provider configured, cites no repository, database or score-0 chunk", async () => {
      const finder = await seedDocument("finder_test.go", "repo");
      const table = await seedDocument("orders.table", "db");
      const unranked = await seedDocument("unranked.md", "upload");
      const policy = await seedDocument("gdpr-notes.md", "upload");
      const { webFindings, webPrompts } = await runToEnd(true, ["web"], false, {
        knowledge: knowledgeReturning([
          { documentId: finder, filename: "finder_test.go", score: 0.9, source: "repo" },
          { documentId: table, filename: "orders.table", score: 0.85, source: "db" },
          { documentId: unranked, filename: "unranked.md", score: 0, source: "upload" },
          { documentId: policy, filename: "gdpr-notes.md", score: 0.7, source: "upload" },
        ]),
        citeContext: true,
      });
      const prompt = webPrompts.join("\n");
      for (const local of ["finder_test.go", "orders.table", "unranked.md"]) {
        expect(prompt).not.toContain(local);
      }
      expect(citedFilenames(webFindings)).toEqual(["gdpr-notes.md"]);
    });
  },
);
