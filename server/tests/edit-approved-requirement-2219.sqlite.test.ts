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
const { readRequirementApproval, flagApprovalReopened } =
  await import("../src/lib/reviews/requirement-approval.js");
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
      // #2224 — named in words, and still the review's while the re-review
      // runs, so the review page keeps linking it.
      expect(first!.name).toBe("Security sign-off");
      expect(reopened?.baseline?.id).toBe(first!.id);
      const audit = await db.auditLog.findMany({
        where: { targetId: reviewId, action: "review.reopen" },
      });
      expect(audit).toHaveLength(1);

      // #2224 — a manual baseline already holds the round's name: the
      // approval takes the next free one instead of failing on the unique name.
      await db.baseline.create({
        data: { projectId: PROJECT, name: "Security sign-off (round 2)", createdById: REQUESTER },
      });

      const decided = await recordDecision(REVIEWER, reviewId, "approved");
      expect(decided.status).toBe("approved");
      const second = await db.baseline.findUnique({
        where: { id: decided.baselineId! },
        include: { items: true },
      });
      expect(second?.reviewRequestId).toBe(reviewId);
      expect(second?.name).toBe("Security sign-off (round 2) (2)");
      // The earlier round's baseline is kept, detached from the review now.
      const kept = await db.baseline.findUnique({ where: { id: first!.id } });
      expect(kept?.reviewRequestId).toBeNull();
      expect(second?.items.map((i) => i.version)).toEqual([2]);
      expect(
        (await db.requirement.findUnique({ where: { id: REQ }, select: { reviewStatus: true } }))
          ?.reviewStatus,
      ).toBe("approved");
    });

    // #2224 — a version bump that told nobody (a system writer) used to
    // silence every later analyst edit: notify keyed on `pin === fromVersion`.
    it("an analyst edit after a silent system bump still tells the review's people, once", async () => {
      const REQ_C = "req-2224-c";
      await db.requirement.create({
        data: {
          id: REQ_C,
          projectId: PROJECT,
          analysisId: ANALYSIS,
          title: "Session timeout",
          body: "15 minutes",
        },
      });
      const created = (await createReviewRequest(REQUESTER, PROJECT, {
        title: "Session sign-off",
        policy: "all",
        reviewerIds: [REVIEWER],
        items: [{ requirementId: REQ_C }],
      })) as { id: string };
      await submitReview(REQUESTER, created.id, false);
      await recordDecision(REVIEWER, created.id, "approved");
      const toldOfC = async (userId: string) =>
        (await notificationsFor(userId)).filter((n) => n.href === `/reviews/${created.id}`);

      // A system write (no actor) bumps v0 → v1 and sends nothing.
      await updateRequirementWithHistory(db as never, {
        requirementId: REQ_C,
        patch: { body: "15 minutes of inactivity" },
        actorId: null,
        projectId: PROJECT,
      });
      const analystEdit = async (body: string) => {
        const result = await updateRequirementWithHistory(db as never, {
          requirementId: REQ_C,
          patch: { body },
          actorId: EDITOR,
          projectId: PROJECT,
          reopenApproval: true,
        });
        await notifyReviewedRequirementEdited({
          requirementId: REQ_C,
          fromVersion: result.version - 1,
          toVersion: result.version,
          actorId: EDITOR,
        });
      };

      await analystEdit("30 minutes of inactivity");
      for (const userId of [REQUESTER, REVIEWER]) {
        const rows = await toldOfC(userId);
        expect(rows).toHaveLength(1);
        expect(rows[0].message).toContain("approved v0");
      }

      await analystEdit("45 minutes of inactivity");
      expect(await toldOfC(REQUESTER)).toHaveLength(1);
      expect(await toldOfC(REVIEWER)).toHaveLength(1);
    });

    // #2224 — a reopened requirement read "draft", like one never reviewed.
    it("flags a requirement an approved review pinned and that was edited since, in its own project only", async () => {
      const REQ_D = "req-2224-d";
      await db.requirement.create({
        data: {
          id: REQ_D,
          projectId: PROJECT,
          analysisId: ANALYSIS,
          title: "Audit log",
          body: "a",
        },
      });
      const created = (await createReviewRequest(REQUESTER, PROJECT, {
        title: "Audit sign-off",
        policy: "all",
        reviewerIds: [REVIEWER],
        items: [{ requirementId: REQ_D }],
      })) as { id: string };
      await submitReview(REQUESTER, created.id, false);
      await recordDecision(REVIEWER, created.id, "approved");
      const readRow = async () => {
        const r = await db.requirement.findUniqueOrThrow({
          where: { id: REQ_D },
          select: { id: true, version: true, reviewStatus: true },
        });
        return { ...r, reviewStatus: r.reviewStatus ?? "draft" };
      };

      // Approved and current: nothing to say.
      expect((await flagApprovalReopened(PROJECT, [await readRow()]))[0]).not.toHaveProperty(
        "approvalReopened",
      );

      await updateRequirementWithHistory(db as never, {
        requirementId: REQ_D,
        patch: { body: "b" },
        actorId: EDITOR,
        projectId: PROJECT,
        reopenApproval: true,
      });
      const edited = await readRow();
      expect(edited.reviewStatus).toBe("draft");
      const [flagged] = await flagApprovalReopened(PROJECT, [edited]);
      expect(flagged.approvalReopened).toEqual({
        reviewId: created.id,
        reviewTitle: "Audit sign-off",
        approvedVersion: 0,
      });
      // Another project's read never names this project's review.
      const [elsewhere] = await flagApprovalReopened(OTHER_PROJECT, [edited]);
      expect(elsewhere).not.toHaveProperty("approvalReopened");
    });

    // #2223 review — approving a review pinned at v0 must not approve the v1
    // an analyst saved while the review was still in progress.
    it("approving an in-review review leaves a requirement edited since its pin awaiting review", async () => {
      const REQ_B = "req-2219-b";
      await db.requirement.create({
        data: {
          id: REQ_B,
          projectId: PROJECT,
          analysisId: ANALYSIS,
          title: "Export format",
          body: "JSON",
        },
      });
      const created = (await createReviewRequest(REQUESTER, PROJECT, {
        title: "Export sign-off",
        policy: "all",
        reviewerIds: [REVIEWER],
        items: [{ requirementId: REQ_B }],
      })) as { id: string };
      await submitReview(REQUESTER, created.id, false);

      await updateRequirementWithHistory(db as never, {
        requirementId: REQ_B,
        patch: { body: "JSON or OPML" },
        actorId: EDITOR,
        projectId: PROJECT,
        reopenApproval: true,
      });

      const decided = await recordDecision(REVIEWER, created.id, "approved");
      expect(decided.status).toBe("approved");
      const row = await db.requirement.findUnique({
        where: { id: REQ_B },
        select: { reviewStatus: true, version: true },
      });
      expect(row?.version).toBe(1);
      expect(row?.reviewStatus).not.toBe("approved");
    });
  },
);
