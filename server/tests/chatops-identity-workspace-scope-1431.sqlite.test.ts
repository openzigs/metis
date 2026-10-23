/**
 * #1431 — a ChatOps identity binding (Teams AAD id, Slack user id) belongs to
 * ONE workspace and may only name a member of it.
 *
 * Before the fix, `POST /api/integrations/teams/workspaces/:workspaceId/identities`
 * checked only that the target user was active, so workspace W's admin could
 * bind their own AAD object id to a member of another workspace (or to a system
 * admin) and then run Teams commands as that user. The binding was also keyed on
 * `(tenantId, aadObjectId)` alone, so one workspace's link overwrote another's.
 * The Slack resolver had the same shape.
 *
 * Pinned here, against a real SQLite database built from the migration chain:
 *   - linking refuses a non-member target, by id and by email, with the SAME 404
 *     an unknown user gets, and persists nothing;
 *   - a system admin who is not a member is refused like anyone else; one who IS
 *     a member may be bound only by a system admin;
 *   - another workspace's binding for the same identity is neither overwritten
 *     nor unlinked;
 *   - at command time a binding resolves only in its own workspace and only
 *     while the user is still an active member of it — otherwise the Teams
 *     command is refused as an unlinked sender.
 *
 * Real routers, real JWT auth, real resolvers. Nothing on the access path is mocked.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import type { TurnContext } from "botbuilder";
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

const { teamsIntegrationRouter } = await import("../src/routes/integrations/teams.js");
const { TeamsAadIdentityResolver } = await import("../src/lib/teams/aad-identity-resolver.js");
const { SlackIdentityResolver } = await import("../src/lib/slack/slack-identity-resolver.js");
const { handleTeamsStatusCommand } = await import("../src/lib/teams/teams-command.js");
const { handleSlackStatusCommand } = await import("../src/lib/slack/slack-command.js");
const { loadTeamsTenantAllowlist } = await import("../src/lib/teams/tenant-allowlist.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const WS_A = "ws-1431-a";
const WS_B = "ws-1431-b";
const TENANT = "tenant-1431";
const SLACK_TEAM = "T1431";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1431 — ChatOps identity bindings are scoped to their workspace",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let ADMIN_A = ""; // workspace admin of A (global role developer)
    let ADMIN_B = ""; // workspace admin of B
    let SYSADMIN = ""; // system admin, member of no workspace

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use(
        "/api/integrations/teams",
        teamsIntegrationRouter(undefined, undefined, new TeamsAadIdentityResolver(db)),
      );
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const link = (workspaceId: string, bearer: string, body: Record<string, unknown>) =>
      request(app())
        .post(`/api/integrations/teams/workspaces/${workspaceId}/identities`)
        .set("Authorization", `Bearer ${bearer}`)
        .send({ tenantId: TENANT, ...body });
    const developer = (userId: string, workspaces: string[]) =>
      issueTokens({ userId, username: userId, role: "developer", permissions: [], workspaces })
        .accessToken;
    const teamsBindings = () => db.teamsUserIdentity.findMany({ orderBy: { workspaceId: "asc" } });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1431-chatops-identity-scope");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const id of [
        "u-admin-a",
        "u-admin-b",
        "u-member-a",
        "u-member-b",
        "u-sysadmin",
        "u-sysadmin-member",
      ]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@Example.test` },
        });
      }
      const adminRole = await db.role.create({ data: { key: "admin", name: "Admin" } });
      for (const userId of ["u-sysadmin", "u-sysadmin-member"]) {
        await db.userRole.create({ data: { userId, roleId: adminRole.id } });
      }
      await db.workspace.create({ data: { id: WS_A, name: WS_A, slug: WS_A } });
      await db.workspace.create({ data: { id: WS_B, name: WS_B, slug: WS_B } });
      for (const [workspaceId, userId, role] of [
        [WS_A, "u-admin-a", "admin"],
        [WS_A, "u-member-a", "member"],
        [WS_A, "u-sysadmin-member", "member"],
        [WS_B, "u-admin-b", "admin"],
        [WS_B, "u-member-b", "member"],
      ] as const) {
        await db.workspaceMember.create({ data: { workspaceId, userId, role } });
      }
      ADMIN_A = developer("u-admin-a", [WS_A]);
      ADMIN_B = developer("u-admin-b", [WS_B]);
      SYSADMIN = issueTokens({
        userId: "u-sysadmin",
        username: "u-sysadmin",
        role: "admin",
        permissions: [],
        workspaces: [],
      }).accessToken;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(async () => {
      await db.teamsUserIdentity.deleteMany({});
      await db.slackUserIdentity.deleteMany({});
    });

    // ── linking: the target must be a member of the route's workspace ──────────
    describe("Teams link route", () => {
      it("refuses a non-member target by id with the unknown-user 404 and persists nothing", async () => {
        const foreign = await link(WS_A, ADMIN_A, { aadObjectId: "oid-1", userId: "u-member-b" });
        const unknown = await link(WS_A, ADMIN_A, { aadObjectId: "oid-1", userId: "u-nope" });

        expect(foreign.status).toBe(404);
        expect(foreign.body).toEqual(unknown.body);
        expect(foreign.body.error.code).toBe("AAD_USER_UNMAPPED");
        expect(await teamsBindings()).toEqual([]);
      });

      it("refuses a non-member target by email with the unknown-email 404 and persists nothing", async () => {
        const foreign = await link(WS_A, ADMIN_A, {
          aadObjectId: "oid-1",
          email: "u-member-b@example.test",
        });
        const unknown = await link(WS_A, ADMIN_A, {
          aadObjectId: "oid-1",
          email: "nobody@example.test",
        });

        expect(foreign.status).toBe(404);
        expect(foreign.body).toEqual(unknown.body);
        expect(await teamsBindings()).toEqual([]);
      });

      it("refuses a system admin who is not a member, even to a system admin actor", async () => {
        const res = await link(WS_A, SYSADMIN, { aadObjectId: "oid-1", userId: "u-sysadmin" });
        expect(res.status).toBe(404);
        expect(await teamsBindings()).toEqual([]);
      });

      it("refuses a member who is a system admin when a workspace admin asks", async () => {
        const res = await link(WS_A, ADMIN_A, {
          aadObjectId: "oid-1",
          userId: "u-sysadmin-member",
        });
        expect(res.status).toBe(404);
        expect(await teamsBindings()).toEqual([]);
      });

      it("lets a system admin bind a member who is a system admin", async () => {
        const res = await link(WS_A, SYSADMIN, {
          aadObjectId: "oid-1",
          userId: "u-sysadmin-member",
        });
        expect(res.status).toBe(201);
        expect(await teamsBindings()).toMatchObject([
          { workspaceId: WS_A, aadObjectId: "oid-1", userId: "u-sysadmin-member" },
        ]);
      });

      it("positive control: binds a member of the workspace, by id and by email (any case)", async () => {
        const byId = await link(WS_A, ADMIN_A, { aadObjectId: "oid-1", userId: "u-member-a" });
        const byEmail = await link(WS_A, ADMIN_A, {
          aadObjectId: "oid-2",
          email: "U-MEMBER-A@example.test",
        });

        expect(byId.status).toBe(201);
        expect(byEmail.status).toBe(201);
        expect(byEmail.body.data.userId).toBe("u-member-a");
        expect(await teamsBindings()).toMatchObject([
          { workspaceId: WS_A, aadObjectId: "oid-1", userId: "u-member-a" },
          { workspaceId: WS_A, aadObjectId: "oid-2", userId: "u-member-a" },
        ]);
      });

      it("does not overwrite another workspace's binding of the same identity", async () => {
        expect(
          (await link(WS_B, ADMIN_B, { aadObjectId: "oid-shared", userId: "u-member-b" })).status,
        ).toBe(201);

        await link(WS_A, ADMIN_A, { aadObjectId: "oid-shared", userId: "u-member-a" });

        const resolver = new TeamsAadIdentityResolver(db);
        expect(
          (await resolver.resolveUserFromAadObjectId(TENANT, "oid-shared", WS_B))?.userId,
        ).toBe("u-member-b");
        const inB = await db.teamsUserIdentity.findMany({ where: { workspaceId: WS_B } });
        expect(inB).toMatchObject([{ aadObjectId: "oid-shared", userId: "u-member-b" }]);
      });

      it("re-linking in the same workspace still re-points that workspace's binding", async () => {
        await link(WS_A, ADMIN_A, { aadObjectId: "oid-1", userId: "u-member-a" });
        await link(WS_A, ADMIN_A, { aadObjectId: "oid-1", userId: "u-admin-a" });
        expect(await teamsBindings()).toMatchObject([
          { workspaceId: WS_A, aadObjectId: "oid-1", userId: "u-admin-a" },
        ]);
      });
    });

    describe("Teams resolver unlink", () => {
      it("removes only the named workspace's binding", async () => {
        await link(WS_A, ADMIN_A, { aadObjectId: "oid-shared", userId: "u-member-a" });
        await link(WS_B, ADMIN_B, { aadObjectId: "oid-shared", userId: "u-member-b" });
        const resolver = new TeamsAadIdentityResolver(db);

        expect(await resolver.unlink(WS_A, TENANT, "oid-shared")).toBe(true);

        expect(await teamsBindings()).toMatchObject([
          { workspaceId: WS_B, aadObjectId: "oid-shared", userId: "u-member-b" },
        ]);
      });
    });

    // ── command time: the bound user must be a member of the bot's workspace ───
    describe("Teams command-time resolution", () => {
      const statusIn = async (workspaceId: string, aadObjectId: string) => {
        const sent: unknown[] = [];
        const context = {
          activity: {
            type: "message",
            text: "/metis status proj-x",
            from: { aadObjectId },
            conversation: { id: "conv-1", tenantId: TENANT },
            recipient: { id: "28:bot" },
            channelData: { tenant: { id: TENANT } },
          },
          sendActivity: async (a: unknown) => {
            sent.push(a);
            return { id: "s" };
          },
        } as unknown as TurnContext;
        return handleTeamsStatusCommand(
          context,
          { projectRef: "proj-x" },
          {
            workspaceId,
            db,
            resolver: new TeamsAadIdentityResolver(db),
            tenantPolicy: loadTeamsTenantAllowlist({}),
            rateLimit: (async () => ({ allowed: true, remaining: 1 })) as never,
            authorizeProject: (async () => true) as never,
            summarize: (async () => null) as never,
          },
        );
      };

      it("refuses a legacy binding that names a non-member of the workspace", async () => {
        // The shape the pre-fix route could write: A's binding naming B's member.
        await db.teamsUserIdentity.create({
          data: { workspaceId: WS_A, tenantId: TENANT, aadObjectId: "oid-1", userId: "u-member-b" },
        });

        expect((await statusIn(WS_A, "oid-1")).outcome).toBe("unmapped-sender");
      });

      it("refuses a binding owned by another workspace", async () => {
        await db.teamsUserIdentity.create({
          data: { workspaceId: WS_B, tenantId: TENANT, aadObjectId: "oid-1", userId: "u-member-b" },
        });

        expect((await statusIn(WS_A, "oid-1")).outcome).toBe("unmapped-sender");
      });

      it("refuses once the bound user has left the workspace", async () => {
        await link(WS_A, ADMIN_A, { aadObjectId: "oid-1", userId: "u-member-a" });
        await db.workspaceMember.delete({
          where: { workspaceId_userId: { workspaceId: WS_A, userId: "u-member-a" } },
        });
        try {
          expect((await statusIn(WS_A, "oid-1")).outcome).toBe("unmapped-sender");
        } finally {
          await db.workspaceMember.create({
            data: { workspaceId: WS_A, userId: "u-member-a", role: "member" },
          });
        }
      });

      it("positive control: a member's binding in its own workspace acts", async () => {
        await link(WS_A, ADMIN_A, { aadObjectId: "oid-1", userId: "u-member-a" });

        // Past the identity gate: the stub summarizer finds no project.
        expect((await statusIn(WS_A, "oid-1")).outcome).toBe("project-not-found");
      });
    });

    // ── Slack: same rules on the resolver (it has no HTTP link route) ─────────
    describe("Slack identity resolver", () => {
      const slackBindings = () =>
        db.slackUserIdentity.findMany({ orderBy: { workspaceId: "asc" } });

      it("refuses a non-member target by id and by email, persisting nothing", async () => {
        const resolver = new SlackIdentityResolver(db);
        const byId = await resolver.linkExplicit({
          workspaceId: WS_A,
          slackTeamId: SLACK_TEAM,
          slackUserId: "U1",
          userId: "u-member-b",
        });
        const byEmail = await resolver.linkByEmail({
          workspaceId: WS_A,
          slackTeamId: SLACK_TEAM,
          slackUserId: "U1",
          email: "u-member-b@example.test",
        });

        expect(byId).toEqual({ ok: false, reason: "no_matching_user" });
        expect(byEmail).toEqual({ ok: false, reason: "no_matching_user" });
        expect(await slackBindings()).toEqual([]);
      });

      it("refuses a system admin member unless the caller allows it", async () => {
        const resolver = new SlackIdentityResolver(db);
        const params = {
          workspaceId: WS_A,
          slackTeamId: SLACK_TEAM,
          slackUserId: "U1",
          userId: "u-sysadmin-member",
        };
        expect((await resolver.linkExplicit(params)).ok).toBe(false);
        expect((await resolver.linkExplicit({ ...params, allowSystemAdminTarget: true })).ok).toBe(
          true,
        );
      });

      it("does not overwrite or unlink another workspace's binding", async () => {
        const resolver = new SlackIdentityResolver(db);
        await resolver.linkExplicit({
          workspaceId: WS_B,
          slackTeamId: SLACK_TEAM,
          slackUserId: "U1",
          userId: "u-member-b",
        });
        await resolver.linkExplicit({
          workspaceId: WS_A,
          slackTeamId: SLACK_TEAM,
          slackUserId: "U1",
          userId: "u-member-a",
        });
        await resolver.unlink(WS_A, SLACK_TEAM, "U1");

        expect(await slackBindings()).toMatchObject([
          { workspaceId: WS_B, slackUserId: "U1", userId: "u-member-b" },
        ]);
        expect((await resolver.resolveUserFromSlackId(SLACK_TEAM, "U1", WS_B))?.userId).toBe(
          "u-member-b",
        );
      });

      it("refuses a command whose binding names a non-member, and acts for a member", async () => {
        await db.slackUserIdentity.create({
          data: {
            workspaceId: WS_A,
            slackTeamId: SLACK_TEAM,
            slackUserId: "U-legacy",
            userId: "u-member-b",
          },
        });
        const resolver = new SlackIdentityResolver(db);
        await resolver.linkByEmail({
          workspaceId: WS_A,
          slackTeamId: SLACK_TEAM,
          slackUserId: "U-member",
          email: "u-member-a@example.test",
        });
        const status = (slackUserId: string) =>
          handleSlackStatusCommand(
            { workspaceId: WS_A, slackTeamId: SLACK_TEAM, slackUserId },
            { projectRef: "proj-x" },
            {
              db,
              resolver,
              authorizeProject: (async () => true) as never,
              summarize: (async () => null) as never,
            },
          );

        expect((await status("U-legacy")).outcome).toBe("unmapped-sender");
        expect((await status("U-member")).outcome).toBe("project-not-found");
      });
    });
  },
);
