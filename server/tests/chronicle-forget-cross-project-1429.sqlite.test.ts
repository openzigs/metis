/**
 * #1429 — `DELETE /api/projects/:id/chronicle/:entryId` deletes only an entry
 * of project `:id`.
 *
 * The router guard authorizes the project in the PATH; the entry used to be
 * looked up by its own id alone, so a caller with `project.update` on P1 could
 * delete P2's entry — another workspace's — by naming it under P1. Proven
 * through the REAL projects router, REAL auth and the REAL chronicle service
 * against a REAL SQLite database built by the migration chain. Each refusal is
 * paired with a positive control, so a route that refuses everything cannot
 * pass, and the refusal is compared with the response for an id that does not
 * exist at all, so it is no existence oracle.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole } from "@metis/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
const audit = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit }));

const { projectsRouter } = await import("../src/routes/projects.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

const USER_A = "u-a-1429";
const WS_A = "ws-a-1429";
const WS_B = "ws-b-1429";
/** A's project: A holds `project.update` on it. */
const P1 = "proj-1-1429";
/** Another workspace's project: A cannot reach it. */
const P2 = "proj-2-1429";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1429 — a chronicle entry is deleted only under its own project (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let bearer = "";

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects", projectsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const del = (projectId: string, entryId: string) =>
      request(app())
        .delete(`/api/projects/${projectId}/chronicle/${entryId}`)
        .set("Authorization", bearer);

    const entry = (projectId: string, key: string) =>
      db.chronicleEntry.create({ data: { projectId, key, value: `${key} value` } });
    const exists = async (id: string) =>
      (await db.chronicleEntry.findUnique({ where: { id } })) !== null;
    const forgets = () => audit.mock.calls.filter(([e]) => e?.action === "chronicle.forget");

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1429-chronicle-forget");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER_A, username: USER_A, displayName: USER_A, email: "a@1429.test" },
      });
      for (const ws of [WS_A, WS_B]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      await db.workspaceMember.create({
        data: { workspaceId: WS_A, userId: USER_A, role: "member" },
      });
      for (const [id, workspaceId] of [
        [P1, WS_A],
        [P2, WS_B],
      ] as const) {
        await db.project.create({
          data: {
            id,
            name: id,
            slug: id,
            createdById: USER_A,
            workspaceId,
            status: "active",
            chronicleEnabled: true,
          },
        });
      }
      // `coordinator` is the lowest role holding `project.update`, so every
      // refusal below is the entry's project scope, never the role check.
      const permissions = getPermissionsForRole("coordinator");
      expect(permissions).toContain("project.update");
      bearer = `Bearer ${
        issueTokens({
          userId: USER_A,
          username: USER_A,
          role: "coordinator",
          permissions,
          workspaces: [WS_A],
        }).accessToken
      }`;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(() => {
      audit.mockClear();
    });

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("refuses P2's entry named under P1 with a 404, and the entry survives", async () => {
      const theirs = await entry(P2, "secret-plan");
      const res = await del(P1, theirs.id);
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(res.body.error.code).toBe("CHRONICLE_NOT_FOUND");
      expect(await exists(theirs.id)).toBe(true);
      // No audit row names P1 (or P2) as the target of a delete that did not happen.
      expect(forgets()).toEqual([]);
    });

    it("answers a foreign entry exactly as it answers an id that does not exist", async () => {
      const theirs = await entry(P2, "oracle-check");
      const foreign = await del(P1, theirs.id);
      const unknown = await del(P1, "no-such-entry-1429");
      expect(foreign.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(foreign.body).toEqual(unknown.body);
    });

    it("refuses the entry under its own project too — A cannot reach P2", async () => {
      const theirs = await entry(P2, "direct");
      const res = await del(P2, theirs.id);
      expect(res.status).toBe(404);
      expect(await exists(theirs.id)).toBe(true);
    });

    it("positive control: deletes A's own entry under P1 and audits it against P1", async () => {
      const mine = await entry(P1, "stack");
      const res = await del(P1, mine.id);
      expect(res.status, JSON.stringify(res.body)).toBe(204);
      expect(await exists(mine.id)).toBe(false);
      expect(forgets()).toHaveLength(1);
      expect(forgets()[0][0].target).toEqual({ type: "project", id: P1 });
    });
  },
);
