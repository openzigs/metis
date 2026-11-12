/**
 * #1873 (epic #1866) — a BA answer reaches the read path, over the REAL router
 * and a REAL SQLite database built by the migration chain.
 *
 * An analysis whose stored applicability has two `uncertain` rules hinging on
 * the same business fact. `POST /clarify` starts the round: ONE question,
 * linked to both rules. Answering it through the same endpoint (and, in a
 * second analysis, through the CSV import) judges the answer back onto the
 * pairs; a FRESH `GET /governing-applicability` then shows both moved out of
 * `uncertain`. Not only in the dialog's in-memory state.
 *
 * Also: another workspace's member gets 404 for the route, and with the flag
 * off the route is 404 and the round asks no governing question.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  return { db: null as unknown, prompts: [] as string[] };
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
  // Judging: the card rule applies, the encryption rule does not.
  const chat = vi.fn(
    async (messages: Array<{ content: unknown }>, o: { systemMessage?: string } = {}) => {
      const user = messages.map((m) => String(m.content)).join("\n");
      state.prompts.push(`${o.systemMessage ?? ""}\n${user}`);
      const content = (o.systemMessage ?? "").includes("You decide which of a company's")
        ? JSON.stringify({
            decisions: [
              { rule: "R1", verdict: "applies", reason: "Whole numbers are kept." },
              { rule: "R2", verdict: "does-not-apply", reason: "The vault encrypts them." },
            ],
          })
        : "{}";
      return {
        content,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: "stub",
        provider: "anthropic",
      };
    },
  );
  return {
    ...actual,
    buildProvider: vi.fn(() => ({ key: "anthropic", model: "stub", offline: false, chat })),
    loadAIConfig: vi.fn(() => ({ provider: "anthropic", model: "stub" })),
  };
});
vi.mock("../src/lib/rag/knowledge-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/rag/knowledge-service.js")>()),
  getKnowledgeService: vi.fn(() => ({ search: vi.fn(async () => ({ hits: [] })) })),
}));
// #2236 — every analysis here is of one project asking the same governing
// question, so a later start would reuse an earlier test's answer and ask
// nothing. These tests are about one answer's round trip; reuse is
// `clarification-knowledge-2236.sqlite.test.ts`'s.
vi.mock("../src/lib/clarifications/analysis-clarifications.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/lib/clarifications/analysis-clarifications.js")
  >()),
  priorAnswerSourceFor: () => ({ find: async () => new Map() }),
}));

const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const WS = "ws-1873";
const OTHER_WS = "ws-1873-other";
const PROJECT = "proj-1873";
const OTHER_PROJECT = "proj-1873-other";
const MEMBER = "u-1873";
const OUTSIDER = "u-1873-out";
const FACT = "Will the saved card keep the customer's whole card number?";
const REQ_TEXT = "Let returning customers check out with a saved card.";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1873 — a governing answer reaches the read path (real router, real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let seq = 0;
    const rules: Record<string, string> = {};

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId/analyses", initAnalysisRouter().projectScoped);
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const token = (userId: string, workspace: string) =>
      issueTokens({
        userId,
        username: userId,
        role: "coordinator",
        permissions: ["analysis.read", "analysis.run"],
        workspaces: [workspace],
      }).accessToken;
    const base = (projectId: string, analysisId: string) =>
      `/api/projects/${projectId}/analyses/${analysisId}`;

    async function seedAnalysis(): Promise<string> {
      seq += 1;
      const id = `ana-1873-${seq}`;
      const uncertain = (ruleId: string, controlId: string) => ({
        ruleId,
        controlId,
        verdict: "uncertain",
        reason: "Depends on what the saved card keeps.",
        businessFact: FACT,
        foundBy: ["screen"],
      });
      await db.analysis.create({
        data: {
          id,
          projectId: PROJECT,
          startedById: MEMBER,
          status: "completed",
          metadata: JSON.stringify({
            structuredRequirements: {
              requirements: [
                {
                  id: "REQ-001",
                  title: "Saved card checkout",
                  description: REQ_TEXT,
                  type: "functional",
                  stakeholders: [],
                  priority: "must-have",
                  ambiguities: [],
                  evidenceNeeds: [],
                  rawSource: "",
                },
              ],
              totalAmbiguities: 0,
              totalEvidenceNeeds: 0,
            },
            structuredRunId: "run-1873",
            governingApplicability: {
              decidedAt: "2026-11-08T00:00:00.000Z",
              requirements: [
                {
                  requirementId: "REQ-001",
                  text: REQ_TEXT,
                  decisions: [
                    uncertain(rules["EN-03"]!, "EN-03"),
                    uncertain(rules["EN-02"]!, "EN-02"),
                  ],
                },
              ],
            },
          }),
        },
      });
      return id;
    }

    const freshApplicability = async (analysisId: string) => {
      const res = await request(app())
        .get(`${base(PROJECT, analysisId)}/governing-applicability`)
        .set("Authorization", `Bearer ${token(MEMBER, WS)}`);
      expect(res.status).toBe(200);
      return res.body.data.applicability as {
        requirements: Array<{
          decisions: Array<{
            ruleId: string;
            verdict: string;
            settled?: { questionId: string; answer: string };
          }>;
        }>;
      };
    };

    /** Start the round: exactly one question, linked to both rules. */
    async function startRound(analysisId: string) {
      const res = await request(app())
        .post(`${base(PROJECT, analysisId)}/clarify`)
        .set("Authorization", `Bearer ${token(MEMBER, WS)}`)
        .send({});
      expect(res.status).toBe(200);
      const questions = res.body.data.rounds[0].questions as Array<{
        id: string;
        question: string;
        governing?: { ruleIds: string[] };
      }>;
      expect(questions).toHaveLength(1);
      expect(questions[0]!.governing?.ruleIds.sort()).toEqual(
        [rules["EN-03"]!, rules["EN-02"]!].sort(),
      );
      expect(questions[0]!.question).toBe(FACT);
      return questions[0]!;
    }

    function expectBothMoved(
      applicability: Awaited<ReturnType<typeof freshApplicability>>,
      questionId: string,
    ) {
      const byRule = new Map(applicability.requirements[0]!.decisions.map((d) => [d.ruleId, d]));
      expect(byRule.get(rules["EN-03"]!)).toMatchObject({
        verdict: "applies",
        settled: { questionId },
      });
      expect(byRule.get(rules["EN-02"]!)).toMatchObject({
        verdict: "does-not-apply",
        settled: { questionId },
      });
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1873-governing-round-trip");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const [id, slug] of [
        [WS, "ws-1873"],
        [OTHER_WS, "ws-1873-other"],
      ]) {
        await db.workspace.create({ data: { id: id!, name: id!, slug: slug! } });
      }
      for (const u of [MEMBER, OUTSIDER]) {
        await db.user.create({
          data: { id: u, username: u, displayName: u, email: `${u}@example.test` },
        });
      }
      await db.workspaceMember.create({
        data: { workspaceId: WS, userId: MEMBER, role: "member" },
      });
      await db.workspaceMember.create({
        data: { workspaceId: OTHER_WS, userId: OUTSIDER, role: "member" },
      });
      await db.project.create({
        data: { id: PROJECT, name: PROJECT, slug: PROJECT, createdById: MEMBER, workspaceId: WS },
      });
      await db.project.create({
        data: {
          id: OTHER_PROJECT,
          name: OTHER_PROJECT,
          slug: OTHER_PROJECT,
          createdById: OUTSIDER,
          workspaceId: OTHER_WS,
        },
      });
      const text =
        "EN-02: Payment information is encrypted at rest.\n\nEN-03: Full card numbers are never stored.";
      const doc = await db.governingDocument.create({
        data: { workspaceId: WS, title: "Info Policy", createdById: MEMBER },
      });
      const rev = await db.governingDocumentRevision.create({
        data: {
          documentId: doc.id,
          revisionLabel: "v1",
          effectiveDate: new Date("2026-01-01"),
          storagePath: `${doc.id}/v1`,
          contentHash: `${doc.id}-v1`,
          mimeType: "text/markdown",
          sizeBytes: text.length,
          extractedText: text,
          indexState: "indexed",
          extractionState: "done",
          uploadedById: MEMBER,
        },
      });
      await db.governingDocument.update({
        where: { id: doc.id },
        data: { currentRevisionId: rev.id },
      });
      for (const [controlId, summary] of [
        ["EN-03", "Full card numbers are never stored."],
        ["EN-02", "Payment information is encrypted at rest."],
      ] as const) {
        const start = text.indexOf(summary);
        const rule = await db.governingRule.create({
          data: {
            revisionId: rev.id,
            controlId,
            summary,
            clauseRef: "§4",
            clauseStart: start,
            clauseEnd: start + summary.length,
            clauseExcerpt: summary,
          },
        });
        rules[controlId] = rule.id;
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(() => {
      process.env.GOVERNING_DOCS_ENABLED = "1";
      state.prompts = [];
    });
    afterEach(() => {
      delete process.env.GOVERNING_DOCS_ENABLED;
    });
    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("POST /clarify answers it; a fresh GET shows both pairs moved out of uncertain", async () => {
      const id = await seedAnalysis();
      const q = await startRound(id);
      // Before the answer: both uncertain, on a fresh read.
      const before = await freshApplicability(id);
      expect(before.requirements[0]!.decisions.map((d) => d.verdict)).toEqual([
        "uncertain",
        "uncertain",
      ]);
      const res = await request(app())
        .post(`${base(PROJECT, id)}/clarify`)
        .set("Authorization", `Bearer ${token(MEMBER, WS)}`)
        .send({ answers: [{ questionId: q.id, answer: "Yes, the whole number is kept." }] });
      expect(res.status).toBe(200);
      expectBothMoved(await freshApplicability(id), q.id);
      // The judging prompt carried the answer, and the clause it judges against.
      const judged = state.prompts.filter((p) => p.includes("You decide which"));
      expect(judged).toHaveLength(1);
      expect(judged[0]).toContain("Their answer: Yes, the whole number is kept.");
      // And it is in the database, not just a response.
      const row = await db.analysis.findUniqueOrThrow({ where: { id } });
      expect(
        JSON.parse(row.metadata!).governingApplicability.requirements[0].decisions[0],
      ).toMatchObject({
        verdict: "applies",
      });
      // #1874 — the answer fed the findings too: the rule that now applies has
      // one, the rule that does not apply has none. #2010 — written off the
      // request path, after the response, so read until it lands.
      await vi.waitFor(
        async () => {
          const findings = await db.governingFinding.findMany({ where: { analysisId: id } });
          expect(findings.map((f) => f.ruleId)).toEqual([rules["EN-03"]!]);
        },
        { timeout: 5_000, interval: 25 },
      );
    });

    it("the CSV import answers it the same way", async () => {
      const id = await seedAnalysis();
      const q = await startRound(id);
      const csv =
        "questionId,requirement,ambiguityField,question,suggestedAnswer,answer\r\n" +
        `${q.id},Saved card checkout,governing-applicability,"${FACT}",,"Yes, all of it."\r\n`;
      const res = await request(app())
        .post(`${base(PROJECT, id)}/clarify/import`)
        .set("Authorization", `Bearer ${token(MEMBER, WS)}`)
        .attach("file", Buffer.from(csv), "answers.csv");
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ applied: 1 });
      expectBothMoved(await freshApplicability(id), q.id);
    });

    it("a member of another workspace gets 404 for the route", async () => {
      const id = await seedAnalysis();
      const asOutsider = await request(app())
        .get(`${base(PROJECT, id)}/governing-applicability`)
        .set("Authorization", `Bearer ${token(OUTSIDER, OTHER_WS)}`);
      expect(asOutsider.status).toBe(404);
      // Through their own project's path, the analysis is not found either.
      const crossPath = await request(app())
        .get(`${base(OTHER_PROJECT, id)}/governing-applicability`)
        .set("Authorization", `Bearer ${token(OUTSIDER, OTHER_WS)}`);
      expect(crossPath.status).toBe(404);
    });

    it("flag off: the route is 404 and the round asks no governing question", async () => {
      const id = await seedAnalysis();
      process.env.GOVERNING_DOCS_ENABLED = "0";
      const get = await request(app())
        .get(`${base(PROJECT, id)}/governing-applicability`)
        .set("Authorization", `Bearer ${token(MEMBER, WS)}`);
      expect(get.status).toBe(404);
      const start = await request(app())
        .post(`${base(PROJECT, id)}/clarify`)
        .set("Authorization", `Bearer ${token(MEMBER, WS)}`)
        .send({});
      expect(start.status).toBe(200);
      expect(start.body.data).toMatchObject({ completed: true, rounds: [] });
    });
  },
);
