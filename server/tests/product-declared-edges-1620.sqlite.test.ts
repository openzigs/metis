/**
 * #1620 — the declared-edges API: `POST/PATCH/DELETE /api/products/:id/edges`
 * and `/resources`, on a real SQLite database built by the migration chain,
 * through the real router, read back through the `GET /api/products/:id` the
 * product page uses.
 *
 * Workspace ws1 holds project A: Alice (coordinator, may edit) and Rita (a
 * reader member: no `project.update`). Mallory is in ws2 with project B, and
 * cannot open the product at all. Product P is homed in ws1 and carries repos
 * A1 and A2 plus B, a cross-workspace row of the pre-#1257 kind that Alice
 * cannot read. Product Q is a second product, for the partition checks. Ada is
 * an admin.
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

const WS1 = "ws1-1620";
const WS2 = "ws2-1620";
const PA = "proj-a-1620";
const PB = "proj-b-1620";
const USERS: Record<string, { role: RoleKey; ws: string }> = {
  alice: { role: "coordinator", ws: WS1 },
  rita: { role: "reader", ws: WS1 },
  mallory: { role: "coordinator", ws: WS2 },
  ada: { role: "admin", ws: WS2 },
};
type Who = keyof typeof USERS;
type Verb = "post" | "patch" | "delete";

interface EdgeBody {
  id: string;
  targetRepoId: string | null;
  resourceId: string | null;
  strength: string | null;
  origin: string;
  declaredById: string | null;
  [k: string]: unknown;
}
interface ResourceBody {
  id: string;
  kind: string;
  name: string;
  locator: string | null;
  origin: string;
  declaredById: string | null;
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1620 — declared edges and resources",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const rc = { a1: "", a2: "", b: "" };
    let p = "";
    let q = "";

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
    const call = (verb: Verb | "get", path: string, who: Who, body?: object) => {
      const req = request(app())
        [verb](path)
        .set("Authorization", `Bearer ${issueTokens(userPayload(who)).accessToken}`);
      return body ? req.send(body) : req;
    };
    const graph = async (who: Who = "alice", productId = p) => {
      const res = await call("get", `/api/products/${productId}`, who);
      expect(res.status).toBe(200);
      return res.body.data as { edges: EdgeBody[]; resources: ResourceBody[] };
    };
    const declaredEdge = (over: Record<string, unknown> = {}) => ({
      sourceRepoId: rc.a1,
      targetRepoId: rc.a2,
      edgeType: "calls",
      integrationKind: "identity",
      strength: "functional",
      direction: "depends-on",
      ...over,
    });
    const newEdge = async (data: Record<string, unknown>) =>
      (
        await db.productEdge.create({
          data: {
            productId: p,
            sourceRepoId: rc.a1,
            targetRepoId: rc.a2,
            edgeType: "calls",
            confidence: 0.9,
            ...data,
          },
        })
      ).id;
    const newResource = async (data: Record<string, unknown>) =>
      (
        await db.productResource.create({
          data: { productId: p, kind: "table", name: `t-${Math.random()}`, ...data },
        })
      ).id;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1620-declared-edges");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const key of ["coordinator", "reader", "admin"]) {
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
        [PA, "alice", WS1],
        [PB, "mallory", WS2],
      ] as const) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById, workspaceId, status: "active" },
        });
      }
      for (const [key, projectId] of [
        ["a1", PA],
        ["a2", PA],
        ["b", PB],
      ] as const) {
        rc[key] = (
          await db.repoConnection.create({
            data: { projectId, label: key, repoName: `repo-${key}-1620`, ownerOrOrg: "org" },
          })
        ).id;
      }
      for (const [slug, repos] of [
        ["p-1620", ["a1", "a2", "b"]],
        ["q-1620", ["a1", "a2"]],
      ] as const) {
        const id = (
          await db.product.create({
            data: { name: slug, slug, createdById: "alice", workspaceId: WS1 },
          })
        ).id;
        if (slug === "p-1620") p = id;
        else q = id;
        for (const key of repos) {
          await db.productRepo.create({ data: { productId: id, repoConnectionId: rc[key] } });
        }
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    // ── Authorisation: one test per verb ─────────────────────────────────────

    describe("a member without edit rights, and a non-member", () => {
      const refused = async (verb: Verb, path: string, body?: object) => {
        const before = {
          edges: await db.productEdge.findMany({ orderBy: { id: "asc" } }),
          resources: await db.productResource.findMany({ orderBy: { id: "asc" } }),
        };
        const reader = await call(verb, path, "rita", body);
        const outsider = await call(verb, path, "mallory", body);
        expect(reader.status).toBe(403);
        expect(outsider.status).toBe(404);
        expect({
          edges: await db.productEdge.findMany({ orderBy: { id: "asc" } }),
          resources: await db.productResource.findMany({ orderBy: { id: "asc" } }),
        }).toEqual(before);
      };

      it("POST /edges", async () => {
        await refused("post", `/api/products/${p}/edges`, declaredEdge());
      });
      it("PATCH /edges/:edgeId", async () => {
        const id = await newEdge({ origin: "declared", declaredById: "alice" });
        await refused("patch", `/api/products/${p}/edges/${id}`, { strength: "contract" });
      });
      it("DELETE /edges/:edgeId", async () => {
        const id = await newEdge({ origin: "declared", declaredById: "alice" });
        await refused("delete", `/api/products/${p}/edges/${id}`);
      });
      it("POST /resources", async () => {
        await refused("post", `/api/products/${p}/resources`, {
          kind: "identity-provider",
          name: "corp-sso",
        });
      });
      it("PATCH /resources/:resourceId", async () => {
        const id = await newResource({ origin: "declared" });
        await refused("patch", `/api/products/${p}/resources/${id}`, { locator: "x" });
      });
      it("DELETE /resources/:resourceId", async () => {
        const id = await newResource({ origin: "declared" });
        await refused("delete", `/api/products/${p}/resources/${id}`);
      });
    });

    // ── Edges ────────────────────────────────────────────────────────────────

    describe("declaring and changing an edge", () => {
      it("round-trips: POST declares it, the product GET returns it with every field", async () => {
        const res = await call("post", `/api/products/${p}/edges`, "alice", declaredEdge());
        expect(res.status).toBe(201);
        const read = (await graph()).edges.find((e) => e.id === res.body.data.id);
        expect(read).toEqual({
          id: res.body.data.id,
          productId: p,
          sourceRepoId: rc.a1,
          targetRepoId: rc.a2,
          edgeType: "calls",
          confidence: 1,
          evidence: [],
          sourceFile: null,
          targetFile: null,
          commitSha: null,
          integrationKind: "identity",
          strength: "functional",
          direction: "depends-on",
          origin: "declared",
          resourceId: null,
          contractDocId: null,
          declaredById: "alice",
        });
      });

      it("PATCH changes a declared edge, re-checked like a create", async () => {
        const id = await newEdge({ origin: "declared", declaredById: "ada" });
        const resource = await newResource({ origin: "declared" });
        const res = await call("patch", `/api/products/${p}/edges/${id}`, "alice", {
          strength: "intrusive",
          targetRepoId: null,
          resourceId: resource,
        });
        expect(res.status).toBe(200);
        expect((await graph()).edges.find((e) => e.id === id)).toMatchObject({
          strength: "intrusive",
          targetRepoId: null,
          resourceId: resource,
          origin: "declared",
          declaredById: "alice",
        });
        // ...and the same checks as a create: neither target nor resource, another
        // product's resource, a repo the caller cannot read.
        const neither = await call("patch", `/api/products/${p}/edges/${id}`, "alice", {
          resourceId: null,
        });
        expect(neither.status).toBe(400);
        expect(neither.body.error.code).toBe("EDGE_TARGET_REQUIRED");
        const qResource = (
          await db.productResource.create({ data: { productId: q, kind: "topic", name: "q" } })
        ).id;
        const foreign = await call("patch", `/api/products/${p}/edges/${id}`, "alice", {
          resourceId: qResource,
        });
        expect(foreign.status).toBe(404);
        expect(foreign.body.error.code).toBe("RESOURCE_NOT_FOUND");
        const hidden = await call("patch", `/api/products/${p}/edges/${id}`, "alice", {
          targetRepoId: rc.b,
        });
        expect(hidden.status).toBe(404);
        expect(hidden.body.error.code).toBe("REPO_NOT_ASSOCIATED");
        expect((await db.productEdge.findUnique({ where: { id } }))?.targetRepoId).toBeNull();
      });

      it("PATCH overrides a detected edge's strength, which makes it declared", async () => {
        const id = await newEdge({
          origin: "detected",
          strength: "contract",
          integrationKind: "api",
        });
        const res = await call("patch", `/api/products/${p}/edges/${id}`, "alice", {
          strength: "functional",
        });
        expect(res.status).toBe(200);
        expect((await graph()).edges.find((e) => e.id === id)).toMatchObject({
          strength: "functional",
          integrationKind: "api",
          origin: "declared",
          declaredById: "alice",
        });
      });

      it("PATCH refuses to move a detected edge's ends", async () => {
        const id = await newEdge({ origin: "detected" });
        const res = await call("patch", `/api/products/${p}/edges/${id}`, "alice", {
          targetRepoId: rc.a1,
          strength: "model",
        });
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe("DETECTED_EDGE_LOCKED");
        expect(await db.productEdge.findUnique({ where: { id } })).toMatchObject({
          targetRepoId: rc.a2,
          strength: null,
          origin: "detected",
        });
      });

      it("PATCH refuses an empty body or an unknown strength", async () => {
        const id = await newEdge({ origin: "declared" });
        expect((await call("patch", `/api/products/${p}/edges/${id}`, "alice", {})).status).toBe(
          400,
        );
        expect(
          (await call("patch", `/api/products/${p}/edges/${id}`, "alice", { strength: "tight" }))
            .status,
        ).toBe(400);
      });

      it("DELETE removes a declared edge", async () => {
        const id = await newEdge({ origin: "declared" });
        const res = await call("delete", `/api/products/${p}/edges/${id}`, "alice");
        expect(res.status).toBe(204);
        expect((await graph()).edges.map((e) => e.id)).not.toContain(id);
      });

      it("DELETE refuses a detected edge and says to override its strength", async () => {
        const id = await newEdge({ origin: "detected" });
        const res = await call("delete", `/api/products/${p}/edges/${id}`, "alice");
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe("DETECTED_EDGE_UNDELETABLE");
        expect(res.body.error.message).toMatch(/override its strength/i);
        expect(await db.productEdge.findUnique({ where: { id } })).not.toBeNull();
      });

      it("answers another product's edge, a missing one and one touching a hidden repo alike", async () => {
        const inQ = (
          await db.productEdge.create({
            data: {
              productId: q,
              sourceRepoId: rc.a1,
              targetRepoId: rc.a2,
              edgeType: "calls",
              confidence: 1,
              origin: "declared",
            },
          })
        ).id;
        const toHidden = await newEdge({ origin: "declared", targetRepoId: rc.b });
        for (const id of [inQ, "edge-missing-1620", toHidden]) {
          for (const verb of ["patch", "delete"] as const) {
            const res = await call(
              verb,
              `/api/products/${p}/edges/${id}`,
              "alice",
              verb === "patch" ? { strength: "model" } : undefined,
            );
            expect(res.status).toBe(404);
            expect(res.body.error.code).toBe("EDGE_NOT_FOUND");
          }
        }
        expect(await db.productEdge.count({ where: { id: { in: [inQ, toHidden] } } })).toBe(2);
        // The admin reads every repo, so the hidden repo's edge is theirs to change.
        const admin = await call("patch", `/api/products/${p}/edges/${toHidden}`, "ada", {
          strength: "model",
        });
        expect(admin.status).toBe(200);
      });
    });

    // ── Resources ────────────────────────────────────────────────────────────

    describe("declaring and changing a resource", () => {
      it("round-trips: POST declares it, the product GET returns it", async () => {
        const res = await call("post", `/api/products/${p}/resources`, "alice", {
          kind: "identity-provider",
          name: "corp-sso",
          locator: "https://login.example.test/tenant",
        });
        expect(res.status).toBe(201);
        expect((await graph()).resources.find((r) => r.id === res.body.data.id)).toEqual({
          id: res.body.data.id,
          productId: p,
          kind: "identity-provider",
          name: "corp-sso",
          locator: "https://login.example.test/tenant",
          origin: "declared",
          declaredById: "alice",
        });
        const again = await call("post", `/api/products/${p}/resources`, "alice", {
          kind: "identity-provider",
          name: "corp-sso",
        });
        expect(again.status).toBe(409);
        expect(again.body.error.code).toBe("RESOURCE_EXISTS");
      });

      it.each([
        [
          "a locator carrying credentials",
          { kind: "database", name: "db", locator: "postgres://u:pw@db/x" },
        ],
        ["an unknown kind", { kind: "mainframe", name: "m" }],
        ["an empty name", { kind: "table", name: "  " }],
        ["a client-chosen origin", { kind: "table", name: "t", origin: "detected" }],
      ])("POST refuses %s with 400", async (_label, body) => {
        expect((await call("post", `/api/products/${p}/resources`, "alice", body)).status).toBe(
          400,
        );
      });

      it("POST answers a missing product with 404, for an admin too", async () => {
        const res = await call("post", `/api/products/prod-missing-1620/resources`, "ada", {
          kind: "table",
          name: "t",
        });
        expect(res.status).toBe(404);
      });

      it("PATCH changes a declared resource, and refuses a name another resource holds", async () => {
        const id = await newResource({ origin: "declared", name: "billing-db" });
        await newResource({ origin: "declared", name: "taken" });
        const res = await call("patch", `/api/products/${p}/resources/${id}`, "alice", {
          name: "ledger-db",
          locator: "db.internal:5432/ledger",
        });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({
          name: "ledger-db",
          locator: "db.internal:5432/ledger",
        });
        const clash = await call("patch", `/api/products/${p}/resources/${id}`, "alice", {
          name: "taken",
        });
        expect(clash.status).toBe(409);
        expect(clash.body.error.code).toBe("RESOURCE_EXISTS");
      });

      it("PATCH sets a detected resource's locator (making it declared) but not its name", async () => {
        const id = await newResource({ origin: "detected", name: "orders" });
        const rename = await call("patch", `/api/products/${p}/resources/${id}`, "alice", {
          name: "orders-v2",
        });
        expect(rename.status).toBe(409);
        expect(rename.body.error.code).toBe("DETECTED_RESOURCE_LOCKED");
        const locate = await call("patch", `/api/products/${p}/resources/${id}`, "alice", {
          locator: "pg-main/public",
        });
        expect(locate.status).toBe(200);
        expect(locate.body.data).toMatchObject({
          name: "orders",
          locator: "pg-main/public",
          origin: "declared",
          declaredById: "alice",
        });
      });

      it("DELETE removes a declared resource and the repo-less edges through it, keeping the others", async () => {
        const id = await newResource({ origin: "declared" });
        const repoLess = await newEdge({ origin: "declared", targetRepoId: null, resourceId: id });
        const withTarget = await newEdge({ origin: "declared", resourceId: id });
        const res = await call("delete", `/api/products/${p}/resources/${id}`, "alice");
        expect(res.status).toBe(204);
        expect(await db.productResource.findUnique({ where: { id } })).toBeNull();
        expect(await db.productEdge.findUnique({ where: { id: repoLess } })).toBeNull();
        expect(await db.productEdge.findUnique({ where: { id: withTarget } })).toMatchObject({
          resourceId: null,
          targetRepoId: rc.a2,
        });
      });

      it("DELETE refuses a detected resource", async () => {
        const id = await newResource({ origin: "detected" });
        const res = await call("delete", `/api/products/${p}/resources/${id}`, "alice");
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe("DETECTED_RESOURCE_UNDELETABLE");
      });

      it("answers a resource only a hidden repo's edge goes through, or another product's, as not found", async () => {
        const hidden = await newResource({ origin: "declared" });
        await newEdge({
          origin: "declared",
          sourceRepoId: rc.b,
          targetRepoId: null,
          resourceId: hidden,
        });
        const inQ = (
          await db.productResource.create({ data: { productId: q, kind: "table", name: "q-t" } })
        ).id;
        for (const id of [hidden, inQ]) {
          const patch = await call("patch", `/api/products/${p}/resources/${id}`, "alice", {
            locator: "x",
          });
          const del = await call("delete", `/api/products/${p}/resources/${id}`, "alice");
          expect([patch.status, del.status]).toEqual([404, 404]);
          expect(patch.body.error.code).toBe("RESOURCE_NOT_FOUND");
        }
        expect(await db.productResource.count({ where: { id: { in: [hidden, inQ] } } })).toBe(2);
      });
    });
  },
);
