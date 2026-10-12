/**
 * Issue #1007 (review of #1112, cycle 2) — `GET /api/runs/chat-turns` for a
 * caller with far more chat sessions than one SQL statement can name, through
 * the REAL router against a REAL SQLite database.
 *
 * Prisma's better-sqlite3 adapter takes 999 bound values a statement and
 * refuses more with P2029; it does not split a read that has an `orderBy` or a
 * `take`. The first version of this route named every session of the caller in
 * one `IN` list: 985 sessions answered 200, 1,000 answered 500. Every fixture
 * then had a handful of sessions, so nothing saw it.
 *
 * What it pins:
 *   • 2,500 sessions answer 200, with the right rows in the right order (the
 *     order one statement over the whole ledger gives) and the right session
 *     totals — the page is assembled from several statements;
 *   • no statement of the request binds more than 900 values, counting every
 *     bound value and not only the ids;
 *   • a caller who can reach more than 999 projects is served too;
 *   • a chat its owner DELETED is still listed to its owner, the one respect in
 *     which this list differs from `loadAuthorizedSession`.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { getPermissionsForRole } from "@metis/shared";

const { errorHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { runsRouter } = await import("../src/routes/runs.js");
const { listChatTurns, CHAT_TURN_SESSION_BATCH } =
  await import("../src/lib/ai/conversation/chat-turn-ledger.js");
const { loadAuthorizedSession } = await import("../src/lib/ai/conversation/session-access.js");

/** The engine's limit on this adapter, and the margin this suite holds the code to. */
const SQLITE_BIND_LIMIT = 999;
const SAFE_BINDS = 900;

const SESSIONS = 2_500;
const MANY = "uMany";
const pad = (n: number) => String(n).padStart(4, "0");
const sessionId = (i: number) => `sm-${pad(i)}`;
/** Every fifth session is in the second project, so a page mixes projects. */
const projectOf = (i: number) => (i % 5 === 0 ? "pM2" : "pM1");
/**
 * When session `i`'s turn was written, in seconds: a permutation of
 * 0…2,499 (7,919 is prime), so the newest turns are scattered over every
 * batch of sessions instead of sitting in the last one.
 */
const second = (i: number) => (i * 7_919) % SESSIONS;
const at = (s: number) => new Date(Date.UTC(2026, 9, 9, 10, 0, s));

interface Turn {
  id: string;
  sessionId: string;
  projectId: string;
  createdAt: string;
}
interface SessionSpend {
  sessionId: string;
  projectId: string;
  turnCount: number;
  turns: { calls: number; tokens: { withCache: number } };
  other: { calls: number; tokens: { withCache: number } };
  total: { calls: number; tokens: { withCache: number }; costUsd: number | null };
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1007 GET /api/runs/chat-turns — thousands of sessions on real SQLite",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const token: Record<string, string> = {};
    /** Bound values of each statement since the last reset. */
    let binds: number[] = [];
    let ledgerStatements = 0;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/runs", runsRouter());
      a.use(errorHandler);
      return a;
    };
    const get = (path: string, who: string) =>
      request(app()).get(path).set("Authorization", `Bearer ${token[who]}`);

    /**
     * One statement over the whole ledger: the order and the rows the page must
     * have. (`EXISTS` by the session's primary key, so the ledger is walked
     * once; a join was planned from the sessions and took 0.7 s.)
     */
    async function sqlPage(userId: string, limit: number): Promise<string[]> {
      const rows = await db.$queryRaw<Array<{ id: string }>>`
        SELECT t."id" FROM "token_usages" t
        WHERE t."agentStep" IN ('chat', 'chat-estimated', 'chat-failed')
          AND EXISTS (SELECT 1 FROM "ai_sessions" s
                      WHERE s."id" = t."sessionId" AND s."projectId" = t."projectId"
                        AND s."userId" = ${userId})
        ORDER BY t."createdAt" DESC, t."id" DESC
        LIMIT ${limit}`;
      return rows.map((r) => r.id);
    }

    /** Each session's chat rows summed directly: rows, turn rows, tokens with cache, cost. */
    async function sqlSessions(userId: string) {
      const rows = await db.$queryRaw<
        Array<{ sessionId: string; calls: bigint; turns: bigint; withCache: bigint; cost: number }>
      >`
        SELECT t."sessionId" AS "sessionId", COUNT(*) AS "calls",
               SUM(CASE WHEN t."agentStep" IN ('chat', 'chat-estimated', 'chat-failed') THEN 1 ELSE 0 END) AS "turns",
               SUM(t."inputTokens" + t."outputTokens" + t."cacheReadTokens" + t."cacheWriteTokens") AS "withCache",
               SUM(t."costUsd") AS "cost"
        FROM "token_usages" t
        WHERE t."agentStep" IN ('chat', 'chat-estimated', 'chat-failed', 'subagent', 'chat.apply-diff', 'compaction')
          AND EXISTS (SELECT 1 FROM "ai_sessions" s
                      WHERE s."id" = t."sessionId" AND s."projectId" = t."projectId"
                        AND s."userId" = ${userId})
        GROUP BY t."sessionId"`;
      return new Map(
        rows.map((r) => [
          r.sessionId,
          {
            calls: Number(r.calls),
            turns: Number(r.turns),
            withCache: Number(r.withCache),
            cost: r.cost,
          },
        ]),
      );
    }

    const row = (
      id: string,
      projectId: string,
      session: string,
      createdAt: Date,
      agentStep = "chat",
    ) => ({
      id,
      projectId,
      sessionId: session,
      agentStep,
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 400,
      totalTokens: 1_500,
      costUsd: 0.004,
      costCents: 0,
      createdAt,
    });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1007-chat-turns-many");
      db = new PrismaClient({
        adapter: new PrismaBetterSqlite3({ url: sqlite.url }),
        log: [{ emit: "event", level: "query" }],
      });
      (
        db as unknown as {
          $on(event: "query", cb: (e: { query: string; params: string }) => void): void;
        }
      ).$on("query", (e) => {
        binds.push((JSON.parse(e.params) as unknown[]).length);
        if (e.query.includes("token_usages")) ledgerStatements += 1;
      });
      state.db = db;

      for (const id of [MANY, "uDel", "uOther"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@x.test` },
        });
      }
      await db.workspace.create({ data: { id: "wsM", name: "wsM", slug: "wsM" } });
      for (const userId of [MANY, "uDel", "uOther"]) {
        await db.workspaceMember.create({ data: { workspaceId: "wsM", userId } });
      }
      for (const id of ["pM1", "pM2"]) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById: MANY, workspaceId: "wsM" },
        });
      }

      const index = Array.from({ length: SESSIONS }, (_, i) => i);
      const chunks = <T>(items: T[], size: number) =>
        Array.from({ length: Math.ceil(items.length / size) }, (_, n) =>
          items.slice(n * size, (n + 1) * size),
        );
      for (const part of chunks(index, 100)) {
        await db.aISession.createMany({
          data: part.map((i) => ({
            id: sessionId(i),
            userId: MANY,
            projectId: projectOf(i),
            provider: "anthropic",
            model: "claude-3-5-sonnet",
          })),
        });
      }
      // One turn per session.
      for (const part of chunks(index, 50)) {
        await db.tokenUsage.createMany({
          data: part.map((i) =>
            row(`tm-${pad(i)}`, projectOf(i), sessionId(i), at(second(i)), "chat"),
          ),
        });
      }
      // Rows written in the SAME instant as the newest turn, in sessions that
      // fall in other batches: the order between batches must still be total.
      const newest = index.find((i) => second(i) === SESSIONS - 1)!;
      await db.tokenUsage.createMany({
        data: [
          row("tz-tie-first", projectOf(0), sessionId(0), at(second(newest)), "chat-failed"),
          row(
            "tz-tie-last",
            projectOf(SESSIONS - 1),
            sessionId(SESSIONS - 1),
            at(second(newest)),
            "chat-estimated",
          ),
        ],
      });
      // The newest session's other chat spend, a row that is not chat spend,
      // and its id under a project that is not its own.
      const other = projectOf(newest) === "pM1" ? "pM2" : "pM1";
      await db.tokenUsage.createMany({
        data: [
          row("om-sub", projectOf(newest), sessionId(newest), at(1), "subagent"),
          row("om-diff", projectOf(newest), sessionId(newest), at(2), "chat.apply-diff"),
          row("om-compaction", projectOf(newest), sessionId(newest), at(3), "compaction"),
          row("xm-docs", projectOf(newest), sessionId(newest), at(4), "docs-gen"),
          row("xm-wrong-project", other, sessionId(newest), at(SESSIONS + 5), "chat"),
        ],
      });

      // ── 450 sessions, each in a project of its own ──
      const spread = Array.from({ length: 450 }, (_, i) => i);
      await db.user.create({
        data: { id: "uSpread", username: "uSpread", displayName: "uSpread", email: "s@x.test" },
      });
      for (const part of chunks(spread, 100)) {
        await db.project.createMany({
          data: part.map((i) => ({
            id: `ps-${pad(i)}`,
            name: `ps-${pad(i)}`,
            slug: `ps-${pad(i)}`,
            createdById: "uSpread",
          })),
        });
        await db.aISession.createMany({
          data: part.map((i) => ({
            id: `ss-${pad(i)}`,
            userId: "uSpread",
            projectId: `ps-${pad(i)}`,
            provider: "anthropic",
            model: "claude-3-5-sonnet",
          })),
        });
      }
      for (const part of chunks(spread, 50)) {
        await db.tokenUsage.createMany({
          data: part.map((i) =>
            row(`ts-${pad(i)}`, `ps-${pad(i)}`, `ss-${pad(i)}`, at((i * 7_919) % 450)),
          ),
        });
      }

      // ── a chat its owner deleted, and one they did not ──
      await db.aISession.create({
        data: {
          id: "sd-live",
          userId: "uDel",
          projectId: "pM1",
          provider: "anthropic",
          model: "claude-3-5-sonnet",
        },
      });
      await db.aISession.create({
        data: {
          id: "sd-deleted",
          userId: "uDel",
          projectId: "pM1",
          provider: "anthropic",
          model: "claude-3-5-sonnet",
          deletedAt: at(50),
        },
      });
      await db.tokenUsage.createMany({
        data: [
          row("td-live", "pM1", "sd-live", at(10)),
          row("td-deleted", "pM1", "sd-deleted", at(20)),
          row("od-deleted-sub", "pM1", "sd-deleted", at(21), "subagent"),
        ],
      });

      for (const userId of [MANY, "uDel", "uOther"]) {
        token[userId] = issueTokens({
          userId,
          username: userId,
          role: "developer",
          permissions: getPermissionsForRole("developer"),
          workspaces: ["wsM"],
        }).accessToken;
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      binds = [];
      ledgerStatements = 0;
    });

    describe("a caller with 2,500 chat sessions", () => {
      it("the fixture is past what one statement can name", () => {
        expect(SESSIONS).toBeGreaterThan(2 * SQLITE_BIND_LIMIT);
        expect(SESSIONS).toBeGreaterThan(6 * CHAT_TURN_SESSION_BATCH);
      });

      it("answers 200 with the newest 200 turns, in the order one statement gives", async () => {
        const res = await get("/api/runs/chat-turns?limit=200", MANY);
        expect(res.status).toBe(200);
        const items = res.body.data.items as Turn[];
        const expected = await sqlPage(MANY, 200);
        expect(expected).toHaveLength(200);
        expect(items.map((t) => t.id)).toEqual(expected);

        // The three rows of the newest instant lead, by id: they come from three batches.
        expect(items.slice(0, 3).map((t) => t.id)).toEqual([
          "tz-tie-last",
          "tz-tie-first",
          expected[2],
        ]);
        expect(new Set(items.slice(0, 3).map((t) => t.createdAt)).size).toBe(1);
        // Newest first throughout, and from both projects.
        const times = items.map((t) => Date.parse(t.createdAt));
        expect([...times].sort((a, b) => b - a)).toEqual(times);
        expect(new Set(items.map((t) => t.projectId))).toEqual(new Set(["pM1", "pM2"]));
        // The session id under another project is nobody's turn.
        expect(items.map((t) => t.id)).not.toContain("xm-wrong-project");
      });

      it("pages the same order at every size", async () => {
        const all = await sqlPage(MANY, 200);
        for (const [query, size] of [
          ["", 50],
          ["?limit=1", 1],
          ["?limit=7", 7],
          ["?limit=5000", 200],
        ] as const) {
          const res = await get(`/api/runs/chat-turns${query}`, MANY);
          expect(res.status).toBe(200);
          expect((res.body.data.items as Turn[]).map((t) => t.id)).toEqual(all.slice(0, size));
        }
      });

      it("gives every listed session its whole chat spend, equal to a direct SQL sum", async () => {
        const res = await get("/api/runs/chat-turns?limit=200", MANY);
        const items = res.body.data.items as Turn[];
        const sessions = res.body.data.sessions as SessionSpend[];
        // One entry per listed session, in order of first appearance.
        expect(sessions.map((s) => s.sessionId)).toEqual([
          ...new Set(items.map((t) => t.sessionId)),
        ]);

        const sql = await sqlSessions(MANY);
        for (const s of sessions) {
          const want = sql.get(s.sessionId)!;
          expect(s.projectId).toBe(projectOf(Number(s.sessionId.slice(3))));
          expect(s.turnCount).toBe(want.turns);
          expect(s.total.calls).toBe(want.calls);
          expect(s.total.tokens.withCache).toBe(want.withCache);
          expect(s.total.costUsd).toBeCloseTo(want.cost, 10);
          expect(s.turns.calls + s.other.calls).toBe(s.total.calls);
        }
        // The newest session: its turn, plus sub-agent, apply-diff and
        // compaction rows; not the docs row, not the other project's row.
        const newest = sessions.find((s) => s.other.calls > 0)!;
        expect(newest).toMatchObject({
          turnCount: 1,
          turns: { calls: 1, tokens: { withCache: 1_500 } },
          other: { calls: 3, tokens: { withCache: 4_500 } },
          total: { calls: 4, tokens: { withCache: 6_000 } },
        });
        expect(sessions.filter((s) => s.other.calls > 0)).toHaveLength(1);
      });

      it("binds no more than a safe number of values in any statement", async () => {
        const res = await get("/api/runs/chat-turns?limit=200&from=2026-01-01&to=2027-01-01", MANY);
        expect(res.status).toBe(200);
        expect(res.body.data.items).toHaveLength(200);
        // Every session is read: one ledger statement per batch, plus the totals.
        expect(ledgerStatements).toBe(Math.ceil(SESSIONS / CHAT_TURN_SESSION_BATCH) + 1);
        const largest = Math.max(...binds);
        // A batch's ids, its project (sessions are batched project by project),
        // three steps, two dates, LIMIT and OFFSET.
        expect(largest).toBe(CHAT_TURN_SESSION_BATCH + 1 + 3 + 2 + 2);
        expect(largest).toBeLessThanOrEqual(SAFE_BINDS);
      });

      it("nor when every session of a batch is in a project of its own (the most a statement binds)", async () => {
        const page = await listChatTurns({
          userId: "uSpread",
          limit: 200,
          from: new Date("2026-01-01"),
          to: new Date("2027-01-01"),
        });
        expect(page.items).toHaveLength(200);
        expect(page.items.map((t) => t.id)).toEqual(await sqlPage("uSpread", 200));
        const largest = Math.max(...binds);
        // 400 ids, 400 projects, three steps, two dates, LIMIT and OFFSET.
        expect(largest).toBe(2 * CHAT_TURN_SESSION_BATCH + 3 + 2 + 2);
        expect(largest).toBeLessThanOrEqual(SAFE_BINDS);
        expect(largest).toBeLessThan(SQLITE_BIND_LIMIT);
      });

      it("the same holds for a caller alone in the list by session id", async () => {
        const res = await get(`/api/runs/chat-turns?sessionId=${sessionId(7)}`, MANY);
        expect(res.status).toBe(200);
        expect((res.body.data.items as Turn[]).map((t) => t.id)).toEqual(["tm-0007"]);
      });

      it("another member of the project sees none of them", async () => {
        const res = await get("/api/runs/chat-turns?limit=200", "uOther");
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ items: [], sessions: [] });
      });
    });

    describe("a caller who can reach more projects than a statement can name", () => {
      it("is listed their turns: the projects are not bound as an IN list", async () => {
        const accessibleProjectIds = [
          ...Array.from({ length: 1_500 }, (_, i) => `p-reachable-${i}`),
          "pM1",
        ];
        const page = await listChatTurns({ userId: "uDel", accessibleProjectIds });
        expect(page.items.map((t) => t.id)).toEqual(["td-deleted", "td-live"]);
        expect(Math.max(...binds)).toBeLessThanOrEqual(SAFE_BINDS);
        // …and a project outside the list is still excluded.
        const none = await listChatTurns({
          userId: "uDel",
          accessibleProjectIds: accessibleProjectIds.slice(0, 1_500),
        });
        expect(none).toEqual({ items: [], sessions: [] });
      });
    });

    describe("a chat its owner deleted", () => {
      const owner = {
        userId: "uDel",
        username: "uDel",
        role: "developer" as const,
        permissions: getPermissionsForRole("developer"),
        workspaces: ["wsM"],
      };

      it("is closed everywhere else: loadAuthorizedSession answers 404", async () => {
        await expect(loadAuthorizedSession(owner, "sd-live")).resolves.toMatchObject({
          id: "sd-live",
        });
        await expect(loadAuthorizedSession(owner, "sd-deleted")).rejects.toMatchObject({
          statusCode: 404,
        });
      });

      it("is still listed to its owner, turns and session total: it is their spend", async () => {
        const res = await get("/api/runs/chat-turns", "uDel");
        expect(res.status).toBe(200);
        expect((res.body.data.items as Turn[]).map((t) => t.id)).toEqual(["td-deleted", "td-live"]);
        const sessions = res.body.data.sessions as SessionSpend[];
        expect(sessions.map((s) => s.sessionId)).toEqual(["sd-deleted", "sd-live"]);
        expect(sessions[0]).toMatchObject({
          turnCount: 1,
          other: { calls: 1 },
          total: { calls: 2, tokens: { withCache: 3_000 } },
        });
        // Asked for by id as well.
        const byId = await get("/api/runs/chat-turns?sessionId=sd-deleted", "uDel");
        expect((byId.body.data.items as Turn[]).map((t) => t.id)).toEqual(["td-deleted"]);
      });

      it("and to nobody else", async () => {
        for (const who of [MANY, "uOther"]) {
          const res = await get("/api/runs/chat-turns?sessionId=sd-deleted", who);
          expect(res.status).toBe(200);
          expect(res.body.data.items).toEqual([]);
        }
      });
    });
  },
);
