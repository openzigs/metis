/**
 * #1724 — edges across products of one workspace: detection pairs a product's
 * repos with the readable repos of the other products homed in its workspace,
 * a declared edge may end at one, and two products' resources of one kind and
 * name meet in the impact walk. On a real SQLite database built by the
 * migration chain, through `POST /api/products/:id/analyze` over real clones,
 * `GET /api/products/:id` and the portfolio impact engine.
 *
 * Fixtures: `fixtures/products/portfolio-1724/{orders,billing,notify}` are the
 * TypeScript sources of `openzigs/metis-fixture-{orders,billing,notify}`. As one
 * product they hold exactly 7 detected edges: an API spec reference, the
 * `order.created` and `invoice.issued` topics, the `orders`, `customers` and
 * `invoices` tables, and a shared type.
 *
 * Bob is a WS1 member; Ada is an admin. Project A is in WS1, project B in WS2,
 * and project C in WS1 is soft-deleted, so Bob cannot read its repo `closed`,
 * which Far carries beside its own.
 * Orders, Billing and Notify are WS1 products of one repo each. Shadow is a WS2
 * product whose repo is in project N, which has no workspace (legacy, open to
 * every member), and Stray a WS1 product carrying a project-B repo (a row of the
 * pre-#1257 kind); both clones hold Notify's sources, so a run that paired
 * across a workspace boundary would find edges to them.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole, type AuthPayload, type RoleKey } from "@metis/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
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
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { productsRouter } = await import("../src/routes/products-multi.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { runProductEdgeDetection, MAX_CROSS_PRODUCT_REPOS } =
  await import("../src/lib/products/edge-detection.js");
const { listReadableSiblingRepos } = await import("../src/lib/products/workspace-siblings.js");
const { createCloneFileLoader } = await import("../src/lib/products/clone-file-loader.js");
const { evaluatePortfolioImpact } = await import("../src/lib/portfolio/impact-engine.js");
const { assertEdgeReferencesInProduct } = await import("../src/lib/products/product-edges.js");

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "products",
  "portfolio-1724",
);
const WS1 = "ws1-1724";
const WS2 = "ws2-1724";
const PA = "proj-a-1724";
const PB = "proj-b-1724";
const PC = "proj-c-1724";
const PN = "proj-n-1724";

const USERS: Record<string, { role: RoleKey; ws: string }> = {
  bob: { role: "coordinator", ws: WS1 },
  ada: { role: "admin", ws: WS2 },
};
type Who = keyof typeof USERS;
const userPayload = (who: Who): AuthPayload => ({
  userId: who,
  username: who,
  role: USERS[who].role,
  permissions: getPermissionsForRole(USERS[who].role),
  workspaces: [USERS[who].ws],
});

/** Repo connection ids, sorted as named so sibling order is predictable. */
const R = {
  orders: "rc-1-orders-1724",
  billing: "rc-2-billing-1724",
  notify: "rc-3-notify-1724",
  idle: "rc-4-idle-1724",
  far: "rc-5-far-1724",
  alpha: "rc-6-alpha-1724",
  beta: "rc-7-beta-1724",
  shadow: "rc-8-shadow-1724",
  stray: "rc-9-stray-1724",
  ledger: "rc-a-ledger-1724",
  vault: "rc-b-vault-1724",
  closed: "rc-c-closed-1724",
} as const;
const P = {
  orders: "p-orders-1724",
  billing: "p-billing-1724",
  notify: "p-notify-1724",
  idle: "p-idle-1724",
  far: "p-far-1724",
  alpha: "p-alpha-1724",
  beta: "p-beta-1724",
  shadow: "p-shadow-1724",
  stray: "p-stray-1724",
  ledger: "p-ledger-1724",
  vault: "p-vault-1724",
} as const;

/** The 7 ground-truth edges, as `source>target:type:resource`. */
const GROUND_TRUTH = [
  `${R.billing}>${R.orders}:calls:`,
  // The shared type is oriented by repo id, not by who owns it (#1727).
  `${R.billing}>${R.orders}:imports:`,
  `${R.notify}>${R.billing}:consumes:topic/invoice.issued`,
  `${R.billing}>${R.orders}:consumes:topic/order.created`,
  `${R.orders}>${R.billing}:produces:table/orders`,
  `${R.orders}>${R.billing}:produces:table/customers`,
  `${R.billing}>${R.notify}:produces:table/invoices`,
].sort();

interface EdgeBody {
  id: string;
  productId: string;
  sourceRepoId: string;
  targetRepoId: string | null;
  resourceId: string | null;
  edgeType: string;
  origin: string;
  strength: string | null;
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1724 — edges across products of one workspace",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let tmp: string;
    const originalCloneDir = process.env.REPO_CLONE_DIR;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/products", productsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const bearer = (who: Who) => `Bearer ${issueTokens(userPayload(who)).accessToken}`;
    const analyze = (productId: string, who: Who = "bob") =>
      request(app()).post(`/api/products/${productId}/analyze`).set("Authorization", bearer(who));
    const getProduct = async (productId: string, who: Who = "bob") => {
      const res = await request(app())
        .get(`/api/products/${productId}`)
        .set("Authorization", bearer(who));
      expect(res.status).toBe(200);
      return {
        text: res.text,
        body: {
          data: res.body.data as {
            edges: EdgeBody[];
            resources: Array<{ id: string; kind: string; name: string }>;
            linkedRepos: Array<{
              repoConnectionId: string;
              label: string;
              productId: string;
              productName: string;
            }>;
          },
        },
      };
    };
    /** #1732 — the product's generated documents, as `who` may read them. */
    const documents = async (productId: string, who: Who = "bob") => {
      const res = await request(app())
        .get(`/api/products/${productId}/documents`)
        .set("Authorization", bearer(who));
      expect(res.status).toBe(200);
      return res.body.data as Array<{
        docType: string;
        repoId: string | null;
        content: string;
        metadata: string;
      }>;
    };
    const unifiedDoc = async (productId: string, who: Who = "bob") => {
      const doc = (await documents(productId, who)).find(
        (d) => d.docType === "unified-architecture",
      );
      expect(doc, "the unified architecture document").toBeDefined();
      return doc!;
    };
    const send = (method: "post" | "patch" | "delete", url: string, who: Who, body?: object) =>
      request(app())[method](url).set("Authorization", bearer(who)).send(body);
    /** The key detection matches an edge by, with the resource's kind and name. */
    const keyOf = async (e: {
      sourceRepoId: string;
      targetRepoId: string | null;
      edgeType: string;
      resourceId: string | null;
    }) => {
      const r = e.resourceId
        ? await db.productResource.findUnique({ where: { id: e.resourceId } })
        : null;
      return `${e.sourceRepoId}>${e.targetRepoId}:${e.edgeType}:${r ? `${r.kind}/${r.name}` : ""}`;
    };
    const keysOn = async (productId: string) =>
      (
        await Promise.all(
          (await db.productEdge.findMany({ where: { productId } })).map((e) => keyOf(e)),
        )
      ).sort();

    /** A clone of `connectorId` under the clone root, as ingest leaves one. */
    const makeClone = (connectorId: string, fixture: string) => {
      const dir = path.join(tmp, "clones", connectorId);
      cpSync(path.join(FIXTURES, fixture), dir, { recursive: true });
      mkdirSync(path.join(dir, ".git"), { recursive: true });
      writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    };

    const ordersImpact = (who: Who, listed: string[], maxDepth?: number) =>
      evaluatePortfolioImpact(
        userPayload(who),
        {
          directChangeProductIds: [P.orders],
          listedProductIds: [P.orders, ...listed],
          ...(maxDepth ? { maxDepth } : {}),
        },
        // No cross-project usage: the walk alone is under test.
        { sharedObjects: async () => ({ affectedObjects: [] }) as never },
      );
    const of = (impact: Awaited<ReturnType<typeof ordersImpact>>, productId: string) => {
      const hit = impact.products.find((p) => p.productId === productId);
      if (!hit) throw new Error(`${productId} is not in the result`);
      return hit;
    };

    beforeAll(async () => {
      tmp = mkdtempSync(path.join(os.tmpdir(), "metis-1724-"));
      process.env.REPO_CLONE_DIR = path.join(tmp, "clones");
      sqlite = createMigratedSqlite("1724-cross-product-edges");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const key of ["coordinator", "admin"]) {
        await db.role.create({ data: { id: `role-${key}`, key, name: key } });
      }
      for (const [id, u] of Object.entries(USERS)) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
        await db.userRole.create({ data: { userId: id, roleId: `role-${u.role}` } });
      }
      for (const ws of [WS1, WS2]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      for (const [userId, u] of Object.entries(USERS)) {
        await db.workspaceMember.create({ data: { workspaceId: u.ws, userId, role: "member" } });
      }
      for (const [id, workspaceId] of [
        [PA, WS1],
        [PB, WS2],
        [PC, WS1],
        [PN, null],
      ] as const) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById: "bob", workspaceId, status: "active" },
        });
      }
      await db.project.update({ where: { id: PC }, data: { deletedAt: new Date() } });
      const repos: Array<[keyof typeof R, string, string | null]> = [
        ["orders", PA, "orders"],
        ["billing", PA, "billing"],
        ["notify", PA, "notify"],
        ["idle", PA, null],
        ["far", PA, null],
        ["alpha", PA, null],
        ["beta", PA, null],
        ["shadow", PN, "notify"],
        ["stray", PB, "notify"],
        ["ledger", PB, null],
        ["vault", PB, null],
        ["closed", PC, null],
      ];
      for (const [key, projectId, fixture] of repos) {
        await db.repoConnection.create({
          data: { id: R[key], projectId, label: key, repoName: key, ownerOrOrg: "openzigs" },
        });
        if (fixture) makeClone(R[key], fixture);
      }
      const products: Array<[keyof typeof P, string, string]> = [
        ["orders", "Orders", WS1],
        ["billing", "Billing", WS1],
        ["notify", "Notify", WS1],
        ["idle", "Idle", WS1],
        ["far", "Far", WS1],
        ["alpha", "Alpha", WS1],
        ["beta", "Beta", WS1],
        ["shadow", "Shadow", WS2],
        ["stray", "Stray", WS1],
        ["ledger", "Ledger", WS2],
        ["vault", "Vault", WS1],
      ];
      for (const [key, name, workspaceId] of products) {
        await db.product.create({
          data: { id: P[key], name, slug: P[key], createdById: "bob", workspaceId },
        });
        await db.productRepo.create({ data: { productId: P[key], repoConnectionId: R[key] } });
      }
      await db.productRepo.create({ data: { productId: P.far, repoConnectionId: R.closed } });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      if (originalCloneDir === undefined) delete process.env.REPO_CLONE_DIR;
      else process.env.REPO_CLONE_DIR = originalCloneDir;
      await db?.$disconnect();
      sqlite?.cleanup();
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    });

    describe("detection across products", () => {
      const counts: Record<string, { cross: number; internal: number }> = {};

      beforeAll(async () => {
        for (const key of ["orders", "billing", "notify"] as const) {
          const res = await analyze(P[key]);
          expect(res.status).toBe(200);
          counts[key] = {
            cross: res.body.data.crossProductEdges,
            internal: res.body.data.edgesDetected,
          };
        }
      });

      it("analysing each one-repo product finds its cross-product edges, with no declared edge", async () => {
        // An edge is stored on each product it has an end in: 5 + 7 + 2.
        expect(counts).toEqual({
          orders: { cross: 5, internal: 0 },
          billing: { cross: 7, internal: 0 },
          notify: { cross: 2, internal: 0 },
        });
        expect(await db.productEdge.count({ where: { origin: { not: "detected" } } })).toBe(0);
      });

      it("together they are exactly the 7 ground-truth edges", async () => {
        const all = new Set([
          ...(await keysOn(P.orders)),
          ...(await keysOn(P.billing)),
          ...(await keysOn(P.notify)),
        ]);
        expect([...all].sort()).toEqual(GROUND_TRUTH);
        expect(await keysOn(P.billing)).toEqual(GROUND_TRUTH);
      });

      it("never stores an edge between two other products' repos on the product analysed", async () => {
        expect(await keysOn(P.notify)).toEqual(GROUND_TRUTH.filter((k) => k.includes(R.notify)));
        expect(await keysOn(P.orders)).toEqual(GROUND_TRUTH.filter((k) => k.includes(R.orders)));
      });

      it("shows them on the product page, naming the other products' repos", async () => {
        const { body } = await getProduct(P.billing);
        expect(body.data.edges).toHaveLength(7);
        expect(body.data.linkedRepos).toEqual([
          {
            repoConnectionId: R.orders,
            label: "openzigs/orders",
            productId: P.orders,
            productName: "Orders",
          },
          {
            repoConnectionId: R.notify,
            label: "openzigs/notify",
            productId: P.notify,
            productName: "Notify",
          },
          ...["idle", "far", "alpha", "beta"].map((k) =>
            expect.objectContaining({ label: `openzigs/${k}` }),
          ),
        ]);
      });

      it("#1732 — the generated documents draw them, naming each far repo `owner/name (Product)`", async () => {
        const doc = await unifiedDoc(P.billing);
        expect(doc.content).not.toContain("No API contract edges detected.");
        expect(doc.content).not.toContain("No data flow edges detected.");
        expect(doc.content).toContain('["openzigs/orders (Orders)"]');
        expect(doc.content).toContain('["openzigs/notify (Notify)"]');
        expect(doc.content).toMatch(/\| billing \| openzigs\/orders \(Orders\) \| \d+% \|/);
        expect(doc.content).toContain("participant __ext0 as openzigs/orders (Orders)");
        expect(doc.content).toContain("7 links reach a repository of another product");
        // A reader who cannot open a far repo is not shown a document naming it (#1258).
        expect(JSON.parse(doc.metadata).repoConnectionIds).toEqual(
          expect.arrayContaining([R.billing, R.orders, R.notify]),
        );
        const perService = (await documents(P.billing)).find((d) => d.docType === "per-service")!;
        expect(perService.content).toContain("openzigs/orders (Orders)");
        expect(JSON.parse(perService.metadata).repoConnectionIds).toEqual(
          expect.arrayContaining([R.billing, R.orders, R.notify]),
        );
      });

      it("#1732 (#1727) — the provenance credits each evidence file to the repo it is in", async () => {
        const { content } = await unifiedDoc(P.billing);
        const provenance = content.slice(content.indexOf("## Provenance"));
        // `order.created`: Billing subscribes, Orders publishes from its own file.
        expect(provenance).toContain("| openzigs/orders (Orders) | src/events/publisher.ts |");
        expect(provenance).not.toContain("| openzigs/billing | src/events/publisher.ts |");
        // The `orders` table: written by Orders, read by Billing's repository code.
        expect(provenance).toContain("| openzigs/billing | src/db/billing-repo.ts |");
        expect(provenance).not.toContain("| openzigs/orders (Orders) | src/db/billing-repo.ts |");
        expect(provenance).toContain("| openzigs/orders (Orders) | src/db/orders-repo.ts |");
      });

      it("is idempotent: a second run changes no row", async () => {
        const before = await db.productEdge.findMany({ orderBy: { id: "asc" } });
        const res = await analyze(P.billing);
        expect(res.status).toBe(200);
        expect(await db.productEdge.findMany({ orderBy: { id: "asc" } })).toEqual(before);
      });

      it("never pairs across a workspace boundary, even for an admin who reads every repo", async () => {
        // Shadow is homed in WS2; Stray is a WS1 product, but its repo is project B's.
        const siblings = await listReadableSiblingRepos(userPayload("ada"), P.billing);
        expect(siblings.map((s) => s.repoConnectionId)).not.toContain(R.shadow);
        expect(siblings.map((s) => s.repoConnectionId)).not.toContain(R.stray);
        const res = await analyze(P.billing, "ada");
        expect(res.status).toBe(200);
        const touching = await db.productEdge.count({
          where: {
            OR: [
              { sourceRepoId: { in: [R.shadow, R.stray] } },
              { targetRepoId: { in: [R.shadow, R.stray] } },
            ],
          },
        });
        expect(touching).toBe(0);
      });

      it("a product with no home workspace has no siblings", async () => {
        await db.product.update({ where: { id: P.idle }, data: { workspaceId: null } });
        try {
          expect(await listReadableSiblingRepos(userPayload("bob"), P.idle)).toEqual([]);
        } finally {
          await db.product.update({ where: { id: P.idle }, data: { workspaceId: WS1 } });
        }
      });

      it("deletes a cross-product edge no longer found, and keeps one whose far repo was not read", async () => {
        const files = new Map<string, null | []>([[R.notify, null]]);
        const clones = createCloneFileLoader();
        const loader: Parameters<typeof runProductEdgeDetection>[0]["loadRepoFiles"] = (repo) =>
          files.has(repo.repoConnectionId)
            ? Promise.resolve(files.get(repo.repoConnectionId)!)
            : clones(repo);
        const unread = await runProductEdgeDetection({
          user: userPayload("bob"),
          productId: P.billing,
          loadRepoFiles: loader,
        });
        expect(unread).toMatchObject({ created: 0, updated: 0, deleted: 0 });
        files.set(R.notify, []);
        const emptied = await runProductEdgeDetection({
          user: userPayload("bob"),
          productId: P.billing,
          loadRepoFiles: loader,
        });
        expect(emptied.deleted).toBe(2);
        expect(await keysOn(P.billing)).toEqual(GROUND_TRUTH.filter((k) => !k.includes(R.notify)));
        // Put them back for the impact tests below.
        expect((await analyze(P.billing)).status).toBe(200);
        expect(await keysOn(P.billing)).toEqual(GROUND_TRUTH);
      });
    });

    describe("impact over the detected edges", () => {
      it("a change to Orders reaches Billing directly and Notify two hops away", async () => {
        const impact = await ordersImpact("bob", [P.billing, P.notify]);
        const billing = of(impact, P.billing);
        const notify = of(impact, P.notify);
        expect(billing).toMatchObject({ impactKind: "downstream-consumer", restricted: false });
        expect(billing.hops).toHaveLength(1);
        expect(billing.hops[0]).toMatchObject({ fromProductId: P.orders, toProductId: P.billing });
        expect(notify).toMatchObject({ impactKind: "downstream-consumer", restricted: false });
        expect(notify.hops.map((h) => [h.fromProductId, h.toProductId])).toEqual([
          [P.orders, P.billing],
          [P.billing, P.notify],
        ]);
        // Every edge on the paths was detected.
        const edges = await db.productEdge.findMany({
          where: { id: { in: [...billing.edgeIds, ...notify.edgeIds] } },
        });
        expect(edges.every((e) => e.origin === "detected")).toBe(true);
      });

      it("one hop of depth leaves Notify unaffected", async () => {
        const impact = await ordersImpact("bob", [P.billing, P.notify], 1);
        expect(of(impact, P.notify).impactKind).toBe("none");
      });
    });

    describe("declared edges across products", () => {
      const declared = (over: Record<string, unknown>) => ({
        sourceRepoId: R.notify,
        targetRepoId: R.orders,
        edgeType: "consumes",
        integrationKind: "api",
        strength: "contract",
        direction: "consumes",
        ...over,
      });

      it("may end at a readable repo of another product in the workspace, and the walk follows it", async () => {
        // Intrusive, so as severe as the detected two-hop path: the first path found stands.
        const res = await send(
          "post",
          `/api/products/${P.notify}/edges`,
          "bob",
          declared({ strength: "intrusive" }),
        );
        expect(res.status).toBe(201);
        try {
          const { body } = await getProduct(P.notify);
          expect(body.data.edges.map((e) => e.id)).toContain(res.body.data.id);
          const impact = await ordersImpact("bob", [P.notify]);
          expect(of(impact, P.notify).hops).toHaveLength(1);
          expect(of(impact, P.notify).edgeIds).toEqual([res.body.data.id]);
        } finally {
          expect(
            (await send("delete", `/api/products/${P.notify}/edges/${res.body.data.id}`, "bob"))
              .status,
          ).toBe(204);
        }
      });

      it.each([
        ["a WS2 product's repo", "ada", { targetRepoId: R.shadow }],
        ["a WS1 product's repo of a WS2 project", "ada", { targetRepoId: R.stray }],
        ["a WS2 repo the caller cannot read", "bob", { targetRepoId: R.ledger }],
        ["a WS1 repo the caller cannot read", "bob", { targetRepoId: R.closed }],
        ["from another product's repo", "bob", { sourceRepoId: R.orders, targetRepoId: R.notify }],
      ] as const)("is refused %s, as not attached", async (_name, who, over) => {
        const before = await db.productEdge.count();
        const res = await send("post", `/api/products/${P.notify}/edges`, who, declared(over));
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("REPO_NOT_ASSOCIATED");
        expect(await db.productEdge.count()).toBe(before);
      });

      it("the reference check itself refuses another workspace, whatever the caller may read", async () => {
        const readsAll = new Set(Object.values(R));
        const refs = (targetRepoId: string) => ({ sourceRepoId: R.notify, targetRepoId });
        await expect(
          assertEdgeReferencesInProduct(P.notify, refs(R.orders), readsAll),
        ).resolves.toBeUndefined();
        for (const far of [R.shadow, R.stray]) {
          await expect(
            assertEdgeReferencesInProduct(P.notify, refs(far), readsAll),
          ).rejects.toMatchObject({ status: 404, code: "REPO_NOT_ASSOCIATED" });
        }
        // No readable set: nothing outside the product qualifies.
        await expect(assertEdgeReferencesInProduct(P.notify, refs(R.orders))).rejects.toMatchObject(
          { status: 404, code: "REPO_NOT_ASSOCIATED" },
        );
      });

      it("a detected cross-product edge that starts at the other product's repo can be overridden and reverted", async () => {
        const edge = await db.productEdge.findFirstOrThrow({
          where: { productId: P.orders, sourceRepoId: R.billing, edgeType: "consumes" },
        });
        const patched = await send("patch", `/api/products/${P.orders}/edges/${edge.id}`, "bob", {
          strength: "functional",
        });
        expect(patched.status).toBe(200);
        expect(patched.body.data).toMatchObject({ origin: "overridden", strength: "functional" });
        const reverted = await send(
          "post",
          `/api/products/${P.orders}/edges/${edge.id}/revert`,
          "bob",
        );
        expect(reverted.status).toBe(200);
        expect(reverted.body.data).toMatchObject({ origin: "detected", strength: "contract" });
      });
    });

    describe("shared resources across products", () => {
      /** Declare topic `name` on `productId` and an edge from its repo to it alone. */
      const shareTopic = async (
        productId: string,
        repoId: string,
        name: string,
        direction: "provides" | "consumes",
      ) => {
        const resource = await db.productResource.create({
          data: { productId, kind: "topic", name, origin: "declared" },
        });
        const edge = await db.productEdge.create({
          data: {
            productId,
            sourceRepoId: repoId,
            resourceId: resource.id,
            edgeType: direction === "provides" ? "produces" : "consumes",
            integrationKind: "event",
            strength: "contract",
            direction,
            confidence: 1,
            origin: "declared",
          },
        });
        return { resource, edge };
      };

      it("a topic one product provides and another consumes, each declared on its own product, links them", async () => {
        const a = await shareTopic(P.orders, R.orders, "payments.settled", "provides");
        const b = await shareTopic(P.idle, R.idle, "payments.settled", "consumes");
        // Same kind and name on a WS2 product, and another name in WS1: neither meets.
        const c = await shareTopic(P.shadow, R.shadow, "payments.settled", "consumes");
        const d = await shareTopic(P.far, R.far, "payments.refunded", "consumes");
        try {
          const impact = await ordersImpact("ada", [P.idle, P.shadow, P.far]);
          const idle = of(impact, P.idle);
          expect(idle.impactKind).toBe("downstream-consumer");
          expect(idle.hops).toHaveLength(1);
          expect(idle.hops[0]).toMatchObject({
            edgeIds: [a.edge.id, b.edge.id],
            resource: { kind: "topic", name: "payments.settled" },
          });
          expect(of(impact, P.shadow).impactKind).toBe("none");
          expect(of(impact, P.far).impactKind).toBe("none");
        } finally {
          for (const x of [a, b, c, d]) {
            await db.productEdge.delete({ where: { id: x.edge.id } });
            await db.productResource.delete({ where: { id: x.resource.id } });
          }
        }
      });

      it("a resource of a product in another workspace never meets one of the same name", async () => {
        // Orders' repo only consumes the topic on Orders; a WS2 product records the
        // same repo providing a topic of that name. Idle consumes it on Idle (WS1).
        const ownT = await shareTopic(P.orders, R.orders, "ledger.closed", "consumes");
        const idleT = await shareTopic(P.idle, R.idle, "ledger.closed", "consumes");
        const shadowT = await shareTopic(P.shadow, R.shadow, "ledger.closed", "consumes");
        const fromShadow = await db.productEdge.create({
          data: {
            productId: P.shadow,
            sourceRepoId: R.orders,
            resourceId: shadowT.resource.id,
            edgeType: "produces",
            integrationKind: "event",
            strength: "contract",
            direction: "provides",
            confidence: 1,
            origin: "declared",
          },
        });
        try {
          expect(of(await ordersImpact("ada", [P.idle]), P.idle).impactKind).toBe("none");
        } finally {
          await db.productEdge.delete({ where: { id: fromShadow.id } });
          for (const x of [ownT, idleT, shadowT]) {
            await db.productEdge.delete({ where: { id: x.edge.id } });
            await db.productResource.delete({ where: { id: x.resource.id } });
          }
        }
      });

      it("a twin on a product the reader cannot read counts as left out, so what lies past it reads restricted", async () => {
        // Vault is homed in WS1 but carries only a project-B repo: Bob cannot read it.
        const a = await shareTopic(P.orders, R.orders, "vault.sealed", "provides");
        const b = await shareTopic(P.vault, R.vault, "vault.sealed", "consumes");
        const past = await db.productEdge.create({
          data: {
            productId: P.vault,
            sourceRepoId: R.vault,
            targetRepoId: R.far,
            edgeType: "produces",
            integrationKind: "api",
            strength: "contract",
            direction: "provides",
            confidence: 1,
            origin: "declared",
          },
        });
        try {
          expect(of(await ordersImpact("ada", [P.far]), P.far).impactKind).toBe(
            "downstream-consumer",
          );
          const bobs = await ordersImpact("bob", [P.far]);
          expect(of(bobs, P.far)).toMatchObject({ impactKind: "restricted", hops: [] });
          expect(JSON.stringify(bobs)).not.toContain(R.vault);
          expect(JSON.stringify(bobs)).not.toContain(P.vault);
        } finally {
          await db.productEdge.delete({ where: { id: past.id } });
          for (const x of [a, b]) {
            await db.productEdge.delete({ where: { id: x.edge.id } });
            await db.productResource.delete({ where: { id: x.resource.id } });
          }
        }
      });
    });

    describe("a reader without access to the far repo", () => {
      // An admin's earlier run, or a row of the pre-#1257 kind: Ledger's repo
      // (project B) consumes Billing's, recorded on Billing and on Notify.
      const hidden = ["e-hidden-billing-1724", "e-hidden-notify-1724"];
      beforeAll(async () => {
        for (const [id, productId] of [
          [hidden[0], P.billing],
          [hidden[1], P.notify],
        ]) {
          await db.productEdge.create({
            data: {
              id,
              productId,
              sourceRepoId: R.ledger,
              targetRepoId: R.billing,
              edgeType: "calls",
              integrationKind: "api",
              strength: "contract",
              direction: "consumes",
              confidence: 0.9,
              origin: "detected",
            },
          });
        }
      });
      afterAll(async () => {
        await db.productEdge.deleteMany({ where: { id: { in: hidden } } });
      });

      it("sees no detail of it on the product page", async () => {
        const res = await getProduct(P.billing);
        expect(res.body.data.edges.map((e) => e.id)).not.toContain(hidden[0]);
        expect(res.text).not.toContain(R.ledger);
        const patch = await send("patch", `/api/products/${P.billing}/edges/${hidden[0]}`, "bob", {
          strength: "model",
        });
        expect(patch.status).toBe(404);
        expect(patch.body.error.code).toBe("EDGE_NOT_FOUND");
      });

      it("the walk counts it hidden once, though two products record it, and names nothing of it", async () => {
        const impact = await ordersImpact("bob", [P.billing, P.notify, P.ledger]);
        expect(of(impact, P.billing).hiddenEdgeCount).toBe(1);
        expect(of(impact, P.ledger)).toMatchObject({
          restricted: true,
          name: null,
          impactKind: "none",
          hops: [],
        });
        expect(JSON.stringify(impact)).not.toContain(R.ledger);
        // The admin, who reads everything, is shown the path.
        expect(of(await ordersImpact("ada", [P.ledger]), P.ledger).impactKind).toBe(
          "downstream-consumer",
        );
      });

      it("the analysis counts no cross-product edge to it", async () => {
        const res = await analyze(P.billing);
        expect(res.status).toBe(200);
        expect(res.body.data.crossProductEdges).toBe(7);
      });

      it("#1732 — the documents draw it under the restricted relabel, with nothing of it", async () => {
        expect((await analyze(P.billing)).status).toBe(200);
        const doc = await unifiedDoc(P.billing);
        expect(doc.content).toContain('["A restricted repository"]');
        expect(doc.content).not.toContain(R.ledger);
        expect(doc.content).not.toMatch(/ledger/i);
        // Not a source of the document: naming nothing of it, it hides nothing from anyone.
        expect(JSON.parse(doc.metadata).repoConnectionIds).not.toContain(R.ledger);
      });
    });

    it("a person's override on one product's copy of an edge is what the walk follows", async () => {
      // Alpha's copy, detected, is intrusive (high); Beta's copy, overridden by a
      // person, is a contract (low). The walk takes the person's.
      const copies = [
        {
          id: "e-1-alpha-copy-1724",
          productId: P.alpha,
          strength: "intrusive",
          origin: "detected",
        },
        { id: "e-2-beta-copy-1724", productId: P.beta, strength: "contract", origin: "overridden" },
      ];
      for (const c of copies) {
        await db.productEdge.create({
          data: {
            ...c,
            sourceRepoId: R.beta,
            targetRepoId: R.alpha,
            edgeType: "calls",
            integrationKind: "api",
            direction: "consumes",
            confidence: 0.9,
          },
        });
      }
      try {
        const impact = await evaluatePortfolioImpact(
          userPayload("bob"),
          { directChangeProductIds: [P.alpha], listedProductIds: [P.beta] },
          { sharedObjects: async () => ({ affectedObjects: [] }) as never },
        );
        expect(of(impact, P.beta)).toMatchObject({
          impactKind: "downstream-consumer",
          severity: "low",
          edgeIds: ["e-2-beta-copy-1724"],
        });
      } finally {
        await db.productEdge.deleteMany({ where: { id: { in: copies.map((c) => c.id) } } });
      }
    });

    it(`crawls at most ${MAX_CROSS_PRODUCT_REPOS} other products' repos and counts the rest`, async () => {
      const many = await db.product.create({
        data: {
          id: "p-many-1724",
          name: "Many",
          slug: "p-many-1724",
          createdById: "bob",
          workspaceId: WS1,
        },
      });
      const ids = Array.from(
        { length: MAX_CROSS_PRODUCT_REPOS + 1 },
        (_, i) => `rc-z-many-${String(i).padStart(3, "0")}-1724`,
      );
      for (const id of ids) {
        await db.repoConnection.create({
          data: { id, projectId: PA, label: id, repoName: id, ownerOrOrg: "openzigs" },
        });
        await db.productRepo.create({ data: { productId: many.id, repoConnectionId: id } });
      }
      try {
        const siblings = await listReadableSiblingRepos(userPayload("bob"), P.notify);
        const loaded: string[] = [];
        const result = await runProductEdgeDetection({
          user: userPayload("bob"),
          productId: P.notify,
          loadRepoFiles: async (repo) => {
            loaded.push(repo.repoConnectionId);
            return null;
          },
        });
        expect(loaded).toEqual([
          R.notify,
          ...siblings.slice(0, MAX_CROSS_PRODUCT_REPOS).map((s) => s.repoConnectionId),
        ]);
        expect(result.crossProductReposSkipped).toBe(siblings.length - MAX_CROSS_PRODUCT_REPOS);
        expect(result.crossProductReposSkipped).toBeGreaterThan(0);
        expect(result.siblingRepoIds).toHaveLength(siblings.length);
      } finally {
        await db.product.delete({ where: { id: many.id } });
        await db.repoConnection.deleteMany({ where: { id: { in: ids } } });
      }
    });
  },
);
