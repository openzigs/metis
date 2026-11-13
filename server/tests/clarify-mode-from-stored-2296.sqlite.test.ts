/**
 * #2296 (review of #2426) — the clarification dialog's question mode is the
 * server's: the clarify route decides it from the requirements list the
 * analysis STORED, never from the `sources` on a client's `requirements`
 * override. Through the real analysis router over a real SQLite database
 * built by the migration chain; the model is a stub that records which system
 * prompt the question call was given.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return { db: null as unknown, questionPrompts: [] as string[] };
});
vi.mock("../src/lib/prisma.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/prisma.js")>()),
  get prisma() {
    return state.db;
  },
}));
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: vi.fn(),
}));
vi.mock("../src/lib/finops/token-tracker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/finops/token-tracker.js")>()),
  recordUsage: vi.fn(),
}));
vi.mock("../src/lib/ai/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/ai/index.js")>();
  const chat = vi.fn(async (messages: Array<{ role: string; content: string }>) => {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    if (system.includes("generate targeted clarifying questions")) {
      state.questionPrompts.push(system);
    }
    return {
      content: JSON.stringify({
        questions: [
          {
            requirementId: "REQ-1",
            ambiguityField: "scope",
            question: "Which invoices does the export cover?",
            context: "",
          },
        ],
      }),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      model: "offline-stub",
      provider: "offline-stub",
      offline: true,
    };
  });
  return {
    ...actual,
    buildProvider: vi.fn(() => ({ offline: true, chat })),
    loadAIConfig: vi.fn(() => ({ provider: "offline-stub", model: "offline-stub" })),
  };
});
vi.mock("../src/lib/rag/knowledge-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/rag/knowledge-service.js")>()),
  getKnowledgeService: vi.fn(() => ({ search: vi.fn(async () => []) })),
}));

const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { QUESTION_SYSTEM_PROMPT, LEGACY_QUESTION_SYSTEM_PROMPT } =
  await import("../src/lib/analysis/clarification-dialog.js");

const WORKSPACE = "ws-2296m";
const PROJECT = "proj-2296m";
const ADMIN = "u-2296m-admin";

const SOURCES = [
  {
    ref: "REQ-001",
    documentId: "doc-1",
    filename: "frd.docx",
    headingPath: ["4 Invoices"],
    quote: "Export the monthly invoice report, where possible.",
  },
];

const R1 = {
  id: "REQ-1",
  title: "Export the monthly invoice report",
  description: "Export the monthly invoice report.",
  type: "functional",
  stakeholders: [],
  priority: "must-have",
  ambiguities: [
    { field: "scope", description: "Which invoices?", suggestedQuestion: "Which invoices?" },
  ],
  evidenceNeeds: [],
  rawSource: "",
};

const list = (withSources: boolean) => ({
  requirements: [withSources ? { ...R1, sources: SOURCES } : R1],
  totalAmbiguities: 1,
  totalEvidenceNeeds: 0,
});

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2296 — the clarify route decides the question mode from the stored list",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let seq = 0;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId/analyses", initAnalysisRouter().projectScoped);
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const token = () =>
      issueTokens({
        userId: ADMIN,
        username: ADMIN,
        role: "admin",
        permissions: [],
        workspaces: [WORKSPACE],
      }).accessToken;
    const clarify = (analysisId: string, body: object) =>
      request(app())
        .post(`/api/projects/${PROJECT}/analyses/${analysisId}/clarify`)
        .set("Authorization", `Bearer ${token()}`)
        .send(body);

    /** An analysis whose stored list does (or does not) carry `sources`. */
    async function seedAnalysis(storedWithSources: boolean): Promise<string> {
      seq += 1;
      const id = `ana-2296m-${seq}`;
      await db.analysis.create({
        data: {
          id,
          projectId: PROJECT,
          startedById: ADMIN,
          status: "completed",
          metadata: JSON.stringify({
            structuredRequirements: list(storedWithSources),
            structuredRunId: `extraction-run-2296m-${seq}`,
          }),
        },
      });
      return id;
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2296-clarify-mode-route");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.workspace.create({ data: { id: WORKSPACE, name: "ws", slug: WORKSPACE } });
      await db.user.create({
        data: { id: ADMIN, username: ADMIN, displayName: ADMIN, email: `${ADMIN}@example.test` },
      });
      await db.workspaceMember.create({
        data: { workspaceId: WORKSPACE, userId: ADMIN, role: "member" },
      });
      await db.project.create({
        data: {
          id: PROJECT,
          name: PROJECT,
          slug: PROJECT,
          createdById: ADMIN,
          workspaceId: WORKSPACE,
        },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(() => {
      state.questionPrompts = [];
    });

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("an override that adds `sources` does not switch a stored legacy list to the classified mode", async () => {
      const id = await seedAnalysis(false);
      const res = await clarify(id, { requirements: list(true) });
      expect(res.status).toBe(200);
      expect(state.questionPrompts).toEqual([LEGACY_QUESTION_SYSTEM_PROMPT]);
    });

    it("an override that drops `sources` does not switch a stored reader-read list to the legacy mode", async () => {
      const id = await seedAnalysis(true);
      const res = await clarify(id, { requirements: list(false) });
      expect(res.status).toBe(200);
      expect(state.questionPrompts).toEqual([QUESTION_SYSTEM_PROMPT]);
    });

    it("with no override, the stored list decides as before", async () => {
      const read = await seedAnalysis(true);
      expect((await clarify(read, {})).status).toBe(200);
      const legacy = await seedAnalysis(false);
      expect((await clarify(legacy, {})).status).toBe(200);
      expect(state.questionPrompts).toEqual([
        QUESTION_SYSTEM_PROMPT,
        LEGACY_QUESTION_SYSTEM_PROMPT,
      ]);
    });
  },
);
