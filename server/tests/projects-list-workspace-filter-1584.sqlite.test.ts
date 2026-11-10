/**
 * #1584 — `GET /api/projects?workspaceId=` narrows a member's list to one of
 * their own workspaces, so the header project switcher can list the active
 * workspace's projects rather than every project the user can open.
 *
 * Before, the filter was honoured for admins only; a member's `?workspaceId=`
 * was ignored and they got all their workspaces' projects. The filter may only
 * NARROW (OWASP A01): naming a workspace the caller is not in, or one their
 * token claims but whose membership row is gone (#561), lists none of its
 * projects. Proven through the REAL router and auth against a REAL SQLite
 * database built from the migration chain; nothing about access is mocked.
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

const { projectsRouter } = await import("../src/routes/projects.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const P1 = "proj-1584-ws1";
const P2 = "proj-1584-ws2";
const P3 = "proj-1584-ws3";
const P_OPEN = "proj-1584-open"; // no workspace — listed to every signed-in user

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1584 — GET /api/projects?workspaceId= lists one of the caller's workspaces",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const bearer = (userId: string, workspaces: string[], role: RoleKey = "developer") => {
      const payload: AuthPayload = {
        userId,
        username: userId,
        role,
        permissions: getPermissionsForRole(role),
        workspaces,
      };
      return `Bearer ${issueTokens(payload).accessToken}`;
    };

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects", projectsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };

    const ids = async (auth: string, query = "") => {
      const res = await request(app()).get(`/api/projects${query}`).set("Authorization", auth);
      expect(res.status).toBe(200);
      return (res.body.data.items as Array<{ id: string }>).map((p) => p.id).sort();
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1584-project-list-workspace");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const id of ["u-two", "u-one", "u-admin"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      for (const ws of ["ws-1", "ws-2", "ws-3"]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      for (const [workspaceId, userId] of [
        ["ws-1", "u-two"],
        ["ws-2", "u-two"],
        ["ws-1", "u-one"],
      ] as const) {
        await db.workspaceMember.create({ data: { workspaceId, userId, role: "member" } });
      }
      for (const [id, workspaceId] of [
        [P1, "ws-1"],
        [P2, "ws-2"],
        [P3, "ws-3"],
        [P_OPEN, null],
      ] as const) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById: "u-admin", workspaceId, status: "active" },
        });
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("a member of two workspaces sees one of them when they name it", async () => {
      const two = bearer("u-two", ["ws-1", "ws-2"]);
      expect(await ids(two)).toEqual([P1, P2, P_OPEN].sort());
      expect(await ids(two, "?workspaceId=ws-2")).toEqual([P2, P_OPEN].sort());
      expect(await ids(two, "?workspaceId=ws-1")).toEqual([P1, P_OPEN].sort());
    });

    it("naming a workspace they are not in lists none of its projects (it only narrows)", async () => {
      const one = bearer("u-one", ["ws-1"]);
      expect(await ids(one, "?workspaceId=ws-2")).toEqual([P_OPEN]);
      expect(await ids(one, "?workspaceId=ws-3")).toEqual([P_OPEN]);
    });

    it("a claim with no membership row behind it grants nothing through the filter (#561)", async () => {
      const forged = bearer("u-one", ["ws-1", "ws-3"]);
      expect(await ids(forged, "?workspaceId=ws-3")).toEqual([P_OPEN]);
    });

    it("an admin's filter is unchanged: any live workspace", async () => {
      const admin = bearer("u-admin", [], "admin");
      expect(await ids(admin, "?workspaceId=ws-3")).toEqual([P3, P_OPEN].sort());
      expect(await ids(admin)).toEqual([P1, P2, P3, P_OPEN].sort());
    });
  },
);
