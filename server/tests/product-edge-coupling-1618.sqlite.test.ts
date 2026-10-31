/**
 * #1618 — typed product edges and shared-resource nodes, through the real
 * routes on a real SQLite database built by the migration chain.
 *
 * - An edge written BEFORE the migration reads back through
 *   `GET /api/products/:id` unchanged, as `origin: detected` with every new
 *   field null.
 * - `POST /api/products/:id/edges` writes a declared edge, validated by the
 *   `@metis/shared` zod schema (an unknown `strength` is a 400) and checked
 *   against the product by the service: a resource or contract document of
 *   another product is refused as not found (the partition test), and so is a
 *   repo that is not attached or that the caller cannot open (#1258).
 *
 * Workspace ws1 holds project A (Alice, Bob, Rita the reader); ws2 holds
 * project B (Mallory). Product P1 is homed in ws1 and carries repos A1 and A2
 * plus B, a cross-workspace row of the pre-#1257 kind. Product P2 carries A1
 * and A2 only. Ada is an admin.
 */
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
const { assertEdgeReferencesInProduct } = await import("../src/lib/products/product-edges.js");

const MIGRATION = "20261106001618_issue1618_product_edge_coupling";
const WS1 = "ws1-1618";
const WS2 = "ws2-1618";
const PA = "proj-a-1618";
const PB = "proj-b-1618";

const USERS: Record<string, { role: RoleKey; ws: string }> = {
  alice: { role: "coordinator", ws: WS1 },
  bob: { role: "coordinator", ws: WS1 },
  rita: { role: "reader", ws: WS1 },
  mallory: { role: "coordinator", ws: WS2 },
  ada: { role: "admin", ws: WS2 },
};
type Who = keyof typeof USERS;

interface EdgeBody {
  id: string;
  sourceRepoId: string;
  targetRepoId: string | null;
  resourceId: string | null;
  [k: string]: unknown;
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1618 — typed product edges and shared resources",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const rc = { a1: "", a2: "", a3: "", b: "" };
    let p1 = "";
    let p2 = "";
    let resource1 = "";
    let contract1 = "";
    const LEGACY_EVIDENCE = [
      { filePath: "openapi.yaml", pattern: "openapi_spec_reference", matchType: "spec_reference" },
    ];
    const LEGACY_EDGE = "legacy-edge-a1-a2";
    const LEGACY_FOREIGN_EDGE = "legacy-edge-a1-b";

    const userPayload = (who: Who): AuthPayload => ({
      userId: who,
      username: who,
      role: USERS[who].role,
      permissions: getPermissionsForRole(USERS[who].role),
      workspaces: [USERS[who].ws],
    });
    const bearer = (who: Who) => `Bearer ${issueTokens(userPayload(who)).accessToken}`;
    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/products", productsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const get = (path: string, who: Who) =>
      request(app()).get(path).set("Authorization", bearer(who));
    const post = (path: string, who: Who, body: object) =>
      request(app()).post(path).set("Authorization", bearer(who)).send(body);
    const declared = (over: Record<string, unknown> = {}) => ({
      sourceRepoId: rc.a1,
      targetRepoId: rc.a2,
      edgeType: "calls",
      integrationKind: "api",
      strength: "contract",
      direction: "consumes",
      ...over,
    });
    const edgesOf = async (productId: string, who: Who): Promise<EdgeBody[]> => {
      const res = await get(`/api/products/${productId}`, who);
      expect(res.status).toBe(200);
      return res.body.data.edges as EdgeBody[];
    };

    beforeAll(async () => {
      // Seed in the shape the database had before #1618, then migrate it.
      sqlite = createMigratedSqlite("1618-product-edges", { stopBefore: MIGRATION });
      const seed = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      for (const key of ["coordinator", "reader", "admin"]) {
        await seed.role.create({ data: { id: `role-${key}`, key, name: key } });
      }
      for (const [id, u] of Object.entries(USERS)) {
        await seed.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
        await seed.userRole.create({ data: { userId: id, roleId: `role-${u.role}` } });
      }
      for (const ws of [WS1, WS2]) {
        await seed.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      for (const [userId, u] of Object.entries(USERS)) {
        await seed.workspaceMember.create({ data: { workspaceId: u.ws, userId, role: "member" } });
      }
      for (const [id, createdById, workspaceId] of [
        [PA, "alice", WS1],
        [PB, "mallory", WS2],
      ] as const) {
        await seed.project.create({
          data: { id, name: id, slug: id, createdById, workspaceId, status: "active" },
        });
      }
      for (const [key, projectId] of [
        ["a1", PA],
        ["a2", PA],
        ["a3", PA],
        ["b", PB],
      ] as const) {
        rc[key] = (
          await seed.repoConnection.create({
            data: {
              projectId,
              label: `rc-${key}`,
              repoName: `repo-${key}-1618`,
              ownerOrOrg: "org",
            },
          })
        ).id;
      }
      p1 = (
        await seed.product.create({
          data: { name: "P1", slug: "p1-1618", createdById: "alice", workspaceId: WS1 },
        })
      ).id;
      p2 = (
        await seed.product.create({
          data: { name: "P2", slug: "p2-1618", createdById: "alice", workspaceId: WS1 },
        })
      ).id;
      for (const key of ["a1", "a2", "b"] as const) {
        await seed.productRepo.create({ data: { productId: p1, repoConnectionId: rc[key] } });
      }
      for (const key of ["a1", "a2"] as const) {
        await seed.productRepo.create({ data: { productId: p2, repoConnectionId: rc[key] } });
      }
      contract1 = (
        await seed.productContractDoc.create({
          data: { productId: p1, repoId: rc.a2, version: 1, contentHash: "h1", title: "A2 API" },
        })
      ).id;
      await seed.$disconnect();
      const now = new Date("2026-09-01T00:00:00Z").toISOString();
      for (const [id, target] of [
        [LEGACY_EDGE, rc.a2],
        [LEGACY_FOREIGN_EDGE, rc.b],
      ]) {
        sqlite.exec(
          `INSERT INTO "product_edges" ("id","productId","sourceRepoId","targetRepoId","edgeType","confidence","evidence","sourceFile","targetFile","commitSha","createdAt","updatedAt")
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            id,
            p1,
            rc.a1,
            target,
            "calls",
            0.95,
            JSON.stringify(LEGACY_EVIDENCE),
            "openapi.yaml",
            null,
            "sha-1",
            now,
            now,
          ],
        );
      }
      sqlite.applyRemaining();

      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      resource1 = (
        await db.productResource.create({ data: { productId: p1, kind: "table", name: "orders" } })
      ).id;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    describe("an edge written before the migration", () => {
      it("reads back through GET unchanged, as detected, with every new field null", async () => {
        const legacy = (await edgesOf(p1, "bob")).find((e) => e.id === LEGACY_EDGE);
        expect(legacy).toEqual({
          id: LEGACY_EDGE,
          productId: p1,
          sourceRepoId: rc.a1,
          targetRepoId: rc.a2,
          edgeType: "calls",
          confidence: 0.95,
          evidence: LEGACY_EVIDENCE,
          sourceFile: "openapi.yaml",
          targetFile: null,
          commitSha: "sha-1",
          integrationKind: null,
          strength: null,
          direction: null,
          origin: "detected",
          resourceId: null,
          contractDocId: null,
          declaredById: null,
        });
      });

      it("is hidden from a member when it touches a repo they cannot open (#1258), not from an admin", async () => {
        const bob = await get(`/api/products/${p1}`, "bob");
        expect(bob.body.data.edges.map((e: EdgeBody) => e.id)).not.toContain(LEGACY_FOREIGN_EDGE);
        expect(JSON.stringify(bob.body)).not.toContain(rc.b);
        const ada = await edgesOf(p1, "ada");
        expect(ada.map((e) => e.id)).toEqual(
          expect.arrayContaining([LEGACY_EDGE, LEGACY_FOREIGN_EDGE]),
        );
      });
    });

    describe("declaring an edge", () => {
      it("writes a declared, fully typed edge that the product GET returns with every field", async () => {
        const res = await post(
          `/api/products/${p1}/edges`,
          "bob",
          declared({ contractDocId: contract1 }),
        );
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({
          origin: "declared",
          declaredById: "bob",
          confidence: 1,
          strength: "contract",
        });
        const read = (await edgesOf(p1, "bob")).find((e) => e.id === res.body.data.id);
        expect(read).toEqual({
          id: res.body.data.id,
          productId: p1,
          sourceRepoId: rc.a1,
          targetRepoId: rc.a2,
          edgeType: "calls",
          confidence: 1,
          evidence: [],
          sourceFile: null,
          targetFile: null,
          commitSha: null,
          integrationKind: "api",
          strength: "contract",
          direction: "consumes",
          origin: "declared",
          resourceId: null,
          contractDocId: contract1,
          declaredById: "bob",
        });
      });

      it("writes an edge through a resource with no target repo, and the GET shows the resource", async () => {
        const res = await post(
          `/api/products/${p1}/edges`,
          "bob",
          declared({
            targetRepoId: null,
            resourceId: resource1,
            edgeType: "produces",
            integrationKind: "database",
            strength: "intrusive",
            direction: "writes",
          }),
        );
        expect(res.status).toBe(201);
        const product = (await get(`/api/products/${p1}`, "bob")).body.data;
        const edge = product.edges.find((e: EdgeBody) => e.id === res.body.data.id);
        expect(edge).toMatchObject({
          targetRepoId: null,
          resourceId: resource1,
          strength: "intrusive",
        });
        expect(product.resources).toEqual([
          {
            id: resource1,
            productId: p1,
            kind: "table",
            name: "orders",
            locator: null,
            origin: "detected",
            declaredById: null,
          },
        ]);
      });

      it("refuses an unknown strength with 400 and writes nothing", async () => {
        const before = await db.productEdge.count({ where: { productId: p1 } });
        const res = await post(`/api/products/${p1}/edges`, "bob", declared({ strength: "tight" }));
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("VALIDATION_ERROR");
        expect(await db.productEdge.count({ where: { productId: p1 } })).toBe(before);
      });

      it.each([
        ["integrationKind", { integrationKind: "carrier-pigeon" }],
        ["direction", { direction: "sideways" }],
        ["edgeType", { edgeType: "befriends" }],
        ["neither a target repo nor a resource", { targetRepoId: null }],
        ["a client-chosen origin", { origin: "detected" }],
      ])("refuses %s with 400", async (_label, over) => {
        const res = await post(`/api/products/${p1}/edges`, "bob", declared(over));
        expect(res.status).toBe(400);
      });

      it("refuses a resource of another product exactly like a missing one (partition)", async () => {
        const before = await db.productEdge.count({ where: { productId: p2 } });
        const foreign = await post(
          `/api/products/${p2}/edges`,
          "bob",
          declared({ resourceId: resource1 }),
        );
        const missing = await post(
          `/api/products/${p2}/edges`,
          "bob",
          declared({ resourceId: "res-does-not-exist-1618" }),
        );
        expect(foreign.status).toBe(404);
        expect(foreign.body.error.code).toBe("RESOURCE_NOT_FOUND");
        expect(missing.status).toBe(404);
        expect(missing.body.error.code).toBe(foreign.body.error.code);
        expect(await db.productEdge.count({ where: { productId: p2 } })).toBe(before);
      });

      it("the service rejects another product's resource and contract, and an edge with no target", async () => {
        await expect(
          assertEdgeReferencesInProduct(p2, { sourceRepoId: rc.a1, resourceId: resource1 }),
        ).rejects.toMatchObject({ status: 404, code: "RESOURCE_NOT_FOUND" });
        await expect(
          assertEdgeReferencesInProduct(p2, {
            sourceRepoId: rc.a1,
            targetRepoId: rc.a2,
            contractDocId: contract1,
          }),
        ).rejects.toMatchObject({ status: 404, code: "CONTRACT_DOC_NOT_FOUND" });
        await expect(
          assertEdgeReferencesInProduct(p1, { sourceRepoId: rc.a1, targetRepoId: null }),
        ).rejects.toMatchObject({ status: 400, code: "EDGE_TARGET_REQUIRED" });
        // ...and accepts the same references in their own product.
        await expect(
          assertEdgeReferencesInProduct(p1, {
            sourceRepoId: rc.a1,
            targetRepoId: rc.a2,
            resourceId: resource1,
            contractDocId: contract1,
          }),
        ).resolves.toBeUndefined();
      });

      it("refuses a contract document of another product", async () => {
        const res = await post(
          `/api/products/${p2}/edges`,
          "bob",
          declared({ contractDocId: contract1 }),
        );
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("CONTRACT_DOC_NOT_FOUND");
      });

      it("refuses a repo that is not attached to the product, at either end", async () => {
        for (const over of [{ sourceRepoId: rc.a3 }, { targetRepoId: rc.a3 }]) {
          const res = await post(`/api/products/${p1}/edges`, "bob", declared(over));
          expect(res.status).toBe(404);
          expect(res.body.error.code).toBe("REPO_NOT_ASSOCIATED");
        }
      });

      it("answers a repo the caller cannot open as not attached; an admin may use it", async () => {
        const hidden = await post(
          `/api/products/${p1}/edges`,
          "bob",
          declared({ targetRepoId: rc.b }),
        );
        expect(hidden.status).toBe(404);
        expect(hidden.body.error.code).toBe("REPO_NOT_ASSOCIATED");
        const hiddenSource = await post(
          `/api/products/${p1}/edges`,
          "bob",
          declared({ sourceRepoId: rc.b }),
        );
        expect(hiddenSource.status).toBe(404);
        const admin = await post(
          `/api/products/${p1}/edges`,
          "ada",
          declared({ targetRepoId: rc.b }),
        );
        expect(admin.status).toBe(201);
      });

      it("refuses a reader (403) and a non-member of the product (404)", async () => {
        const before = await db.productEdge.count();
        expect((await post(`/api/products/${p1}/edges`, "rita", declared())).status).toBe(403);
        expect((await post(`/api/products/${p1}/edges`, "mallory", declared())).status).toBe(404);
        // An admin skips the access check; the service still answers a missing product.
        const missing = await post(`/api/products/prod-missing-1618/edges`, "ada", declared());
        expect(missing.status).toBe(404);
        expect(missing.body.error.code).toBe("PRODUCT_NOT_FOUND");
        expect(await db.productEdge.count()).toBe(before);
      });
    });

    describe("what the product GET shows", () => {
      it("hides a resource known only from an edge the caller cannot see", async () => {
        const hiddenRes = await db.productResource.create({
          data: { productId: p1, kind: "topic", name: "orders.created" },
        });
        await db.productEdge.create({
          data: {
            productId: p1,
            sourceRepoId: rc.b,
            resourceId: hiddenRes.id,
            edgeType: "produces",
            confidence: 0.9,
            integrationKind: "event",
          },
        });
        const bob = (await get(`/api/products/${p1}`, "bob")).body.data;
        expect(bob.resources.map((r: { id: string }) => r.id)).not.toContain(hiddenRes.id);
        expect(JSON.stringify(bob)).not.toContain("orders.created");
        const ada = (await get(`/api/products/${p1}`, "ada")).body.data;
        expect(ada.resources.map((r: { id: string }) => r.id)).toContain(hiddenRes.id);
      });

      it("reads an unknown stored enum value as unclassified and bad evidence JSON as none", async () => {
        const odd = await db.productEdge.create({
          data: {
            productId: p1,
            sourceRepoId: rc.a2,
            targetRepoId: rc.a1,
            edgeType: "calls",
            confidence: 0.5,
            evidence: "{not json",
            strength: "bogus",
            integrationKind: "bogus",
            direction: "bogus",
            origin: "bogus",
          },
        });
        const edge = (await edgesOf(p1, "bob")).find((e) => e.id === odd.id);
        expect(edge).toMatchObject({
          evidence: [],
          strength: null,
          integrationKind: null,
          direction: null,
          origin: "detected",
        });
        // `/analyze` (below) parses evidence strictly, as it did before #1618.
        await db.productEdge.delete({ where: { id: odd.id } });
      });

      it("keeps a repo-less edge out of the generated documents (/analyze)", async () => {
        const res = await post(`/api/products/${p1}/analyze`, "ada", {});
        expect(res.status).toBe(200);
        const repoToRepo = await db.productEdge.count({
          where: { productId: p1, NOT: { targetRepoId: null } },
        });
        expect(res.body.data.edgesDetected).toBe(repoToRepo);
      });
    });
  },
);
