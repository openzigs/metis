/**
 * Issue #2236 — clarification answers as project knowledge, over a REAL SQLite
 * database built by the migration chain, read back through the paths a real
 * consumer uses:
 *
 *   - an analysis's answers become records (question, answer, who, when, the
 *     source paragraph, the requirements and the project's product), and
 *     writing the same answer again changes nothing;
 *   - a second analysis of the same project does not ask a settled question:
 *     the dialog reuses the answer (state `reused`, counted as answered, its
 *     text reaching the requirement body as a `reused` answer), and another
 *     project never sees it;
 *   - a changed paragraph in the same place reopens the old answer and the
 *     question is asked again;
 *   - a record is indexed as a project document attributed to the person who
 *     answered, and a changed answer replaces the earlier document;
 *   - `persistClarificationKnowledge` records from the stored dialog state,
 *     indexes and re-runs only what changed.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage } from "../src/lib/ai/types.js";
import type {
  ClarificationState,
  StructuredRequirements,
} from "../src/lib/analysis/types/requirements.js";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/prisma.js")>()),
  get prisma() {
    return state.db;
  },
}));

const { ClarificationDialog } = await import("../src/lib/analysis/clarification-dialog.js");
const { collectAnsweredQuestions } =
  await import("../src/lib/analysis/clarification-enrichment.js");
const { writeDialogState } = await import("../src/lib/analysis/clarification-dialog-store.js");
const { persistClarificationKnowledge, priorAnswerSourceFor, recordAnalysisClarifications } =
  await import("../src/lib/clarifications/analysis-clarifications.js");
const { indexClarification } = await import("../src/lib/clarifications/clarification-knowledge.js");
const { listClarifications } = await import("../src/lib/clarifications/clarification-records.js");
const { recordSpecKitClarification } =
  await import("../src/lib/clarifications/spec-kit-clarifications.js");

const WS = "ws-2236";
const USER = "u-2236";
const PA = "proj-2236-a";
const PB = "proj-2236-b";
const PRODUCT = "prod-2236";
const A1 = "ana-2236-1";
const A2 = "ana-2236-2";
const A3 = "ana-2236-3";
const B1 = "ana-2236-b";

const PARAGRAPH = "Passwords must be long enough.";
const SOURCE = {
  ref: "REQ-001",
  documentId: "doc-frd",
  filename: "frd.docx",
  headingPath: ["4 Accounts", "4.2 Passwords"],
  quote: PARAGRAPH,
};

function requirements(id: string, quote = PARAGRAPH): StructuredRequirements {
  return {
    requirements: [
      {
        id,
        title: "Password policy",
        description: "Passwords must be long enough.",
        type: "functional",
        stakeholders: [],
        priority: "high",
        ambiguities: [
          { field: "minimumLength", description: "'long enough' is vague", suggestedQuestion: "" },
        ],
        evidenceNeeds: [],
        rawSource: quote,
        sources: [{ ...SOURCE, quote }],
      },
    ],
    totalAmbiguities: 1,
    totalEvidenceNeeds: 0,
  } as unknown as StructuredRequirements;
}

/** The question model: one high-impact ambiguity question per requirement. */
function questionModel(): AIProvider & { chat: ReturnType<typeof vi.fn> } {
  const chat = vi.fn(async (messages: ChatMessage[]) => {
    const user = messages.map((m) => String(m.content)).join("\n");
    const ids = [...user.matchAll(/\(id: ([^)]+)\)/g)].map((m) => m[1]);
    return {
      content: JSON.stringify({
        questions: ids.map((requirementId) => ({
          requirementId,
          ambiguityField: "minimumLength",
          uncertainty: "ambiguity",
          options: ["8 characters", "12 characters"],
          divergent: true,
          impact: "high",
          question: `How long must a password be? (asked for ${requirementId})`,
          context: "'long enough' is vague",
        })),
      }),
      model: "m",
      provider: "anthropic" as const,
    };
  });
  return { key: "anthropic", model: "stub", offline: false, chat } as never;
}

/** A dialog state with one answered round about `requirements(id)`. */
function answeredState(analysisId: string, reqId: string, answer: string): ClarificationState {
  return {
    analysisId,
    currentRound: 2,
    maxRounds: 3,
    rounds: [
      {
        round: 1,
        questions: [
          {
            id: `q-${analysisId}`,
            requirementId: reqId,
            ambiguityField: "minimumLength",
            question: "How long must a password be?",
            context: "",
            answer,
            citation: {
              documentId: SOURCE.documentId,
              filename: SOURCE.filename,
              headingPath: SOURCE.headingPath,
              quote: PARAGRAPH,
            },
          },
        ],
        answers: [{ questionId: `q-${analysisId}`, answer }],
      },
    ],
    resolvedAmbiguities: [],
    answeredAmbiguities: [`${reqId}:minimumLength`],
    escalatedToSonnet: false,
    completed: true,
  };
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2236 — clarification answers as project knowledge (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2236-clarification-knowledge");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.workspace.create({ data: { id: WS, name: WS, slug: WS } });
      await db.user.create({
        data: { id: USER, username: USER, displayName: "Ana Lyst", email: `${USER}@example.test` },
      });
      await db.product.create({
        data: { id: PRODUCT, name: "Accounts", slug: PRODUCT, createdById: USER },
      });
      await db.project.create({
        data: {
          id: PA,
          name: PA,
          slug: PA,
          createdById: USER,
          workspaceId: WS,
          productId: PRODUCT,
        },
      });
      await db.project.create({
        data: { id: PB, name: PB, slug: PB, createdById: USER, workspaceId: WS },
      });
      for (const [id, projectId] of [
        [A1, PA],
        [A2, PA],
        [A3, PA],
        [B1, PB],
      ] as const) {
        await db.analysis.create({
          data: { id, projectId, startedById: USER, status: "completed" },
        });
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(async () => {
      await db.clarificationRecord.deleteMany({});
      await db.clarificationDialogState.deleteMany({});
      await db.document.deleteMany({});
    });

    it("records each answer with who, when, the source paragraph, the requirement and the product", async () => {
      const at = new Date("2026-11-11T10:00:00.000Z");
      const changed = await recordAnalysisClarifications({
        projectId: PA,
        analysisId: A1,
        answeredById: USER,
        state: answeredState(A1, "R-1", "At least 12 characters."),
        requirements: requirements("R-1"),
        now: at,
      });
      expect(changed).toHaveLength(1);
      const [stored] = await listClarifications(PA);
      expect(stored).toMatchObject({
        origin: "analysis",
        analysisId: A1,
        question: "How long must a password be?",
        answer: "At least 12 characters.",
        answeredById: USER,
        answeredAt: at,
        ambiguityField: "minimumLength",
        source: {
          documentId: "doc-frd",
          filename: "frd.docx",
          headingPath: ["4 Accounts", "4.2 Passwords"],
          quote: PARAGRAPH,
        },
        requirementIds: ["R-1"],
        productIds: [PRODUCT],
        status: "settled",
      });

      // The same answer again changes nothing; a new answer replaces it.
      const again = await recordAnalysisClarifications({
        projectId: PA,
        analysisId: A1,
        answeredById: USER,
        state: answeredState(A1, "R-1", "At least   12 characters."),
        requirements: requirements("R-1"),
      });
      expect(again).toEqual([]);
      const edited = await recordAnalysisClarifications({
        projectId: PA,
        analysisId: A1,
        answeredById: USER,
        state: answeredState(A1, "R-1", "At least 15 characters."),
        requirements: requirements("R-1"),
      });
      expect(edited.map((r) => r.answer)).toEqual(["At least 15 characters."]);
      expect(await listClarifications(PA)).toHaveLength(1);
    });

    it("a later analysis of the project reuses the settled answer instead of asking; another project asks", async () => {
      await recordAnalysisClarifications({
        projectId: PA,
        analysisId: A1,
        answeredById: USER,
        state: answeredState(A1, "R-1", "At least 12 characters."),
        requirements: requirements("R-1"),
      });

      const provider = questionModel();
      const dialog = new ClarificationDialog({ provider, priorAnswers: priorAnswerSourceFor(PA) });
      const started = await dialog.startOrContinue(A2, requirements("R-9"));
      // Nothing is left to ask, so the dialog completes without a question.
      expect(started.completed).toBe(true);
      expect(started.rounds.flatMap((r) => r.questions)).toEqual([]);
      expect(started.reused).toEqual([
        expect.objectContaining({
          requirementId: "R-9",
          ambiguityField: "minimumLength",
          answer: "At least 12 characters.",
          fromAnalysisId: A1,
          round: 1,
        }),
      ]);
      expect(started.answeredAmbiguities).toContain("R-9:minimumLength");
      // The reused answer reaches the requirement body like a typed one.
      expect(collectAnsweredQuestions(started)).toEqual([
        expect.objectContaining({
          requirementId: "R-9",
          answer: "At least 12 characters.",
          provenance: "reused",
        }),
      ]);

      // Another project of the same workspace has no such answer: it asks.
      const other = new ClarificationDialog({
        provider: questionModel(),
        priorAnswers: priorAnswerSourceFor(PB),
      });
      const asked = await other.startOrContinue(B1, requirements("R-9"));
      expect(asked.reused ?? []).toEqual([]);
      expect(asked.rounds[0]!.questions.map((q) => q.ambiguityField)).toEqual(["minimumLength"]);
    });

    it("a changed paragraph in the same place reopens the old answer and asks again", async () => {
      await recordAnalysisClarifications({
        projectId: PA,
        analysisId: A1,
        answeredById: USER,
        state: answeredState(A1, "R-1", "At least 12 characters."),
        requirements: requirements("R-1"),
      });
      const dialog = new ClarificationDialog({
        provider: questionModel(),
        priorAnswers: priorAnswerSourceFor(PA),
      });
      const changedParagraph = "Passwords must be long enough, or use a passkey.";
      const started = await dialog.startOrContinue(A3, requirements("R-5", changedParagraph));
      expect(started.reused ?? []).toEqual([]);
      expect(started.rounds[0]!.questions).toHaveLength(1);
      const [record] = await listClarifications(PA);
      expect(record).toMatchObject({ status: "reopened" });
      expect(record!.reopenedAt).toBeInstanceOf(Date);
    });

    it("indexes a record as a project document by the person who answered, replacing it when the answer changes", async () => {
      const [record] = await recordAnalysisClarifications({
        projectId: PA,
        analysisId: A1,
        answeredById: USER,
        state: answeredState(A1, "R-1", "At least 12 characters."),
        requirements: requirements("R-1"),
      });
      const written: string[] = [];
      const storage = {
        write: vi.fn(async ({ buffer }: { buffer: Buffer }) => {
          written.push(buffer.toString("utf8"));
          return {
            storagePath: `p/${written.length}`,
            checksum: `c${written.length}`,
            sizeBytes: buffer.length,
            deduplicated: false,
          };
        }),
      };
      const enqueue = vi.fn(async () => undefined);
      const deleteDocument = vi.fn(async () => undefined);
      const first = await indexClarification(record!, { storage, enqueue, deleteDocument });
      expect(first).not.toBeNull();
      const doc = await db.document.findUniqueOrThrow({ where: { id: first! } });
      expect(doc).toMatchObject({
        projectId: PA,
        uploadedById: USER,
        mimeType: "text/markdown",
        title: "Clarification: How long must a password be?",
      });
      expect(written[0]).toContain("**Answer:** At least 12 characters.");
      expect(written[0]).toContain("**Source paragraph:** Passwords must be long enough.");
      expect(enqueue).toHaveBeenCalledWith(first);
      const [indexed] = await listClarifications(PA);
      expect(indexed!.knowledgeDocumentId).toBe(first);

      const [changed] = await recordAnalysisClarifications({
        projectId: PA,
        analysisId: A1,
        answeredById: USER,
        state: answeredState(A1, "R-1", "At least 15 characters."),
        requirements: requirements("R-1"),
      });
      const second = await indexClarification(changed!, { storage, enqueue, deleteDocument });
      expect(deleteDocument).toHaveBeenCalledWith(first);
      expect(second).not.toBe(first);
      expect((await listClarifications(PA))[0]!.knowledgeDocumentId).toBe(second);
    });

    it("persistClarificationKnowledge records from the stored dialog, indexes and re-runs only what changed", async () => {
      await writeDialogState(A1, answeredState(A1, "R-1", "At least 12 characters."));
      const index = vi.fn(async () => "doc");
      const rerun = vi.fn(async () => ({
        codeMapped: 0,
        governingRequirements: [],
        governingUnmatched: [],
      }));
      const provider = questionModel();
      const input = { projectId: PA, analysisId: A1, answeredById: USER, provider };
      const changed = await persistClarificationKnowledge(input, { index, rerun });
      expect(changed.map((r) => r.answer)).toEqual(["At least 12 characters."]);
      expect(index).toHaveBeenCalledTimes(1);
      expect(rerun).toHaveBeenCalledWith(
        expect.objectContaining({ analysisId: A1, projectId: PA, records: changed }),
      );
      // Nothing changed: nothing indexed, nothing re-run.
      expect(await persistClarificationKnowledge(input, { index, rerun })).toEqual([]);
      expect(index).toHaveBeenCalledTimes(1);
      expect(rerun).toHaveBeenCalledTimes(1);
    });

    it("a Spec Kit /clarify answer is a record of the project, keyed by its feature", async () => {
      const index = vi.fn(async () => null);
      const record = await recordSpecKitClarification(
        {
          projectId: PA,
          feature: "001-export",
          question: "What is the SLA?",
          answer: "Five nines.",
          answeredById: USER,
        },
        { index },
      );
      expect(record).toMatchObject({
        origin: "spec-kit",
        specKitFeature: "001-export",
        answer: "Five nines.",
        productIds: [PRODUCT],
      });
      expect(index).toHaveBeenCalledTimes(1);
      expect(await listClarifications(PA, { specKitFeature: "001-export" })).toHaveLength(1);
      expect(await listClarifications(PA, { specKitFeature: null })).toHaveLength(0);
    });
  },
);
