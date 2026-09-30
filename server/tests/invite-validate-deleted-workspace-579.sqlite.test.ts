/**
 * #579 — validating an invite to a soft-deleted workspace reports it as not valid.
 *
 * Workspace DELETE sets `deletedAt` and leaves outstanding invites in place
 * (#563). The accept route refuses such an invite, but the public validate route
 * `GET /api/workspaces/invites/:token` used to answer `valid: true` and disclose
 * the deleted workspace's name and the inviter to any token holder. Proven
 * through the REAL router against a REAL SQLite database built from the
 * migration chain, paired with a positive control on a live workspace so a
 * route that reports every invite invalid cannot pass.
 *
 * #597 — the same withholding applies to every invalid invite: an expired or
 * already-used token is as stale as one to a deleted workspace, so it keeps only
 * the reason flags and drops the workspace, inviter, invitee email, role and
 * expiry — nothing the page's invalid states read.
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

const LIVE = "ws-live-579";
const DEAD = "ws-dead-579";
const DEAD_NAME = "Deleted Workspace 579";
const INVITEE = "u-invitee-579";
const INVITER = "u-inviter-579";
const INVITER_NAME = "Inviter Display 579";
const LIVE_NAME = "Live Workspace 579";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#579, #597 — public invite validation withholds a deleted-workspace, expired or used invite's details",
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

    beforeAll(async () => {
      sqlite = createMigratedSqlite("579-invite-validate-deleted-workspace");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: {
          id: INVITEE,
          username: INVITEE,
          displayName: INVITEE,
          email: `${INVITEE}@example.test`,
        },
      });
      await db.user.create({
        data: {
          id: INVITER,
          username: INVITER,
          displayName: INVITER_NAME,
          email: `${INVITER}@example.test`,
        },
      });
      const expiresAt = new Date(Date.now() + 86_400_000);
      for (const [ws, name] of [
        [LIVE, LIVE_NAME],
        [DEAD, DEAD_NAME],
      ] as const) {
        await db.workspace.create({ data: { id: ws, name, slug: ws } });
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
      // #597 — an expired and an already-used invite, both to the LIVE workspace.
      await db.workspaceInvite.create({
        data: {
          workspaceId: LIVE,
          email: `${INVITEE}@example.test`,
          role: "member",
          token: "token-expired-597",
          invitedById: INVITER,
          expiresAt: new Date(Date.now() - 86_400_000),
        },
      });
      await db.workspaceInvite.create({
        data: {
          workspaceId: LIVE,
          email: `${INVITEE}@example.test`,
          role: "member",
          token: "token-consumed-597",
          invitedById: INVITER,
          expiresAt,
          consumedAt: new Date(),
        },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("reports the deleted workspace's invite as not valid, naming the reason, without its name or inviter", async () => {
      const res = await request(app()).get(`/api/workspaces/invites/token-${DEAD}`);
      expect(res.status).toBe(200);
      // Pin the reason, not only `valid`: expired or used also read `valid: false`.
      expect(res.body.data).toMatchObject({
        valid: false,
        workspaceDeleted: true,
        expired: false,
        consumed: false,
        workspace: null,
        invitedBy: null,
        email: null,
        role: null,
        expiresAt: null,
      });
      expect(JSON.stringify(res.body)).not.toContain(DEAD_NAME);
      expect(JSON.stringify(res.body)).not.toContain(INVITEE);
      expect(JSON.stringify(res.body)).not.toContain(INVITER_NAME);
    });

    it("reports the live workspace's invite as valid, with its name and inviter", async () => {
      const res = await request(app()).get(`/api/workspaces/invites/token-${LIVE}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        valid: true,
        workspaceDeleted: false,
        workspace: { id: LIVE, name: LIVE_NAME, slug: LIVE },
        invitedBy: INVITER_NAME,
        email: `${INVITEE}@example.test`,
        role: "member",
      });
      expect(res.body.data.expiresAt).toEqual(expect.any(String));
      expect(res.body.data.workspace).not.toHaveProperty("deletedAt");
    });

    it.each([
      ["expired", "token-expired-597", { expired: true, consumed: false }],
      ["already-used", "token-consumed-597", { expired: false, consumed: true }],
    ] as const)(
      "#597 — reports an %s invite as not valid, naming the reason, withholding everything else",
      async (_label, token, flags) => {
        const res = await request(app()).get(`/api/workspaces/invites/${token}`);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({
          valid: false,
          workspaceDeleted: false,
          ...flags,
          workspace: null,
          invitedBy: null,
          // The page's invalid states read only the reason flags.
          email: null,
          role: null,
          expiresAt: null,
        });
        expect(JSON.stringify(res.body)).not.toContain(LIVE_NAME);
        expect(JSON.stringify(res.body)).not.toContain(INVITEE);
        expect(JSON.stringify(res.body)).not.toContain(INVITER_NAME);
      },
    );
  },
);
