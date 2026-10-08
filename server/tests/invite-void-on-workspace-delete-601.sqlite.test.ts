/**
 * #601 — workspace DELETE voids the workspace's outstanding invites.
 *
 * The accept route's guarded consume (#580) re-checks the invite row it locks,
 * not the workspace row, so on Postgres a soft delete committing mid-accept was
 * invisible to it. The DELETE now consumes every outstanding invite in the same
 * transaction as the soft delete, and the accept names the deleted workspace
 * before the spent invite. The concurrent case is proven on Postgres in
 * `invite-accept-workspace-delete-race-601-postgres.integration.test.ts`; this
 * suite pins the effects through the REAL router against a REAL SQLite
 * database built from the migration chain, reading state back from the
 * database.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
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
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
// The caller is injected below; workspace RBAC runs for real against the database.
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const { workspacesRouter } = await import("../src/routes/workspaces.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");

const OWNER = "u-owner-601";
const INVITEE = "u-invitee-601";
const OTHER = "u-other-601";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#601 — workspace DELETE voids outstanding invites",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let seq = 0;

    const app = (userId = OWNER) => {
      const a = express();
      a.use(express.json());
      a.use((req, _res, next) => {
        req.user = { userId, role: "developer" } as never;
        next();
      });
      a.use("/api/workspaces", workspacesRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };

    async function seedWorkspace(): Promise<string> {
      seq += 1;
      const workspaceId = `ws-601-${seq}`;
      await db.workspace.create({
        data: { id: workspaceId, name: workspaceId, slug: workspaceId },
      });
      await db.workspaceMember.create({ data: { workspaceId, userId: OWNER, role: "owner" } });
      return workspaceId;
    }

    async function seedInvite(
      workspaceId: string,
      userId: string,
      consumedAt: Date | null = null,
    ): Promise<string> {
      seq += 1;
      const token = `token-601-${seq}`;
      await db.workspaceInvite.create({
        data: {
          workspaceId,
          email: `${userId}@example.test`,
          role: "member",
          token,
          invitedById: OWNER,
          expiresAt: new Date(Date.now() + 86_400_000),
          consumedAt,
        },
      });
      return token;
    }

    const del = (workspaceId: string) => request(app()).delete(`/api/workspaces/${workspaceId}`);
    const accept = (token: string) =>
      request(app(INVITEE)).post(`/api/workspaces/invites/${token}/accept`); // #941: as the invitee
    const inviteRow = (token: string) => db.workspaceInvite.findUnique({ where: { token } });
    const membership = (workspaceId: string, userId: string) =>
      db.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("601-invite-void-on-delete");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      for (const id of [OWNER, INVITEE, OTHER]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(() => {
      state.db = db;
    });

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("consumes the deleted workspace's outstanding invites and no other workspace's", async () => {
      const dead = await seedWorkspace();
      const live = await seedWorkspace();
      const pendingA = await seedInvite(dead, INVITEE);
      const pendingB = await seedInvite(dead, OTHER);
      const usedAt = new Date(Date.now() - 60_000);
      const used = await seedInvite(dead, OTHER, usedAt);
      const elsewhere = await seedInvite(live, INVITEE);

      const res = await del(dead);
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      const deletedAt = (await db.workspace.findUnique({ where: { id: dead } }))?.deletedAt;
      expect(deletedAt).toBeInstanceOf(Date);
      // Voided at the delete's own instant, in the same write.
      expect((await inviteRow(pendingA))?.consumedAt?.getTime()).toBe(deletedAt!.getTime());
      expect((await inviteRow(pendingB))?.consumedAt?.getTime()).toBe(deletedAt!.getTime());
      // An invite already spent keeps the time it was spent.
      expect((await inviteRow(used))?.consumedAt?.getTime()).toBe(usedAt.getTime());
      // Scoped to the deleted workspace: the live one's invite is still open.
      expect((await inviteRow(elsewhere))?.consumedAt).toBeNull();
    });

    it("refuses a voided invite as a deleted workspace, and the live workspace's still accepts", async () => {
      const dead = await seedWorkspace();
      const live = await seedWorkspace();
      const deadToken = await seedInvite(dead, INVITEE);
      const liveToken = await seedInvite(live, INVITEE);
      expect((await del(dead)).status).toBe(200);

      const refused = await accept(deadToken);
      expect(refused.status).toBe(410);
      // The invite now reads as consumed too; the reason must name the workspace.
      expect(refused.body.error.message).toBe("This workspace no longer exists");
      expect(await membership(dead, INVITEE)).toBeNull();

      const accepted = await accept(liveToken);
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      expect(await membership(live, INVITEE)).toMatchObject({ role: "member" });
    });

    it("names the deleted workspace when the DELETE lands after the accept's first read", async () => {
      const workspaceId = await seedWorkspace();
      const token = await seedInvite(workspaceId, INVITEE);
      // Run the real DELETE route right after the accept's pre-check read, so the
      // accept's guarded consume meets an invite the delete already spent.
      let fired = false;
      state.db = db.$extends({
        query: {
          workspaceInvite: {
            async findUnique({ args, query }) {
              const result = await query(args);
              if (!fired) {
                fired = true;
                const res = await del(workspaceId);
                expect(res.status).toBe(200);
              }
              return result;
            },
          },
        },
      });

      const res = await accept(token);
      expect(fired).toBe(true);
      expect(res.status).toBe(410);
      expect(res.body.error.message).toBe("This workspace no longer exists");
      expect(await membership(workspaceId, INVITEE)).toBeNull();
    });
  },
);
