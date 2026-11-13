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
 *   - a changed paragraph in the same place reopens the old answer, withdraws
 *     its document, and the question is asked again; a sibling paragraph of
 *     the same section reopens nothing;
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
const {
  persistClarificationKnowledge,
  priorAnswerSourceFor,
  recordAnalysisClarifications,
  rerunReusedClarifications,
} = await import("../src/lib/clarifications/analysis-clarifications.js");
const { indexClarification } = await import("../src/lib/clarifications/clarification-knowledge.js");
const { rerunAfterClarification } =
  await import("../src/lib/clarifications/clarification-rerun.js");
const { findClarificationsById } =
  await import("../src/lib/clarifications/clarification-records.js");
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
const A4 = "ana-2236-4";
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
        [A4, PA],
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

    /** The project's records, newest answer first; with a feature, that Spec Kit set's. */
    async function listRecords(projectId: string, specKitFeature?: string | null) {
      const rows = await db.clarificationRecord.findMany({
        where: {
          projectId,
          ...(specKitFeature !== undefined ? { origin: "spec-kit", specKitFeature } : {}),
        },
        orderBy: { answeredAt: "desc" },
        select: { id: true },
      });
      const byId = await findClarificationsById(
        projectId,
        rows.map((r) => r.id),
      );
      return rows.map((r) => byId.get(r.id)!);
    }

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
      const [stored] = await listRecords(PA);
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
      expect(await listRecords(PA)).toHaveLength(1);
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
      const dialog = new ClarificationDialog({
        provider,
        priorAnswers: priorAnswerSourceFor(PA, A2),
      });
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
        priorAnswers: priorAnswerSourceFor(PB, B1),
      });
      const asked = await other.startOrContinue(B1, requirements("R-9"));
      expect(asked.reused ?? []).toEqual([]);
      expect(asked.rounds[0]!.questions.map((q) => q.ambiguityField)).toEqual(["minimumLength"]);
    });

    it("a changed paragraph in the same place reopens the old answer, withdraws its document, and asks again", async () => {
      const [answered] = await recordAnalysisClarifications({
        projectId: PA,
        analysisId: A1,
        answeredById: USER,
        state: answeredState(A1, "R-1", "At least 12 characters."),
        requirements: requirements("R-1"),
      });
      await db.clarificationRecord.update({
        where: { id: answered!.id },
        data: { knowledgeDocumentId: "doc-answer-1" },
      });
      const deleteDocument = vi.fn(async () => undefined);
      const dialog = new ClarificationDialog({
        provider: questionModel(),
        priorAnswers: priorAnswerSourceFor(PA, A3, { deleteDocument }),
      });
      const changedParagraph = "Passwords must be long enough, or use a passkey.";
      const started = await dialog.startOrContinue(A3, requirements("R-5", changedParagraph));
      expect(started.reused ?? []).toEqual([]);
      expect(started.rounds[0]!.questions).toHaveLength(1);
      const [record] = await listRecords(PA);
      expect(record).toMatchObject({ status: "reopened" });
      expect(record!.reopenedAt).toBeInstanceOf(Date);
      // The reopened answer is no longer project knowledge: it cannot be cited.
      expect(deleteDocument).toHaveBeenCalledWith("doc-answer-1");
      expect(record!.knowledgeDocumentId).toBeNull();
    });

    it("a question about a sibling paragraph of the same section and field leaves a settled answer settled", async () => {
      await recordAnalysisClarifications({
        projectId: PA,
        analysisId: A1,
        answeredById: USER,
        state: answeredState(A1, "R-1", "At least 12 characters."),
        requirements: requirements("R-1"),
      });
      const deleteDocument = vi.fn(async () => undefined);
      const dialog = new ClarificationDialog({
        provider: questionModel(),
        priorAnswers: priorAnswerSourceFor(PA, A3, { deleteDocument }),
      });
      // Same document, heading and field; another paragraph of the section.
      const sibling = "Service accounts rotate their credentials every quarter.";
      const started = await dialog.startOrContinue(A3, requirements("R-6", sibling));
      // The sibling is asked about (it has no answer of its own) ...
      expect(started.rounds[0]!.questions).toHaveLength(1);
      // ... and the first paragraph's answer still stands.
      const [record] = await listRecords(PA);
      expect(record).toMatchObject({ status: "settled", reopenedAt: null });
      expect(deleteDocument).not.toHaveBeenCalled();
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
            absolutePath: `/blobs/p/${written.length}`,
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
      const [indexed] = await listRecords(PA);
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
      expect((await listRecords(PA))[0]!.knowledgeDocumentId).toBe(second);
    });

    it("persistClarificationKnowledge records from the stored dialog, indexes and re-runs only what changed", async () => {
      await writeDialogState(A1, answeredState(A1, "R-1", "At least 12 characters."));
      const index = vi.fn(async () => "doc");
      const rerun = vi.fn(async () => ({
        codeMapped: 0,
        governingRequirements: [],
        governingUnmatched: [],
        governingRechecked: [],
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

    it("a later round's re-decision judges, and stores, every round's answers to the requirement", async () => {
      await db.analysis.update({
        where: { id: A4 },
        data: {
          metadata: JSON.stringify({
            structuredRequirements: requirements("R-1"),
            governingApplicability: {
              decidedAt: "2026-11-01T00:00:00.000Z",
              requirements: [{ requirementId: "R-1", text: PARAGRAPH, decisions: [] }],
            },
          }),
        },
      });
      const q = (id: string, field: string, question: string, answer: string) => ({
        id,
        requirementId: "R-1",
        ambiguityField: field,
        question,
        context: "",
        answer,
      });
      const round1 = {
        round: 1,
        questions: [q("q1", "minimumLength", "How long must a password be?", "12 characters.")],
        answers: [{ questionId: "q1", answer: "12 characters." }],
      };
      const round2 = (answer: string) => ({
        round: 2,
        questions: [q("q2", "complexity", "Must a password contain a digit?", answer)],
        answers: [{ questionId: "q2", answer }],
      });
      const dialog = (rounds: ClarificationState["rounds"]): ClarificationState => ({
        analysisId: A4,
        currentRound: rounds.length,
        maxRounds: 3,
        rounds,
        resolvedAmbiguities: [],
        answeredAmbiguities: [],
        escalatedToSonnet: false,
        completed: false,
      });
      const texts: string[] = [];
      const decide = vi.fn(async (r: { id: string; text: string }) => {
        texts.push(r.text);
        return {
          requirementId: r.id,
          decisions: [],
          rulesScreened: 0,
          screenBatches: 0,
          candidates: 0,
          reasked: 0,
          screenReasked: 0,
        };
      });
      const run = {
        requirements: 1,
        written: 0,
        removed: 0,
        decisionsCleared: 0,
        unverifiedCitations: 0,
        noEvidenceDemoted: 0,
        failed: 0,
      };
      const rerun: typeof rerunAfterClarification = (input) =>
        rerunAfterClarification(input, {
          mapToCode: async () => [],
          applicabilityHookFor: async () => ({ decide }),
          produceFindings: async (p) => {
            await p.prepare?.();
            await p.afterProduce?.(run);
            return run;
          },
        });
      const index = vi.fn(async () => null);
      const input = {
        projectId: PA,
        analysisId: A4,
        answeredById: USER,
        provider: questionModel(),
      };
      const storedText = async () =>
        (
          JSON.parse((await db.analysis.findUnique({ where: { id: A4 } }))!.metadata!) as {
            governingApplicability: { requirements: Array<{ text: string }> };
          }
        ).governingApplicability.requirements[0]!.text;
      const bodyAnswers = (s: ClarificationState) =>
        collectAnsweredQuestions(s)
          .filter((a) => a.requirementId === "R-1")
          .map((a) => a.answer);

      // Round 1 answers Q1.
      await writeDialogState(A4, dialog([round1]));
      await persistClarificationKnowledge(input, { index, rerun });
      expect(texts[0]).toContain("A: 12 characters.");

      // Round 2 answers Q2 for the same requirement; Q1's answer is unchanged and settled.
      const two = dialog([round1, round2("Yes, one digit.")]);
      await writeDialogState(A4, two);
      const changed = await persistClarificationKnowledge(input, { index, rerun });
      expect(changed.map((r) => r.answer)).toEqual(["Yes, one digit."]);
      const decided = texts[1]!;
      expect(decided).toContain("A: 12 characters.");
      expect(decided).toContain("A: Yes, one digit.");
      // The decided text carries what the requirement body carries.
      for (const answer of bodyAnswers(two)) expect(decided).toContain(`A: ${answer}`);
      expect(await storedText()).toBe(decided);

      // Q2's answer changes: it replaces the earlier one, and Q1's stays.
      await writeDialogState(A4, dialog([round1, round2("Yes, two digits.")]));
      await persistClarificationKnowledge(input, { index, rerun });
      const third = texts[2]!;
      expect(third).toContain("A: 12 characters.");
      expect(third).toContain("A: Yes, two digits.");
      expect(third).not.toContain("one digit");
      expect(third.match(/- Q: Must a password contain a digit\?/g)).toHaveLength(1);
      expect(await storedText()).toBe(third);
    });

    it("#2310 — a submit records only the round it answered: an older analysis never overwrites a newer answer", async () => {
      const index = vi.fn(async () => "doc");
      const rerun = vi.fn(async () => ({
        codeMapped: 0,
        governingRequirements: [],
        governingUnmatched: [],
        governingRechecked: [],
      }));
      const provider = questionModel();
      // A1 answers the paragraph's question in round 1.
      await writeDialogState(A1, answeredState(A1, "R-1", "At least 12 characters."));
      await persistClarificationKnowledge(
        { projectId: PA, analysisId: A1, answeredById: USER, provider, rounds: [1] },
        { index, rerun },
      );
      // A2, later, answers the same question differently.
      await writeDialogState(A2, answeredState(A2, "R-9", "At least 15 characters."));
      await persistClarificationKnowledge(
        { projectId: PA, analysisId: A2, answeredById: USER, provider, rounds: [1] },
        { index, rerun },
      );
      expect((await listRecords(PA)).map((r) => r.answer)).toEqual(["At least 15 characters."]);

      // A1 then answers round 2 (another question): its round 1 is not recorded again.
      const older = answeredState(A1, "R-1", "At least 12 characters.");
      older.rounds.push({
        round: 2,
        questions: [
          {
            id: "q-a1-r2",
            requirementId: "R-1",
            ambiguityField: "expiry",
            question: "Do passwords expire?",
            context: "",
            answer: "Never.",
          },
        ],
        answers: [{ questionId: "q-a1-r2", answer: "Never." }],
      });
      await writeDialogState(A1, older);
      const changed = await persistClarificationKnowledge(
        { projectId: PA, analysisId: A1, answeredById: USER, provider, rounds: [2] },
        { index, rerun },
      );
      expect(changed.map((r) => r.answer)).toEqual(["Never."]);
      const records = await listRecords(PA);
      expect(records.find((r) => r.ambiguityField === "minimumLength")!.answer).toBe(
        "At least 15 characters.",
      );
    });

    it("#2310 — an uncited answer is its analysis's own: a same-titled requirement elsewhere does not share it", async () => {
      const uncited = (analysisId: string, answer: string): ClarificationState => {
        const s = answeredState(analysisId, "R-1", answer);
        delete s.rounds[0]!.questions[0]!.citation;
        return s;
      };
      const noSources = (id: string) => {
        const r = requirements(id);
        delete r.requirements[0]!.sources;
        return r;
      };
      await recordAnalysisClarifications({
        projectId: PA,
        analysisId: A1,
        answeredById: USER,
        state: uncited(A1, "At least 12 characters."),
        requirements: noSources("R-1"),
      });
      await recordAnalysisClarifications({
        projectId: PA,
        analysisId: A2,
        answeredById: USER,
        state: uncited(A2, "At least 15 characters."),
        requirements: noSources("R-1"),
      });
      const answers = (await listRecords(PA)).map((r) => r.answer).sort();
      expect(answers).toEqual(["At least 12 characters.", "At least 15 characters."]);
    });

    it("#2310 — a reused answer re-runs what it changes for the requirement it now applies to", async () => {
      const [record] = await recordAnalysisClarifications({
        projectId: PA,
        analysisId: A1,
        answeredById: USER,
        state: answeredState(A1, "R-1", "At least 12 characters."),
        requirements: requirements("R-1"),
      });
      const reused = (round: number, extra: Record<string, unknown> = {}) => ({
        requirementId: "R-9",
        ambiguityField: "minimumLength",
        question: "How long must a password be now?",
        answer: "At least 12 characters.",
        recordId: record!.id,
        answeredAt: record!.answeredAt.toISOString(),
        fromAnalysisId: A1,
        round,
        ...extra,
      });
      await writeDialogState(A2, {
        analysisId: A2,
        currentRound: 2,
        maxRounds: 3,
        rounds: [],
        resolvedAmbiguities: [],
        escalatedToSonnet: false,
        completed: true,
        reused: [
          reused(2),
          // Another round's, and a governing one: neither is re-run here.
          reused(1, { requirementId: "R-8" }),
          reused(2, {
            requirementId: "R-7",
            governing: { requirementId: "R-7", ruleIds: ["rule-1"] },
          }),
        ],
      });
      const rerun = vi.fn(async () => ({
        codeMapped: 0,
        governingRequirements: [],
        governingUnmatched: [],
        governingRechecked: [],
      }));
      const provider = questionModel();
      const count = await rerunReusedClarifications(
        { projectId: PA, analysisId: A2, provider, round: 2 },
        { rerun },
      );
      expect(count).toBe(1);
      expect(rerun).toHaveBeenCalledTimes(1);
      const call = (rerun.mock.calls[0] as unknown as [Record<string, unknown>])[0];
      expect(call).toMatchObject({ analysisId: A2, projectId: PA });
      expect(call.records).toEqual([
        expect.objectContaining({
          id: record!.id,
          question: "How long must a password be now?",
          answer: "At least 12 characters.",
          requirementIds: ["R-9"],
        }),
      ]);
      expect(call.settled).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: `record:${record!.id}` })]),
      );
      // The record now applies to the requirement that reused it too, each id
      // qualified by its analysis (#2310: `R-1` is local to an analysis).
      const storedIds = async () =>
        JSON.parse(
          (await db.clarificationRecord.findUniqueOrThrow({ where: { id: record!.id } }))
            .requirementIds,
        ) as string[];
      expect(await storedIds()).toEqual([`${A1}:R-1`, `${A2}:R-9`]);
      // Read back, a record lists its own analysis's requirements only.
      const [stored] = await listRecords(PA);
      expect(stored!.requirementIds).toEqual(["R-1"]);
      // Re-running again adds nothing twice.
      await rerunReusedClarifications(
        { projectId: PA, analysisId: A2, provider, round: 2 },
        { rerun },
      );
      expect(await storedIds()).toEqual([`${A1}:R-1`, `${A2}:R-9`]);

      // Nothing reused this round, no dialog, or another project's record: nothing re-run.
      rerun.mockClear();
      expect(
        await rerunReusedClarifications(
          { projectId: PA, analysisId: A2, provider, round: 3 },
          { rerun },
        ),
      ).toBe(0);
      expect(
        await rerunReusedClarifications(
          { projectId: PA, analysisId: A3, provider, round: 2 },
          { rerun },
        ),
      ).toBe(0);
      expect(
        await rerunReusedClarifications(
          { projectId: PB, analysisId: A2, provider, round: 2 },
          { rerun },
        ),
      ).toBe(0);
      expect(rerun).not.toHaveBeenCalled();
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
      expect(await listRecords(PA, "001-export")).toHaveLength(1);
      expect(await listRecords(PA, null)).toHaveLength(0);
    });
  },
);
