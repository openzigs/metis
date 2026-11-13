/**
 * #2345 — `/api/portfolio-assessments` with `analysisId`: a portfolio check
 * started from a change request, before or after its requirements are
 * approved. On a real SQLite database built by the migration chain, over the
 * #1622 synthetic portfolio, with real JWTs, the real router, product access,
 * federated search (fixture index) and engine; the model is scripted.
 *
 * Users: Mia is in both workspaces, Ana in ws-a, Ola in ws-b.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import {
  getPermissionsForRole,
  type AuthPayload,
  type PortfolioAssessmentListItem,
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
  WS_A,
  WS_B,
  fixtureKnowledgeService,
  scriptedProvider,
  seedPortfolio,
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

/** A change request with a draft and an approved requirement, one all approved, one empty. */
const CR_DRAFT = "cr-draft-2345";
const CR_APPROVED = "cr-approved-2345";
const CR_EMPTY = "cr-empty-2345";
/** One in ws-b's billing project. */
const CR_BILLING = "cr-billing-2345";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2345 — a portfolio check started from a change request",
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

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2345-change-request-portfolio");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await seedPortfolio(db, USERS);
      for (const [id, projectId, title] of [
        [CR_DRAFT, PROJECTS[0].id, "Password reset by email"],
        [CR_APPROVED, PROJECTS[0].id, "Approved reset"],
        [CR_EMPTY, PROJECTS[0].id, "Nothing yet"],
        [CR_BILLING, PROJECTS[2].id, "Billing export"],
      ] as const) {
        await db.analysis.create({
          data: { id, projectId, title, startedById: "mia", status: "completed" },
        });
      }
      let t = Date.parse("2026-11-01T00:00:00Z");
      for (const [id, analysisId, projectId, reviewStatus, title] of [
        ["req-d1-2345", CR_DRAFT, PROJECTS[0].id, "draft", RESET_CRITERIA[0]],
        ["req-d2-2345", CR_DRAFT, PROJECTS[0].id, "approved", RESET_CRITERIA[1]],
        ["req-d3-2345", CR_DRAFT, PROJECTS[0].id, "rejected", "Rejected one"],
        ["req-a1-2345", CR_APPROVED, PROJECTS[0].id, "approved", RESET_CRITERIA[0]],
        ["req-b1-2345", CR_BILLING, PROJECTS[2].id, "approved", "Export invoices"],
      ] as const) {
        await db.requirement.create({
          data: {
            id,
            projectId,
            analysisId,
            title,
            body: "As written.",
            reviewStatus,
            createdAt: new Date((t += 1000)),
          },
        });
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("checks the change request's draft and approved requirements before approval, labelled so, and names it back", async () => {
      const res = await post("ana", { analysisId: CR_DRAFT, scope: "all-accessible" });
      expect(res.status).toBe(202);
      const view = await settled(res.body.data.id, "ana");
      expect(view.status).toBe("completed");
      expect(view.sourceAnalysisId).toBe(CR_DRAFT);
      expect(view.sourceProjectId).toBe(PROJECTS[0].id);
      expect(view.sourceRequirementId).toBeNull();
      expect(view.preApproval).toBe(true);
      expect(view.statement).toBe('Requirements of change request "Password reset by email"');
      // Each requirement is one criterion; the rejected one is not part of the change.
      const accounts = view.products.find((p) => p.productId === P1)!;
      const criteria = (accounts.technicalDetail as { criteria: Array<{ criterion: string }> })
        .criteria;
      expect(criteria.map((c) => c.criterion)).toEqual(
        RESET_CRITERIA.map((c) => `${c}: As written.`),
      );
      expect(view.changeRequest).toEqual({
        id: CR_DRAFT,
        projectId: PROJECTS[0].id,
        title: "Password reset by email",
      });

      // Cited in the run's list and in the export, with the label.
      const list = (await get("ana", `?analysisId=${CR_DRAFT}`)).body
        .data as PortfolioAssessmentListItem[];
      expect(list[0]).toMatchObject({ id: view.id, sourceAnalysisId: CR_DRAFT, preApproval: true });
      const md = await get("ana", `/${view.id}/export`);
      expect(md.text).toContain("**Run on unapproved requirements**");
    });

    it("a change request whose requirements are all approved is not labelled", async () => {
      const res = await post("ana", {
        analysisId: CR_APPROVED,
        scope: "product",
        productIds: [P1],
      });
      expect(res.status).toBe(202);
      const view = await settled(res.body.data.id, "ana");
      expect(view.preApproval).toBe(false);
      const md = await get("ana", `/${view.id}/export`);
      expect(md.text).not.toContain("Run on unapproved requirements");
    });

    it("lists a change request's checks newest first, so a second run shows above the first", async () => {
      const first = (await post("ana", { analysisId: CR_APPROVED, scope: "all-accessible" })).body
        .data.id;
      await settled(first, "ana");
      const second = (await post("ana", { analysisId: CR_APPROVED, scope: "all-accessible" })).body
        .data.id;
      await settled(second, "ana");
      const ids = (
        (await get("ana", `?analysisId=${CR_APPROVED}`)).body.data as Array<{
          id: string;
        }>
      ).map((r) => r.id);
      expect(ids.indexOf(second)).toBeLessThan(ids.indexOf(first));
      expect(ids.indexOf(first)).toBeGreaterThanOrEqual(0);
    });

    it("a requirement checked from its own detail before approval is labelled too", async () => {
      const res = await post("ana", { requirementId: "req-d1-2345", scope: "all-accessible" });
      expect(res.status).toBe(202);
      expect((await settled(res.body.data.id, "ana")).preApproval).toBe(true);
      const approved = await post("ana", { requirementId: "req-a1-2345", scope: "all-accessible" });
      expect((await settled(approved.body.data.id, "ana")).preApproval).toBe(false);
    });

    it("refuses a change request the caller cannot read, an unknown one and a deleted one alike (404)", async () => {
      const unreadable = await post("ana", { analysisId: CR_BILLING, scope: "all-accessible" });
      expect(unreadable.status).toBe(404);
      await db.analysis.create({
        data: {
          id: "cr-deleted-2345",
          projectId: PROJECTS[0].id,
          startedById: "mia",
          status: "completed",
          deletedAt: new Date(),
        },
      });
      for (const analysisId of ["cr-nope-2345", "cr-deleted-2345"]) {
        const res = await post("ana", { analysisId, scope: "all-accessible" });
        expect(res.status).toBe(404);
        expect(res.body.error).toEqual(unreadable.body.error);
      }
      // A reader of its project may.
      expect((await post("ola", { analysisId: CR_BILLING, scope: "all-accessible" })).status).toBe(
        202,
      );
    });

    it("says a change request with nothing to check has none (400), and takes it as the only source", async () => {
      const empty = await post("ana", { analysisId: CR_EMPTY, scope: "all-accessible" });
      expect(empty.status).toBe(400);
      expect(empty.body.error.code).toBe("NO_REQUIREMENTS");
      const both = await post("ana", {
        analysisId: CR_DRAFT,
        statement: "Something typed",
        scope: "all-accessible",
      });
      expect(both.status).toBe(400);
    });

    it("only a reader of the change request's project reads its checks, or sees it named", async () => {
      const id = (await post("mia", { analysisId: CR_DRAFT, scope: "all-accessible" })).body.data
        .id;
      await settled(id, "mia");
      expect((await get("ola", `/${id}`)).status).toBe(404);
      expect((await get("ola", `?analysisId=${CR_DRAFT}`)).body.data).toEqual([]);
    });
  },
);
