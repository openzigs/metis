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
 * The same rule gates the review notifications that carry the review's
 * title: `review_requested` (a submit, or the reopen of an approved review)
 * and `review_item_changed`. Someone without access gets no row and no
 * `review:notification`.
 *
 * Proven through the real emitter and fan-out against a real SQLite database
 * built from the migration chain; only the socket server is a fake.
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
const { notifyReviewDecision, notifyReviewSubmitted, notifyReviewedRequirementEdited } =
  await import("../src/lib/reviews/notify.js");

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
const EDITOR = "u-2394-editor";
const ANALYSIS = "an-2394";
const REQUIREMENT = "req-2394";
const REVIEW = "rev-2394-approved";

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
      // An approved review in PROJECT that pinned a requirement at v1, its
      // requester and reviewers spanning every audience above.
      await db.user.create({
        data: {
          id: EDITOR,
          username: EDITOR,
          displayName: EDITOR,
          email: `${EDITOR}@example.test`,
        },
      });
      await db.analysis.create({
        data: { id: ANALYSIS, projectId: PROJECT, startedById: MEMBER, status: "completed" },
      });
      await db.requirement.create({
        data: {
          id: REQUIREMENT,
          projectId: PROJECT,
          analysisId: ANALYSIS,
          title: "Password length",
          body: "body",
          version: 1,
        },
      });
      await db.reviewRequest.create({
        data: {
          id: REVIEW,
          projectId: PROJECT,
          title: "Sprint 4 sign-off",
          status: "approved",
          requestedById: REMOVED,
          assignments: {
            create: [MEMBER, ADMIN, DISABLED, SCIM_DELETED].map((reviewerId) => ({ reviewerId })),
          },
          items: { create: [{ requirementId: REQUIREMENT, pinnedVersion: 1 }] },
        },
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

    /** Who was sent a `review:notification`, and who got a stored row of `type`. */
    const notified = async (type: string) => {
      const live = emit.mock.calls
        .filter(([name]) => name === "review:notification")
        .map(([, payload]) => (payload as { userId: string }).userId)
        .sort();
      const rows = await db.notification.findMany({ where: { type }, select: { userId: true } });
      await db.notification.deleteMany({ where: { type } });
      return { live, stored: rows.map((r) => r.userId).sort() };
    };

    it("a reopen sends review_requested only to reviewers who can open the project", async () => {
      emit.mockClear();
      await notifyReviewSubmitted({
        reviewId: REVIEW,
        projectId: PROJECT,
        title: "Sprint 4 sign-off",
        actorId: EDITOR,
        reviewerIds: REVIEWERS,
        reopened: true,
      });
      expect(await notified("review_requested")).toEqual({
        live: [ADMIN, MEMBER].sort(),
        stored: [ADMIN, MEMBER].sort(),
      });
    });

    it("an edit of a pinned requirement sends review_item_changed only to participants with access", async () => {
      emit.mockClear();
      // REMOVED requested the review; DISABLED and SCIM_DELETED are assigned.
      await notifyReviewedRequirementEdited({
        requirementId: REQUIREMENT,
        fromVersion: 1,
        toVersion: 2,
        actorId: EDITOR,
      });
      expect(await notified("review_item_changed")).toEqual({
        live: [ADMIN, MEMBER].sort(),
        stored: [ADMIN, MEMBER].sort(),
      });
    });

    it("a decision reaches the requester only while they can open the project", async () => {
      const decide = (requestedById: string) =>
        notifyReviewDecision({
          reviewId: REVIEW,
          projectId: PROJECT,
          title: "Sprint 4 sign-off",
          requestedById,
          reviewerId: ADMIN,
          reviewerName: ADMIN,
          decision: "approved",
          outcome: "approved",
          baselineId: null,
        });
      emit.mockClear();
      // REMOVED requested REVIEW but is no longer a member of its workspace.
      await decide(REMOVED);
      expect(await notified("review_approved")).toEqual({ live: [], stored: [] });
      // The control: a requester who can open it is sent the row and the event.
      await decide(MEMBER);
      expect(await notified("review_approved")).toEqual({ live: [MEMBER], stored: [MEMBER] });
    });

    it("a project that no longer exists: system admins only", async () => {
      expect(await roomsFor("proj-2394-gone")).toEqual(["project:proj-2394-gone", `user:${ADMIN}`]);
    });
  },
);
