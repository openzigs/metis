/**
 * #1137 — the gap report and the current-vs-proposed diff are paged, so their
 * order must be total and stable, and a page must never repeat or skip a
 * requirement. Through the real routes against a real SQLite database:
 *
 *  - requirements created in the same millisecond, inserted out of id order,
 *    come back in (createdAt, id) order on both lists;
 *  - walking every page yields each live requirement exactly once;
 *  - a soft-deleted requirement is not in the gap report, matching the
 *    per-requirement database-changes route, which 404s it.
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
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: vi.fn(),
}));

const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const WS = "ws-1137-paging";
const PROJECT = "proj-1137-paging";
const USER = "u-1137-paging";
const BASE = "ana-1137-base";
const HEAD = "ana-1137-head";
const DELETED = "req-h-deleted";
// Inserted in this (non-sorted) order, all with one createdAt.
const HEAD_IDS = [
  "req-h-07",
  "req-h-02",
  "req-h-11",
  "req-h-01",
  "req-h-13",
  "req-h-05",
  "req-h-09",
  "req-h-03",
  "req-h-12",
  "req-h-06",
  "req-h-10",
  "req-h-04",
  "req-h-08",
];
const SORTED = [...HEAD_IDS].sort();
const PAGE_SIZE = 5;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1137 — paged gap report and diff: total order, disjoint and complete pages, live rows only",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let TOKEN = "";

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId/analyses", initAnalysisRouter().projectScoped);
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const get = (path: string) =>
      request(app())
        .get(`/api/projects/${PROJECT}/analyses/${HEAD}${path}`)
        .set("Authorization", `Bearer ${TOKEN}`);

    /** Every page, in order, as lists of requirement ids. */
    const walk = async (
      path: string,
      idsOf: (data: Record<string, unknown>) => string[],
    ): Promise<{ pages: string[][]; total: number }> => {
      const pages: string[][] = [];
      let total = 0;
      for (let page = 1; page <= 10; page++) {
        const sep = path.includes("?") ? "&" : "?";
        const res = await get(`${path}${sep}page=${page}&pageSize=${PAGE_SIZE}`);
        expect(res.status).toBe(200);
        const data = res.body.data as Record<string, unknown> & {
          page: { page: number; total: number };
        };
        total = data.page.total;
        if (data.page.page !== page) break; // clamped: past the last page
        pages.push(idsOf(data));
      }
      return { pages, total };
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1137-traceability-paging");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@example.test` },
      });
      await db.workspace.create({ data: { id: WS, name: "ws", slug: WS } });
      await db.workspaceMember.create({ data: { workspaceId: WS, userId: USER, role: "owner" } });
      await db.project.create({
        data: { id: PROJECT, name: PROJECT, slug: PROJECT, createdById: USER, workspaceId: WS },
      });
      await db.analysis.create({
        data: {
          id: BASE,
          projectId: PROJECT,
          startedById: USER,
          status: "completed",
          startedAt: new Date("2026-10-01T00:00:00Z"),
        },
      });
      await db.analysis.create({
        data: {
          id: HEAD,
          projectId: PROJECT,
          startedById: USER,
          status: "completed",
          startedAt: new Date("2026-10-02T00:00:00Z"),
        },
      });
      const createdAt = new Date("2026-10-02T00:00:01Z");
      for (const id of HEAD_IDS) {
        await db.requirement.create({
          data: {
            id,
            projectId: PROJECT,
            analysisId: HEAD,
            title: `Distinct requirement ${id}`,
            body: `Body for ${id}.`,
            createdAt,
          },
        });
      }
      await db.requirement.create({
        data: {
          id: DELETED,
          projectId: PROJECT,
          analysisId: HEAD,
          title: "Deleted requirement",
          body: "Gone.",
          createdAt,
          deletedAt: new Date(),
        },
      });
      TOKEN = issueTokens({
        userId: USER,
        username: USER,
        role: "admin",
        permissions: [],
        workspaces: [WS],
      }).accessToken;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    const expectDisjointAndComplete = (pages: string[][]) => {
      const flat = pages.flat();
      expect(new Set(flat).size).toBe(flat.length); // no requirement on two pages
      expect(flat).toEqual(SORTED); // every live one, in (createdAt, id) order
      expect(pages.map((p) => p.length)).toEqual([5, 5, 3]);
    };

    it("gap report: pages are disjoint, complete, in (createdAt, id) order, without the deleted row", async () => {
      const { pages, total } = await walk("/gap-report", (data) =>
        (data.requirements as { requirementId: string }[]).map((r) => r.requirementId),
      );
      expect(total).toBe(HEAD_IDS.length);
      expectDisjointAndComplete(pages);
    });

    it("requirement diff: pages are disjoint, complete and in (createdAt, id) order", async () => {
      const { pages, total } = await walk(`/requirement-diff?base=${BASE}`, (data) =>
        (data.entries as { proposed: { requirementId: string } | null }[]).map(
          (e) => e.proposed!.requirementId,
        ),
      );
      expect(total).toBe(HEAD_IDS.length);
      expectDisjointAndComplete(pages);
    });

    it("the deleted requirement's database changes 404, as its absence from the report implies", async () => {
      const res = await get(`/gap-report/requirements/${DELETED}/database-changes`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("REQUIREMENT_NOT_FOUND");
    });
  },
);
