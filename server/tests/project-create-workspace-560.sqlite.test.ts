/**
 * #560 — `POST /api/projects` must not place a project into a workspace the
 * caller cannot reach.
 *
 * The body's `workspaceId` used to be persisted as given, so a caller holding
 * `project.create` could put a project into a workspace they are not a member
 * of, or into a soft-deleted one. Proven through the REAL projects router
 * against a REAL SQLite database built from the migration chain; no access
 * helper is mocked, and every refusal is read back from the table so a 4xx that
 * still wrote the row cannot pass.
 *
 * Each denial is paired with a positive control, so a check that refuses
 * everyone cannot pass either.
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

// `workspaceId` is validated as a cuid, so the fixture ids are cuid-shaped.
const MINE = "cmine560000000000000000000";
const OTHER = "cother56000000000000000000";
const DEAD = "cdead560000000000000000000";
const MISSING = "cmissing560000000000000000";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#560 — POST /api/projects refuses a workspace the caller cannot reach",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let slugSeq = 0;

    const bearer = (userId: string, role: RoleKey, workspaces: string[]) => {
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

    /** POST a project into `workspaceId`; returns the response and the slug used. */
    const create = async (auth: string, workspaceId: string) => {
      slugSeq += 1;
      const slug = `p560-${slugSeq}`;
      const res = await request(app())
        .post("/api/projects")
        .set("Authorization", auth)
        .send({ name: slug, slug, workspaceId });
      return { res, slug };
    };

    const rowFor = (slug: string) => db.project.findUnique({ where: { slug } });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("560-project-create-workspace");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const id of ["u-dev", "u-admin"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      for (const ws of [MINE, OTHER, DEAD]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      await db.workspaceMember.create({
        data: { workspaceId: MINE, userId: "u-dev", role: "member" },
      });
      await db.workspaceMember.create({
        data: { workspaceId: DEAD, userId: "u-dev", role: "owner" },
      });
      // What `DELETE /api/workspaces/:id` does: a soft delete, memberships kept.
      await db.workspace.update({ where: { id: DEAD }, data: { deletedAt: new Date() } });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("a member creates a project in their own live workspace (positive control)", async () => {
      const { res, slug } = await create(bearer("u-dev", "coordinator", [MINE]), MINE);
      expect(res.status).toBe(201);
      expect(res.body.data.workspaceId).toBe(MINE);
      expect((await rowFor(slug))?.workspaceId).toBe(MINE);
    });

    it("a non-member is refused a workspace they do not belong to, and nothing is written", async () => {
      const { res, slug } = await create(bearer("u-dev", "coordinator", [MINE]), OTHER);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("WORKSPACE_NOT_FOUND");
      expect(await rowFor(slug)).toBeNull();
    });

    it("a forged claim naming the workspace does not stand in for a membership row", async () => {
      const { res, slug } = await create(bearer("u-dev", "coordinator", [MINE, OTHER]), OTHER);
      expect(res.status).toBe(404);
      expect(await rowFor(slug)).toBeNull();
    });

    it("a member of a soft-deleted workspace is refused it, and nothing is written", async () => {
      // A token minted before the delete still names the dead workspace.
      const { res, slug } = await create(bearer("u-dev", "coordinator", [MINE, DEAD]), DEAD);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("WORKSPACE_NOT_FOUND");
      expect(await rowFor(slug)).toBeNull();
    });

    it("an admin may place a project in a live workspace they are not a member of", async () => {
      const { res, slug } = await create(bearer("u-admin", "admin", []), OTHER);
      expect(res.status).toBe(201);
      expect((await rowFor(slug))?.workspaceId).toBe(OTHER);
    });

    it("an admin is refused a soft-deleted workspace too", async () => {
      const { res, slug } = await create(bearer("u-admin", "admin", []), DEAD);
      expect(res.status).toBe(404);
      expect(await rowFor(slug)).toBeNull();
    });

    it("an unknown workspace id is a 404, not a foreign-key 500", async () => {
      const { res, slug } = await create(bearer("u-admin", "admin", []), MISSING);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("WORKSPACE_NOT_FOUND");
      expect(await rowFor(slug)).toBeNull();
    });

    it("omitting workspaceId still creates an unassigned project", async () => {
      slugSeq += 1;
      const slug = `p560-${slugSeq}`;
      const res = await request(app())
        .post("/api/projects")
        .set("Authorization", bearer("u-dev", "coordinator", [MINE]))
        .send({ name: slug, slug });
      expect(res.status).toBe(201);
      expect((await rowFor(slug))?.workspaceId).toBeNull();
    });
  },
);
