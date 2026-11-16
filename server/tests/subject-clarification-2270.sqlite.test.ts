/**
 * #2270 — an Impact Analysis run on a document and a portfolio check on an FRD
 * raise their clarifying questions in the same dialog as a requirements
 * analysis, through the REAL routers (`routes/impact-analysis.ts`,
 * `routes/portfolio-assessments.ts`) over a real SQLite database built by the
 * migration chain, with the real dialog, store and clarification records:
 *
 *   - what the run read is stored as its dialog (`saveImpactClarifiable`), and
 *     `GET …/clarify` reads it back with no state until the analyst asks;
 *   - a start asks #2235's classified question, citing the paragraph, and its
 *     state lands in `subject_clarification_dialogs` (never in an analysis's
 *     `clarification_dialog_states`); a second start returns the same round;
 *   - a submitted answer refines the stored requirement and becomes a project
 *     record (origin `impact`), indexed in the project's knowledge;
 *   - a portfolio check on the same document reuses that answer instead of
 *     asking (#2236);
 *   - a caller who cannot read the run, or its document, sees no dialog; the
 *     body never carries a requirement list.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const ANSWER = "Under one second for the first page";
const QUESTION = "How fast must search results be returned under §4 Search?";
const QUOTE = "Search results must be returned fast.";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return { db: null as unknown, questionCalls: 0, resolutionCalls: 0 };
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
// The record's document is written to a fake blob store and its ingest queued
// nowhere: what is under test is that the answer is recorded and indexed.
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

const { impactAnalysisRouter, saveImpactClarifiable } =
  await import("../src/routes/impact-analysis.js");
const { portfolioAssessmentsRouter } = await import("../src/routes/portfolio-assessments.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const WORKSPACE = "ws-2270";
const PROJECT = "proj-2270";
const ADMIN = "u-2270-admin";
const OUTSIDER = "u-2270-outsider";
const DOC = "doc-2270";
const RESTRICTED_DOC = "doc-2270-restricted";

const reply = (content: unknown) => ({
  content: JSON.stringify(content),
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  model: "offline-stub",
  provider: "offline-stub",
  offline: true,
});
const provider = {
  offline: true,
  key: "offline-stub",
  model: "offline-stub",
  chat: vi.fn(async (messages: Array<{ content: string }>) => {
    const asked = messages.map((m) => m.content).join("\n");
    if (asked.includes("generate targeted clarifying questions")) {
      state.questionCalls += 1;
      return reply({
        questions: [
          {
            requirementId: "T1",
            ambiguityField: "R7:fast",
            uncertainty: "ambiguity",
            options: ["under one second", "under five seconds"],
            divergent: true,
            impact: "high",
            question: QUESTION,
            context: "'fast' cannot be tested as written.",
          },
        ],
      });
    }
    state.resolutionCalls += 1;
    return reply({
      resolvedFields: ["R7:fast"],
      updatedDescription: `Search returns results ${ANSWER.toLowerCase()}.`,
      remainingUncertainty: 0,
    });
  }),
};
const clarify = {
  provider: provider as never,
  retriever: { search: vi.fn(async () => []) } as never,
};

const READING = {
  statements: [
    {
      id: "T1",
      kind: "requirement" as const,
      statement: "Search returns results fast.",
      quote: QUOTE,
      start: 0,
      end: QUOTE.length,
      sectionId: "S1",
      headingPath: ["4 Search"],
      refersTo: [],
    },
    {
      id: "T2",
      kind: "requirement" as const,
      statement: "Each order has one customer.",
      quote: "Each order has exactly one customer.",
      start: 40,
      end: 76,
      sectionId: "S2",
      headingPath: ["5 Orders"],
      refersTo: [],
    },
  ],
};

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2270 — impact runs and portfolio checks ask in the clarification dialog",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/impact-analyses", impactAnalysisRouter({ clarify }));
      a.use("/api/portfolio-assessments", portfolioAssessmentsRouter({ clarify }));
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const token = (userId: string, role: "admin" | "coordinator") =>
      issueTokens({
        userId,
        username: userId,
        role,
        // A coordinator (who holds both permissions) with no access to the project.
        permissions: [],
        workspaces: role === "admin" ? [WORKSPACE] : [],
      }).accessToken;
    const as = (userId = ADMIN, role: "admin" | "coordinator" = "admin") => ({
      get: (path: string) =>
        request(app())
          .get(path)
          .set("Authorization", `Bearer ${token(userId, role)}`),
      post: (path: string, body: object) =>
        request(app())
          .post(path)
          .set("Authorization", `Bearer ${token(userId, role)}`)
          .send(body),
    });
    const impact = (id: string) => `/api/impact-analyses/${id}/clarify`;
    const check = (id: string) => `/api/portfolio-assessments/${id}/clarify`;

    async function seedDocument(id: string, aclSubjects = "[]") {
      await db.document.create({
        data: {
          id,
          projectId: PROJECT,
          filename: `${id}.docx`,
          mimeType: "text/markdown",
          sizeBytes: 10,
          storagePath: `${PROJECT}/${id}`,
          checksum: `sum-${id}`,
          status: "ready",
          uploadedById: ADMIN,
          aclSubjects,
        },
      });
    }
    async function seedImpactRun(id: string, documentId: string, withDialog = true) {
      await db.impactAnalysis.create({
        data: { id, documentId, startedById: ADMIN, status: "completed" },
      });
      await db.impactAnalysisProject.create({ data: { analysisId: id, projectId: PROJECT } });
      if (withDialog) {
        await saveImpactClarifiable({
          impactAnalysisId: id,
          reading: READING as never,
          document: { projectId: PROJECT, documentId },
          title: "frd.docx",
        });
      }
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2270-subject-clarification");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.workspace.create({ data: { id: WORKSPACE, name: "ws", slug: WORKSPACE } });
      for (const id of [ADMIN, OUTSIDER]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
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
      await seedDocument(DOC);
      await seedDocument(RESTRICTED_DOC, JSON.stringify([{ kind: "user", value: "u-someone" }]));
      await seedImpactRun("ia-2270", DOC);
      await db.portfolioAssessment.create({
        data: {
          id: "pa-2270",
          statement: 'Requirements read from "frd.docx"',
          scope: "all-accessible",
          status: "completed",
          sourceProjectId: PROJECT,
          sourceDocumentId: DOC,
          createdById: ADMIN,
        },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("stores what the run read as its dialog: the flagged requirement, nothing asked yet", async () => {
      const row = await db.subjectClarificationDialog.findUnique({
        where: { impactAnalysisId: "ia-2270" },
      });
      expect(row).toMatchObject({ projectId: PROJECT, documentId: DOC, state: null });
      const res = await as().get(impact("ia-2270"));
      expect(res.status).toBe(200);
      expect(res.body.data.state).toBeNull();
      // Only the requirement with a GtWR hit is asked about.
      expect(res.body.data.requirements.requirements.map((r: { id: string }) => r.id)).toEqual([
        "T1",
      ]);
    });

    it("a start asks the classified question citing its paragraph, stored on the run, once", async () => {
      const res = await as().post(impact("ia-2270"), {});
      expect(res.status).toBe(200);
      const [question] = res.body.data.rounds[0].questions;
      expect(question).toMatchObject({
        requirementId: "T1",
        ambiguityField: "R7:fast",
        question: QUESTION,
        uncertainty: "ambiguity",
        options: ["under one second", "under five seconds"],
        citation: { documentId: DOC, headingPath: ["4 Search"], quote: QUOTE },
      });
      expect(state.questionCalls).toBe(1);
      // Read back through the store a later request reads: the subject's row.
      const again = await as().get(impact("ia-2270"));
      expect(again.body.data.state.rounds[0].questions[0].id).toBe(question.id);
      expect(await db.clarificationDialogState.count()).toBe(0);
      // A second start returns the open round, without asking the model again.
      const second = await as().post(impact("ia-2270"), {});
      expect(second.body.data.rounds[0].questions[0].id).toBe(question.id);
      expect(state.questionCalls).toBe(1);
    });

    it("an answer refines the stored requirement and becomes an indexed project record", async () => {
      const read = await as().get(impact("ia-2270"));
      const questionId = read.body.data.state.rounds[0].questions[0].id as string;
      const res = await as().post(impact("ia-2270"), {
        answers: [{ questionId, answer: ANSWER }],
      });
      expect(res.status).toBe(200);
      expect(res.body.data.state.answeredAmbiguities).toEqual(["T1:R7:fast"]);
      expect(res.body.data.state.completed).toBe(true);
      const row = await db.subjectClarificationDialog.findUnique({
        where: { impactAnalysisId: "ia-2270" },
      });
      expect(JSON.parse(row!.requirements).requirements[0].description).toBe(
        `Search returns results ${ANSWER.toLowerCase()}.`,
      );
      // Recorded and indexed off the response's path.
      await vi.waitFor(async () => {
        const [record] = await db.clarificationRecord.findMany({ where: { projectId: PROJECT } });
        expect(record?.knowledgeDocumentId).toBeTruthy();
      });
      const records = await db.clarificationRecord.findMany({ where: { projectId: PROJECT } });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        origin: "impact",
        analysisId: "ia-2270",
        question: QUESTION,
        answer: ANSWER,
        answeredById: ADMIN,
        ambiguityField: "R7:fast",
        sourceDocumentId: DOC,
        sourceQuote: QUOTE,
        status: "settled",
      });
      const indexed = await db.document.findUnique({
        where: { id: records[0]!.knowledgeDocumentId! },
      });
      expect(indexed).toMatchObject({ projectId: PROJECT, source: "clarification" });
    });

    it("a portfolio check on the same document reuses the answer instead of asking", async () => {
      // The check's dialog, as its run stores it (the same helper's shape).
      const { saveSubjectClarifiable, clarifiableRequirements } =
        await import("../src/lib/clarifications/subject-clarifications.js");
      await saveSubjectClarifiable(
        { kind: "portfolio", id: "pa-2270" },
        {
          projectId: PROJECT,
          documentId: DOC,
          requirements: clarifiableRequirements(READING as never, {
            documentId: DOC,
            title: "frd.docx",
          })!,
        },
      );
      const before = state.questionCalls;
      const read = await as().get(check("pa-2270"));
      expect(read.status).toBe(200);
      expect(read.body.data.state).toBeNull();
      const res = await as().post(check("pa-2270"), {});
      expect(res.status).toBe(200);
      expect(state.questionCalls).toBe(before + 1);
      expect(res.body.data.rounds.flatMap((r: { questions: unknown[] }) => r.questions)).toEqual(
        [],
      );
      expect(res.body.data.reused).toEqual([
        expect.objectContaining({ requirementId: "T1", answer: ANSWER, fromAnalysisId: "ia-2270" }),
      ]);
      expect(res.body.data.completed).toBe(true);
      const row = await db.subjectClarificationDialog.findUnique({
        where: { portfolioAssessmentId: "pa-2270" },
      });
      expect(JSON.parse(row!.state!).reused).toHaveLength(1);
    });

    it("a caller who cannot read the run or the check sees no dialog", async () => {
      const outsider = as(OUTSIDER, "coordinator");
      expect((await outsider.get(impact("ia-2270"))).status).toBe(404);
      expect((await outsider.post(impact("ia-2270"), {})).status).toBe(404);
      expect((await outsider.get(check("pa-2270"))).status).toBe(404);
      expect((await outsider.post(check("pa-2270"), {})).status).toBe(404);
      expect((await as().get(impact("ia-unknown"))).status).toBe(404);
    });

    it("a run whose document the caller may not read now has no dialog for them", async () => {
      await seedImpactRun("ia-2270-restricted", RESTRICTED_DOC);
      expect(
        await db.subjectClarificationDialog.count({
          where: { impactAnalysisId: "ia-2270-restricted" },
        }),
      ).toBe(1);
      const read = await as().get(impact("ia-2270-restricted"));
      expect(read.status).toBe(200);
      expect(read.body.data).toEqual({ state: null, requirements: null });
      const post = await as().post(impact("ia-2270-restricted"), {});
      expect(post.status).toBe(404);
      expect(post.body.error.code).toBe("NO_DIALOG");

      // A check of that document likewise.
      await db.portfolioAssessment.create({
        data: {
          id: "pa-2270-restricted",
          statement: "s",
          scope: "all-accessible",
          status: "completed",
          sourceProjectId: PROJECT,
          sourceDocumentId: RESTRICTED_DOC,
          createdById: ADMIN,
        },
      });
      const { saveSubjectClarifiable, clarifiableRequirements } =
        await import("../src/lib/clarifications/subject-clarifications.js");
      await saveSubjectClarifiable(
        { kind: "portfolio", id: "pa-2270-restricted" },
        {
          projectId: PROJECT,
          documentId: RESTRICTED_DOC,
          requirements: clarifiableRequirements(READING as never, {
            documentId: RESTRICTED_DOC,
            title: "frd.docx",
          })!,
        },
      );
      expect((await as().get(check("pa-2270-restricted"))).body.data).toEqual({
        state: null,
        requirements: null,
      });
      expect((await as().post(check("pa-2270-restricted"), {})).status).toBe(404);
    });

    it("a run with no dialog answers none, and answers before a start are refused", async () => {
      await seedImpactRun("ia-2270-none", DOC, false);
      expect((await as().get(impact("ia-2270-none"))).body.data).toEqual({
        state: null,
        requirements: null,
      });
      expect((await as().post(impact("ia-2270-none"), {})).status).toBe(404);

      await seedImpactRun("ia-2270-unstarted", DOC);
      const early = await as().post(impact("ia-2270-unstarted"), {
        answers: [{ questionId: "q-1", answer: "x" }],
      });
      expect(early.status).toBe(404);
      expect(early.body.error.code).toBe("NO_DIALOG");
    });

    it("the body carries answers only: a requirement list is a 400", async () => {
      const res = await as().post(impact("ia-2270-unstarted"), {
        requirements: { requirements: [] },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      const portfolio = await as().post(check("pa-2270"), { requirements: { requirements: [] } });
      expect(portfolio.status).toBe(400);
    });

    describe("the store, keyed on the subject", () => {
      const key = { kind: "impact" as const, id: "ia-2270-store" };
      const stateOf = (round: number) =>
        ({
          analysisId: key.id,
          currentRound: round,
          maxRounds: 3,
          rounds: [],
          resolvedAmbiguities: [],
          escalatedToSonnet: false,
          completed: false,
        }) as never;
      const stored = async () =>
        (await db.subjectClarificationDialog.findUnique({ where: { impactAnalysisId: key.id } }))!;

      beforeAll(async () => {
        await seedImpactRun(key.id, DOC);
      });

      it("a first write lands once, and a write on a stale revision is refused", async () => {
        const store = await import("../src/lib/analysis/clarification-dialog-store.js");
        const first = await store.replaceDialogState(key, undefined, stateOf(1));
        expect(first).toBe(JSON.stringify(stateOf(1)));
        // Another writer that also read no state loses.
        expect(await store.replaceDialogState(key, undefined, stateOf(9))).toBeNull();
        const next = await store.replaceDialogState(key, first!, stateOf(2));
        expect(next).not.toBeNull();
        expect(await store.replaceDialogState(key, first!, stateOf(9))).toBeNull();
        expect((await store.readDialogState(key))?.currentRound).toBe(2);
        // The analysis store never sees it, nor the portfolio key of the same id.
        expect(await store.readDialogState(key.id)).toBeUndefined();
        expect(await store.readDialogState({ kind: "portfolio", id: key.id })).toBeUndefined();
        // No row: nothing to write.
        expect(
          await store.replaceDialogState({ kind: "impact", id: "ia-none" }, undefined, stateOf(1)),
        ).toBeNull();
      });

      it("a corrupt state is replaced by a first write; a refused commit writes nothing", async () => {
        const store = await import("../src/lib/analysis/clarification-dialog-store.js");
        await db.subjectClarificationDialog.update({
          where: { impactAnalysisId: key.id },
          data: { state: "{not json" },
        });
        expect(await store.readDialogState(key)).toBeUndefined();
        const revision = await store.replaceDialogState(key, undefined, stateOf(1));
        expect(revision).not.toBeNull();
        await expect(
          store.commitDialogState(key, revision!, stateOf(2), async (tx) => {
            await tx.subjectClarificationDialog.updateMany({
              where: { impactAnalysisId: key.id },
              data: { requirements: "{}" },
            });
            throw new Error("refused");
          }),
        ).rejects.toThrow("refused");
        expect((await store.readDialogState(key))?.currentRound).toBe(1);
        expect(JSON.parse((await stored()).requirements).requirements).toHaveLength(1);
      });

      it("write sets the state; delete clears it and keeps the requirements", async () => {
        const store = await import("../src/lib/analysis/clarification-dialog-store.js");
        await store.writeDialogState(key, stateOf(3));
        expect((await store.readDialogState(key))?.currentRound).toBe(3);
        await store.deleteDialogState(key);
        expect((await stored()).state).toBeNull();
        expect(JSON.parse((await stored()).requirements).requirements).toHaveLength(1);
      });
    });
  },
);
