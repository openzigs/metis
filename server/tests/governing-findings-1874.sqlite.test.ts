/**
 * #1874 (epic #1866) — cited governing findings over the REAL router and a REAL
 * SQLite database built by the migration chain.
 *
 *   - Round trip: findings written by the analysis's production step
 *     (`produceGoverningFindingsForAnalysis`, what the run's join calls) come
 *     back from a fresh `GET …/governing-findings`. A decision POST followed by
 *     a fresh GET shows the decision, the note and the decider (the session
 *     user), and an `AuditLog` row names the finding.
 *   - The decider is never the body: a body naming one is a 400.
 *   - A member of another project in another workspace gets 404 for both
 *     routes, through either project's path, and a finding id is never found
 *     under another analysis.
 *   - After a policy v2 changes the clause, the findings produced against v1
 *     still show v1's excerpt and revision label.
 *
 * #2010 — every test starts from the same database: no findings, policy v1
 * current. A test that needs a decided finding makes one itself
 * (`produceAndReject`), so each one passes run alone or in any order.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatOptions } from "../src/lib/ai/types.js";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  return { db: null as unknown };
});
vi.mock("../src/lib/prisma.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/prisma.js")>()),
  get prisma() {
    return state.db;
  },
}));

const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { produceGoverningFindingsForAnalysis } =
  await import("../src/lib/governing/findings-store.js");

const WS_A = "ws-1874-a";
const WS_B = "ws-1874-b";
const PA = "proj-1874-a";
const PB = "proj-1874-b";
const MEMBER_A = "u-1874-a";
const MEMBER_B = "u-1874-b";
const ANA = "ana-1874-a";
const ANB = "ana-1874-b";

const CARD_V1 =
  "The company never stores a full payment card number in any system; only the last four digits may be kept.";
const AUDIT_V1 =
  "Every bulk export of customer records is written to the audit log with the person who ran it.";
const V1_TEXT = `# Information Handling Policy\n\n§4.3 ${CARD_V1}\n\n§5.1 ${AUDIT_V1}\n`;
const CARD_V2 =
  "The company never stores a full payment card number in any system; only a vault token may be kept.";
const V2_TEXT = `# Information Handling Policy\n\n§4.3 ${CARD_V2}\n\n§5.1 ${AUDIT_V1}\n`;
const REQ_TEXT =
  "Saved cards keep only the last four digits of the card number, shown at checkout.";

/** The findings model: the card rule is compliant, quoting the requirement and its clause. */
function findingsModel(): AIProvider {
  const chat = vi.fn(async (messages: ChatMessage[], _o: ChatOptions = {}) => {
    const user = messages.map((m) => String(m.content)).join("\n");
    const findings = [...user.matchAll(/^(R\d+) \[(\S+)\]/gm)].map((m) =>
      m[2] === "EN-03"
        ? {
            rule: m[1],
            status: "compliant",
            reasoning: "Only the last four digits are kept.",
            excerpt: "never stores a full payment card number in any system",
            satisfiedBy: "keep only the last four digits of the card number",
          }
        : { rule: m[1], status: "gap", reasoning: "Not covered.", excerpt: "x" },
    );
    return { content: JSON.stringify({ findings }), model: "m", provider: "anthropic" as const };
  });
  return { key: "anthropic", model: "stub", offline: false, chat } as unknown as AIProvider;
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1874 — cited governing findings (real router, real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const rules: Record<string, string> = {};
    let docId = "";
    let v1Id = "";

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId/analyses", initAnalysisRouter().projectScoped);
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const token = (userId: string, ws: string) =>
      issueTokens({
        userId,
        username: userId,
        role: "coordinator",
        permissions: [],
        workspaces: [ws],
      }).accessToken;
    const findingsPath = (project: string, analysis: string) =>
      `/api/projects/${project}/analyses/${analysis}/governing-findings`;
    const getFindings = (project: string, analysis: string, user = MEMBER_A, ws = WS_A) =>
      request(app())
        .get(findingsPath(project, analysis))
        .set("Authorization", `Bearer ${token(user, ws)}`);
    const decide = (
      project: string,
      analysis: string,
      findingId: string,
      body: unknown,
      user = MEMBER_A,
      ws = WS_A,
    ) =>
      request(app())
        .post(`${findingsPath(project, analysis)}/${findingId}/decision`)
        .set("Authorization", `Bearer ${token(user, ws)}`)
        .send(body as object);

    async function revision(label: string, text: string) {
      const rev = await db.governingDocumentRevision.create({
        data: {
          documentId: docId,
          revisionLabel: label,
          effectiveDate: new Date("2026-01-01"),
          storagePath: `${docId}/${label}`,
          contentHash: `${docId}-${label}`,
          mimeType: "text/markdown",
          sizeBytes: text.length,
          extractedText: text,
          indexState: "indexed",
          extractionState: "done",
          uploadedById: MEMBER_A,
        },
      });
      await db.governingDocument.update({
        where: { id: docId },
        data: { currentRevisionId: rev.id },
      });
      return rev.id;
    }
    async function rule(revisionId: string, text: string, controlId: string, clause: string) {
      const start = text.indexOf(clause);
      const row = await db.governingRule.create({
        data: {
          revisionId,
          controlId,
          summary: `${controlId} summary`,
          clauseRef: controlId === "EN-03" ? "§4.3" : "§5.1",
          clauseStart: start,
          clauseEnd: start + clause.length,
          clauseExcerpt: clause,
        },
      });
      return row.id;
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1874-governing-findings");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const [ws, user, project] of [
        [WS_A, MEMBER_A, PA],
        [WS_B, MEMBER_B, PB],
      ] as const) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
        await db.user.create({
          data: { id: user, username: user, displayName: user, email: `${user}@example.test` },
        });
        await db.workspaceMember.create({
          data: { workspaceId: ws, userId: user, role: "member" },
        });
        await db.project.create({
          data: { id: project, name: project, slug: project, createdById: user, workspaceId: ws },
        });
      }
      const doc = await db.governingDocument.create({
        data: { workspaceId: WS_A, title: "Information Handling Policy", createdById: MEMBER_A },
      });
      docId = doc.id;
      v1Id = await revision("v1", V1_TEXT);
      rules.card = await rule(v1Id, V1_TEXT, "EN-03", CARD_V1);
      rules.audit = await rule(v1Id, V1_TEXT, "AL-02", AUDIT_V1);
      const applicability = {
        decidedAt: "2026-11-08T00:00:00.000Z",
        requirements: [
          {
            requirementId: "REQ-001",
            text: REQ_TEXT,
            decisions: [
              {
                ruleId: rules.card,
                controlId: "EN-03",
                verdict: "applies",
                reason: "It keeps card data.",
                foundBy: ["screen"],
              },
              {
                ruleId: rules.audit,
                controlId: "AL-02",
                verdict: "uncertain",
                reason: "Depends on exports.",
                businessFact: "Will anyone export the saved cards in bulk?",
                foundBy: ["screen"],
              },
            ],
          },
        ],
      };
      for (const [id, project, user] of [
        [ANA, PA, MEMBER_A],
        [ANB, PB, MEMBER_B],
      ] as const) {
        await db.analysis.create({
          data: {
            id,
            projectId: project,
            startedById: user,
            status: "completed",
            metadata: JSON.stringify({ governingApplicability: applicability }),
          },
        });
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(async () => {
      process.env.GOVERNING_DOCS_ENABLED = "1";
      await db.governingFinding.deleteMany({ where: { analysisId: { in: [ANA, ANB] } } });
      await db.auditLog.deleteMany({ where: { targetType: "governing_finding" } });
      await db.governingDocument.update({
        where: { id: docId },
        data: { currentRevisionId: v1Id },
      });
    });

    /** #2010 — findings produced against v1, and the card finding rejected by A's member. */
    async function produceAndReject() {
      await produceGoverningFindingsForAnalysis({
        analysisId: ANA,
        projectId: PA,
        provider: findingsModel(),
      });
      const card = await db.governingFinding.findFirstOrThrow({
        where: { analysisId: ANA, controlId: "EN-03" },
      });
      const res = await decide(PA, ANA, card.id, {
        decision: "rejected",
        note: "Security says tokens, not digits.",
      });
      expect(res.status).toBe(200);
      return card;
    }

    /** Policy v2 made current, created once however many tests ask for it. */
    async function makeV2Current() {
      const existing = await db.governingDocumentRevision.findFirst({
        where: { documentId: docId, revisionLabel: "v2" },
      });
      if (existing) {
        await db.governingDocument.update({
          where: { id: docId },
          data: { currentRevisionId: existing.id },
        });
        return;
      }
      const v2Id = await revision("v2", V2_TEXT);
      await rule(v2Id, V2_TEXT, "EN-03", CARD_V2);
    }
    afterEach(() => {
      delete process.env.GOVERNING_DOCS_ENABLED;
    });
    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("round trip: written by the analysis step, read by a fresh GET; a decision is read back with its decider and audited", async () => {
      const run = await produceGoverningFindingsForAnalysis({
        analysisId: ANA,
        projectId: PA,
        provider: findingsModel(),
      });
      expect(run).toMatchObject({ requirements: 1, written: 2, unverifiedCitations: 0 });

      const first = await getFindings(PA, ANA);
      expect(first.status).toBe(200);
      const findings = first.body.data.findings as Array<Record<string, unknown>>;
      const card = findings.find((f) => f.controlId === "EN-03")!;
      const audit = findings.find((f) => f.controlId === "AL-02")!;
      expect(card).toMatchObject({
        status: "compliant",
        ruleId: rules.card,
        revisionId: v1Id,
        revisionLabel: "v1",
        documentTitle: "Information Handling Policy",
        clauseExcerpt: "never stores a full payment card number in any system",
        citationDropped: false,
        decision: null,
      });
      // The stored excerpt IS the revision's own text at the stored offsets.
      expect(V1_TEXT.slice(card.clauseStart as number, card.clauseEnd as number)).toBe(
        card.clauseExcerpt,
      );
      expect(audit).toMatchObject({
        status: "needs-ba-input",
        businessQuestion: "Will anyone export the saved cards in bulk?",
        clauseExcerpt: AUDIT_V1,
      });
      expect(first.body.data.summary).toMatchObject({
        total: 2,
        compliant: 1,
        needsBaInput: 1,
        unverifiedCitations: 0,
      });

      const res = await decide(PA, ANA, card.id as string, {
        decision: "rejected",
        note: "Security says tokens, not digits.",
      });
      expect(res.status).toBe(200);
      const fresh = await getFindings(PA, ANA);
      expect(
        (fresh.body.data.findings as Array<Record<string, unknown>>).find((f) => f.id === card.id),
      ).toMatchObject({
        decision: "rejected",
        decisionNote: "Security says tokens, not digits.",
        decidedById: MEMBER_A,
        decidedAt: expect.any(String),
      });
      const rows = await db.auditLog.findMany({
        where: { targetType: "governing_finding", targetId: card.id as string },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorId: MEMBER_A, action: "governing.finding.decision" });
      expect(JSON.parse(rows[0]!.metadata!)).toMatchObject({
        analysisId: ANA,
        decision: "rejected",
        previousDecision: null,
      });
    });

    it("the decider is the session user, never the body: a body naming one is a 400 and changes nothing", async () => {
      const card = await produceAndReject();
      const before = await db.auditLog.count();
      const res = await decide(PA, ANA, card.id, {
        decision: "accepted",
        decidedById: MEMBER_B,
      });
      expect(res.status).toBe(400);
      expect(await db.auditLog.count()).toBe(before);
      const bad = await decide(PA, ANA, card.id, { decision: "approved" });
      expect(bad.status).toBe(400);
    });

    it("a member of another workspace's project gets 404 for both routes, through either path", async () => {
      const card = await produceAndReject();
      const before = await db.governingFinding.findUniqueOrThrow({ where: { id: card.id } });
      expect((await getFindings(PA, ANA, MEMBER_B, WS_B)).status).toBe(404);
      expect((await getFindings(PB, ANA, MEMBER_B, WS_B)).status).toBe(404);
      expect(
        (await decide(PA, ANA, card.id, { decision: "accepted" }, MEMBER_B, WS_B)).status,
      ).toBe(404);
      expect(
        (await decide(PB, ANA, card.id, { decision: "accepted" }, MEMBER_B, WS_B)).status,
      ).toBe(404);
      // B's OWN analysis path, with A's finding id: not found under B's analysis.
      expect(
        (await decide(PB, ANB, card.id, { decision: "accepted" }, MEMBER_B, WS_B)).status,
      ).toBe(404);
      expect(await db.governingFinding.findUniqueOrThrow({ where: { id: card.id } })).toEqual(
        before,
      );
      // And B's own analysis lists none of A's findings.
      const own = await getFindings(PB, ANB, MEMBER_B, WS_B);
      expect(own.status).toBe(200);
      expect(own.body.data.findings).toEqual([]);
    });

    it("after policy v2 changes the clause, findings produced against v1 still show v1's excerpt and label", async () => {
      await produceAndReject();
      await makeV2Current();
      const res = await getFindings(PA, ANA);
      const card = (res.body.data.findings as Array<Record<string, unknown>>).find(
        (f) => f.controlId === "EN-03",
      )!;
      expect(card).toMatchObject({
        revisionId: v1Id,
        revisionLabel: "v1",
        clauseExcerpt: "never stores a full payment card number in any system",
      });
      expect(String(card.clauseExcerpt)).not.toContain("vault token");
      // Re-producing against the SAME v1 rules keeps citing v1, not the current v2.
      await produceGoverningFindingsForAnalysis({
        analysisId: ANA,
        projectId: PA,
        provider: findingsModel(),
      });
      const again = await getFindings(PA, ANA);
      const audit = (again.body.data.findings as Array<Record<string, unknown>>).find(
        (f) => f.controlId === "AL-02",
      )!;
      expect(audit).toMatchObject({ revisionId: v1Id, revisionLabel: "v1" });
      // The card finding is unchanged, so the BA's decision on it stands.
      const card2 = (again.body.data.findings as Array<Record<string, unknown>>).find(
        (f) => f.controlId === "EN-03",
      )!;
      expect(card2).toMatchObject({ id: card.id, decision: "rejected", decidedById: MEMBER_A });
    });

    it("a re-produced finding that changed loses the decision made on the old one", async () => {
      await produceAndReject();
      const card = await db.governingFinding.findFirstOrThrow({
        where: { analysisId: ANA, controlId: "EN-03" },
      });
      expect(card.decision).toBe("rejected");
      // The model now finds a gap: a different finding from the one decided.
      const gapModel = {
        key: "anthropic",
        model: "stub",
        offline: false,
        chat: vi.fn(async (messages: ChatMessage[]) => {
          const user = messages.map((m) => String(m.content)).join("\n");
          const findings = [...user.matchAll(/^(R\d+) \[/gm)].map((m) => ({
            rule: m[1],
            status: "gap",
            reasoning: "It keeps the full number.",
            excerpt: "never stores a full payment card number in any system",
          }));
          return { content: JSON.stringify({ findings }), model: "m", provider: "anthropic" };
        }),
      } as unknown as AIProvider;
      await produceGoverningFindingsForAnalysis({
        analysisId: ANA,
        projectId: PA,
        provider: gapModel,
      });
      const after = await db.governingFinding.findUniqueOrThrow({ where: { id: card.id } });
      expect(after).toMatchObject({ status: "gap", decision: null, decidedById: null });
      // #2010 — A09: the erasure is in the audit trail beside the decision it
      // erased, read back from the database.
      const trail = await db.auditLog.findMany({
        where: { targetType: "governing_finding", targetId: card.id },
      });
      expect(trail.map((r) => r.action).sort()).toEqual([
        "governing.finding.decision",
        "governing.finding.decision-cleared",
      ]);
      const cleared = trail.find((r) => r.action === "governing.finding.decision-cleared")!;
      expect(cleared).toMatchObject({ actorId: null });
      expect(JSON.parse(cleared.metadata!)).toMatchObject({
        analysisId: ANA,
        previousDecision: "rejected",
        previousDecidedById: MEMBER_A,
        previousStatus: "compliant",
        status: "gap",
      });
    });

    it("flag off: both routes are 404", async () => {
      delete process.env.GOVERNING_DOCS_ENABLED;
      expect((await getFindings(PA, ANA)).status).toBe(404);
      expect((await decide(PA, ANA, "any", { decision: "accepted" })).status).toBe(404);
    });
  },
);
