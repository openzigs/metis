/**
 * #646 — a discussion view that reconnects re-reads the messages it may have
 * missed with `GET /discussions/threads/:id/messages?cursor=<id>`: everything
 * after the newest message it holds. The route orders oldest-first, so a plain
 * `limit` read returns the OLDEST page and recovers nothing on a thread longer
 * than one page. This pins, against a REAL SQLite database built by
 * `prisma migrate deploy`, that the existing `cursor` pages forward in
 * `createdAt` order, and that it stays scoped to the thread the caller is
 * authorized for — a cursor naming another thread's message returns no row of
 * that other thread.
 *
 * SQLite-only (a Postgres-generated client rejects the better-sqlite3 adapter);
 * the `api` CI job builds the SQLite client, so this runs on every PR.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const state = vi.hoisted(() => ({ db: null as unknown }));

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

const { discussionsRouter } = await import("../src/routes/discussions.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

/** One more message than a full page, so the thread spans two pages. */
const THREAD_LENGTH = 150;
const msgId = (n: number) => `m${String(n).padStart(3, "0")}`;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "discussion messages cursor (real SQLite) (#646)",
  () => {
    let tmpDir: string;
    let db: PrismaClient;
    // #734 — project access is the workspace seam: each user's claim names
    // the one workspace they belong to.
    const WORKSPACE_OF: Record<string, string> = { "u-alice": "ws-1", "u-mallory": "ws-2" };
    const token = (userId: string) =>
      issueTokens({
        userId,
        username: userId,
        role: "developer",
        permissions: [],
        workspaces: [WORKSPACE_OF[userId]],
      }).accessToken;

    function get(userId: string, url: string) {
      const a = express();
      a.use(express.json());
      a.use("/api/discussions", discussionsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return request(a)
        .get(url)
        .set("Authorization", `Bearer ${token(userId)}`);
    }

    beforeAll(async () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "metis-646-"));
      const dbFile = path.join(tmpDir, "threads.db");
      execFileSync(
        process.execPath,
        [
          path.join(SERVER_ROOT, "node_modules", "prisma", "build", "index.js"),
          "migrate",
          "deploy",
          "--schema",
          path.join(SERVER_ROOT, "prisma", "schema.prisma"),
        ],
        {
          cwd: SERVER_ROOT,
          env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
          stdio: "pipe",
        },
      );
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbFile}` }) });
      state.db = db;
      for (const id of ["u-alice", "u-mallory"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      // #734 — project access is by workspace membership: Alice is in ws-1
      // (p-1), Mallory in ws-2 (p-2).
      for (const [ws, userId] of [
        ["ws-1", "u-alice"],
        ["ws-2", "u-mallory"],
      ]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
        await db.workspaceMember.create({ data: { workspaceId: ws, userId } });
      }
      await db.project.create({
        data: { id: "p-1", name: "P1", slug: "p-1", createdById: "u-alice", workspaceId: "ws-1" },
      });
      await db.project.create({
        data: {
          id: "p-2",
          name: "P2",
          slug: "p-2",
          createdById: "u-mallory",
          workspaceId: "ws-2",
        },
      });
      await db.discussionThread.create({
        data: { id: "t-1", projectId: "p-1", createdById: "u-alice" },
      });
      await db.discussionThread.create({
        data: { id: "t-2", projectId: "p-2", createdById: "u-mallory" },
      });
      // Insert in REVERSE so id order and insertion order disagree with
      // createdAt order — the route must page by createdAt.
      const base = Date.UTC(2026, 0, 1);
      for (let n = THREAD_LENGTH; n >= 1; n--) {
        await db.discussionMessage.create({
          data: {
            id: msgId(n),
            threadId: "t-1",
            authorKind: "human",
            authorUserId: "u-alice",
            body: `message ${n}`,
            createdAt: new Date(base + n * 1000),
          },
        });
      }
      // Mallory's thread: one message inside t-1's time range, one after it.
      for (const [id, offset] of [
        ["x-mid", 140_500],
        ["x-new", (THREAD_LENGTH + 10) * 1000],
      ] as const) {
        await db.discussionMessage.create({
          data: {
            id,
            threadId: "t-2",
            authorKind: "human",
            authorUserId: "u-mallory",
            body: `secret ${id}`,
            createdAt: new Date(base + offset),
          },
        });
      }
    }, 120_000);

    afterAll(async () => {
      await db?.$disconnect();
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    it("a plain limit read returns the OLDEST page, so it cannot recover a newer message", async () => {
      const res = await get("u-alice", "/api/discussions/threads/t-1/messages?limit=100");
      expect(res.status).toBe(200);
      const ids = (res.body.data as Array<{ id: string }>).map((m) => m.id);
      expect(ids).toHaveLength(100);
      expect(ids[0]).toBe(msgId(1));
      expect(ids[99]).toBe(msgId(100));
      expect(res.body.nextCursor).toBe(msgId(100));
    });

    it("pages forward from a cursor in createdAt order, recovering every newer message", async () => {
      // The view holds up to m120; m121..m150 were posted while it was offline.
      const res = await get(
        "u-alice",
        `/api/discussions/threads/t-1/messages?limit=100&cursor=${msgId(120)}`,
      );
      expect(res.status).toBe(200);
      const ids = (res.body.data as Array<{ id: string }>).map((m) => m.id);
      expect(ids).toEqual(Array.from({ length: 30 }, (_, i) => msgId(121 + i)));
      expect(res.body.nextCursor).toBeNull();
    });

    it("returns nothing after the newest message", async () => {
      const res = await get(
        "u-alice",
        `/api/discussions/threads/t-1/messages?limit=100&cursor=${msgId(THREAD_LENGTH)}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it("stays scoped to the authorized thread when the cursor names another thread's message", async () => {
      const res = await get(
        "u-alice",
        "/api/discussions/threads/t-1/messages?limit=100&cursor=x-mid",
      );
      expect(res.status).toBe(200);
      // The cursor row is itself filtered by the thread scope, so a foreign
      // message is no position at all: nothing comes back — not t-2's later
      // row, and not t-1 paged from t-2's timestamp either.
      expect(res.body.data).toEqual([]);
      // ...the same answer as an id that does not exist, so no existence oracle.
      const missing = await get(
        "u-alice",
        "/api/discussions/threads/t-1/messages?limit=100&cursor=no-such-message",
      );
      expect(missing.status).toBe(200);
      expect(missing.body.data).toEqual([]);
    });

    it("refuses a caller who cannot read the thread, cursor or not", async () => {
      const res = await get(
        "u-mallory",
        `/api/discussions/threads/t-1/messages?limit=100&cursor=${msgId(120)}`,
      );
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain("message 121");
    });
  },
);
