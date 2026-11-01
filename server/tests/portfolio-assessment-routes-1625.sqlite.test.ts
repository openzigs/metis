/**
 * #1625 — `/api/portfolio-assessments` on a real SQLite database built by the
 * migration chain, over the #1622 synthetic portfolio, with real JWTs, the
 * real router, product access, federated search (fixture index) and engine.
 * Only the model is scripted.
 *
 * Users: Mia is in both workspaces, Ana and Rex in ws-a, Ola in ws-b, Sam in
 * none. Nobody is an admin: an admin bypasses every check.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import {
  getPermissionsForRole,
  type AuthPayload,
  type PortfolioAssessmentView,
} from "@metis/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";
import {
  CRYPTO_STATEMENT,
  P1,
  P2,
  P3,
  PROJECTS,
  RC_P3,
  RESET_CRITERIA,
  RESET_STATEMENT,
  WS_A,
  WS_B,
  fixtureKnowledgeService,
  scriptedProvider,
  seedPortfolio,
} from "./fixtures/portfolio-gap-1622.js";

const state = vi.hoisted(() => {
  process.env.AI_OFFLINE = "1";
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
const { jobEvents } = await import("../src/lib/socket/job-events.js");
const { resolveJobRoomScope } = await import("../src/lib/socket/room-access.js");
const { createApp } = await import("../src/app.js");

const USERS: Record<string, string[]> = {
  mia: [WS_A, WS_B],
  ana: [WS_A],
  rex: [WS_A],
  ola: [WS_B],
  sam: [],
  "rl-1625": [WS_A],
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

const REQ_A = "req-accounts-1625";
const REQ_B = "req-billing-1625";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1625 — portfolio assessment routes",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let signal: AbortSignal | undefined;

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
            get signal() {
              return signal;
            },
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

    /** Poll until the job leaves pending/running, then read it back as `who`. */
    async function settled(id: string, who: Who = "mia"): Promise<PortfolioAssessmentView> {
      for (let i = 0; i < 200; i++) {
        const row = await db.portfolioAssessment.findUnique({ where: { id } });
        if (row && row.status !== "pending" && row.status !== "running") break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const res = await get(who, `/${id}`);
      expect(res.status).toBe(200);
      return res.body.data as PortfolioAssessmentView;
    }

    async function start(who: Who, body: object): Promise<string> {
      const res = await post(who, body);
      expect(res.status).toBe(202);
      return res.body.data.id as string;
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1625-portfolio-routes");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await seedPortfolio(db, USERS);
      // Two projects, each with an analysis and a requirement.
      for (const [reqId, projectId, title] of [
        [REQ_A, PROJECTS[0].id, RESET_STATEMENT],
        [REQ_B, PROJECTS[2].id, "Invoices as PDF"],
      ] as const) {
        const analysisId = `ana-${reqId}`;
        await db.analysis.create({
          data: { id: analysisId, projectId, startedById: "mia", status: "completed" },
        });
        await db.requirement.create({
          data: {
            id: reqId,
            projectId,
            analysisId,
            title,
            body: "As a user I want it.",
            acceptanceCriteria: JSON.stringify(RESET_CRITERIA),
          },
        });
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterEach(() => {
      signal = undefined;
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    describe("POST validation", () => {
      it.each([
        ["neither statement nor requirementId", { scope: "all-accessible" }],
        [
          "both statement and requirementId",
          { statement: "s", requirementId: REQ_A, scope: "all-accessible" },
        ],
        ["a product scope naming no product", { statement: "s", scope: "product" }],
        [
          "a product scope naming two products",
          { statement: "s", scope: "product", productIds: ["p1", "p2"] },
        ],
        ["an over-long statement", { statement: "x".repeat(8_001), scope: "all-accessible" }],
        ["an unknown field", { statement: "s", scope: "all-accessible", extra: 1 }],
      ])("400 on %s", async (_label, body) => {
        const res = await post("mia", body);
        expect(res.status).toBe(400);
      });

      it("401 without a token", async () => {
        const res = await request(app())
          .post("/api/portfolio-assessments")
          .send({ statement: "s", scope: "all-accessible" });
        expect(res.status).toBe(401);
      });
    });

    describe("requirementId", () => {
      it("404 for a requirement in a project the caller cannot read", async () => {
        const res = await post("ana", { requirementId: REQ_B, scope: "all-accessible" });
        expect(res.status).toBe(404);
        expect(await db.portfolioAssessment.count({ where: { createdById: "ana" } })).toBe(0);
      });

      it("404 for a requirement that does not exist", async () => {
        const res = await post("ana", { requirementId: "req-none", scope: "all-accessible" });
        expect(res.status).toBe(404);
      });

      it("a readable requirement is assessed with its text and acceptance criteria", async () => {
        const id = await start("ana", { requirementId: REQ_A, scope: "all-accessible" });
        const v = await settled(id, "ana");
        expect(v.status).toBe("completed");
        expect(v.sourceRequirementId).toBe(REQ_A);
        expect(v.sourceProjectId).toBe(PROJECTS[0].id);
        expect(v.statement).toBe(`${RESET_STATEMENT}\n\nAs a user I want it.`);
        const p2 = v.products.find((p) => p.productId === P2)!;
        expect(p2.technicalDetail.criteria).toEqual([
          { criterion: RESET_CRITERIA[0], coveredBy: [expect.any(String)] },
          { criterion: RESET_CRITERIA[1], coveredBy: [] },
        ]);
        // Ola cannot read the source project: not readable at all.
        expect((await get("ola", `/${id}`)).status).toBe(404);
      });
    });

    it("202 → poll → completed, read back over GET, with job events", async () => {
      const started = vi.spyOn(jobEvents, "started");
      const progress = vi.spyOn(jobEvents, "progress");
      const completed = vi.spyOn(jobEvents, "completed");
      const id = await start("mia", { statement: RESET_STATEMENT, scope: "all-accessible" });
      const v = await settled(id);
      expect(v.status).toBe("completed");
      expect(v.verdict).toBe("implemented");
      expect(v.portfolioVerdict).toBe("covers");
      expect(Object.fromEntries(v.products.map((p) => [p.productId, p.coverage]))).toEqual({
        [P1]: "covers",
        [P2]: "partial",
        [P3]: "not-covered",
      });
      expect(v.productNames).toEqual({ [P1]: "Accounts", [P2]: "Support", [P3]: "Billing" });
      expect(v.summary).toContain("Implemented by Accounts (acme/accounts-api)");
      expect(started).toHaveBeenCalledWith("portfolio-assessment", id, null, expect.any(String));
      expect(progress).toHaveBeenLastCalledWith(
        "portfolio-assessment",
        id,
        null,
        100,
        "3 of 3 products checked",
      );
      expect(completed).toHaveBeenCalledWith("portfolio-assessment", id, null, expect.any(String));
    });

    it("a run that fails is recorded failed, with the generic message only", async () => {
      const failed = vi.spyOn(jobEvents, "failed");
      const controller = new AbortController();
      controller.abort(new Error("internal detail: db host 10.0.0.7"));
      signal = controller.signal;
      const id = await start("mia", { statement: RESET_STATEMENT, scope: "all-accessible" });
      const v = await settled(id);
      expect(v.status).toBe("failed");
      expect(v.products).toEqual([]);
      expect(failed).toHaveBeenCalledWith(
        "portfolio-assessment",
        id,
        null,
        "The portfolio assessment failed. Please try again.",
      );
    });

    describe("read-time access", () => {
      let miaRun: string;
      beforeAll(async () => {
        miaRun = await start("mia", { statement: RESET_STATEMENT, scope: "all-accessible" });
        await settled(miaRun);
      });

      it("a reader without one of its products sees that product restricted, with nothing about it", async () => {
        const v = await settled(miaRun, "ana");
        expect(Object.fromEntries(v.products.map((p) => [p.productId, p.coverage]))).toEqual({
          [P1]: "covers",
          [P2]: "partial",
          [P3]: "restricted",
        });
        const p3 = v.products.find((p) => p.productId === P3)!;
        expect(p3).toEqual(
          expect.objectContaining({ baSummary: "", technicalDetail: {}, edgeIds: [] }),
        );
        expect(v.repos.some((r) => r.productId === P3)).toBe(false);
        expect(v.productNames).toEqual({ [P1]: "Accounts", [P2]: "Support" });
        const text = JSON.stringify(v);
        expect(text).not.toContain("Billing");
        expect(text).not.toContain(RC_P3);
        // P1 still covers it for Ana.
        expect(v.verdict).toBe("implemented");
      });

      it("the verdict and summary are recomputed from what the reader can see", async () => {
        const v = await settled(miaRun, "ola");
        expect(Object.fromEntries(v.products.map((p) => [p.productId, p.coverage]))).toEqual({
          [P1]: "restricted",
          [P2]: "restricted",
          [P3]: "not-covered",
        });
        expect(v.verdict).toBe("could-not-verify");
        expect(v.portfolioVerdict).toBe("not-checked");
        expect(v.summary).toBe(
          "Could not verify across the portfolio: of 3 products, 2 restricted.",
        );
        const text = JSON.stringify(v);
        expect(text).not.toContain("Accounts");
        expect(text).not.toContain("accounts-api");
      });

      it("a reader who can read none of its products (and did not start it) gets 404", async () => {
        expect((await get("sam", `/${miaRun}`)).status).toBe(404);
        expect((await get("sam", `/${miaRun}/export?format=md`)).status).toBe(404);
        expect(await resolveJobRoomScope(payload("sam"), miaRun)).toBeNull();
        expect(await resolveJobRoomScope(payload("ana"), miaRun)).toEqual({
          kind: "portfolio-assessment",
          projectId: null,
        });
      });

      it("an unknown id is 404", async () => {
        expect((await get("mia", "/pa-none")).status).toBe(404);
      });

      it("access lost after the run is applied at read time, not trusted from write time", async () => {
        const id = await start("rex", {
          statement: RESET_STATEMENT,
          scope: "product",
          productIds: [P1],
        });
        const before = await settled(id, "rex");
        expect(before.products.map((p) => p.coverage)).toEqual(["covers"]);
        await db.workspaceMember.deleteMany({ where: { userId: "rex" } });
        const after = await settled(id, "rex");
        expect(after.products.map((p) => p.coverage)).toEqual(["restricted"]);
        expect(after.repos).toEqual([]);
        expect(after.verdict).toBe("could-not-verify");
        expect(JSON.stringify(after)).not.toContain("Accounts");
      });

      it("lists by product only for a reader of that product, each row re-filtered", async () => {
        const forAna = await get("ana", `?productId=${P1}`);
        expect(forAna.status).toBe(200);
        const row = forAna.body.data.find((r: { id: string }) => r.id === miaRun);
        expect(row).toEqual(
          expect.objectContaining({
            statement: RESET_STATEMENT,
            verdict: "implemented",
            productCount: 3,
          }),
        );
        expect((await get("ana", `?productId=${P3}`)).body.data).toEqual([]);
        // Ola reads P3 but not P1/P2: the row is there, its verdict re-derived.
        const forOla = await get("ola", `?productId=${P3}`);
        expect(forOla.body.data.find((r: { id: string }) => r.id === miaRun).verdict).toBe(
          "could-not-verify",
        );
        // No product: the caller's own runs, newest first.
        const own = await get("mia", "");
        expect(own.body.data.length).toBeGreaterThan(0);
        expect(own.body.data.every((r: { createdById: string }) => r.createdById === "mia")).toBe(
          true,
        );
        expect(own.body.data[0].createdAt >= own.body.data.at(-1).createdAt).toBe(true);
        expect((await get("mia", `?productId=${"x".repeat(65)}`)).status).toBe(400);
      });

      it("exports the reader's view as Markdown", async () => {
        const res = await get("ana", `/${miaRun}/export?format=md`);
        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toContain("text/markdown");
        expect(res.headers["content-disposition"]).toBe(
          `attachment; filename="portfolio-assessment-${miaRun}.md"`,
        );
        expect(res.text).toContain(RESET_STATEMENT);
        expect(res.text).toContain("| Accounts | Covers it |");
        expect(res.text).toContain(`| ${P3} | Restricted |  |`);
        expect(res.text).toContain("### Accounts: acme/accounts-api (implemented)");
        expect(res.text).not.toContain("Billing");
        expect((await get("ana", `/${miaRun}/export?format=pdf`)).status).toBe(400);
      });
    });

    it("rate-limits starts per user", async () => {
      process.env.PORTFOLIO_ASSESSMENT_START_RATE_LIMIT_MAX = "1";
      try {
        const body = { statement: CRYPTO_STATEMENT, scope: "product", productIds: [P1] };
        expect((await post("rl-1625", body)).status).toBe(202);
        const second = await post("rl-1625", body);
        expect(second.status).toBe(429);
        expect(second.body.error.code).toBe("PORTFOLIO_ASSESSMENT_RATE_LIMITED");
      } finally {
        delete process.env.PORTFOLIO_ASSESSMENT_START_RATE_LIMIT_MAX;
      }
    });

    it("CSRF: a cookie-authenticated start without X-METIS-CSRF is refused (#913)", async () => {
      const cookie = `accessToken=${issueTokens(payload("mia")).accessToken}`;
      const refused = await request(createApp())
        .post("/api/portfolio-assessments")
        .set("Cookie", cookie)
        .send({ statement: "s", scope: "all-accessible" });
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe("CSRF_REJECTED");
      // With the header it reaches the router (an invalid body, so no job starts).
      const reached = await request(createApp())
        .post("/api/portfolio-assessments")
        .set("Cookie", cookie)
        .set("X-METIS-CSRF", "1")
        .send({ scope: "all-accessible" });
      expect(reached.status).toBe(400);
    });
  },
);
