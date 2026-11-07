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
  RC_P1_API,
  RC_P1_WEB,
  RC_P2,
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
// #1673 — what each run's final write returned, so a test can wait on it rather
// than on a fixed number of ticks. The write itself is the real one.
const completions = vi.hoisted(() => ({
  waiters: new Map<string, (written: boolean) => void>(),
}));
vi.mock("../src/lib/portfolio/assessment-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/portfolio/assessment-store.js")>();
  return {
    ...actual,
    completePortfolioAssessment: async (
      ...args: Parameters<typeof actual.completePortfolioAssessment>
    ) => {
      const written = await actual.completePortfolioAssessment(...args);
      completions.waiters.get(args[0])?.(written);
      return written;
    },
  };
});
/** Resolves with what the final write of run `id` returned. */
const completionOf = (id: string) =>
  new Promise<boolean>((resolve) => completions.waiters.set(id, resolve));

const { portfolioAssessmentsRouter } = await import("../src/routes/portfolio-assessments.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { FederatedSearchService } = await import("../src/lib/rag/federated-search-service.js");
const { jobEvents } = await import("../src/lib/socket/job-events.js");
const { resolveJobRoomScope } = await import("../src/lib/socket/room-access.js");
const { createApp } = await import("../src/app.js");
const {
  completePortfolioAssessment,
  createPortfolioAssessment,
  listPortfolioAssessmentIds,
  setPortfolioAssessmentStatus,
  touchPortfolioAssessment,
} = await import("../src/lib/portfolio/assessment-store.js");
const { PORTFOLIO_ASSESSMENT_STALE_MS, sweepInterruptedPortfolioAssessments } =
  await import("../src/lib/portfolio/interrupted-assessments.js");

const USERS: Record<string, string[]> = {
  mia: [WS_A, WS_B],
  ana: [WS_A],
  rex: [WS_A],
  ola: [WS_B],
  sam: [],
  "rl-1625": [WS_A],
  // #1623's impact runs: their own start budget, so the rate-limit tests are unchanged.
  "imp-1623": [WS_A, WS_B],
  // #1668 — the stalled run, on its own start budget too.
  "stall-1668": [WS_A, WS_B],
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
const REQ_DELETED = "req-deleted-1657";

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
        ["an over-long statement", { statement: "x".repeat(8_001), scope: "all-accessible" }],
        ["an unknown field", { statement: "s", scope: "all-accessible", extra: 1 }],
      ])("400 on %s", async (_label, body) => {
        const res = await post("mia", body);
        expect(res.status).toBe(400);
      });

      // #1657 — the HTTP schema is what refuses these: each names a
      // requirement Ana cannot read, which the route would otherwise answer
      // 404 before the engine's own schema ever saw the products.
      it.each([
        ["a product scope naming two products", { scope: "product", productIds: [P1, P2] }],
        ["an all-accessible scope naming a product", { scope: "all-accessible", productIds: [P1] }],
      ])("400 on %s, from the HTTP contract", async (_label, scope) => {
        const res = await post("ana", { requirementId: REQ_B, ...scope });
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

      it("404 for a soft-deleted requirement, which is never copied into a statement (#1657)", async () => {
        await db.requirement.create({
          data: {
            id: REQ_DELETED,
            projectId: PROJECTS[0].id,
            analysisId: `ana-${REQ_A}`,
            title: "A deleted requirement",
            body: "Its text must not be assessed.",
            deletedAt: new Date(),
          },
        });
        const res = await post("ana", { requirementId: REQ_DELETED, scope: "all-accessible" });
        expect(res.status).toBe(404);
        expect(
          await db.portfolioAssessment.count({ where: { sourceRequirementId: REQ_DELETED } }),
        ).toBe(0);
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
        // #1657 — the cost is of what she sees: P1's two calls and P2's one,
        // not the decomposition, P3's call or the #1624 report call (0.01 each;
        // Mia sees all six).
        expect(v.costUsd).toBeCloseTo(0.03, 10);
        expect((await settled(miaRun, "mia")).costUsd).toBeCloseTo(0.06, 10);
      });

      it("a repo whose connection was deleted is dropped, with its citations (#1657)", async () => {
        await db.repoConnection.update({
          where: { id: RC_P1_API },
          data: { deletedAt: new Date() },
        });
        try {
          const v = await settled(miaRun, "ana");
          expect(v.repos.map((r) => r.repoConnectionId)).not.toContain(RC_P1_API);
          const p1 = v.products.find((p) => p.productId === P1)!;
          expect(JSON.stringify(p1)).not.toContain("accounts-api");
          // The hidden repo held P1's evidence, so P1 can no longer read covered.
          expect(p1.coverage).not.toBe("covers");
        } finally {
          await db.repoConnection.update({ where: { id: RC_P1_API }, data: { deletedAt: null } });
        }
      });

      it("a product its starter could not read never lists the assessment, or opens it, to that product's readers (#1657)", async () => {
        // Ana (ws-a) names Billing (ws-b): her run stores it restricted.
        const id = await start("ana", {
          statement: CRYPTO_STATEMENT,
          scope: "product",
          productIds: [P3],
        });
        const own = await settled(id, "ana");
        expect(own.products.map((p) => p.coverage)).toEqual(["restricted"]);
        // Ola reads Billing, and must learn nothing of Ana's statement.
        const list = await get("ola", `?productId=${P3}`);
        expect(list.body.data.map((r: { id: string }) => r.id)).not.toContain(id);
        expect((await get("ola", `/${id}`)).status).toBe(404);
        expect(await resolveJobRoomScope(payload("ola"), id)).toBeNull();
        // The store does not name it under Billing at all, so it takes no
        // place in a page that the per-row filter would then leave short.
        const named = await listPortfolioAssessmentIds({ productId: P3, take: 100 });
        expect(named.map((r) => r.id)).not.toContain(id);
        expect(named.map((r) => r.id)).toContain(miaRun);
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

    describe("#1623 — impact from the products that change", () => {
      const EDGE = "e-web-consumes-desk-1623";
      beforeAll(async () => {
        // Support's desk API is called by the Accounts web app (an edge on Support).
        await db.productEdge.create({
          data: {
            id: EDGE,
            productId: P2,
            sourceRepoId: RC_P1_WEB,
            targetRepoId: RC_P2,
            edgeType: "calls",
            confidence: 0.9,
            integrationKind: "api",
            strength: "contract",
            direction: "consumes",
          },
        });
      });
      afterAll(async () => {
        await db.productEdge.deleteMany({ where: { id: EDGE } });
      });

      it("the partial product and the host change; a consumer of the partial one is downstream", async () => {
        const id = await start("imp-1623", {
          statement: RESET_STATEMENT,
          scope: "all-accessible",
          hostProductId: P3,
        });
        const v = await settled(id, "imp-1623");
        expect(v.status).toBe("completed");
        expect(Object.fromEntries(v.products.map((p) => [p.productId, p.impactKind]))).toEqual({
          [P1]: "downstream-consumer",
          [P2]: "direct-change",
          [P3]: "direct-change",
        });
        const p1 = v.products.find((p) => p.productId === P1)!;
        expect(p1).toEqual(
          expect.objectContaining({ via: "api", severity: "low", edgeIds: [EDGE] }),
        );
        // Impact does not move the gap verdict.
        expect(v.verdict).toBe("implemented");
        expect(p1.coverage).toBe("covers");
        // #1725 — the host is stored and read back, named for a reader who can read it ...
        expect(v.hostProductId).toBe(P3);
        expect(v.productNames[P3]).toEqual(expect.any(String));
        expect((await db.portfolioAssessment.findUnique({ where: { id } }))?.hostProductId).toBe(
          P3,
        );
        const md = await get("imp-1623", `/${id}/export?format=md`);
        expect(md.text).toContain(`**Built by:** ${v.productNames[P3]}`);
        // ... and withheld from one who cannot read it (Ana reads only ws-a).
        const ana = await get("ana", `/${id}`);
        expect(ana.status).toBe(200);
        expect(ana.body.data.hostProductId).toBeNull();
        expect(ana.body.data.productNames).not.toHaveProperty(P3);
        expect((await get("ana", `/${id}/export?format=md`)).text).not.toContain("Built by");
      });

      describe("#1963 — a product the change does not reach, that nobody indexed", () => {
        const P_OLD = "prod-old-1963";
        const PROJ_OLD = "proj-old-1963";
        const RC_OLD = "rc-old-1963";
        beforeAll(async () => {
          // An older product in ws-a whose repo has nothing indexed: it cannot be checked.
          await db.project.create({
            data: {
              id: PROJ_OLD,
              workspaceId: WS_A,
              name: PROJ_OLD,
              slug: PROJ_OLD,
              createdById: "mia",
              status: "active",
            },
          });
          await db.repoConnection.create({
            data: {
              id: RC_OLD,
              projectId: PROJ_OLD,
              label: "old",
              ownerOrOrg: "acme",
              repoName: "old-walkthrough",
            },
          });
          await db.product.create({
            data: {
              id: P_OLD,
              name: "Old walkthrough",
              slug: P_OLD,
              workspaceId: WS_A,
              createdById: "mia",
            },
          });
          await db.productRepo.create({ data: { productId: P_OLD, repoConnectionId: RC_OLD } });
        });
        afterAll(async () => {
          await db.productRepo.deleteMany({ where: { productId: P_OLD } });
          await db.product.deleteMany({ where: { id: P_OLD } });
          await db.repoConnection.deleteMany({ where: { id: RC_OLD } });
          await db.project.deleteMany({ where: { id: PROJ_OLD } });
        });

        it("a gap every product the change touches confirms reads as a gap, the old one not in scope", async () => {
          const id = await start("imp-1623", {
            statement: CRYPTO_STATEMENT,
            scope: "all-accessible",
            hostProductId: P3,
          });
          const v = await settled(id, "imp-1623");
          expect(v.status).toBe("completed");
          const old = v.products.find((p) => p.productId === P_OLD)!;
          expect(old).toEqual(
            expect.objectContaining({ coverage: "not-checked", impactKind: "none" }),
          );
          expect(v.verdict).toBe("gap-confirmed");
          expect(v.summary).toContain(
            "Nothing checked covers this. Old walkthrough was not checked, but this change does not reach it, so it is not in scope.",
          );
          // Stored so, not only shown so.
          expect(
            (await db.portfolioAssessment.findUnique({ where: { id } }))?.portfolioVerdict,
          ).toBe("not-covered");
        });

        it("with no product that changes, the old one still stops the gap", async () => {
          const id = await start("imp-1623", {
            statement: CRYPTO_STATEMENT,
            scope: "all-accessible",
          });
          const v = await settled(id, "imp-1623");
          expect(v.verdict).toBe("could-not-verify");
          expect(v.summary).not.toContain("not in scope");
        });
      });

      it("#1725 — a run with no host reads back with none", async () => {
        const id = await start("imp-1623", { statement: RESET_STATEMENT, scope: "all-accessible" });
        expect((await settled(id, "imp-1623")).hostProductId).toBeNull();
      });

      it("lists an assessment under a product it reaches downstream, counting only its scope (#1668)", async () => {
        const id = await start("imp-1623", {
          statement: RESET_STATEMENT,
          scope: "product",
          productIds: [P2],
          hostProductId: P2,
        });
        const v = await settled(id, "imp-1623");
        // Accounts is reached outside the one-product scope.
        expect(v.products.map((p) => [p.productId, p.coverage, p.impactKind])).toEqual([
          [P1, "not-checked", "downstream-consumer"],
          [P2, expect.any(String), "direct-change"],
        ]);
        const listed = await get("imp-1623", `?productId=${P1}`);
        expect(listed.body.data.find((r: { id: string }) => r.id === id)).toEqual(
          expect.objectContaining({ productCount: 1 }),
        );
      });

      it("400 for a product scope hosting on another product", async () => {
        const res = await post("imp-1623", {
          statement: CRYPTO_STATEMENT,
          scope: "product",
          productIds: [P1],
          hostProductId: P2,
        });
        expect(res.status).toBe(400);
      });

      it("404 for a host the caller cannot read, before any job starts", async () => {
        const before = await db.portfolioAssessment.count();
        const res = await post("ana", {
          statement: CRYPTO_STATEMENT,
          scope: "all-accessible",
          hostProductId: P3,
        });
        expect(res.status).toBe(404);
        expect(await db.portfolioAssessment.count()).toBe(before);
      });

      describe("#1624 — the BA report", () => {
        /** The scripted model, except the report call, which invents a repo and a product. */
        const lyingReport = () => {
          const scripted = scriptedProvider();
          return {
            ...scripted,
            async chat(messages: Parameters<typeof scripted.chat>[0], opts?: unknown) {
              const prompt = String(messages.find((m) => m.role === "user")?.content ?? "");
              if (!prompt.includes("<<<ASSESSMENT>>>"))
                return scripted.chat(messages, opts as never);
              return {
                content: JSON.stringify({
                  summary:
                    "Support must change. The acme/refund-gateway repo must be redeployed. Accounts follows.",
                  products: [
                    {
                      ref: "P2",
                      functional: "Support sends the reset email.",
                      business: "The Ledger product loses revenue.",
                      stakeholder: "Agents stop resetting by hand.",
                    },
                  ],
                  requirements: [
                    { text: "A reset link is emailed", kind: "functional", category: null },
                    { text: "Billing emails a reset link", kind: "functional", category: null },
                    {
                      text: "The email arrives within a minute",
                      kind: "non-functional",
                      category: "performance",
                    },
                  ],
                }),
                usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
                model: "scripted-1622",
                provider: "openai" as const,
              };
            },
          };
        };
        const reportApp = () => {
          const a = express();
          a.use(express.json());
          a.use(
            "/api/portfolio-assessments",
            portfolioAssessmentsRouter({
              gap: {
                get provider() {
                  return lyingReport() as never;
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
        let id: string;

        beforeAll(async () => {
          const res = await request(reportApp())
            .post("/api/portfolio-assessments")
            .set("Authorization", bearer("imp-1623"))
            .send({ statement: RESET_STATEMENT, scope: "all-accessible", hostProductId: P3 });
          expect(res.status).toBe(202);
          id = res.body.data.id as string;
          await settled(id, "imp-1623");
        });

        it("the hallucinated repo and product never reach the persisted summary or report", async () => {
          const row = await db.portfolioAssessment.findUnique({ where: { id } });
          expect(row!.status).toBe("completed");
          for (const invented of ["refund-gateway", "Ledger"]) {
            expect(row!.summary).not.toContain(invented);
            expect(row!.report).not.toContain(invented);
          }
          expect(row!.summary).toContain("Support must change. Accounts follows.");
          const report = JSON.parse(row!.report);
          expect(report).toEqual(
            expect.objectContaining({ source: "model", degraded: false, strippedSentences: 2 }),
          );
          expect(report.requirements.map((r: { kind: string }) => r.kind)).toEqual([
            "functional",
            "functional",
            "non-functional",
          ]);
        });

        it("exports the BA summary first and the deep dive per affected product", async () => {
          const res = await get("imp-1623", `/${id}/export?format=md`);
          expect(res.status).toBe(200);
          expect(res.text.indexOf("## Summary")).toBeLessThan(res.text.indexOf("## Products"));
          expect(res.text).toContain("#### Support: Must change");
          expect(res.text).toContain("- **Stakeholder impact:** Agents stop resetting by hand.");
          expect(res.text).toContain(
            "## Non-functional requirements\n\n- **performance:** The email arrives within a minute",
          );
          expect(res.text).toContain("## Technical deep dive");
          expect(res.text).toContain("1. Support → Accounts: api, contract, confidence 0.9");
        });

        it("a reader without one of its products sees it restricted, and no model prose", async () => {
          const res = await get("ana", `/${id}/export?format=md`);
          expect(res.status).toBe(200);
          expect(res.text).toContain(`| ${P3} | Restricted |  |  |  |`);
          expect(res.text).toContain(
            `### ${P3}\n\nRestricted: you cannot read this product, so nothing about it is shown.`,
          );
          expect(res.text).not.toContain("Billing");
          // The detail route hides the model requirement that names it too.
          const detail = await get("ana", `/${id}`);
          expect(detail.status).toBe(200);
          expect(JSON.stringify(detail.body)).not.toContain("Billing");
          expect(res.text).not.toContain("Agents stop resetting by hand.");
          expect(res.text).toContain("the written summary and the impact paragraphs are not shown");
          // The requirements restate the statement the reader can read: they stay.
          expect(res.text).toContain("1. A reset link is emailed");
        });
      });
    });

    it("a list filtered after the query still fills its page from older rows (#1657)", async () => {
      // The newest 25 rows naming Accounts come from Billing's project, which
      // Ana cannot read; behind them is one she can.
      const write = async (sourceProjectId: string | null, createdAt: Date) => {
        const assessmentId = await createPortfolioAssessment({
          statement: "Paged",
          sourceRequirementId: null,
          sourceProjectId,
          scope: "product",
          productIds: [P1],
          status: "completed",
          portfolioVerdict: "not-checked",
          createdById: "sam",
          products: [{ productId: P1, coverage: "not-checked" }],
        });
        await db.portfolioAssessment.update({
          where: { id: assessmentId },
          data: { createdAt },
        });
        return assessmentId;
      };
      const readable = await write(null, new Date("2099-01-01T00:00:00Z"));
      const hidden: string[] = [];
      for (let i = 0; i < 25; i++) {
        hidden.push(await write(PROJECTS[2].id, new Date(Date.UTC(2099, 1, 1, 0, i))));
      }
      const res = await get("ana", `?productId=${P1}`);
      expect(res.status).toBe(200);
      const ids = res.body.data.map((r: { id: string }) => r.id);
      expect(ids[0]).toBe(readable);
      expect(ids.some((id: string) => hidden.includes(id))).toBe(false);
      await db.portfolioAssessment.deleteMany({ where: { id: { in: [readable, ...hidden] } } });
    });

    describe("interrupted runs (#1657)", () => {
      it("a running assessment refreshes its row while it runs", async () => {
        const slow = express();
        slow.use(express.json());
        slow.use(
          "/api/portfolio-assessments",
          portfolioAssessmentsRouter({
            gap: {
              provider: scriptedProvider({ delayMs: 60 }),
              search: federated.searchAcrossProjects.bind(federated),
              limits: { runCostCapUsd: 100, productCostCapUsd: 100, concurrency: 1 },
              costOf: () => 0.01,
            },
            heartbeatMs: 10,
          }),
        );
        slow.use(errorHandler);
        const res = await request(slow)
          .post("/api/portfolio-assessments")
          .set("Authorization", `Bearer ${issueTokens(payload("mia")).accessToken}`)
          .send({ statement: RESET_STATEMENT, scope: "all-accessible" });
        expect(res.status).toBe(202);
        const id = res.body.data.id as string;
        let first: Date | null = null;
        for (let i = 0; i < 100 && !first; i++) {
          const row = await db.portfolioAssessment.findUnique({ where: { id } });
          if (row?.status === "running") first = row.updatedAt;
          else await new Promise((r) => setTimeout(r, 5));
        }
        expect(first).not.toBeNull();
        await new Promise((r) => setTimeout(r, 80));
        const later = await db.portfolioAssessment.findUniqueOrThrow({ where: { id } });
        expect(later.status).toBe("running");
        expect(later.updatedAt.getTime()).toBeGreaterThan(first!.getTime());
        await settled(id);
      });

      it("the sweep fails a pending or running row whose heartbeat stopped, and nothing else", async () => {
        const make = async (status: "pending" | "running" | "completed", ageMs: number) => {
          const id = await createPortfolioAssessment({
            statement: `Swept ${status}`,
            scope: "all-accessible",
            productIds: [],
            status,
            createdById: "sam",
          });
          await db.portfolioAssessment.update({
            where: { id },
            data: { updatedAt: new Date(Date.now() - ageMs) },
          });
          return id;
        };
        const old = PORTFOLIO_ASSESSMENT_STALE_MS + 60_000;
        const stalePending = await make("pending", old);
        const staleRunning = await make("running", old);
        const liveRunning = await make("running", 1_000);
        const staleCompleted = await make("completed", old);
        expect(await sweepInterruptedPortfolioAssessments()).toBe(2);
        const status = async (id: string) =>
          (await db.portfolioAssessment.findUniqueOrThrow({ where: { id } })).status;
        expect(await status(stalePending)).toBe("failed");
        expect(await status(staleRunning)).toBe("failed");
        expect(await status(liveRunning)).toBe("running");
        expect(await status(staleCompleted)).toBe("completed");
        // A beat keeps a run out of the next sweep.
        await db.portfolioAssessment.update({
          where: { id: liveRunning },
          data: { updatedAt: new Date(Date.now() - old) },
        });
        await touchPortfolioAssessment(liveRunning);
        expect(await sweepInterruptedPortfolioAssessments()).toBe(0);
        expect(await status(liveRunning)).toBe("running");
        await db.portfolioAssessment.update({
          where: { id: liveRunning },
          data: { status: "completed" },
        });
      });

      it("failed is final: no status write and no completion reopens it (#1668)", async () => {
        const id = await createPortfolioAssessment({
          statement: "Final",
          scope: "product",
          productIds: [P1],
          status: "failed",
          createdById: "sam",
        });
        expect(await setPortfolioAssessmentStatus(id, "running")).toBe(false);
        expect(await setPortfolioAssessmentStatus(id, "failed")).toBe(false);
        const written = await completePortfolioAssessment(id, {
          statement: "Final",
          scope: "product",
          productIds: [P1],
          status: "completed",
          portfolioVerdict: "covers",
          createdById: "sam",
          products: [{ productId: P1, coverage: "covers" }],
        });
        expect(written).toBe(false);
        const row = await db.portfolioAssessment.findUniqueOrThrow({
          where: { id },
          include: { products: true },
        });
        // The batch rolled back whole: no verdict, and no child row either.
        expect(row.status).toBe("failed");
        expect(row.portfolioVerdict).toBeNull();
        expect(row.products).toEqual([]);
        // A run still live completes as before.
        await db.portfolioAssessment.update({ where: { id }, data: { status: "running" } });
        expect(
          await completePortfolioAssessment(id, {
            statement: "Final",
            scope: "product",
            productIds: [P1],
            status: "completed",
            createdById: "sam",
            products: [{ productId: P1, coverage: "covers" }],
          }),
        ).toBe(true);
        expect(await setPortfolioAssessmentStatus(id, "failed")).toBe(false);
        expect((await db.portfolioAssessment.findUniqueOrThrow({ where: { id } })).status).toBe(
          "completed",
        );
      });

      it("a run the sweep failed while it stalled stays failed when it finishes (#1668)", async () => {
        const completed = vi.spyOn(jobEvents, "completed");
        const failed = vi.spyOn(jobEvents, "failed");
        // The report call stalls until released, as a run whose heartbeats stopped would.
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let reportStarted!: () => void;
        const started = new Promise<void>((resolve) => (reportStarted = resolve));
        const scripted = scriptedProvider();
        const stalling = {
          ...scripted,
          async chat(messages: Parameters<typeof scripted.chat>[0], opts?: unknown) {
            const prompt = String(messages.find((m) => m.role === "user")?.content ?? "");
            if (prompt.includes("<<<ASSESSMENT>>>")) {
              reportStarted();
              await gate;
            }
            return scripted.chat(messages, opts as never);
          },
        };
        const stalled = express();
        stalled.use(express.json());
        stalled.use(
          "/api/portfolio-assessments",
          portfolioAssessmentsRouter({
            gap: {
              provider: scripted,
              search: federated.searchAcrossProjects.bind(federated),
              limits: { runCostCapUsd: 100, productCostCapUsd: 100, concurrency: 2 },
              costOf: () => 0.01,
            },
            report: { provider: stalling as never },
          }),
        );
        stalled.use(errorHandler);
        const res = await request(stalled)
          .post("/api/portfolio-assessments")
          .set("Authorization", bearer("stall-1668"))
          .send({ statement: RESET_STATEMENT, scope: "all-accessible" });
        expect(res.status).toBe(202);
        const id = res.body.data.id as string;
        await started;
        // Seen from five minutes on, the stalled row is stale: the sweep fails it, and says so.
        await sweepInterruptedPortfolioAssessments(
          Date.now() + PORTFOLIO_ASSESSMENT_STALE_MS + 1_000,
        );
        expect(failed.mock.calls.filter((c) => c[1] === id)).toHaveLength(1);
        const finished = completionOf(id);
        release();
        // #1673 — the finished run's write is refused: wait for it, not for a fixed time.
        expect(await finished).toBe(false);
        const row = await db.portfolioAssessment.findUniqueOrThrow({
          where: { id },
          include: { products: true },
        });
        expect(row.status).toBe("failed");
        expect(row.products).toEqual([]);
        expect(completed.mock.calls.filter((c) => c[1] === id)).toEqual([]);
        expect(failed.mock.calls.filter((c) => c[1] === id)).toHaveLength(1);
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
