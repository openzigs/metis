/**
 * #1232 — products, impact-analysis detail, run access and the cross-project
 * impact queries follow project access: the project's live workspace members,
 * not only its creator (the #1221 rule, `assertProjectAccess` via
 * `actorHasProjectAccess` / `listMemberAccessibleProjectIds` /
 * `listMemberProjectsInWorkspace`).
 *
 * Workspace `ws1` holds projects A and C, both created by Alice, and a
 * soft-deleted project D. Bob is a second member of `ws1` (coordinator, NOT
 * the creator), Rita a third (reader role). Mallory is a coordinator in `ws2`,
 * where she created project B. Dora (disabled), Sid (soft-deleted) and Gus
 * (membership row deleted) were `ws1` members whose access ended after their
 * token was minted. Wendy created project W in a workspace that was since
 * soft-deleted. Nobody here is a system admin — an admin bypasses the check, so
 * an admin test proves nothing about it.
 *
 * Real SQLite built by the migration chain, real routers, services and JWTs;
 * only the audit sink is a double. No model is called.
 *
 * Each "Bob/Rita may" assertion fails if the creator-only rule is restored on
 * its path; each revoked-member assertion fails if the path reads the token's
 * workspace claim instead of the live membership.
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
const auditSpy = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: auditSpy }));

const { productsRouter } = await import("../src/routes/products-multi.js");
const { impactAnalysisRouter } = await import("../src/routes/impact-analysis.js");
const { runsRouter } = await import("../src/routes/runs.js");
const { resolveJobRoomScope } = await import("../src/lib/socket/room-access.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const WS1 = "ws1-1232";
const WS2 = "ws2-1232";
const WS_DEAD = "ws-dead-1232";
const PA = "proj-a-1232";
const PC = "proj-c-1232";
const PD = "proj-d-1232"; // soft-deleted, in ws1
const PB = "proj-b-1232";
const PW = "proj-w-1232"; // in the soft-deleted workspace
const PL = "proj-legacy-1232"; // legacy: no workspace

const USERS: Record<string, { role: RoleKey; ws: string }> = {
  alice: { role: "coordinator", ws: WS1 },
  bob: { role: "coordinator", ws: WS1 },
  rita: { role: "reader", ws: WS1 },
  mallory: { role: "coordinator", ws: WS2 },
  dora: { role: "coordinator", ws: WS1 },
  sid: { role: "coordinator", ws: WS1 },
  gus: { role: "coordinator", ws: WS1 },
  wendy: { role: "coordinator", ws: WS_DEAD },
};
const MEMBERS = ["bob", "rita"] as const;
const REVOKED = ["dora", "sid", "gus"] as const;
type Who = keyof typeof USERS;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1232 — products, impact detail, runs and cross-project impact are open to the project's workspace members",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const product: Record<"a" | "b" | "d" | "w", string> = { a: "", b: "", d: "", w: "" };
    const repo: Record<"a" | "b", string> = { a: "", b: "" };
    const impact: Record<"a" | "b" | "orphan", string> = { a: "", b: "", orphan: "" };
    const run: Record<"a" | "d" | "w", string> = { a: "", d: "", w: "" };

    const userPayload = (who: Who): AuthPayload => ({
      userId: who,
      username: who,
      role: USERS[who].role,
      permissions: getPermissionsForRole(USERS[who].role),
      // The claim minted at login: every revoked user still carries `ws1`.
      workspaces: [USERS[who].ws],
    });
    const bearer = (who: Who) => `Bearer ${issueTokens(userPayload(who)).accessToken}`;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/products", productsRouter());
      a.use("/api/impact-analyses", impactAnalysisRouter());
      a.use("/api/runs", runsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const get = (path: string, who: Who) =>
      request(app()).get(path).set("Authorization", bearer(who));

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1232-member-access");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const key of ["coordinator", "reader"]) {
        await db.role.create({ data: { id: `role-${key}`, key, name: key } });
      }
      for (const [id, u] of Object.entries(USERS)) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
        await db.userRole.create({ data: { userId: id, roleId: `role-${u.role}` } });
      }
      for (const ws of [WS1, WS2, WS_DEAD]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      for (const [userId, u] of Object.entries(USERS)) {
        await db.workspaceMember.create({ data: { workspaceId: u.ws, userId, role: "member" } });
      }
      for (const [id, createdById, workspaceId] of [
        [PA, "alice", WS1],
        [PC, "alice", WS1],
        [PD, "alice", WS1],
        [PB, "mallory", WS2],
        [PW, "wendy", WS_DEAD],
        [PL, "alice", null],
      ] as const) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById, workspaceId, status: "active" },
        });
      }

      // Products, each bound to one project through a repo connection.
      const bind = async (key: "a" | "b" | "d" | "w", projectId: string, createdById: string) => {
        const rc = await db.repoConnection.create({
          data: { projectId, label: `rc-${key}`, repoName: `repo-${key}`, createdById },
        });
        const p = await db.product.create({
          data: { name: `Product ${key}`, slug: `product-${key}-1232`, createdById },
        });
        await db.productRepo.create({ data: { productId: p.id, repoConnectionId: rc.id } });
        product[key] = p.id;
        return rc.id;
      };
      repo.a = await bind("a", PA, "alice");
      repo.b = await bind("b", PB, "mallory");
      await bind("d", PD, "alice");
      await bind("w", PW, "wendy");

      // Impact analyses over one project each.
      for (const [key, projectId, startedById] of [
        ["a", PA, "alice"],
        ["b", PB, "mallory"],
      ] as const) {
        const ia = await db.impactAnalysis.create({
          data: { status: "completed", startedById, sourceText: `change ${key}` },
        });
        await db.impactAnalysisProject.create({ data: { analysisId: ia.id, projectId } });
        impact[key] = ia.id;
      }
      // A pre-#70 run that names no project: its starter's alone (#88).
      impact.orphan = (
        await db.impactAnalysis.create({ data: { status: "completed", startedById: "alice" } })
      ).id;

      // Agent runs.
      for (const [key, projectId] of [
        ["a", PA],
        ["d", PD],
        ["w", PW],
      ] as const) {
        run[key] = (
          await db.agentRun.create({
            data: { sessionId: `s-${key}`, projectId, status: "completed" },
          })
        ).id;
      }

      // A shared database resource in ws1 whose `public.orders` A and C both use.
      const resource = await db.databaseResource.create({
        data: { workspaceId: WS1, driver: "postgres", host: "db", databaseName: "app" },
      });
      await db.schemaObjectIdentity.create({
        data: {
          databaseResourceId: resource.id,
          schemaName: "public",
          objectName: "orders",
          objectType: "table",
        },
      });
      for (const projectId of [PA, PC]) {
        await db.schemaUsageClassification.create({
          data: {
            projectId,
            kind: "table",
            tableName: "public.orders",
            usageClass: "used",
            evidence: JSON.stringify([{ edgeKind: "reads" }]),
          },
        });
      }

      // Access ended after the token was minted.
      await db.project.update({ where: { id: PD }, data: { deletedAt: new Date() } });
      await db.workspace.update({ where: { id: WS_DEAD }, data: { deletedAt: new Date() } });
      await db.user.update({ where: { id: "dora" }, data: { status: "disabled" } });
      await db.user.update({ where: { id: "sid" }, data: { deletedAt: new Date() } });
      await db.workspaceMember.deleteMany({ where: { userId: "gus" } });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    // ── Products ─────────────────────────────────────────────────────────────

    describe("products", () => {
      const listedIds = async (who: Who) => {
        const res = await get("/api/products?pageSize=100", who);
        expect(res.status).toBe(200);
        return (res.body.data.items as { id: string }[]).map((p) => p.id);
      };

      it("both members list the product of a project a teammate created; the other workspace's stays hidden", async () => {
        for (const who of MEMBERS) {
          const ids = await listedIds(who);
          expect(ids, who).toContain(product.a);
          expect(ids, who).not.toContain(product.b);
        }
        const mallory = await listedIds("mallory");
        expect(mallory).toContain(product.b);
        expect(mallory).not.toContain(product.a);
      });

      it("never lists a product of a soft-deleted project or workspace", async () => {
        expect(await listedIds("bob")).not.toContain(product.d);
        expect(await listedIds("wendy")).not.toContain(product.w);
      });

      it("lists nothing of ws1 to a disabled, soft-deleted or removed member", async () => {
        for (const who of REVOKED) expect(await listedIds(who), who).not.toContain(product.a);
      });

      it("the repo-connection picker shows a member the teammate's connection, not another workspace's", async () => {
        const res = await get("/api/products/repo-connections", "bob");
        expect(res.status).toBe(200);
        const ids = (res.body.data as { id: string }[]).map((c) => c.id);
        expect(ids).toContain(repo.a);
        expect(ids).not.toContain(repo.b);
        const revoked = await get("/api/products/repo-connections", "dora");
        expect((revoked.body.data as { id: string }[]).map((c) => c.id)).not.toContain(repo.a);
      });

      it("both members open the product by id; the non-member and revoked members get 404", async () => {
        for (const who of MEMBERS) {
          const res = await get(`/api/products/${product.a}`, who);
          expect(res.status, who).toBe(200);
          expect(res.body.data.id).toBe(product.a);
        }
        for (const who of ["mallory", ...REVOKED] as const) {
          expect((await get(`/api/products/${product.a}`, who)).status, who).toBe(404);
        }
      });

      it("a product of a soft-deleted project or workspace answers 404", async () => {
        expect((await get(`/api/products/${product.d}`, "bob")).status).toBe(404);
        expect((await get(`/api/products/${product.w}`, "wendy")).status).toBe(404);
      });

      it("writes keep their role permission: the coordinator member updates, the reader member is refused", async () => {
        const patch = (who: Who) =>
          request(app())
            .patch(`/api/products/${product.a}`)
            .set("Authorization", bearer(who))
            .send({ description: `edited by ${who}` });
        expect((await patch("bob")).status).toBe(200);
        expect((await patch("rita")).status).toBe(403);
        expect((await patch("mallory")).status).toBe(404);
        expect((await patch("dora")).status).toBe(404);
        const row = await db.product.findUnique({ where: { id: product.a } });
        expect(row?.description).toBe("edited by bob");
      });
    });

    // ── Impact analysis ──────────────────────────────────────────────────────

    describe("impact-analysis detail", () => {
      it("both members list and open a run a teammate started; the non-member does not see it", async () => {
        for (const who of MEMBERS) {
          const list = await get("/api/impact-analyses", who);
          expect(list.status, who).toBe(200);
          const ids = (list.body.data as { id: string }[]).map((r) => r.id);
          expect(ids, who).toContain(impact.a);
          expect(ids, who).not.toContain(impact.b);
          const filtered = await get(`/api/impact-analyses?projectId=${PA}`, who);
          expect((filtered.body.data as { id: string }[]).map((r) => r.id)).toContain(impact.a);
          const detail = await get(`/api/impact-analyses/${impact.a}`, who);
          expect(detail.status, who).toBe(200);
          expect(detail.body.data.id).toBe(impact.a);
        }
        const mallory = await get("/api/impact-analyses", "mallory");
        expect((mallory.body.data as { id: string }[]).map((r) => r.id)).not.toContain(impact.a);
        expect((await get(`/api/impact-analyses/${impact.a}`, "mallory")).status).toBe(404);
      });

      it("a run that names no project stays its starter's alone; an unknown id is 404", async () => {
        expect((await get(`/api/impact-analyses/${impact.orphan}`, "alice")).status).toBe(200);
        for (const who of MEMBERS) {
          expect((await get(`/api/impact-analyses/${impact.orphan}`, who)).status, who).toBe(404);
        }
        expect((await get("/api/impact-analyses/no-such-run-1232", "bob")).status).toBe(404);
      });

      it("a disabled, soft-deleted or removed member neither lists nor opens it", async () => {
        for (const who of REVOKED) {
          const list = await get("/api/impact-analyses", who);
          expect(
            (list.body.data as { id: string }[]).map((r) => r.id),
            who,
          ).not.toContain(impact.a);
          expect((await get(`/api/impact-analyses/${impact.a}`, who)).status, who).toBe(404);
        }
      });

      it("the run's live socket room admits both members and refuses the others", async () => {
        for (const who of MEMBERS) {
          expect(await resolveJobRoomScope(userPayload(who), impact.a), who).not.toBeNull();
        }
        for (const who of ["mallory", ...REVOKED] as const) {
          expect(await resolveJobRoomScope(userPayload(who), impact.a), who).toBeNull();
        }
      });

      it("both members read a teammate's project's usage overrides; the others are refused", async () => {
        for (const who of MEMBERS) {
          expect(
            (await get(`/api/impact-analyses/projects/${PA}/usage-overrides`, who)).status,
            who,
          ).toBe(200);
        }
        for (const who of ["mallory", ...REVOKED] as const) {
          expect(
            (await get(`/api/impact-analyses/projects/${PA}/usage-overrides`, who)).status,
            who,
          ).toBe(403);
        }
        expect(
          (await get(`/api/impact-analyses/projects/${PD}/usage-overrides`, "bob")).status,
        ).toBe(403);
      });

      it("writes keep their role permission: the coordinator member records an override, the reader is refused", async () => {
        const post = (who: Who) =>
          request(app())
            .post(`/api/impact-analyses/projects/${PA}/usage-overrides`)
            .set("Authorization", bearer(who))
            .send({ kind: "table", tableName: "public.orders", usageClass: "used" });
        expect((await post("bob")).status).toBe(201);
        expect((await post("rita")).status).toBe(403);
        expect((await post("mallory")).status).toBe(403);
        expect((await post("dora")).status).toBe(403);
      });
    });

    // ── Run access ───────────────────────────────────────────────────────────

    describe("run access (/api/runs/:id)", () => {
      it("both members open a run of a teammate's project, and its replay", async () => {
        for (const who of MEMBERS) {
          const res = await get(`/api/runs/${run.a}`, who);
          expect(res.status, who).toBe(200);
          expect(res.body.data.run.id).toBe(run.a);
          expect((await get(`/api/runs/${run.a}/replay`, who)).status, who).toBe(200);
        }
      });

      it("the non-member and revoked members get the same 404 as an unknown run", async () => {
        for (const who of ["mallory", ...REVOKED] as const) {
          const res = await get(`/api/runs/${run.a}`, who);
          expect(res.status, who).toBe(404);
          expect(res.body.error.code).toBe("RUN_NOT_FOUND");
        }
      });

      it("a run of a soft-deleted project or workspace answers 404", async () => {
        expect((await get(`/api/runs/${run.d}`, "bob")).status).toBe(404);
        expect((await get(`/api/runs/${run.w}`, "wendy")).status).toBe(404);
      });
    });

    // ── Cross-project impact ─────────────────────────────────────────────────

    describe("cross-project impact", () => {
      it("both members read a teammate's project's cross-project impact", async () => {
        for (const who of MEMBERS) {
          const res = await get(`/api/impact-analyses/projects/${PA}/cross-project-impact`, who);
          expect(res.status, who).toBe(200);
          expect(res.body.data.workspaceId).toBe(WS1);
          const orders = res.body.data.affectedObjects.find(
            (o: { objectName: string }) => o.objectName === "orders",
          );
          expect(orders?.alsoUsedByProjects.map((p: { projectId: string }) => p.projectId)).toEqual(
            [PC],
          );
        }
      });

      it("both members see every project in their workspace that uses an object", async () => {
        for (const who of MEMBERS) {
          const res = await get(
            `/api/impact-analyses/workspaces/${WS1}/objects/usage?schemaName=public&objectName=orders`,
            who,
          );
          expect(res.status, who).toBe(200);
          const ids = (res.body.data.projects as { projectId: string }[]).map((p) => p.projectId);
          expect(ids.sort(), who).toEqual([PA, PC].sort());
        }
      });

      it("a legacy workspace-less project is open to every authenticated user, not only its creator", async () => {
        for (const who of [...MEMBERS, "mallory"] as const) {
          const res = await get(`/api/impact-analyses/projects/${PL}/cross-project-impact`, who);
          expect(res.status, who).toBe(200);
          expect(res.body.data).toEqual({
            sourceProjectId: PL,
            workspaceId: "",
            affectedObjects: [],
          });
        }
      });

      it("the non-member and revoked members get 404 on both", async () => {
        for (const who of ["mallory", ...REVOKED] as const) {
          expect(
            (await get(`/api/impact-analyses/projects/${PA}/cross-project-impact`, who)).status,
            who,
          ).toBe(404);
          expect(
            (
              await get(
                `/api/impact-analyses/workspaces/${WS1}/objects/usage?schemaName=public&objectName=orders`,
                who,
              )
            ).status,
            who,
          ).toBe(404);
        }
      });
    });
  },
);
