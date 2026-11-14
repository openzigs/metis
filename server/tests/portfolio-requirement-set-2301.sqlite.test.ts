/**
 * #2301 — `/api/portfolio-assessments` with `requirementIds`: a portfolio check
 * of a chosen set of stored requirements, each checked on its own. On a real
 * SQLite database built by the migration chain, over the #1622 synthetic
 * portfolio, with real JWTs, the real router, product access, federated search
 * (fixture index) and engine; the model is scripted.
 *
 * Users: Mia is in both workspaces, Ana in ws-a, Ola in ws-b. Projects 0 and 1
 * are ws-a's, project 2 is ws-b's.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import {
  PORTFOLIO_MAX_REQUIREMENTS,
  PORTFOLIO_REQUIREMENT_MAX_CHARS,
  getPermissionsForRole,
  type AuthPayload,
  type PortfolioAssessmentView,
} from "@metis/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";
import {
  P1,
  PROJECTS,
  RESET_CRITERIA,
  fixtureKnowledgeService,
  scriptedProvider,
  seedPortfolio,
  WS_A,
  WS_B,
} from "./fixtures/portfolio-gap-1622.js";

const state = vi.hoisted(() => {
  process.env.AI_OFFLINE = "1";
  process.env.PORTFOLIO_ASSESSMENT_START_RATE_LIMIT_MAX = "1000";
  return { db: null as unknown };
});
vi.mock("../src/lib/prisma.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/prisma.js")>();
  return {
    ...actual,
    get prisma() {
      return state.db;
    },
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { portfolioAssessmentsRouter } = await import("../src/routes/portfolio-assessments.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { FederatedSearchService } = await import("../src/lib/rag/federated-search-service.js");

const USERS: Record<string, string[]> = {
  mia: [WS_A, WS_B],
  ana: [WS_A],
  ola: [WS_B],
};
type Who = keyof typeof USERS;

const payload = (who: Who): AuthPayload => ({
  userId: who,
  username: who,
  role: "coordinator",
  permissions: getPermissionsForRole("coordinator"),
  workspaces: USERS[who],
});
const bearer = (who: Who) => `Bearer ${issueTokens(payload(who)).accessToken}`;

const CR = "cr-2301";
const CR_SUPPORT = "cr-support-2301";
const CR_BILLING = "cr-billing-2301";
/** In project 0: a draft and an approved one (the reset criteria), and one approved, long. */
const R_DRAFT = "req-draft-2301";
// Named to sort after the draft and created after it: chosen first, it tells the
// chosen order from both the rows' id order and their insertion order.
const R_APPROVED = "req-z-approved-2301";
const R_LONG = "req-long-2301";
const R_DELETED = "req-deleted-2301";
/** In project 1 (ws-a) and project 2 (ws-b). */
const R_SUPPORT = "req-support-2301";
const R_BILLING = "req-billing-2301";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2301 — a portfolio check of a chosen set of stored requirements",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const federated = new FederatedSearchService({ knowledgeService: fixtureKnowledgeService() });
    const app = () => {
      const a = express();
      a.use(express.json());
      a.use(
        "/api/portfolio-assessments",
        portfolioAssessmentsRouter({
          gap: {
            get provider() {
              return scriptedProvider();
            },
            search: federated.searchAcrossProjects.bind(federated),
            limits: { runCostCapUsd: 100, productCostCapUsd: 100, concurrency: 2 },
            costOf: () => 0.01,
          },
        }),
      );
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const post = (who: Who, body: object) =>
      request(app())
        .post("/api/portfolio-assessments")
        .set("Authorization", bearer(who))
        .send(body);
    const get = (who: Who, path: string) =>
      request(app()).get(`/api/portfolio-assessments${path}`).set("Authorization", bearer(who));

    async function settled(id: string, who: Who): Promise<PortfolioAssessmentView> {
      for (let i = 0; i < 300; i++) {
        const row = await db.portfolioAssessment.findUnique({ where: { id } });
        if (row && row.status !== "pending" && row.status !== "running") break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const res = await get(who, `/${id}`);
      expect(res.status).toBe(200);
      return res.body.data as PortfolioAssessmentView;
    }
    const criteriaOf = (view: PortfolioAssessmentView) =>
      (
        view.products.find((p) => p.productId === P1)!.technicalDetail as {
          criteria: Array<{ criterion: string }>;
        }
      ).criteria.map((c) => c.criterion);

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2301-portfolio-requirement-set");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await seedPortfolio(db, USERS);
      for (const [id, projectId] of [
        [CR, PROJECTS[0].id],
        [CR_SUPPORT, PROJECTS[1].id],
        [CR_BILLING, PROJECTS[2].id],
      ] as const) {
        await db.analysis.create({
          data: { id, projectId, title: id, startedById: "mia", status: "completed" },
        });
      }
      for (const [id, analysisId, projectId, reviewStatus, title, body, deletedAt] of [
        [R_DRAFT, CR, PROJECTS[0].id, "draft", RESET_CRITERIA[0], "As written.", null],
        [R_APPROVED, CR, PROJECTS[0].id, "approved", RESET_CRITERIA[1], "As written.", null],
        [
          R_LONG,
          CR,
          PROJECTS[0].id,
          "approved",
          "Long",
          "y".repeat(PORTFOLIO_REQUIREMENT_MAX_CHARS + 50),
          null,
        ],
        [R_DELETED, CR, PROJECTS[0].id, "approved", "Gone", "x", new Date()],
        [R_SUPPORT, CR_SUPPORT, PROJECTS[1].id, "approved", "Support desk", "x", null],
        [R_BILLING, CR_BILLING, PROJECTS[2].id, "approved", "Export invoices", "x", null],
      ] as const) {
        await db.requirement.create({
          data: { id, projectId, analysisId, title, body, reviewStatus, deletedAt },
        });
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("checks each chosen requirement on its own, in the order chosen, and stores the set", async () => {
      // Chosen approved-first: the criteria follow the choice, not the rows' order.
      const res = await post("ana", {
        requirementIds: [R_APPROVED, R_DRAFT],
        scope: "product",
        productIds: [P1],
      });
      expect(res.status).toBe(202);
      const view = await settled(res.body.data.id, "ana");
      expect(view.status).toBe("completed");
      expect(view.sourceRequirementIds).toEqual([R_APPROVED, R_DRAFT]);
      expect(view.sourceProjectId).toBe(PROJECTS[0].id);
      expect(view.sourceRequirementId).toBeNull();
      expect(view.sourceAnalysisId).toBeNull();
      expect(view.statement).toBe(`2 chosen requirements of project "${PROJECTS[0].id}"`);
      expect(criteriaOf(view)).toEqual([
        `${RESET_CRITERIA[1]}: As written.`,
        `${RESET_CRITERIA[0]}: As written.`,
      ]);
      // A draft among them: labelled as run on unapproved requirements.
      expect(view.preApproval).toBe(true);
      expect(view.notChecked).toEqual([]);
      const row = await db.portfolioAssessment.findUnique({ where: { id: view.id } });
      expect(JSON.parse(row!.sourceRequirementIds)).toEqual([R_APPROVED, R_DRAFT]);
    });

    it("a set of approved requirements is not labelled, and a requirement's text past the cap is listed, not cut silently", async () => {
      const res = await post("ana", {
        requirementIds: [R_APPROVED, R_LONG],
        scope: "all-accessible",
      });
      expect(res.status).toBe(202);
      const view = await settled(res.body.data.id, "ana");
      expect(view.preApproval).toBe(false);
      expect(view.statement).toBe(`2 chosen requirements of project "${PROJECTS[0].id}"`);
      expect(view.notChecked).toEqual([
        expect.objectContaining({
          reason: "text-cut",
          // "Long: " and the 50 characters past the cap.
          count: "Long: ".length + 50,
        }),
      ]);
    });

    it("says one requirement in the singular", async () => {
      const res = await post("ana", { requirementIds: [R_APPROVED], scope: "all-accessible" });
      expect(res.status).toBe(202);
      expect((await settled(res.body.data.id, "ana")).statement).toBe(
        `1 chosen requirement of project "${PROJECTS[0].id}"`,
      );
    });

    it("refuses a set holding a requirement the caller cannot read, an unknown one or a deleted one alike (404), and stores nothing", async () => {
      const before = await db.portfolioAssessment.count();
      const unreadable = await post("ana", {
        requirementIds: [R_APPROVED, R_BILLING],
        scope: "all-accessible",
      });
      expect(unreadable.status).toBe(404);
      for (const other of ["req-nope-2301", R_DELETED]) {
        const res = await post("ana", {
          requirementIds: [R_APPROVED, other],
          scope: "all-accessible",
        });
        expect(res.status).toBe(404);
        expect(res.body.error).toEqual(unreadable.body.error);
      }
      expect(await db.portfolioAssessment.count()).toBe(before);
    });

    it("refuses a readable set across projects (400): one check reads one project's requirements", async () => {
      // Mia reads both workspaces, Ana both ws-a projects: the 400 is never an oracle.
      for (const [who, ids] of [
        ["mia", [R_APPROVED, R_BILLING]],
        ["ana", [R_APPROVED, R_SUPPORT]],
      ] as const) {
        const res = await post(who, { requirementIds: ids, scope: "all-accessible" });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("REQUIREMENTS_SPAN_PROJECTS");
      }
    });

    it("refuses more than a check takes, a repeated id, and a second source (400)", async () => {
      const many = Array.from({ length: PORTFOLIO_MAX_REQUIREMENTS + 1 }, (_, i) => `r-${i}`);
      for (const body of [
        { requirementIds: many, scope: "all-accessible" },
        { requirementIds: [R_APPROVED, R_APPROVED], scope: "all-accessible" },
        { requirementIds: [R_APPROVED], requirementId: R_DRAFT, scope: "all-accessible" },
      ]) {
        expect((await post("ana", body)).status).toBe(400);
      }
    });

    it("only a reader of the requirements' project reads the check", async () => {
      const id = (await post("mia", { requirementIds: [R_APPROVED], scope: "all-accessible" })).body
        .data.id;
      await settled(id, "mia");
      expect((await get("ola", `/${id}`)).status).toBe(404);
      expect((await get("ola", `/${id}/export`)).status).toBe(404);
      expect((await get("ana", `/${id}`)).status).toBe(200);
      // And a reader of project 2 may check its own.
      expect(
        (await post("ola", { requirementIds: [R_BILLING], scope: "all-accessible" })).status,
      ).toBe(202);
    });
  },
);
