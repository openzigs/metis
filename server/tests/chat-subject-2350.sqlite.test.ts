/**
 * #2350 — "Ask about this": `GET /api/ai/chat-subjects/:kind/:id` names the
 * project, change request or requirement a chat is opened from, and the project
 * the chat is scoped to — for an item the caller can read, and for nothing else.
 * Proven through the REAL router against a REAL SQLite database built from the
 * migration chain. Also the history list's scope fields (`GET /api/ai/sessions`).
 *
 * Fixture: `u-a` belongs to `ws-a` (project "Alpha"), `u-b` to `ws-b` (project
 * "Bravo"). Each project holds one change request with one requirement; Alpha
 * also holds a deleted change request, a deleted requirement, and a change
 * request with no stored title (not yet backfilled).
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

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2350 — GET /api/ai/chat-subjects/:kind/:id",
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

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2350-chat-subject");
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
      await db.project.create({
        data: {
          id: "proj-gone",
          name: "Gone",
          slug: "proj-gone",
          createdById: "u-admin",
          workspaceId: "ws-a",
          deletedAt: new Date(),
        },
      });

      const runs: Array<{
        id: string;
        projectId: string;
        title: string | null;
        deleted?: boolean;
      }> = [
        { id: "cr-a", projectId: "proj-a", title: "Checkout v2" },
        { id: "cr-a-untitled", projectId: "proj-a", title: null },
        { id: "cr-a-deleted", projectId: "proj-a", title: "Old", deleted: true },
        { id: "cr-b", projectId: "proj-b", title: "Bravo refunds" },
      ];
      for (const r of runs) {
        await db.analysis.create({
          data: {
            id: r.id,
            projectId: r.projectId,
            status: "completed",
            title: r.title,
            startedAt: new Date("2026-11-01T10:00:00Z"),
            ...(r.deleted ? { deletedAt: new Date() } : {}),
          },
        });
      }
      const reqs: Array<[string, string, string, string, boolean?]> = [
        ["req-a", "proj-a", "cr-a", "Pay by card"],
        ["req-a-deleted", "proj-a", "cr-a", "Gone requirement", true],
        ["req-a-in-deleted-cr", "proj-a", "cr-a-deleted", "Orphan"],
        ["req-b", "proj-b", "cr-b", "Refund within 30 days"],
      ];
      for (const [id, projectId, analysisId, title, deleted] of reqs) {
        await db.requirement.create({
          data: {
            id,
            projectId,
            analysisId,
            title,
            body: `${title} body`,
            ...(deleted ? { deletedAt: new Date() } : {}),
          },
        });
      }

      await db.aISession.create({
        data: {
          id: "s-multi",
          userId: "u-a",
          projectId: null,
          scopeProjectIds: JSON.stringify(["proj-a", "proj-b"]),
          provider: "anthropic",
          model: "m",
        },
      });
      await db.aISession.create({
        data: {
          id: "s-ws",
          userId: "u-a",
          projectId: null,
          scopeWorkspaceId: "ws-a",
          provider: "anthropic",
          model: "m",
        },
      });

      const token = (userId: string, role: string, workspaces: string[]) =>
        issueTokens({
          userId,
          username: userId,
          role: role as "admin",
          permissions: [],
          workspaces,
        }).accessToken;
      A = token("u-a", "developer", ["ws-a"]);
      B = token("u-b", "reader", ["ws-b"]);
      ADMIN = token("u-admin", "admin", []);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("names a project the caller can reach", async () => {
      const res = await get("/api/ai/chat-subjects/project/proj-a", A);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        kind: "project",
        id: "proj-a",
        projectId: "proj-a",
        projectName: "Alpha",
        title: "Alpha",
        changeRequestTitle: null,
      });
    });

    it("names a change request and the project that holds it", async () => {
      const res = await get("/api/ai/chat-subjects/change-request/cr-a", A);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        kind: "change-request",
        id: "cr-a",
        projectId: "proj-a",
        projectName: "Alpha",
        title: "Checkout v2",
        changeRequestTitle: null,
      });
    });

    it("gives a change request with no stored title the title its page generates", async () => {
      const res = await get("/api/ai/chat-subjects/change-request/cr-a-untitled", A);
      expect(res.status).toBe(200);
      expect(res.body.data.title).toEqual(expect.any(String));
      expect(res.body.data.title.length).toBeGreaterThan(0);
    });

    it("names a requirement with its change request and project", async () => {
      const res = await get("/api/ai/chat-subjects/requirement/req-b", B);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        kind: "requirement",
        id: "req-b",
        projectId: "proj-b",
        projectName: "Bravo",
        title: "Refund within 30 days",
        changeRequestTitle: "Bravo refunds",
      });
    });

    // The acceptance criterion: an item the caller cannot read is refused by
    // the server, with the same 404 an unknown id gets.
    it.each([
      ["project", "proj-b"],
      ["change-request", "cr-b"],
      ["requirement", "req-b"],
    ])("refuses another workspace's %s with the one 404", async (kind, id) => {
      const res = await get(`/api/ai/chat-subjects/${kind}/${id}`, A);
      expect(res.status).toBe(404);
      const unknown = await get(`/api/ai/chat-subjects/${kind}/no-such-id`, A);
      expect(unknown.status).toBe(404);
      expect(res.body.error).toEqual(unknown.body.error);
    });

    it.each([
      ["project", "proj-gone"],
      ["change-request", "cr-a-deleted"],
      ["requirement", "req-a-deleted"],
      ["requirement", "req-a-in-deleted-cr"],
    ])("refuses a deleted %s (%s) with 404", async (kind, id) => {
      expect((await get(`/api/ai/chat-subjects/${kind}/${id}`, A)).status).toBe(404);
    });

    it("lets an admin name an item in any workspace", async () => {
      const res = await get("/api/ai/chat-subjects/requirement/req-a", ADMIN);
      expect(res.status).toBe(200);
      expect(res.body.data.changeRequestTitle).toBe("Checkout v2");
    });

    it("refuses a change request or requirement to a role without analysis.read", async () => {
      const guest = issueTokens({
        userId: "u-a",
        username: "u-a",
        role: "guest" as "admin",
        permissions: [],
        workspaces: ["ws-a"],
      }).accessToken;
      expect((await get("/api/ai/chat-subjects/change-request/cr-a", guest)).status).toBe(403);
      expect((await get("/api/ai/chat-subjects/requirement/req-a", guest)).status).toBe(403);
    });

    it("refuses an unknown kind and an over-long id with 400", async () => {
      expect((await get("/api/ai/chat-subjects/workspace/ws-a", A)).status).toBe(400);
      expect((await get(`/api/ai/chat-subjects/project/${"x".repeat(121)}`, A)).status).toBe(400);
    });

    it("requires authentication", async () => {
      expect((await get("/api/ai/chat-subjects/project/proj-a")).status).toBe(401);
    });

    it("the history list carries a multi-product or workspace chat's scope", async () => {
      const res = await get("/api/ai/sessions", A);
      expect(res.status).toBe(200);
      const byId = new Map(
        (
          res.body.data as Array<{
            id: string;
            scopeProjectIds: string[] | null;
            scopeWorkspaceId: string | null;
          }>
        ).map((s) => [s.id, s]),
      );
      expect(byId.get("s-multi")).toMatchObject({
        scopeProjectIds: ["proj-a", "proj-b"],
        scopeWorkspaceId: null,
      });
      expect(byId.get("s-ws")).toMatchObject({ scopeProjectIds: null, scopeWorkspaceId: "ws-a" });
    });
  },
);
