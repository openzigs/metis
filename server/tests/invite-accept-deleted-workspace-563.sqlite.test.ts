/**
 * #563 — accepting an invite to a soft-deleted workspace is refused.
 *
 * Workspace DELETE sets `deletedAt` and leaves outstanding invites in place, so
 * the public accept route used to create a `WorkspaceMember` row in a workspace
 * that no longer exists. Proven through the REAL router against a REAL SQLite
 * database built from the migration chain, reading the membership back from
 * the database. The denial is paired with a positive control on a live
 * workspace, so a route that refuses every invite cannot pass.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
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

const { workspacesRouter } = await import("../src/routes/workspaces.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const LIVE = "ws-live-563";
const DEAD = "ws-dead-563";
const INVITEE = "u-invitee-563";
const INVITER = "u-inviter-563";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#563 — invite accept on a soft-deleted workspace",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/workspaces", workspacesRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };

    // #941 — accepting needs a session as the invited account (real `requireAuth`).
    const accept = (token: string) =>
      request(app())
        .post(`/api/workspaces/invites/${token}/accept`)
        .set(
          "Authorization",
          `Bearer ${issueTokens({ userId: INVITEE, username: INVITEE, role: "developer", permissions: [] }).accessToken}`,
        );

    beforeAll(async () => {
      sqlite = createMigratedSqlite("563-invite-deleted-workspace");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const id of [INVITEE, INVITER]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      const expiresAt = new Date(Date.now() + 86_400_000);
      for (const ws of [LIVE, DEAD]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
        await db.workspaceMember.create({
          data: { workspaceId: ws, userId: INVITER, role: "owner" },
        });
        await db.workspaceInvite.create({
          data: {
            workspaceId: ws,
            email: `${INVITEE}@example.test`,
            role: "member",
            token: `token-${ws}`,
            invitedById: INVITER,
            expiresAt,
          },
        });
      }
      // What `DELETE /api/workspaces/:id` does: a soft delete. The invite survives.
      await db.workspace.update({ where: { id: DEAD }, data: { deletedAt: new Date() } });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    const membership = (workspaceId: string) =>
      db.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: INVITEE } },
      });

    it("refuses the deleted workspace's invite with 410, creates no membership, leaves the invite unconsumed", async () => {
      const res = await accept(`token-${DEAD}`);
      expect(res.status).toBe(410);
      // 410 also means expired or used; pin the reason, or a retry passes on "already used".
      expect(res.body.error.message).toBe("This workspace no longer exists");
      expect(await membership(DEAD)).toBeNull();
      const invite = await db.workspaceInvite.findUnique({ where: { token: `token-${DEAD}` } });
      expect(invite?.consumedAt).toBeNull();
    });

    it("accepts the live workspace's invite and the membership reads back", async () => {
      const res = await accept(`token-${LIVE}`);
      expect(res.status).toBe(200);
      expect(res.body.data.workspace.id).toBe(LIVE);
      expect(await membership(LIVE)).toMatchObject({ role: "member" });
    });
  },
);
