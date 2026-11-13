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
const to = vi.fn((_rooms: string[]) => ({ emit }));
vi.mock("../src/lib/socket/registry.js", () => ({ getSocketServer: () => ({ to }) }));

const { emitReviewChanged } = await import("../src/lib/reviews/review-events.js");

const WS = "ws-2394";
const PROJECT = "proj-2394";
const LEGACY = "proj-2394-legacy";
const MEMBER = "u-2394-member";
const REMOVED = "u-2394-removed";
const ADMIN = "u-2394-admin";
const REVIEWERS = [MEMBER, REMOVED, ADMIN];

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2394 — review:changed reaches only reviewers who can open the project",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const roomsFor = async (projectId: string) => {
      to.mockClear();
      await emitReviewChanged(projectId, "rev-2394", REVIEWERS);
      expect(to).toHaveBeenCalledTimes(1);
      return to.mock.calls[0]![0];
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
      await db.workspace.create({ data: { id: WS, name: WS, slug: WS } });
      // REMOVED was never (or is no longer) a member: only MEMBER holds a row.
      await db.workspaceMember.create({ data: { workspaceId: WS, userId: MEMBER } });
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

    it("a workspace project: its live members and system admins, not a removed reviewer", async () => {
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

    it("a legacy project with no workspace: every reviewer", async () => {
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
