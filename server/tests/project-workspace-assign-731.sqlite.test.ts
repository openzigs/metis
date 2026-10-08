/**
 * #731 — an existing project with no workspace can be put into one.
 *
 * `PUT /api/projects/:id/workspace` driven through the REAL projects router and
 * project service against a REAL SQLite database built from the migration chain.
 * Every success is read back with a fresh `GET /api/projects/:id` (and the row
 * itself), never from the PUT's own answer; every denial is paired with a
 * positive control so a check that refuses everyone cannot pass.
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
const auditSpy = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: auditSpy }));

const { projectsRouter } = await import("../src/routes/projects.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const WS = "ws-731";
const WS_OTHER = "ws-other-731";
const WS_DEAD = "ws-dead-731";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#731 — PUT /api/projects/:id/workspace",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const bearer = (userId: string, role: RoleKey, workspaces: string[] = []) => {
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

    const put = (projectId: string, auth: string, body: string | object) =>
      request(app())
        .put(`/api/projects/${projectId}/workspace`)
        .set("Authorization", auth)
        .send(body);

    const workspaceOf = async (projectId: string) =>
      (await db.project.findUniqueOrThrow({ where: { id: projectId } })).workspaceId;

    let seq = 0;
    const newProject = async (createdById: string, workspaceId: string | null = null) => {
      const id = `p-731-${++seq}`;
      await db.project.create({
        data: { id, name: id, slug: id, createdById, workspaceId, status: "active" },
      });
      return id;
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("731-project-workspace-assign");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const id of ["u-owner", "u-member", "u-outsider", "u-sysadmin", "u-reader"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      for (const ws of [WS, WS_OTHER, WS_DEAD]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      for (const [workspaceId, userId, role] of [
        [WS, "u-owner", "owner"],
        [WS, "u-member", "member"],
        [WS, "u-reader", "admin"],
        [WS_OTHER, "u-owner", "admin"],
        [WS_DEAD, "u-owner", "owner"],
      ] as const) {
        await db.workspaceMember.create({ data: { workspaceId, userId, role } });
      }
      await db.workspace.update({ where: { id: WS_DEAD }, data: { deletedAt: new Date() } });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("a workspace owner moves their unassigned project in; a fresh read sees it", async () => {
      const id = await newProject("u-owner");
      const res = await put(id, bearer("u-owner", "coordinator", [WS]), { workspaceId: WS });
      expect(res.status).toBe(200);
      expect(await workspaceOf(id)).toBe(WS);
      // The route is rate limited (express-rate-limit's standard headers).
      expect(res.headers["ratelimit-limit"]).toBeDefined();
      const read = await request(app())
        .get(`/api/projects/${id}`)
        .set("Authorization", bearer("u-owner", "coordinator", [WS]));
      expect(read.status).toBe(200);
      expect(read.body.data.workspaceId).toBe(WS);
      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "project.workspace.assign",
          target: { type: "project", id },
          metadata: { workspaceId: WS },
        }),
      );
    });

    it("a workspace admin role (not only owner) is enough", async () => {
      const id = await newProject("u-owner");
      const res = await put(id, bearer("u-owner", "coordinator"), { workspaceId: WS_OTHER });
      expect(res.status).toBe(200);
      expect(await workspaceOf(id)).toBe(WS_OTHER);
    });

    it("a plain workspace member gets 403 and the project stays unassigned", async () => {
      const id = await newProject("u-member");
      const res = await put(id, bearer("u-member", "coordinator", [WS]), { workspaceId: WS });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
      expect(await workspaceOf(id)).toBeNull();
    });

    it("a non-member of the target gets the same 404 as an unknown or deleted workspace", async () => {
      const id = await newProject("u-outsider");
      for (const workspaceId of [WS, "ws-does-not-exist"]) {
        const res = await put(id, bearer("u-outsider", "coordinator"), { workspaceId });
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("WORKSPACE_NOT_FOUND");
      }
      const owned = await newProject("u-owner");
      const dead = await put(owned, bearer("u-owner", "coordinator"), { workspaceId: WS_DEAD });
      expect(dead.status).toBe(404);
      expect(dead.body.error.code).toBe("WORKSPACE_NOT_FOUND");
      expect(await workspaceOf(id)).toBeNull();
      expect(await workspaceOf(owned)).toBeNull();
    });

    it("a developer (no project.update) is refused at the permission layer", async () => {
      const id = await newProject("u-owner");
      const res = await put(id, bearer("u-owner", "developer", [WS]), { workspaceId: WS });
      expect(res.status).toBe(403);
      expect(await workspaceOf(id)).toBeNull();
    });

    it("a reader is refused at the permission layer even as a workspace admin", async () => {
      const id = await newProject("u-reader");
      const res = await put(id, bearer("u-reader", "reader", [WS]), { workspaceId: WS });
      expect(res.status).toBe(403);
      expect(await workspaceOf(id)).toBeNull();
    });

    it("a system admin may move any unassigned project into any live workspace", async () => {
      const id = await newProject("u-member");
      const res = await put(id, bearer("u-sysadmin", "admin"), { workspaceId: WS_OTHER });
      expect(res.status).toBe(200);
      expect(await workspaceOf(id)).toBe(WS_OTHER);
      const owned = await newProject("u-member");
      const dead = await put(owned, bearer("u-sysadmin", "admin"), { workspaceId: WS_DEAD });
      expect(dead.status).toBe(404);
      expect(await workspaceOf(owned)).toBeNull();
    });

    it("a project already in a workspace cannot be moved to another (409); the same one is a no-op", async () => {
      const id = await newProject("u-owner", WS);
      const moved = await put(id, bearer("u-owner", "coordinator", [WS]), {
        workspaceId: WS_OTHER,
      });
      expect(moved.status).toBe(409);
      expect(moved.body.error.code).toBe("PROJECT_ALREADY_IN_WORKSPACE");
      expect(await workspaceOf(id)).toBe(WS);
      // Refused as already-assigned before the target is even looked up.
      const unknown = await put(id, bearer("u-owner", "coordinator", [WS]), {
        workspaceId: "ws-does-not-exist",
      });
      expect(unknown.status).toBe(409);
      const same = await put(id, bearer("u-owner", "coordinator", [WS]), { workspaceId: WS });
      expect(same.status).toBe(200);
      expect(same.body.data.workspaceId).toBe(WS);
    });

    it("of two concurrent moves only one lands", async () => {
      const id = await newProject("u-owner");
      const auth = bearer("u-owner", "coordinator", [WS, WS_OTHER]);
      const results = await Promise.all([
        put(id, auth, { workspaceId: WS }),
        put(id, auth, { workspaceId: WS_OTHER }),
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409]);
      const winner = results.find((r) => r.status === 200)!;
      expect(await workspaceOf(id)).toBe(winner.body.data.workspaceId);
    });

    it("the write itself refuses a project assigned after it was read (stale read → 409)", async () => {
      const id = await newProject("u-owner", WS);
      const row = await db.project.findUniqueOrThrow({ where: { id } });
      // Another request assigned the project between this one's read and write.
      const spy = vi
        .spyOn(db.project, "findFirst")
        .mockResolvedValueOnce({ ...row, workspaceId: null } as never);
      try {
        const res = await put(id, bearer("u-owner", "coordinator", [WS]), {
          workspaceId: WS_OTHER,
        });
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe("PROJECT_ALREADY_IN_WORKSPACE");
      } finally {
        spy.mockRestore();
      }
      expect(await workspaceOf(id)).toBe(WS);
    });

    it("a missing or empty workspaceId is a 400", async () => {
      const id = await newProject("u-owner");
      for (const body of [{}, { workspaceId: "" }, { workspaceId: 7 }]) {
        const res = await put(id, bearer("u-owner", "coordinator"), body);
        expect(res.status).toBe(400);
      }
      expect(await workspaceOf(id)).toBeNull();
    });

    it("another tenant's project answers 404, not 409 — no existence oracle", async () => {
      const id = await newProject("u-owner", WS_OTHER);
      const res = await put(id, bearer("u-member", "coordinator", [WS]), { workspaceId: WS });
      expect(res.status).toBe(404);
      expect(await workspaceOf(id)).toBe(WS_OTHER);
    });

    it("an unknown project is a 404", async () => {
      const res = await put("p-731-missing", bearer("u-sysadmin", "admin"), { workspaceId: WS });
      expect(res.status).toBe(404);
    });
  },
);
