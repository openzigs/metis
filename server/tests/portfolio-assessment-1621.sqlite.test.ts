/**
 * #1621 — a portfolio assessment is written and read back through the store,
 * on a real SQLite database built by the migration chain:
 *
 * - it survives a re-run of the analysis its requirement came from (the re-run
 *   deletes and recreates every requirement), keeping its statement snapshot,
 *   with `sourceRequirementId` set to null rather than the assessment deleted;
 * - an assessment over 1,200 repos writes on SQLite, whose driver adapter
 *   refuses more than 999 bound values per statement (#1346);
 * - the write is all or nothing, and the input is validated.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/prisma.js")>();
  return {
    ...actual,
    get prisma() {
      return state.db;
    },
  };
});

const { createPortfolioAssessment, getPortfolioAssessment, rowsPerInsert } =
  await import("../src/lib/portfolio/assessment-store.js");
const { persistRequirements } = await import("../src/lib/analysis/analysis-service.js");

const USER = "u-1621";
const PROJECT = "proj-1621";
const ANALYSIS = "ana-1621";

const synthesis = (title: string) => ({
  summary: "A run.",
  requirements: [
    {
      type: "feature" as const,
      title,
      body: `${title}.`,
      priority: "medium" as const,
      labels: [],
      evidenceFindingIndexes: [],
      acceptanceCriteria: [],
    },
  ],
});

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1621 — the portfolio assessment store",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1621-portfolio-assessment");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: "u", email: `${USER}@example.test` },
      });
      await db.project.create({
        data: { id: PROJECT, name: PROJECT, slug: PROJECT, createdById: USER },
      });
      await db.analysis.create({
        data: { id: ANALYSIS, projectId: PROJECT, startedById: USER, status: "completed" },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("reads back every field it wrote", async () => {
      const id = await createPortfolioAssessment({
        statement: "Customers can export invoices as PDF.",
        sourceProjectId: PROJECT,
        scope: "all-accessible",
        productIds: ["prod-a", "prod-b"],
        status: "completed",
        portfolioVerdict: "partial",
        summary: "Billing covers part of it.",
        costUsd: 0.42,
        createdById: USER,
        products: [
          {
            productId: "prod-a",
            coverage: "partial",
            impactKind: "direct-change",
            edgeIds: [],
            baSummary: "Billing exports CSV, not PDF.",
            technicalDetail: { files: ["src/export.ts"] },
          },
          {
            productId: "prod-b",
            coverage: "not-covered",
            impactKind: "downstream-consumer",
            via: "api",
            edgeIds: ["edge-1"],
            severity: "medium",
          },
        ],
        repos: [
          {
            productId: "prod-a",
            repoConnectionId: "rc-a",
            verdict: "partial",
            citations: [{ filePath: "src/export.ts", repoConnectionId: "rc-a", startLine: 3 }],
          },
        ],
      });
      const read = await getPortfolioAssessment(id);
      expect(read).toEqual({
        id,
        statement: "Customers can export invoices as PDF.",
        sourceRequirementId: null,
        sourceProjectId: PROJECT,
        scope: "all-accessible",
        productIds: ["prod-a", "prod-b"],
        status: "completed",
        portfolioVerdict: "partial",
        summary: "Billing covers part of it.",
        costUsd: 0.42,
        createdById: USER,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        products: [
          {
            productId: "prod-a",
            coverage: "partial",
            impactKind: "direct-change",
            via: null,
            edgeIds: [],
            severity: null,
            baSummary: "Billing exports CSV, not PDF.",
            technicalDetail: { files: ["src/export.ts"] },
          },
          {
            productId: "prod-b",
            coverage: "not-covered",
            impactKind: "downstream-consumer",
            via: "api",
            edgeIds: ["edge-1"],
            severity: "medium",
            baSummary: "",
            technicalDetail: {},
          },
        ],
        repos: [
          {
            productId: "prod-a",
            repoConnectionId: "rc-a",
            verdict: "partial",
            citations: [{ filePath: "src/export.ts", repoConnectionId: "rc-a", startLine: 3 }],
          },
        ],
      });
      expect(await getPortfolioAssessment("pa-missing-1621")).toBeNull();
    });

    it("survives a re-run that recreates its requirement: statement kept, source set to null", async () => {
      const [requirementId] = await persistRequirements({
        analysisId: ANALYSIS,
        projectId: PROJECT,
        synthesis: synthesis("Single sign-on for partners"),
        findingIdsByIndex: [],
      });
      const id = await createPortfolioAssessment({
        statement: "Single sign-on for partners",
        sourceRequirementId: requirementId,
        sourceProjectId: PROJECT,
        scope: "product",
        productIds: ["prod-a"],
        createdById: USER,
        products: [{ productId: "prod-a", coverage: "covers" }],
        repos: [{ productId: "prod-a", repoConnectionId: "rc-a", verdict: "implemented" }],
      });
      expect((await getPortfolioAssessment(id))?.sourceRequirementId).toBe(requirementId);

      // The analysis is re-run: its requirement set is deleted and recreated.
      const [recreated] = await persistRequirements({
        analysisId: ANALYSIS,
        projectId: PROJECT,
        synthesis: synthesis("Single sign-on for partners and staff"),
        findingIdsByIndex: [],
      });
      expect(recreated).not.toBe(requirementId);
      expect(await db.requirement.findUnique({ where: { id: requirementId } })).toBeNull();

      const after = await getPortfolioAssessment(id);
      expect(after).toMatchObject({
        statement: "Single sign-on for partners",
        sourceRequirementId: null,
        sourceProjectId: PROJECT,
      });
      expect(after?.products).toHaveLength(1);
      expect(after?.repos).toHaveLength(1);
    });

    it("writes an assessment over 1,200 repos on SQLite", async () => {
      expect(rowsPerInsert(7) * 7).toBeLessThan(999);
      const repos = Array.from({ length: 1_200 }, (_, i) => ({
        productId: `prod-${i % 40}`,
        repoConnectionId: `rc-${i}`,
        verdict: "could-not-verify" as const,
        citations: [],
      }));
      const products = Array.from({ length: 40 }, (_, i) => ({
        productId: `prod-${i}`,
        coverage: "not-checked" as const,
      }));
      const id = await createPortfolioAssessment({
        statement: "Every product supports audit export.",
        scope: "all-accessible",
        productIds: products.map((p) => p.productId),
        createdById: USER,
        products,
        repos,
      });
      expect(await db.portfolioAssessmentRepo.count({ where: { assessmentId: id } })).toBe(1_200);
      const read = await getPortfolioAssessment(id);
      expect(read?.repos).toHaveLength(1_200);
      expect(read?.products).toHaveLength(40);
    });

    it("writes nothing when any row fails (one transaction)", async () => {
      const before = await db.portfolioAssessment.count();
      await expect(
        createPortfolioAssessment({
          statement: "Duplicate repo rows.",
          scope: "product",
          productIds: ["prod-a"],
          createdById: USER,
          repos: [
            { productId: "prod-a", repoConnectionId: "rc-dup", verdict: "implemented" },
            { productId: "prod-a", repoConnectionId: "rc-dup", verdict: "implemented" },
          ],
        }),
      ).rejects.toThrow();
      expect(await db.portfolioAssessment.count()).toBe(before);
    });

    it.each([
      ["an unknown coverage", { products: [{ productId: "p", coverage: "mostly" }] }],
      [
        "an unknown verdict",
        { repos: [{ productId: "p", repoConnectionId: "r", verdict: "yes" }] },
      ],
      ["an unknown scope", { scope: "galaxy" }],
      ["an empty statement", { statement: "   " }],
      ["a negative cost", { costUsd: -1 }],
    ])("refuses %s before writing", async (_label, over) => {
      const before = await db.portfolioAssessment.count();
      // Refused by the schema (a ZodError), not by some later accident.
      await expect(
        createPortfolioAssessment({
          statement: "S",
          scope: "product",
          productIds: [],
          createdById: USER,
          products: [],
          repos: [],
          ...(over as object),
        } as Parameters<typeof createPortfolioAssessment>[0]),
      ).rejects.toMatchObject({ name: "ZodError" });
      expect(await db.portfolioAssessment.count()).toBe(before);
    });

    it("reads an unknown stored value back as its safe default", async () => {
      const id = await createPortfolioAssessment({
        statement: "S",
        scope: "product",
        productIds: [],
        createdById: USER,
        products: [{ productId: "p", coverage: "covers" }],
        repos: [{ productId: "p", repoConnectionId: "r", verdict: "implemented" }],
      });
      await db.portfolioAssessment.update({
        where: { id },
        data: { scope: "x", status: "x", portfolioVerdict: "x", productIds: "{bad" },
      });
      await db.portfolioAssessmentProduct.updateMany({
        where: { assessmentId: id },
        data: { coverage: "x", impactKind: "x", edgeIds: "{bad", technicalDetail: "{bad" },
      });
      await db.portfolioAssessmentRepo.updateMany({
        where: { assessmentId: id },
        data: { verdict: "x", citations: "{bad" },
      });
      expect(await getPortfolioAssessment(id)).toMatchObject({
        scope: "product",
        status: "failed",
        portfolioVerdict: null,
        productIds: [],
        products: [
          { coverage: "not-checked", impactKind: "none", edgeIds: [], technicalDetail: {} },
        ],
        repos: [{ verdict: "could-not-verify", citations: [] }],
      });
    });
  },
);
