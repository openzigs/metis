/**
 * #1619 — detection fills the typed-edge fields (#1618) and stores what it
 * finds, on a real SQLite database built by the migration chain, read back
 * through the same `GET /api/products/:id` the product page uses.
 *
 * Fixtures (synthetic, committed under tests/fixtures/products/):
 *   (a) event-topic: orders-service documents `orders.created` in an AsyncAPI
 *       3.0 file; billing-service subscribes to it in code, and names
 *       `inventory.reserved` only in comments; shipping-service publishes
 *       `inventory.reserved`.
 *   (b) shared-table: order-writer writes `orders` (and reads `customers`);
 *       report-reader only reads `orders`.
 *
 * Bob is a ws1 member; project A is in ws1, project B in ws2. The event product
 * also carries repo F of project B, a cross-workspace row of the pre-#1257 kind:
 * Bob's run must not read it, nor touch an edge that has it as an end.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
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
const { runProductEdgeDetection, syncDetectedProductEdges } =
  await import("../src/lib/products/edge-detection.js");
type FileEntry = import("../src/lib/products/repo-crawler.js").FileEntry;
type DetectionRepo = import("../src/lib/products/edge-detection.js").DetectionRepo;
type RepoFiles = import("../src/lib/products/edge-detection.js").RepoFiles;

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "products");

/** Every file under a fixture repo, with its path relative to the repo root. */
function readFixtureRepo(dir: string): FileEntry[] {
  const out: FileEntry[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(path.join(dir, rel))) {
      const relPath = rel ? `${rel}/${name}` : name;
      const abs = path.join(dir, relPath);
      if (statSync(abs).isDirectory()) walk(relPath);
      else {
        const content = readFileSync(abs, "utf-8");
        out.push({ path: relPath, content, size: content.length });
      }
    }
  };
  walk("");
  return out;
}

const WS1 = "ws1-1619";
const WS2 = "ws2-1619";
const PA = "proj-a-1619";
const PB = "proj-b-1619";
const USERS: Record<string, { role: RoleKey; ws: string }> = {
  bob: { role: "coordinator", ws: WS1 },
  mallory: { role: "coordinator", ws: WS2 },
  ada: { role: "admin", ws: WS2 },
};
type Who = keyof typeof USERS;

interface EdgeBody {
  id: string;
  sourceRepoId: string;
  targetRepoId: string | null;
  resourceId: string | null;
  edgeType: string;
  integrationKind: string | null;
  strength: string | null;
  direction: string | null;
  origin: string;
  contractDocId: string | null;
  [k: string]: unknown;
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1619 — detected event-topic and shared-table edges",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const rc: Record<string, string> = {};
    const product: Record<string, string> = {};
    /** repoConnectionId -> the files the loader hands back (null: cannot be read). */
    const files = new Map<string, FileEntry[] | RepoFiles | null>();
    const loaded: string[] = [];

    const userPayload = (who: Who): AuthPayload => ({
      userId: who,
      username: who,
      role: USERS[who].role,
      permissions: getPermissionsForRole(USERS[who].role),
      workspaces: [USERS[who].ws],
    });
    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/products", productsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const bearer = (who: Who) => `Bearer ${issueTokens(userPayload(who)).accessToken}`;
    const graphOf = async (productId: string, who: Who = "bob") => {
      const res = await request(app())
        .get(`/api/products/${productId}`)
        .set("Authorization", bearer(who));
      expect(res.status).toBe(200);
      return res.body.data as {
        edges: EdgeBody[];
        resources: Array<{ id: string; kind: string; name: string; origin: string }>;
      };
    };
    const detect = (productId: string, who: Who = "bob") =>
      runProductEdgeDetection({
        user: userPayload(who),
        productId,
        loadRepoFiles: async (repo: DetectionRepo) => {
          loaded.push(repo.repoConnectionId);
          return files.get(repo.repoConnectionId) ?? null;
        },
      });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1619-edge-detection");
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
      for (const [id, createdById, workspaceId] of [
        [PA, "bob", WS1],
        [PB, "mallory", WS2],
      ] as const) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById, workspaceId, status: "active" },
        });
      }
      const repos: Array<[string, string, string | null]> = [
        ["orders", PA, "event-topic/orders-service"],
        ["billing", PA, "event-topic/billing-service"],
        ["shipping", PA, "event-topic/shipping-service"],
        ["foreign", PB, "event-topic/orders-service"],
        ["writer", PA, "shared-table/order-writer"],
        ["reader", PA, "shared-table/report-reader"],
        ["client", PA, null],
        ["server-repo", PA, null],
        ["g1", PA, null],
        ["g2", PA, null],
      ];
      for (const [key, projectId, fixture] of repos) {
        rc[key] = (
          await db.repoConnection.create({
            data: { projectId, label: key, repoName: `${key}-1619`, ownerOrOrg: "org" },
          })
        ).id;
        files.set(rc[key], fixture ? readFixtureRepo(path.join(FIXTURES, fixture)) : []);
      }
      const products: Array<[string, string[]]> = [
        ["event", ["orders", "billing", "shipping", "foreign"]],
        ["table", ["writer", "reader"]],
        ["api", ["client", "server-repo"]],
        ["graph", ["g1", "g2"]],
      ];
      for (const [key, members] of products) {
        product[key] = (
          await db.product.create({
            data: { name: key, slug: `${key}-1619`, createdById: "bob", workspaceId: WS1 },
          })
        ).id;
        for (const m of members) {
          await db.productRepo.create({
            data: { productId: product[key], repoConnectionId: rc[m] },
          });
        }
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    describe("fixture (a): an AsyncAPI document and a consumer of its channel", () => {
      const foreignEdges: string[] = [];

      beforeAll(async () => {
        // Found by an admin's earlier run; Bob cannot read repo F. One edge has F
        // as its source, one as its target.
        for (const [source, target] of [
          [rc.foreign, rc.orders],
          [rc.orders, rc.foreign],
        ]) {
          const edge = await db.productEdge.create({
            data: {
              productId: product.event,
              sourceRepoId: source,
              targetRepoId: target,
              edgeType: "calls",
              confidence: 0.9,
              origin: "detected",
            },
          });
          foreignEdges.push(edge.id);
        }
      });

      it("yields exactly one event edge, through one topic resource", async () => {
        loaded.length = 0;
        const result = await detect(product.event);
        expect(result.created).toBe(1);
        const { edges, resources } = await graphOf(product.event);
        const detected = edges.filter((e) => e.origin === "detected");
        expect(detected).toHaveLength(1);
        expect(detected[0]).toMatchObject({
          sourceRepoId: rc.billing,
          targetRepoId: rc.orders,
          edgeType: "consumes",
          integrationKind: "event",
          strength: "contract",
          direction: "consumes",
        });
        expect(resources).toEqual([
          expect.objectContaining({ kind: "topic", name: "orders.created", origin: "detected" }),
        ]);
        expect(detected[0].resourceId).toBe(resources[0].id);
      });

      it("makes no edge from a topic named only in a comment", async () => {
        const { edges } = await graphOf(product.event, "ada");
        expect(
          edges.filter((e) => e.sourceRepoId === rc.billing && e.targetRepoId === rc.shipping),
        ).toEqual([]);
        expect(await db.productResource.count({ where: { name: "inventory.reserved" } })).toBe(0);
      });

      it("reads only the repos the caller can read, and leaves an edge touching another alone", async () => {
        // #1724 — the product's own readable repos, then the repos of the other
        // products homed in WS1 (every product here), which Bob can read too.
        const own = [rc.orders, rc.billing, rc.shipping];
        expect(loaded.slice(0, 3).sort()).toEqual(own.sort());
        expect(loaded.slice(3).sort()).toEqual(
          ["writer", "reader", "client", "server-repo", "g1", "g2"].map((k) => rc[k]).sort(),
        );
        expect(loaded).not.toContain(rc.foreign);
        expect(await db.productEdge.count({ where: { id: { in: foreignEdges } } })).toBe(2);
      });
    });

    describe("fixture (b): two repos' SQL on one table, one of them writing", () => {
      it("yields one database edge, intrusive, from the writer through the table", async () => {
        await detect(product.table);
        const { edges, resources } = await graphOf(product.table);
        expect(edges).toHaveLength(1);
        expect(edges[0]).toMatchObject({
          sourceRepoId: rc.writer,
          targetRepoId: rc.reader,
          integrationKind: "database",
          strength: "intrusive",
          direction: "writes",
          origin: "detected",
        });
        // `customers` is read by the writer alone; the reader's prose "from" is not SQL.
        expect(resources.map((r) => `${r.kind}:${r.name}`)).toEqual(["table:orders"]);
      });

      it("is idempotent and never overwrites a declared edge", async () => {
        const declare = await request(app())
          .post(`/api/products/${product.table}/edges`)
          .set("Authorization", bearer("bob"))
          .send({
            sourceRepoId: rc.reader,
            targetRepoId: rc.writer,
            edgeType: "consumes",
            integrationKind: "database",
            strength: "functional",
            direction: "reads",
          });
        expect(declare.status).toBe(201);
        const declaredBefore = await db.productEdge.findUnique({
          where: { id: declare.body.data.id },
        });
        const before = await db.productEdge.findMany({
          where: { productId: product.table },
          orderBy: { id: "asc" },
        });

        const again = await detect(product.table);
        // #1643 — the edge found again as stored is not rewritten at all.
        expect(again).toMatchObject({ created: 0, deleted: 0, updated: 0 });

        const after = await db.productEdge.findMany({
          where: { productId: product.table },
          orderBy: { id: "asc" },
        });
        expect(after).toEqual(before);
        expect(await db.productEdge.findUnique({ where: { id: declare.body.data.id } })).toEqual(
          declaredBefore,
        );
        const read = (await graphOf(product.table)).edges.find(
          (e) => e.id === declare.body.data.id,
        );
        expect(read).toMatchObject({
          origin: "declared",
          strength: "functional",
          direction: "reads",
        });
      });

      it("does not write a detected copy of an edge a person declared, nor change the declaration", async () => {
        const resourceId = (await graphOf(product.table)).resources[0].id;
        // A person cannot declare a copy of an edge the product already has
        // (#1647), so the declaration comes first, as it would in practice:
        // detection then finds the edge the person already declared.
        await db.productEdge.deleteMany({
          where: { productId: product.table, origin: "detected", sourceRepoId: rc.writer },
        });
        const declare = await request(app())
          .post(`/api/products/${product.table}/edges`)
          .set("Authorization", bearer("bob"))
          .send({
            sourceRepoId: rc.writer,
            targetRepoId: rc.reader,
            resourceId,
            edgeType: "produces",
            integrationKind: "database",
            strength: "functional",
            direction: "writes",
          });
        expect(declare.status).toBe(201);
        const declaredBefore = await db.productEdge.findUnique({
          where: { id: declare.body.data.id },
        });
        const result = await detect(product.table);
        expect(result.keptDeclared).toBe(1);
        const edges = (await graphOf(product.table)).edges;
        expect(edges.filter((e) => e.origin === "detected")).toEqual([]);
        expect(await db.productEdge.findUnique({ where: { id: declare.body.data.id } })).toEqual(
          declaredBefore,
        );
        // The resource it goes through stays, though no detected edge does now.
        expect((await graphOf(product.table)).resources.map((r) => r.id)).toEqual([resourceId]);
      });
    });

    describe("what else a run stores", () => {
      it("links an API edge to the target repo's latest contract document", async () => {
        files.set(rc.client, [
          {
            path: "openapi.yaml",
            content: "servers:\n  - url: https://server-repo-1619.example.test\n",
            size: 60,
          },
        ]);
        for (const version of [1, 2]) {
          await db.productContractDoc.create({
            data: {
              productId: product.api,
              repoId: rc["server-repo"],
              version,
              contentHash: `h${version}`,
              title: "contract",
            },
          });
        }
        const latest = await db.productContractDoc.findFirst({
          where: { productId: product.api, version: 2 },
        });
        await detect(product.api);
        const { edges } = await graphOf(product.api);
        expect(edges).toHaveLength(1);
        expect(edges[0]).toMatchObject({
          sourceRepoId: rc.client,
          targetRepoId: rc["server-repo"],
          integrationKind: "api",
          strength: "contract",
          contractDocId: latest!.id,
        });
      });

      it("finds a shared table in the repos' code graphs (model when both only read)", async () => {
        for (const key of ["g1", "g2"]) {
          const graph = await db.codeGraph.create({
            data: { projectId: PA, repoConnectionId: rc[key] },
          });
          const sym = (kind: string, name: string, qualifiedName: string) =>
            db.codeSymbol.create({
              data: {
                codeGraphId: graph.id,
                projectId: PA,
                kind,
                name,
                qualifiedName,
                filePath: "src/q.go",
                startLine: 1,
                endLine: 2,
                language: kind === "table" ? "sql" : "go",
                contentHash: `${key}-${name}`,
              },
            });
          const fn = await sym("function", "load", `src/q.go::load-${key}`);
          const table = await sym("table", "orders", "public.orders");
          const column = await sym("column", "total", "public.orders.total");
          for (const to of [table, column]) {
            await db.codeEdge.create({
              data: {
                codeGraphId: graph.id,
                projectId: PA,
                kind: "reads",
                fromSymbolId: fn.id,
                toSymbolId: to.id,
                filePath: "src/q.go",
                line: 7,
              },
            });
          }
        }
        await detect(product.graph);
        const { edges, resources } = await graphOf(product.graph);
        expect(edges).toHaveLength(1);
        expect(edges[0]).toMatchObject({ integrationKind: "database", strength: "model" });
        expect(resources.map((r) => r.name)).toEqual(["public.orders"]);
      });

      it("deletes a detected edge no longer found, drops its resource, keeps a repo it could not read", async () => {
        // The reader stops using the table: nothing is shared any more.
        files.set(rc.g2, []);
        await db.codeEdge.deleteMany({ where: { graph: { repoConnectionId: rc.g2 } } });
        const result = await detect(product.graph);
        expect(result.deleted).toBe(1);
        expect((await graphOf(product.graph)).edges).toEqual([]);
        expect(await db.productResource.count({ where: { productId: product.graph } })).toBe(0);

        // A repo whose files cannot be read is not crawled: its edges stay.
        await detect(product.event);
        const eventEdges = await db.productEdge.count({
          where: { productId: product.event, origin: "detected" },
        });
        files.set(rc.billing, null);
        const partial = await detect(product.event);
        const eventRepos = new Set([rc.orders, rc.billing, rc.shipping, rc.foreign]);
        expect(partial.scannedRepoIds.filter((id) => eventRepos.has(id)).sort()).toEqual(
          [rc.orders, rc.shipping].sort(),
        );
        expect(partial.deleted).toBe(0);
        expect(
          await db.productEdge.count({ where: { productId: product.event, origin: "detected" } }),
        ).toBe(eventEdges);
      });

      it("refuses a product that does not exist", async () => {
        await expect(detect("prod-missing-1619", "ada")).rejects.toMatchObject({
          status: 404,
          code: "PRODUCT_NOT_FOUND",
        });
      });
    });

    // ── #1647 — review follow-ups ────────────────────────────────────────────

    describe("what a run keeps, refreshes and refuses (#1647)", () => {
      /** A fresh product over two new repos of project A, with the given files. */
      const twoRepoProduct = async (slug: string, a: FileEntry[], b: FileEntry[]) => {
        const ids: string[] = [];
        for (const [key, entries] of [
          ["x", a],
          ["y", b],
        ] as const) {
          const id = (
            await db.repoConnection.create({
              data: {
                projectId: PA,
                label: `${slug}-${key}`,
                repoName: `${slug}-${key}`,
                ownerOrOrg: "org",
              },
            })
          ).id;
          files.set(id, entries);
          ids.push(id);
        }
        const productId = (
          await db.product.create({
            data: { name: slug, slug: `${slug}-1647`, createdById: "bob", workspaceId: WS1 },
          })
        ).id;
        for (const id of ids) {
          await db.productRepo.create({ data: { productId, repoConnectionId: id } });
        }
        return { productId, x: ids[0], y: ids[1] };
      };
      const sql = (path: string, content: string): FileEntry => ({
        path,
        content,
        size: content.length,
      });

      it("keeps an overridden edge's classification on re-detection, and drops it once not found", async () => {
        const t = await twoRepoProduct(
          "override",
          [sql("w.sql", "insert into invoices (id) values (1);")],
          [sql("r.sql", "select id from invoices;")],
        );
        await detect(t.productId);
        const [edge] = (await graphOf(t.productId)).edges;
        expect(edge).toMatchObject({ strength: "intrusive", origin: "detected" });
        const patch = await request(app())
          .patch(`/api/products/${t.productId}/edges/${edge.id}`)
          .set("Authorization", bearer("bob"))
          .send({ strength: "functional" });
        expect(patch.status).toBe(200);
        // Found again: the person's strength stands, detection's facts refresh.
        files.set(t.y, [sql("r2.sql", "select id from invoices;")]);
        const again = await detect(t.productId);
        expect(again).toMatchObject({ created: 0, updated: 1, deleted: 0 });
        const read = (await graphOf(t.productId)).edges;
        expect(read).toHaveLength(1);
        expect(read[0]).toMatchObject({
          id: edge.id,
          strength: "functional",
          integrationKind: "database",
          origin: "overridden",
          targetFile: "r2.sql",
        });
        // Not found any more: it goes, as a detected edge would.
        files.set(t.y, []);
        const gone = await detect(t.productId);
        expect(gone.deleted).toBe(1);
        expect((await graphOf(t.productId)).edges).toEqual([]);
      });

      it("refreshes detection's kept classification of an overridden edge, which a revert restores (#1687)", async () => {
        const t = await twoRepoProduct(
          "revert",
          [sql("w.sql", "insert into payments (id) values (1);")],
          [sql("r.sql", "select id from payments;")],
        );
        await detect(t.productId);
        const [edge] = (await graphOf(t.productId)).edges;
        expect(edge).toMatchObject({ strength: "intrusive", origin: "detected" });
        await request(app())
          .patch(`/api/products/${t.productId}/edges/${edge.id}`)
          .set("Authorization", bearer("bob"))
          .send({ strength: "functional" })
          .expect(200);
        // A kept copy that no longer matches what detection finds (detection
        // changed its mind since the override) is refreshed by the next run.
        await db.productEdge.update({
          where: { id: edge.id },
          data: { detectedStrength: "contract" },
        });
        expect(await detect(t.productId)).toMatchObject({ created: 0, updated: 1, deleted: 0 });
        expect(await db.productEdge.findUnique({ where: { id: edge.id } })).toMatchObject({
          origin: "overridden",
          strength: "functional",
          detectedIntegrationKind: "database",
          detectedStrength: "intrusive",
        });
        // Found again unchanged: nothing is written.
        expect(await detect(t.productId)).toMatchObject({ created: 0, updated: 0, deleted: 0 });
        const revert = await request(app())
          .post(`/api/products/${t.productId}/edges/${edge.id}/revert`)
          .set("Authorization", bearer("bob"));
        expect(revert.status).toBe(200);
        expect((await graphOf(t.productId)).edges).toEqual([
          expect.objectContaining({
            id: edge.id,
            origin: "detected",
            integrationKind: "database",
            strength: "intrusive",
            direction: edge.direction,
          }),
        ]);
        // Reverted to what detection finds, so the next run has nothing to change.
        expect(await detect(t.productId)).toMatchObject({ created: 0, updated: 0, deleted: 0 });
      });

      it("keeps an edge it did not find when either end was read only in part (#1643)", async () => {
        const t = await twoRepoProduct(
          "partial",
          [sql("w.sql", "insert into ledgers (id) values (1);")],
          [sql("r.sql", "select id from ledgers;")],
        );
        await detect(t.productId);
        const [edge] = (await graphOf(t.productId)).edges;
        await request(app())
          .patch(`/api/products/${t.productId}/edges/${edge.id}`)
          .set("Authorization", bearer("bob"))
          .send({ strength: "functional" })
          .expect(200);
        // The reader's SQL now sits past a read limit: not found, not deleted.
        files.set(t.y, { files: [], partial: true });
        expect(await detect(t.productId)).toMatchObject({ deleted: 0 });
        // Likewise when it is the writer, the edge's source, that was cut short.
        files.set(t.y, []);
        files.set(t.x, { files: [], partial: true });
        expect(await detect(t.productId)).toMatchObject({ deleted: 0 });
        expect((await graphOf(t.productId)).edges).toEqual([
          expect.objectContaining({ id: edge.id, strength: "functional", origin: "overridden" }),
        ]);
        // Both read in full and still not found: now it goes.
        files.set(t.x, { files: [], partial: false });
        expect(await detect(t.productId)).toMatchObject({ deleted: 1 });
        expect((await graphOf(t.productId)).edges).toEqual([]);
      });

      it("leaves an edge of an origin detection does not own alone, and does not count it deleted (#1657)", async () => {
        const t = await twoRepoProduct(
          "foreign",
          [sql("w.sql", "insert into ledgers (id) values (1);")],
          [sql("r.sql", "select id from ledgers;")],
        );
        await detect(t.productId);
        const [edge] = (await graphOf(t.productId)).edges;
        // An origin from outside detection (an import, a later origin kind).
        await db.productEdge.update({ where: { id: edge.id }, data: { origin: "imported" } });
        // Found again: kept as a declared edge is, not refreshed or copied.
        const again = await detect(t.productId);
        expect(again).toMatchObject({ created: 0, updated: 0, deleted: 0, keptDeclared: 1 });
        // Not found any more: still not detection's to delete, and not counted.
        files.set(t.y, []);
        const gone = await detect(t.productId);
        expect(gone.deleted).toBe(0);
        expect(await db.productEdge.findUnique({ where: { id: edge.id } })).toMatchObject({
          origin: "imported",
        });
      });

      it("keeps a declared resource no edge goes through, and drops a detected one (orphan cleanup)", async () => {
        const t = await twoRepoProduct("orphans", [], []);
        const declared = await db.productResource.create({
          data: { productId: t.productId, kind: "bucket", name: "exports", origin: "declared" },
        });
        await db.productResource.create({
          data: { productId: t.productId, kind: "table", name: "stale", origin: "detected" },
        });
        await detect(t.productId);
        expect(
          (await db.productResource.findMany({ where: { productId: t.productId } })).map(
            (r) => r.id,
          ),
        ).toEqual([declared.id]);
      });

      it("finds no shared table in two repos' unresolved dynamic SQL", async () => {
        const t = await twoRepoProduct("dynamic", [], []);
        for (const repoId of [t.x, t.y]) {
          const graph = await db.codeGraph.create({
            data: { projectId: PA, repoConnectionId: repoId },
          });
          const sym = (kind: string, name: string) =>
            db.codeSymbol.create({
              data: {
                codeGraphId: graph.id,
                projectId: PA,
                kind,
                name,
                qualifiedName: name,
                filePath: "src/Dao.java",
                startLine: 1,
                endLine: 2,
                language: "java",
                contentHash: `${repoId}-${name}`,
              },
            });
          const fn = await sym("function", `load-${repoId}`);
          const table = await sym("table", "?dynamic:tableName");
          await db.codeEdge.create({
            data: {
              codeGraphId: graph.id,
              projectId: PA,
              kind: "writes",
              fromSymbolId: fn.id,
              toSymbolId: table.id,
              filePath: "src/Dao.java",
              line: 3,
            },
          });
        }
        await detect(t.productId);
        expect((await graphOf(t.productId)).edges).toEqual([]);
        expect(await db.productResource.count({ where: { productId: t.productId } })).toBe(0);
      });

      it("writes no detected resource when the run's transaction fails", async () => {
        const t = await twoRepoProduct("atomic", [], []);
        // An edge from a repo that does not exist fails its foreign key, after
        // the resource it goes through would have been created.
        await expect(
          syncDetectedProductEdges(
            t.productId,
            [t.x, "rc-ghost-1647"],
            [
              {
                sourceRepoId: "rc-ghost-1647",
                targetRepoId: t.x,
                edgeType: "produces",
                confidence: 0.8,
                evidence: [],
                integrationKind: "database",
                strength: "intrusive",
                direction: "writes",
                resource: { kind: "table", name: "ghost_orders" },
              },
            ],
          ),
        ).rejects.toThrow();
        expect(await db.productResource.count({ where: { productId: t.productId } })).toBe(0);
      });
    });
  },
);
