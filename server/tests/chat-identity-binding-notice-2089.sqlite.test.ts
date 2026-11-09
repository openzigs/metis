/**
 * #2089 — a chat identity binding is never silent, read back through the paths
 * a real consumer uses.
 *
 * A workspace admin binds a Teams account to the workspace OWNER through the
 * real route and the real resolver; the owner then opens their notification
 * list (the drawer's own endpoint) and sees the notice unredacted, and the
 * audit log holds the binding. Real router, real JWT auth, real SQLite from the
 * migration chain; only the Teams install / link / target stores are stubbed
 * (the identity route does not use them).
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

const { teamsIntegrationRouter } = await import("../src/routes/integrations/teams.js");
const { notificationsRouter } = await import("../src/routes/notifications.js");
const { TeamsAadIdentityResolver } = await import("../src/lib/teams/aad-identity-resolver.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const isSqlite = readGeneratedClientProvider() === "sqlite";
const WS = "ws-2089";

type Row = { type: string; title: string; message: string; redacted: boolean };

describe.skipIf(!isSqlite)(
  "#2089 — binding a chat account to the owner is audited and announced",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const token = (userId: string) =>
      issueTokens({
        userId,
        username: userId,
        role: "developer",
        permissions: [],
        workspaces: [WS],
      }).accessToken;

    const app = () => {
      const a = express();
      a.use(express.json());
      const unused = {} as never;
      a.use(
        "/api/integrations/teams",
        teamsIntegrationRouter(unused, unused, new TeamsAadIdentityResolver(db), unused),
      );
      a.use("/api/notifications", notificationsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2089-binding-notice");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const [id, displayName] of [
        ["u-owner", "Olive Owner"],
        ["u-admin", "Adam Admin"],
      ]) {
        await db.user.create({
          data: { id, username: id, displayName, email: `${id}@example.test` },
        });
      }
      await db.workspace.create({ data: { id: WS, name: "Acme", slug: WS } });
      await db.workspaceMember.create({
        data: { workspaceId: WS, userId: "u-owner", role: "owner" },
      });
      await db.workspaceMember.create({
        data: { workspaceId: WS, userId: "u-admin", role: "admin" },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("the owner reads the notice in their list and the audit log holds the binding", async () => {
      const bind = await request(app())
        .post(`/api/integrations/teams/workspaces/${WS}/identities`)
        .set("Authorization", `Bearer ${token("u-admin")}`)
        .send({ tenantId: "tenant-a", aadObjectId: "aad-owner", userId: "u-owner" });
      expect(bind.status).toBe(201);
      expect(
        await db.teamsUserIdentity.count({ where: { workspaceId: WS, userId: "u-owner" } }),
      ).toBe(1);

      const list = await request(app())
        .get("/api/notifications")
        .set("Authorization", `Bearer ${token("u-owner")}`);
      expect(list.status).toBe(200);
      const rows = list.body.data.notifications as Row[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: "chat_identity_bound",
        title: "A Microsoft Teams account can now act as you",
        redacted: false,
      });
      expect(rows[0].message).toContain(
        'Adam Admin linked Microsoft Teams account aad-owner to you in the workspace "Acme"',
      );
      expect(list.body.data.unreadCount).toBe(1);

      // The actor (not the bound member, not the owner) is told nothing.
      const actorList = await request(app())
        .get("/api/notifications")
        .set("Authorization", `Bearer ${token("u-admin")}`);
      expect(actorList.body.data.notifications).toEqual([]);

      // The audit write is queued on a microtask; wait for it to land.
      await vi.waitFor(async () => {
        const audit = await db.auditLog.findMany({ where: { action: "chatops.identity.bind" } });
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({
          actorId: "u-admin",
          targetType: "user",
          targetId: "u-owner",
        });
        expect(JSON.parse(audit[0].metadata ?? "{}")).toEqual({
          workspaceId: WS,
          provider: "teams",
          boundUserId: "u-owner",
          externalScope: "tenant-a",
          externalId: "aad-owner",
        });
      });
    });
  },
);
