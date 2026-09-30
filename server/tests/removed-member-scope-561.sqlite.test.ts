/**
 * #561 — a member removed from a LIVE workspace loses its projects on an
 * existing session.
 *
 * The `workspaces` claim is minted at login and used to be carried forward
 * unchanged by `refreshAccessToken`, so a removed member kept the workspace in
 * scope until the refresh token expired, wherever a reader trusted the claim.
 * Proven here through the REAL routers and helpers against a REAL SQLite
 * database built from the migration chain; no access helper is mocked.
 *
 * One live workspace `ws-561`. `u-kept` stays a member; `u-gone` is removed in
 * `beforeAll` exactly as `DELETE /api/workspaces/:id/members/:memberId` does
 * (the membership row is deleted). Both hold tokens minted BEFORE the removal
 * whose claim names `ws-561`. Each denial is paired with a positive control on
 * `u-kept`, so a check that refuses everyone cannot pass.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole, type AuthPayload } from "@metis/shared";
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

const { projectsRouter } = await import("../src/routes/projects.js");
const { authRouter } = await import("../src/routes/auth.js");
const { searchRouter } = await import("../src/routes/search.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens, verifyAccessToken } = await import("../src/lib/auth/jwt.js");
const { assertProjectAccess } = await import("../src/lib/custom-agents/authz.js");
const { listAccessibleProjectIds } = await import("../src/lib/acp/authz.js");
const { runProjectScope } = await import("../src/lib/async/run-authz.js");

const WS = "ws-561";
const WS_LATE = "ws-late-561"; // joined by u-gone AFTER its token was minted
const P_WS = "proj-ws-561";
const P_LATE = "proj-late-561";
const P_OPEN = "proj-open-561"; // no workspace — open to every authenticated user

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#561 — a member removed from a live workspace keeps no access through the claim",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const payload = (userId: string, workspaces: string[]): AuthPayload => ({
      userId,
      username: userId,
      role: "developer",
      permissions: getPermissionsForRole("developer"),
      workspaces,
    });
    // Minted BEFORE the removal: the claim still names the workspace.
    const staleTokens = (userId: string) => issueTokens(payload(userId, [WS]));
    const bearer = (userId: string) => `Bearer ${staleTokens(userId).accessToken}`;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/auth", authRouter());
      a.use("/api/projects", projectsRouter());
      a.use("/api/search", searchRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("561-removed-member");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const id of ["u-kept", "u-gone"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      for (const ws of [WS, WS_LATE]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      await db.workspaceMember.create({
        data: { workspaceId: WS, userId: "u-kept", role: "owner" },
      });
      await db.workspaceMember.create({
        data: { id: "m-gone-561", workspaceId: WS, userId: "u-gone", role: "member" },
      });
      await db.workspaceMember.create({
        data: { workspaceId: WS_LATE, userId: "u-gone", role: "member" },
      });
      for (const [id, workspaceId] of [
        [P_WS, WS],
        [P_LATE, WS_LATE],
        [P_OPEN, null],
      ] as const) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById: "u-kept", workspaceId, status: "active" },
        });
      }
      // What `DELETE /api/workspaces/:id/members/:memberId` does.
      await db.workspaceMember.delete({ where: { id: "m-gone-561" } });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    describe("open", () => {
      it("GET /api/projects/:id — 404 for the removed member, 200 for the kept one", async () => {
        const gone = await request(app())
          .get(`/api/projects/${P_WS}`)
          .set("Authorization", bearer("u-gone"));
        expect(gone.status).toBe(404);
        const kept = await request(app())
          .get(`/api/projects/${P_WS}`)
          .set("Authorization", bearer("u-kept"));
        expect(kept.status).toBe(200);
        expect(kept.body.data.id).toBe(P_WS);
      });

      it("assertProjectAccess — rejects the removed member, admits the kept one", async () => {
        await expect(assertProjectAccess(payload("u-gone", [WS]), P_WS)).rejects.toMatchObject({
          statusCode: 404,
        });
        await expect(assertProjectAccess(payload("u-kept", [WS]), P_WS)).resolves.toBeUndefined();
      });
    });

    describe("list", () => {
      it("GET /api/projects — the removed member's list leaves the workspace out", async () => {
        const ids = async (userId: string) => {
          const res = await request(app())
            .get("/api/projects")
            .set("Authorization", bearer(userId));
          expect(res.status).toBe(200);
          return (res.body.data.items as Array<{ id: string }>).map((p) => p.id).sort();
        };
        expect(await ids("u-gone")).toEqual([P_OPEN]);
        expect(await ids("u-kept")).toEqual([P_OPEN, P_WS].sort());
      });

      it("listAccessibleProjectIds (workspaceScopeWhere) ignores the stale claim", async () => {
        expect((await listAccessibleProjectIds(payload("u-gone", [WS]))).sort()).toEqual([P_OPEN]);
        expect((await listAccessibleProjectIds(payload("u-kept", [WS]))).sort()).toEqual(
          [P_OPEN, P_WS].sort(),
        );
      });

      it("runProjectScope ignores the stale claim", async () => {
        const visible = async (userId: string) => {
          const scope = runProjectScope(payload(userId, [WS]));
          const rows = await db.project.findMany({
            where: "project" in scope ? scope.project : {},
            select: { id: true },
          });
          return rows.map((r) => r.id).sort();
        };
        expect(await visible("u-gone")).toEqual([P_OPEN]);
        expect(await visible("u-kept")).toEqual([P_OPEN, P_WS].sort());
      });
    });

    describe("search", () => {
      it("GET /api/search/projects — the search scope leaves the workspace out", async () => {
        const ids = async (userId: string) => {
          const res = await request(app())
            .get("/api/search/projects")
            .set("Authorization", bearer(userId));
          expect(res.status).toBe(200);
          return (res.body.data as Array<{ id: string }>).map((p) => p.id);
        };
        expect(await ids("u-gone")).not.toContain(P_WS);
        expect(await ids("u-kept")).toContain(P_WS);
      });
    });

    describe("refresh", () => {
      const refreshedClaim = async (userId: string) => {
        const res = await request(app())
          .post("/api/auth/refresh")
          .send({ refreshToken: staleTokens(userId).refreshToken });
        expect(res.status).toBe(200);
        return verifyAccessToken(res.body.data.accessToken as string).workspaces;
      };

      it("POST /api/auth/refresh — does not carry forward the removed membership", async () => {
        expect(await refreshedClaim("u-gone")).not.toContain(WS);
        expect(await refreshedClaim("u-kept")).toEqual([WS]);
      });

      it("POST /api/auth/refresh — re-reads memberships, so one joined since is picked up", async () => {
        expect(await refreshedClaim("u-gone")).toEqual([WS_LATE]);
      });
    });
  },
);
