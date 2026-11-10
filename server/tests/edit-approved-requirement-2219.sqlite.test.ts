/**
 * #2219 — editing an approved requirement kept it approved: the review stayed
 * Approved on the old version, nothing asked for a re-review and nobody was told.
 *
 * Proven through the real services against a real SQLite database built from
 * the migration chain, read back through fresh queries: the approval read the
 * Edit dialog warns from, the edit that returns the requirement to awaiting
 * review, the notification sent once to the review's people, and "Request
 * re-review", which re-pins the current version and lets a second approval
 * create its own baseline. Only the socket server is absent.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { approvalEditWarning } from "@metis/shared";
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
vi.mock("../src/lib/socket/registry.js", () => ({ getSocketServer: () => null }));

const { createReviewRequest, submitReview, recordDecision, reopenReview } =
  await import("../src/lib/reviews/review-service.js");
const { notifyReviewedRequirementEdited } = await import("../src/lib/reviews/notify.js");
const { readRequirementApproval } = await import("../src/lib/reviews/requirement-approval.js");
const { updateRequirementWithHistory } =
  await import("../src/lib/requirements/requirement-version-service.js");

const PROJECT = "proj-2219";
const OTHER_PROJECT = "proj-2219-other";
const ANALYSIS = "ana-2219";
const REQUESTER = "u-2219-req";
const REVIEWER = "u-2219-rev";
const EDITOR = "u-2219-edit";
const REQ = "req-2219";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2219 — an edit of an approved requirement reopens its approval",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let reviewId: string;

    const edit = (body: string) =>
      updateRequirementWithHistory(db as never, {
        requirementId: REQ,
        patch: { body },
        actorId: EDITOR,
        projectId: PROJECT,
        reopenApproval: true,
      });

    const notificationsFor = (userId: string) =>
      db.notification.findMany({ where: { userId, type: "review_item_changed" } });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2219-edit-approved-requirement");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const [id, name] of [
        [REQUESTER, "Requester"],
        [REVIEWER, "Test Coordinator"],
        [EDITOR, "Editor"],
      ]) {
        await db.user.create({
          data: { id, username: id, displayName: name, email: `${id}@example.test` },
        });
      }
      for (const id of [PROJECT, OTHER_PROJECT]) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById: REQUESTER },
        });
      }
      await db.analysis.create({
        data: { id: ANALYSIS, projectId: PROJECT, startedById: REQUESTER, status: "completed" },
      });
      await db.requirement.create({
        data: {
          id: REQ,
          projectId: PROJECT,
          analysisId: ANALYSIS,
          title: "Password length",
          body: "At least 12 characters",
        },
      });

      const created = (await createReviewRequest(REQUESTER, PROJECT, {
        title: "Security sign-off",
        policy: "all",
        reviewerIds: [REVIEWER],
        items: [{ requirementId: REQ }],
      })) as { id: string };
      reviewId = created.id;
      await submitReview(REQUESTER, reviewId, false);
      await recordDecision(REVIEWER, reviewId, "approved");
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("the approval read names the approver, so the Edit dialog warns before the save", async () => {
      const approval = await readRequirementApproval(REQ, PROJECT);
      expect(approval).toMatchObject({
        requirementId: REQ,
        version: 0,
        reviewStatus: "approved",
        reviews: [
          {
            id: reviewId,
            status: "approved",
            pinnedVersion: 0,
            approvedBy: ["Test Coordinator"],
          },
        ],
      });
      expect(approvalEditWarning(approval)).toBe(
        "Approved as v0 by Test Coordinator; saving creates v1 and reopens review.",
      );
      // Out of the caller's project, the requirement is not found.
      expect(await readRequirementApproval(REQ, OTHER_PROJECT)).toBeNull();
    });

    it("the edit returns the requirement to awaiting review and tells the review's people once", async () => {
      const result = await edit("15 characters, or 8 with MFA");
      expect(result.version).toBe(1);

      const row = await db.requirement.findUnique({
        where: { id: REQ },
        select: { reviewStatus: true, version: true },
      });
      expect(row).toEqual({ reviewStatus: "draft", version: 1 });
      // The review still records what was approved: the pin is the old version.
      const item = await db.reviewRequestItem.findFirst({ where: { reviewRequestId: reviewId } });
      expect(item?.pinnedVersion).toBe(0);
      expect((await db.reviewRequest.findUnique({ where: { id: reviewId } }))?.status).toBe(
        "approved",
      );

      await notifyReviewedRequirementEdited({
        requirementId: REQ,
        fromVersion: 0,
        toVersion: 1,
        actorId: EDITOR,
      });
      for (const userId of [REQUESTER, REVIEWER]) {
        const rows = await notificationsFor(userId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          title: "Approved requirement changed",
          href: `/reviews/${reviewId}`,
          projectId: PROJECT,
        });
      }
      expect(await notificationsFor(EDITOR)).toHaveLength(0);

      // A second edit: the pin is already out of date, so nobody is told again.
      await edit("15 characters, or 10 with MFA");
      await notifyReviewedRequirementEdited({
        requirementId: REQ,
        fromVersion: 1,
        toVersion: 2,
        actorId: EDITOR,
      });
      expect(await notificationsFor(REQUESTER)).toHaveLength(1);
      expect(await notificationsFor(REVIEWER)).toHaveLength(1);
    });

    it("Request re-review re-pins the current version; the re-approval creates its own baseline", async () => {
      const first = await db.baseline.findFirst({ where: { reviewRequestId: reviewId } });
      expect(first).not.toBeNull();

      await reopenReview(REQUESTER, reviewId, false);

      const reopened = await db.reviewRequest.findUnique({
        where: { id: reviewId },
        include: { items: true, assignments: true, baseline: true },
      });
      expect(reopened?.status).toBe("in_review");
      expect(reopened?.items[0].pinnedVersion).toBe(2);
      expect(reopened?.assignments.map((a) => a.decision)).toEqual(["pending"]);
      // The earlier round's baseline is kept, detached from the review.
      expect(reopened?.baseline).toBeNull();
      expect(await db.baseline.findUnique({ where: { id: first!.id } })).not.toBeNull();
      const audit = await db.auditLog.findMany({
        where: { targetId: reviewId, action: "review.reopen" },
      });
      expect(audit).toHaveLength(1);

      const decided = await recordDecision(REVIEWER, reviewId, "approved");
      expect(decided.status).toBe("approved");
      const second = await db.baseline.findUnique({
        where: { id: decided.baselineId! },
        include: { items: true },
      });
      expect(second?.reviewRequestId).toBe(reviewId);
      expect(second?.name).toBe(`${first!.name} round 2`);
      expect(second?.items.map((i) => i.version)).toEqual([2]);
      expect(
        (await db.requirement.findUnique({ where: { id: REQ }, select: { reviewStatus: true } }))
          ?.reviewStatus,
      ).toBe("approved");
    });
  },
);
