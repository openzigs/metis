/**
 * #2236 — clarification answers as project knowledge, through the REAL
 * analysis router (`routes/analysis.ts`) over a real SQLite database built by
 * the migration chain, with the project's real clarification records
 * (`priorAnswerSourceFor` and `persistClarificationKnowledge` unstubbed):
 *
 *   - submitting a round stores each answer as a project record;
 *   - a second analysis of the project reuses the settled answer instead of
 *     asking, and the reused answer is written into its stored requirement;
 *   - a CSV import of answers stores records the same way.
 *
 * The record-level behaviour is `clarification-knowledge-2236.sqlite.test.ts`'s;
 * this file proves the router is wired to it.
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

const ANSWER = "Only EU invoices";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return { db: null as unknown, questionCalls: 0 };
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
  const reply = (content: unknown) => ({
    content: JSON.stringify(content),
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    model: "offline-stub",
    provider: "offline-stub",
    offline: true,
  });
  const chat = vi.fn(async (messages: Array<{ content: string }>) => {
    const asked = messages.map((m) => m.content).join("\n");
    if (asked.includes("generate targeted clarifying questions")) {
      state.questionCalls += 1;
      return reply({
        questions: [
          {
            requirementId: "REQ-1",
            ambiguityField: "scope",
            question: "Which invoices does the export cover?",
            context: "",
          },
        ],
      });
    }
    return reply({
      resolvedFields: ["scope"],
      updatedDescription: `Export the monthly invoice report: ${ANSWER}.`,
    });
  });
  return {
    ...actual,
    buildProvider: vi.fn(() => ({ offline: true, chat })),
    loadAIConfig: vi.fn(() => ({ provider: "offline-stub", model: "offline-stub" })),
  };
});
vi.mock("../src/lib/rag/knowledge-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/rag/knowledge-service.js")>()),
  getKnowledgeService: vi.fn(() => ({
    search: vi.fn(async () => []),
    deleteDocument: vi.fn(async () => undefined),
  })),
}));
// The record's document is written to a fake blob store and its ingest queued
// nowhere: what is under test is that the router records the answer.
vi.mock("../src/lib/documents/storage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/documents/storage.js")>()),
  getDocumentStorage: vi.fn(() => ({
    write: vi.fn(async ({ buffer }: { buffer: Buffer }) => ({
      absolutePath: "/blobs/x",
      storagePath: `p/${buffer.length}`,
      checksum: "c",
      sizeBytes: buffer.length,
      deduplicated: false,
    })),
  })),
}));
vi.mock("../src/lib/rag/ingest-queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/rag/ingest-queue.js")>()),
  getIngestQueue: vi.fn(() => ({ enqueue: vi.fn(async () => undefined) })),
}));

const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const WORKSPACE = "ws-2236r";
const PROJECT = "proj-2236r";
const ADMIN = "u-2236r-admin";
const TITLE = "Export the monthly invoice report";

const R1 = {
  id: "REQ-1",
  title: TITLE,
  description: "Export the monthly invoice report.",
  type: "functional",
  stakeholders: [],
  priority: "must-have",
  ambiguities: [
    { field: "scope", description: "Which invoices?", suggestedQuestion: "Which invoices?" },
  ],
  evidenceNeeds: [],
  rawSource: "",
  // #2310 — only a question about a cited paragraph is reused by another
  // analysis: a title alone does not say two analyses' requirements are one.
  sources: [
    {
      ref: "REQ-001",
      documentId: "doc-2236r",
      filename: "frd.docx",
      headingPath: ["3 Export"],
      quote: "The monthly invoice report is exported for every region.",
    },
  ],
};

const CITATION = {
  documentId: "doc-2236r",
  filename: "frd.docx",
  headingPath: ["3 Export"],
  quote: "The monthly invoice report is exported for every region.",
};

const OPEN_ROUND = (analysisId: string) =>
  JSON.stringify({
    analysisId,
    currentRound: 1,
    maxRounds: 3,
    rounds: [
      {
        round: 1,
        questions: [
          {
            id: "q-1",
            requirementId: "REQ-1",
            ambiguityField: "scope",
            question: "Which invoices does the export cover?",
            context: "",
            groundingStatus: "open",
            citation: CITATION,
          },
        ],
        answers: [],
      },
    ],
    resolvedAmbiguities: [],
    escalatedToSonnet: false,
    completed: false,
  });

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2236 — the analysis router records clarification answers and reuses them",
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
    const base = (analysisId: string) => `/api/projects/${PROJECT}/analyses/${analysisId}`;
    const clarify = (analysisId: string, body: object) =>
      request(app())
        .post(`${base(analysisId)}/clarify`)
        .set("Authorization", `Bearer ${token()}`)
        .send(body);

    /** An analysis at its checkpoint, with a stored requirement row; with `dialog`, its dialog row. */
    async function seedAnalysis(dialog?: (id: string) => string): Promise<string> {
      seq += 1;
      const id = `ana-2236r-${seq}`;
      await db.analysis.create({
        data: {
          id,
          projectId: PROJECT,
          startedById: ADMIN,
          status: "completed",
          metadata: JSON.stringify({
            structuredRequirements: {
              requirements: [R1],
              totalAmbiguities: 1,
              totalEvidenceNeeds: 0,
            },
            structuredRunId: `extraction-run-2236r-${seq}`,
          }),
        },
      });
      await db.requirement.create({
        data: {
          id: `req-row-${seq}`,
          projectId: PROJECT,
          analysisId: id,
          title: TITLE,
          body: "Export the monthly invoice report.",
        },
      });
      if (dialog) {
        await db.clarificationDialogState.create({ data: { analysisId: id, state: dialog(id) } });
      }
      return id;
    }

    const records = () => db.clarificationRecord.findMany({ where: { projectId: PROJECT } });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2236-clarification-reuse-route");
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

    beforeEach(async () => {
      state.questionCalls = 0;
      await db.clarificationRecord.deleteMany({});
    });

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("a submitted answer becomes a record, and a second analysis reuses it instead of asking", async () => {
      const first = await seedAnalysis(OPEN_ROUND);
      const submitted = await clarify(first, { answers: [{ questionId: "q-1", answer: ANSWER }] });
      expect(submitted.status).toBe(200);
      // Recorded off the response's path.
      await vi.waitFor(async () => expect(await records()).toHaveLength(1));
      const [record] = await records();
      expect(record).toMatchObject({
        analysisId: first,
        question: "Which invoices does the export cover?",
        answer: ANSWER,
        answeredById: ADMIN,
        ambiguityField: "scope",
        status: "settled",
      });

      const second = await seedAnalysis();
      const started = await clarify(second, {});
      expect(started.status).toBe(200);
      const dialog = started.body.data as {
        completed: boolean;
        rounds: Array<{ questions: unknown[] }>;
        reused?: Array<{ answer: string; fromAnalysisId?: string; requirementId: string }>;
      };
      // The question was generated, then answered from the record: not asked.
      expect(state.questionCalls).toBe(1);
      expect(dialog.rounds.flatMap((r) => r.questions)).toEqual([]);
      expect(dialog.reused).toEqual([
        expect.objectContaining({ requirementId: "REQ-1", answer: ANSWER, fromAnalysisId: first }),
      ]);
      // And the reused answer reaches the second analysis's stored requirement.
      const row = await db.requirement.findUniqueOrThrow({ where: { id: `req-row-${seq}` } });
      expect(row.body).toContain(ANSWER);
    });

    it("a CSV import of answers becomes a record too", async () => {
      const id = await seedAnalysis(OPEN_ROUND);
      const res = await request(app())
        .post(`${base(id)}/clarify/import`)
        .set("Authorization", `Bearer ${token()}`)
        .attach(
          "file",
          Buffer.from(
            "questionId,requirement,ambiguityField,question,suggestedAnswer,answer\r\n" +
              `q-1,${TITLE},scope,Which invoices?,,${ANSWER}\r\n`,
          ),
          "answers.csv",
        );
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ applied: 1 });
      await vi.waitFor(async () => expect(await records()).toHaveLength(1));
      expect((await records())[0]).toMatchObject({ analysisId: id, answer: ANSWER });
    });
  },
);
