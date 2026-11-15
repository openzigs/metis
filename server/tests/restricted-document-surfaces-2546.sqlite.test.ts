/**
 * #2546 — a document restricted to Alice reaches Bob, a project member its
 * access list does not name, through none of the surfaces the 2026-11-15
 * walkthrough found it on, nor the ones the sweep found beside them. A REAL
 * SQLite database built by the migration chain, the REAL routers and real JWTs.
 *
 * Fixture: one project with an open brief and `PAYROLL`, restricted to Alice.
 * Alice's change request was started from the payroll document (its title was
 * generated from its name, and its document pass wrote `SECRET` into the run's
 * metadata); one of its requirements rests on the document and a discussion is
 * about it; a portfolio check and an impact analysis were started from it.
 *   - L1: Bob cannot start a portfolio check (or an impact analysis) from it,
 *     and reads none of the document's words in the ones Alice started;
 *   - L2: the analyses list sends no raw metadata, and names no document Bob
 *     cannot see (nor does its title, nor the snapshot, nor a chat subject);
 *   - L3: the discussion list names the requirement as "Restricted";
 *   - the documents list marks the document restricted, without its name.
 * Alice, on the list, and Root, an admin, see everything.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import {
  getPermissionsForRole,
  RESTRICTED_SOURCE_BODY,
  RESTRICTED_SOURCE_TITLE,
  type AuthPayload,
  type RoleKey,
} from "@metis/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.PORTFOLIO_ASSESSMENT_START_RATE_LIMIT_MAX = "1000";
  process.env.AI_OFFLINE = "1";
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

const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { documentsRouter } = await import("../src/routes/documents.js");
const { discussionsRouter } = await import("../src/routes/discussions.js");
const { portfolioAssessmentsRouter } = await import("../src/routes/portfolio-assessments.js");
const { impactAnalysisRouter } = await import("../src/routes/impact-analysis.js");
const { projectRequirementsRouter } = await import("../src/routes/project-requirements.js");
const { projectsRouter } = await import("../src/routes/projects.js");
const { audit } = await import("../src/lib/audit/audit-service.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { resolveChatSubject, chatSubjectContextBlock } =
  await import("../src/lib/ai/chat-subject.js");
const { listReviews } = await import("../src/lib/reviews/review-service.js");
const { attachChangeRequests } = await import("../src/lib/reviews/review-change-requests.js");
const { userSourceReader } = await import("../src/lib/analysis/source-redaction.js");

const WS = "ws-2546";
const P = "proj-2546-x"; // ids are at least 10 characters (`idSchema`)
const PRODUCT = "prod-2546";
const BRIEF = "doc-brief-2546";
const PAYROLL = "doc-payroll-2546";
const PAYROLL_NAME = "payroll-2546.docx";
const RUN = "run-2546-alice";
const REQ = "req-2546-payroll";
const THREAD = "thread-2546";
const CHECK = "check-2546";
const IMPACT = "impact-2546";
/** #2546 review — a requirement of the run Bob CAN see, from the open brief. */
const REQ_OPEN = "req-2546-brief";
/** A portfolio check and an impact analysis started from Alice's change request. */
const CHECK_CR = "check-2546-cr";
const IMPACT_CR = "impact-2546-cr";
/** Bob's name for Alice's change request: its generated title, made without the document. */
const BOB_TITLE = "Change request of 2026-11-01";
const SECRET = "SALARY_2546 rises by 40%";
/** Nothing of the restricted document: neither its words nor its name. */
const LEAKS = /SALARY_2546|payroll-2546\.docx/i;

type Who = "alice" | "bob" | "root";
const ROLES: Record<Who, RoleKey> = { alice: "coordinator", bob: "coordinator", root: "admin" };
const sources = (documentIds: string[]) => JSON.stringify({ documentIds, chunkIds: [] });

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2546 — a restricted document's text and name reach no reader its access list leaves out (real SQLite)",
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
      a.use("/api/projects/:projectId/documents", documentsRouter({ ingestQueue: null }));
      a.use("/api/discussions", discussionsRouter());
      a.use(
        "/api/portfolio-assessments",
        portfolioAssessmentsRouter({
          gap: {
            // No model in this suite: a started check fails, which is all we need.
            get provider(): never {
              throw new Error("no model in this suite");
            },
          },
        }),
      );
      a.use("/api/impact-analyses", impactAnalysisRouter());
      a.use("/api/projects/:projectId/requirements", projectRequirementsRouter());
      a.use("/api/projects", projectsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const get = (who: Who, path: string) =>
      request(app()).get(path).set("Authorization", bearer(who));
    const post = (who: Who, path: string, body: object) =>
      request(app()).post(path).set("Authorization", bearer(who)).send(body);
    const patch = (who: Who, path: string, body: object) =>
      request(app()).patch(path).set("Authorization", bearer(who)).send(body);

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2546-restricted-document-surfaces");
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
      await db.product.create({
        data: { id: PRODUCT, name: "Billing", slug: PRODUCT, createdById: "alice" },
      });
      for (const [id, filename, aclSubjects] of [
        [BRIEF, "brief-2546.md", "[]"],
        [PAYROLL, PAYROLL_NAME, JSON.stringify([{ kind: "user", value: "alice" }])],
      ] as const) {
        await db.document.create({
          data: {
            id,
            projectId: P,
            filename,
            mimeType: "text/markdown",
            sizeBytes: 2048,
            storagePath: `/tmp/${filename}`,
            checksum: `sha-${id}`,
            uploadedById: "alice",
            status: "ready",
            chunkCount: 3,
            aclSubjects,
          },
        });
      }
      // Alice's change request, started from the payroll document: its title
      // generated from the document's name, its metadata written by a pass that
      // read the document with her access.
      await db.analysis.create({
        data: {
          id: RUN,
          projectId: P,
          startedById: "alice",
          status: "completed",
          completedAt: new Date(),
          startedAt: new Date("2026-11-01T09:00:00Z"),
          title: PAYROLL_NAME,
          titleGenerated: true,
          sourceAccess: "starter",
          metadata: JSON.stringify({
            agentKeys: ["document"],
            documentIds: [PAYROLL],
            webResearch: {
              digests: [{ id: "d1", requirementId: "REQ-1", query: SECRET, summary: SECRET }],
              totalSources: 1,
              reviewRequired: 0,
            },
            checkpointApprovedCriteria: { "REQ-1": [SECRET] },
          }),
        },
      });
      await db.agentResult.create({
        data: {
          analysisId: RUN,
          agentKey: "document",
          status: "completed",
          readSourceIds: sources([PAYROLL]),
          output: JSON.stringify({ summary: SECRET, notes: [] }),
        },
      });
      await db.requirement.create({
        data: {
          id: REQ,
          analysisId: RUN,
          projectId: P,
          title: SECRET,
          body: SECRET,
          labels: "[]",
          sourceIds: sources([PAYROLL]),
        },
      });
      await db.requirement.create({
        data: {
          id: REQ_OPEN,
          analysisId: RUN,
          projectId: P,
          title: "Brief requirement",
          body: "From the open brief",
          labels: "[]",
          sourceIds: sources([BRIEF]),
        },
      });
      // A portfolio check started from the change request: its statement quotes
      // the run's name as Alice saw it when she started it.
      await db.portfolioAssessment.create({
        data: {
          id: CHECK_CR,
          statement: `Requirements of change request "${PAYROLL_NAME}"`,
          scope: "product",
          productIds: JSON.stringify([PRODUCT]),
          status: "completed",
          portfolioVerdict: "partial",
          summary: "s",
          sourceAnalysisId: RUN,
          sourceProjectId: P,
          notChecked: "[]",
          createdById: "alice",
          products: {
            create: [
              {
                productId: PRODUCT,
                coverage: "partial",
                technicalDetail: JSON.stringify({
                  criteria: [
                    { criterion: "Brief requirement: From the open brief", coveredBy: [] },
                  ],
                }),
              },
            ],
          },
        },
      });
      await db.impactAnalysis.create({
        data: {
          id: IMPACT_CR,
          status: "completed",
          sourceAnalysisId: RUN,
          sourceText: "Brief requirement",
          startedById: "alice",
          completedAt: new Date(),
          projects: { create: [{ projectId: P }] },
        },
      });
      await db.discussionThread.create({
        data: { id: THREAD, projectId: P, requirementId: REQ, createdById: "alice", title: "t" },
      });
      // A portfolio check Alice started from the document, as its run stored it.
      await db.portfolioAssessment.create({
        data: {
          id: CHECK,
          statement: `Requirements read from "${PAYROLL_NAME}"`,
          scope: "product",
          productIds: JSON.stringify([PRODUCT]),
          status: "completed",
          portfolioVerdict: "partial",
          summary: `${SECRET} needs the billing service`,
          sourceDocumentId: PAYROLL,
          sourceProjectId: P,
          notChecked: JSON.stringify([
            { text: SECRET, reason: "over-limit", count: null, detail: null },
          ]),
          createdById: "alice",
          products: {
            create: [
              {
                productId: PRODUCT,
                coverage: "partial",
                technicalDetail: JSON.stringify({
                  criteria: [{ criterion: SECRET, coveredBy: [] }],
                }),
              },
            ],
          },
        },
      });
      // An impact analysis Alice started from it.
      await db.impactAnalysis.create({
        data: {
          id: IMPACT,
          status: "completed",
          documentId: PAYROLL,
          sourceText: SECRET,
          summary: SECRET,
          startedById: "alice",
          completedAt: new Date(),
          projects: { create: [{ projectId: P }] },
          items: {
            create: [{ projectId: P, requirementTitle: SECRET, summary: SECRET }],
          },
        },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    describe("the documents list", () => {
      it("shows Bob the restricted document marked restricted, without its name or path", async () => {
        const res = await get("bob", `/api/projects/${P}/documents`);
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toMatch(LEAKS);
        const rows = res.body.data.items as Array<Record<string, unknown>>;
        expect(rows).toHaveLength(2);
        expect(res.body.data.total).toBe(2);
        const payroll = rows.find((r) => r.id === PAYROLL)!;
        expect(payroll).toMatchObject({
          filename: RESTRICTED_SOURCE_TITLE,
          title: null,
          restricted: true,
          // Counts stay (#2437).
          sizeBytes: 2048,
          chunkCount: 3,
          status: "ready",
        });
        // #2546 review — an allowlist: who may read it, its path and its
        // uploader are not sent to a reader it leaves out.
        for (const key of ["aclSubjects", "storagePath", "checksum", "uploadedById", "mimeType"]) {
          expect(payroll, key).not.toHaveProperty(key);
        }
        const brief = rows.find((r) => r.id === BRIEF)!;
        expect(brief.filename).toBe("brief-2546.md");
        expect(brief).not.toHaveProperty("restricted");
      });

      it("reads the same by cursor and one at a time", async () => {
        const first = await get("bob", `/api/projects/${P}/documents?limit=1`);
        const next = await get(
          "bob",
          `/api/projects/${P}/documents?limit=1&cursor=${first.body.data.nextCursor}`,
        );
        expect(next.status).toBe(200);
        const one = await get("bob", `/api/projects/${P}/documents/${PAYROLL}`);
        expect(one.status).toBe(200);
        for (const body of [first.body, next.body, one.body]) {
          expect(JSON.stringify(body)).not.toMatch(LEAKS);
        }
        expect(one.body.data).toMatchObject({ id: PAYROLL, restricted: true });
      });

      it("names it to Alice and to an admin", async () => {
        for (const who of ["alice", "root"] as const) {
          const res = await get(who, `/api/projects/${P}/documents/${PAYROLL}`);
          expect(res.body.data.filename, who).toBe(PAYROLL_NAME);
          expect(res.body.data, who).not.toHaveProperty("restricted");
        }
      });
    });

    describe("L1 — a portfolio check from the document", () => {
      it("is refused to Bob as for an unknown document, before anything is stored", async () => {
        const before = await db.portfolioAssessment.count();
        const bob = await post("bob", "/api/portfolio-assessments", {
          scope: "product",
          productIds: [PRODUCT],
          documentId: PAYROLL,
        });
        const unknown = await post("bob", "/api/portfolio-assessments", {
          scope: "product",
          productIds: [PRODUCT],
          documentId: "doc-no-such-2546",
        });
        expect(bob.status).toBe(404);
        expect(bob.body.error.code).toBe(unknown.body.error.code);
        expect(bob.body.error.message).toBe(unknown.body.error.message);
        expect(await db.portfolioAssessment.count()).toBe(before);
      });

      it("starts for Alice", async () => {
        const alice = await post("alice", "/api/portfolio-assessments", {
          scope: "product",
          productIds: [PRODUCT],
          documentId: PAYROLL,
        });
        expect(alice.status).toBe(202);
        // Let its run end (it fails: no model here) before the suite closes the database.
        const id = alice.body.data.id as string;
        for (let i = 0; i < 300; i++) {
          const row = await db.portfolioAssessment.findUnique({ where: { id } });
          if (row && row.status !== "pending" && row.status !== "running") break;
          await new Promise((r) => setTimeout(r, 10));
        }
      });

      it("Alice's check shows Bob none of the document's words, and the verdict stays", async () => {
        const res = await get("bob", `/api/portfolio-assessments/${CHECK}`);
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toMatch(LEAKS);
        expect(res.body.data.statement).toBe(RESTRICTED_SOURCE_TITLE);
        expect(res.body.data.verdict).not.toBeNull();
        const list = await get("bob", `/api/portfolio-assessments?productId=${PRODUCT}`);
        expect(list.status).toBe(200);
        expect(list.body.data.some((i: { id: string }) => i.id === CHECK)).toBe(true);
        expect(JSON.stringify(list.body)).not.toMatch(LEAKS);
        const md = await get("bob", `/api/portfolio-assessments/${CHECK}/export?format=md`);
        expect(md.status).toBe(200);
        expect(md.text).not.toMatch(LEAKS);
      });

      it("shows Alice and an admin all of it", async () => {
        for (const who of ["alice", "root"] as const) {
          const res = await get(who, `/api/portfolio-assessments/${CHECK}`);
          expect(res.body.data.statement, who).toContain(PAYROLL_NAME);
          expect(JSON.stringify(res.body), who).toContain(SECRET);
        }
      });
    });

    describe("L2 — the analyses list", () => {
      it("sends no raw metadata, and names no document Bob cannot see", async () => {
        const res = await get("bob", `/api/projects/${P}/analyses`);
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toMatch(LEAKS);
        const [item] = res.body.data.items;
        expect(item.id).toBe(RUN);
        expect(item).not.toHaveProperty("metadata");
        expect(item.sources.documents).toEqual([{ id: PAYROLL, name: RESTRICTED_SOURCE_TITLE }]);
        // Generated again without the hidden name: the date title.
        expect(item.title).toBe("Change request of 2026-11-01");
        expect(item.titleGenerated).toBe(true);
      });

      it("names the document, and keeps the stored title, for Alice and an admin", async () => {
        for (const who of ["alice", "root"] as const) {
          const [item] = (await get(who, `/api/projects/${P}/analyses`)).body.data.items;
          expect(item.title, who).toBe(PAYROLL_NAME);
          expect(item.sources.documents, who).toEqual([{ id: PAYROLL, name: PAYROLL_NAME }]);
          expect(item, who).not.toHaveProperty("metadata");
        }
      });

      it("a title a person typed is theirs, and stays for Bob", async () => {
        await db.analysis.update({
          where: { id: RUN },
          data: { title: "Pay review", titleGenerated: false },
        });
        try {
          const [item] = (await get("bob", `/api/projects/${P}/analyses`)).body.data.items;
          expect(item.title).toBe("Pay review");
          expect(item.titleGenerated).toBe(false);
        } finally {
          await db.analysis.update({
            where: { id: RUN },
            data: { title: PAYROLL_NAME, titleGenerated: true },
          });
        }
      });

      it("the result page names nothing of it either", async () => {
        const res = await get("bob", `/api/analyses/${RUN}`);
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toMatch(LEAKS);
        expect(res.body.data.sources.documents[0].name).toBe(RESTRICTED_SOURCE_TITLE);
        const alice = await get("alice", `/api/analyses/${RUN}`);
        expect(alice.body.data.title).toBe(PAYROLL_NAME);
      });

      it("a chat about the change request is told nothing of it", async () => {
        const bob = await resolveChatSubject(payload("bob"), "change-request", RUN);
        expect(bob.title).not.toMatch(LEAKS);
        const alice = await resolveChatSubject(payload("alice"), "change-request", RUN);
        expect(alice.title).toBe(PAYROLL_NAME);
      });

      it("a review of its requirements is labelled without it", async () => {
        const reviews = [{ projectId: P, items: [{ requirementId: REQ }] }];
        const bob = await attachChangeRequests(reviews, userSourceReader("bob"));
        expect(bob[0]!.changeRequests).toEqual([
          { id: RUN, title: "Change request of 2026-11-01" },
        ]);
        const alice = await attachChangeRequests(reviews, userSourceReader("alice"));
        expect(alice[0]!.changeRequests).toEqual([{ id: RUN, title: PAYROLL_NAME }]);
      });
    });

    describe("L3 — the discussion list", () => {
      it("names the requirement as Restricted to Bob, and by its title to Alice", async () => {
        const bob = await get("bob", `/api/discussions/threads?projectId=${P}`);
        expect(bob.status).toBe(200);
        expect(JSON.stringify(bob.body)).not.toMatch(LEAKS);
        expect(bob.body.data[0].requirement).toEqual({
          id: REQ,
          title: RESTRICTED_SOURCE_TITLE,
          analysisId: RUN,
        });
        const alice = await get("alice", `/api/discussions/threads?projectId=${P}`);
        expect(alice.body.data[0].requirement.title).toBe(SECRET);
      });
    });

    describe("an impact analysis from the document", () => {
      it("is refused to Bob as for an unknown document", async () => {
        const before = await db.impactAnalysis.count();
        const bob = await post("bob", "/api/impact-analyses", {
          documentId: PAYROLL,
          projectIds: [P],
        });
        const unknown = await post("bob", "/api/impact-analyses", {
          documentId: "doc-no-such-2546",
          projectIds: [P],
        });
        expect(bob.status).toBe(404);
        expect(bob.body.error.code).toBe(unknown.body.error.code);
        expect(await db.impactAnalysis.count()).toBe(before);
        // Nor re-run from Alice's.
        const rerun = await post("bob", `/api/impact-analyses/${IMPACT}/rerun`, {});
        expect(rerun.status).toBe(404);
        expect(await db.impactAnalysis.count()).toBe(before);
      });

      it("Alice's shows Bob its scores but none of the document's words", async () => {
        const res = await get("bob", `/api/impact-analyses/${IMPACT}`);
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toMatch(LEAKS);
        expect(res.body.data).toMatchObject({ sourceText: null, summary: null });
        expect(res.body.data.items[0]).toMatchObject({
          requirementTitle: RESTRICTED_SOURCE_TITLE,
          summary: RESTRICTED_SOURCE_BODY,
        });
        const list = await get("bob", `/api/impact-analyses?projectId=${P}`);
        expect(list.status).toBe(200);
        const row = list.body.data.find((r: { id: string }) => r.id === IMPACT);
        expect(row.summary).toBeNull();
      });

      it("shows Alice and an admin all of it", async () => {
        for (const who of ["alice", "root"] as const) {
          const res = await get(who, `/api/impact-analyses/${IMPACT}`);
          expect(res.body.data.sourceText, who).toBe(SECRET);
          expect(res.body.data.items[0].requirementTitle, who).toBe(SECRET);
          const list = await get(who, `/api/impact-analyses?projectId=${P}`);
          expect(list.body.data.find((r: { id: string }) => r.id === IMPACT).summary, who).toBe(
            SECRET,
          );
        }
      });
    });
    describe("#2546 review — the change request's name on every surface", () => {
      it("the Requirements list names Alice's change request without the document to Bob", async () => {
        const bob = await get("bob", `/api/projects/${P}/requirements`);
        expect(bob.status).toBe(200);
        expect(JSON.stringify(bob.body)).not.toMatch(LEAKS);
        const open = bob.body.data.items.find((i: { id: string }) => i.id === REQ_OPEN);
        expect(open.changeRequest).toEqual({ id: RUN, title: BOB_TITLE });
        for (const who of ["alice", "root"] as const) {
          const res = await get(who, `/api/projects/${P}/requirements`);
          const row = res.body.data.items.find((i: { id: string }) => i.id === REQ_OPEN);
          expect(row.changeRequest.title, who).toBe(PAYROLL_NAME);
        }
      });

      it("the impact analysis's link back names it without the document to Bob", async () => {
        const bob = await get("bob", `/api/impact-analyses/${IMPACT_CR}`);
        expect(bob.status).toBe(200);
        expect(JSON.stringify(bob.body)).not.toMatch(LEAKS);
        expect(bob.body.data.changeRequest).toEqual({ id: RUN, projectId: P, title: BOB_TITLE });
        for (const who of ["alice", "root"] as const) {
          const res = await get(who, `/api/impact-analyses/${IMPACT_CR}`);
          expect(res.body.data.changeRequest.title, who).toBe(PAYROLL_NAME);
        }
      });

      it("the portfolio check's link back and statement name it without the document to Bob", async () => {
        const bob = await get("bob", `/api/portfolio-assessments/${CHECK_CR}`);
        expect(bob.status).toBe(200);
        expect(JSON.stringify(bob.body)).not.toMatch(LEAKS);
        expect(bob.body.data.changeRequest).toEqual({ id: RUN, projectId: P, title: BOB_TITLE });
        expect(bob.body.data.statement).toBe(`Requirements of change request "${BOB_TITLE}"`);
        const list = await get("bob", `/api/portfolio-assessments?analysisId=${RUN}`);
        expect(list.status).toBe(200);
        expect(list.body.data.some((i: { id: string }) => i.id === CHECK_CR)).toBe(true);
        expect(JSON.stringify(list.body)).not.toMatch(LEAKS);
        const md = await get("bob", `/api/portfolio-assessments/${CHECK_CR}/export?format=md`);
        expect(md.status).toBe(200);
        expect(md.text).not.toMatch(LEAKS);
        for (const who of ["alice", "root"] as const) {
          const res = await get(who, `/api/portfolio-assessments/${CHECK_CR}`);
          expect(res.body.data.changeRequest.title, who).toBe(PAYROLL_NAME);
          expect(res.body.data.statement, who).toContain(PAYROLL_NAME);
        }
      });

      it("a check Bob starts from the change request stores no name he cannot see", async () => {
        const before = new Set((await db.portfolioAssessment.findMany()).map((a) => a.id));
        const bob = await post("bob", "/api/portfolio-assessments", {
          scope: "product",
          productIds: [PRODUCT],
          analysisId: RUN,
        });
        expect(bob.status).toBe(202);
        const id = bob.body.data.id as string;
        expect(before.has(id)).toBe(false);
        let row = await db.portfolioAssessment.findUnique({ where: { id } });
        for (
          let i = 0;
          i < 300 && row && (row.status === "pending" || row.status === "running");
          i++
        ) {
          await new Promise((r) => setTimeout(r, 10));
          row = await db.portfolioAssessment.findUnique({ where: { id } });
        }
        expect(row!.statement).toBe(`Requirements of change request "${BOB_TITLE}"`);
      });
    });

    describe("#2546 review — a document's toggles answer with the same row", () => {
      it("Bob's spec and auto-approve toggles answer with the restricted row", async () => {
        try {
          for (const [path, body] of [
            ["spec", { isSpec: true }],
            ["auto-approve", { autoApproveTrusted: true }],
          ] as const) {
            const bob = await patch("bob", `/api/projects/${P}/documents/${PAYROLL}/${path}`, body);
            expect(bob.status, path).toBe(200);
            expect(JSON.stringify(bob.body), path).not.toMatch(LEAKS);
            expect(bob.body.data, path).toMatchObject({ id: PAYROLL, restricted: true });
            expect(bob.body.data, path).not.toHaveProperty("aclSubjects");
          }
          const alice = await patch("alice", `/api/projects/${P}/documents/${PAYROLL}/spec`, {
            isSpec: false,
          });
          expect(alice.body.data.filename).toBe(PAYROLL_NAME);
          expect(alice.body.data).not.toHaveProperty("restricted");
        } finally {
          await db.document.update({
            where: { id: PAYROLL },
            data: { isSpec: false, autoApproveTrusted: false },
          });
        }
      });
    });

    describe("#2546 panel — a run from before #2446 (no recorded source access)", () => {
      it("names a document restricted now as the placeholder to Bob, and to Alice by its name", async () => {
        await db.analysis.update({ where: { id: RUN }, data: { sourceAccess: null } });
        try {
          const list = await get("bob", `/api/projects/${P}/analyses`);
          expect(JSON.stringify(list.body)).not.toMatch(LEAKS);
          const [item] = list.body.data.items;
          expect(item.sources.documents).toEqual([{ id: PAYROLL, name: RESTRICTED_SOURCE_TITLE }]);
          expect(item.title).toBe(BOB_TITLE);
          const reqs = await get("bob", `/api/projects/${P}/requirements`);
          const open = reqs.body.data.items.find((i: { id: string }) => i.id === REQ_OPEN);
          expect(open.changeRequest.title).toBe(BOB_TITLE);
          const impact = await get("bob", `/api/impact-analyses/${IMPACT_CR}`);
          expect(impact.body.data.changeRequest.title).toBe(BOB_TITLE);
          const check = await get("bob", `/api/portfolio-assessments/${CHECK_CR}`);
          expect(JSON.stringify(check.body.data.changeRequest)).not.toMatch(LEAKS);
          expect(check.body.data.statement).not.toMatch(LEAKS);
          const subject = await resolveChatSubject(payload("bob"), "change-request", RUN);
          expect(subject.title).not.toMatch(LEAKS);
          for (const who of ["alice", "root"] as const) {
            const [mine] = (await get(who, `/api/projects/${P}/analyses`)).body.data.items;
            expect(mine.title, who).toBe(PAYROLL_NAME);
            expect(mine.sources.documents, who).toEqual([{ id: PAYROLL, name: PAYROLL_NAME }]);
          }
        } finally {
          await db.analysis.update({ where: { id: RUN }, data: { sourceAccess: "starter" } });
        }
      });
    });

    describe("#2546 panel — test gaps", () => {
      it("the documents list's cursor page names the restricted document to no one it leaves out", async () => {
        // Oldest, so it falls on the page read by cursor, not the first one.
        await db.document.update({
          where: { id: PAYROLL },
          data: { uploadedAt: new Date("2000-01-01T00:00:00Z") },
        });
        try {
          const first = await get("bob", `/api/projects/${P}/documents?limit=1`);
          expect(first.body.data.items.map((r: { id: string }) => r.id)).toEqual([BRIEF]);
          const next = await get(
            "bob",
            `/api/projects/${P}/documents?limit=1&cursor=${first.body.data.nextCursor}`,
          );
          expect(next.status).toBe(200);
          expect(JSON.stringify(next.body)).not.toMatch(LEAKS);
          expect(next.body.data.items).toEqual([
            expect.objectContaining({ id: PAYROLL, restricted: true }),
          ]);
          const alice = await get(
            "alice",
            `/api/projects/${P}/documents?limit=1&cursor=${first.body.data.nextCursor}`,
          );
          expect(alice.body.data.items[0].filename).toBe(PAYROLL_NAME);
        } finally {
          await db.document.update({ where: { id: PAYROLL }, data: { uploadedAt: new Date() } });
        }
      });

      it("a chat about the change request tells the model no source document Bob cannot see", async () => {
        const ref = { kind: "change-request" as const, id: RUN };
        const bob = await chatSubjectContextBlock(payload("bob"), { projectId: P }, ref);
        expect(bob).toContain("Its source documents:");
        expect(bob).not.toMatch(LEAKS);
        const alice = await chatSubjectContextBlock(payload("alice"), { projectId: P }, ref);
        expect(alice).toContain(PAYROLL_NAME);
      });

      it("the Reviews list labels a review of its requirements without it, for the caller", async () => {
        await db.reviewRequest.create({
          data: {
            id: "review-2546",
            projectId: P,
            title: "Review",
            requestedById: "alice",
            items: { create: [{ requirementId: REQ_OPEN, pinnedVersion: 1 }] },
          },
        });
        try {
          const labels = async (who: Who) =>
            (
              (await listReviews(who, { projectId: P, page: 1, pageSize: 25 })).reviews as Array<{
                changeRequests: Array<{ id: string; title: string }>;
              }>
            )[0]!.changeRequests;
          expect(await labels("bob")).toEqual([{ id: RUN, title: BOB_TITLE }]);
          expect(await labels("alice")).toEqual([{ id: RUN, title: PAYROLL_NAME }]);
        } finally {
          await db.reviewRequest.delete({ where: { id: "review-2546" } });
        }
      });
    });

    describe("#2546 panel round 2 — a check's statement after its change request is renamed", () => {
      it("names the change request by its new name to Bob, not the frozen document name", async () => {
        await db.analysis.update({
          where: { id: RUN },
          data: { title: "Pay review", titleGenerated: false },
        });
        try {
          const bob = await get("bob", `/api/portfolio-assessments/${CHECK_CR}`);
          expect(bob.status).toBe(200);
          expect(JSON.stringify(bob.body)).not.toMatch(LEAKS);
          expect(bob.body.data.statement).toBe('Requirements of change request "Pay review"');
          // Alice saw the document when the check was started: hers stays as written.
          const alice = await get("alice", `/api/portfolio-assessments/${CHECK_CR}`);
          expect(alice.body.data.statement).toContain(PAYROLL_NAME);
        } finally {
          await db.analysis.update({
            where: { id: RUN },
            data: { title: PAYROLL_NAME, titleGenerated: true },
          });
        }
      });
    });

    describe("#2546 panel round 2 — a quarantine decision answers with the reader's row", () => {
      it("Bob's reject answers with the restricted row, Alice's with the document", async () => {
        const reject = async (who: Who) => {
          await db.document.update({ where: { id: PAYROLL }, data: { indexState: "quarantined" } });
          return post(who, `/api/projects/${P}/documents/${PAYROLL}/reject`, {});
        };
        try {
          const bob = await reject("bob");
          expect(bob.status).toBe(200);
          expect(JSON.stringify(bob.body)).not.toMatch(LEAKS);
          expect(bob.body.data.document).toMatchObject({ id: PAYROLL, restricted: true });
          expect(bob.body.data.document).not.toHaveProperty("aclSubjects");
          const alice = await reject("alice");
          expect(alice.status).toBe(200);
          expect(alice.body.data.document.filename).toBe(PAYROLL_NAME);
        } finally {
          await db.document.update({ where: { id: PAYROLL }, data: { indexState: "indexed" } });
        }
      });
    });

    describe("#2546 review — the quarantine list", () => {
      it("lists the restricted document to Bob without its name, and names it to Alice", async () => {
        await db.document.update({ where: { id: PAYROLL }, data: { indexState: "quarantined" } });
        try {
          const bob = await get("bob", `/api/projects/${P}/quarantine`);
          expect(bob.status).toBe(200);
          expect(JSON.stringify(bob.body)).not.toMatch(LEAKS);
          expect(bob.body.data.items).toEqual([
            expect.objectContaining({
              documentId: PAYROLL,
              filename: RESTRICTED_SOURCE_TITLE,
              restricted: true,
            }),
          ]);
          for (const who of ["alice", "root"] as const) {
            const res = await get(who, `/api/projects/${P}/quarantine`);
            expect(res.body.data.items[0].filename, who).toBe(PAYROLL_NAME);
            expect(res.body.data.items[0], who).not.toHaveProperty("restricted");
          }
        } finally {
          await db.document.update({ where: { id: PAYROLL }, data: { indexState: "indexed" } });
        }
      });
    });

    describe("#2546 review — refusals are audited", () => {
      it("an impact analysis Bob tries to start from the document is audited as denied", async () => {
        vi.mocked(audit).mockClear();
        const bob = await post("bob", "/api/impact-analyses", {
          documentId: PAYROLL,
          projectIds: [P],
        });
        expect(bob.status).toBe(404);
        expect(vi.mocked(audit)).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "impact_analysis.document.denied",
            actor: expect.objectContaining({ id: "bob" }),
          }),
        );
      });

      it("a portfolio check Bob tries to start from the document is audited as denied", async () => {
        vi.mocked(audit).mockClear();
        const bob = await post("bob", "/api/portfolio-assessments", {
          scope: "product",
          productIds: [PRODUCT],
          documentId: PAYROLL,
        });
        expect(bob.status).toBe(404);
        expect(vi.mocked(audit)).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "portfolio_assessment.document.denied",
            actor: expect.objectContaining({ id: "bob" }),
          }),
        );
      });
    });
  },
);
