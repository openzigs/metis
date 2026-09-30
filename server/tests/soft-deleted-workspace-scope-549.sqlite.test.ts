/**
 * #549 — a soft-deleted workspace grants no project scope.
 *
 * Workspace DELETE sets `deletedAt` and leaves the membership rows in place, so
 * every reader that turned memberships into scope kept admitting a member of a
 * deleted workspace to its projects. Proven here through the REAL routers and
 * helpers against a REAL SQLite database built from the migration chain; no
 * access helper is mocked.
 *
 * Two workspaces: `ws-live` and `ws-dead` (soft-deleted in `beforeAll`). `u-both`
 * belongs to both, `u-dead` only to the deleted one. Each denial is paired with
 * a positive control on the live workspace, so a check that refuses everyone
 * cannot pass.
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
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
// The OIDC IdP is the only thing stubbed on the SSO path: a configured provider
// and a code exchange that returns `u-both`. Token minting reads the real DB.
vi.mock("../src/lib/auth/sso-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/auth/sso-config.js")>()),
  getProviderByMode: (mode: string) =>
    mode === "oidc" ? { oidc: {}, groupMappings: [], defaultRole: "developer" } : undefined,
}));
vi.mock("../src/lib/auth/oidc-provider.js", () => ({
  generateAuthorizationUrl: async () => ({
    url: "https://idp.example.test/authorize",
    codeVerifier: "verifier-549",
    state: "state-549",
    nonce: "nonce-549",
  }),
  exchangeCodeForTokens: async () => ({
    success: true,
    user: {
      username: "u-both",
      displayName: "u-both",
      email: "u-both@example.test",
      groups: [],
      mfaPassed: true,
    },
  }),
}));

const { projectsRouter } = await import("../src/routes/projects.js");
const { workspacesRouter } = await import("../src/routes/workspaces.js");
const { authRouter } = await import("../src/routes/auth.js");
const { ssoRouter } = await import("../src/routes/sso.js");
const { refreshAuthenticatedUser } = await import("../src/middleware/auth.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens, verifyAccessToken } = await import("../src/lib/auth/jwt.js");
const { getUserAccessibleProjects } = await import("../src/lib/auth/accessible-projects.js");
const { resolveAcpActor, listAccessibleProjectIds } = await import("../src/lib/acp/authz.js");
const { assertWorkspaceAdminForProject } = await import("../src/lib/custom-agents/authz.js");
const { listAccessibleWorkspaceIds, actorIsWorkspaceMember } =
  await import("../src/lib/cross-project/cross-project-access.js");
const { runProjectScope } = await import("../src/lib/async/run-authz.js");
const { listProjects } = await import("../src/lib/projects/project-service.js");

const LIVE = "ws-live-549";
const DEAD = "ws-dead-549";
const P_LIVE = "proj-live-549";
const P_DEAD = "proj-dead-549";
const P_OPEN = "proj-open-549"; // no workspace — open to every authenticated user

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#549 — a soft-deleted workspace grants no project scope",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const payload = (userId: string, role: RoleKey, workspaces: string[]): AuthPayload => ({
      userId,
      username: userId,
      role,
      permissions: getPermissionsForRole(role),
      workspaces,
    });
    // A token minted BEFORE the delete: its claim still names the dead workspace,
    // and token refresh carries the claim forward unchanged.
    const staleToken = (userId: string, workspaces: string[]) =>
      issueTokens(payload(userId, "developer", workspaces)).accessToken;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/auth", authRouter());
      a.use("/api/auth", ssoRouter());
      a.use("/api/projects", projectsRouter());
      a.use("/api/workspaces", workspacesRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("549-soft-deleted-workspace");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      // `developer` is a mock-auth login, so its row id is fixed here and the
      // login route's upsert (by username) keeps it.
      for (const id of ["u-both", "u-dead", "developer"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      for (const ws of [LIVE, DEAD]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      for (const [ws, userId] of [
        [LIVE, "u-both"],
        [DEAD, "u-both"],
        [DEAD, "u-dead"],
        [LIVE, "developer"],
        [DEAD, "developer"],
      ] as const) {
        await db.workspaceMember.create({ data: { workspaceId: ws, userId, role: "owner" } });
      }
      for (const [id, workspaceId] of [
        [P_LIVE, LIVE],
        [P_DEAD, DEAD],
        [P_OPEN, null],
      ] as const) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById: "u-both", workspaceId, status: "active" },
        });
      }
      // What `DELETE /api/workspaces/:id` does: a soft delete.
      await db.workspace.update({ where: { id: DEAD }, data: { deletedAt: new Date() } });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    describe("routes", () => {
      it("GET /api/projects/:id — a stale claim on the deleted workspace gets 404; the live one 200", async () => {
        const bearer = staleToken("u-both", [LIVE, DEAD]);
        const dead = await request(app())
          .get(`/api/projects/${P_DEAD}`)
          .set("Authorization", `Bearer ${bearer}`);
        expect(dead.status).toBe(404);
        const live = await request(app())
          .get(`/api/projects/${P_LIVE}`)
          .set("Authorization", `Bearer ${bearer}`);
        expect(live.status).toBe(200);
        expect(live.body.data.id).toBe(P_LIVE);
      });

      it("GET /api/projects — the list leaves out the deleted workspace's projects", async () => {
        const res = await request(app())
          .get("/api/projects")
          .set("Authorization", `Bearer ${staleToken("u-both", [LIVE, DEAD])}`);
        expect(res.status).toBe(200);
        const ids = (res.body.data.items as Array<{ id: string }>).map((p) => p.id).sort();
        expect(ids).toEqual([P_LIVE, P_OPEN].sort());
      });

      it("POST /api/auth/login — the minted claim leaves out the deleted workspace", async () => {
        const res = await request(app())
          .post("/api/auth/login")
          .send({ username: "developer", password: "password" });
        expect(res.status).toBe(200);
        const claims = verifyAccessToken(res.body.data.accessToken as string);
        expect(claims.userId).toBe("developer");
        expect(claims.workspaces).toEqual([LIVE]);
      });

      it("GET /api/auth/oidc/callback — the SSO-minted claim leaves out the deleted workspace", async () => {
        const agent = request(app());
        expect((await agent.get("/api/auth/oidc/login")).status).toBe(302);
        const res = await agent.get("/api/auth/oidc/callback?code=code-549&state=state-549");
        expect(res.status).toBe(302);
        const cookies = [res.headers["set-cookie"] ?? []].flat() as string[];
        const access = cookies.find((c) => c.startsWith("accessToken="));
        expect(access).toBeDefined();
        const claims = verifyAccessToken(
          decodeURIComponent(access!.split(";")[0]!.slice("accessToken=".length)),
        );
        expect(claims.userId).toBe("u-both");
        expect(claims.workspaces).toEqual([LIVE]);
      });

      it("refreshAuthenticatedUser — the per-request scope leaves out the deleted workspace", async () => {
        // Called directly rather than mounted on a test route: the middleware
        // replaces `req.user` from durable state, whatever the token claimed.
        const req = { user: payload("u-both", "developer", [LIVE, DEAD]) } as express.Request;
        const next = vi.fn();
        await refreshAuthenticatedUser(req, {} as express.Response, next);
        expect(next).toHaveBeenCalledWith();
        expect(req.user?.workspaces).toEqual([LIVE]);
      });

      it("requireWorkspaceRole — GET /api/workspaces/:id is 404 for the deleted workspace, 200 for the live one", async () => {
        const bearer = staleToken("u-both", [LIVE, DEAD]);
        const dead = await request(app())
          .get(`/api/workspaces/${DEAD}`)
          .set("Authorization", `Bearer ${bearer}`);
        expect(dead.status).toBe(404);
        // Member management runs behind the same guard; it must not reach the row.
        const invite = await request(app())
          .post(`/api/workspaces/${DEAD}/invites`)
          .set("Authorization", `Bearer ${bearer}`)
          .send({ email: "x@example.test", role: "member" });
        expect(invite.status).toBe(404);
        const live = await request(app())
          .get(`/api/workspaces/${LIVE}`)
          .set("Authorization", `Bearer ${bearer}`);
        expect(live.status).toBe(200);
      });
    });

    describe("helpers", () => {
      it("getUserAccessibleProjects (federated search scope) leaves out the deleted workspace", async () => {
        const ids = (await getUserAccessibleProjects("u-both")).map((p) => p.id).sort();
        expect(ids).toEqual([P_LIVE, P_OPEN].sort());
      });

      it("resolveAcpActor leaves out the deleted workspace", async () => {
        const actor = await resolveAcpActor({ userId: "u-both" } as never);
        expect(actor.workspaces).toEqual([LIVE]);
      });

      it("listAccessibleProjectIds (workspaceScopeWhere) ignores a stale claim on the deleted workspace", async () => {
        const ids = (
          await listAccessibleProjectIds(payload("u-both", "developer", [LIVE, DEAD]))
        ).sort();
        expect(ids).toEqual([P_LIVE, P_OPEN].sort());
      });

      it("runProjectScope ignores a stale claim on the deleted workspace", async () => {
        const scope = runProjectScope(payload("u-both", "developer", [LIVE, DEAD]));
        const rows = await db.project.findMany({
          where: "project" in scope ? scope.project : {},
          select: { id: true },
        });
        expect(rows.map((r) => r.id).sort()).toEqual([P_LIVE, P_OPEN].sort());
      });

      it("listProjects leaves out the deleted workspace's projects", async () => {
        const { items } = await listProjects({ workspaceIds: [LIVE, DEAD] });
        expect(items.map((p) => p.id).sort()).toEqual([P_LIVE, P_OPEN].sort());
      });

      it("assertWorkspaceAdminForProject — 404 on the deleted workspace, passes on the live one", async () => {
        const owner = payload("u-both", "developer", [LIVE, DEAD]);
        await expect(assertWorkspaceAdminForProject(owner, P_DEAD)).rejects.toMatchObject({
          statusCode: 404,
        });
        await expect(assertWorkspaceAdminForProject(owner, P_LIVE)).resolves.toBeUndefined();
      });

      it("cross-project access — the deleted workspace is neither listed nor a membership", async () => {
        const member = { id: "u-both", role: "developer" } as never;
        expect(await listAccessibleWorkspaceIds(member, db)).toEqual([LIVE]);
        expect(await actorIsWorkspaceMember(member, DEAD, db)).toBe(false);
        expect(await actorIsWorkspaceMember(member, LIVE, db)).toBe(true);
      });

      it("cross-project access — the admin list leaves out the deleted workspace too", async () => {
        const admin = { id: "u-dead", role: "admin" } as never;
        expect(await listAccessibleWorkspaceIds(admin, db)).toEqual([LIVE]);
      });
    });
  },
);
