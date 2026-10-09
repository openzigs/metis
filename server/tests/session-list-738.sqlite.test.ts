/**
 * #738 — `GET /api/ai/sessions` without `?status=resumable` used to answer `[]`,
 * which read as "you have no sessions" to any caller that did not know the
 * filter. It now lists the caller's sessions, newest first and paged, scoped
 * exactly like the resumable list: the caller's own sessions, narrowed to
 * project-less chats and projects they can still reach. Proven through the
 * REAL router against a REAL SQLite database built from the migration chain.
 *
 * Fixture: `u-a` belongs to `ws-a` (project "Alpha"), `u-b` to `ws-b` (project
 * "Bravo"). `u-a` owns four live sessions — one in Alpha, one project-less,
 * one stale (outside the resume window), one in Bravo (which `u-a` cannot
 * reach) — and one soft-deleted. `u-b` owns one session in Bravo.
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

const { aiSdkRouter } = await import("../src/routes/ai-sdk.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

interface Row {
  id: string;
  projectId: string | null;
  projectName: string | null;
  updatedAt: string;
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#738 — GET /api/ai/sessions lists the caller's sessions",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let A = "";
    let B = "";
    let ADMIN = "";

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/ai", aiSdkRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const get = (url: string, bearer?: string) => {
      const r = request(app()).get(url);
      return bearer ? r.set("Authorization", `Bearer ${bearer}`) : r;
    };
    const ids = (body: { data: Row[] }) => body.data.map((s) => s.id);

    beforeAll(async () => {
      sqlite = createMigratedSqlite("738-session-list");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;

      for (const id of ["u-a", "u-b", "u-admin"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      for (const [ws, user, proj, name] of [
        ["ws-a", "u-a", "proj-a", "Alpha"],
        ["ws-b", "u-b", "proj-b", "Bravo"],
      ] as const) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
        await db.workspaceMember.create({ data: { workspaceId: ws, userId: user, role: "owner" } });
        await db.project.create({
          data: { id: proj, name, slug: proj, createdById: "u-admin", workspaceId: ws },
        });
      }

      const now = Date.now();
      const minutesAgo = (m: number) => new Date(now - m * 60_000);
      const sessions: Array<{
        id: string;
        userId: string;
        projectId: string | null;
        updatedAt: Date;
        snapshotUpdatedAt: Date | null;
        deletedAt?: Date;
      }> = [
        {
          id: "s-a-alpha",
          userId: "u-a",
          projectId: "proj-a",
          updatedAt: minutesAgo(30),
          snapshotUpdatedAt: minutesAgo(30),
        },
        {
          id: "s-a-free",
          userId: "u-a",
          projectId: null,
          updatedAt: minutesAgo(5),
          snapshotUpdatedAt: minutesAgo(5),
        },
        {
          id: "s-a-stale",
          userId: "u-a",
          projectId: "proj-a",
          updatedAt: minutesAgo(60 * 24 * 10),
          snapshotUpdatedAt: null,
        },
        {
          id: "s-a-in-bravo",
          userId: "u-a",
          projectId: "proj-b",
          updatedAt: minutesAgo(1),
          snapshotUpdatedAt: minutesAgo(1),
        },
        {
          id: "s-a-deleted",
          userId: "u-a",
          projectId: null,
          updatedAt: minutesAgo(2),
          snapshotUpdatedAt: minutesAgo(2),
          deletedAt: minutesAgo(2),
        },
        {
          id: "s-b-bravo",
          userId: "u-b",
          projectId: "proj-b",
          updatedAt: minutesAgo(3),
          snapshotUpdatedAt: minutesAgo(3),
        },
      ];
      for (const s of sessions) {
        await db.aISession.create({ data: { ...s, provider: "anthropic", model: "m" } });
      }

      const token = (userId: string, role: "admin" | "coordinator", workspaces: string[]) =>
        issueTokens({ userId, username: userId, role, permissions: [], workspaces }).accessToken;
      A = token("u-a", "coordinator", ["ws-a"]);
      B = token("u-b", "coordinator", ["ws-b"]);
      ADMIN = token("u-admin", "admin", []);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("returns the caller's reachable sessions, newest activity first, with project names", async () => {
      const res = await get("/api/ai/sessions", A);
      expect(res.status).toBe(200);
      // Not the deleted one, not the one in a project u-a cannot reach, and the
      // stale one IS listed (only the resumable filter applies the window).
      expect(ids(res.body)).toEqual(["s-a-free", "s-a-alpha", "s-a-stale"]);
      const byId = new Map((res.body.data as Row[]).map((s) => [s.id, s]));
      expect(byId.get("s-a-alpha")!.projectName).toBe("Alpha");
      expect(byId.get("s-a-free")!.projectName).toBeNull();
      expect(res.body.page).toEqual({ limit: 20, offset: 0, hasMore: false });
    });

    it("never returns another user's session (cross-user)", async () => {
      const asB = await get("/api/ai/sessions", B);
      expect(asB.status).toBe(200);
      expect(ids(asB.body)).toEqual(["s-b-bravo"]);
      const asA = await get("/api/ai/sessions?limit=100", A);
      expect(ids(asA.body)).not.toContain("s-b-bravo");
    });

    it("an admin sees only their own sessions — the workspace bypass does not widen the owner", async () => {
      const res = await get("/api/ai/sessions", ADMIN);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it("pages with limit and offset, and says when more remain", async () => {
      const first = await get("/api/ai/sessions?limit=2", A);
      expect(ids(first.body)).toEqual(["s-a-free", "s-a-alpha"]);
      expect(first.body.page).toEqual({ limit: 2, offset: 0, hasMore: true });
      const second = await get("/api/ai/sessions?limit=2&offset=2", A);
      expect(ids(second.body)).toEqual(["s-a-stale"]);
      expect(second.body.page).toEqual({ limit: 2, offset: 2, hasMore: false });
    });

    it("clamps a limit past the ceiling rather than refusing it", async () => {
      const res = await get("/api/ai/sessions?limit=5000", A);
      expect(res.status).toBe(200);
      expect(res.body.page.limit).toBe(100);
    });

    it("refuses a malformed query and an unknown status filter with 400", async () => {
      expect((await get("/api/ai/sessions?limit=0", A)).status).toBe(400);
      expect((await get("/api/ai/sessions?offset=-1", A)).status).toBe(400);
      expect((await get("/api/ai/sessions?status=bogus", A)).status).toBe(400);
    });

    it("requires authentication", async () => {
      expect((await get("/api/ai/sessions")).status).toBe(401);
    });

    it("?status=resumable keeps the resume window and now carries the project name", async () => {
      const res = await get("/api/ai/sessions?status=resumable", A);
      expect(res.status).toBe(200);
      expect(ids(res.body)).toEqual(["s-a-free", "s-a-alpha"]);
      expect((res.body.data as Row[]).find((s) => s.id === "s-a-alpha")!.projectName).toBe("Alpha");
    });
  },
);
