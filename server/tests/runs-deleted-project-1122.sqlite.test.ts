/**
 * Issue #1122 — `GET /api/runs` and `GET /api/runs/chat-turns` for a project
 * that has been SOFT-DELETED, through the real router with real access tokens
 * against a real SQLite database built by the migration chain.
 *
 * The rule (the one every other project surface already applies — socket
 * rooms, scheduler, discussions, #1212/#1221/#1251): a soft-deleted project is
 * closed to non-admins and open to admins. Both lists apply it the same way:
 *   • a non-admin's unfiltered list leaves the project's rows out;
 *   • a non-admin's explicit `?projectId=` naming it answers the same 404 as a
 *     project that does not exist — not an empty 200;
 *   • an admin is unaffected: their own chat turns in it, and its runs, are
 *     still listed, filtered or not.
 *
 * Also #1122 part 2: the per-batch `createdAt desc, id desc` tie-break of the
 * chat-turn ledger read. A tie inside ONE batch that straddles its `take` cut
 * is decided by the statement, not by the in-code sort, so the `id` term is
 * what picks the right row at `limit=1` and at a page boundary.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
const { deleteProject } = await import("../src/lib/projects/project-service.js");

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1122 GET /api/runs and /api/runs/chat-turns — a soft-deleted project, real SQLite",
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
    const get = (path: string, who: string) =>
      request(app()).get(path).set("Authorization", `Bearer ${token[who]}`);
    const ids = async (path: string, who: string): Promise<string[]> => {
      const res = await get(path, who);
      expect(res.status).toBe(200);
      return (res.body.data.items as Array<{ id: string; run?: { id: string } }>).map(
        (i) => i.run?.id ?? i.id,
      );
    };
    const at = (minute: number, ms = 0) => new Date(Date.UTC(2026, 9, 9, 10, minute, 0, ms));

    async function turn(id: string, projectId: string, sessionId: string, when: Date) {
      await db.tokenUsage.create({
        data: {
          id,
          projectId,
          sessionId,
          agentStep: "chat",
          provider: "anthropic",
          model: "claude-3-5-sonnet",
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 0,
          totalTokens: 110,
          costUsd: 0.001,
          costCents: 0,
          createdAt: when,
        },
      });
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1122-runs-deleted-project");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;

      for (const id of ["uMem", "uAdm", "uTie"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@x.test` },
        });
      }
      await db.workspace.create({ data: { id: "wsD", name: "wsD", slug: "wsD" } });
      for (const userId of ["uMem", "uTie"]) {
        await db.workspaceMember.create({ data: { workspaceId: "wsD", userId } });
      }
      const project = (id: string, workspaceId?: string) =>
        db.project.create({
          data: {
            id,
            name: id,
            slug: id,
            createdById: "uMem",
            ...(workspaceId ? { workspaceId } : {}),
          },
        });
      await project("pLive", "wsD");
      await project("pGone", "wsD");
      // A legacy, workspace-less project: open to every signed-in user while live.
      await project("pGoneOpen");
      await project("pTie", "wsD");

      const session = (id: string, userId: string, projectId: string) =>
        db.aISession.create({
          data: { id, userId, projectId, provider: "anthropic", model: "claude-3-5-sonnet" },
        });
      await session("sMemLive", "uMem", "pLive");
      await session("sMemGone", "uMem", "pGone");
      await session("sMemGoneOpen", "uMem", "pGoneOpen");
      await session("sAdmGone", "uAdm", "pGone");
      await turn("t-mem-live", "pLive", "sMemLive", at(1));
      await turn("t-mem-gone", "pGone", "sMemGone", at(2));
      await turn("t-mem-gone-open", "pGoneOpen", "sMemGoneOpen", at(3));
      await turn("t-adm-gone", "pGone", "sAdmGone", at(4));

      const run = (id: string, projectId: string, minute: number) =>
        db.agentRun.create({
          data: {
            id,
            sessionId: `an-${id}`,
            projectId,
            kind: "analysis",
            status: "completed",
            startedAt: at(minute),
            completedAt: at(minute + 1),
          },
        });
      await run("rLive", "pLive", 1);
      await run("rGone", "pGone", 2);
      await run("rGoneOpen", "pGoneOpen", 3);

      // The project service's own soft delete: the sessions and ledger rows stay.
      const admin = { id: "uAdm", role: "admin" } as Parameters<typeof deleteProject>[1];
      await deleteProject("pGone", admin);
      await deleteProject("pGoneOpen", admin);

      // ── part 2: same-instant ties inside ONE batch (two sessions, one project) ──
      // Pairs a and b are written higher id first, pair c lower id first, so
      // whichever way the engine breaks a tie it is given no `id` term for, a
      // cut below takes the wrong row. (SQLite here returns the later-written
      // row first: the `limit=1` and `limit=3` cuts fail without the term.)
      await session("sTie1", "uTie", "pTie");
      await session("sTie2", "uTie", "pTie");
      await turn("tie-a-9", "pTie", "sTie1", at(30));
      await turn("tie-a-1", "pTie", "sTie2", at(30));
      await turn("tie-b-9", "pTie", "sTie2", at(20));
      await turn("tie-b-1", "pTie", "sTie1", at(20));
      await turn("tie-c-1", "pTie", "sTie1", at(15));
      await turn("tie-c-9", "pTie", "sTie2", at(15));
      await turn("tie-old", "pTie", "sTie1", at(10));

      const mk = (userId: string, role: RoleKey, workspaces: string[]) =>
        issueTokens({
          userId,
          username: userId,
          role,
          permissions: getPermissionsForRole(role),
          workspaces,
        }).accessToken;
      token.mem = mk("uMem", "developer", ["wsD"]);
      token.adm = mk("uAdm", "admin", []);
      token.tie = mk("uTie", "developer", ["wsD"]);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("the fixture's projects are soft-deleted, and their sessions and ledger rows remain", async () => {
      const gone = await db.project.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      expect(gone.map((p) => p.id)).toEqual(["pGone", "pGoneOpen"]);
      expect(await db.aISession.count({ where: { projectId: "pGone" } })).toBe(2);
      expect(await db.tokenUsage.count({ where: { projectId: "pGone" } })).toBe(2);
    });

    describe("a non-admin: a soft-deleted project is closed", () => {
      it("chat turns: the unfiltered list leaves its turns out", async () => {
        const res = await get("/api/runs/chat-turns", "mem");
        expect(res.status).toBe(200);
        expect(res.body.data.items.map((t: { id: string }) => t.id)).toEqual(["t-mem-live"]);
        expect(res.body.data.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual([
          "sMemLive",
        ]);
      });

      it("chat turns: an explicit ?projectId= of it is a 404, the body of an unknown project", async () => {
        const unknown = await get("/api/runs/chat-turns?projectId=no-such-project", "mem");
        expect(unknown.status).toBe(404);
        for (const projectId of ["pGone", "pGoneOpen"]) {
          const res = await get(`/api/runs/chat-turns?projectId=${projectId}`, "mem");
          expect(res.status).toBe(404);
          expect(res.body).toEqual(unknown.body);
        }
      });

      it("chat turns: a ?sessionId= of their own session in it surfaces nothing", async () => {
        expect(await ids("/api/runs/chat-turns?sessionId=sMemGone", "mem")).toEqual([]);
      });

      it("runs: the unfiltered list leaves its runs out", async () => {
        expect(await ids("/api/runs", "mem")).toEqual(["rLive"]);
      });

      it("runs: an explicit ?projectId= of it is a 404, the body of an unknown project", async () => {
        const unknown = await get("/api/runs?projectId=no-such-project", "mem");
        expect(unknown.status).toBe(404);
        for (const projectId of ["pGone", "pGoneOpen"]) {
          const res = await get(`/api/runs?projectId=${projectId}`, "mem");
          expect(res.status).toBe(404);
          expect(res.body).toEqual(unknown.body);
        }
      });

      it("a live project they can reach is still answered", async () => {
        expect(await ids("/api/runs/chat-turns?projectId=pLive", "mem")).toEqual(["t-mem-live"]);
        expect(await ids("/api/runs?projectId=pLive", "mem")).toEqual(["rLive"]);
      });
    });

    describe("an admin: a soft-deleted project stays open", () => {
      it("chat turns: their own turn in it is listed, filtered or not; nobody else's", async () => {
        expect(await ids("/api/runs/chat-turns", "adm")).toEqual(["t-adm-gone"]);
        expect(await ids("/api/runs/chat-turns?projectId=pGone", "adm")).toEqual(["t-adm-gone"]);
      });

      it("runs: its runs are listed, filtered or not", async () => {
        expect(await ids("/api/runs?projectId=pGone", "adm")).toEqual(["rGone"]);
        expect(await ids("/api/runs", "adm")).toEqual(
          expect.arrayContaining(["rLive", "rGone", "rGoneOpen"]),
        );
      });
    });

    describe("#1122 part 2 — a same-instant tie inside one batch is cut by id", () => {
      it("the page order, by createdAt then id, both descending", async () => {
        expect(await ids("/api/runs/chat-turns", "tie")).toEqual([
          "tie-a-9",
          "tie-a-1",
          "tie-b-9",
          "tie-b-1",
          "tie-c-9",
          "tie-c-1",
          "tie-old",
        ]);
      });

      it("limit=1 takes the higher id of the newest tie", async () => {
        expect(await ids("/api/runs/chat-turns?limit=1", "tie")).toEqual(["tie-a-9"]);
      });

      it("a page boundary inside a tie keeps the higher id", async () => {
        expect(await ids("/api/runs/chat-turns?limit=3", "tie")).toEqual([
          "tie-a-9",
          "tie-a-1",
          "tie-b-9",
        ]);
        expect(await ids("/api/runs/chat-turns?limit=5", "tie")).toEqual([
          "tie-a-9",
          "tie-a-1",
          "tie-b-9",
          "tie-b-1",
          "tie-c-9",
        ]);
      });
    });
  },
);
