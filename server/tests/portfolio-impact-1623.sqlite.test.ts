/**
 * #1623 — cross-product impact propagation, end to end on a real SQLite
 * database built by the migration chain, over the synthetic graph in
 * `fixtures/portfolio-impact-1623.ts`.
 *
 * Real: product access, repo access, the product graph, the contract versions,
 * the cross-project usage classifications (`crossProjectImpact`), the #1621
 * store and the #1625 read-time view. Nothing is scripted.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import {
  getPermissionsForRole,
  type AuthPayload,
  type PortfolioAssessmentInput,
} from "@metis/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";
import {
  ADDITIVE_DIFF,
  BREAKING_DIFF,
  CONTRACT_V2,
  ORDERS_TABLE,
  P,
  R,
  seedImpactGraph,
} from "./fixtures/portfolio-impact-1623.js";

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
// The connectors that write to connected systems: none may be called.
const connectorWrites = vi.hoisted(() => ({
  createDbConnector: vi.fn(),
  updateDbConnector: vi.fn(),
  deleteDbConnector: vi.fn(),
}));
vi.mock("../src/lib/connectors/db/db-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/connectors/db/db-service.js")>()),
  ...connectorWrites,
}));

const { evaluatePortfolioImpact, withImpact } =
  await import("../src/lib/portfolio/impact-engine.js");
const { createPortfolioAssessment, getPortfolioAssessment } =
  await import("../src/lib/portfolio/assessment-store.js");
const { resolveReaderAccess, viewPortfolioAssessment } =
  await import("../src/lib/portfolio/assessment-view.js");

const user = (id: "mia" | "ana", workspaces: string[]): AuthPayload => ({
  userId: id,
  username: id,
  role: "coordinator",
  permissions: getPermissionsForRole("coordinator"),
  workspaces,
});
const MIA = user("mia", ["ws-a-1623", "ws-b-1623"]);
const ANA = user("ana", ["ws-a-1623"]);

type Impact = Awaited<ReturnType<typeof evaluatePortfolioImpact>>;
const of = (impact: Impact, productId: string) => {
  const hit = impact.products.find((p) => p.productId === productId);
  if (!hit) throw new Error(`${productId} is not in the result`);
  return hit;
};
const kinds = (impact: Impact) =>
  Object.fromEntries(impact.products.map((p) => [p.productId, p.impactKind]));

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1623 — cross-product impact over typed edges",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1623-portfolio-impact");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await seedImpactGraph(db);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    const ordersImpact = (who = MIA, maxDepth?: number) =>
      evaluatePortfolioImpact(who, {
        directChangeProductIds: [P.orders],
        listedProductIds: [P.orders, P.storefront, P.reporting, P.notifications, P.idle],
        ...(maxDepth ? { maxDepth } : {}),
      });

    describe("Orders changes an API field Storefront consumes and writes a table Reporting reads", () => {
      it("a breaking field change: Storefront api/medium, Reporting database/high, each citing its evidence", async () => {
        const impact = await ordersImpact();
        expect(of(impact, P.orders)).toEqual(
          expect.objectContaining({ impactKind: "direct-change", severity: null, hops: [] }),
        );

        const store = of(impact, P.storefront);
        expect(store).toEqual(
          expect.objectContaining({
            impactKind: "downstream-consumer",
            via: "api",
            severity: "medium",
            edgeIds: ["e-storefront-orders-1623"],
          }),
        );
        const [apiHop] = store.hops;
        expect(apiHop.provider.repoConnectionId).toBe(R.ordersApi);
        expect(apiHop.consumer).toEqual({
          repoConnectionId: R.storefront,
          label: "acme/storefront",
        });
        expect(apiHop.callSites).toEqual([{ filePath: "src/checkout/order-client.ts", line: 42 }]);
        // The provider's contract item, from the contract's latest version.
        expect(apiHop.contract).toEqual(
          expect.objectContaining({
            contractDocId: CONTRACT_V2,
            version: 2,
            breaking: true,
            items: [{ id: "graphql type Order", change: "changed", breaking: true }],
          }),
        );
        expect(apiHop.severity).toEqual({
          severity: "medium",
          strength: "contract",
          base: "low",
          modifiers: [{ kind: "breaking-contract", step: 1 }],
        });

        const reporting = of(impact, P.reporting);
        expect(reporting).toEqual(
          expect.objectContaining({
            impactKind: "downstream-consumer",
            via: "database",
            severity: "high",
            edgeIds: ["e-orders-reporting-1623"],
          }),
        );
        const [dbHop] = reporting.hops;
        expect(dbHop.resource).toEqual({ kind: "table", name: "orders" });
        expect(dbHop.callSites).toEqual([{ filePath: "sql/daily-report.sql", line: 7 }]);
        // The table both projects use, from the cross-project usage classifications.
        expect(dbHop.sharedObjects).toEqual([
          { schemaName: null, objectName: "orders", objectType: "table", usageClass: "used" },
          { schemaName: null, objectName: "orders", objectType: "column", usageClass: "used" },
        ]);
        expect(dbHop.severity.modifiers).toEqual([]);
      });

      it("an additive field change: Storefront is api/low", async () => {
        await db.productContractDoc.update({
          where: { id: CONTRACT_V2 },
          data: { diff: ADDITIVE_DIFF },
        });
        try {
          const store = of(await ordersImpact(), P.storefront);
          expect(store.severity).toBe("low");
          expect(store.hops[0].contract).toEqual(expect.objectContaining({ breaking: false }));
          expect(store.hops[0].severity.modifiers).toEqual([]);
        } finally {
          await db.productContractDoc.update({
            where: { id: CONTRACT_V2 },
            data: { diff: BREAKING_DIFF },
          });
        }
      });

      it("two hops out: Notifications, through Reporting, at the weaker hop's severity", async () => {
        const n = of(await ordersImpact(), P.notifications);
        expect(n).toEqual(
          expect.objectContaining({
            impactKind: "downstream-consumer",
            via: "event",
            // database/high, then event/low: a chain is as severe as its weakest hop.
            severity: "low",
            edgeIds: ["e-orders-reporting-1623", "e-notifier-reporting-1623"],
          }),
        );
        expect(n.hops.map((h) => [h.fromProductId, h.toProductId])).toEqual([
          [P.orders, P.reporting],
          [P.reporting, P.notifications],
        ]);
        // A contract further out is cited, never counted: only the first hop's provider changes.
        expect(n.hops[1].contract).toEqual(expect.objectContaining({ breaking: true }));
        expect(n.hops[1].severity.modifiers).toEqual([]);
      });

      it("a path is as severe as its weakest hop, even when a later hop is stronger", async () => {
        // Orders -> Reporting becomes a loose contract; Reporting -> Notifications intrusive.
        await db.productEdge.update({
          where: { id: "e-orders-reporting-1623" },
          data: { strength: "contract" },
        });
        await db.productEdge.update({
          where: { id: "e-notifier-reporting-1623" },
          data: { strength: "intrusive" },
        });
        try {
          const n = of(await ordersImpact(), P.notifications);
          expect(n.hops.map((h) => h.severity.severity)).toEqual(["low", "high"]);
          expect(n.severity).toBe("low");
        } finally {
          await db.productEdge.update({
            where: { id: "e-orders-reporting-1623" },
            data: { strength: "intrusive" },
          });
          await db.productEdge.update({
            where: { id: "e-notifier-reporting-1623" },
            data: { strength: "contract" },
          });
        }
      });

      it("impact runs from provider to consumer: Storefront changing does not reach Orders", async () => {
        const impact = await evaluatePortfolioImpact(MIA, {
          directChangeProductIds: [P.storefront],
          listedProductIds: [P.orders, P.storefront],
        });
        // Storefront consumes the Orders API: a change to Storefront breaks nothing in Orders.
        expect(of(impact, P.orders).impactKind).toBe("none");
      });

      it("the depth cap stops the walk: one hop leaves Notifications unaffected", async () => {
        const impact = await ordersImpact(MIA, 1);
        expect(impact.maxDepth).toBe(1);
        expect(of(impact, P.notifications).impactKind).toBe("none");
        expect(of(impact, P.reporting).impactKind).toBe("downstream-consumer");
      });

      it("a product nothing reaches stays in the result as none", async () => {
        expect(of(await ordersImpact(), P.idle)).toEqual(
          expect.objectContaining({ impactKind: "none", severity: null, edgeIds: [], hops: [] }),
        );
      });

      it("a low-confidence edge drops a step", async () => {
        await db.productEdge.update({
          where: { id: "e-orders-reporting-1623" },
          data: { confidence: 0.3 },
        });
        try {
          const reporting = of(await ordersImpact(), P.reporting);
          expect(reporting.severity).toBe("medium");
          expect(reporting.hops[0].severity.modifiers).toEqual([
            { kind: "low-confidence", step: -1, confidence: 0.3 },
          ]);
        } finally {
          await db.productEdge.update({
            where: { id: "e-orders-reporting-1623" },
            data: { confidence: 0.8 },
          });
        }
      });
    });

    it("two edges meeting at a shared table: the writer reaches the other user", async () => {
      // A declared repo -> table edge each, no target repo: paired through the resource.
      await db.productEdge.createMany({
        data: [
          {
            id: "e-orders-writes-table-1623",
            productId: P.reporting,
            sourceRepoId: R.ordersApi,
            targetRepoId: null,
            resourceId: ORDERS_TABLE,
            edgeType: "produces",
            confidence: 1,
            integrationKind: "database",
            strength: "intrusive",
            direction: "writes",
            origin: "declared",
          },
          {
            id: "e-notifier-reads-table-1623",
            productId: P.reporting,
            sourceRepoId: R.notifier,
            targetRepoId: null,
            resourceId: ORDERS_TABLE,
            edgeType: "consumes",
            confidence: 0.9,
            integrationKind: "database",
            strength: "model",
            direction: "reads",
            origin: "declared",
          },
        ],
      });
      try {
        const n = of(await ordersImpact(), P.notifications);
        expect(n).toEqual(
          expect.objectContaining({
            via: "database",
            // The pair is as strong as its stronger edge: the write is intrusive.
            severity: "high",
            edgeIds: ["e-orders-writes-table-1623", "e-notifier-reads-table-1623"],
          }),
        );
        expect(n.hops).toHaveLength(1);
        expect(n.hops[0].resource).toEqual({ kind: "table", name: "orders" });
        expect(n.hops[0].origin).toBe("declared");
      } finally {
        await db.productEdge.deleteMany({
          where: { id: { in: ["e-orders-writes-table-1623", "e-notifier-reads-table-1623"] } },
        });
      }
    });

    it("a cycle terminates and lists each product once", async () => {
      const impact = await evaluatePortfolioImpact(MIA, {
        directChangeProductIds: [P.cycA],
        listedProductIds: [P.cycA, P.cycB, P.cycC],
        maxDepth: 4,
      });
      expect(impact.products.map((p) => p.productId)).toEqual([P.cycA, P.cycB, P.cycC]);
      expect(kinds(impact)).toEqual({
        [P.cycA]: "direct-change",
        [P.cycB]: "downstream-consumer",
        [P.cycC]: "downstream-consumer",
      });
      // Cycle A is never downstream of itself, though Cycle B's repo points back at it.
      expect(of(impact, P.cycA).hops).toEqual([]);
    });

    describe("across two workspaces", () => {
      const billing = (who: AuthPayload) =>
        evaluatePortfolioImpact(who, {
          directChangeProductIds: [P.billing],
          listedProductIds: [P.billing, P.ledger],
        });

      it("a product reached only through a product the caller cannot read is restricted, with no content", async () => {
        const impact = await billing(ANA);
        expect(of(impact, P.partner)).toEqual({
          productId: P.partner,
          name: null,
          restricted: true,
          impactKind: "downstream-consumer",
          via: null,
          severity: null,
          edgeIds: [],
          hops: [],
          hiddenEdgeCount: 0,
        });
        // Not walked through: Ledger is only reachable via Partner's own edges.
        expect(of(impact, P.ledger).impactKind).toBe("none");
        // The edge from a ws-b repo Ana cannot read is not walked, only counted.
        expect(of(impact, P.billing).hiddenEdgeCount).toBe(1);
        const text = JSON.stringify(impact);
        for (const hidden of ["partner-core", R.partnerCore, R.legacy, "Partner"]) {
          expect(text).not.toContain(hidden);
        }
      });

      it("a reader of both workspaces sees the whole path", async () => {
        const impact = await billing(MIA);
        expect(of(impact, P.partner)).toEqual(
          expect.objectContaining({
            restricted: false,
            name: "Partner",
            via: "api",
            severity: "low",
          }),
        );
        expect(of(impact, P.ledger).impactKind).toBe("downstream-consumer");
        expect(of(impact, P.billing).hiddenEdgeCount).toBe(0);
      });

      it("persisted and read back, the restricted product carries nothing but its id and impact kind", async () => {
        const impact = await billing(ANA);
        const detail = {
          reason: null,
          criteria: [{ criterion: "c", coveredBy: [] }],
          repos: [],
          inaccessibleRepoCount: 0,
          costUsd: 0,
        };
        const input: PortfolioAssessmentInput = {
          statement: "Bill partners monthly",
          scope: "all-accessible",
          productIds: [P.billing, P.ledger],
          status: "completed",
          portfolioVerdict: "partial",
          createdById: "ana",
          products: [
            { productId: P.billing, coverage: "partial", technicalDetail: detail },
            { productId: P.ledger, coverage: "not-covered", technicalDetail: detail },
          ],
        };
        const id = await createPortfolioAssessment(withImpact(input, impact));
        const stored = (await getPortfolioAssessment(id))!;
        expect(stored.products.map((p) => [p.productId, p.coverage, p.impactKind])).toEqual([
          [P.partner, "restricted", "downstream-consumer"],
          [P.billing, "partial", "direct-change"],
          [P.ledger, "not-covered", "none"],
        ]);
        const partner = stored.products.find((p) => p.productId === P.partner)!;
        expect(partner).toEqual(
          expect.objectContaining({
            via: null,
            edgeIds: [],
            severity: null,
            baSummary: "",
            technicalDetail: {},
          }),
        );
        expect(stored.products.find((p) => p.productId === P.billing)!.technicalDetail).toEqual(
          expect.objectContaining({ impact: expect.objectContaining({ hiddenEdgeCount: 1 }) }),
        );
        // The verdict is still the gap scope's: the restricted product reached outside it is not counted.
        const view = (await viewPortfolioAssessment(await resolveReaderAccess(ANA), id))!;
        expect(view.verdict).toBe("partial");
        expect(JSON.stringify(view)).not.toContain("partner-core");
      });
    });

    it("is read-only: no write to the database or to any connected system", async () => {
      const calls: string[] = [];
      const recording = new Proxy(db, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver) as unknown;
          if (typeof prop === "string" && prop.startsWith("$")) {
            return (...args: unknown[]) => {
              calls.push(prop);
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          if (typeof prop !== "string" || value === null || typeof value !== "object") return value;
          return new Proxy(value as object, {
            get(model, method) {
              const fn = Reflect.get(model, method) as unknown;
              if (typeof fn !== "function") return fn;
              return (...args: unknown[]) => {
                calls.push(`${prop}.${String(method)}`);
                return (fn as (...a: unknown[]) => unknown).apply(model, args);
              };
            },
          });
        },
      });
      state.db = recording;
      try {
        await ordersImpact();
        await evaluatePortfolioImpact(MIA, { directChangeProductIds: [P.billing] });
      } finally {
        state.db = db;
      }
      expect(calls.length).toBeGreaterThan(0);
      const reads = /\.(findMany|findFirst|findUnique|count)$/;
      expect(calls.filter((c) => !reads.test(c))).toEqual([]);
      for (const write of Object.values(connectorWrites)) expect(write).not.toHaveBeenCalled();
    });
  },
);
