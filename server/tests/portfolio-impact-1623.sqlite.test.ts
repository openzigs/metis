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
  CONTRACT_REPORTING,
  CONTRACT_V1,
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
          modifiers: [{ kind: "breaking-contract", step: 1, basis: "latest-contract-version" }],
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
        // #1668 — the walk says it stopped there, and (#1673, the owner's AC3 call) a
        // readable product it did not reach reads `restricted`, never `none`.
        expect(impact.stoppedAtRestricted).toBe(1);
        expect(of(impact, P.ledger)).toEqual(
          expect.objectContaining({
            impactKind: "restricted",
            restricted: false,
            name: "Ledger",
            via: null,
            severity: null,
            hops: [],
          }),
        );
        // The edge from a ws-b repo Ana cannot read is not walked, only counted.
        expect(of(impact, P.billing).hiddenEdgeCount).toBe(1);
        const text = JSON.stringify(impact);
        for (const hidden of ["partner-core", R.partnerCore, R.legacy, "Partner"]) {
          expect(text).not.toContain(hidden);
        }
      });

      describe("#1689 — the restricted relabel matches the walk that reads everything", () => {
        const withIdle = (who: AuthPayload, maxDepth = 4) =>
          evaluatePortfolioImpact(who, {
            directChangeProductIds: [P.billing],
            listedProductIds: [P.billing, P.ledger, P.idle],
            maxDepth,
          });
        /**
         * Idle as Ana reads it, and as Mia's walk (both workspaces: it reads
         * everything) reports it, from the same start and to the same depth. The
         * relabel is right only when the two agree: `restricted` for Ana exactly
         * where Mia's walk reaches Idle, so over-reach and under-reach both fail.
         */
        const idle = async (maxDepth = 4) => ({
          ana: of(await withIdle(ANA, maxDepth), P.idle).impactKind,
          mia: of(await withIdle(MIA, maxDepth), P.idle).impactKind,
        });
        const reached = { ana: "restricted", mia: "downstream-consumer" };
        const unreached = { ana: "none", mia: "none" };
        const edgeData = (id: string, sourceRepoId: string, targetRepoId: string | null) => ({
          id,
          productId: P.partner as string,
          sourceRepoId,
          targetRepoId,
          edgeType: "calls",
          confidence: 0.9,
          evidence: "[]",
          integrationKind: "api",
          strength: "contract",
          direction: "consumes",
        });
        /** Seed `edges`, run `body`, and remove them whatever happens. */
        const withEdges = async (
          edges: Array<ReturnType<typeof edgeData> & Record<string, unknown>>,
          body: () => Promise<void>,
        ) => {
          await db.productEdge.createMany({ data: edges });
          try {
            await body();
          } finally {
            await db.productEdge.deleteMany({ where: { id: { in: edges.map((e) => e.id) } } });
          }
        };
        // Inside Ledger: partner-core provides to Ledger's own repo, so a change
        // reaching partner-core goes on to `ledger` (#1668).
        const coreToLedger = {
          ...edgeData("e-core-ledger-1689", R.partnerCore, R.ledger),
          productId: P.ledger,
          direction: "provides",
        };

        it("a product connected to nothing the walk stopped at stays none", async () => {
          const impact = await withIdle(ANA);
          expect(impact.stoppedAtRestricted).toBe(1);
          // Ledger shares partner-core with Partner: Mia's walk reaches it.
          expect(of(impact, P.ledger).impactKind).toBe("restricted");
          expect(of(await withIdle(MIA), P.ledger).impactKind).toBe("downstream-consumer");
          expect(await idle()).toEqual(unreached);
        });

        it("an edge from the stopped product's repo to it makes it restricted, read from either end", async () => {
          // Idle consumes partner-core: a change in Partner can reach it.
          await withEdges([edgeData("e-idle-core-1680", R.idle, R.partnerCore)], async () => {
            expect(await idle()).toEqual(reached);
          });
          await withEdges(
            [{ ...edgeData("e-core-idle-1680", R.partnerCore, R.idle), direction: "provides" }],
            async () => {
              expect(await idle()).toEqual(reached);
            },
          );
        });

        it("a product that only provides to the stopped product stays none", async () => {
          // Partner's partner-core consumes Idle: nothing flows from Partner to Idle.
          await withEdges([edgeData("e-core-idle-1685", R.partnerCore, R.idle)], async () => {
            expect(await idle()).toEqual(unreached);
          });
        });

        it("two edges meeting at a resource the stopped product provides make it restricted", async () => {
          await db.productResource.create({
            data: { id: "res-drop-1680", productId: P.partner, kind: "bucket", name: "drop" },
          });
          try {
            await withEdges(
              [
                {
                  ...edgeData("e-core-drop-1680", R.partnerCore, null),
                  direction: "writes",
                  resourceId: "res-drop-1680",
                },
                { ...edgeData("e-idle-drop-1680", R.idle, null), resourceId: "res-drop-1680" },
              ],
              async () => {
                expect(await idle()).toEqual(reached);
                // A stopped repo that only reads the resource passes nothing on.
                await db.productEdge.update({
                  where: { id: "e-core-drop-1680" },
                  data: { direction: "reads" },
                });
                expect(await idle()).toEqual(unreached);
                // Only the edge from Idle's repo: it alone meets nothing.
                await db.productEdge.delete({ where: { id: "e-core-drop-1680" } });
                expect(await idle()).toEqual(unreached);
              },
            );
          } finally {
            await db.productResource.delete({ where: { id: "res-drop-1680" } });
          }
        });

        it("edges recorded by two products never meet at a resource", async () => {
          await db.productResource.create({
            data: { id: "res-two-1685", productId: P.partner, kind: "bucket", name: "two" },
          });
          try {
            await withEdges(
              [
                {
                  ...edgeData("e-core-two-1685", R.partnerCore, null),
                  direction: "writes",
                  resourceId: "res-two-1685",
                },
                // Same resource id, but recorded on Idle: not one product's resource meeting.
                {
                  ...edgeData("e-idle-two-1685", R.idle, null),
                  productId: P.idle,
                  resourceId: "res-two-1685",
                },
              ],
              async () => {
                expect(await idle()).toEqual(unreached);
              },
            );
          } finally {
            await db.productResource.delete({ where: { id: "res-two-1685" } });
          }
        });

        describe("through Ledger, which reads restricted", () => {
          const ledgerToIdle = {
            ...edgeData("e-ledger-idle-1685", R.ledger, R.idle),
            productId: P.ledger,
            direction: "provides",
          };

          it("an edge from a repo of Ledger the walk never reaches leaves it none", async () => {
            // The walk reaches Ledger at partner-core only, and nothing inside Ledger
            // leads on to `ledger`: Ledger providing to Idle does not reach it.
            await withEdges([ledgerToIdle], async () => {
              expect(await idle()).toEqual(unreached);
            });
          });

          it("once the change moves inside Ledger to that repo, it makes it restricted", async () => {
            await withEdges([coreToLedger, ledgerToIdle], async () => {
              expect(await idle()).toEqual(reached);
            });
          });

          it("against the flow it stays none", async () => {
            // Idle provides to Ledger: a change reaching Ledger does not reach Idle.
            await withEdges(
              [
                coreToLedger,
                {
                  ...edgeData("e-idle-ledger-1685", R.idle, R.ledger),
                  productId: P.ledger,
                  direction: "provides",
                },
              ],
              async () => {
                expect(await idle()).toEqual(unreached);
              },
            );
          });

          it("a resource Ledger writes and Idle uses makes it restricted", async () => {
            await db.productResource.create({
              data: { id: "res-ledger-1685", productId: P.ledger, kind: "table", name: "ledger" },
            });
            try {
              await withEdges(
                [
                  coreToLedger,
                  {
                    ...edgeData("e-ledger-res-1685", R.ledger, null),
                    productId: P.ledger,
                    direction: "writes",
                    resourceId: "res-ledger-1685",
                  },
                  {
                    ...edgeData("e-idle-res-1685", R.idle, null),
                    productId: P.ledger,
                    direction: "reads",
                    resourceId: "res-ledger-1685",
                  },
                ],
                async () => {
                  expect(await idle()).toEqual(reached);
                },
              );
            } finally {
              await db.productResource.delete({ where: { id: "res-ledger-1685" } });
            }
          });

          it("a move inside Ledger costs no depth, exactly at the depth limit", async () => {
            // Billing -> partner-core (1) -> ledger (2, Partner to Ledger) -> ledger-2
            // (3, inside Ledger: free) -> Idle (3). Only the free move gets there at 3.
            await db.repoConnection.create({
              data: {
                id: "rc-ledger-2-1692",
                projectId: "proj-a-1623",
                label: "ledger-2",
                ownerOrOrg: "acme",
                repoName: "ledger-2",
              },
            });
            await db.productRepo.create({
              data: { productId: P.ledger, repoConnectionId: "rc-ledger-2-1692" },
            });
            const inLedger = (id: string, sourceRepoId: string, targetRepoId: string) => ({
              ...edgeData(id, sourceRepoId, targetRepoId),
              productId: P.ledger,
              direction: "provides",
            });
            try {
              await withEdges(
                [
                  coreToLedger,
                  inLedger("e-ledger-ledger2-1692", R.ledger, "rc-ledger-2-1692"),
                  inLedger("e-ledger2-idle-1692", "rc-ledger-2-1692", R.idle),
                ],
                async () => {
                  expect(await idle(3)).toEqual(reached);
                  expect(await idle(2)).toEqual(unreached);
                },
              );
            } finally {
              await db.productRepo.deleteMany({ where: { repoConnectionId: "rc-ledger-2-1692" } });
              await db.repoConnection.delete({ where: { id: "rc-ledger-2-1692" } });
            }
          });

          it("no further than the run's depth: two boundaries leave it none", async () => {
            // Billing -> partner-core (1) -> ledger (2, Partner to Ledger) -> Idle (3).
            await withEdges([coreToLedger, ledgerToIdle], async () => {
              expect(await idle(2)).toEqual(unreached);
              expect(await idle(3)).toEqual(reached);
            });
          });
        });

        it("through a readable product the run does not list, it makes it restricted", async () => {
          // partner-core -> Alerts -> Idle. Alerts is not listed, and Ana can read it.
          await withEdges(
            [
              { ...edgeData("e-alerts-core-1689", R.alerts, R.partnerCore), productId: P.alerts },
              { ...edgeData("e-idle-alerts-1689", R.idle, R.alerts), productId: P.alerts },
            ],
            async () => {
              expect(await idle()).toEqual(reached);
              // Alerts itself is reached the same way, and is not listed.
              const ana = await withIdle(ANA);
              expect(ana.products.map((p) => p.productId)).not.toContain(P.alerts);
            },
          );
        });

        it("through another product the reader cannot read, it makes it restricted", async () => {
          // partner-core -> Behind (ws-b, a ws-b repo) -> Idle.
          await db.repoConnection.create({
            data: {
              id: "rc-behind-1689",
              projectId: "proj-b-1623",
              label: "behind",
              ownerOrOrg: "acme",
              repoName: "behind",
            },
          });
          await db.product.create({
            data: {
              id: "p-behind-1689",
              name: "Behind",
              slug: "p-behind-1689",
              workspaceId: "ws-b-1623",
              createdById: "mia",
            },
          });
          await db.productRepo.create({
            data: { productId: "p-behind-1689", repoConnectionId: "rc-behind-1689" },
          });
          try {
            await withEdges(
              [
                {
                  ...edgeData("e-behind-core-1689", "rc-behind-1689", R.partnerCore),
                  productId: "p-behind-1689",
                },
                {
                  ...edgeData("e-idle-behind-1689", R.idle, "rc-behind-1689"),
                  productId: "p-behind-1689",
                },
              ],
              async () => {
                expect(await idle()).toEqual(reached);
                // Nothing of Behind reaches Ana's result.
                const text = JSON.stringify(await withIdle(ANA));
                for (const hidden of ["p-behind-1689", "rc-behind-1689", "Behind"]) {
                  expect(text).not.toContain(hidden);
                }
              },
            );
          } finally {
            await db.productRepo.deleteMany({ where: { productId: "p-behind-1689" } });
            await db.product.delete({ where: { id: "p-behind-1689" } });
            await db.repoConnection.delete({ where: { id: "rc-behind-1689" } });
          }
        });

        describe("#1692 — whatever the walk could not read counts, stop or no stop", () => {
          const toIdle = (who: AuthPayload, direct: string[]) =>
            evaluatePortfolioImpact(who, {
              directChangeProductIds: direct,
              listedProductIds: [P.idle],
              maxDepth: 4,
            });
          /** Attach the ws-b repo `dedup-hidden` (Ana cannot read it) to `productId`. */
          const withHiddenRepoOn = async (productId: string, body: () => Promise<void>) => {
            await db.productRepo.create({
              data: { productId, repoConnectionId: R.dedupHidden },
            });
            try {
              await body();
            } finally {
              await db.productRepo.deleteMany({
                where: { productId, repoConnectionId: R.dedupHidden },
              });
            }
          };
          const idleConsumesHidden = {
            ...edgeData("e-idle-dhidden-1692", R.idle, R.dedupHidden),
            productId: P.idle,
          };

          it("a path through a repo of a readable product the reader cannot read reads restricted, whatever else the run stopped at", async () => {
            // Dedup X -> dedup-hidden (a repo of Alerts, readable; the edge is a
            // hidden edge to Ana) -> Idle. With Billing too, Ana's walk also stops
            // at Partner, which has nothing to do with this path: the same answer.
            await withHiddenRepoOn(P.alerts, () =>
              withEdges([idleConsumesHidden], async () => {
                const alone = await toIdle(ANA, [P.dedupX]);
                expect(alone.stoppedAtRestricted).toBe(0);
                expect(of(alone, P.dedupX).hiddenEdgeCount).toBe(1);
                const stopped = await toIdle(ANA, [P.dedupX, P.billing]);
                expect(stopped.stoppedAtRestricted).toBe(1);
                expect({
                  alone: of(alone, P.idle).impactKind,
                  stopped: of(stopped, P.idle).impactKind,
                }).toEqual({ alone: "restricted", stopped: "restricted" });
                for (const direct of [[P.dedupX], [P.dedupX, P.billing]]) {
                  expect(of(await toIdle(MIA, direct), P.idle).impactKind).toBe(
                    "downstream-consumer",
                  );
                }
                expect(JSON.stringify(alone)).not.toContain(R.dedupHidden);
              }),
            );
          });

          it("a path from a repo of a direct-change product the reader cannot read reads restricted", async () => {
            // Alerts' ws-b repo feeds Idle. Ana's walk never starts there, hides no
            // edge and stops at no product (#1258: the edge is not hers to see).
            await withHiddenRepoOn(P.alerts, () =>
              withEdges([idleConsumesHidden], async () => {
                const ana = await toIdle(ANA, [P.alerts]);
                expect(ana.stoppedAtRestricted).toBe(0);
                expect(of(ana, P.alerts).hiddenEdgeCount).toBe(0);
                expect(of(ana, P.idle).impactKind).toBe("restricted");
                expect(JSON.stringify(ana)).not.toContain(R.dedupHidden);
                expect(of(await toIdle(MIA, [P.alerts]), P.idle).impactKind).toBe(
                  "downstream-consumer",
                );
              }),
            );
          });

          it("a path along an edge recorded on a product the reader cannot read reads restricted", async () => {
            // Idle consumes Alerts, recorded on Partner (ws-b). Both repos are Ana's,
            // so it is no hidden edge, and Ana's walk stops at no product.
            await withEdges([edgeData("e-idle-alerts-1692", R.idle, R.alerts)], async () => {
              const ana = await toIdle(ANA, [P.alerts]);
              expect(ana.stoppedAtRestricted).toBe(0);
              expect(of(ana, P.alerts).hiddenEdgeCount).toBe(0);
              expect(of(ana, P.idle).impactKind).toBe("restricted");
              expect(of(await toIdle(MIA, [P.alerts]), P.idle).impactKind).toBe(
                "downstream-consumer",
              );
            });
          });

          it("nothing else is relabelled: an unreached product with no such path stays none", async () => {
            // Ana's walk from Dedup D hides the edge to dedup-hidden, but nothing
            // past it reaches Idle.
            const ana = await toIdle(ANA, [P.dedupD]);
            expect(of(ana, P.dedupX).hiddenEdgeCount).toBe(1);
            expect(of(ana, P.idle).impactKind).toBe("none");
          });
        });

        describe("#1692 — the comparison walk does only the work it needs", () => {
          type Query = { call: string; where: Record<string, { in?: string[] } | undefined> };
          /** Every query `body` makes, in order, with its `where`. */
          const queriesOf = async (body: () => Promise<unknown>): Promise<Query[]> => {
            const calls: Query[] = [];
            state.db = new Proxy(db, {
              get(target, prop, receiver) {
                const value = Reflect.get(target, prop, receiver) as unknown;
                if (typeof prop !== "string" || value === null || typeof value !== "object") {
                  return value;
                }
                return new Proxy(value as object, {
                  get(model, method) {
                    const fn = Reflect.get(model, method) as unknown;
                    if (typeof fn !== "function") return fn;
                    return (...args: unknown[]) => {
                      const where = (args[0] as { where?: Query["where"] } | undefined)?.where;
                      calls.push({ call: `${prop}.${String(method)}`, where: where ?? {} });
                      return (fn as (...a: unknown[]) => unknown).apply(model, args);
                    };
                  },
                });
              },
            });
            try {
              await body();
            } finally {
              state.db = db;
            }
            return calls;
          };
          /** Where each walk starts: the repos of its direct-change products. */
          const walkStarts = (calls: Query[]) =>
            calls.flatMap((q, i) =>
              q.call === "productRepo.findMany" && q.where.productId?.in ? [i] : [],
            );
          /** The queries of the comparison walk, the second one to start. */
          const comparison = (calls: Query[]) => {
            const starts = walkStarts(calls);
            expect(starts).toHaveLength(2);
            return { before: calls.slice(0, starts[1]), during: calls.slice(starts[1]) };
          };
          const ordersAndBilling = () =>
            evaluatePortfolioImpact(ANA, {
              directChangeProductIds: [P.orders, P.billing],
              listedProductIds: [P.idle],
            });

          it("is not run when the reader's walk left nothing out", async () => {
            // Mia reads every product and repo the walk from Dedup D touches.
            const calls = await queriesOf(async () => {
              const mia = await evaluatePortfolioImpact(MIA, {
                directChangeProductIds: [P.dedupD],
                listedProductIds: [P.idle],
              });
              expect(of(mia, P.idle).impactKind).toBe("none");
            });
            expect(walkStarts(calls)).toHaveLength(1);
          });

          it("loads a contract only for a first hop, the one hop it can raise the severity of", async () => {
            const { before, during } = comparison(await queriesOf(ordersAndBilling));
            const contractIds = (qs: Query[]) =>
              qs.flatMap((q) =>
                q.call === "productContractDoc.findFirst" && typeof q.where.id === "string"
                  ? [q.where.id as string]
                  : [],
              );
            // Reporting's edge to Notifications names a contract two hops out: the
            // reader's walk cites it, and the comparison walk never loads it.
            expect(contractIds(before)).toContain(CONTRACT_REPORTING);
            // Orders' edge to Storefront leaves a direct-change repo (#1695).
            expect(new Set(contractIds(during))).toEqual(new Set([CONTRACT_V1]));
          });

          it("an edge to a deleted repo leaves nothing out: the comparison could not follow it either", async () => {
            await db.repoConnection.create({
              data: {
                id: "rc-gone-1695",
                projectId: "proj-a-1623",
                label: "gone",
                ownerOrOrg: "acme",
                repoName: "gone",
                deletedAt: new Date("2026-11-01T00:00:00.000Z"),
              },
            });
            try {
              await withEdges(
                [
                  {
                    ...edgeData("e-fulfil-gone-1695", R.fulfil, "rc-gone-1695"),
                    productId: P.fulfil,
                    direction: "provides",
                  },
                ],
                async () => {
                  const calls = await queriesOf(async () => {
                    const ana = await evaluatePortfolioImpact(ANA, {
                      directChangeProductIds: [P.fulfil],
                      listedProductIds: [P.idle],
                    });
                    expect(of(ana, P.idle).impactKind).toBe("none");
                  });
                  expect(walkStarts(calls)).toHaveLength(1);
                },
              );
            } finally {
              await db.repoConnection.delete({ where: { id: "rc-gone-1695" } });
            }
          });

          it("reuses the repos, attachments and resources the reader's walk loaded", async () => {
            const { before, during } = comparison(await queriesOf(ordersAndBilling));
            const ids = (qs: Query[]) =>
              qs.flatMap((q) => {
                if (q.call === "repoConnection.findMany" || q.call === "productResource.findMany") {
                  return (q.where.id?.in ?? []).map((id) => `${q.call}:${id}`);
                }
                if (q.call === "productRepo.findMany") {
                  return (q.where.repoConnectionId?.in ?? []).map((id) => `${q.call}:${id}`);
                }
                return [];
              });
            const loaded = new Set(ids(before));
            expect(loaded.size).toBeGreaterThan(0);
            expect(ids(during).filter((id) => loaded.has(id))).toEqual([]);
          });

          it("stops once it has reached every product the reader's walk did not", async () => {
            // Dedup D's ws-b repo feeds Idle: the comparison reaches it at its first
            // step, and walks no further (Dedup X and Y lie beyond).
            await db.productRepo.create({
              data: { productId: P.dedupD, repoConnectionId: R.dedupHidden },
            });
            try {
              await withEdges(
                [
                  {
                    ...edgeData("e-idle-dhidden-stop-1692", R.idle, R.dedupHidden),
                    productId: P.idle,
                  },
                ],
                async () => {
                  const { during } = comparison(
                    await queriesOf(async () => {
                      const ana = await evaluatePortfolioImpact(ANA, {
                        directChangeProductIds: [P.dedupD],
                        listedProductIds: [P.idle],
                        maxDepth: 4,
                      });
                      expect(of(ana, P.idle).impactKind).toBe("restricted");
                    }),
                  );
                  // One step: the edges from Dedup D's two repos, by source and by target.
                  expect(during.filter((q) => q.call === "productEdge.findMany")).toHaveLength(2);
                },
              );
            } finally {
              await db.productRepo.deleteMany({
                where: { productId: P.dedupD, repoConnectionId: R.dedupHidden },
              });
            }
          });
        });

        describe("#1695 — a severity the comparison walk gets wrong changes what it reaches", () => {
          /**
           * Severity is not neutral to reach: `offer()` keeps a repo's more severe
           * state, and that state's product decides which moves are free.
           *
           *   Source (changes) ─ s ─(model, breaking contract)──▶ r   (in X and Y)
           *                       └─(functional)──▶ q (Y) ─(functional)──▶ r
           *   r ─▶ t (Y) ─▶ u (Target)
           *
           * With the contract, s -> r is high: r is walked as X, so r -> t crosses
           * into Y and Target is three boundaries out. Without it, s -> r is medium,
           * q -> r (high) walks r again as Y, and r -> t -> u reaches Target at two.
           * Source also holds a ws-b repo, so Ana's walk leaves something out and the
           * comparison runs.
           */
          const S = {
            source: "p-sev-s-1695",
            x: "p-sev-x-1695",
            y: "p-sev-y-1695",
            target: "p-sev-t-1695",
          };
          const SR = {
            s: "rc-sev-s-1695",
            r: "rc-sev-r-1695",
            q: "rc-sev-q-1695",
            t: "rc-sev-t-1695",
            u: "rc-sev-u-1695",
            hidden: "rc-sev-hidden-1695",
          };
          const CONTRACT = "cdoc-sev-s-1695";

          beforeAll(async () => {
            for (const [id, projectId] of [
              [SR.s, "proj-a-1623"],
              [SR.r, "proj-a-1623"],
              [SR.q, "proj-a-1623"],
              [SR.t, "proj-a-1623"],
              [SR.u, "proj-a-1623"],
              [SR.hidden, "proj-b-1623"],
            ]) {
              await db.repoConnection.create({
                data: { id, projectId, label: id, ownerOrOrg: "acme", repoName: id },
              });
            }
            for (const [id, repos] of [
              [S.source, [SR.s, SR.hidden]],
              [S.x, [SR.r]],
              [S.y, [SR.r, SR.q, SR.t]],
              [S.target, [SR.u]],
            ] as const) {
              await db.product.create({
                data: { id, name: id, slug: id, workspaceId: "ws-a-1623", createdById: "mia" },
              });
              for (const repoConnectionId of repos) {
                await db.productRepo.create({ data: { productId: id, repoConnectionId } });
              }
            }
            await db.productContractDoc.create({
              data: {
                id: CONTRACT,
                productId: S.x,
                repoId: SR.s,
                version: 1,
                contentHash: `h${CONTRACT}`,
                title: "Contract",
                diff: BREAKING_DIFF,
              },
            });
            const provides = (
              id: string,
              productId: string,
              sourceRepoId: string,
              targetRepoId: string,
              strength: string,
            ) => ({
              ...edgeData(id, sourceRepoId, targetRepoId),
              productId,
              direction: "provides",
              strength,
            });
            await db.productEdge.createMany({
              data: [
                {
                  ...provides("e-sev-1-s-r-1695", S.x, SR.s, SR.r, "model"),
                  contractDocId: CONTRACT,
                },
                provides("e-sev-2-s-q-1695", S.y, SR.s, SR.q, "functional"),
                provides("e-sev-3-q-r-1695", S.y, SR.q, SR.r, "functional"),
                provides("e-sev-4-r-t-1695", S.y, SR.r, SR.t, "functional"),
                provides("e-sev-5-t-u-1695", S.target, SR.t, SR.u, "functional"),
              ],
            });
          });

          afterAll(async () => {
            await db.productEdge.deleteMany({ where: { id: { startsWith: "e-sev-" } } });
            await db.productContractDoc.deleteMany({ where: { id: CONTRACT } });
            await db.productRepo.deleteMany({ where: { productId: { in: Object.values(S) } } });
            await db.product.deleteMany({ where: { id: { in: Object.values(S) } } });
            await db.repoConnection.deleteMany({ where: { id: { in: Object.values(SR) } } });
          });

          const target = async (maxDepth: number) => {
            const run = (who: AuthPayload) =>
              evaluatePortfolioImpact(who, {
                directChangeProductIds: [S.source],
                listedProductIds: [S.target],
                maxDepth,
              });
            return {
              ana: of(await run(ANA), S.target).impactKind,
              mia: of(await run(MIA), S.target).impactKind,
            };
          };

          it("the breaking contract makes the path one boundary longer in Mia's walk", async () => {
            const mia = await evaluatePortfolioImpact(MIA, {
              directChangeProductIds: [S.source],
              listedProductIds: [S.target],
              maxDepth: 3,
            });
            const hop = of(mia, S.x).hops[0];
            expect(hop.contract?.breaking).toBe(true);
            expect(hop.severity.severity).toBe("high");
            expect(of(mia, S.target).hops.map((h) => h.toProductId)).toEqual([S.x, S.y, S.target]);
          });

          it("exactly at the depth limit, Ana's relabel agrees with Mia's walk", async () => {
            expect(await target(2)).toEqual({ ana: "none", mia: "none" });
            expect(await target(3)).toEqual({
              ana: "downstream-consumer",
              mia: "downstream-consumer",
            });
          });
        });

        it("a listed product the caller cannot read is never relabelled", async () => {
          // Hidden is in ws-b, shares partner-core with Partner, and nothing reaches it.
          await db.product.create({
            data: {
              id: "p-hidden-1680",
              name: "Hidden",
              slug: "p-hidden-1680",
              workspaceId: "ws-b-1623",
              createdById: "mia",
            },
          });
          await db.productRepo.create({
            data: { productId: "p-hidden-1680", repoConnectionId: R.partnerCore },
          });
          try {
            const impact = await evaluatePortfolioImpact(ANA, {
              directChangeProductIds: [P.billing],
              listedProductIds: [P.billing, "p-hidden-1680"],
            });
            expect(of(impact, "p-hidden-1680")).toEqual(
              expect.objectContaining({ restricted: true, impactKind: "none" }),
            );
          } finally {
            await db.productRepo.deleteMany({ where: { productId: "p-hidden-1680" } });
            await db.product.delete({ where: { id: "p-hidden-1680" } });
          }
        });
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
        expect(impact.products.map((p) => p.impactKind)).not.toContain("restricted");
        expect(of(impact, P.billing).hiddenEdgeCount).toBe(0);
        expect(impact.stoppedAtRestricted).toBe(0);
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
          [P.ledger, "not-covered", "restricted"],
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
        // #1668 — Ledger's `restricted` carries where the walk stopped, and (#1689) by
        // which rule it was relabelled.
        expect(stored.products.find((p) => p.productId === P.ledger)!.technicalDetail).toEqual(
          expect.objectContaining({
            impact: expect.objectContaining({ stoppedAtRestricted: 1, restrictedRule: "walk" }),
          }),
        );
        // The verdict is still the gap scope's: the restricted product reached outside it is not counted.
        const view = (await viewPortfolioAssessment(await resolveReaderAccess(ANA), id))!;
        expect(view.verdict).toBe("partial");
        expect(JSON.stringify(view)).not.toContain("partner-core");
      });
    });

    describe("#1668 — traversal follow-ups", () => {
      it("impact moves inside a downstream product at no depth: Fulfilment -> Warehouse API -> Warehouse UI -> Alerts", async () => {
        const impact = await evaluatePortfolioImpact(MIA, {
          directChangeProductIds: [P.fulfil],
          listedProductIds: [P.fulfil, P.warehouse, P.alerts],
        });
        expect(impact.maxDepth).toBe(2);
        // Warehouse is listed once, by the hop that crosses into it.
        expect(of(impact, P.warehouse)).toEqual(
          expect.objectContaining({
            impactKind: "downstream-consumer",
            edgeIds: ["e-whapi-fulfil-1668"],
          }),
        );
        const alerts = of(impact, P.alerts);
        expect(alerts).toEqual(
          expect.objectContaining({
            impactKind: "downstream-consumer",
            via: "api",
            severity: "low",
            edgeIds: ["e-whapi-fulfil-1668", "e-whui-whapi-1668", "e-alerts-whui-1668"],
          }),
        );
        // The hop inside Warehouse is on the path, as evidence.
        expect(alerts.hops.map((h) => [h.fromProductId, h.toProductId])).toEqual([
          [P.fulfil, P.warehouse],
          [P.warehouse, P.warehouse],
          [P.warehouse, P.alerts],
        ]);
        expect(alerts.hops[1].consumer.repoConnectionId).toBe(R.whUi);
        // Two product boundaries: one hop of depth stops at Warehouse.
        const shallow = await evaluatePortfolioImpact(MIA, {
          directChangeProductIds: [P.fulfil],
          listedProductIds: [P.alerts],
          maxDepth: 1,
        });
        expect(of(shallow, P.alerts).impactKind).toBe("none");
      });

      it("a write between two writers of a table reaches each from the other, whatever their id order", async () => {
        const from = (direct: string, other: string) =>
          evaluatePortfolioImpact(MIA, {
            directChangeProductIds: [direct],
            listedProductIds: [direct, other],
          }).then((impact) => of(impact, other));
        // The edge runs from the lower id (Writer A): the higher one changing reaches it too.
        expect(await from(P.writerB, P.writerA)).toEqual(
          expect.objectContaining({
            impactKind: "downstream-consumer",
            via: "database",
            severity: "high",
            edgeIds: ["e-writers-1668"],
          }),
        );
        expect((await from(P.writerA, P.writerB)).impactKind).toBe("downstream-consumer");
      });

      it("a hidden edge on a repo walked twice is counted once", async () => {
        const impact = await evaluatePortfolioImpact(ANA, {
          directChangeProductIds: [P.dedupD],
          listedProductIds: [P.dedupX],
          maxDepth: 3,
        });
        const x = of(impact, P.dedupX);
        // Re-expanded by the stronger path through Dedup Y: functional/high, not contract/low.
        expect(x.severity).toBe("high");
        expect(x.edgeIds).toEqual(["e-dedup-y-d-1668", "e-dedup-x-y-1668"]);
        expect(x.hiddenEdgeCount).toBe(1);
        expect(JSON.stringify(impact)).not.toContain(R.dedupHidden);
      });

      it("a repo's two edges to one resource never pair it with itself", async () => {
        // Orders' repo both writes and reads the `orders` table, through two edges.
        await db.productEdge.createMany({
          data: ["writes", "reads"].map((direction) => ({
            id: `e-orders-self-${direction}-1668`,
            productId: P.reporting,
            sourceRepoId: R.ordersApi,
            targetRepoId: null,
            resourceId: ORDERS_TABLE,
            edgeType: direction === "writes" ? "produces" : "consumes",
            confidence: 1,
            integrationKind: "database",
            strength: direction === "writes" ? "intrusive" : "model",
            direction,
            origin: "declared",
          })),
        });
        try {
          const impact = await ordersImpact();
          // Paired with itself, Orders' repo would reach Storefront again, by a shared table.
          expect(of(impact, P.storefront)).toEqual(
            expect.objectContaining({ via: "api", edgeIds: ["e-storefront-orders-1623"] }),
          );
          for (const p of impact.products) {
            for (const h of p.hops) {
              expect(h.provider.repoConnectionId).not.toBe(h.consumer.repoConnectionId);
            }
          }
        } finally {
          await db.productEdge.deleteMany({
            where: { id: { in: ["e-orders-self-writes-1668", "e-orders-self-reads-1668"] } },
          });
        }
      });

      describe("an edge naming a contract on a repo that is not an end of it", () => {
        const LEGACY_CONTRACT = "cdoc-legacy-1668";
        beforeAll(async () => {
          await db.productContractDoc.create({
            data: {
              id: LEGACY_CONTRACT,
              productId: P.storefront,
              repoId: R.legacy,
              version: 1,
              contentHash: "h-legacy-1668",
              title: "Contract",
              diff: BREAKING_DIFF,
            },
          });
          await db.productEdge.update({
            where: { id: "e-storefront-orders-1623" },
            data: { contractDocId: LEGACY_CONTRACT },
          });
        });
        afterAll(async () => {
          await db.productEdge.update({
            where: { id: "e-storefront-orders-1623" },
            data: { contractDocId: CONTRACT_V1 },
          });
          await db.productContractDoc.delete({ where: { id: LEGACY_CONTRACT } });
        });

        it("is cited for a reader of its repo, and never raises the severity: it is not the provider's", async () => {
          const [hop] = of(await ordersImpact(MIA), P.storefront).hops;
          expect(hop.contract).toEqual(
            expect.objectContaining({ contractDocId: LEGACY_CONTRACT, repoConnectionId: R.legacy }),
          );
          // Breaking, but Legacy's: the api/contract hop stays low.
          expect(hop.severity).toEqual(
            expect.objectContaining({ severity: "low", base: "low", modifiers: [] }),
          );
        });

        it("is withheld from a reader who cannot read its repo", async () => {
          const impact = await ordersImpact(ANA);
          expect(of(impact, P.storefront).hops[0].contract).toBeNull();
          expect(JSON.stringify(impact)).not.toContain(LEGACY_CONTRACT);
        });
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
