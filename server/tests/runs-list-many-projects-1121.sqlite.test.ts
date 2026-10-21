/**
 * Issue #1121 — `GET /api/runs` for a non-admin who can reach more projects
 * than one SQLite statement can name, through the REAL router against a REAL
 * SQLite database built by the migration chain.
 *
 * Prisma's better-sqlite3 adapter takes 999 bound values a statement and does
 * not split a read that has an `orderBy` or a `take` (P2029). The list bound
 * `projectId IN (every reachable project)` in one ordered, paged read, so a
 * member who could reach about 995 projects was answered 500.
 *
 * What it pins:
 *   • 1,100 reachable projects answer 200 — the premise, failing before the fix;
 *   • the page is the one a single SQL statement gives (newest first, ties by
 *     id), at every page size, though it is assembled from several statements;
 *   • no statement binds more than 900 values;
 *   • scope is unchanged: a project in someone else's workspace, a deleted
 *     project and a project-less (system) run are still not listed, and an
 *     explicit `?projectId=` still narrows to that one project.
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

const SQLITE_BIND_LIMIT = 999;
const SAFE_BINDS = 900;

/** Workspace-less projects are open to every signed-in non-admin. */
const PROJECTS = 1_100;
const RUNS = 600;
const pad = (n: number) => String(n).padStart(4, "0");
const projectId = (i: number) => `po-${pad(i)}`;
/** Run `i` is in project `(i * 37) % PROJECTS`, so a page spans many batches. */
const projectOf = (i: number) => projectId((i * 37) % PROJECTS);
/** A permutation of the run's start second (599 + 1 = 600; 7 is coprime). */
const second = (i: number) => (i * 7) % RUNS;
const at = (s: number) => new Date(Date.UTC(2026, 9, 9, 10, 0, 0) + s * 1_000);

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1121 GET /api/runs — a member who can reach more projects than a statement can name",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const token: Record<string, string> = {};
    let binds: number[] = [];

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/runs", runsRouter());
      a.use(errorHandler);
      return a;
    };
    const get = (path: string, who: string) =>
      request(app()).get(path).set("Authorization", `Bearer ${token[who]}`);

    /** The page one statement over every run gives, scoped like the route. */
    async function sqlPage(limit: number): Promise<string[]> {
      const rows = await db.$queryRaw<Array<{ id: string }>>`
        SELECT r."id" FROM "agent_runs" r
        WHERE r."projectId" IN (
          SELECT p."id" FROM "projects" p
          WHERE p."deletedAt" IS NULL AND (p."workspaceId" IS NULL OR p."workspaceId" = 'wsMine'))
        ORDER BY r."startedAt" DESC, r."id" DESC
        LIMIT ${limit}`;
      return rows.map((r) => r.id);
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1121-runs-many-projects");
      db = new PrismaClient({
        adapter: new PrismaBetterSqlite3({ url: sqlite.url }),
        log: [{ emit: "event", level: "query" }],
      });
      (
        db as unknown as {
          $on(event: "query", cb: (e: { params: string }) => void): void;
        }
      ).$on("query", (e) => {
        binds.push((JSON.parse(e.params) as unknown[]).length);
      });
      state.db = db;

      for (const id of ["uMember", "uStranger"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@x.test` },
        });
      }
      await db.workspace.create({ data: { id: "wsMine", name: "wsMine", slug: "wsMine" } });
      await db.workspace.create({ data: { id: "wsTheirs", name: "wsTheirs", slug: "wsTheirs" } });
      await db.workspaceMember.create({ data: { workspaceId: "wsMine", userId: "uMember" } });
      await db.workspaceMember.create({ data: { workspaceId: "wsTheirs", userId: "uStranger" } });

      const index = (n: number) => Array.from({ length: n }, (_, i) => i);
      const chunks = <T>(items: T[], size: number) =>
        Array.from({ length: Math.ceil(items.length / size) }, (_, n) =>
          items.slice(n * size, (n + 1) * size),
        );
      for (const part of chunks(index(PROJECTS), 100)) {
        await db.project.createMany({
          data: part.map((i) => ({
            id: projectId(i),
            name: projectId(i),
            slug: projectId(i),
            createdById: "uStranger",
          })),
        });
      }
      await db.project.createMany({
        data: [
          {
            id: "p-mine",
            name: "p-mine",
            slug: "p-mine",
            createdById: "uMember",
            workspaceId: "wsMine",
          },
          {
            id: "p-theirs",
            name: "p-theirs",
            slug: "p-theirs",
            createdById: "uStranger",
            workspaceId: "wsTheirs",
          },
          {
            id: "p-deleted",
            name: "p-deleted",
            slug: "p-deleted",
            createdById: "uMember",
            deletedAt: at(0),
          },
        ],
      });

      for (const part of chunks(index(RUNS), 100)) {
        await db.agentRun.createMany({
          data: part.map((i) => ({
            id: `run-${pad(i)}`,
            sessionId: `s-${pad(i)}`,
            projectId: projectOf(i),
            kind: "chat",
            status: "completed",
            startedAt: at(second(i)),
            completedAt: at(second(i) + 1),
          })),
        });
      }
      // Newer than every run above: none may be listed to uMember…
      await db.agentRun.createMany({
        data: [
          { id: "x-theirs", sessionId: "sx1", projectId: "p-theirs", startedAt: at(RUNS + 10) },
          { id: "x-deleted", sessionId: "sx2", projectId: "p-deleted", startedAt: at(RUNS + 11) },
          { id: "x-system", sessionId: "sx3", projectId: null, startedAt: at(RUNS + 12) },
          // …and this one is: their own workspace's project, and rows written in
          // the same instant as it in other batches, so the merge needs the id order.
          { id: "y-mine", sessionId: "sy1", projectId: "p-mine", startedAt: at(RUNS + 5) },
          { id: "y-tie-a", sessionId: "sy2", projectId: projectId(3), startedAt: at(RUNS + 5) },
          { id: "y-tie-z", sessionId: "sy3", projectId: projectId(1_050), startedAt: at(RUNS + 5) },
        ],
      });

      token.uMember = issueTokens({
        userId: "uMember",
        username: "uMember",
        role: "developer",
        permissions: getPermissionsForRole("developer"),
        workspaces: ["wsMine"],
      }).accessToken;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      binds = [];
    });

    it("the fixture reaches more projects than one statement can name", async () => {
      const reachable = await db.project.count({
        where: { deletedAt: null, OR: [{ workspaceId: null }, { workspaceId: "wsMine" }] },
      });
      expect(reachable).toBe(PROJECTS + 1);
      expect(reachable).toBeGreaterThan(SQLITE_BIND_LIMIT);
    });

    it("answers 200 with the page one SQL statement gives", async () => {
      const res = await get("/api/runs?limit=200", "uMember");
      expect(res.status).toBe(200);
      const ids = (res.body.data.items as Array<{ id: string }>).map((r) => r.id);
      const expected = await sqlPage(200);
      expect(expected).toHaveLength(200);
      expect(ids).toEqual(expected);
      // The three runs of the newest instant lead, by id descending, from three batches.
      expect(ids.slice(0, 3)).toEqual(["y-tie-z", "y-tie-a", "y-mine"]);
      for (const hidden of ["x-theirs", "x-deleted", "x-system"]) expect(ids).not.toContain(hidden);
    });

    it("pages the same order at every size", async () => {
      const all = await sqlPage(200);
      for (const [query, size] of [
        ["", 50],
        ["?limit=1", 1],
        ["?limit=7", 7],
        ["?limit=5000", 200],
      ] as const) {
        const res = await get(`/api/runs${query}`, "uMember");
        expect(res.status).toBe(200);
        expect((res.body.data.items as Array<{ id: string }>).map((r) => r.id)).toEqual(
          all.slice(0, size),
        );
      }
    });

    it("binds no more than a safe number of values in any statement", async () => {
      const res = await get("/api/runs?limit=200&from=2026-01-01&to=2027-01-01", "uMember");
      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(200);
      expect(Math.max(...binds)).toBeLessThanOrEqual(SAFE_BINDS);
    });

    it("an explicit project still narrows the list to that project", async () => {
      const res = await get(`/api/runs?projectId=${projectId(3)}`, "uMember");
      expect(res.status).toBe(200);
      const ids = (res.body.data.items as Array<{ id: string; projectId: string }>).map(
        (r) => r.projectId,
      );
      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids)).toEqual(new Set([projectId(3)]));
      // A project outside the caller's reach is still a 404.
      expect((await get("/api/runs?projectId=p-theirs", "uMember")).status).toBe(404);
    });
  },
);
