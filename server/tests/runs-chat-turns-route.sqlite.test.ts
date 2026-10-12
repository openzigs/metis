/**
 * Issue #1007 — `GET /api/runs/chat-turns` through the REAL router, with real
 * access tokens, against a REAL SQLite database built by the migration chain:
 * real users, workspaces, memberships, projects, chat sessions and ledger rows.
 * Nothing about who may see what is faked (review of #1112: the earlier route
 * test returned the caller's project whatever `where` it was asked).
 *
 * What it pins:
 *   • OWNERSHIP — a chat turn is listed to the owner of its chat session only:
 *     not to another member of the same project, not to a signed-in user on a
 *     workspace-less project, not to an admin;
 *   • project scope on top of it, exactly like `GET /api/runs`;
 *   • what a row is — the turn's own ledger row (`chat`, `chat-estimated`,
 *     `chat-failed`) — and that the session's sub-agent, apply-diff and
 *     compaction rows are reported per session, so the session's figures equal
 *     a direct SQL sum over `token_usages`;
 *   • the cost is the STORED ledger cost;
 *   • the per-route rate limiters, on every route of the router.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
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

import express from "express";
import request from "supertest";
import { getPermissionsForRole, type RoleKey } from "@metis/shared";

const { errorHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { runsRouter } = await import("../src/routes/runs.js");
const { APPLY_DIFF_AGENT_STEP } = await import("../src/lib/ai/tools/apply-diff.js");
const { CHAT_APPLY_DIFF_AGENT_STEP, CHAT_SESSION_OTHER_STEPS, CHAT_TURN_LEDGER_STEPS } =
  await import("../src/lib/ai/conversation/chat-turn-ledger.js");

interface Turn {
  id: string;
  sessionId: string;
  projectId: string;
  step: string;
  requests: number;
  tokens: { withCache: number; withoutCache: number };
  costUsd: number | null;
}
interface Spend {
  calls: number;
  tokens: { withCache: number; withoutCache: number };
  costUsd: number | null;
  unpricedTokens: number;
}
interface SessionSpend {
  sessionId: string;
  projectId: string;
  turnCount: number;
  turns: Spend;
  other: Spend;
  total: Spend;
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1007 GET /api/runs/chat-turns — real router, real auth, real SQLite",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const token: Record<string, string> = {};

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/runs", runsRouter());
      a.use(errorHandler);
      return a;
    };
    const get = (path: string, who?: string) => {
      const r = request(app()).get(path);
      return who ? r.set("Authorization", `Bearer ${token[who]}`) : r;
    };
    const turns = async (path: string, who: string): Promise<Turn[]> => {
      const res = await get(path, who);
      expect(res.status).toBe(200);
      return res.body.data.items as Turn[];
    };
    const ids = async (path: string, who: string) => (await turns(path, who)).map((t) => t.id);
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 9, 10, minute));

    interface Row {
      id: string;
      projectId: string;
      sessionId: string | null;
      minute: number;
      agentStep?: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      costUsd?: number | null;
      costCents?: number | null;
      requestTokens?: string;
    }
    async function ledger(r: Row): Promise<void> {
      const inputTokens = r.inputTokens ?? 1_000;
      const outputTokens = r.outputTokens ?? 100;
      const cacheReadTokens = r.cacheReadTokens ?? 400;
      const costUsd = r.costUsd === undefined ? 0.004 : r.costUsd;
      await db.tokenUsage.create({
        data: {
          id: r.id,
          projectId: r.projectId,
          sessionId: r.sessionId,
          agentStep: r.agentStep ?? "chat",
          provider: "anthropic",
          model: "claude-3-5-sonnet",
          inputTokens,
          outputTokens,
          cacheReadTokens,
          totalTokens: inputTokens + outputTokens + cacheReadTokens,
          costUsd,
          costCents: r.costCents === undefined ? (costUsd === null ? null : 0) : r.costCents,
          requestTokens: r.requestTokens ?? null,
          createdAt: at(r.minute),
        },
      });
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1007-chat-turns-route");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;

      const users = [
        "uA",
        "uA2",
        "uB",
        "uNone",
        "uAdmin",
        "uLeft",
        "uRate1",
        "uRate2",
        "uRate3",
        "uRate4",
        "uRate5",
      ];
      for (const id of users) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@x.test` },
        });
      }
      for (const id of ["wsA", "wsB"])
        await db.workspace.create({ data: { id, name: id, slug: id } });
      for (const [workspaceId, userId] of [
        ["wsA", "uA"],
        ["wsA", "uA2"],
        ["wsB", "uB"],
        ["wsA", "uRate1"],
        ["wsA", "uRate2"],
        ["wsA", "uRate3"],
        ["wsA", "uRate4"],
        ["wsA", "uRate5"],
      ] as const) {
        await db.workspaceMember.create({ data: { workspaceId, userId } });
      }
      const project = (id: string, workspaceId?: string) =>
        db.project.create({
          data: {
            id,
            name: id,
            slug: id,
            createdById: "uA",
            ...(workspaceId ? { workspaceId } : {}),
          },
        });
      await project("pA", "wsA");
      await project("pA-2", "wsA");
      await project("pB", "wsB");
      // No workspace: every signed-in user can reach it.
      await project("pOpen");

      const session = (id: string, userId: string, projectId: string | null) =>
        db.aISession.create({
          data: { id, userId, projectId, provider: "anthropic", model: "claude-3-5-sonnet" },
        });
      await session("sA", "uA", "pA");
      await session("sA-other-project", "uA", "pA-2");
      await session("sA2", "uA2", "pA");
      await session("sOpenA", "uA", "pOpen");
      await session("sOpenNone", "uNone", "pOpen");
      await session("sB", "uB", "pB");
      await session("sAdmin", "uAdmin", "pA");
      // Owned by a user who is no longer in the workspace of its project.
      await session("sLeft", "uLeft", "pA");

      // ── uA's session in pA: every kind of row a chat session can hold ──
      // A turn that ran a tool loop: one row, three model calls.
      await ledger({
        id: "t-A-loop",
        projectId: "pA",
        sessionId: "sA",
        minute: 1,
        inputTokens: 900,
        outputTokens: 90,
        cacheReadTokens: 300,
        costUsd: 0.00042,
        requestTokens: JSON.stringify([
          [300, 30, 0, 0],
          [300, 30, 100, 0],
          [300, 30, 200, 0],
        ]),
      });
      // The provider reported no usage: an estimate, recorded unpriced.
      await ledger({
        id: "t-A-estimated",
        projectId: "pA",
        sessionId: "sA",
        minute: 2,
        agentStep: "chat-estimated",
        inputTokens: 50,
        outputTokens: 5,
        cacheReadTokens: 0,
        costUsd: null,
      });
      // A turn that failed after spending.
      await ledger({
        id: "t-A-failed",
        projectId: "pA",
        sessionId: "sA",
        minute: 3,
        agentStep: "chat-failed",
        costUsd: 0.0031,
      });
      // Spend of the same conversation that is in NO turn's row.
      await ledger({
        id: "o-A-sub-1",
        projectId: "pA",
        sessionId: "sA",
        minute: 4,
        agentStep: "subagent",
        inputTokens: 20_000,
        outputTokens: 2_000,
        cacheReadTokens: 5_000,
        costUsd: 0.0915,
      });
      await ledger({
        id: "o-A-sub-2",
        projectId: "pA",
        sessionId: "sA",
        minute: 5,
        agentStep: "subagent",
        costUsd: 0.005,
      });
      await ledger({
        id: "o-A-diff",
        projectId: "pA",
        sessionId: "sA",
        minute: 6,
        agentStep: "chat.apply-diff",
        cacheReadTokens: 0,
        costUsd: null,
      });
      await ledger({
        id: "o-A-compaction",
        projectId: "pA",
        sessionId: "sA",
        minute: 7,
        agentStep: "compaction",
        costUsd: 0.02,
      });
      // Not chat spend, though it names the session: never in the table or the subtotal.
      await ledger({
        id: "x-A-docs",
        projectId: "pA",
        sessionId: "sA",
        minute: 8,
        agentStep: "docs-gen",
      });
      // The session id under a project that is not the session's.
      await ledger({ id: "x-A-wrong-project", projectId: "pA-2", sessionId: "sA", minute: 9 });

      // ── everyone else ──
      await ledger({ id: "t-A-p2", projectId: "pA-2", sessionId: "sA-other-project", minute: 10 });
      await ledger({ id: "t-A2", projectId: "pA", sessionId: "sA2", minute: 11 });
      await ledger({ id: "t-OpenA", projectId: "pOpen", sessionId: "sOpenA", minute: 12 });
      await ledger({ id: "t-OpenNone", projectId: "pOpen", sessionId: "sOpenNone", minute: 13 });
      await ledger({ id: "t-B", projectId: "pB", sessionId: "sB", minute: 14 });
      await ledger({ id: "t-Admin", projectId: "pA", sessionId: "sAdmin", minute: 15 });
      await ledger({ id: "t-Left", projectId: "pA", sessionId: "sLeft", minute: 19 });
      // An analysis row, a chat row whose session no longer exists, one with no session.
      await ledger({
        id: "x-analysis",
        projectId: "pA",
        sessionId: "an1",
        minute: 16,
        agentStep: "analysis",
      });
      await ledger({ id: "x-ghost", projectId: "pA", sessionId: "s-deleted-for-good", minute: 17 });
      await ledger({ id: "x-no-session", projectId: "pA", sessionId: null, minute: 18 });

      await db.agentRun.create({
        data: {
          id: "rA",
          sessionId: "an1",
          projectId: "pA",
          kind: "analysis",
          status: "completed",
          startedAt: at(0),
          completedAt: at(9),
        },
      });

      const mk = (userId: string, role: RoleKey, workspaces: string[]) =>
        issueTokens({
          userId,
          username: userId,
          role,
          permissions: getPermissionsForRole(role),
          workspaces,
        }).accessToken;
      token.A = mk("uA", "developer", ["wsA"]);
      token.A2 = mk("uA2", "developer", ["wsA"]);
      token.B = mk("uB", "developer", ["wsB"]);
      token.none = mk("uNone", "developer", []);
      token.admin = mk("uAdmin", "admin", []);
      // The token still claims the workspace the user has left.
      token.left = mk("uLeft", "developer", ["wsA"]);
      for (const n of [1, 2, 3, 4, 5]) token[`rate${n}`] = mk(`uRate${n}`, "developer", ["wsA"]);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    const A_TURNS = ["t-OpenA", "t-A-p2", "t-A-failed", "t-A-estimated", "t-A-loop"];

    it("requires authentication, and is not answered by the run-by-id route", async () => {
      const anon = await get("/api/runs/chat-turns");
      expect(anon.status).toBe(401);
      const res = await get("/api/runs/chat-turns", "A");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty("items");
      expect(res.body.data).toHaveProperty("sessions");
    });

    describe("ownership: only the turns of the caller's own chat sessions", () => {
      it("I see mine, across my projects, newest first", async () => {
        expect(await ids("/api/runs/chat-turns", "A")).toEqual(A_TURNS);
      });

      it("another member of the same project sees none of my turns", async () => {
        // uA2 is in wsA like uA and can open pA; the list holds uA2's own turn only.
        expect(await ids("/api/runs/chat-turns", "A2")).toEqual(["t-A2"]);
        expect(await ids("/api/runs/chat-turns?projectId=pA", "A2")).toEqual(["t-A2"]);
        expect(await ids("/api/runs/chat-turns?sessionId=sA", "A2")).toEqual([]);
        expect(await ids("/api/runs/chat-turns?projectId=pA&sessionId=sA", "A2")).toEqual([]);
        const res = await get("/api/runs/chat-turns?sessionId=sA", "A2");
        expect(res.body.data.sessions).toEqual([]);
      });

      it("a user in no workspace sees none of another user's turns on a workspace-less project", async () => {
        expect(await ids("/api/runs/chat-turns", "none")).toEqual(["t-OpenNone"]);
        expect(await ids("/api/runs/chat-turns?projectId=pOpen", "none")).toEqual(["t-OpenNone"]);
        expect(await ids("/api/runs/chat-turns?sessionId=sOpenA", "none")).toEqual([]);
        // And uA, on the same open project, does not see theirs.
        expect(await ids("/api/runs/chat-turns?projectId=pOpen", "A")).toEqual(["t-OpenA"]);
      });

      it("an admin gets the same rule: their own sessions, nobody else's", async () => {
        expect(await ids("/api/runs/chat-turns", "admin")).toEqual(["t-Admin"]);
        expect(await ids("/api/runs/chat-turns?sessionId=sA", "admin")).toEqual([]);
        expect(await ids("/api/runs/chat-turns?projectId=pB", "admin")).toEqual([]);
      });

      it("owning a session is not enough: its project must still be reachable", async () => {
        // The rule of `loadAuthorizedSession`: leaving the workspace loses the
        // project's chats. The stale workspace claim in the token changes nothing.
        expect(await ids("/api/runs/chat-turns", "left")).toEqual([]);
        expect(await ids("/api/runs/chat-turns?sessionId=sLeft", "left")).toEqual([]);
        expect((await get("/api/runs/chat-turns?projectId=pA", "left")).status).toBe(404);
      });

      it("never lists a row whose session cannot be tied to the caller", async () => {
        const everyone = ["A", "A2", "B", "none", "admin"];
        for (const who of everyone) {
          const listed = await ids("/api/runs/chat-turns?limit=200", who);
          for (const id of [
            "x-ghost",
            "x-no-session",
            "x-analysis",
            "x-A-docs",
            "x-A-wrong-project",
          ]) {
            expect(listed).not.toContain(id);
          }
        }
      });
    });

    describe("project scope, as on GET /api/runs", () => {
      it("404s an explicit project the caller cannot reach", async () => {
        const res = await get("/api/runs/chat-turns?projectId=pB", "A");
        expect(res.status).toBe(404);
        expect((await get("/api/runs/chat-turns?projectId=pA", "B")).status).toBe(404);
      });

      it("narrows to an explicit project the caller can reach", async () => {
        expect(await ids("/api/runs/chat-turns?projectId=pA-2", "A")).toEqual(["t-A-p2"]);
        expect(await ids("/api/runs/chat-turns?projectId=pA", "A")).toEqual([
          "t-A-failed",
          "t-A-estimated",
          "t-A-loop",
        ]);
      });

      it("a session id from another of my projects surfaces nothing under this one", async () => {
        expect(await ids("/api/runs/chat-turns?projectId=pA-2&sessionId=sA", "A")).toEqual([]);
      });

      it("ignores array and object query parameters rather than passing them on", async () => {
        expect(await ids("/api/runs/chat-turns?sessionId[not]=x", "A")).toEqual(A_TURNS);
        expect(await ids("/api/runs/chat-turns?projectId[]=pA&projectId[]=pB", "A")).toEqual(
          A_TURNS,
        );
      });
    });

    describe("what a row is", () => {
      it("is the turn's own ledger row: chat, chat-estimated and chat-failed", async () => {
        const mine = await turns("/api/runs/chat-turns?sessionId=sA", "A");
        expect(mine.map((t) => [t.id, t.step, t.requests])).toEqual([
          ["t-A-failed", "chat-failed", 1],
          ["t-A-estimated", "chat-estimated", 1],
          ["t-A-loop", "chat", 3],
        ]);
      });

      it("carries the ledger's tokens and its STORED cost, and nothing else", async () => {
        const mine = await turns("/api/runs/chat-turns?sessionId=sA", "A");
        const loop = mine.find((t) => t.id === "t-A-loop")!;
        expect(loop.tokens).toEqual({ withoutCache: 990, withCache: 1_290 });
        // 0.042¢ as recorded: not whole cents, not the tokens at today's rates
        // (990 tokens of Sonnet would be about 0.45¢).
        expect(loop.costUsd).toBeCloseTo(0.00042, 12);
        // Recorded unpriced: unknown, never $0.
        expect(mine.find((t) => t.id === "t-A-estimated")!.costUsd).toBeNull();
        expect(Object.keys(loop).sort()).toEqual([
          "costUsd",
          "createdAt",
          "id",
          "model",
          "projectId",
          "provider",
          "requests",
          "sessionId",
          "step",
          "tokens",
        ]);
      });

      it("names every step it reads, and the apply-diff step is the writer's", () => {
        expect([...CHAT_TURN_LEDGER_STEPS]).toEqual(["chat", "chat-estimated", "chat-failed"]);
        expect([...CHAT_SESSION_OTHER_STEPS]).toEqual([
          "subagent",
          "chat.apply-diff",
          "compaction",
        ]);
        expect(CHAT_APPLY_DIFF_AGENT_STEP).toBe(APPLY_DIFF_AGENT_STEP);
      });
    });

    describe("a session's spend outside its turn rows", () => {
      /** The direct sum over the ledger for one session's steps (all rows here are native Anthropic). */
      async function sqlSpend(projectId: string, sessionId: string, steps: readonly string[]) {
        const rows = await db.tokenUsage.findMany({
          where: { projectId, sessionId, agentStep: { in: [...steps] } },
          select: { id: true },
        });
        const idList = rows.map((r) => r.id);
        const [sum] = await db.$queryRawUnsafe<
          Array<{ withoutCache: number; withCache: number; cost: number | null; unpriced: number }>
        >(
          `SELECT
             COALESCE(SUM("inputTokens" + "outputTokens"), 0) AS "withoutCache",
             COALESCE(SUM("inputTokens" + "outputTokens" + "cacheReadTokens" + "cacheWriteTokens"), 0) AS "withCache",
             SUM(COALESCE("costUsd", "costCents" / 100.0)) AS "cost",
             COALESCE(SUM(CASE WHEN "costUsd" IS NULL AND "costCents" IS NULL
                               THEN "inputTokens" + "outputTokens" + "cacheReadTokens" + "cacheWriteTokens"
                               ELSE 0 END), 0) AS "unpriced"
           FROM "token_usages" WHERE "id" IN (${idList.map(() => "?").join(",") || "NULL"})`,
          ...idList,
        );
        return {
          rows: idList.length,
          tokens: { withoutCache: Number(sum!.withoutCache), withCache: Number(sum!.withCache) },
          costUsd: sum!.cost === null ? null : Number(sum!.cost),
          unpricedTokens: Number(sum!.unpriced),
        };
      }

      function expectSpend(got: Spend, want: Awaited<ReturnType<typeof sqlSpend>>) {
        expect(got.tokens).toEqual(want.tokens);
        expect(got.unpricedTokens).toBe(want.unpricedTokens);
        if (want.costUsd === null) expect(got.costUsd).toBeNull();
        else expect(got.costUsd).toBeCloseTo(want.costUsd, 12);
      }

      it("is reported per session, and turns + other reconcile to the ledger", async () => {
        const res = await get("/api/runs/chat-turns", "A");
        const sessions = res.body.data.sessions as SessionSpend[];
        // One entry per session with a listed turn, in order of first appearance.
        expect(sessions.map((s) => [s.sessionId, s.projectId])).toEqual([
          ["sOpenA", "pOpen"],
          ["sA-other-project", "pA-2"],
          ["sA", "pA"],
        ]);
        const sA = sessions.find((s) => s.sessionId === "sA")!;
        const sqlTurns = await sqlSpend("pA", "sA", CHAT_TURN_LEDGER_STEPS);
        const sqlOther = await sqlSpend("pA", "sA", CHAT_SESSION_OTHER_STEPS);
        const sqlTotal = await sqlSpend("pA", "sA", [
          ...CHAT_TURN_LEDGER_STEPS,
          ...CHAT_SESSION_OTHER_STEPS,
        ]);
        expect(sqlTurns.rows).toBe(3);
        expect(sqlOther.rows).toBe(4);
        expectSpend(sA.turns, sqlTurns);
        expectSpend(sA.other, sqlOther);
        expectSpend(sA.total, sqlTotal);
        expect(sA.turnCount).toBe(3);
        // Model calls: the tool loop's three plus two single-call turns; four other rows.
        expect(sA.turns.calls).toBe(5);
        expect(sA.other.calls).toBe(4);
        expect(sA.total.calls).toBe(9);
        // The figures themselves, so the SQL helper cannot agree with a wrong answer.
        expect(sA.other.tokens).toEqual({ withoutCache: 25_300, withCache: 31_100 });
        expect(sA.other.costUsd).toBeCloseTo(0.1165, 12);
        // The apply-diff row was recorded unpriced.
        expect(sA.other.unpricedTokens).toBe(1_100);
        expect(sA.turns.costUsd).toBeCloseTo(0.00352, 12);
        expect(sA.turns.unpricedTokens).toBe(55);
        expect(sA.total.costUsd).toBeCloseTo(0.12002, 12);
      });

      it("is zero for a session that only has turn rows", async () => {
        const res = await get("/api/runs/chat-turns?sessionId=sA2", "A2");
        expect(res.body.data.sessions).toEqual([
          {
            sessionId: "sA2",
            projectId: "pA",
            turnCount: 1,
            turns: {
              calls: 1,
              tokens: { withoutCache: 1_100, withCache: 1_500 },
              costUsd: expect.closeTo(0.004, 12),
              unpricedTokens: 0,
            },
            other: {
              calls: 0,
              tokens: { withoutCache: 0, withCache: 0 },
              costUsd: 0,
              unpricedTokens: 0,
            },
            total: {
              calls: 1,
              tokens: { withoutCache: 1_100, withCache: 1_500 },
              costUsd: expect.closeTo(0.004, 12),
              unpricedTokens: 0,
            },
          },
        ]);
      });

      it("covers the whole session whatever page or date range lists its turns", async () => {
        const res = await get("/api/runs/chat-turns?sessionId=sA&limit=1", "A");
        expect(res.body.data.items).toHaveLength(1);
        const [sA] = res.body.data.sessions as SessionSpend[];
        expect(sA!.turnCount).toBe(3);
        expect(sA!.other.calls).toBe(4);
      });
    });

    describe("filters and page size", () => {
      it("applies the date range", async () => {
        const from = encodeURIComponent(at(2).toISOString());
        const to = encodeURIComponent(at(3).toISOString());
        expect(await ids(`/api/runs/chat-turns?from=${from}&to=${to}`, "A")).toEqual([
          "t-A-failed",
          "t-A-estimated",
        ]);
        expect(await ids("/api/runs/chat-turns?from=not-a-date", "A")).toEqual(A_TURNS);
      });

      it("takes a positive whole limit; anything else is the default page", async () => {
        expect(await ids("/api/runs/chat-turns?limit=2", "A")).toEqual(A_TURNS.slice(0, 2));
        for (const bad of ["abc", "-3", "0", "1.5", "2abc", ""]) {
          expect(await ids(`/api/runs/chat-turns?limit=${bad}`, "A")).toEqual(A_TURNS);
        }
      });

      it("GET /api/runs: ?limit=abc is no longer a 500 and ?limit=-3 no longer the oldest rows", async () => {
        for (let i = 0; i < 4; i += 1) {
          await db.agentRun.create({
            data: {
              id: `r-page-${i}`,
              sessionId: `an-page-${i}`,
              projectId: "pA",
              kind: "analysis",
              status: "completed",
              startedAt: at(20 + i),
              completedAt: at(21 + i),
            },
          });
        }
        const newestFirst = ["r-page-3", "r-page-2", "r-page-1", "r-page-0", "rA"];
        const list = async (limit: string) => {
          const res = await get(`/api/runs?limit=${limit}`, "A");
          expect(res.status).toBe(200);
          return (res.body.data.items as Array<{ id: string }>).map((r) => r.id);
        };
        for (const bad of ["abc", "-3", "0", "1.5"]) expect(await list(bad)).toEqual(newestFirst);
        expect(await list("3")).toEqual(newestFirst.slice(0, 3));
      });
    });

    describe("rate limits (CodeQL js/missing-rate-limiting)", () => {
      afterEach(() => {
        delete process.env.RUNS_LIMIT_MAX;
        delete process.env.RUNS_PREAUTH_LIMIT_MAX;
      });

      const ROUTES = [
        "/api/runs",
        "/api/runs/chat-turns",
        "/api/runs/rA",
        "/api/runs/rA/replay",
        "/api/runs/rA/sandbox-sessions",
      ];

      it("every route spends the signed-in user's budget, and answers 429 past it", async () => {
        process.env.RUNS_LIMIT_MAX = String(ROUTES.length);
        // One request to each route uses the budget up between them…
        // (The by-id routes answer this user 404: a run's page is open to the
        // project's creator and admins only. A 404 is a served request.)
        const served: number[] = [];
        for (const path of ROUTES) served.push((await get(path, "rate1")).status);
        expect(served).toEqual([200, 200, 404, 404, 404]);
        // …so each of them is now refused.
        for (const path of ROUTES) {
          const res = await get(path, "rate1");
          expect(res.status).toBe(429);
          expect(res.body.error.code).toBe("RUNS_RATE_LIMITED");
        }
        // Another user is not affected, nor served from the first one's counter.
        expect((await get("/api/runs/chat-turns", "rate2")).status).toBe(200);
      });

      it("the budget cannot be dodged with a forwarded address", async () => {
        process.env.RUNS_LIMIT_MAX = "2";
        const statuses: number[] = [];
        for (let i = 0; i < 4; i += 1) {
          const res = await get("/api/runs/chat-turns", "rate3").set(
            "X-Forwarded-For",
            `198.51.100.${i + 1}`,
          );
          statuses.push(res.status);
        }
        expect(statuses).toEqual([200, 200, 429, 429]);
      });

      it("the user budget runs after requireAuth: an anonymous caller cannot spend anyone's", async () => {
        process.env.RUNS_LIMIT_MAX = "1";
        for (let i = 0; i < 3; i += 1) {
          expect((await get("/api/runs/chat-turns")).status).toBe(401);
        }
        // A user's first request is still served.
        expect((await get("/api/runs/chat-turns", "rate4")).status).toBe(200);
      });

      it("a guard runs ahead of requireAuth on every route, keyed on nothing the caller chooses", async () => {
        // The anonymous requests above already counted against the TCP peer.
        process.env.RUNS_PREAUTH_LIMIT_MAX = "1";
        for (const path of ROUTES) {
          const res = await get(path).set("X-Forwarded-For", "203.0.113.77");
          expect(res.status).toBe(429);
        }
        // A made-up token is not a key of its own: it is the same peer bucket.
        const forged = await request(app())
          .get("/api/runs/chat-turns")
          .set("Authorization", "Bearer not-a-token-we-signed");
        expect(forged.status).toBe(429);
      });

      it("an exhausted peer bucket refuses anonymous callers only: a signed-in user is still served", async () => {
        // The guard's key for a signed-in request is the user inside its token,
        // not the TCP peer it shares with every anonymous caller. Were it the
        // peer, anyone could lock every user out of these routes from outside.
        process.env.RUNS_PREAUTH_LIMIT_MAX = "3";
        const anonymous: number[] = [];
        for (let i = 0; i < 5; i += 1) anonymous.push((await get("/api/runs/chat-turns")).status);
        expect(anonymous.slice(-2)).toEqual([429, 429]);
        // Same peer, same instant, a token this server signed: served, on every
        // route (the by-id routes answer this user 404, which is a served request).
        const served: number[] = [];
        for (const path of ROUTES.slice(0, 3)) served.push((await get(path, "rate5")).status);
        expect(served).toEqual([200, 200, 404]);
        // The peer is still refused.
        expect((await get("/api/runs/chat-turns")).status).toBe(429);
      });
    });
  },
);
