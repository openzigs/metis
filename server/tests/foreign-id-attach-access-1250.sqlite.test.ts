/**
 * #1250 — a product or impact-analysis write that takes a caller-supplied
 * foreign id checks the caller's access to THAT id's own project, not only to
 * the product or the run's projects:
 *
 * - `POST /api/products/:id/repos` — the `repoConnectionId` must belong to a
 *   project the caller can open. Otherwise `/analyze` would run over another
 *   tenant's repository once it is attached.
 * - `POST /api/impact-analyses` — the `documentId` must belong to a project the
 *   caller can open. Otherwise the run reads another tenant's document text.
 * - `POST /api/impact-analyses/:id/rerun` — re-reads the original's document,
 *   so the re-runner needs access to that document's project too.
 *
 * An inaccessible id is refused exactly as a nonexistent one (no existence
 * oracle), and the denial is audited.
 *
 * Workspace `ws1` holds projects A and C, created by Alice; Bob is a second
 * `ws1` member (coordinator, NOT the creator). Mallory is a coordinator in
 * `ws2` with project B. Nina is a coordinator in `ws3`, which holds nothing of
 * interest — a non-member of both. Project L is legacy (no workspace) and so
 * open to every authenticated user. Nobody here is a system admin: an admin
 * bypasses the check, so an admin test proves nothing about it.
 *
 * Real SQLite built by the migration chain, real routers, services and JWTs;
 * the audit sink and the impact engine's fire-and-forget trigger are doubles.
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
const triggerSpy = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/impact-analysis/impact-analysis-engine.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/lib/impact-analysis/impact-analysis-engine.js")
  >("../src/lib/impact-analysis/impact-analysis-engine.js");
  return { ...actual, triggerImpactAnalysis: triggerSpy };
});

const { productsRouter } = await import("../src/routes/products-multi.js");
const { impactAnalysisRouter } = await import("../src/routes/impact-analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const WS1 = "ws1-1250";
const WS2 = "ws2-1250";
const WS3 = "ws3-1250";
const PA = "proj-a-1250";
const PC = "proj-c-1250";
const PB = "proj-b-1250";
const PL = "proj-legacy-1250"; // legacy: no workspace

const USERS: Record<string, { role: RoleKey; ws: string }> = {
  alice: { role: "coordinator", ws: WS1 },
  bob: { role: "coordinator", ws: WS1 },
  mallory: { role: "coordinator", ws: WS2 },
  nina: { role: "coordinator", ws: WS3 },
  // A system admin, only to pin that the bypass still holds.
  ada: { role: "admin", ws: WS3 },
};
type Who = keyof typeof USERS;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1250 — a write that names a foreign id needs access to that id's own project",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const rc: Record<"a" | "c" | "b" | "l", string> = { a: "", c: "", b: "", l: "" };
    const doc: Record<"a" | "b" | "l" | "deleted", string> = {
      a: "",
      b: "",
      l: "",
      deleted: "",
    };
    let productA = "";
    let runFromDocA = "";
    let runFromDocB = "";

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
      a.use("/api/impact-analyses", impactAnalysisRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const post = (path: string, who: Who, body: object = {}) =>
      request(app()).post(path).set("Authorization", bearer(who)).send(body);

    /** An unbound product — open to every authenticated user (the null-workspace convention). */
    const openProduct = async (slug: string) =>
      (await db.product.create({ data: { name: slug, slug, createdById: "alice" } })).id;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1250-foreign-id-attach");
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
      for (const ws of [WS1, WS2, WS3]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      for (const [userId, u] of Object.entries(USERS)) {
        await db.workspaceMember.create({ data: { workspaceId: u.ws, userId, role: "member" } });
      }
      for (const [id, createdById, workspaceId] of [
        [PA, "alice", WS1],
        [PC, "alice", WS1],
        [PB, "mallory", WS2],
        [PL, "mallory", null],
      ] as const) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById, workspaceId, status: "active" },
        });
      }
      for (const [key, projectId, createdById] of [
        ["a", PA, "alice"],
        ["c", PC, "alice"],
        ["b", PB, "mallory"],
        ["l", PL, "mallory"],
      ] as const) {
        rc[key] = (
          await db.repoConnection.create({
            data: { projectId, label: `rc-${key}`, repoName: `repo-${key}`, createdById },
          })
        ).id;
      }
      // Product A is bound to project A through repo connection A.
      productA = (
        await db.product.create({
          data: { name: "Product A", slug: "product-a-1250", createdById: "alice" },
        })
      ).id;
      await db.productRepo.create({ data: { productId: productA, repoConnectionId: rc.a } });

      for (const [key, projectId, uploadedById] of [
        ["a", PA, "alice"],
        ["b", PB, "mallory"],
        ["l", PL, "mallory"],
        ["deleted", PA, "alice"],
      ] as const) {
        doc[key] = (
          await db.document.create({
            data: {
              projectId,
              filename: `${key}.md`,
              mimeType: "text/markdown",
              sizeBytes: 1,
              storagePath: `/tmp/${key}.md`,
              checksum: key,
              uploadedById,
              ...(key === "deleted" ? { deletedAt: new Date() } : {}),
            },
          })
        ).id;
      }

      // Completed runs over project A, sourced from a document. The doc-B run
      // is a row the pre-fix POST would have accepted.
      for (const [documentId, startedById] of [
        [doc.a, "alice"],
        [doc.b, "alice"],
      ] as const) {
        const ia = await db.impactAnalysis.create({
          data: { status: "completed", startedById, documentId },
        });
        await db.impactAnalysisProject.create({ data: { analysisId: ia.id, projectId: PA } });
        await db.impactItem.create({
          data: { impactAnalysisId: ia.id, projectId: PA },
        });
        if (documentId === doc.a) runFromDocA = ia.id;
        else runFromDocB = ia.id;
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      auditSpy.mockClear();
      triggerSpy.mockReset();
      triggerSpy.mockResolvedValue({ id: "new-run", status: "pending" });
    });

    const deniedAudits = (action: string) =>
      auditSpy.mock.calls.map((c) => c[0]).filter((e) => e.action === action);

    // ── POST /api/products/:id/repos ─────────────────────────────────────────

    describe("attaching a repo connection to a product", () => {
      const attach = (productId: string, who: Who, repoConnectionId: string) =>
        post(`/api/products/${productId}/repos`, who, { repoConnectionId });

      it("refuses a workspace member attaching another workspace's connection, as if it did not exist", async () => {
        const res = await attach(productA, "bob", rc.b);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({
          error: { code: "REPO_NOT_FOUND", message: `RepoConnection ${rc.b} not found` },
        });
        const missing = await attach(productA, "bob", "rc-does-not-exist");
        expect(missing.status).toBe(404);
        expect(missing.body).toEqual({
          error: { code: "REPO_NOT_FOUND", message: "RepoConnection rc-does-not-exist not found" },
        });
        expect(
          await db.productRepo.count({ where: { productId: productA, repoConnectionId: rc.b } }),
        ).toBe(0);
        expect(deniedAudits("product.repo.attach.denied")).toEqual([
          expect.objectContaining({
            actor: { id: "bob" },
            target: { type: "repo_connection", id: rc.b },
            metadata: expect.objectContaining({ projectId: PB }),
          }),
        ]);
      });

      it("refuses a non-member attaching a workspace's connection to a product they can open", async () => {
        const open = await openProduct("open-nina-1250");
        const res = await attach(open, "nina", rc.a);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("REPO_NOT_FOUND");
        expect(await db.productRepo.count({ where: { productId: open } })).toBe(0);
        expect(deniedAudits("product.repo.attach.denied")).toHaveLength(1);
      });

      it("still answers 409 for an accessible connection that is already attached", async () => {
        const dup = await attach(productA, "bob", rc.a);
        expect(dup.status).toBe(409);
        expect(dup.body.error.code).toBe("REPO_ALREADY_ASSOCIATED");
      });

      it("lets a member attach a teammate's connection from the same workspace", async () => {
        const res = await attach(productA, "bob", rc.c);
        expect(res.status).toBe(201);
        expect(res.body.data.repoConnectionId).toBe(rc.c);
        expect(deniedAudits("product.repo.attach.denied")).toEqual([]);
      });

      it("lets any member attach a legacy project's connection (no workspace)", async () => {
        const res = await attach(productA, "bob", rc.l);
        expect(res.status).toBe(201);
        const open = await openProduct("open-legacy-1250");
        expect((await attach(open, "nina", rc.l)).status).toBe(201);
      });

      it("keeps the admin bypass, and still answers a missing id with the same 404", async () => {
        const open = await openProduct("open-admin-1250");
        expect((await attach(open, "ada", rc.b)).status).toBe(201);
        const missing = await attach(open, "ada", "rc-does-not-exist");
        expect(missing.status).toBe(404);
        expect(missing.body.error.code).toBe("REPO_NOT_FOUND");
      });
    });

    // ── POST /api/impact-analyses ────────────────────────────────────────────

    describe("starting an impact analysis from a document", () => {
      const start = (who: Who, projectIds: string[], documentId: string) =>
        post("/api/impact-analyses", who, { projectIds, documentId });

      it("refuses a member naming another workspace's document, as if it did not exist", async () => {
        const res = await start("bob", [PA], doc.b);
        expect(res.status).toBe(404);
        const missing = await start("bob", [PA], "doc-does-not-exist");
        expect(missing.status).toBe(404);
        expect(res.body.error).toEqual(missing.body.error);
        expect(res.body.error.code).toBe("NOT_FOUND");
        expect(triggerSpy).not.toHaveBeenCalled();
        expect(deniedAudits("impact_analysis.document.denied")).toEqual([
          expect.objectContaining({
            actor: { id: "bob" },
            target: { type: "document", id: doc.b },
            metadata: expect.objectContaining({ projectId: PB }),
          }),
        ]);
      });

      it("refuses a non-member naming a workspace's document over a project they can open", async () => {
        const res = await start("nina", [PL], doc.a);
        expect(res.status).toBe(404);
        expect(triggerSpy).not.toHaveBeenCalled();
      });

      it("refuses a soft-deleted document", async () => {
        expect((await start("bob", [PA], doc.deleted)).status).toBe(404);
        expect(triggerSpy).not.toHaveBeenCalled();
      });

      it("lets a member start a run from a teammate's document and from a legacy project's", async () => {
        const res = await start("bob", [PA], doc.a);
        expect(res.status).toBe(202);
        expect(triggerSpy).toHaveBeenCalledWith(
          expect.objectContaining({ documentId: doc.a, projectIds: [PA] }),
          expect.anything(),
        );
        expect((await start("nina", [PL], doc.l)).status).toBe(202);
        expect(deniedAudits("impact_analysis.document.denied")).toEqual([]);
      });

      it("keeps the admin bypass for an existing document; a missing one is 404 for everyone", async () => {
        expect((await start("ada", [PB], doc.a)).status).toBe(202);
        expect((await start("ada", [PB], "doc-does-not-exist")).status).toBe(404);
      });

      it("still accepts a text-sourced run with no document", async () => {
        const res = await post("/api/impact-analyses", "bob", { projectIds: [PA], text: "x" });
        expect(res.status).toBe(202);
      });
    });

    // ── POST /api/impact-analyses/:id/rerun ──────────────────────────────────

    describe("re-running an impact analysis", () => {
      it("refuses a re-run that would re-read a document the caller cannot access", async () => {
        const res = await post(`/api/impact-analyses/${runFromDocB}/rerun`, "bob");
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("NOT_FOUND");
        expect(triggerSpy).not.toHaveBeenCalled();
        expect(deniedAudits("impact_analysis.document.denied")).toHaveLength(1);
      });

      it("lets a member re-run a teammate's run sourced from an accessible document", async () => {
        const res = await post(`/api/impact-analyses/${runFromDocA}/rerun`, "bob");
        expect(res.status).toBe(202);
        expect(triggerSpy).toHaveBeenCalledWith(
          expect.objectContaining({ documentId: doc.a, rerunOfId: runFromDocA }),
          expect.anything(),
        );
      });
    });
  },
);
