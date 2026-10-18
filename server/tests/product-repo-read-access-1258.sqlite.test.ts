/**
 * #1258 — #1257 (#1250) gated NEW attaches of a repo connection to a product by
 * the caller's access to the connection's own project. Rows attached before that
 * fix are still on disk, so every READER of a product's repos re-checks access
 * per repo:
 *
 * - `GET /api/products/:id` and `GET /api/products` return only the repos whose
 *   connection's project the caller can open, plus a bare count of the rest —
 *   no id, name, owner or URL of a repo the caller cannot reach.
 * - `POST /api/products/:id/analyze` skips those repos, and every edge touching
 *   one, so another workspace's repository never feeds the generated documents.
 * - `POST /api/products/:id/repos` refuses a soft-deleted connection with the
 *   same 404 body as a missing id.
 *
 * Workspace `ws1` holds projects A and C (Alice); Bob is a second `ws1` member
 * who created neither. Mallory is in `ws2` with project B. Project L is legacy
 * (no workspace) and so open to everyone. Product X is bound to project A and
 * carries repos A, C and L, plus repo B — a cross-workspace row written the way
 * the pre-#1257 route allowed. Nobody acting here is an admin except Ada, who
 * pins the bypass.
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

const WS1 = "ws1-1258";
const WS2 = "ws2-1258";
const PA = "proj-a-1258";
const PC = "proj-c-1258";
const PB = "proj-b-1258";
const PL = "proj-legacy-1258"; // legacy: no workspace

/** Distinctive strings that must never reach a caller who cannot open project B. */
const FOREIGN_REPO = "foreign-repo-b-1258";
const FOREIGN_OWNER = "foreign-org-b-1258";
const FOREIGN_SNIPPET = "FOREIGN-SNIPPET-1258";
const FOREIGN_SOURCE_SNIPPET = "FOREIGN-SOURCE-SNIPPET-1258";

const USERS: Record<string, { role: RoleKey; ws: string }> = {
  alice: { role: "coordinator", ws: WS1 },
  bob: { role: "coordinator", ws: WS1 },
  mallory: { role: "coordinator", ws: WS2 },
  ada: { role: "admin", ws: WS2 },
};
type Who = keyof typeof USERS;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1258 — a product's readers re-check access to each attached repo",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const rc: Record<"a" | "c" | "b" | "l" | "deleted", string> = {
      a: "",
      c: "",
      b: "",
      l: "",
      deleted: "",
    };
    let productX = "";

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
    const post = (path: string, who: Who, body: object = {}) =>
      request(app()).post(path).set("Authorization", bearer(who)).send(body);

    const repoIds = (repos: Array<{ repoConnectionId: string }>) =>
      repos.map((r) => r.repoConnectionId).sort();

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1258-product-repo-read");
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

      productX = (
        await db.product.create({
          data: { name: "Product X", slug: "product-x-1258", createdById: "alice" },
        })
      ).id;

      for (const [id, createdById, workspaceId, productId] of [
        [PA, "alice", WS1, productX],
        [PC, "alice", WS1, null],
        [PB, "mallory", WS2, null],
        [PL, "mallory", null, null],
      ] as const) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById, workspaceId, productId, status: "active" },
        });
      }
      for (const [key, projectId, createdById, repoName, ownerOrOrg] of [
        ["a", PA, "alice", "repo-a-1258", "org-a"],
        ["c", PC, "alice", "repo-c-1258", "org-a"],
        ["b", PB, "mallory", FOREIGN_REPO, FOREIGN_OWNER],
        ["l", PL, "mallory", "repo-legacy-1258", "org-l"],
        ["deleted", PA, "alice", "repo-deleted-1258", "org-a"],
      ] as const) {
        rc[key] = (
          await db.repoConnection.create({
            data: {
              projectId,
              label: `rc-${key}`,
              repoName,
              ownerOrOrg,
              createdById,
              ...(key === "deleted" ? { deletedAt: new Date() } : {}),
            },
          })
        ).id;
      }
      // Repo B is the pre-#1257 row: attached straight to the table, as the
      // unguarded route used to.
      for (const key of ["a", "c", "l", "b"] as const) {
        await db.productRepo.create({
          data: { productId: productX, repoConnectionId: rc[key], role: "backend-api" },
        });
      }
      // An edge from a readable repo into the foreign one, whose evidence would be
      // printed into every generated document.
      await db.productEdge.create({
        data: {
          productId: productX,
          sourceRepoId: rc.a,
          targetRepoId: rc.b,
          edgeType: "calls",
          confidence: 0.9,
          evidence: JSON.stringify([{ snippet: FOREIGN_SNIPPET, pattern: FOREIGN_SNIPPET }]),
        },
      });
      // ...and one OUT of the foreign repo, so a check of only one end is caught.
      await db.productEdge.create({
        data: {
          productId: productX,
          sourceRepoId: rc.b,
          targetRepoId: rc.a,
          edgeType: "calls",
          confidence: 0.7,
          evidence: JSON.stringify([
            { snippet: FOREIGN_SOURCE_SNIPPET, pattern: FOREIGN_SOURCE_SNIPPET },
          ]),
        },
      });
      await db.productEdge.create({
        data: {
          productId: productX,
          sourceRepoId: rc.a,
          targetRepoId: rc.c,
          edgeType: "calls",
          confidence: 0.8,
          evidence: JSON.stringify([{ snippet: "a-to-c", pattern: "a-to-c" }]),
        },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      auditSpy.mockClear();
    });

    // ── GET /api/products/:id ────────────────────────────────────────────────

    describe("reading a product", () => {
      it("hides a cross-workspace repo from a member, keeping only a count", async () => {
        const res = await get(`/api/products/${productX}`, "bob");
        expect(res.status).toBe(200);
        expect(repoIds(res.body.data.repos)).toEqual([rc.a, rc.c, rc.l].sort());
        expect(res.body.data.inaccessibleRepoCount).toBe(1);
        const text = JSON.stringify(res.body);
        expect(text).not.toContain(rc.b);
        expect(text).not.toContain(FOREIGN_REPO);
        expect(text).not.toContain(FOREIGN_OWNER);
      });

      it("shows a member the teammate's and the legacy project's repos (no over-blocking)", async () => {
        const res = await get(`/api/products/${productX}`, "bob");
        const byId = new Map(
          (
            res.body.data.repos as Array<{
              repoConnectionId: string;
              repoConnection: { repoName: string };
            }>
          ).map((r) => [r.repoConnectionId, r.repoConnection.repoName]),
        );
        expect(byId.get(rc.c)).toBe("repo-c-1258");
        expect(byId.get(rc.l)).toBe("repo-legacy-1258");
      });

      it("hides the product's own workspace repos from the foreign repo's member", async () => {
        // Mallory reaches the product only through the row the old route let in.
        const res = await get(`/api/products/${productX}`, "mallory");
        expect(res.status).toBe(200);
        expect(repoIds(res.body.data.repos)).toEqual([rc.b, rc.l].sort());
        expect(res.body.data.inaccessibleRepoCount).toBe(2);
        expect(JSON.stringify(res.body)).not.toContain("repo-a-1258");
      });

      it("keeps the admin bypass: every repo, nothing hidden", async () => {
        const res = await get(`/api/products/${productX}`, "ada");
        expect(res.status).toBe(200);
        expect(repoIds(res.body.data.repos)).toEqual([rc.a, rc.c, rc.l, rc.b].sort());
        expect(res.body.data.inaccessibleRepoCount).toBe(0);
      });
    });

    // ── GET /api/products ────────────────────────────────────────────────────

    describe("listing products", () => {
      it("applies the same per-repo filter to each listed product", async () => {
        const res = await get(`/api/products`, "bob");
        expect(res.status).toBe(200);
        const item = res.body.data.items.find((p: { id: string }) => p.id === productX);
        expect(repoIds(item.repos)).toEqual([rc.a, rc.c, rc.l].sort());
        expect(item.inaccessibleRepoCount).toBe(1);
        expect(JSON.stringify(res.body)).not.toContain(FOREIGN_REPO);
      });

      it("lists every repo for an admin", async () => {
        const res = await get(`/api/products`, "ada");
        const item = res.body.data.items.find((p: { id: string }) => p.id === productX);
        expect(item.repos).toHaveLength(4);
        expect(item.inaccessibleRepoCount).toBe(0);
      });
    });

    // ── POST /api/products/:id/analyze ───────────────────────────────────────

    describe("analysing a product", () => {
      const documentsText = async () =>
        JSON.stringify(await db.productDocument.findMany({ where: { productId: productX } }));

      it("skips a repo the member cannot access, and every edge touching it", async () => {
        const res = await post(`/api/products/${productX}/analyze`, "bob");
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe("completed");
        expect(res.body.data.inaccessibleRepoCount).toBe(1);
        expect(res.body.data.edgesDetected).toBe(1);
        expect(res.body.data.contractDocs.map((d: { repoId: string }) => d.repoId).sort()).toEqual(
          [rc.a, rc.c, rc.l].sort(),
        );
        expect(JSON.stringify(res.body)).not.toContain(rc.b);

        const docs = await documentsText();
        expect(docs).not.toContain(FOREIGN_REPO);
        expect(docs).not.toContain(FOREIGN_OWNER);
        expect(docs).not.toContain(FOREIGN_SNIPPET);
        expect(docs).not.toContain(FOREIGN_SOURCE_SNIPPET);
        expect(docs).not.toContain(rc.b);
        expect(docs).toContain("repo-c-1258");
        expect(docs).toContain("repo-legacy-1258");
        expect(
          await db.productContractDoc.count({
            where: { productId: productX, repoId: rc.b },
          }),
        ).toBe(0);

        expect(
          auditSpy.mock.calls
            .map((c) => c[0])
            .filter((e) => e.action === "product.analyze.repo.skipped"),
        ).toEqual([
          expect.objectContaining({
            actor: { id: "bob" },
            target: { type: "product", id: productX },
            metadata: expect.objectContaining({ repoConnectionIds: [rc.b] }),
          }),
        ]);
      });

      it("keeps the admin bypass: every repo and edge feeds the documents", async () => {
        const res = await post(`/api/products/${productX}/analyze`, "ada");
        expect(res.status).toBe(200);
        expect(res.body.data.inaccessibleRepoCount).toBe(0);
        expect(res.body.data.edgesDetected).toBe(3);
        const docs = await documentsText();
        expect(docs).toContain(FOREIGN_REPO);
        expect(docs).toContain(FOREIGN_SNIPPET);
        expect(docs).toContain(FOREIGN_SOURCE_SNIPPET);
      });
    });

    // ── GET /api/products/:id/documents ──────────────────────────────────────

    describe("reading a product's generated documents", () => {
      const docsAs = async (who: Who) => {
        const res = await get(`/api/products/${productX}/documents`, who);
        expect(res.status).toBe(200);
        return res.body.data as Array<{ docType: string; repoId: string | null }>;
      };

      it("hides from a member every document an admin's run generated from a foreign repo", async () => {
        expect((await post(`/api/products/${productX}/analyze`, "ada")).status).toBe(200);
        const docs = await docsAs("bob");
        const text = JSON.stringify(docs);
        expect(text).not.toContain(FOREIGN_REPO);
        expect(text).not.toContain(FOREIGN_SNIPPET);
        expect(text).not.toContain(rc.b);
        // The unified doc names the foreign repo, so it goes too; the readable
        // repos' own documents stay.
        expect(docs.filter((d) => d.docType === "unified-architecture")).toEqual([]);
        expect([...new Set(docs.map((d) => d.repoId))].sort()).toEqual([rc.a, rc.c, rc.l].sort());
        // Repo A's per-service doc names its edge neighbour B, so it goes as well;
        // its api-contract doc names only A and stays.
        const perService = docs.filter((d) => d.docType === "per-service").map((d) => d.repoId);
        expect(perService.sort()).toEqual([rc.c, rc.l].sort());
        expect(
          docs
            .filter((d) => d.docType === "api-contract")
            .map((d) => d.repoId)
            .sort(),
        ).toEqual([rc.a, rc.c, rc.l].sort());
      });

      it("shows the admin every document", async () => {
        const docs = await docsAs("ada");
        expect(JSON.stringify(docs)).toContain(FOREIGN_REPO);
        expect(docs.filter((d) => d.docType === "unified-architecture")).toHaveLength(1);
      });

      it("shows a member the unified doc of a run that skipped the foreign repo", async () => {
        expect((await post(`/api/products/${productX}/analyze`, "bob")).status).toBe(200);
        const docs = await docsAs("bob");
        expect(docs.filter((d) => d.docType === "unified-architecture")).toHaveLength(1);
        expect(JSON.stringify(docs)).not.toContain(FOREIGN_REPO);
      });

      it("keeps the skipped repo's own documents from the admin's earlier run", async () => {
        // The member's run above regenerated only what it could read; it must not
        // wipe the per-repo documents an earlier run built for the repo it skipped.
        const docs = await docsAs("ada");
        const forB = docs.filter((d) => d.repoId === rc.b).map((d) => d.docType);
        expect(forB.sort()).toEqual(["api-contract", "per-service"]);
        // ...and nothing is duplicated for the repos the member's run did cover.
        const forC = docs.filter((d) => d.repoId === rc.c).map((d) => d.docType);
        expect(forC.sort()).toEqual(["api-contract", "per-service"]);
      });

      it("hides a legacy unified doc that does not record its repos while a repo is hidden", async () => {
        await db.productDocument.create({
          data: {
            productId: productX,
            docType: "unified-architecture",
            title: "legacy",
            content: `mentions ${FOREIGN_REPO}`,
            repoId: null,
            metadata: "{}",
          },
        });
        expect(JSON.stringify(await docsAs("bob"))).not.toContain(FOREIGN_REPO);
        expect(JSON.stringify(await docsAs("ada"))).toContain(FOREIGN_REPO);
      });
    });

    // ── PATCH /api/products/:id and /:id/repos/:repoId ───────────────────────

    describe("updating a product", () => {
      const patch = (path: string, who: Who, body: object) =>
        request(app()).patch(path).set("Authorization", bearer(who)).send(body);

      it("returns only the readable repos from a metadata update", async () => {
        const res = await patch(`/api/products/${productX}`, "bob", {});
        expect(res.status).toBe(200);
        expect(repoIds(res.body.data.repos)).toEqual([rc.a, rc.c, rc.l].sort());
        expect(res.body.data.inaccessibleRepoCount).toBe(1);
        const text = JSON.stringify(res.body);
        expect(text).not.toContain(rc.b);
        expect(text).not.toContain(FOREIGN_REPO);
      });

      it("answers a role update on a hidden repo as if it were not attached", async () => {
        const res = await patch(`/api/products/${productX}/repos/${rc.b}`, "bob", {
          role: "frontend",
        });
        const missing = await patch(`/api/products/${productX}/repos/rc-nope-1258`, "bob", {
          role: "frontend",
        });
        expect(res.status).toBe(404);
        expect(missing.status).toBe(404);
        expect(res.body.error.code).toBe("REPO_NOT_ASSOCIATED");
        expect(res.body.error.code).toBe(missing.body.error.code);
        expect(JSON.stringify(res.body)).not.toContain(FOREIGN_REPO);
        const row = await db.productRepo.findUnique({
          where: { productId_repoConnectionId: { productId: productX, repoConnectionId: rc.b } },
        });
        expect(row?.role).toBe("backend-api");
      });

      it("still lets a member update a readable repo's role, and an admin a hidden one's", async () => {
        const mine = await patch(`/api/products/${productX}/repos/${rc.c}`, "bob", {
          role: "frontend",
        });
        expect(mine.status).toBe(200);
        expect(mine.body.data.role).toBe("frontend");
        const admin = await patch(`/api/products/${productX}/repos/${rc.b}`, "ada", {
          role: "backend-api",
        });
        expect(admin.status).toBe(200);
      });
    });

    // ── The read-only audit query, on the real migrated schema ───────────────

    describe("the cross-workspace audit query (scripts/audit-cross-workspace-product-repos.mjs)", () => {
      it("lists Product X's rows, since its repos span two workspaces", async () => {
        // A URL specifier: the scripts package ships plain `.mjs` with no
        // declarations, so a literal path would fail the server's typecheck.
        const core = new URL(
          "../../scripts/lib/cross-workspace-product-repos-core.mjs",
          import.meta.url,
        );
        const { CROSS_WORKSPACE_PRODUCT_REPOS_SQL } = (await import(core.href)) as {
          CROSS_WORKSPACE_PRODUCT_REPOS_SQL: string;
        };
        const rows = await db.$queryRawUnsafe<
          Array<{
            productId: string;
            repoConnectionId: string;
            repoWorkspaceId: string;
            creatorIsMember: number | bigint;
          }>
        >(CROSS_WORKSPACE_PRODUCT_REPOS_SQL);
        const mine = rows.filter((r) => r.productId === productX);
        // The legacy repo is in no workspace, so it is never listed.
        expect(mine.map((r) => r.repoConnectionId).sort()).toEqual([rc.a, rc.b, rc.c].sort());
        const foreign = mine.find((r) => r.repoConnectionId === rc.b)!;
        expect(foreign.repoWorkspaceId).toBe(WS2);
        expect(Number(foreign.creatorIsMember)).toBe(0);
      });
    });

    // ── POST /api/products/:id/repos (soft-deleted connection) ───────────────

    describe("attaching a soft-deleted repo connection", () => {
      const attach = (who: Who, repoConnectionId: string) =>
        post(`/api/products/${productX}/repos`, who, { repoConnectionId });

      it("refuses a member with the same 404 body as a missing id", async () => {
        const res = await attach("bob", rc.deleted);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({
          error: { code: "REPO_NOT_FOUND", message: `RepoConnection ${rc.deleted} not found` },
        });
        const missing = await attach("bob", "rc-does-not-exist-1258");
        expect(missing.status).toBe(404);
        expect(missing.body).toEqual({
          error: {
            code: "REPO_NOT_FOUND",
            message: "RepoConnection rc-does-not-exist-1258 not found",
          },
        });
        expect(
          await db.productRepo.count({
            where: { productId: productX, repoConnectionId: rc.deleted },
          }),
        ).toBe(0);
      });

      it("refuses an admin too", async () => {
        // A product of its own, so this does not lean on the member test's outcome.
        const fresh = (
          await db.product.create({
            data: { name: "Fresh", slug: "fresh-1258", createdById: "ada" },
          })
        ).id;
        const res = await post(`/api/products/${fresh}/repos`, "ada", {
          repoConnectionId: rc.deleted,
        });
        expect(res.status).toBe(404);
        expect(res.body).toEqual({
          error: { code: "REPO_NOT_FOUND", message: `RepoConnection ${rc.deleted} not found` },
        });
        expect(await db.productRepo.count({ where: { productId: fresh } })).toBe(0);
      });
    });
  },
);
