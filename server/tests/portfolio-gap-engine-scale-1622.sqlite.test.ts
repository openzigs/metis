/**
 * #1622 — the portfolio gap analysis engine at scale, and with repos the
 * caller cannot read, on a real SQLite database built by the migration chain.
 *
 * - Over 1,000 reachable projects and products on SQLite, whose driver adapter
 *   refuses a statement binding more than 999 values (#1346), the engine reads
 *   its scope and writes its assessment without error.
 * - A product carrying a repo the caller cannot read (#1258) is never
 *   `not-covered` on the strength of the repos it can: the hidden one was not
 *   checked.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole, type AuthPayload } from "@metis/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";
import {
  CRYPTO_CRITERIA,
  CRYPTO_STATEMENT,
  fixtureKnowledgeService,
  scriptedProvider,
} from "./fixtures/portfolio-gap-1622.js";

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
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { runPortfolioGapAnalysis } = await import("../src/lib/portfolio/gap-engine.js");
const { getPortfolioAssessment } = await import("../src/lib/portfolio/assessment-store.js");
const { FederatedSearchService } = await import("../src/lib/rag/federated-search-service.js");

const N = 1_050;
const ZED: AuthPayload = {
  userId: "zed",
  username: "zed",
  role: "coordinator",
  permissions: getPermissionsForRole("coordinator"),
  workspaces: [],
};
const limits = { runCostCapUsd: 100, productCostCapUsd: 100, concurrency: 8 };
const pad = (i: number) => String(i).padStart(4, "0");

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1622 — portfolio gap analysis at scale and over hidden repos",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1622-portfolio-gap-scale");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: "zed", username: "zed", displayName: "z", email: "zed@example.test" },
      });
      // Workspace-less projects are open to every non-admin: Zed reaches all N.
      await db.project.createMany({
        data: Array.from({ length: N }, (_, i) => ({
          id: `proj-${pad(i)}`,
          name: `p${i}`,
          slug: `proj-${pad(i)}-1622`,
          createdById: "zed",
          status: "active",
        })),
      });
      await db.repoConnection.createMany({
        data: Array.from({ length: N }, (_, i) => ({
          id: `rc-${pad(i)}`,
          projectId: `proj-${pad(i)}`,
          label: `repo-${i}`,
        })),
      });
      // N one-repo products, and one product carrying all N repos.
      await db.product.createMany({
        data: [
          ...Array.from({ length: N }, (_, i) => ({
            id: `prod-${pad(i)}`,
            name: `Product ${i}`,
            slug: `prod-${pad(i)}-1622`,
            createdById: "zed",
          })),
          { id: "prod-big", name: "Big", slug: "prod-big-1622", createdById: "zed" },
        ],
      });
      await db.productRepo.createMany({
        data: Array.from({ length: N }, (_, i) => [
          { productId: `prod-${pad(i)}`, repoConnectionId: `rc-${pad(i)}` },
          { productId: "prod-big", repoConnectionId: `rc-${pad(i)}` },
        ]).flat(),
      });

      // A product with one repo Zed can read and one in a workspace he is not in.
      await db.workspace.create({ data: { id: "ws-x-1622", name: "x", slug: "ws-x-1622" } });
      await db.project.create({
        data: {
          id: "proj-hidden",
          name: "hidden",
          slug: "proj-hidden-1622",
          createdById: "zed",
          workspaceId: "ws-x-1622",
          status: "active",
        },
      });
      await db.repoConnection.create({
        data: { id: "rc-hidden", projectId: "proj-hidden", label: "secret-repo" },
      });
      await db.repoConnection.create({
        data: { id: "rc-visible", projectId: "proj-0000", label: "visible-repo" },
      });
      await db.product.create({
        data: { id: "prod-mixed", name: "Mixed", slug: "prod-mixed-1622", createdById: "zed" },
      });
      for (const repoConnectionId of ["rc-hidden", "rc-visible"]) {
        await db.productRepo.create({ data: { productId: "prod-mixed", repoConnectionId } });
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it(`assesses every one of ${N}+ accessible products on SQLite without error`, async () => {
      const searched: number[] = [];
      const { assessmentId } = await runPortfolioGapAnalysis(
        ZED,
        { statement: CRYPTO_STATEMENT, criteria: CRYPTO_CRITERIA, scope: "all-accessible" },
        {
          provider: scriptedProvider(),
          limits,
          costOf: () => 0,
          // Every project answers, with nothing: no index.
          search: async ({ projectIds = [] }) => {
            searched.push(projectIds.length);
            return {
              hits: [],
              projectsSearched: projectIds,
              projectsFailed: [],
              totalHits: 0,
              projectsWithoutHits: [],
              failures: [],
              projectsRejected: 0,
              projectNames: {},
            };
          },
        },
      );
      const read = (await getPortfolioAssessment(assessmentId))!;
      const total = await db.product.count();
      expect(total).toBeGreaterThan(N);
      expect(read.products.length).toBe(total);
      expect(read.productIds.length).toBe(total);
      expect(read.products.every((p) => p.coverage === "not-checked")).toBe(true);
      // prod-big's search covered all N of its projects in one call.
      expect(Math.max(...searched)).toBe(N);
      expect(read.repos.length).toBe(N * 2 + 1);
    });

    it(`one product over ${N} repos runs through the real federated search on SQLite`, async () => {
      const federated = new FederatedSearchService({
        knowledgeService: fixtureKnowledgeService([], {}),
      });
      const { assessmentId } = await runPortfolioGapAnalysis(
        ZED,
        {
          statement: CRYPTO_STATEMENT,
          criteria: CRYPTO_CRITERIA,
          scope: "product",
          productIds: ["prod-big"],
        },
        {
          provider: scriptedProvider(),
          limits,
          costOf: () => 0,
          search: federated.searchAcrossProjects.bind(federated),
        },
      );
      const read = (await getPortfolioAssessment(assessmentId))!;
      expect(read.products).toEqual([
        expect.objectContaining({ productId: "prod-big", coverage: "not-checked" }),
      ]);
      expect(read.repos.length).toBe(N);
    });

    it("a product with a hidden repo is not-checked, never not-covered, and the hidden repo stays hidden", async () => {
      const provider = scriptedProvider();
      const federated = new FederatedSearchService({
        knowledgeService: fixtureKnowledgeService(
          [
            { id: "rc-visible", projectId: "proj-0000" },
            { id: "rc-hidden", projectId: "proj-hidden" },
          ],
          {
            "rc-visible": [{ path: "src/invoice.ts", text: "export function renderInvoice() {}" }],
            "rc-hidden": [{ path: "src/pay.ts", text: "export function acceptCryptoPayment() {}" }],
          },
        ),
      });
      const { assessmentId } = await runPortfolioGapAnalysis(
        ZED,
        {
          statement: CRYPTO_STATEMENT,
          criteria: CRYPTO_CRITERIA,
          scope: "product",
          productIds: ["prod-mixed"],
        },
        {
          provider,
          limits,
          costOf: () => 0,
          search: federated.searchAcrossProjects.bind(federated),
        },
      );
      const read = (await getPortfolioAssessment(assessmentId))!;
      const [mixed] = read.products;
      expect(mixed.coverage).toBe("not-checked");
      expect(mixed.technicalDetail.reason).toBe("repos-restricted");
      expect(mixed.technicalDetail.inaccessibleRepoCount).toBe(1);
      expect(read.repos).toEqual([
        expect.objectContaining({ repoConnectionId: "rc-visible", verdict: "gap-confirmed" }),
      ]);
      expect(JSON.stringify(read)).not.toContain("rc-hidden");
      expect(provider.prompts.join("\n")).not.toContain("acceptCryptoPayment");
    });
  },
);
