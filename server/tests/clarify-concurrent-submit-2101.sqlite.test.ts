/**
 * #2101 — two submits of the same open clarification round that arrive
 * together (two tabs, or a tab and a CSV import) both passed the #2085 guard,
 * because it was a check before a model call and the write after it was an
 * unconditional upsert: the last writer won, and the other client's answers
 * were lost while it was told they were saved.
 *
 * Both submit paths run through the real router on a real SQLite database
 * built by the migration chain. The model stub holds each resolution call
 * until both submits are inside theirs, so both have read the open round
 * before either writes. Read back through the dialog row and the analysis
 * metadata: exactly one submit is answered 200, the other 409
 * CLARIFY_ROUND_NOT_OPEN, and what is stored is the winner's, in both places.
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

const ANSWER_A = "Only EU invoices";
const ANSWER_B = "Every invoice in the ledger";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return {
    db: null as unknown,
    /** Resolution calls currently held, and the release once all are out. */
    held: [] as Array<() => void>,
    holdFor: 0,
  };
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
  const chat = vi.fn(async (messages: Array<{ content: string }>) => {
    // Held until `holdFor` resolution calls are out, then all released together.
    if (state.holdFor > 0) {
      await new Promise<void>((resolve) => {
        state.held.push(resolve);
        if (state.held.length === state.holdFor) for (const release of state.held) release();
      });
    }
    const asked = messages.map((m) => m.content).join("\n");
    const answer = asked.includes(ANSWER_B) ? ANSWER_B : ANSWER_A;
    return {
      content: JSON.stringify({
        resolvedFields: ["scope"],
        updatedDescription: `Export the monthly invoice report: ${answer}.`,
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

const WORKSPACE = "ws-2101";
const PROJECT = "proj-2101";
const ADMIN = "u-2101-admin";

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

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2101 — two submits of one open round: one is written, the other refused",
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

    /** A run at its checkpoint with one open question on REQ-1. */
    async function seedAnalysis(): Promise<string> {
      seq += 1;
      const id = `ana-2101-${seq}`;
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
            structuredRunId: "extraction-run-2101",
          }),
        },
      });
      await db.clarificationDialogState.create({
        data: {
          analysisId: id,
          state: JSON.stringify({
            analysisId: id,
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
                  },
                ],
                answers: [],
              },
            ],
            resolvedAmbiguities: [],
            escalatedToSonnet: false,
            completed: false,
          }),
        },
      });
      return id;
    }

    const submitJson = (id: string, answer: string) =>
      request(app())
        .post(`${base(id)}/clarify`)
        .set("Authorization", `Bearer ${token()}`)
        .send({ answers: [{ questionId: "q-1", answer }] });
    const submitCsv = (id: string, answer: string) =>
      request(app())
        .post(`${base(id)}/clarify/import`)
        .set("Authorization", `Bearer ${token()}`)
        .attach(
          "file",
          Buffer.from(
            "questionId,requirement,ambiguityField,question,suggestedAnswer,answer\r\n" +
              `q-1,Export the monthly invoice report,scope,Which invoices?,,${answer}\r\n`,
          ),
          "answers.csv",
        );

    const stored = async (analysisId: string) => {
      const row = await db.clarificationDialogState.findUniqueOrThrow({ where: { analysisId } });
      const dialog = JSON.parse(row.state) as {
        currentRound: number;
        rounds: Array<{ answers: unknown[]; questions: Array<{ answer?: string }> }>;
      };
      const analysis = await db.analysis.findUniqueOrThrow({ where: { id: analysisId } });
      const list = JSON.parse(analysis.metadata ?? "{}").structuredRequirements as {
        requirements: Array<{ description: string }>;
      };
      return { dialog, description: list.requirements[0]!.description };
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2101-clarify-concurrent-submit");
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
      state.held = [];
      state.holdFor = 2;
    });

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it.each([
      ["two JSON submits (two tabs)", submitJson, submitJson],
      ["a JSON submit and a CSV import", submitJson, submitCsv],
    ])("%s", async (_label, first, second) => {
      const id = await seedAnalysis();

      const [a, b] = await Promise.all([first(id, ANSWER_A), second(id, ANSWER_B)]);

      expect(state.held, "both submits reached their model call").toHaveLength(2);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const [won, lost] = a.status === 200 ? [a, b] : [b, a];
      const winner = won === a ? ANSWER_A : ANSWER_B;
      expect(lost.body.error.code).toBe("CLARIFY_ROUND_NOT_OPEN");

      // The winner's answer is the one stored, and its refinement the one applied.
      const { dialog, description } = await stored(id);
      expect(dialog.currentRound).toBe(2);
      expect(dialog.rounds).toHaveLength(1);
      expect(dialog.rounds[0]!.answers).toEqual([{ questionId: "q-1", answer: winner }]);
      expect(dialog.rounds[0]!.questions[0]!.answer).toBe(winner);
      expect(description).toBe(`Export the monthly invoice report: ${winner}.`);
    });

    it("a CSV import answers with the state it wrote", async () => {
      state.holdFor = 0;
      const id = await seedAnalysis();

      const res = await submitCsv(id, ANSWER_A);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ applied: 1, skipped: 0, unmatched: [] });
      expect(res.body.data.state).toEqual((await stored(id)).dialog);
    });
  },
);
