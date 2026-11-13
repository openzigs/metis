/**
 * #2394 — `review:changed` reaches an assigned reviewer's own `user:{id}` room
 * (#2370) only while that reviewer can still open the review's project.
 *
 * A reviewer removed from the workspace, or any non-admin once the project or
 * its workspace is soft-deleted, stays an assignee of the review, but is no
 * longer sent the event. System admins open every project, deleted ones
 * included, and a legacy project with no workspace is open to everyone — the
 * project-access rule (`assertLiveProjectAccess`).
 *
 * Proven through the real emitter against a real SQLite database built from
 * the migration chain; only the socket server is a fake.
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
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    resolveDatabaseProvider: () => "sqlite" as const,
    Prisma,
  };
});
const emit = vi.fn();
const to = vi.fn((_rooms: string | string[]) => ({ emit, except: () => ({ emit }) }));
vi.mock("../src/lib/socket/registry.js", () => ({ getSocketServer: () => ({ to }) }));

const { emitReviewChanged } = await import("../src/lib/reviews/review-events.js");

const WS = "ws-2394";
const OTHER_WS = "ws-2394-other";
const PROJECT = "proj-2394";
const LEGACY = "proj-2394-legacy";
const MEMBER = "u-2394-member";
const REMOVED = "u-2394-removed";
const ADMIN = "u-2394-admin";
const DISABLED = "u-2394-disabled";
const SCIM_DELETED = "u-2394-scim-deleted";
const REVIEWERS = [MEMBER, REMOVED, ADMIN, DISABLED, SCIM_DELETED];

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2394 — review:changed reaches only reviewers who can open the project",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const roomsFor = async (projectId: string) => {
      to.mockClear();
      await emitReviewChanged(projectId, "rev-2394", REVIEWERS);
      // The project room first, then (if anyone qualifies) the personal rooms.
      return to.mock.calls.flatMap(([rooms]) => rooms);
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2394-review-changed-audience");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const id of REVIEWERS) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      const adminRole = await db.role.upsert({
        where: { key: "admin" },
        update: {},
        create: { key: "admin", name: "admin", isSystem: true },
      });
      await db.userRole.create({ data: { userId: ADMIN, roleId: adminRole.id } });
      // Disabled, and SCIM-deprovisioned (soft-deleted, status still active):
      // both keep their membership rows, and neither is sent the event.
      await db.user.update({ where: { id: DISABLED }, data: { status: "disabled" } });
      await db.user.update({ where: { id: SCIM_DELETED }, data: { deletedAt: new Date() } });
      await db.workspace.create({ data: { id: WS, name: WS, slug: WS } });
      await db.workspace.create({ data: { id: OTHER_WS, name: OTHER_WS, slug: OTHER_WS } });
      // REMOVED is no longer a member of WS, but still of another workspace:
      // the realistic shape of a removal, and what tells "a member of this
      // project's workspace" from "a member of some workspace".
      await db.workspaceMember.create({ data: { workspaceId: OTHER_WS, userId: REMOVED } });
      for (const userId of [MEMBER, DISABLED, SCIM_DELETED]) {
        await db.workspaceMember.create({ data: { workspaceId: WS, userId } });
      }
      await db.project.create({
        data: { id: PROJECT, name: PROJECT, slug: PROJECT, createdById: MEMBER, workspaceId: WS },
      });
      await db.project.create({
        data: { id: LEGACY, name: LEGACY, slug: LEGACY, createdById: MEMBER },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(async () => {
      await db.project.update({ where: { id: PROJECT }, data: { deletedAt: null } });
      await db.workspace.update({ where: { id: WS }, data: { deletedAt: null } });
    });

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("a workspace project: its live members and system admins, not a reviewer removed to another workspace", async () => {
      expect(await roomsFor(PROJECT)).toEqual([
        `project:${PROJECT}`,
        `user:${MEMBER}`,
        `user:${ADMIN}`,
      ]);
    });

    it("a soft-deleted project: system admins only", async () => {
      await db.project.update({ where: { id: PROJECT }, data: { deletedAt: new Date() } });
      expect(await roomsFor(PROJECT)).toEqual([`project:${PROJECT}`, `user:${ADMIN}`]);
    });

    it("a project in a soft-deleted workspace: system admins only", async () => {
      await db.workspace.update({ where: { id: WS }, data: { deletedAt: new Date() } });
      expect(await roomsFor(PROJECT)).toEqual([`project:${PROJECT}`, `user:${ADMIN}`]);
    });

    it("a legacy project with no workspace: every active reviewer", async () => {
      expect(await roomsFor(LEGACY)).toEqual([
        `project:${LEGACY}`,
        `user:${MEMBER}`,
        `user:${REMOVED}`,
        `user:${ADMIN}`,
      ]);
    });

    it("a project that no longer exists: system admins only", async () => {
      expect(await roomsFor("proj-2394-gone")).toEqual(["project:proj-2394-gone", `user:${ADMIN}`]);
    });
  },
);
