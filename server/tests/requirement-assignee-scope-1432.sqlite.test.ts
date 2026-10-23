/**
 * #1432 — a requirement can be assigned only to an active member who can open
 * the requirement's project.
 *
 * `POST /api/requirements/:requirementId/assignments` authorized the CALLER on
 * the requirement and then upserted `body.assigneeId` unchecked. Any user id was
 * accepted, so the response's `assignee` include looked up any user's username
 * and display name across workspaces, and the SLA checker later sent that user
 * a notification carrying the requirement title.
 *
 * Pinned here, against a real SQLite database built from the migration chain,
 * through the real router, JWT auth and access rule:
 *   - a member of another workspace, a system admin who is not a member, a
 *     disabled or deleted member and an unknown id are all refused with the SAME
 *     404 body, and nothing is written;
 *   - a legacy workspace-less project keeps its open rule;
 *   - an assignment that already names an ineligible user (written before the
 *     fix, or whose assignee has since left) is listed without that user's
 *     name, and the SLA checker does not notify them;
 *   - positive controls: a workspace member is assigned, listed and notified.
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
  return { db: null as unknown, rooms: [] as string[] };
});
// A live socket server, so the checker takes every branch it has (the
// coordinator's notification is only persisted alongside its emit).
vi.mock("../src/lib/socket/registry.js", () => ({
  getSocketServer: () => ({
    to: (room: string) => {
      state.rooms.push(room);
      return { emit: () => true };
    },
  }),
}));
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

const { requirementsCollaborationRouter } = await import("../src/routes/requirements.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { runSlaCheck } = await import("../src/lib/collaboration/sla-checker.js");

const WS_A = "ws-1432-a";
const WS_B = "ws-1432-b";
const REQ_A = "req-1432-a";
const REQ_L = "req-1432-legacy";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1432 — requirement assignees are scoped to the requirement's project",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let TOKEN = "";

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/requirements", requirementsCollaborationRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const assign = (requirementId: string, assigneeId: string) =>
      request(app())
        .post(`/api/requirements/${requirementId}/assignments`)
        .set("Authorization", `Bearer ${TOKEN}`)
        .send({ assigneeId });
    const list = (requirementId: string) =>
      request(app())
        .get(`/api/requirements/${requirementId}/assignments`)
        .set("Authorization", `Bearer ${TOKEN}`);

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1432-requirement-assignee-scope");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;

      for (const id of ["alice", "bob", "mallory", "sysadm", "disabled", "gone"]) {
        await db.user.create({
          data: {
            id,
            username: `${id}-handle`,
            displayName: `${id} Display`,
            email: `${id}@x.test`,
            ...(id === "disabled" ? { status: "disabled" } : {}),
            ...(id === "gone" ? { deletedAt: new Date() } : {}),
          },
        });
      }
      const admin = await db.role.create({ data: { key: "admin", name: "Admin" } });
      await db.userRole.create({ data: { userId: "sysadm", roleId: admin.id } });
      await db.workspace.create({ data: { id: WS_A, name: WS_A, slug: WS_A } });
      await db.workspace.create({ data: { id: WS_B, name: WS_B, slug: WS_B } });
      for (const [workspaceId, userId] of [
        [WS_A, "alice"],
        [WS_A, "bob"],
        [WS_A, "disabled"],
        [WS_A, "gone"],
        [WS_B, "mallory"],
      ] as const) {
        await db.workspaceMember.create({ data: { workspaceId, userId, role: "member" } });
      }
      for (const [projectId, workspaceId, requirementId] of [
        ["p-1432-a", WS_A, REQ_A],
        ["p-1432-legacy", null, REQ_L],
      ] as const) {
        await db.project.create({
          data: {
            id: projectId,
            name: projectId,
            slug: projectId,
            createdById: "alice",
            ...(workspaceId ? { workspaceId } : {}),
          },
        });
        await db.analysis.create({
          data: { id: `an-${projectId}`, projectId, startedById: "alice" },
        });
        await db.requirement.create({
          data: {
            id: requirementId,
            projectId,
            analysisId: `an-${projectId}`,
            title: `Secret title ${requirementId}`,
            body: "b",
          },
        });
      }
      TOKEN = issueTokens({
        userId: "alice",
        username: "alice",
        role: "coordinator",
        permissions: getPermissionsForRole("coordinator"),
        workspaces: [WS_A],
      }).accessToken;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(async () => {
      await db.assignment.deleteMany({});
      await db.notification.deleteMany({});
    });

    describe("POST /:requirementId/assignments", () => {
      it("refuses every ineligible assignee with the unknown-user 404 and writes nothing", async () => {
        const unknown = await assign(REQ_A, "u-nope");
        expect(unknown.status).toBe(404);

        for (const assigneeId of ["mallory", "sysadm", "disabled", "gone"]) {
          const res = await assign(REQ_A, assigneeId);
          expect({ assigneeId, status: res.status }).toEqual({ assigneeId, status: 404 });
          expect(res.body).toEqual(unknown.body);
          expect(JSON.stringify(res.body)).not.toContain(`${assigneeId}-handle`);
        }
        expect(await db.assignment.count()).toBe(0);
      });

      it("positive control: assigns an active member of the project's workspace", async () => {
        const res = await assign(REQ_A, "bob");
        expect(res.status).toBe(201);
        expect(res.body.data.assignee).toEqual({
          id: "bob",
          username: "bob-handle",
          displayName: "bob Display",
        });
        expect(await db.assignment.count()).toBe(1);
      });

      it("a legacy workspace-less project keeps its open rule: any active user", async () => {
        expect((await assign(REQ_L, "mallory")).status).toBe(201);
        expect((await assign(REQ_L, "disabled")).status).toBe(404);
      });
    });

    describe("rows naming an ineligible assignee (pre-fix, or since left)", () => {
      beforeEach(async () => {
        const overdue = new Date(Date.now() - 60_000);
        for (const assigneeId of ["bob", "mallory"]) {
          await db.assignment.create({
            data: { requirementId: REQ_A, assigneeId, assignedById: "alice", slaDeadline: overdue },
          });
        }
      });

      it("GET lists the row without the ineligible assignee's name", async () => {
        const res = await list(REQ_A);
        expect(res.status).toBe(200);
        const byId = Object.fromEntries(
          (res.body.data as Array<{ assigneeId: string; assignee: unknown }>).map((a) => [
            a.assigneeId,
            a.assignee,
          ]),
        );
        expect(byId.bob).toEqual({ id: "bob", username: "bob-handle", displayName: "bob Display" });
        expect(byId.mallory).toEqual({ id: "mallory", username: null, displayName: null });
        expect(JSON.stringify(res.body)).not.toContain("mallory-handle");
      });

      it("the SLA checker notifies the member and not the outsider, and marks both handled", async () => {
        state.rooms.length = 0;
        await runSlaCheck();

        expect(state.rooms).not.toContain("user:mallory");
        expect(state.rooms).toContain("user:bob");
        const notified = await db.notification.findMany({ select: { userId: true } });
        const recipients = notified.map((n) => n.userId).sort();
        expect(recipients).not.toContain("mallory");
        // bob (assignee) and alice (the project's creator, once per overdue row).
        expect(recipients).toEqual(["alice", "alice", "bob"]);
        expect(await db.assignment.count({ where: { notifiedAt: null } })).toBe(0);
      });
    });
  },
);
