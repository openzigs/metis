/**
 * #2222 — governing findings go stale when a requirement is edited, and
 * **Re-check this requirement** checks its current wording, over the REAL
 * router and a REAL SQLite database built by the migration chain.
 *
 * The analysis analysed one requirement, AC-2 (passwords of 8 characters),
 * and synthesis wrote two stored requirements from the code finding on it:
 * R1 (minimum length) and R2 (the reset page). That is the many-to-many join
 * the dev sample shows (`requirement-staleness.ts`).
 *
 *   - Fresh: no finding is stale.
 *   - A person edits R1 (12 → "15 characters, or 8 with MFA"): AC-2's finding
 *     is stale for R1 only, judged at v0, R1 now v1. A system version (kept
 *     criteria) on R2 does not make it stale.
 *   - POST …/recheck for R1: the applicability is decided on R1's CURRENT
 *     wording, its findings are stored under R1's own id with the version
 *     judged, AC-2's finding is no longer stale, and an AuditLog row names the
 *     user. A second edit of R1 makes both stale again.
 *   - A requirement of another analysis or project is 404 through this path;
 *     a member of another workspace gets 404; an unknown key is 400; no rules
 *     is 409; rules that cannot be read is 502 and nothing is stored; the flag
 *     off is 404.
 *
 * The applicability hook is stubbed (its screen and judge are tested in
 * `applicability.test.ts`); the findings run is the real one, on a stub model.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatOptions } from "../src/lib/ai/types.js";
import type { ApplicabilitySet } from "../src/lib/governing/applicability.js";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  return {
    db: null as unknown,
    provider: null as unknown,
    /** What the stubbed applicability hook does; null: no current rules. */
    decide: null as null | ((r: { id: string; text: string }) => Promise<unknown>),
    decided: [] as Array<{ id: string; text: string }>,
  };
});
vi.mock("../src/lib/prisma.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/prisma.js")>()),
  get prisma() {
    return state.db;
  },
}));
vi.mock("../src/lib/ai/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/ai/index.js")>()),
  buildProvider: () => state.provider,
}));
vi.mock("../src/lib/governing/applicability.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/governing/applicability.js")>()),
  governingApplicabilityHookFor: async () =>
    state.decide
      ? {
          decide: async (r: { id: string; text: string }) => {
            state.decided.push(r);
            return state.decide!(r);
          },
        }
      : null,
}));

const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { produceGoverningFindingsForAnalysis } =
  await import("../src/lib/governing/findings-store.js");
const { updateRequirementWithHistory } =
  await import("../src/lib/requirements/requirement-version-service.js");
const { getAnalysisSnapshot } = await import("../src/lib/analysis/analysis-service.js");

const WS_A = "ws-2222-a";
const WS_B = "ws-2222-b";
const PA = "proj-2222-a";
const PB = "proj-2222-b";
const MEMBER_A = "u-2222-a";
const MEMBER_B = "u-2222-b";
const ANA = "ana-2222-a";
const ANA_OTHER = "ana-2222-a2";
const ANB = "ana-2222-b";

const CLAUSE = "Passwords SHALL be at least 15 characters long unless MFA is enabled.";
const POLICY = `# Authentication Standard\n\n§5.1 ${CLAUSE}\n`;
const AC2 = "Raise the minimum password length from 6 to 8 characters.";

/** The findings model: PW-01 is a gap, quoting its clause. */
function findingsModel(): AIProvider {
  const chat = vi.fn(async (messages: ChatMessage[], _o: ChatOptions = {}) => {
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
  "#2222 — stale governing findings and Re-check this requirement (real router, real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let ruleId = "";
    let r1 = "";
    let r2 = "";
    let rOther = "";
    let rB = "";

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
    const getFindings = async (project = PA, analysis = ANA) => {
      const res = await request(app())
        .get(findingsPath(project, analysis))
        .set("Authorization", `Bearer ${token(MEMBER_A, WS_A)}`);
      expect(res.status).toBe(200);
      return res.body.data as {
        findings: Array<{
          id: string;
          requirementId: string;
          requirementVersions?: Record<string, number> | null;
          stale?: Array<{
            requirementId: string;
            title: string;
            judgedVersion: number;
            currentVersion: number;
          }>;
        }>;
        requirementTitles: Record<string, string>;
      };
    };
    const recheck = (body: unknown, project = PA, analysis = ANA, user = MEMBER_A, ws = WS_A) =>
      request(app())
        .post(`${findingsPath(project, analysis)}/recheck`)
        .set("Authorization", `Bearer ${token(user, ws)}`)
        .send(body as object);
    const personEdit = async (id: string, body: string) => {
      const row = await db.requirement.findUniqueOrThrow({ where: { id } });
      await updateRequirementWithHistory(db as never, {
        requirementId: id,
        patch: { body },
        expectedVersion: row.version,
        actorId: MEMBER_A,
      });
    };
    /** Applicability on any wording: PW-01 applies. */
    const applies = async (r: { id: string }): Promise<ApplicabilitySet> => ({
      requirementId: r.id,
      decisions: [
        {
          ruleId,
          controlId: "PW-01",
          verdict: "applies",
          reason: "It sets a password length.",
          foundBy: ["screen"],
        },
      ] as ApplicabilitySet["decisions"],
      rulesScreened: 1,
      screenBatches: 1,
      candidates: 1,
      reasked: 0,
      screenReasked: 0,
    });

    async function requirement(
      analysisId: string,
      projectId: string,
      title: string,
      labels: string[],
    ) {
      const row = await db.requirement.create({
        data: { analysisId, projectId, title, body: `${title}.`, labels: JSON.stringify(labels) },
      });
      return row.id;
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2222-governing-recheck");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const [ws, user, project] of [
        [WS_A, MEMBER_A, PA],
        [WS_B, MEMBER_B, PB],
      ] as const) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
        await db.user.create({
          data: {
            id: user,
            username: user,
            displayName: `Name of ${user}`,
            email: `${user}@example.test`,
          },
        });
        await db.workspaceMember.create({
          data: { workspaceId: ws, userId: user, role: "member" },
        });
        await db.project.create({
          data: { id: project, name: project, slug: project, createdById: user, workspaceId: ws },
        });
      }
      const doc = await db.governingDocument.create({
        data: { workspaceId: WS_A, title: "Authentication Standard", createdById: MEMBER_A },
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
          uploadedById: MEMBER_A,
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
      const applicability = {
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
      };
      for (const [id, project, user] of [
        [ANA, PA, MEMBER_A],
        [ANA_OTHER, PA, MEMBER_A],
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
      const agent = await db.agentResult.create({
        data: { analysisId: ANA, agentKey: "code", status: "completed" },
      });
      const code = await db.finding.create({
        data: {
          agentResultId: agent.id,
          category: "gap",
          title: "Raise minimum password length from 6 to 8",
          body: "b",
          evidence: JSON.stringify({ requirementId: "AC-2" }),
        },
      });
      r1 = await requirement(ANA, PA, "Minimum password length is 12 characters", [
        `finding:${code.id}`,
      ]);
      r2 = await requirement(ANA, PA, "Reset page states the password rules", [
        `finding:${code.id}`,
      ]);
      rOther = await requirement(ANA_OTHER, PA, "A requirement of another analysis", []);
      rB = await requirement(ANB, PB, "A requirement of another project", []);
      // R2 gets a SYSTEM version (kept approved criteria): the analysis's own writing.
      await updateRequirementWithHistory(db as never, {
        requirementId: r2,
        patch: { acceptanceCriteria: JSON.stringify(["The rules are listed."]) },
        expectedVersion: 0,
        actorId: null,
      });
      await produceGoverningFindingsForAnalysis({
        analysisId: ANA,
        projectId: PA,
        provider: findingsModel(),
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(() => {
      process.env.GOVERNING_DOCS_ENABLED = "1";
      state.provider = findingsModel();
      state.decide = applies;
      state.decided = [];
    });
    afterEach(() => {
      delete process.env.GOVERNING_DOCS_ENABLED;
    });
    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    // The tests below run in order: each builds on the edits before it.

    it("fresh: the analysed finding judges every requirement drawn from it at its analysed version", async () => {
      const data = await getFindings();
      expect(data.findings).toHaveLength(1);
      expect(data.findings[0]).toMatchObject({ requirementId: "AC-2", requirementVersions: null });
      expect(data.findings[0]!.stale).toEqual([]);
      expect(data.requirementTitles).toEqual({});
    });

    it("a person's edit of R1 marks AC-2's finding stale for R1 only", async () => {
      await personEdit(r1, "Passwords are at least 15 characters, or 8 with MFA.");
      const data = await getFindings();
      expect(data.findings[0]!.stale).toEqual([
        {
          requirementId: r1,
          title: "Minimum password length is 12 characters",
          judgedVersion: 0,
          currentVersion: 1,
        },
      ]);
    });

    it("the analysis snapshot carries each requirement's analysed version, so its findings read stale", async () => {
      const snapshot = await getAnalysisSnapshot(ANA);
      const byId = new Map(snapshot!.requirements.map((r) => [r.id, r]));
      // R1: a person's v1 — analysed at v0. R2: v1 is the system's own — analysed at v1.
      expect(byId.get(r1)).toMatchObject({ version: 1, analysedVersion: 0 });
      expect(byId.get(r2)).toMatchObject({ version: 1, analysedVersion: 1 });
    });

    it("rejects a body naming anything but the requirement (400), and a requirement of another analysis or project (404)", async () => {
      expect((await recheck({ requirementId: r1, actorId: MEMBER_B })).status).toBe(400);
      expect((await recheck({})).status).toBe(400);
      expect((await recheck({ requirementId: rOther })).status).toBe(404);
      expect((await recheck({ requirementId: rB })).status).toBe(404);
      // Another workspace's member, through either path.
      expect((await recheck({ requirementId: r1 }, PA, ANA, MEMBER_B, WS_B)).status).toBe(404);
      expect((await recheck({ requirementId: r1 }, PB, ANA, MEMBER_B, WS_B)).status).toBe(404);
      expect(state.decided).toEqual([]);
    });

    it("409 with no current rules; 502 and nothing stored when the rules cannot be read", async () => {
      state.decide = null;
      const none = await recheck({ requirementId: r1 });
      expect(none.status).toBe(409);
      expect(none.body.error.code).toBe("NO_GOVERNING_RULES");

      state.decide = async (r) => ({
        requirementId: r.id,
        decisions: [],
        rulesScreened: 0,
        screenBatches: 0,
        candidates: 0,
        reasked: 0,
        screenReasked: 0,
        error: "Governing rules could not be loaded for this analysis, so no rule was checked.",
      });
      const failed = await recheck({ requirementId: r1 });
      expect(failed.status).toBe(502);
      const data = await getFindings();
      expect(data.findings.map((f) => f.requirementId)).toEqual(["AC-2"]);
      expect(data.findings[0]!.stale).toHaveLength(1);
    });

    it("502 and nothing stored when the requirement cannot be evaluated", async () => {
      const broken = findingsModel();
      vi.mocked(broken.chat).mockRejectedValue(new Error("provider down"));
      state.provider = broken;
      const res = await recheck({ requirementId: r2 });
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe("GOVERNING_RECHECK_FAILED");
      const data = await getFindings();
      expect(data.findings.map((f) => f.requirementId)).toEqual(["AC-2"]);
      const stored = JSON.parse(
        (await db.analysis.findUniqueOrThrow({ where: { id: ANA } })).metadata!,
      ) as { governingApplicability: { requirements: Array<{ requirementId: string }> } };
      expect(stored.governingApplicability.requirements.map((r) => r.requirementId)).toEqual([
        "AC-2",
      ]);
    });

    it("404 while the flag is off", async () => {
      process.env.GOVERNING_DOCS_ENABLED = "0";
      expect((await recheck({ requirementId: r1 })).status).toBe(404);
    });

    it("Re-check R1: checks its current wording only, stores its findings at v1, clears the stale marker, audits the user", async () => {
      const res = await recheck({ requirementId: r1 });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ requirementId: r1, version: 1, findings: 1 });
      expect(state.decided).toEqual([
        {
          id: r1,
          text: "Minimum password length is 12 characters\n\nPasswords are at least 15 characters, or 8 with MFA.",
        },
      ]);

      const data = await getFindings();
      const own = data.findings.find((f) => f.requirementId === r1);
      const analysed = data.findings.find((f) => f.requirementId === "AC-2");
      expect(own).toMatchObject({ requirementVersions: { [r1]: 1 }, stale: [] });
      expect(analysed!.stale).toEqual([]);
      expect(data.requirementTitles).toEqual({ [r1]: "Minimum password length is 12 characters" });

      const stored = JSON.parse(
        (await db.analysis.findUniqueOrThrow({ where: { id: ANA } })).metadata!,
      ) as { governingApplicability: { requirements: Array<Record<string, unknown>> } };
      const entry = stored.governingApplicability.requirements.find((r) => r.requirementId === r1);
      expect(entry).toMatchObject({ versions: { [r1]: 1 } });
      // AC-2's entry is untouched.
      expect(
        stored.governingApplicability.requirements.find((r) => r.requirementId === "AC-2"),
      ).toMatchObject({ text: AC2 });

      const audit = await db.auditLog.findFirst({
        where: { action: "governing.requirement.recheck", targetId: r1 },
      });
      expect(audit?.actorId).toBe(MEMBER_A);
      expect(JSON.parse(audit!.metadata!)).toMatchObject({ analysisId: ANA, version: 1 });
    });

    it("another edit of R1 makes its own result and AC-2's stale again", async () => {
      await personEdit(r1, "Passwords are at least 15 characters.");
      const data = await getFindings();
      const own = data.findings.find((f) => f.requirementId === r1);
      const analysed = data.findings.find((f) => f.requirementId === "AC-2");
      expect(own!.stale).toEqual([
        expect.objectContaining({ judgedVersion: 1, currentVersion: 2 }),
      ]);
      expect(analysed!.stale).toEqual([
        expect.objectContaining({ requirementId: r1, judgedVersion: 0, currentVersion: 2 }),
      ]);
    });
  },
);
