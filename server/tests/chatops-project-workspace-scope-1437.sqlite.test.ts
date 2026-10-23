/**
 * #1437 — a ChatOps command acts only on projects in the bot's (Teams) or the
 * install's (Slack) workspace.
 *
 * #1431 made the sender resolve only to a member of the bot's workspace. But a
 * user who belongs to BOTH W1 and W2, once resolved through W1's bot, could still
 * name a W2 project, draft or thread: every command authorized the target only
 * through the user's own project access, never through the bot's workspace.
 *
 * Pinned here, against a real SQLite database built from the migration chain,
 * with the real resolvers, the real project-access rule and the real health
 * summarizer (only the side-effecting approve/promote/create services are
 * spies):
 *   - Teams and Slack `status` (explicit ref, and Teams via a channel link),
 *     `approve` prompt and approve submit/action refuse a W2 target with the
 *     reply an unknown id gets, for a dual member and for a system admin;
 *   - Teams promote and inbound sync refuse a W2 thread like a missing one;
 *   - a legacy workspace-less project is not in the bot's workspace either;
 *   - positive controls: the same user and commands still work on W1 targets.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import type { TurnContext } from "botbuilder";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
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

const { TeamsAadIdentityResolver } = await import("../src/lib/teams/aad-identity-resolver.js");
const { SlackIdentityResolver } = await import("../src/lib/slack/slack-identity-resolver.js");
const { handleTeamsStatusCommand, handleTeamsApproveCommand, handleTeamsApproveSubmit } =
  await import("../src/lib/teams/teams-command.js");
const { handleTeamsPromoteSubmit } = await import("../src/lib/teams/teams-promote.js");
const { ingestTeamsActivity } = await import("../src/lib/teams/inbound-sync.js");
const { handleSlackStatusCommand, handleSlackApproveCommand, handleSlackApproveAction } =
  await import("../src/lib/slack/slack-command.js");
const { loadTeamsTenantAllowlist } = await import("../src/lib/teams/tenant-allowlist.js");

const W1 = "ws-1437-one";
const W2 = "ws-1437-two";
const TENANT = "tenant-1437";
const TEAM = "T1437";
const P1 = "p1437-w1";
const P2 = "p1437-w2";
const PL = "p1437-legacy";
const D1 = "d1437-w1";
const D2 = "d1437-w2";
const T1 = "t1437-w1";
const T2 = "t1437-w2";
const M1 = "m1437-w1";
const M2 = "m1437-w2";
/** Who acts: a coordinator in both workspaces, and a system admin in both. */
const ACTORS = ["dual", "sysdual"] as const;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1437 — ChatOps commands act only on the bot's workspace",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1437-chatops-project-scope");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;

      const coordinator = await db.role.create({ data: { key: "coordinator", name: "Co" } });
      const admin = await db.role.create({ data: { key: "admin", name: "Admin" } });
      for (const [id, roleId] of [
        ["dual", coordinator.id],
        ["sysdual", admin.id],
      ] as const) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@x.test` },
        });
        await db.userRole.create({ data: { userId: id, roleId } });
      }
      for (const ws of [W1, W2]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
        for (const userId of ACTORS) {
          await db.workspaceMember.create({ data: { workspaceId: ws, userId, role: "member" } });
        }
      }
      for (const [id, workspaceId] of [
        [P1, W1],
        [P2, W2],
        [PL, null],
      ] as const) {
        await db.project.create({
          data: {
            id,
            name: id,
            slug: id,
            createdById: "dual",
            status: "active",
            ...(workspaceId ? { workspaceId } : {}),
          },
        });
      }
      for (const [draftId, projectId] of [
        [D1, P1],
        [D2, P2],
      ] as const) {
        await db.issueDraft.create({
          data: { id: draftId, projectId, title: `draft ${draftId}`, body: "b" },
        });
      }
      for (const [threadId, messageId, projectId] of [
        [T1, M1, P1],
        [T2, M2, P2],
      ] as const) {
        await db.discussionThread.create({
          data: { id: threadId, projectId, createdById: "dual", aiResponseMode: "off" },
        });
        await db.discussionMessage.create({
          data: { id: messageId, threadId, authorKind: "human", authorUserId: "dual", body: "x" },
        });
      }
      // Both actors are bound in W1 only — by W1's admin, legitimately (#1431).
      for (const userId of ACTORS) {
        await db.teamsUserIdentity.create({
          data: { workspaceId: W1, tenantId: TENANT, aadObjectId: `aad-${userId}`, userId },
        });
        await db.slackUserIdentity.create({
          data: { workspaceId: W1, slackTeamId: TEAM, slackUserId: `S-${userId}`, userId },
        });
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    // ── Teams ────────────────────────────────────────────────────────────────
    const turn = (who: string, extra: Record<string, unknown> = {}) => {
      const sent: unknown[] = [];
      const context = {
        activity: {
          type: "message",
          text: "",
          from: { id: `29:${who}`, aadObjectId: `aad-${who}` },
          conversation: { id: "conv-1437", tenantId: TENANT },
          recipient: { id: "28:bot" },
          channelData: { tenant: { id: TENANT } },
          ...extra,
        },
        sendActivity: async (a: unknown) => {
          sent.push(a);
          return { id: "sent" };
        },
      } as unknown as TurnContext;
      return { context, sent };
    };
    const linkTo = (threadId: string, projectId: string) =>
      ({
        getByConversation: async () => ({
          id: "link-1437",
          workspaceId: W1,
          threadId,
          projectId,
          conversationId: "conv-1437",
          channelId: "msteams",
          tenantId: TENANT,
          status: "active",
        }),
      }) as never;
    const teamsOpts = (extra: Record<string, unknown> = {}) => ({
      workspaceId: W1,
      db,
      resolver: new TeamsAadIdentityResolver(db),
      linkStore: { getByConversation: async () => null } as never,
      tenantPolicy: loadTeamsTenantAllowlist({}),
      rateLimit: (async () => ({ allowed: true, remaining: 10 })) as never,
      approve: vi.fn(async () => ({}) as never),
      ...extra,
    });

    describe.each(ACTORS)("Teams commands through W1's bot, acting as %s", (who) => {
      const status = async (projectRef: string | null, extra: Record<string, unknown> = {}) => {
        const t = turn(who);
        const result = await handleTeamsStatusCommand(t.context, { projectRef }, teamsOpts(extra));
        return { result, sent: t.sent };
      };

      it("status with an explicit W2 ref is refused exactly like an unknown project", async () => {
        const foreign = await status(P2);
        const unknown = await status("p1437-nope");

        expect(foreign.result.outcome).toBe("forbidden");
        expect(foreign.sent).toEqual(unknown.sent);
        expect(JSON.stringify(foreign.sent)).not.toContain(P2);
      });

      it("status on a legacy workspace-less project is refused too", async () => {
        expect((await status(PL)).result.outcome).toBe("forbidden");
      });

      it("status through a channel link to a W2 project is refused", async () => {
        const res = await status(null, { linkStore: linkTo(T2, P2) });
        expect(res.result.outcome).toBe("forbidden");
      });

      it("positive control: status for a W1 project, explicit and via the link", async () => {
        expect((await status(P1)).result.outcome).toBe("status-shown");
        expect((await status(null, { linkStore: linkTo(T1, P1) })).result.outcome).toBe(
          "status-shown",
        );
      });

      it("approve prompt for a W2 draft is refused like an unknown draft", async () => {
        const f = turn(who);
        const u = turn(who);
        const foreign = await handleTeamsApproveCommand(f.context, { draftRef: D2 }, teamsOpts());
        await handleTeamsApproveCommand(u.context, { draftRef: "d1437-nope" }, teamsOpts());

        expect(foreign.outcome).toBe("draft-not-found");
        expect(f.sent).toEqual(u.sent);
        expect(JSON.stringify(f.sent)).not.toContain("draft d1437-w2");
      });

      it("approve submit for a W2 draft is refused and approves nothing", async () => {
        const opts = teamsOpts();
        const t = turn(who, { value: { metisAction: "approve", draftId: D2 } });
        const result = await handleTeamsApproveSubmit(t.context, opts);

        expect(result.outcome).toBe("draft-not-found");
        expect(opts.approve).not.toHaveBeenCalled();
      });

      it("positive control: approve prompt and submit for a W1 draft", async () => {
        const opts = teamsOpts();
        const prompt = await handleTeamsApproveCommand(turn(who).context, { draftRef: D1 }, opts);
        const submit = await handleTeamsApproveSubmit(
          turn(who, { value: { metisAction: "approve", draftId: D1 } }).context,
          opts,
        );

        expect(prompt.outcome).toBe("approve-prompted");
        expect(submit.outcome).toBe("approved");
        expect(opts.approve).toHaveBeenCalledWith(expect.objectContaining({ draftId: D1 }));
      });

      it("promote of a W2 thread's message is refused like a missing thread", async () => {
        const promote = vi.fn(async () => ({ requirementId: "r" }) as never);
        const opts = { workspaceId: W1, db, resolver: new TeamsAadIdentityResolver(db), promote };
        const submit = (threadId: string, messageId: string) =>
          handleTeamsPromoteSubmit(
            turn(who, { value: { metisAction: "promote", threadId, messageId } }).context,
            { ...opts, tenantPolicy: loadTeamsTenantAllowlist({}) },
          );

        expect((await submit(T2, M2)).outcome).toBe("thread-not-found");
        expect((await submit("t1437-nope", M2)).outcome).toBe("thread-not-found");
        expect(promote).not.toHaveBeenCalled();

        // Positive control: a W1 thread promotes.
        expect((await submit(T1, M1)).outcome).toBe("promoted");
        expect(promote).toHaveBeenCalledTimes(1);
      });

      it("inbound sync into a W2 thread is refused like a missing thread", async () => {
        const createMessage = vi.fn(async () => ({ id: "new-msg" }) as never);
        const ingest = (threadId: string, projectId: string) =>
          ingestTeamsActivity(turn(who, { text: "hello from teams" }).context, {
            ...teamsOpts(),
            identityResolver: new TeamsAadIdentityResolver(db),
            linkStore: linkTo(threadId, projectId),
            createMessage,
            respondAsAI: vi.fn(async () => undefined) as never,
          });

        expect((await ingest(T2, P2)).outcome).toBe("thread-not-found");
        expect(createMessage).not.toHaveBeenCalled();

        // Positive control: the W1 thread ingests.
        expect((await ingest(T1, P1)).outcome).toBe("ingested");
        expect(createMessage).toHaveBeenCalledTimes(1);
      });
    });

    // ── Slack ────────────────────────────────────────────────────────────────
    describe.each(ACTORS)("Slack commands through W1's install, acting as %s", (who) => {
      const actor = { workspaceId: W1, slackTeamId: TEAM, slackUserId: `S-${who}` };
      const slackOpts = () => ({
        db,
        resolver: new SlackIdentityResolver(db),
        approve: vi.fn(async () => ({}) as never),
      });

      it("status with a W2 ref is refused exactly like an unknown project", async () => {
        const foreign = await handleSlackStatusCommand(actor, { projectRef: P2 }, slackOpts());
        const unknown = await handleSlackStatusCommand(
          actor,
          { projectRef: "p1437-nope" },
          slackOpts(),
        );

        expect(foreign.outcome).toBe("forbidden");
        expect(foreign.blocks).toEqual(unknown.blocks);
      });

      it("status with a W2 default project is refused", async () => {
        const reply = await handleSlackStatusCommand(
          { ...actor, defaultProjectId: P2 },
          { projectRef: null },
          slackOpts(),
        );
        expect(reply.outcome).toBe("forbidden");
      });

      it("approve prompt and action for a W2 draft are refused like an unknown draft", async () => {
        const opts = slackOpts();
        const prompt = await handleSlackApproveCommand(actor, { draftRef: D2 }, opts);
        const unknown = await handleSlackApproveCommand(actor, { draftRef: "d1437-nope" }, opts);
        const action = await handleSlackApproveAction(actor, { draftId: D2 }, opts);

        expect(prompt.outcome).toBe("draft-not-found");
        expect(prompt.blocks).toEqual(unknown.blocks);
        expect(action.outcome).toBe("draft-not-found");
        expect(opts.approve).not.toHaveBeenCalled();
      });

      it("positive control: status, prompt and action on W1 targets", async () => {
        const opts = slackOpts();
        expect((await handleSlackStatusCommand(actor, { projectRef: P1 }, opts)).outcome).toBe(
          "status-shown",
        );
        expect((await handleSlackApproveCommand(actor, { draftRef: D1 }, opts)).outcome).toBe(
          "approve-prompted",
        );
        expect((await handleSlackApproveAction(actor, { draftId: D1 }, opts)).outcome).toBe(
          "approved",
        );
        expect(opts.approve).toHaveBeenCalledTimes(1);
      });
    });
  },
);
