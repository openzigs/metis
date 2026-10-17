/**
 * #1221 — requirement links, the workspace traceability roll-up and the
 * Slack/Teams `/metis` commands follow project access: the project's workspace
 * members, not only its creator.
 *
 * Workspace `ws1` holds projects A and C, both created by Alice. Bob is a
 * second member of `ws1` (coordinator, NOT the creator), Rita a third (reader
 * role). Mallory is a coordinator in `ws2`, where she created project B. Nobody
 * here is a system admin — an admin bypasses the check, so an admin test proves
 * nothing about it. Chat identities resolve to these METIS users, and their
 * role comes from their `UserRole` binding, exactly as in production.
 *
 * Real SQLite built by the migration chain, real routers, services and JWTs;
 * the only doubles are the chat identity resolvers, the Teams turn context and
 * the approval service on the button click. No model is called.
 *
 * Each "Bob may" assertion fails if the creator-only rule is restored in
 * `actorHasProjectAccess` or `listMemberProjectsInWorkspace`.
 */
import express from "express";
import request from "supertest";
import type { TurnContext } from "botbuilder";
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
  const actual =
    await vi.importActual<typeof import("../src/lib/prisma.js")>("../src/lib/prisma.js");
  return {
    ...actual,
    get prisma() {
      return state.db;
    },
  };
});
const auditSpy = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: auditSpy }));

const { requirementLinksRouter, requirementLinksResourceRouter, workspaceRequirementSearchRouter } =
  await import("../src/routes/requirement-links.js");
const { getRequirementChainWithLinks, getWorkspaceTraceabilitySummary } =
  await import("../src/lib/traceability/workspace-rollup.js");
const { handleSlackStatusCommand, handleSlackApproveCommand, handleSlackApproveAction } =
  await import("../src/lib/slack/slack-command.js");
const { handleTeamsStatusCommand, handleTeamsApproveCommand } =
  await import("../src/lib/teams/teams-command.js");
const { loadTeamsTenantAllowlist } = await import("../src/lib/teams/tenant-allowlist.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const WS1 = "ws1-1221-links";
const WS2 = "ws2-1221-links";
const PA = "proj-a-1221-links";
const PC = "proj-c-1221-links";
const PB = "proj-b-1221-links";

const USERS: Record<string, { role: RoleKey; ws: string }> = {
  alice: { role: "coordinator", ws: WS1 },
  bob: { role: "coordinator", ws: WS1 },
  rita: { role: "reader", ws: WS1 },
  mallory: { role: "coordinator", ws: WS2 },
  // #1233 review A01 — ws1 members whose access ended after their token was
  // minted: Dora was disabled, Sid soft-deleted (SCIM, #612; both keep their
  // WorkspaceMember row), Gus's membership row was deleted.
  dora: { role: "coordinator", ws: WS1 },
  sid: { role: "coordinator", ws: WS1 },
  gus: { role: "coordinator", ws: WS1 },
};
const REVOKED = ["dora", "sid", "gus"] as const;
type Who = keyof typeof USERS;
const actorOf = (who: Who) => ({ id: who, role: USERS[who].role });

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1221 — requirement links, roll-up and chat commands are open to the project's workspace members",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const req: Record<"a1" | "a2" | "c" | "b", string> = { a1: "", a2: "", c: "", b: "" };
    let linkToC = "";
    let draftA = "";

    const bearer = (who: Who) => {
      const payload: AuthPayload = {
        userId: who,
        username: who,
        role: USERS[who].role,
        permissions: getPermissionsForRole(USERS[who].role),
        workspaces: [USERS[who].ws],
      };
      return `Bearer ${issueTokens(payload).accessToken}`;
    };

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/requirements/:requirementId/links", requirementLinksRouter());
      a.use("/api/requirement-links", requirementLinksResourceRouter());
      a.use("/api/workspaces/:workspaceId/requirements", workspaceRequirementSearchRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const linkTo = (from: string, to: string, who: Who, type = "relates_to") =>
      request(app())
        .post(`/api/requirements/${from}/links`)
        .set("Authorization", bearer(who))
        .send({ targetRequirementId: to, type });
    const linkCount = (from: string, to: string) =>
      db.requirementLink.count({
        where: { sourceRequirementId: from, targetRequirementId: to },
      });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1221-member-access-links");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const key of ["coordinator", "reader"]) {
        await db.role.create({ data: { id: `role-${key}`, key, name: key } });
      }
      for (const [id, u] of Object.entries(USERS)) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
        await db.userRole.create({ data: { userId: id, roleId: `role-${u.role}` } });
      }
      for (const ws of [WS1, WS2]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      for (const [userId, u] of Object.entries(USERS)) {
        await db.workspaceMember.create({ data: { workspaceId: u.ws, userId, role: "member" } });
      }
      for (const [id, createdById, workspaceId] of [
        [PA, "alice", WS1],
        [PC, "alice", WS1],
        [PB, "mallory", WS2],
      ] as const) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById, workspaceId, status: "active" },
        });
        await db.analysis.create({ data: { id: `an-${id}`, projectId: id, startedById: "alice" } });
      }
      const requirement = async (projectId: string, title: string) =>
        (
          await db.requirement.create({
            data: { projectId, analysisId: `an-${projectId}`, title, body: title },
          })
        ).id;
      req.a1 = await requirement(PA, "Export the monthly ledger");
      req.a2 = await requirement(PA, "Ledger totals reconcile");
      req.c = await requirement(PC, "Ledger feed for reporting");
      req.b = await requirement(PB, "Mallory's private requirement");
      linkToC = (
        await db.requirementLink.create({
          data: {
            sourceRequirementId: req.a1,
            targetRequirementId: req.c,
            type: "relates_to",
            createdById: "alice",
          },
        })
      ).id;
      // A cross-workspace edge (seeded directly — the API refuses to make one),
      // so the roll-up has an inaccessible counterpart to keep restricted.
      await db.requirementLink.create({
        data: {
          sourceRequirementId: req.a1,
          targetRequirementId: req.b,
          type: "relates_to",
          createdById: "mallory",
        },
      });
      draftA = (await db.issueDraft.create({ data: { projectId: PA, title: "D", body: "B" } })).id;
      await db.user.update({ where: { id: "dora" }, data: { status: "disabled" } });
      await db.user.update({ where: { id: "sid" }, data: { deletedAt: new Date() } });
      await db.workspaceMember.deleteMany({ where: { userId: "gus" } });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    // ── Requirement links ────────────────────────────────────────────────────

    describe("requirement links", () => {
      it("both members read a requirement's links; the non-member gets 404", async () => {
        for (const who of ["bob", "rita"] as const) {
          const res = await request(app())
            .get(`/api/requirements/${req.a1}/links`)
            .set("Authorization", bearer(who));
          expect(res.status).toBe(200);
          const targets = (res.body.data.outgoing as Array<{ requirement: { id: string } }>).map(
            (l) => l.requirement.id,
          );
          expect(targets).toContain(req.c);
          // The cross-workspace counterpart stays hidden from ws1's members.
          expect(targets).not.toContain(req.b);
        }
        const outsider = await request(app())
          .get(`/api/requirements/${req.a1}/links`)
          .set("Authorization", bearer("mallory"));
        expect(outsider.status).toBe(404);
      });

      it("a second member links two requirements across the workspace's projects; reader and non-member cannot", async () => {
        expect((await linkTo(req.a2, req.c, "rita")).status).toBe(403);
        const outsider = await linkTo(req.a2, req.c, "mallory");
        expect(outsider.status).toBe(403);
        expect(await linkCount(req.a2, req.c)).toBe(0);

        const res = await linkTo(req.a2, req.c, "bob");
        expect(res.status).toBe(201);
        const row = await db.requirementLink.findFirstOrThrow({
          where: { sourceRequirementId: req.a2, targetRequirementId: req.c },
        });
        expect(row.createdById).toBe("bob");
      });

      it("a link to or from a project the actor cannot reach is refused, in either direction", async () => {
        const out = await linkTo(req.a2, req.b, "bob");
        expect(out.status).toBe(403);
        const into = await linkTo(req.b, req.a2, "mallory");
        expect(into.status).toBe(403);
        expect(await linkCount(req.a2, req.b)).toBe(0);
        expect(await linkCount(req.b, req.a2)).toBe(0);
        expect(auditSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            actor: { id: "mallory" },
            metadata: expect.objectContaining({ projectId: PA }),
          }),
        );
      });

      it("a second member deletes a link; reader and non-member cannot", async () => {
        const link = await db.requirementLink.create({
          data: {
            sourceRequirementId: req.a1,
            targetRequirementId: req.a2,
            type: "duplicates",
            createdById: "alice",
          },
        });
        const del = (who: Who) =>
          request(app())
            .delete(`/api/requirement-links/${link.id}`)
            .set("Authorization", bearer(who));
        expect((await del("rita")).status).toBe(403);
        expect((await del("mallory")).status).toBe(404);
        expect(await db.requirementLink.count({ where: { id: link.id } })).toBe(1);

        expect((await del("bob")).status).toBe(200);
        expect(await db.requirementLink.count({ where: { id: link.id } })).toBe(0);
      });

      it("both members search every project in the workspace; the non-member gets 404", async () => {
        for (const who of ["bob", "rita"] as const) {
          const res = await request(app())
            .get(`/api/workspaces/${WS1}/requirements/search?q=Ledger`)
            .set("Authorization", bearer(who));
          expect(res.status).toBe(200);
          const ids = (res.body.data.items as Array<{ id: string }>).map((r) => r.id);
          expect(ids).toEqual(expect.arrayContaining([req.a1, req.a2, req.c]));
          expect(ids).not.toContain(req.b);
        }
        const outsider = await request(app())
          .get(`/api/workspaces/${WS1}/requirements/search?q=Ledger`)
          .set("Authorization", bearer("mallory"));
        expect(outsider.status).toBe(404);
      });

      it("a disabled, soft-deleted or removed member's unexpired token searches nothing: 404, as on the per-id read", async () => {
        for (const who of REVOKED) {
          const byId = await request(app())
            .get(`/api/requirements/${req.a1}/links`)
            .set("Authorization", bearer(who));
          expect(byId.status, `${who} per-id read`).toBe(404);
          const search = await request(app())
            .get(`/api/workspaces/${WS1}/requirements/search?q=Ledger`)
            .set("Authorization", bearer(who));
          expect(search.status, `${who} search`).toBe(404);
          expect(search.body.data).toBeUndefined();
        }
      });
    });

    // ── Traceability roll-up ─────────────────────────────────────────────────

    describe("traceability roll-up", () => {
      it("a linked chain into a teammate's project is open to a second member; the other workspace stays restricted", async () => {
        for (const who of ["bob", "rita"] as const) {
          const chain = await getRequirementChainWithLinks(
            actorOf(who),
            PA,
            req.a1,
            {},
            {
              prisma: db as never,
            },
          );
          const byId = new Map(chain.linkedChains.map((l) => [l.link.requirement.id, l]));
          expect(byId.get(req.c)?.restricted).toBe(false);
          expect(byId.get(req.c)?.chain).not.toBeNull();
          expect(byId.get(req.b)?.restricted).toBe(true);
          expect(byId.get(req.b)?.chain).toBeNull();
        }
        // The other side of the same edge: Mallory reaches her own project only.
        const fromB = await getRequirementChainWithLinks(
          actorOf("mallory"),
          PB,
          req.b,
          {},
          {
            prisma: db as never,
          },
        );
        expect(fromB.linkedChains.map((l) => [l.link.requirement.id, l.restricted])).toEqual([
          [req.a1, true],
        ]);
      });

      it("the workspace summary covers every project for both members; the non-member gets 404", async () => {
        for (const who of ["bob", "rita"] as const) {
          const summary = await getWorkspaceTraceabilitySummary(actorOf(who), WS1, {
            prisma: db as never,
          });
          expect(summary.projects.map((p) => p.projectId).sort()).toEqual([PA, PC].sort());
          expect(summary.crossProjectLinks.map((l) => l.linkId)).toContain(linkToC);
        }
        await expect(
          getWorkspaceTraceabilitySummary(actorOf("mallory"), WS1, { prisma: db as never }),
        ).rejects.toMatchObject({ statusCode: 404 });
      });

      it("the workspace summary is 404 for a disabled, soft-deleted or removed member", async () => {
        for (const who of REVOKED) {
          await expect(
            getWorkspaceTraceabilitySummary(actorOf(who), WS1, { prisma: db as never }),
            who,
          ).rejects.toMatchObject({ statusCode: 404 });
        }
      });
    });

    // ── Slack / Teams commands ───────────────────────────────────────────────

    describe("Slack /metis", () => {
      const slackOpts = () => ({
        db,
        resolver: {
          resolveUserFromSlackId: async (_team: string, slackUserId: string) =>
            slackUserId in USERS ? { userId: slackUserId } : null,
        } as never,
        approve: vi.fn(async () => ({ id: draftA }) as never),
      });
      const slackActor = (who: string) => ({
        workspaceId: WS1,
        slackTeamId: "T1221",
        slackUserId: who,
      });

      it("status: both members see the project's health; the non-member is refused", async () => {
        for (const who of ["bob", "rita"]) {
          const reply = await handleSlackStatusCommand(
            slackActor(who),
            { projectRef: PA },
            slackOpts(),
          );
          expect(reply.outcome).toBe("status-shown");
        }
        const outsider = await handleSlackStatusCommand(
          slackActor("mallory"),
          { projectRef: PA },
          slackOpts(),
        );
        expect(outsider.outcome).toBe("forbidden");
      });

      it("approve: a second member with issue.draft is prompted and the click approves; reader and non-member are refused", async () => {
        const opts = slackOpts();
        const prompt = await handleSlackApproveCommand(
          slackActor("bob"),
          { draftRef: draftA },
          opts,
        );
        expect(prompt.outcome).toBe("approve-prompted");
        const click = await handleSlackApproveAction(slackActor("bob"), { draftId: draftA }, opts);
        expect(click.outcome).toBe("approved");
        expect(opts.approve).toHaveBeenCalledTimes(1);

        const reader = await handleSlackApproveCommand(
          slackActor("rita"),
          { draftRef: draftA },
          opts,
        );
        expect(reader.outcome).toBe("forbidden");
        const outsider = await handleSlackApproveAction(
          slackActor("mallory"),
          { draftId: draftA },
          opts,
        );
        expect(outsider.outcome).toBe("draft-not-found");
        expect(opts.approve).toHaveBeenCalledTimes(1);
      });
    });

    describe("Teams /metis", () => {
      const turn = (who: string): TurnContext =>
        ({
          activity: {
            type: "message",
            text: "",
            from: { aadObjectId: `aad-${who}` },
            conversation: { id: "conv-1221", tenantId: "tenant-1221" },
            recipient: { id: "28:bot" },
            channelData: {},
          },
          sendActivity: vi.fn(async () => ({ id: "sent" })),
        }) as unknown as TurnContext;
      const teamsOpts = () => ({
        workspaceId: WS1,
        db,
        resolver: {
          resolveUserFromAadObjectId: async (_tenant: string, aad: string | null) => {
            const who = (aad ?? "").replace(/^aad-/, "");
            return who in USERS ? { userId: who, username: who, email: null } : null;
          },
        } as never,
        linkStore: { getByConversation: async () => null } as never,
        tenantPolicy: loadTeamsTenantAllowlist({}),
        rateLimit: (async () => ({ allowed: true, remaining: 10 })) as never,
        approve: vi.fn(async () => ({ id: draftA }) as never),
      });

      it("status: both members see the project's health; the non-member is refused", async () => {
        for (const who of ["bob", "rita"]) {
          const result = await handleTeamsStatusCommand(turn(who), { projectRef: PA }, teamsOpts());
          expect(result.outcome).toBe("status-shown");
        }
        const outsider = await handleTeamsStatusCommand(
          turn("mallory"),
          { projectRef: PA },
          teamsOpts(),
        );
        expect(outsider.outcome).toBe("forbidden");
      });

      it("approve: a second member with issue.draft is prompted; reader and non-member are refused", async () => {
        const bob = await handleTeamsApproveCommand(turn("bob"), { draftRef: draftA }, teamsOpts());
        expect(bob.outcome).toBe("approve-prompted");
        const reader = await handleTeamsApproveCommand(
          turn("rita"),
          { draftRef: draftA },
          teamsOpts(),
        );
        expect(reader.outcome).toBe("forbidden");
        const outsider = await handleTeamsApproveCommand(
          turn("mallory"),
          { draftRef: draftA },
          teamsOpts(),
        );
        expect(outsider.outcome).toBe("draft-not-found");
      });
    });
  },
);
