/**
 * #580 — the invite accept route must consume the invite conditionally.
 *
 * The route reads the invite (and its workspace's `deletedAt`), then writes the
 * membership and marks the invite used. Without a guarded, transactional
 * consume, two concurrent accepts of one token both pass the read and both
 * succeed, and a workspace DELETE committing between the read and the write
 * still gains a member. Proven through the REAL router against a REAL SQLite
 * database built from the migration chain, reading state back from the
 * database rather than from what the route returned.
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

const { workspacesRouter } = await import("../src/routes/workspaces.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");

const INVITEE = "u-invitee-580";
const INVITER = "u-inviter-580";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#580 — invite accept consumes the invite conditionally",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let seq = 0;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/workspaces", workspacesRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };

    /** A fresh live workspace with one outstanding invite for INVITEE. */
    async function seedInvite(): Promise<{ workspaceId: string; token: string }> {
      seq += 1;
      const workspaceId = `ws-580-${seq}`;
      const token = `token-580-${seq}`;
      await db.workspace.create({
        data: { id: workspaceId, name: workspaceId, slug: workspaceId },
      });
      await db.workspaceMember.create({ data: { workspaceId, userId: INVITER, role: "owner" } });
      await db.workspaceInvite.create({
        data: {
          workspaceId,
          email: `${INVITEE}@example.test`,
          role: "member",
          token,
          invitedById: INVITER,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      return { workspaceId, token };
    }

    const accept = (token: string) =>
      request(app()).post(`/api/workspaces/invites/${token}/accept`);

    const membership = (workspaceId: string) =>
      db.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: INVITEE } },
      });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("580-invite-accept-race");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      for (const id of [INVITEE, INVITER]) {
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

    it("refuses a second accept of the same token as already used", async () => {
      const { workspaceId, token } = await seedInvite();

      const first = await accept(token);
      expect(first.status).toBe(200);
      expect(await membership(workspaceId)).toMatchObject({ role: "member" });

      const second = await accept(token);
      expect(second.status).toBe(410);
      // 410 also means expired or deleted; pin the reason.
      expect(second.body.error.message).toBe("Invitation has already been used");
    });

    it("lets exactly one of two concurrent accepts of one token succeed", async () => {
      const { workspaceId, token } = await seedInvite();
      // Hold each request's first read of the invite until both have read it,
      // so both see it unconsumed: the window a check-then-write loses.
      let arrived = 0;
      let release!: () => void;
      const bothRead = new Promise<void>((resolve) => (release = resolve));
      state.db = db.$extends({
        query: {
          workspaceInvite: {
            async findUnique({ args, query }) {
              const result = await query(args);
              if (arrived < 2) {
                arrived += 1;
                if (arrived === 2) release();
                await bothRead;
              }
              return result;
            },
          },
        },
      });

      const results = await Promise.all([accept(token), accept(token)]);
      expect(arrived).toBe(2);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 410]);
      const loser = results.find((r) => r.status === 410)!;
      expect(loser.body.error.message).toBe("Invitation has already been used");
      expect(await membership(workspaceId)).toMatchObject({ role: "member" });
    });

    it("adds no member when the workspace is deleted between the read and the write", async () => {
      const { workspaceId, token } = await seedInvite();
      // Commit the soft delete (what `DELETE /api/workspaces/:id` does) right
      // after the route's first read of the invite, before any write.
      let fired = false;
      state.db = db.$extends({
        query: {
          workspaceInvite: {
            async findUnique({ args, query }) {
              const result = await query(args);
              if (!fired) {
                fired = true;
                await db.workspace.update({
                  where: { id: workspaceId },
                  data: { deletedAt: new Date() },
                });
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
      expect(await membership(workspaceId)).toBeNull();
      const invite = await db.workspaceInvite.findUnique({ where: { token } });
      expect(invite?.consumedAt).toBeNull();
    });

    it("refuses an invite that expires between the read and the write", async () => {
      const { workspaceId, token } = await seedInvite();
      let fired = false;
      state.db = db.$extends({
        query: {
          workspaceInvite: {
            async findUnique({ args, query }) {
              const result = await query(args);
              if (!fired) {
                fired = true;
                await db.workspaceInvite.update({
                  where: { token },
                  data: { expiresAt: new Date(Date.now() - 1000) },
                });
              }
              return result;
            },
          },
        },
      });

      const res = await accept(token);
      expect(res.status).toBe(410);
      expect(res.body.error.message).toBe("Invitation has expired");
      expect(await membership(workspaceId)).toBeNull();
    });

    it("keeps an existing member's role when they accept an invite", async () => {
      const { workspaceId, token } = await seedInvite();
      await db.workspaceMember.create({ data: { workspaceId, userId: INVITEE, role: "admin" } });

      const res = await accept(token);
      expect(res.status).toBe(200);
      expect(await membership(workspaceId)).toMatchObject({ role: "admin" });
      const invite = await db.workspaceInvite.findUnique({ where: { token } });
      expect(invite?.consumedAt).not.toBeNull();
    });
  },
);
