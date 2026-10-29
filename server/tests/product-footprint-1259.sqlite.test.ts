/**
 * #1259 — a repo attached across workspaces no longer opens the product to the
 * foreign workspace.
 *
 * A product's footprint used to be its bound projects plus the project of EVERY
 * attached repo, so a `ProductRepo` row written while the #1250 hole was open
 * let the foreign repo's workspace open the product: its name, description,
 * analysis history (with `triggeredBy` user ids) and documents. Since #1259 an
 * attached repo widens the footprint only when the product's CREATOR could have
 * attached it: the creator is a system admin, or has a membership row in the
 * repo project's workspace, or the project has no workspace (legacy, open to
 * all). Bound projects (`Project.productId`) still count as before.
 *
 * #1527 — the rule is now RECORDED: each product's home workspace is written
 * when the first repo its creator could attach is attached, and only repos in
 * the home (or in no workspace) count. These rows are written in the pre-#1527
 * shape and then meet that migration, as a deployed database does, so every
 * expectation below is also a check of its backfill. One changed: an
 * admin-created product no longer opens to every workspace its repos sit in,
 * only to its home — the workspace of its earliest-attached repo.
 *
 * Workspace `ws1` holds project A (Alice, Bob, and Erin — whose account was since
 * deprovisioned). Mallory is in `ws2` with projects B and W. Ada is a system
 * admin in no workspace. Every caller below is a non-admin member.
 *
 * Real SQLite built by the migration chain, real routers, services and JWTs; the
 * audit sink is a double.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole, type AuthPayload, type RoleKey } from "@metis/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
const auditSpy = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: auditSpy }));

const { productsRouter } = await import("../src/routes/products-multi.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const WS1 = "ws1-1259";
const WS2 = "ws2-1259";
const PA = "proj-a-1259";
const PB = "proj-b-1259";
const PW = "proj-w-1259";
const PL = "proj-legacy-1259";
/** The migration that records each product's home workspace (#1527). */
const HOME_MIGRATION = "20261104001527_issue1527_product_home_workspace";

/** Strings only a reader of Product X may see. */
const X_NAME = "Product X 1259";
const X_TRIGGERED_BY = "alice";

const USERS: Record<string, { role: RoleKey; ws: string | null }> = {
  alice: { role: "coordinator", ws: WS1 },
  bob: { role: "coordinator", ws: WS1 },
  erin: { role: "coordinator", ws: WS1 },
  mallory: { role: "coordinator", ws: WS2 },
  ada: { role: "admin", ws: null },
};
type Caller = "alice" | "bob" | "mallory";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1259 — an attached repo widens a product's footprint only when its creator could attach it",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const rc = { a: "", b: "", l: "" };
    const product = {
      /** Alice's: repo A, plus repo B written the way the pre-#1257 route allowed. */
      x: "",
      /** Alice's: repo B alone — repos, but none Alice could attach. */
      foreignOnly: "",
      /** Ada's (system admin, no workspace): repo A, then repo B. */
      adminMade: "",
      /** Erin's (deprovisioned since): repo A. */
      departed: "",
      /** Alice's: repo A, and project W bound to it directly. */
      bound: "",
      /** Alice's: repo B and the legacy repo L. */
      legacy: "",
      /** Alice's: nothing attached. */
      unbound: "",
    };

    const userPayload = (who: Caller): AuthPayload => ({
      userId: who,
      username: who,
      role: USERS[who].role,
      permissions: getPermissionsForRole(USERS[who].role),
      workspaces: USERS[who].ws ? [USERS[who].ws] : [],
    });
    const bearer = (who: Caller) => `Bearer ${issueTokens(userPayload(who)).accessToken}`;
    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/products", productsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const get = (path: string, who: Caller) =>
      request(app()).get(path).set("Authorization", bearer(who));
    const listedIds = async (who: Caller) => {
      const res = await get("/api/products?pageSize=100", who);
      expect(res.status).toBe(200);
      return (res.body.data.items as Array<{ id: string }>).map((p) => p.id);
    };

    beforeAll(async () => {
      // Built as it stood before #1527: products carry no home workspace yet.
      sqlite = createMigratedSqlite("1259-product-footprint", { stopBefore: HOME_MIGRATION });
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
        if (u.ws) {
          await db.workspaceMember.create({ data: { workspaceId: u.ws, userId, role: "member" } });
        }
      }

      // Raw SQL: the head client would write the column the migration adds.
      const make = async (slug: string, createdById: string, name = slug) => {
        const id = `prod-${slug}-1259`;
        sqlite.exec(
          `INSERT INTO "products" ("id","name","slug","createdById","createdAt","updatedAt")
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [id, name, `${slug}-1259`, createdById],
        );
        return id;
      };
      product.x = await make("x", "alice", X_NAME);
      product.foreignOnly = await make("foreign-only", "alice");
      product.adminMade = await make("admin-made", "ada");
      product.departed = await make("departed", "erin");
      product.bound = await make("bound", "alice");
      product.legacy = await make("legacy", "alice");
      product.unbound = await make("unbound", "alice");

      for (const [id, createdById, workspaceId, productId] of [
        [PA, "alice", WS1, null],
        [PB, "mallory", WS2, null],
        [PW, "mallory", WS2, product.bound],
        [PL, "mallory", null, null],
      ] as const) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById, workspaceId, productId, status: "active" },
        });
      }
      for (const [key, projectId, createdById] of [
        ["a", PA, "alice"],
        ["b", PB, "mallory"],
        ["l", PL, "mallory"],
      ] as const) {
        rc[key] = (
          await db.repoConnection.create({
            data: { projectId, label: `rc-${key}`, repoName: `repo-${key}-1259`, createdById },
          })
        ).id;
      }
      // Straight to the table, as the unguarded pre-#1257 route wrote them, each
      // attached a minute after the one before it (the backfill reads the order).
      let attached = 0;
      for (const [productId, keys] of [
        [product.x, ["a", "b"]],
        [product.foreignOnly, ["b"]],
        [product.adminMade, ["a", "b"]],
        [product.departed, ["a"]],
        [product.bound, ["a"]],
        [product.legacy, ["b", "l"]],
      ] as const) {
        for (const key of keys) {
          sqlite.exec(
            `INSERT INTO "product_repos" ("id","productId","repoConnectionId","createdAt")
             VALUES (?, ?, ?, ?)`,
            [
              `pr-${productId}-${key}`,
              productId,
              rc[key],
              new Date(Date.UTC(2026, 0, 1, 0, attached++)).toISOString(),
            ],
          );
        }
      }
      await db.productAnalysis.create({
        data: { productId: product.x, status: "completed", triggeredBy: X_TRIGGERED_BY },
      });
      // Erin leaves: deprovisioned, her membership row kept (#612).
      await db.user.update({
        where: { id: "erin" },
        data: { status: "disabled", deletedAt: new Date() },
      });

      // #1527 — the migration meets these rows, then the head client reads them.
      await db.$disconnect();
      sqlite.applyRemaining();
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      auditSpy.mockClear();
    });

    describe("the foreign repo's member, reaching the product only through that repo", () => {
      it("cannot open it by id: 404 with no name, audited once", async () => {
        const res = await get(`/api/products/${product.x}`, "mallory");
        expect(res.status).toBe(404);
        expect(JSON.stringify(res.body)).not.toContain(X_NAME);
        expect(auditSpy.mock.calls.map((c) => c[0])).toEqual([
          expect.objectContaining({
            actor: { id: "mallory" },
            action: "product.access.denied",
            target: { type: "product", id: product.x },
            // Only the project Alice could attach is judged; B is not in the footprint.
            metadata: { reason: "project-access-denied", projectIds: [PA] },
          }),
        ]);
      });

      it("cannot read its analysis history or documents", async () => {
        const analyses = await get(`/api/products/${product.x}/analyses`, "mallory");
        expect(analyses.status).toBe(404);
        expect(JSON.stringify(analyses.body)).not.toContain(X_TRIGGERED_BY);
        expect((await get(`/api/products/${product.x}/documents`, "mallory")).status).toBe(404);
      });

      it("does not see it listed", async () => {
        expect(await listedIds("mallory")).not.toContain(product.x);
      });

      it("cannot open a product whose only repos the creator could not attach", async () => {
        expect((await get(`/api/products/${product.foreignOnly}`, "mallory")).status).toBe(404);
        expect(await listedIds("mallory")).not.toContain(product.foreignOnly);
      });
    });

    describe("the creator's workspace keeps the product", () => {
      it("the creator and a teammate open it, read its history and see it listed", async () => {
        for (const who of ["alice", "bob"] as const) {
          const res = await get(`/api/products/${product.x}`, who);
          expect(res.status, who).toBe(200);
          expect(res.body.data.name).toBe(X_NAME);
          const analyses = await get(`/api/products/${product.x}/analyses`, who);
          expect(analyses.status, who).toBe(200);
          expect(analyses.body.data).toHaveLength(1);
          expect(await listedIds(who), who).toContain(product.x);
        }
      });

      it("a product with repos none of which count is not treated as unbound", async () => {
        // Unbound products are open to everyone; this one carries a repo, so it is not.
        expect((await get(`/api/products/${product.foreignOnly}`, "bob")).status).toBe(404);
        expect(await listedIds("bob")).not.toContain(product.foreignOnly);
      });

      it("a deprovisioned creator's membership still counts, so the team keeps the product", async () => {
        expect((await get(`/api/products/${product.departed}`, "bob")).status).toBe(200);
        expect(await listedIds("bob")).toContain(product.departed);
      });
    });

    describe("what widens the footprint", () => {
      it("an admin-created product opens to its home workspace only (#1527)", async () => {
        // Repo A was attached first, so the backfill homed it in ws1.
        expect((await get(`/api/products/${product.adminMade}`, "bob")).status).toBe(200);
        expect(await listedIds("bob")).toContain(product.adminMade);
        // Before #1527 repo B, in ws2, opened it to Mallory too.
        expect((await get(`/api/products/${product.adminMade}`, "mallory")).status).toBe(404);
        expect(await listedIds("mallory")).not.toContain(product.adminMade);
      });

      it("a project bound to the product counts whoever created it", async () => {
        expect((await get(`/api/products/${product.bound}`, "mallory")).status).toBe(200);
        expect(await listedIds("mallory")).toContain(product.bound);
      });

      it("a legacy workspace-less repo counts (it is open to everyone)", async () => {
        expect((await get(`/api/products/${product.legacy}`, "mallory")).status).toBe(200);
        expect(await listedIds("mallory")).toContain(product.legacy);
      });

      it("an unbound product stays open to every member", async () => {
        expect((await get(`/api/products/${product.unbound}`, "mallory")).status).toBe(200);
        expect(await listedIds("mallory")).toContain(product.unbound);
      });
    });
  },
);
