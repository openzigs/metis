/**
 * #1261 — follow-ups to #1258, which made `/api/products/:id/analyze` skip the
 * repos the acting member cannot read. Product documents are stored per product,
 * not per caller, so:
 *
 * - every shared document a run writes while a repo is hidden from the actor
 *   records `partial: true` and `inaccessibleRepoCount` in its metadata — the
 *   unified doc, and the per-service and api-contract docs of every repo with an
 *   edge to a skipped repo — and a later full run clears it (AC1: mark, don't
 *   refuse);
 * - detaching a repo the caller cannot read is audited (AC2);
 * - a connection soft-deleted AFTER it was attached is left out of the product
 *   reads and of `/analyze` (AC4).
 *
 * Workspace `ws1` holds projects A and C; Bob is a `ws1` member. Mallory is in
 * `ws2` with project B. Project L is legacy (no workspace). Each test seeds its
 * own product carrying repos A, C, L and the cross-workspace repo B (written
 * the way the pre-#1257 route allowed), with edges A→B, B→A and A→C. Ada is the
 * only admin. Row cardinality is asserted as Ada, whose view no reader filter
 * thins out.
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

const WS1 = "ws1-1261";
const WS2 = "ws2-1261";
const PA = "proj-a-1261";
const PC = "proj-c-1261";
const PB = "proj-b-1261";
const PL = "proj-legacy-1261";

const FOREIGN_REPO = "foreign-repo-b-1261";
const GONE_REPO = "soft-deleted-repo-1261";

const USERS: Record<string, { role: RoleKey; ws: string }> = {
  bob: { role: "coordinator", ws: WS1 },
  mallory: { role: "coordinator", ws: WS2 },
  ada: { role: "admin", ws: WS2 },
};
type Who = keyof typeof USERS;

interface Doc {
  docType: string;
  repoId: string | null;
  metadata: string;
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1261 — partial product documents, detach audit, soft-deleted attached repos",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let seq = 0;

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
    const post = (path: string, who: Who) =>
      request(app()).post(path).set("Authorization", bearer(who)).send({});
    const del = (path: string, who: Who) =>
      request(app()).delete(path).set("Authorization", bearer(who));
    const patch = (path: string, who: Who, body: object) =>
      request(app()).patch(path).set("Authorization", bearer(who)).send(body);

    const analyze = async (productId: string, who: Who) => {
      const res = await post(`/api/products/${productId}/analyze`, who);
      expect(res.status).toBe(200);
      return res;
    };
    const docsAs = async (productId: string, who: Who) => {
      const res = await get(`/api/products/${productId}/documents`, who);
      expect(res.status).toBe(200);
      return res.body.data as Doc[];
    };
    const meta = (doc: Doc | undefined) => {
      expect(doc).toBeDefined();
      return JSON.parse(doc!.metadata) as { partial?: unknown; inaccessibleRepoCount?: unknown };
    };
    const only = (docs: Doc[], docType: string, repoId: string | null) => {
      const hits = docs.filter((d) => d.docType === docType && d.repoId === repoId);
      expect(hits).toHaveLength(1);
      return hits[0];
    };

    /** A fresh connection per call, so no test leans on another's rows. */
    const connection = async (projectId: string, repoName: string, deletedAt?: Date) =>
      (
        await db.repoConnection.create({
          data: {
            projectId,
            label: repoName,
            repoName,
            ownerOrOrg: `org-${repoName}`,
            createdById: "ada",
            ...(deletedAt ? { deletedAt } : {}),
          },
        })
      ).id;

    /** A product carrying repos A, C, L, B, with edges A→B, B→A and A→C. */
    const seedProduct = async () => {
      seq += 1;
      const n = `${seq}-1261`;
      const productId = (
        await db.product.create({
          data: { name: `Product ${n}`, slug: `product-${n}`, createdById: "ada" },
        })
      ).id;
      const rc = {
        a: await connection(PA, `repo-a-${n}`),
        c: await connection(PC, `repo-c-${n}`),
        l: await connection(PL, `repo-l-${n}`),
        b: await connection(PB, `${FOREIGN_REPO}-${n}`),
      };
      for (const id of Object.values(rc)) {
        await db.productRepo.create({
          data: { productId, repoConnectionId: id, role: "backend-api" },
        });
      }
      for (const [sourceRepoId, targetRepoId] of [
        [rc.a, rc.b],
        [rc.b, rc.a],
        [rc.a, rc.c],
      ]) {
        await db.productEdge.create({
          data: {
            productId,
            sourceRepoId,
            targetRepoId,
            edgeType: "calls",
            confidence: 0.9,
            evidence: JSON.stringify([{ snippet: "s", pattern: "p" }]),
          },
        });
      }
      return { productId, rc };
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1261-product-partial-docs");
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
        [PC, WS1],
        [PB, WS2],
        [PL, null],
      ] as const) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById: "ada", workspaceId, status: "active" },
        });
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      auditSpy.mockClear();
    });

    // ── AC1: mark, don't refuse ─────────────────────────────────────────────

    describe("a member's run while a repo is hidden from them", () => {
      it("marks the unified doc and the hidden repo's edge neighbours' docs partial", async () => {
        const { productId, rc } = await seedProduct();
        await analyze(productId, "ada");
        const res = await analyze(productId, "bob");
        expect(res.body.data.inaccessibleRepoCount).toBe(1);

        // As the admin: every row, nothing filtered.
        const docs = await docsAs(productId, "ada");
        expect(docs.filter((d) => d.docType === "unified-architecture")).toHaveLength(1);
        expect(meta(only(docs, "unified-architecture", null))).toMatchObject({
          partial: true,
          inaccessibleRepoCount: 1,
        });
        // A has edges to and from the skipped repo B.
        for (const docType of ["per-service", "api-contract"]) {
          expect(meta(only(docs, docType, rc.a))).toMatchObject({
            partial: true,
            inaccessibleRepoCount: 1,
          });
        }
        // C and L have no edge to B: their docs are complete.
        for (const repoId of [rc.c, rc.l]) {
          for (const docType of ["per-service", "api-contract"]) {
            expect(meta(only(docs, docType, repoId))).toMatchObject({
              partial: false,
              inaccessibleRepoCount: 0,
            });
          }
        }
        // B's own docs are the admin's earlier, complete ones, kept as they were.
        for (const docType of ["per-service", "api-contract"]) {
          expect(meta(only(docs, docType, rc.b))).toMatchObject({ partial: false });
        }
      });

      it("shows the member the same partial marker on the docs they can read", async () => {
        const { productId, rc } = await seedProduct();
        await analyze(productId, "bob");
        const docs = await docsAs(productId, "bob");
        expect(meta(only(docs, "unified-architecture", null)).partial).toBe(true);
        expect(meta(only(docs, "per-service", rc.a)).partial).toBe(true);
        expect(JSON.stringify(docs)).not.toContain(FOREIGN_REPO);
        expect(JSON.stringify(docs)).not.toContain(rc.b);
      });

      it("counts every hidden repo on the unified doc", async () => {
        // Mallory reads B and L only: A and C are hidden from her.
        const { productId, rc } = await seedProduct();
        const res = await analyze(productId, "mallory");
        expect(res.body.data.inaccessibleRepoCount).toBe(2);
        const docs = await docsAs(productId, "ada");
        expect(meta(only(docs, "unified-architecture", null))).toMatchObject({
          partial: true,
          inaccessibleRepoCount: 2,
        });
        // B's only neighbour is A.
        expect(meta(only(docs, "per-service", rc.b))).toMatchObject({
          partial: true,
          inaccessibleRepoCount: 1,
        });
        expect(meta(only(docs, "per-service", rc.l))).toMatchObject({ partial: false });
      });

      it("is cleared by a later full run", async () => {
        const { productId } = await seedProduct();
        await analyze(productId, "bob");
        await analyze(productId, "ada");
        const docs = await docsAs(productId, "ada");
        expect(docs).toHaveLength(9); // unified + 4 per-service + 4 api-contract
        for (const doc of docs) {
          expect(meta(doc)).toMatchObject({ partial: false, inaccessibleRepoCount: 0 });
        }
      });

      it("does not mark a member's run that hides nothing", async () => {
        const { productId, rc } = await seedProduct();
        // Without the foreign repo, Bob reads every repo on the product.
        await db.productRepo.delete({
          where: { productId_repoConnectionId: { productId, repoConnectionId: rc.b } },
        });
        const res = await analyze(productId, "bob");
        expect(res.body.data.inaccessibleRepoCount).toBe(0);
        for (const doc of await docsAs(productId, "ada")) {
          expect(meta(doc).partial).toBe(false);
        }
      });
    });

    // ── AC2: detaching a repo the caller cannot read ────────────────────────

    describe("detaching a repo", () => {
      const detachEvents = () =>
        auditSpy.mock.calls
          .map((c) => c[0])
          .filter((e) => e.action === "product.repo.detach.unreadable");

      it("audits a member detaching a repo they cannot read", async () => {
        const { productId, rc } = await seedProduct();
        const res = await del(`/api/products/${productId}/repos/${rc.b}`, "bob");
        expect(res.status).toBe(204);
        expect(detachEvents()).toEqual([
          {
            actor: { id: "bob" },
            action: "product.repo.detach.unreadable",
            target: { type: "product", id: productId },
            metadata: { reason: "project-access-denied", repoConnectionId: rc.b },
          },
        ]);
        expect(await db.productRepo.count({ where: { productId, repoConnectionId: rc.b } })).toBe(
          0,
        );
      });

      it("does not audit detaching a readable repo, or an admin's detach", async () => {
        const { productId, rc } = await seedProduct();
        expect((await del(`/api/products/${productId}/repos/${rc.c}`, "bob")).status).toBe(204);
        expect((await del(`/api/products/${productId}/repos/${rc.b}`, "ada")).status).toBe(204);
        expect(detachEvents()).toEqual([]);
      });

      it("does not audit an id that is not attached", async () => {
        const { productId } = await seedProduct();
        const res = await del(`/api/products/${productId}/repos/rc-nope-1261`, "bob");
        expect(res.status).toBe(404);
        expect(detachEvents()).toEqual([]);
      });
    });

    // ── AC4: a connection soft-deleted after it was attached ────────────────

    describe("a connection soft-deleted after it was attached", () => {
      const seedWithGone = async () => {
        const seeded = await seedProduct();
        const gone = await connection(PA, `${GONE_REPO}-${seq}`);
        await db.productRepo.create({
          data: { productId: seeded.productId, repoConnectionId: gone, role: "backend-api" },
        });
        await db.productEdge.create({
          data: {
            productId: seeded.productId,
            sourceRepoId: seeded.rc.a,
            targetRepoId: gone,
            edgeType: "calls",
            confidence: 0.9,
            evidence: JSON.stringify([{ snippet: "s", pattern: "p" }]),
          },
        });
        await db.repoConnection.update({ where: { id: gone }, data: { deletedAt: new Date() } });
        return { ...seeded, gone };
      };
      const ids = (repos: Array<{ repoConnectionId: string }>) =>
        repos.map((r) => r.repoConnectionId).sort();

      it("is left out of a product read, for an admin and a member", async () => {
        const { productId, rc, gone } = await seedWithGone();
        const admin = await get(`/api/products/${productId}`, "ada");
        expect(admin.status).toBe(200);
        expect(ids(admin.body.data.repos)).toEqual([rc.a, rc.c, rc.l, rc.b].sort());
        expect(admin.body.data.inaccessibleRepoCount).toBe(0);
        const member = await get(`/api/products/${productId}`, "bob");
        expect(ids(member.body.data.repos)).toEqual([rc.a, rc.c, rc.l].sort());
        // Gone, not hidden: it is not counted either.
        expect(member.body.data.inaccessibleRepoCount).toBe(1);
        expect(JSON.stringify([admin.body, member.body])).not.toContain(gone);
      });

      it("is left out of the product list and a metadata update's response", async () => {
        const { productId, rc, gone } = await seedWithGone();
        const list = await get(`/api/products?pageSize=100`, "ada");
        const item = list.body.data.items.find((p: { id: string }) => p.id === productId);
        expect(ids(item.repos)).toEqual([rc.a, rc.c, rc.l, rc.b].sort());
        const updated = await patch(`/api/products/${productId}`, "ada", {});
        expect(updated.status).toBe(200);
        expect(ids(updated.body.data.repos)).toEqual([rc.a, rc.c, rc.l, rc.b].sort());
        expect(JSON.stringify([list.body, updated.body])).not.toContain(gone);
      });

      it("is not analysed, and does not make the run partial", async () => {
        const { productId, gone } = await seedWithGone();
        const res = await analyze(productId, "ada");
        expect(res.body.data.inaccessibleRepoCount).toBe(0);
        // A→B, B→A, A→C — not A→gone.
        expect(res.body.data.edgesDetected).toBe(3);
        expect(res.body.data.contractDocs.map((d: { repoId: string }) => d.repoId)).not.toContain(
          gone,
        );
        const docs = await docsAs(productId, "ada");
        expect(docs).toHaveLength(9);
        expect(JSON.stringify(docs)).not.toContain(GONE_REPO);
        expect(JSON.stringify(docs)).not.toContain(gone);
        for (const doc of docs) expect(meta(doc).partial).toBe(false);
        expect(await db.productContractDoc.count({ where: { repoId: gone } })).toBe(0);
      });
    });
  },
);
