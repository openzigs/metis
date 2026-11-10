/**
 * #2203 — the discussion requirement picker and the thread list, against a REAL
 * SQLite database built by `prisma migrate deploy`. The route suite mocks
 * Prisma, so it cannot tell whether the relation filters and the paged scan do
 * what they say. This pins that:
 *
 * - a requirement behind more than 500 newer ones can still be found and
 *   attached (#2203: the first scan stopped at one 500-row page);
 * - #2209: the title match runs in SQL — case-insensitive, with the term's own
 *   `%`, `_` and `!` matched literally, at most 20 newest first;
 * - #2218: the match folds case beyond ASCII ("über" finds "Über …"), which
 *   SQLite's own `LOWER()` / `LIKE` do not, and GLOB's `*`, `?` and `[` in a
 *   term match literally;
 * - a requirement whose analysis is soft-deleted is hidden by the picker,
 *   refused as an anchor, and reported as no requirement by GET /threads, so
 *   the three agree.
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
    resolveDatabaseProvider: () => "sqlite",
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { discussionsRouter } = await import("../src/routes/discussions.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

/** More than one 500-row page of newer requirements in front of the old one. */
const NEWER = 510;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "discussion requirement picker (real SQLite) (#2203)",
  () => {
    let tmpDir: string;
    let db: PrismaClient;
    const token = issueTokens({
      userId: "u-alice",
      username: "u-alice",
      role: "developer",
      permissions: [],
      workspaces: ["ws-1"],
    }).accessToken;

    function app() {
      const a = express();
      a.use(express.json());
      a.use("/api/discussions", discussionsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    }
    const get = (url: string) => request(app()).get(url).set("Authorization", `Bearer ${token}`);

    beforeAll(async () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "metis-2203-"));
      const dbFile = path.join(tmpDir, "picker.db");
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
      await db.user.create({
        data: { id: "u-alice", username: "u-alice", displayName: "Alice", email: "a@example.test" },
      });
      await db.workspace.create({ data: { id: "ws-1", name: "ws-1", slug: "ws-1" } });
      await db.workspaceMember.create({ data: { workspaceId: "ws-1", userId: "u-alice" } });
      await db.project.create({
        data: { id: "p-1", name: "P1", slug: "p-1", createdById: "u-alice", workspaceId: "ws-1" },
      });
      await db.analysis.create({ data: { id: "a-live", projectId: "p-1" } });
      // #2209 — another project's requirement with a matching title is never offered.
      await db.project.create({
        data: { id: "p-2", name: "P2", slug: "p-2", createdById: "u-alice", workspaceId: "ws-1" },
      });
      await db.analysis.create({ data: { id: "a-other", projectId: "p-2" } });
      await db.requirement.create({
        data: {
          id: "r-other-project",
          projectId: "p-2",
          analysisId: "a-other",
          title: "Refresh feeds in another project",
          body: "b",
        },
      });
      // …nor a soft-deleted one of this project's.
      await db.requirement.create({
        data: {
          id: "r-deleted",
          projectId: "p-1",
          analysisId: "a-live",
          title: "Refresh feeds, removed",
          body: "b",
          deletedAt: new Date(),
        },
      });
      await db.analysis.create({
        data: { id: "a-gone", projectId: "p-1", deletedAt: new Date() },
      });

      const base = Date.UTC(2026, 0, 1);
      await db.requirement.create({
        data: {
          id: "r-old",
          projectId: "p-1",
          analysisId: "a-live",
          title: "Refresh feeds on a schedule",
          body: "b",
          createdAt: new Date(base),
        },
      });
      await db.requirement.createMany({
        data: Array.from({ length: NEWER }, (_, i) => ({
          id: `r-new-${String(i).padStart(3, "0")}`,
          projectId: "p-1",
          analysisId: "a-live",
          title: `Filler requirement ${i}`,
          body: "b",
          createdAt: new Date(base + (i + 1) * 1000),
        })),
      });
      // Newest of all, but its run is soft-deleted while the row itself is not.
      await db.requirement.create({
        data: {
          id: "r-gone-run",
          projectId: "p-1",
          analysisId: "a-gone",
          title: "Refresh feeds in a deleted run",
          body: "b",
          createdAt: new Date(base + (NEWER + 5) * 1000),
        },
      });
      // #2209 — titles holding the LIKE wildcards and the escape character,
      // older than everything above so the newest-20 listing is unchanged.
      await db.requirement.createMany({
        data: [
          ["r-pct", "Hit 100% of feeds"],
          ["r-under", "Store read_at per entry"],
          ["r-bang", "Warn me! before purging"],
          // #2218 — a non-ASCII capital, and GLOB's own wildcards.
          ["r-umlaut", "Über-Zeitplan für Abrufe"],
          ["r-glob", "Mark [draft]? entries as *done*"],
        ].map(([id, title], i) => ({
          id,
          projectId: "p-1",
          analysisId: "a-live",
          title,
          body: "b",
          createdAt: new Date(base - (i + 1) * 1000),
        })),
      });
      // A thread attached before the run was deleted.
      await db.discussionThread.create({
        data: {
          id: "t-gone",
          projectId: "p-1",
          createdById: "u-alice",
          requirementId: "r-gone-run",
        },
      });
      await db.discussionThread.create({
        data: { id: "t-old", projectId: "p-1", createdById: "u-alice", requirementId: "r-old" },
      });
    }, 120_000);

    afterAll(async () => {
      await db?.$disconnect();
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    it("finds a requirement older than the first 500-row page", async () => {
      const res = await get("/api/discussions/requirements?projectId=p-1&q=REFRESH%20feeds");
      expect(res.status).toBe(200);
      expect(res.body.data.map((r: { id: string }) => r.id)).toEqual(["r-old"]);
    });

    it("matches the term's %, _ and ! literally, not as wildcards (#2209)", async () => {
      const ids = async (q: string) =>
        (
          await get(`/api/discussions/requirements?projectId=p-1&q=${encodeURIComponent(q)}`)
        ).body.data.map((r: { id: string }) => r.id);
      expect(await ids("%")).toEqual(["r-pct"]);
      expect(await ids("d_a")).toEqual(["r-under"]);
      expect(await ids("me!")).toEqual(["r-bang"]);
      expect(await ids("no such title")).toEqual([]);
    });

    it("folds case beyond ASCII, which SQLite's LOWER and LIKE do not (#2218)", async () => {
      const ids = async (q: string) =>
        (
          await get(`/api/discussions/requirements?projectId=p-1&q=${encodeURIComponent(q)}`)
        ).body.data.map((r: { id: string }) => r.id);
      expect(await ids("über")).toEqual(["r-umlaut"]);
      expect(await ids("ÜBER-ZEITPLAN FÜR")).toEqual(["r-umlaut"]);
      expect(await ids("fur")).toEqual([]);
    });

    it("matches GLOB's *, ? and [ in a term literally (#2218)", async () => {
      const ids = async (q: string) =>
        (
          await get(`/api/discussions/requirements?projectId=p-1&q=${encodeURIComponent(q)}`)
        ).body.data.map((r: { id: string }) => r.id);
      expect(await ids("[DRAFT]?")).toEqual(["r-glob"]);
      expect(await ids("*")).toEqual(["r-glob"]);
      expect(await ids("?")).toEqual(["r-glob"]);
      expect(await ids("[d")).toEqual(["r-glob"]);
      expect(await ids("T]")).toEqual(["r-glob"]);
    });

    it("answers at most 20 matches, newest first, none from a soft-deleted run (#2209)", async () => {
      const res = await get("/api/discussions/requirements?projectId=p-1&q=%20FILLER%20");
      const ids = res.body.data.map((r: { id: string }) => r.id);
      expect(ids).toEqual(
        Array.from({ length: 20 }, (_, i) => `r-new-${String(NEWER - 1 - i).padStart(3, "0")}`),
      );
      expect(res.body.data[0]).toEqual({
        id: `r-new-${NEWER - 1}`,
        title: `Filler requirement ${NEWER - 1}`,
        analysisId: "a-live",
        createdAt: new Date(Date.UTC(2026, 0, 1) + NEWER * 1000).toISOString(),
      });
      const deleted = await get("/api/discussions/requirements?projectId=p-1&q=deleted%20run");
      expect(deleted.body.data).toEqual([]);
    });

    it("lists the newest 20 live requirements, none from a soft-deleted run", async () => {
      const res = await get("/api/discussions/requirements?projectId=p-1");
      const ids = res.body.data.map((r: { id: string }) => r.id);
      expect(ids).toHaveLength(20);
      expect(ids[0]).toBe(`r-new-${NEWER - 1}`);
      expect(ids).not.toContain("r-gone-run");
    });

    it("refuses an anchor to a requirement in a soft-deleted run, accepts the old one", async () => {
      const bad = await request(app())
        .post("/api/discussions/threads")
        .set("Authorization", `Bearer ${token}`)
        .send({ projectId: "p-1", anchor: { requirementId: "r-gone-run" } });
      expect(bad.status).toBe(400);

      const ok = await request(app())
        .post("/api/discussions/threads")
        .set("Authorization", `Bearer ${token}`)
        .send({ projectId: "p-1", anchor: { requirementId: "r-old" } });
      expect(ok.status).toBe(201);
      expect(ok.body.data.requirementId).toBe("r-old");
    });

    it("reports a requirement in a soft-deleted run as none in the thread list", async () => {
      const res = await get("/api/discussions/threads?projectId=p-1");
      const byId = new Map(
        (res.body.data as Array<{ id: string; requirement: unknown }>).map((t) => [t.id, t]),
      );
      expect(byId.get("t-gone")?.requirement).toBeNull();
      expect(byId.get("t-old")?.requirement).toEqual({
        id: "r-old",
        title: "Refresh feeds on a schedule",
        analysisId: "a-live",
      });
    });
  },
);
