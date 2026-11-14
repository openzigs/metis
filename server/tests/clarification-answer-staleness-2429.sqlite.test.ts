/**
 * #2429 — an analyst's answer to a clarifying question, given once the
 * requirements exist, is a person's edit for #2222's staleness, over a REAL
 * SQLite database built by the migration chain.
 *
 * The analysis analysed AC-2 (passwords of 8 characters); synthesis wrote R1
 * and R2 from the code finding on it, and the governing check found PW-01 a
 * gap for AC-2.
 *
 *   - Answers written when the requirements were created (promotion) are the
 *     analysis's own: R2 is not stale.
 *   - The analyst answers R1's question after the analysis
 *     (`applyClarificationsToRequirements` with `afterAnalysis`): the
 *     traceability matrix marks R1's findings stale, and so does AC-2's
 *     governing finding, while the #769 guard still reads R1 as unreviewed.
 *   - The clarification re-run's re-decision fails: nothing is stored, and
 *     the old governing finding still reads stale for R1 — the lasting marker.
 *   - The re-decision succeeds: AC-2's finding records R1's answered version
 *     and is current for it; the traceability (agent) findings, not re-run,
 *     stay stale. A hand edit of R1 afterwards makes it stale again.
 *   - Reopen: a near-identical sibling paragraph the document still holds is
 *     never reopened for the edited one.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage } from "../src/lib/ai/types.js";
import type { ApplicabilitySet } from "../src/lib/governing/applicability.js";
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

const { produceGoverningFindingsForAnalysis, listGoverningFindings } =
  await import("../src/lib/governing/findings-store.js");
const { readGoverningApplicability } = await import("../src/lib/governing/applicability-store.js");
const { storedRequirementStates, withGoverningStaleness } =
  await import("../src/lib/governing/requirement-staleness.js");
const { updateRequirementWithHistory } =
  await import("../src/lib/requirements/requirement-version-service.js");
const { applyClarificationsToRequirements, CLARIFICATION_VERSION_REASON } =
  await import("../src/lib/analysis/clarification-enrichment.js");
const { getAnalysisSnapshot, reviewedRequirementWhere } =
  await import("../src/lib/analysis/analysis-service.js");
const { getTraceabilityMatrix } = await import("../src/lib/analysis/traceability-service.js");
const { rerunAfterClarification } =
  await import("../src/lib/clarifications/clarification-rerun.js");
const { recordClarification, reopenChangedSources } =
  await import("../src/lib/clarifications/clarification-records.js");
const { paragraphSimilarity } = await import("../src/lib/clarifications/clarification-key.js");
type StoredClarification =
  import("../src/lib/clarifications/clarification-records.js").StoredClarification;

const WS = "ws-2429";
const USER = "u-2429";
const PA = "proj-2429";
const ANA = "ana-2429";

const CLAUSE = "Passwords SHALL be at least 15 characters long unless MFA is enabled.";
const POLICY = `# Authentication Standard\n\n§5.1 ${CLAUSE}\n`;
const AC2 = "Raise the minimum password length from 6 to 8 characters.";
const QUESTION = "How long must a password be?";
const ANSWER = "At least 12 characters.";

/** The findings model: every rule it is shown is a gap, quoting its clause. */
function findingsModel(): AIProvider {
  const chat = vi.fn(async (messages: ChatMessage[]) => {
    const user = messages.map((m) => String(m.content)).join("\n");
    const findings = [...user.matchAll(/^(R\d+) \[(\S+)\]/gm)].map((m) => ({
      rule: m[1],
      status: "gap",
      reasoning: "The length is below the standard's minimum.",
      excerpt: "Passwords SHALL be at least 15 characters long",
    }));
    return { content: JSON.stringify({ findings }), model: "m", provider: "anthropic" as const };
  });
  return { key: "anthropic", model: "stub", offline: false, chat } as unknown as AIProvider;
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2429 — a clarification answer after the analysis is a person's edit (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let ruleId = "";
    let r1 = "";
    let r2 = "";
    let codeFinding = "";

    /** Applicability that decides PW-01 applies, or fails with `error`. */
    const hookFor = (error?: string) => async () => ({
      decide: async (r: { id: string }): Promise<ApplicabilitySet> => ({
        requirementId: r.id,
        decisions: error
          ? []
          : ([
              {
                ruleId,
                controlId: "PW-01",
                verdict: "applies",
                reason: "It sets a password length.",
                foundBy: ["screen"],
              },
            ] as ApplicabilitySet["decisions"]),
        rulesScreened: 1,
        screenBatches: 1,
        candidates: 1,
        reasked: 0,
        screenReasked: 0,
        ...(error ? { error } : {}),
      }),
    });
    const record: StoredClarification = {
      id: "rec-2429",
      projectId: PA,
      origin: "analysis",
      questionKey: "k-2429",
      analysisId: ANA,
      specKitFeature: null,
      questionId: "q1",
      question: QUESTION,
      answer: ANSWER,
      answeredById: USER,
      answeredAt: new Date("2026-11-13T00:00:00.000Z"),
      ambiguityField: "minimumLength",
      source: null,
      requirementIds: ["REQ-1"],
      productIds: [],
      status: "settled",
      reopenedAt: null,
      knowledgeDocumentId: null,
    };
    const rerun = (error?: string) =>
      rerunAfterClarification(
        { analysisId: ANA, projectId: PA, provider: findingsModel(), records: [record] },
        { mapToCode: async () => [], applicabilityHookFor: hookFor(error) },
      );
    /** AC-2's governing finding, as the findings route shows it. */
    const governing = async () => {
      const [stored, applicability, states] = await Promise.all([
        listGoverningFindings(ANA),
        readGoverningApplicability(ANA),
        storedRequirementStates(ANA, PA),
      ]);
      const all = withGoverningStaleness(stored, states, applicability);
      return all.find((f) => f.requirementId === "AC-2")!;
    };
    const matrixRow = async (id: string) => {
      const matrix = await getTraceabilityMatrix(ANA, { resolveTests: async () => new Map() });
      return matrix!.rows.find((r) => r.requirementId === id)!;
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2429-clarification-staleness");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.workspace.create({ data: { id: WS, name: WS, slug: WS } });
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@example.test` },
      });
      await db.workspaceMember.create({ data: { workspaceId: WS, userId: USER, role: "member" } });
      await db.project.create({
        data: { id: PA, name: PA, slug: PA, createdById: USER, workspaceId: WS },
      });
      const doc = await db.governingDocument.create({
        data: { workspaceId: WS, title: "Authentication Standard", createdById: USER },
      });
      const rev = await db.governingDocumentRevision.create({
        data: {
          documentId: doc.id,
          revisionLabel: "v1",
          effectiveDate: new Date("2026-01-01"),
          storagePath: `${doc.id}/v1`,
          contentHash: `${doc.id}-v1`,
          mimeType: "text/markdown",
          sizeBytes: POLICY.length,
          extractedText: POLICY,
          indexState: "indexed",
          extractionState: "done",
          uploadedById: USER,
        },
      });
      await db.governingDocument.update({
        where: { id: doc.id },
        data: { currentRevisionId: rev.id },
      });
      const start = POLICY.indexOf(CLAUSE);
      ruleId = (
        await db.governingRule.create({
          data: {
            revisionId: rev.id,
            controlId: "PW-01",
            summary: "Passwords of at least 15 characters",
            clauseRef: "§5.1",
            clauseStart: start,
            clauseEnd: start + CLAUSE.length,
            clauseExcerpt: CLAUSE,
          },
        })
      ).id;
      await db.analysis.create({
        data: {
          id: ANA,
          projectId: PA,
          startedById: USER,
          status: "completed",
          metadata: JSON.stringify({
            governingApplicability: {
              decidedAt: "2026-11-10T00:00:00.000Z",
              requirements: [
                {
                  requirementId: "AC-2",
                  text: AC2,
                  decisions: [
                    {
                      ruleId,
                      controlId: "PW-01",
                      verdict: "applies",
                      reason: "It sets a password length.",
                      foundBy: ["screen"],
                    },
                  ],
                },
              ],
            },
            structuredRequirements: {
              requirements: [
                {
                  id: "REQ-1",
                  title: "Minimum password length",
                  description: "",
                  type: "functional",
                  stakeholders: [],
                  priority: "must-have",
                  ambiguities: [],
                  evidenceNeeds: [],
                },
              ],
              totalAmbiguities: 0,
              totalEvidenceNeeds: 0,
            },
          }),
        },
      });
      const agent = await db.agentResult.create({
        data: { analysisId: ANA, agentKey: "code", status: "completed" },
      });
      codeFinding = (
        await db.finding.create({
          data: {
            agentResultId: agent.id,
            category: "gap",
            title: "Raise minimum password length from 6 to 8",
            body: "b",
            evidence: JSON.stringify({ requirementId: "AC-2" }),
          },
        })
      ).id;
      for (const title of ["Minimum password length", "Reset page states the password rules"]) {
        const row = await db.requirement.create({
          data: {
            analysisId: ANA,
            projectId: PA,
            title,
            body: `${title}.`,
            labels: JSON.stringify([`finding:${codeFinding}`]),
          },
        });
        if (!r1) r1 = row.id;
        else r2 = row.id;
      }
      // R2: an answer written in when the requirements were created — the
      // analysis's own writing (#2222's system version).
      await updateRequirementWithHistory(db as never, {
        requirementId: r2,
        patch: { body: "Reset page states the password rules.\n\nAnswered at promotion." },
        expectedVersion: 0,
        actorId: null,
        reason: CLARIFICATION_VERSION_REASON,
      });
      process.env.GOVERNING_DOCS_ENABLED = "1";
      await produceGoverningFindingsForAnalysis({
        analysisId: ANA,
        projectId: PA,
        provider: findingsModel(),
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(() => {
      process.env.GOVERNING_DOCS_ENABLED = "1";
    });
    afterEach(() => {
      delete process.env.GOVERNING_DOCS_ENABLED;
    });
    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    // The tests below run in order: each builds on the writes before it.

    it("an answer written in at promotion is the analysis's own: nothing is stale", async () => {
      expect((await governing()).stale).toEqual([]);
      expect((await matrixRow(r2)).findingsStale).toBeUndefined();
      const snapshot = await getAnalysisSnapshot(ANA);
      expect(snapshot!.requirements.find((r) => r.id === r2)).toMatchObject({
        version: 1,
        analysedVersion: 1,
      });
    });

    it("an answer after the analysis marks the traceability and governing findings stale, and is not review work", async () => {
      await db.clarificationDialogState.create({
        data: {
          analysisId: ANA,
          state: JSON.stringify({
            analysisId: ANA,
            currentRound: 1,
            maxRounds: 3,
            rounds: [
              {
                round: 1,
                questions: [
                  {
                    id: "q1",
                    requirementId: "REQ-1",
                    ambiguityField: "minimumLength",
                    question: QUESTION,
                    context: "",
                    answer: ANSWER,
                  },
                ],
                answers: [],
              },
            ],
            resolvedAmbiguities: [],
            escalatedToSonnet: false,
            completed: true,
          }),
        },
      });
      const applied = await applyClarificationsToRequirements(ANA, { afterAnalysis: true });
      expect(applied).toMatchObject({ appliedCount: 1, requirementsUpdated: 1 });
      const row = await db.requirement.findUniqueOrThrow({ where: { id: r1 } });
      expect(row).toMatchObject({ version: 1 });
      expect(row.body).toContain(ANSWER);

      expect((await matrixRow(r1)).findingsStale).toEqual({ judgedVersion: 0, currentVersion: 1 });
      expect((await governing()).stale).toEqual([
        {
          requirementId: r1,
          title: "Minimum password length",
          judgedVersion: 0,
          currentVersion: 1,
        },
      ]);
      // #769 — an answer is not review work: the set can still be re-synthesised.
      expect(await db.requirement.count({ where: reviewedRequirementWhere(ANA) })).toBe(0);
    });

    it("a failed re-decision stores nothing, and the old finding still reads stale for R1", async () => {
      const before = await readGoverningApplicability(ANA);
      const result = await rerun("Rules could not be loaded.");
      expect(result.governingRequirements).toEqual([]);
      expect(await readGoverningApplicability(ANA)).toEqual(before);
      expect((await governing()).stale?.map((s) => s.requirementId)).toEqual([r1]);
    });

    it("a re-decision judges R1's answered version: current for it; the agent findings stay stale", async () => {
      const result = await rerun();
      expect(result.governingRequirements).toEqual(["AC-2"]);
      const finding = await governing();
      expect(finding.requirementVersions).toEqual({ [r1]: 1 });
      expect(finding.stale).toEqual([]);
      const entry = (await readGoverningApplicability(ANA))!.requirements.find(
        (r) => r.requirementId === "AC-2",
      )!;
      expect(entry.versions).toEqual({ [r1]: 1 });
      expect((await matrixRow(r1)).findingsStale).toEqual({ judgedVersion: 0, currentVersion: 1 });
    });

    it("a hand edit of R1 after the re-decision makes AC-2's finding stale for it again", async () => {
      await updateRequirementWithHistory(db as never, {
        requirementId: r1,
        patch: { body: "Passwords are at least 15 characters." },
        expectedVersion: 1,
        actorId: USER,
      });
      expect((await governing()).stale).toEqual([
        {
          requirementId: r1,
          title: "Minimum password length",
          judgedVersion: 1,
          currentVersion: 2,
        },
      ]);
    });

    describe("reopen: a sibling paragraph the document still holds", () => {
      const DOC = "doc-2429";
      const slot = { documentId: DOC, filename: "frd.md", headingPath: ["4 Accounts"] };
      const A = "Passwords for staff accounts must be long enough and rotated yearly.";
      const B = "Passwords for guest accounts must be long enough and rotated monthly.";
      // A, edited to read more like its sibling B than like itself.
      const A_EDITED =
        "Passwords for staff and guest accounts must be long enough and rotated monthly.";
      const recordFor = (key: string, quote: string) =>
        recordClarification(PA, {
          origin: "analysis",
          questionKey: key,
          analysisId: ANA,
          question: QUESTION,
          answer: ANSWER,
          answeredAt: new Date("2026-11-12T10:00:00.000Z"),
          ambiguityField: "minimumLength",
          source: { ...slot, quote },
          requirementIds: ["REQ-1"],
          productIds: [],
        });
      const askEdited = () =>
        reopenChangedSources(PA, [
          {
            key: "k-a-edited",
            question: {
              question: QUESTION,
              ambiguityField: "minimumLength",
              citation: { ...slot, quote: A_EDITED },
            },
          },
        ]);

      beforeAll(async () => {
        await db.document.create({
          data: {
            id: DOC,
            projectId: PA,
            filename: "frd.md",
            mimeType: "text/markdown",
            sizeBytes: 1,
            storagePath: "frd.md",
            checksum: "c",
            uploadedById: USER,
          },
        });
      });
      beforeEach(async () => {
        await db.clarificationRecord.deleteMany({});
        await db.knowledgeChunk.deleteMany({});
        await db.quarantineChunk.deleteMany({});
      });

      it("the edited paragraph's record is reopened, never the sibling the document still holds", async () => {
        // B reads more like the edit than A does: similarity alone would pick it.
        expect(paragraphSimilarity(A_EDITED, B)).toBeGreaterThan(paragraphSimilarity(A_EDITED, A));
        const a = await recordFor("k-a", A);
        const b = await recordFor("k-b", B);
        await db.knowledgeChunk.create({
          data: {
            projectId: PA,
            documentId: DOC,
            position: 0,
            text: `# 4 Accounts\n\n${A_EDITED}\n\n${B.replace("guest", "guest\n")}`,
            md5: "m",
          },
        });
        const reopened = await askEdited();
        expect(reopened.map((r) => r.id)).toEqual([a.record.id]);
        const byId = new Map(
          (await db.clarificationRecord.findMany()).map((r) => [r.id, r.status]),
        );
        expect(byId.get(b.record.id)).toBe("settled");
      });

      it("finds the sibling the document still holds across two overlapping chunks", async () => {
        const a = await recordFor("k-a", A);
        const b = await recordFor("k-b", B);
        // The chunker's carry-over: chunk 1 opens with chunk 0's end, and B,
        // longer than that overlap, is whole in neither.
        const cut = B.indexOf(" must be long");
        const carried = B.slice(B.indexOf("for guest"), cut);
        for (const [position, text] of [
          [0, `# 4 Accounts\n\n${A_EDITED}\n\n${B.slice(0, cut)}`],
          [1, `${carried}${B.slice(cut)}\n\nInvoices are sent monthly.`],
        ] as const) {
          await db.knowledgeChunk.create({
            data: { projectId: PA, documentId: DOC, position, text, md5: `m${position}` },
          });
        }
        const reopened = await askEdited();
        expect(reopened.map((r) => r.id)).toEqual([a.record.id]);
        const byId = new Map(
          (await db.clarificationRecord.findMany()).map((r) => [r.id, r.status]),
        );
        expect(byId.get(b.record.id)).toBe("settled");
      });

      it("reads the quarantined chunks when none is approved, and reopens nothing when both paragraphs remain", async () => {
        await recordFor("k-a", A);
        await recordFor("k-b", B);
        await db.quarantineChunk.create({
          data: {
            projectId: PA,
            documentId: DOC,
            ord: 0,
            text: `${A} ${B} ${A_EDITED}`,
            embedding: "[]",
          },
        });
        expect(await askEdited()).toEqual([]);
      });

      it("with no stored text, similarity alone decides, as before", async () => {
        const a = await recordFor("k-a", A);
        await recordFor("k-b", "Invoices for guest orders are sent at the end of the month.");
        const reopened = await askEdited();
        expect(reopened.map((r) => r.id)).toEqual([a.record.id]);
      });
    });
  },
);
