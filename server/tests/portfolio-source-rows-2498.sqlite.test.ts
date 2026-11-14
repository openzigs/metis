/**
 * #2498 — a stored portfolio check records the requirement rows it read, so a
 * restricted row HARD-deleted since (a withheld replacement deletes it, a
 * re-synthesis deletes every row of the run and writes new ones) still hides
 * what it wrote from a reader who cannot see its sources.
 *
 * A REAL SQLite database built by the migration chain, the real router with
 * real JWTs for the start and the read, and the real source-redaction filter.
 * Each check is started through `POST /api/portfolio-assessments` (which
 * records the rows), its run is left to fail (no model here), and its result
 * is then written as a completed run would have written it, quoting each row
 * read (`title: body`, how the check writes its criteria).
 *
 * Fixture: one project, documents `d-open` and `d-secret`. `d-secret` is open
 * when Bob starts the first checks and restricted to Alice afterwards; Bob is
 * the reader who cannot see it now, Root an admin who sees everything.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import {
  getPermissionsForRole,
  RESTRICTED_SOURCE_TITLE,
  type AuthPayload,
  type PortfolioAssessmentView,
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
  process.env.AI_OFFLINE = "1";
  process.env.PORTFOLIO_ASSESSMENT_START_RATE_LIMIT_MAX = "1000";
  process.env.RATE_LIMIT_MAX = "100000";
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
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: vi.fn(),
}));
vi.mock("../src/lib/socket/registry.js", () => ({ getSocketServer: () => null }));

const { portfolioAssessmentsRouter } = await import("../src/routes/portfolio-assessments.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { parseSourceRows } = await import("../src/lib/portfolio/assessment-store.js");
const { runPortfolioGapAnalysis } = await import("../src/lib/portfolio/gap-engine.js");

const WS = "ws-2498";
const P = "proj-2498";
const PRODUCT = "prod-2498";
const SECRET = "Payroll export for the CFO";
const OPEN = "Customers can pay";
/** How a check writes a requirement as a criterion. */
const quote = (title: string) => `${title}: ${title} — body`;
const STORED_SUMMARY = "The checkout needs the billing service";

type Who = "alice" | "bob" | "root";
const ROLES: Record<Who, RoleKey> = { alice: "coordinator", bob: "coordinator", root: "admin" };

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2498 — a stored portfolio check and a restricted row hard-deleted since (real SQLite)",
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
      a.use(
        "/api/portfolio-assessments",
        portfolioAssessmentsRouter({
          gap: {
            // No model in this suite: the run fails, and the result is written below.
            get provider(): never {
              throw new Error("no model in this suite");
            },
          },
        }),
      );
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const sources = (documentIds: string[], chunkIds: string[] = []) =>
      JSON.stringify({ documentIds, chunkIds });

    /** Start a check as Bob, and wait for its run to end. */
    const start = async (body: Record<string, unknown>): Promise<string> => {
      const res = await request(app())
        .post("/api/portfolio-assessments")
        .set("Authorization", bearer("bob"))
        .send({ scope: "product", productIds: [PRODUCT], ...body });
      expect(res.status).toBe(202);
      const id = res.body.data.id as string;
      for (let i = 0; i < 300; i++) {
        const row = await db.portfolioAssessment.findUnique({ where: { id } });
        if (row && row.status !== "pending" && row.status !== "running") break;
        await new Promise((r) => setTimeout(r, 10));
      }
      return id;
    };

    /** Write the result a completed run would have, its text quoting `read`. */
    const complete = async (id: string, read: string[]) => {
      await db.portfolioAssessmentProduct.deleteMany({ where: { assessmentId: id } });
      await db.portfolioAssessment.update({
        where: { id },
        data: {
          status: "completed",
          portfolioVerdict: "partial",
          summary: read.some((t) => t.startsWith(SECRET))
            ? `${SECRET} needs the billing service`
            : STORED_SUMMARY,
          report: JSON.stringify({
            source: "model",
            degraded: false,
            requirements: read.map((t) => ({
              text: `${t}, restated`,
              kind: "functional",
              mentions: [],
            })),
            products: [],
          }),
          products: {
            create: [
              {
                productId: PRODUCT,
                coverage: "partial",
                technicalDetail: JSON.stringify({
                  criteria: read.map((criterion) => ({ criterion, coveredBy: [] })),
                }),
              },
            ],
          },
        },
      });
    };

    const view = async (who: Who, id: string): Promise<PortfolioAssessmentView> => {
      const res = await request(app())
        .get(`/api/portfolio-assessments/${id}`)
        .set("Authorization", bearer(who));
      expect(res.status).toBe(200);
      return res.body.data as PortfolioAssessmentView;
    };
    const criteriaOf = (v: PortfolioAssessmentView) =>
      (v.products[0]!.technicalDetail as { criteria: Array<{ criterion: string }> }).criteria.map(
        (c) => c.criterion,
      );

    const run = async (id: string) =>
      db.analysis.create({
        data: {
          id,
          projectId: P,
          startedById: "alice",
          status: "completed",
          completedAt: new Date(),
          title: id,
          sourceAccess: "shared",
        },
      });
    const requirement = (
      id: string,
      analysisId: string,
      title: string,
      documentId: string,
      chunkIds: string[] = [],
    ) =>
      db.requirement.create({
        data: {
          id,
          analysisId,
          projectId: P,
          title,
          body: `${title} — body`,
          reviewStatus: "approved",
          acceptanceCriteria: JSON.stringify([`${title} works`]),
          sourceIds: sources([documentId], chunkIds),
        },
      });

    /** Checks started while `d-secret` was open, and one after it was restricted. */
    const checks = {
      withheld: "",
      resynthesis: "",
      single: "",
      readOpenOnly: "",
      moved: "",
      set: "",
      starter: "",
    };
    const STARTER_ROW = "Refunds reach the bank";
    const MOVED = "Invoices show the tax";

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2498-portfolio-source-rows");
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
      // A product bound to nothing: every reader can read it.
      await db.product.create({
        data: { id: PRODUCT, name: "Billing", slug: PRODUCT, createdById: "bob" },
      });
      for (const id of ["d-open", "d-secret"]) {
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
            aclSubjects: "[]",
          },
        });
      }
      for (const cr of ["cr-withheld", "cr-resynthesis", "cr-single", "cr-open-only"]) {
        await run(cr);
        // Each open row cites a chunk too: the record keeps its documents only.
        await requirement(`${cr}-open`, cr, OPEN, "d-open", [`${cr}-chunk`]);
        await requirement(`${cr}-secret`, cr, SECRET, "d-secret");
      }

      // While d-secret is open, Bob's checks read both rows.
      checks.withheld = await start({ analysisId: "cr-withheld" });
      checks.resynthesis = await start({ analysisId: "cr-resynthesis" });
      checks.single = await start({ requirementId: "cr-single-secret" });
      // A row that cites d-secret when read, and d-open later (its evidence re-cited).
      await run("cr-moved");
      await requirement("cr-moved-row", "cr-moved", MOVED, "d-secret");
      checks.moved = await start({ analysisId: "cr-moved" });
      await complete(checks.moved, [quote(MOVED)]);
      // #2301 — a chosen set of two stored requirements, one resting on d-secret.
      await run("cr-set");
      await requirement("cr-set-open", "cr-set", OPEN, "d-open");
      await requirement("cr-set-secret", "cr-set", SECRET, "d-secret");
      checks.set = await start({ requirementIds: ["cr-set-open", "cr-set-secret"] });
      await complete(checks.set, [quote(OPEN), quote(SECRET)]);
      // #2448 — a starter run: its code pass read d-secret, and its requirement
      // records no sources (NULL), so it rests on the run as a whole.
      await db.analysis.create({
        data: {
          id: "cr-starter",
          projectId: P,
          startedById: "alice",
          status: "completed",
          completedAt: new Date(),
          title: "cr-starter",
          sourceAccess: "starter",
        },
      });
      await db.agentResult.create({
        data: {
          analysisId: "cr-starter",
          agentKey: "codebase-assessor",
          status: "completed",
          readSourceIds: sources(["d-secret"]),
        },
      });
      await db.requirement.create({
        data: {
          id: "cr-starter-row",
          analysisId: "cr-starter",
          projectId: P,
          title: STARTER_ROW,
          body: `${STARTER_ROW} — body`,
          reviewStatus: "approved",
          sourceIds: null,
        },
      });
      checks.starter = await start({ analysisId: "cr-starter" });
      await complete(checks.starter, [quote(STARTER_ROW)]);
      for (const id of [checks.withheld, checks.resynthesis]) {
        await complete(id, [quote(OPEN), quote(SECRET)]);
      }
      await complete(checks.single, [`${SECRET} works`]);
      await db.portfolioAssessment.update({
        where: { id: checks.single },
        data: { statement: `${SECRET}\n\n${SECRET} — body` },
      });

      // Now d-secret is Alice's alone: Bob's next check reads only the open row.
      await db.document.update({
        where: { id: "d-secret" },
        data: { aclSubjects: JSON.stringify([{ kind: "user", value: "alice" }]) },
      });
      checks.readOpenOnly = await start({ analysisId: "cr-open-only" });
      await complete(checks.readOpenOnly, [quote(OPEN)]);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("records, with each check, the rows it read and their sources", async () => {
      const recorded = async (id: string) =>
        parseSourceRows(
          (await db.portfolioAssessment.findUniqueOrThrow({ where: { id } })).sourceRows,
        );
      expect(await recorded(checks.withheld)).toEqual([
        { id: "cr-withheld-open", analysisId: "cr-withheld", sourceIds: sources(["d-open"]) },
        { id: "cr-withheld-secret", analysisId: "cr-withheld", sourceIds: sources(["d-secret"]) },
      ]);
      expect(await recorded(checks.single)).toEqual([
        { id: "cr-single-secret", analysisId: "cr-single", sourceIds: sources(["d-secret"]) },
      ]);
      // Bob could not see the restricted row when he started this one: not read, not recorded.
      expect(await recorded(checks.readOpenOnly)).toEqual([
        { id: "cr-open-only-open", analysisId: "cr-open-only", sourceIds: sources(["d-open"]) },
      ]);
    });

    it("runPortfolioGapAnalysis records the single row it read, its documents only", async () => {
      // Unique per attempt, so a retry does not collide with the rows it seeded.
      const cr = `cr-engine-${Date.now()}`;
      await run(cr);
      await requirement(`${cr}-open`, cr, OPEN, "d-open", [`${cr}-chunk`]);
      const noModel = {
        key: "openai",
        model: "m",
        offline: false,
        chat: async () => {
          throw new Error("no model in this suite");
        },
      };
      const { assessmentId } = await runPortfolioGapAnalysis(
        payload("bob"),
        {
          statement: OPEN,
          scope: "product",
          productIds: [PRODUCT],
          sourceRequirementId: `${cr}-open`,
        },
        {
          provider: noModel as never,
          limits: { runCostCapUsd: 1, productCostCapUsd: 1, concurrency: 1 },
        },
      );
      const row = await db.portfolioAssessment.findUniqueOrThrow({ where: { id: assessmentId } });
      expect(parseSourceRows(row.sourceRows)).toEqual([
        { id: `${cr}-open`, analysisId: cr, sourceIds: sources(["d-open"]) },
      ]);
    });

    it("a withheld replacement's hard delete does not re-open the restricted row's text to Bob", async () => {
      await db.requirement.deleteMany({ where: { id: "cr-withheld-secret" } });
      const bob = await view("bob", checks.withheld);
      expect(JSON.stringify(bob)).not.toContain("Payroll");
      expect(criteriaOf(bob)).toEqual([quote(OPEN), RESTRICTED_SOURCE_TITLE]);
      expect(bob.summary).not.toContain(SECRET);
      expect(bob.report?.requirements).toEqual([]);
      // The change request's own title is not the requirement's text: it stays.
      expect(bob.statement).toBe('Requirements of change request "cr-withheld"');
      // An admin, whom no access list restricts, still reads it all.
      const root = await view("root", checks.withheld);
      expect(criteriaOf(root)).toEqual([quote(OPEN), quote(SECRET)]);
      expect(root.summary).toBe(`${SECRET} needs the billing service`);
    });

    it("a re-synthesis that writes the run's rows anew, without the restricted one, does not either", async () => {
      await db.requirement.deleteMany({ where: { analysisId: "cr-resynthesis" } });
      await requirement(`cr-resynthesis-open-${Date.now()}`, "cr-resynthesis", OPEN, "d-open");
      const bob = await view("bob", checks.resynthesis);
      expect(JSON.stringify(bob)).not.toContain("Payroll");
      // The open row, written anew with the same text, still shows Bob its criterion.
      expect(criteriaOf(bob)).toEqual([quote(OPEN), RESTRICTED_SOURCE_TITLE]);
      expect(bob.report?.requirements).toEqual([]);
    });

    it("a single requirement hard-deleted since (its link set null) shows Bob none of its words", async () => {
      await db.requirement.deleteMany({ where: { id: "cr-single-secret" } });
      const row = await db.portfolioAssessment.findUniqueOrThrow({ where: { id: checks.single } });
      expect(row.sourceRequirementId).toBeNull();
      const bob = await view("bob", checks.single);
      expect(JSON.stringify(bob)).not.toContain("Payroll");
      expect(bob.statement).toBe(RESTRICTED_SOURCE_TITLE);
      expect(criteriaOf(bob)).toEqual([RESTRICTED_SOURCE_TITLE]);
      expect((await view("root", checks.single)).statement).toContain(SECRET);
    });

    it("a check that read only rows Bob can see still shows him its stored text", async () => {
      // The restricted row it never read is gone too: nothing it wrote drew on it.
      await db.requirement.deleteMany({ where: { id: "cr-open-only-secret" } });
      const bob = await view("bob", checks.readOpenOnly);
      expect(bob.summary).toBe(STORED_SUMMARY);
      expect(criteriaOf(bob)).toEqual([quote(OPEN)]);
      expect(bob.report?.requirements.map((r) => r.text)).toEqual([`${quote(OPEN)}, restated`]);
    });

    it("a chosen set (#2301) records its rows, and a member hard-deleted since stays hidden", async () => {
      const row = await db.portfolioAssessment.findUniqueOrThrow({ where: { id: checks.set } });
      expect(parseSourceRows(row.sourceRows)).toEqual([
        { id: "cr-set-open", analysisId: "cr-set", sourceIds: sources(["d-open"]) },
        { id: "cr-set-secret", analysisId: "cr-set", sourceIds: sources(["d-secret"]) },
      ]);
      await db.requirement.deleteMany({ where: { id: "cr-set-secret" } });
      const bob = await view("bob", checks.set);
      expect(JSON.stringify(bob)).not.toContain("Payroll");
      // Read like a change request: the open member's criterion stands, not every word.
      expect(criteriaOf(bob)).toEqual([quote(OPEN), RESTRICTED_SOURCE_TITLE]);
      expect(bob.report?.requirements).toEqual([]);
      // #2301 — the hidden member's id is withheld from Bob; the count is not.
      expect(bob.sourceRequirementIds).toEqual(["cr-set-open"]);
      expect(bob.sourceRequirementCount).toBe(2);
      const root = await view("root", checks.set);
      expect(criteriaOf(root)).toEqual([quote(OPEN), quote(SECRET)]);
      expect(root.sourceRequirementIds).toEqual(["cr-set-open", "cr-set-secret"]);
    });

    it("a starter run's row (no sources of its own) hard-deleted since is judged on the whole run, and stays hidden", async () => {
      const row = await db.portfolioAssessment.findUniqueOrThrow({
        where: { id: checks.starter },
      });
      expect(parseSourceRows(row.sourceRows)).toEqual([
        { id: "cr-starter-row", analysisId: "cr-starter", sourceIds: null },
      ]);
      await db.requirement.deleteMany({ where: { id: "cr-starter-row" } });
      const bob = await view("bob", checks.starter);
      expect(JSON.stringify(bob)).not.toContain("Refunds");
      expect(criteriaOf(bob)).toEqual([RESTRICTED_SOURCE_TITLE]);
      expect(criteriaOf(await view("root", checks.starter))).toEqual([quote(STARTER_ROW)]);
    });

    it("a recorded row that still exists is decided on its sources now, not only as recorded", async () => {
      // Recorded citing d-secret, which Bob can no longer see; it now cites d-open only.
      await db.requirement.update({
        where: { id: "cr-moved-row" },
        data: { sourceIds: sources(["d-open"]) },
      });
      const bob = await view("bob", checks.moved);
      // Its text opens what a row Bob can see says now: the criterion stands.
      expect(criteriaOf(bob)).toEqual([quote(MOVED)]);
    });

    it("a record that does not parse shows Bob none of the check's text (fail closed)", async () => {
      await db.portfolioAssessment.update({
        where: { id: checks.readOpenOnly },
        data: { sourceRows: "{not json" },
      });
      try {
        const bob = await view("bob", checks.readOpenOnly);
        expect(bob.statement).toBe(RESTRICTED_SOURCE_TITLE);
        expect(criteriaOf(bob)).toEqual([RESTRICTED_SOURCE_TITLE]);
        expect(bob.report?.requirements).toEqual([]);
        expect((await view("root", checks.readOpenOnly)).summary).toBe(STORED_SUMMARY);
      } finally {
        await db.portfolioAssessment.update({
          where: { id: checks.readOpenOnly },
          data: {
            sourceRows: JSON.stringify([
              {
                id: "cr-open-only-open",
                analysisId: "cr-open-only",
                sourceIds: sources(["d-open"]),
              },
            ]),
          },
        });
      }
    });
  },
);

describe("#2498 — parseSourceRows", () => {
  it("reads a recorded list, none, and anything else as unreadable", async () => {
    const { parseSourceRows: parse } = await import("../src/lib/portfolio/assessment-store.js");
    expect(parse(null)).toBeNull();
    expect(parse("[]")).toEqual([]);
    expect(parse('[{"id":"r","analysisId":"a","sourceIds":null,"title":"dropped"}]')).toEqual([
      { id: "r", analysisId: "a", sourceIds: null },
    ]);
    expect(parse("{not json")).toBe("unreadable");
    expect(parse('{"id":"r"}')).toBe("unreadable");
    expect(parse('[{"id":"r"}]')).toBe("unreadable");
  });
});
