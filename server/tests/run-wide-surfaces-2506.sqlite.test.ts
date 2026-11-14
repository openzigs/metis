/**
 * #2506 (epic #2438) — what a document pass of a `starter` run writes on the
 * run as a whole is shown only to a reader who can see the run as a whole
 * (`canSeeRun`), on every surface, over a REAL SQLite database built by the
 * migration chain and (where the surface is a route) the REAL router with
 * real JWTs.
 *
 * Fixture: one project, two documents (`doc-brief-2506`, open, and
 * `doc-memo-2506`, restricted to Alice). Run `ALICE_RUN` was started by Alice
 * and its document pass read the memo with her access (its read set records
 * it, as `starter-document-access-2506` proves the orchestrator writes). Run
 * `BOB_RUN` was started by Bob and read nothing restricted. Each holds the
 * same run-wide records, each with `SECRET` in its text on Alice's run: the
 * reviewed list, web research, governing applicability and findings,
 * escalation, elicited NFRs, a requirements-left-out excerpt and a
 * clarification dialog. Readers:
 *   - Alice, on the memo's access list, and Root, an admin: see everything;
 *   - Bob: sees none of Alice's run's run-wide text, and all of his own.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import {
  getPermissionsForRole,
  RESTRICTED_SOURCE_BODY,
  type AuthPayload,
  type RoleKey,
} from "@metis/shared";
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
  process.env.GOVERNING_DOCS_ENABLED = "true";
  return { db: null as unknown };
});
vi.mock("../src/lib/prisma.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/prisma.js")>("../src/lib/prisma.js");
  return {
    ...actual,
    get prisma() {
      return state.db;
    },
    resolveDatabaseProvider: () => "sqlite" as const,
  };
});
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: vi.fn(),
}));
vi.mock("../src/lib/socket/registry.js", () => ({ getSocketServer: () => null }));
// Only who reaches the re-check is in question here; its own suite runs it.
const recheckSpy = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/governing/recheck.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/governing/recheck.js")>()),
  recheckGoverningRequirement: recheckSpy,
}));

const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { getLatestWebResearch } = await import("../src/lib/analysis/analysis-service.js");
const { createGetGoverningFindingsTool } =
  await import("../src/lib/analysis/results-chat-tools.js");
const { loadGoverningSection } = await import("../src/lib/docs-gen/governing-section.js");
const { persistClarificationKnowledge } =
  await import("../src/lib/clarifications/analysis-clarifications.js");

const WS = "ws-2506";
const P = "proj-2506-x";
const ALICE_RUN = "run-2506-alice";
const BOB_RUN = "run-2506-bob";
const BRIEF = "doc-brief-2506";
const MEMO = "doc-memo-2506";
const SECRET = "MERGER_2506 closes in March";

type Who = "alice" | "bob" | "root";
const ROLES: Record<Who, RoleKey> = { alice: "coordinator", bob: "coordinator", root: "admin" };
const sources = (documentIds: string[]) => JSON.stringify({ documentIds, chunkIds: [] });

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2506 — run-wide records of a starter run are shown only to who can see the run (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const payload = (who: Who): AuthPayload => ({
      userId: who,
      username: who,
      role: ROLES[who],
      permissions: getPermissionsForRole(ROLES[who]),
      workspaces: [WS],
    });
    const bearer = (who: Who) => `Bearer ${issueTokens(payload(who)).accessToken}`;
    const app = () => {
      const a = express();
      a.use(express.json());
      const analysis = initAnalysisRouter();
      a.use("/api/projects/:projectId/analyses", analysis.projectScoped);
      a.use("/api/analyses", analysis.topLevel);
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const get = (who: Who, path: string) =>
      request(app()).get(path).set("Authorization", bearer(who));
    const post = (who: Who, path: string, body: unknown = {}) =>
      request(app())
        .post(path)
        .set("Authorization", bearer(who))
        .send(body as object);
    const text = (run: string) => (run === ALICE_RUN ? SECRET : "Invoices are issued monthly");

    /** One run with every run-wide record, its text `text(run)`. */
    const seedRun = async (id: string, startedById: Who, read: string[], createdAt: Date) => {
      const t = text(id);
      await db.analysis.create({
        data: {
          id,
          projectId: P,
          startedById,
          status: "completed",
          completedAt: new Date(),
          createdAt,
          title: id,
          sourceAccess: "starter",
          metadata: JSON.stringify({
            agentKeys: ["document", "code"],
            documentIds: [],
            enhancement: { enableWebResearch: true, enableClarification: true },
            structuredRequirements: {
              requirements: [
                {
                  id: "REQ-1",
                  title: t,
                  description: `${t} — description`,
                  type: "functional",
                  stakeholders: [],
                  priority: "must",
                  ambiguities: [],
                  evidenceNeeds: [],
                  rawSource: t,
                },
              ],
              totalAmbiguities: 0,
              totalEvidenceNeeds: 0,
            },
            structuredRunId: `${id}-x`,
            webResearch: {
              digests: [{ id: `${id}-d1`, requirementId: "REQ-1", query: t, summary: t }],
              totalSources: 1,
              reviewRequired: 0,
            },
            governingApplicability: {
              decidedAt: new Date().toISOString(),
              requirements: [{ requirementId: "REQ-1", text: t, decisions: [] }],
            },
            escalation: {
              enabled: true,
              threshold: 1,
              maxEscalations: 1,
              requirements: [{ requirementId: "REQ-1", text: t, score: 2, depth: "deep" }],
            },
            elicitedNfrsAwaitingPromotion: [{ id: "NFR-1", title: t }],
            synthesisDegraded: {
              reason: "unparseable",
              detail: t,
              attempts: 1,
              requirementCount: 0,
            },
            capability: {
              requirementsLeftOut: [
                {
                  stage: "requirement-grounded-code",
                  analysedCount: 1,
                  totalCount: 2,
                  leftOut: [{ id: "REQ-2", excerpt: t }],
                },
              ],
              reasons: [],
            },
          }),
        },
      });
      // The document pass, with the read set it recorded, and a finding.
      await db.agentResult.create({
        data: {
          analysisId: id,
          agentKey: "document",
          status: "completed",
          readSourceIds: sources(read),
          output: JSON.stringify({ summary: `Read ${t}`, notes: [] }),
          findings: {
            create: [
              {
                id: `${id}-f1`,
                category: "requirement",
                severity: "info",
                title: t,
                body: t,
                evidence: JSON.stringify({ citations: [] }),
                sourceIds: sources([BRIEF, ...read]),
              },
            ],
          },
        },
      });
      await db.governingFinding.create({
        data: {
          id: `${id}-gf1`,
          analysisId: id,
          requirementId: "REQ-1",
          ruleId: "rule-2506-0001",
          revisionId: "rev-2506-0001",
          revisionLabel: "v1",
          documentTitle: "Retention policy",
          controlId: "RET-1",
          clauseRef: "1.1",
          status: "needs-ba-input",
          reasoning: `${t} has no retention period`,
          businessQuestion: `How long is ${t} kept?`,
          decision: "accepted",
          decisionNote: `Noted: ${t}`,
        },
      });
      await db.clarificationDialogState.create({
        data: {
          analysisId: id,
          state: JSON.stringify({
            analysisId: id,
            status: "awaiting_answers",
            rounds: [
              {
                round: 1,
                questions: [
                  {
                    id: "q1",
                    requirementId: "REQ-1",
                    requirementTitle: t,
                    ambiguityField: "scope",
                    question: `What does ${t} cover?`,
                    answer: "All of it",
                  },
                ],
                answers: [],
              },
            ],
            answeredAmbiguities: [],
            resolvedAmbiguities: [],
          }),
        },
      });
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2506-run-wide-surfaces");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.workspace.create({ data: { id: WS, name: "w", slug: WS } });
      for (const key of ["coordinator", "admin"] as const) {
        await db.role.create({ data: { id: `role-${key}`, key, name: key } });
      }
      for (const who of Object.keys(ROLES) as Who[]) {
        await db.user.create({
          data: { id: who, username: who, displayName: who, email: `${who}@example.test` },
        });
        await db.userRole.create({ data: { userId: who, roleId: `role-${ROLES[who]}` } });
        await db.workspaceMember.create({ data: { workspaceId: WS, userId: who, role: "member" } });
      }
      await db.project.create({
        data: { id: P, name: P, slug: P, createdById: "alice", workspaceId: WS, status: "active" },
      });
      for (const [id, aclSubjects] of [
        [BRIEF, "[]"],
        [MEMO, JSON.stringify([{ kind: "user", value: "alice" }])],
      ] as const) {
        await db.document.create({
          data: {
            id,
            projectId: P,
            filename: `${id}.md`,
            mimeType: "text/markdown",
            sizeBytes: 1,
            storagePath: `/tmp/${id}`,
            checksum: id,
            uploadedById: "alice",
            status: "ready",
            aclSubjects,
          },
        });
      }
      // Bob's run is the older one, so the docs-gen read must pass over Alice's.
      await seedRun(BOB_RUN, "bob", [], new Date("2026-01-01T00:00:00Z"));
      await seedRun(ALICE_RUN, "alice", [MEMO], new Date("2026-02-01T00:00:00Z"));
      await db.requirement.create({
        data: {
          id: "req-2506-alice",
          analysisId: ALICE_RUN,
          projectId: P,
          title: "Rests on the run",
          body: "b",
          labels: "[]",
          sourceIds: null,
        },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      recheckSpy.mockReset();
      recheckSpy.mockImplementation(async () => ({
        ok: true,
        result: { requirementId: "req-2506-alice", version: 1, findings: 0 },
      }));
    });

    describe("the result page (GET /api/analyses/:id)", () => {
      it("shows Bob none of Alice's run-wide text, and keeps what the person who started it chose", async () => {
        const res = await get("bob", `/api/analyses/${ALICE_RUN}`);
        expect(res.status).toBe(200);
        const body = JSON.stringify(res.body);
        expect(body).not.toContain("MERGER");
        const snapshot = res.body.data;
        expect(snapshot.escalation).toBeNull();
        for (const key of [
          "webResearch",
          "governingApplicability",
          "escalation",
          "elicitedNfrsAwaitingPromotion",
          "synthesisDegraded",
        ]) {
          expect(snapshot.metadata, key).not.toHaveProperty(key);
        }
        // What the starter chose, and the flags the page reads, stay.
        expect(snapshot.metadata.agentKeys).toEqual(["document", "code"]);
        expect(snapshot.metadata.enhancement).toEqual({
          enableWebResearch: true,
          enableClarification: true,
        });
        // The reviewed list keeps its entries, as placeholders.
        expect(snapshot.metadata.structuredRequirements.requirements[0].restricted).toBe(true);
        // A stage's left-out requirement keeps its id, not its text.
        expect(snapshot.capability.requirementsLeftOut[0].leftOut[0]).toEqual({
          id: "REQ-2",
          excerpt: "",
        });
      });

      it("shows Alice and an admin everything, and Bob all of his own run", async () => {
        for (const who of ["alice", "root"] as const) {
          const snapshot = (await get(who, `/api/analyses/${ALICE_RUN}`)).body.data;
          expect(snapshot.metadata.webResearch.digests[0].summary, who).toBe(SECRET);
          expect(snapshot.metadata.governingApplicability.requirements[0].text, who).toBe(SECRET);
          expect(snapshot.escalation.requirements[0].text, who).toBe(SECRET);
          expect(snapshot.capability.requirementsLeftOut[0].leftOut[0].excerpt, who).toBe(SECRET);
        }
        const bob = (await get("bob", `/api/analyses/${BOB_RUN}`)).body.data;
        expect(bob.metadata.webResearch.digests[0].summary).toBe(text(BOB_RUN));
        expect(bob.escalation.requirements[0].text).toBe(text(BOB_RUN));
        expect(bob.metadata.elicitedNfrsAwaitingPromotion).toHaveLength(1);
      });
    });

    describe("governing applicability and findings", () => {
      const path = (run: string, rest: string) => `/api/projects/${P}/analyses/${run}/${rest}`;

      it("the applicability is none for Bob, and Alice's for her and an admin", async () => {
        const bob = await get("bob", path(ALICE_RUN, "governing-applicability"));
        expect(bob.status).toBe(200);
        expect(bob.body.data).toEqual({ applicability: null });
        for (const who of ["alice", "root"] as const) {
          const res = await get(who, path(ALICE_RUN, "governing-applicability"));
          expect(res.body.data.applicability.requirements[0].text, who).toBe(SECRET);
        }
        const own = await get("bob", path(BOB_RUN, "governing-applicability"));
        expect(own.body.data.applicability.requirements[0].text).toBe(text(BOB_RUN));
      });

      it("the findings are placeholders for Bob, statuses and counts kept", async () => {
        const bob = await get("bob", path(ALICE_RUN, "governing-findings"));
        expect(bob.status).toBe(200);
        expect(JSON.stringify(bob.body)).not.toContain("MERGER");
        const [finding] = bob.body.data.findings;
        expect(finding).toMatchObject({
          id: `${ALICE_RUN}-gf1`,
          status: "needs-ba-input",
          controlId: "RET-1",
          decision: "accepted",
          reasoning: RESTRICTED_SOURCE_BODY,
          businessQuestion: null,
          decisionNote: null,
        });
        expect(bob.body.data.summary).toEqual(
          (await get("alice", path(ALICE_RUN, "governing-findings"))).body.data.summary,
        );
        const alice = await get("alice", path(ALICE_RUN, "governing-findings"));
        expect(alice.body.data.findings[0].reasoning).toContain(SECRET);
        expect(alice.body.data.findings[0].businessQuestion).toContain(SECRET);
        const own = await get("bob", path(BOB_RUN, "governing-findings"));
        expect(own.body.data.findings[0].reasoning).toContain(text(BOB_RUN));
      });

      it("a decision on one answers Bob as for an unknown finding", async () => {
        const decide = (who: Who, run: string) =>
          post(who, path(run, `governing-findings/${run}-gf1/decision`), { decision: "rejected" });
        const bob = await decide("bob", ALICE_RUN);
        const unknown = await post(
          "bob",
          path(BOB_RUN, "governing-findings/no-such-finding-2506/decision"),
          { decision: "rejected" },
        );
        expect(bob.status).toBe(404);
        expect(bob.body.error.code).toBe(unknown.body.error.code);
        expect(JSON.stringify(bob.body)).not.toContain("MERGER");
        // Nothing was written.
        const row = await db.governingFinding.findUniqueOrThrow({
          where: { id: `${ALICE_RUN}-gf1` },
        });
        expect(row.decision).toBe("accepted");
        expect((await decide("bob", BOB_RUN)).status).toBe(200);
        expect((await decide("alice", ALICE_RUN)).status).toBe(200);
      });

      it("a re-check is refused to Bob before it judges anything, and runs for Alice", async () => {
        const recheck = (who: Who, run: string) =>
          post(who, path(run, "governing-findings/recheck"), { requirementId: "req-2506-alice" });
        const bob = await recheck("bob", ALICE_RUN);
        expect(bob.status).toBe(404);
        expect(bob.body.error.code).toBe("NOT_FOUND");
        expect(recheckSpy).not.toHaveBeenCalled();
        expect((await recheck("alice", ALICE_RUN)).status).toBe(200);
        expect(recheckSpy).toHaveBeenCalledTimes(1);
        expect((await recheck("bob", BOB_RUN)).status).toBe(200);
      });

      it("the chat tool hands Bob the placeholders and no requirement text", async () => {
        const tool = createGetGoverningFindingsTool({
          resolveRole: async (id) => ROLES[id as Who],
        });
        const run = (who: Who, analysisId: string) =>
          tool.exec({ analysisId }, { userId: who, projectId: P } as never);
        const bob = await run("bob", ALICE_RUN);
        expect(bob.isError).toBeFalsy();
        expect(bob.text).not.toContain("MERGER");
        expect(bob.text).toContain("RET-1");
        expect((await run("alice", ALICE_RUN)).text).toContain(SECRET);
        expect((await run("bob", BOB_RUN)).text).toContain(text(BOB_RUN));
      });

      it("a generated document's governing section shows the project the placeholders", async () => {
        const section = await loadGoverningSection(P, [
          { id: "req-2506-alice", analysisId: ALICE_RUN, labels: "[]" },
        ]);
        const run = section!.runs[0]!;
        expect(run.findings[0]!.reasoning).toBe(RESTRICTED_SOURCE_BODY);
        expect(run.requirementText.size).toBe(0);
        expect(JSON.stringify(run.findings)).not.toContain("MERGER");
      });
    });

    describe("the clarification dialog", () => {
      const path = (run: string, rest: string) => `/api/projects/${P}/analyses/${run}/${rest}`;

      it("starting or answering a round answers Bob as for no dialog", async () => {
        const bob = await post("bob", path(ALICE_RUN, "clarify"), {});
        expect(bob.status).toBe(404);
        expect(bob.body.error.code).toBe("NO_DIALOG");
        expect(JSON.stringify(bob.body)).not.toContain("MERGER");
        // Alice reaches the dialog itself (whatever it then answers offline).
        const alice = await post("alice", path(ALICE_RUN, "clarify"), {});
        expect(alice.body.error?.code).not.toBe("NO_DIALOG");
      });

      it("an imported answer sheet answers Bob as for no dialog, and Alice is matched", async () => {
        const csv =
          "questionId,requirement,ambiguityField,question,suggestedAnswer,answer\nq-nope,r,f,q,,a\n";
        const upload = (who: Who, run: string) =>
          request(app())
            .post(path(run, "clarify/import"))
            .set("Authorization", bearer(who))
            .attach("file", Buffer.from(csv), { filename: "a.csv", contentType: "text/csv" });
        const bob = await upload("bob", ALICE_RUN);
        expect(bob.status).toBe(404);
        expect(bob.body.error.code).toBe("NO_DIALOG");
        const alice = await upload("alice", ALICE_RUN);
        expect(alice.status).toBe(200);
        expect(alice.body.data).toMatchObject({ applied: 0, unmatched: ["q-nope"] });
        expect((await upload("bob", BOB_RUN)).status).toBe(200);
      });

      it("answers on a run that read a restricted source are kept, but not indexed for the project", async () => {
        const index = vi.fn(async () => "doc-x");
        const withdraw = vi.fn(async () => false);
        const rerun = vi.fn(async () => undefined);
        const keep = (analysisId: string) =>
          persistClarificationKnowledge(
            {
              projectId: P,
              analysisId,
              answeredById: analysisId === ALICE_RUN ? "alice" : "bob",
              provider: { key: "stub", model: "stub", offline: true } as never,
            },
            { index, withdraw, rerun } as never,
          );
        const alice = await keep(ALICE_RUN);
        expect(alice).toHaveLength(1);
        expect(alice[0]!.question).toContain(SECRET);
        expect(index).not.toHaveBeenCalled();
        expect(withdraw).toHaveBeenCalledTimes(1);
        // Positive control: a run that read nothing restricted indexes its answers.
        const bob = await keep(BOB_RUN);
        expect(bob).toHaveLength(1);
        expect(index).toHaveBeenCalledTimes(1);
        expect(withdraw).toHaveBeenCalledTimes(1);
      });
    });

    describe("web research for a generated document", () => {
      it("passes over the research of a run the project cannot see as a whole", async () => {
        const research = await getLatestWebResearch(P);
        expect(research?.digests[0]).toMatchObject({ summary: text(BOB_RUN) });
      });

      it("uses it once the project can see the run (the memo no longer restricted)", async () => {
        await db.document.update({ where: { id: MEMO }, data: { aclSubjects: "[]" } });
        try {
          const research = await getLatestWebResearch(P);
          expect(research?.digests[0]).toMatchObject({ summary: SECRET });
        } finally {
          await db.document.update({
            where: { id: MEMO },
            data: { aclSubjects: JSON.stringify([{ kind: "user", value: "alice" }]) },
          });
        }
      });
    });
  },
);
