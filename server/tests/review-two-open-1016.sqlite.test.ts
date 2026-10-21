/**
 * #1016 — two open reviews of one requirement, and legacy `review:*` label rows.
 *
 * Two reviews may cover the same requirement at once (an analyst can ask a
 * second group to sign off the same set). Each used to capture its own "status
 * before the review", so the second captured the first's "draft", and
 * withdrawing one restored a status the other still depended on. Now:
 *   - while any other review in `in_review` covers a requirement, leaving one
 *     review (withdraw, or close mid-review) leaves the requirement as it is;
 *   - the last open review to leave restores the status from before the reviews,
 *     whichever order they are withdrawn in;
 *   - a status set while one was open (a verdict, an edit) is what a review
 *     submitted after it restores, and the reviews already open restore it too.
 *
 * And a requirement whose column is null but which carries the legacy
 * `review:approved` label is approved for a review exactly as the Requirements
 * counts (and so the Request review note) say it is: submitting leaves it
 * approved.
 *
 * Proven through the real review service against a real SQLite database built
 * from the migration chain. The Postgres row-lock race is proven separately in
 * `review-two-open-1016-postgres.integration.test.ts`.
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
vi.mock("../src/lib/reviews/notify.js", () => ({
  dispatchReviewSubmitted: vi.fn(),
  dispatchReviewDecision: vi.fn(),
}));

const {
  createReviewRequest,
  submitReview,
  withdrawReview,
  closeReview,
  recordDecision,
  heldReviewStatus,
} = await import("../src/lib/reviews/review-service.js");
const { listAnalysesForProject } = await import("../src/lib/analysis/analysis-service.js");

const PROJECT = "proj-1016";
const ANALYSIS = "ana-1016";
const REQUESTER = "u-1016-req";
const REVIEWER = "u-1016-rev";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1016 — two open reviews of one requirement",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let seq = 0;

    const makeRequirement = async (reviewStatus: string | null, labels: string[] = []) => {
      seq += 1;
      const row = await db.requirement.create({
        data: {
          id: `req-1016-${seq}`,
          projectId: PROJECT,
          analysisId: ANALYSIS,
          title: `Requirement ${seq}`,
          body: "body",
          reviewStatus,
          labels: JSON.stringify(labels),
        },
      });
      return row.id;
    };

    const status = async (id: string) =>
      (await db.requirement.findUniqueOrThrow({ where: { id }, select: { reviewStatus: true } }))
        .reviewStatus;

    const openReview = async (ids: string[]) => {
      const created = (await createReviewRequest(REQUESTER, PROJECT, {
        title: "Sign-off",
        policy: "all",
        reviewerIds: [REVIEWER],
        items: ids.map((requirementId) => ({ requirementId })),
      })) as { id: string };
      await submitReview(REQUESTER, created.id, false);
      return created.id;
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1016-two-open-reviews");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const id of [REQUESTER, REVIEWER]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      await db.project.create({
        data: { id: PROJECT, name: PROJECT, slug: PROJECT, createdById: REQUESTER },
      });
      await db.analysis.create({
        data: { id: ANALYSIS, projectId: PROJECT, startedById: REQUESTER, status: "completed" },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(() => {
      seq += 100;
    });

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("the second review records the status from before the first, not the first's draft", async () => {
      const req = await makeRequirement("rejected");
      const first = await openReview([req]);
      const second = await openReview([req]);

      const items = await db.reviewRequestItem.findMany({
        where: { requirementId: req },
        select: { reviewRequestId: true, priorReviewStatus: true },
      });
      expect(
        Object.fromEntries(items.map((i) => [i.reviewRequestId, i.priorReviewStatus])),
      ).toEqual({ [first]: "rejected", [second]: "rejected" });
    });

    it("withdrawing the first leaves the requirement awaiting the second; withdrawing the second restores it", async () => {
      const req = await makeRequirement("rejected");
      const first = await openReview([req]);
      const second = await openReview([req]);

      await withdrawReview(REQUESTER, first, false);
      expect(await status(req)).toBe("draft");

      await withdrawReview(REQUESTER, second, false);
      expect(await status(req)).toBe("rejected");
    });

    it("restores the same status when the reviews are withdrawn in the other order", async () => {
      const req = await makeRequirement("deferred");
      const first = await openReview([req]);
      const second = await openReview([req]);

      await withdrawReview(REQUESTER, second, false);
      expect(await status(req)).toBe("draft");

      await closeReview(REQUESTER, first, false);
      expect(await status(req)).toBe("deferred");
    });

    it("only the requirements the other review covers wait for it", async () => {
      const shared = await makeRequirement("rejected");
      const own = await makeRequirement("deferred");
      const wider = await openReview([shared, own]);
      await openReview([shared]);

      await withdrawReview(REQUESTER, wider, false);
      expect(await status(shared)).toBe("draft");
      expect(await status(own)).toBe("deferred");
    });

    it("a verdict on one review stands when the other is withdrawn", async () => {
      const req = await makeRequirement("rejected");
      const first = await openReview([req]);
      const second = await openReview([req]);

      await recordDecision(REVIEWER, first, "approved");
      expect(await status(req)).toBe("approved");

      await withdrawReview(REQUESTER, second, false);
      expect(await status(req)).toBe("approved");
    });

    it("a status set while one review was open is what every open review restores", async () => {
      const req = await makeRequirement("deferred");
      const first = await openReview([req]);
      const second = await openReview([req]);
      await recordDecision(REVIEWER, first, "rejected");
      expect(await status(req)).toBe("rejected");

      // A third review is requested after the rejection; the second, opened
      // before it, must not later put back the "deferred" it captured.
      const third = await openReview([req]);
      expect(await status(req)).toBe("draft");

      await withdrawReview(REQUESTER, third, false);
      expect(await status(req)).toBe("draft");
      await withdrawReview(REQUESTER, second, false);
      expect(await status(req)).toBe("rejected");
    });

    it("an approved requirement stays approved under two reviews and after both are withdrawn", async () => {
      const req = await makeRequirement("approved");
      const first = await openReview([req]);
      const second = await openReview([req]);
      expect(await status(req)).toBe("approved");

      await withdrawReview(REQUESTER, first, false);
      await withdrawReview(REQUESTER, second, false);
      expect(await status(req)).toBe("approved");
    });

    it("two withdraws at once still restore the status (SQLite runs them one at a time)", async () => {
      const req = await makeRequirement("rejected");
      const first = await openReview([req]);
      const second = await openReview([req]);

      await Promise.all([
        withdrawReview(REQUESTER, first, false),
        withdrawReview(REQUESTER, second, false),
      ]);
      expect(await status(req)).toBe("rejected");
    });

    it("prefers a real capture over a pre-#1016 second review's 'draft' capture", async () => {
      const req = await makeRequirement("rejected");
      const first = await openReview([req]);
      const second = await openReview([req]);
      // What a review submitted second before #1016 recorded. It goes on the
      // OLDER item (a review created first but submitted after the other), so
      // the oldest-first read meets the "draft" before the real capture.
      await db.reviewRequestItem.updateMany({
        where: { reviewRequestId: first, requirementId: req },
        data: { priorReviewStatus: "draft" },
      });
      const third = await openReview([req]);
      const captured = await db.reviewRequestItem.findFirstOrThrow({
        where: { reviewRequestId: third, requirementId: req },
        select: { priorReviewStatus: true },
      });
      expect(captured.priorReviewStatus).toBe("rejected");

      await withdrawReview(REQUESTER, first, false);
      await withdrawReview(REQUESTER, second, false);
      await withdrawReview(REQUESTER, third, false);
      expect(await status(req)).toBe("rejected");
    });

    describe("legacy `review:*` label rows (column null)", () => {
      it("a `review:approved` row counts as approved and stays approved through a review", async () => {
        const legacy = await makeRequirement(null, ["review:approved", "finding:f1"]);

        const before = await listAnalysesForProject(PROJECT);
        const approvedBefore = before.find((a) => a.id === ANALYSIS)?.requirementCounts.approved;

        const reviewId = await openReview([legacy]);
        // The column is not written: the label keeps it approved for every reader.
        expect(await status(legacy)).toBeNull();
        const during = await listAnalysesForProject(PROJECT);
        expect(during.find((a) => a.id === ANALYSIS)?.requirementCounts.approved).toBe(
          approvedBefore,
        );

        await withdrawReview(REQUESTER, reviewId, false);
        expect(await status(legacy)).toBeNull();
      });

      it("a rejection still overrides a `review:approved` label", async () => {
        const legacy = await makeRequirement(null, ["review:approved"]);
        const reviewId = await openReview([legacy]);
        await recordDecision(REVIEWER, reviewId, "rejected");
        expect(await status(legacy)).toBe("rejected");
      });

      it("a `review:rejected` row awaits review and gets its rejection back on withdraw", async () => {
        const legacy = await makeRequirement(null, ["review:rejected"]);
        const reviewId = await openReview([legacy]);
        expect(await status(legacy)).toBe("draft");

        await withdrawReview(REQUESTER, reviewId, false);
        expect(await status(legacy)).toBe("rejected");
      });
    });
  },
);

describe("heldReviewStatus (#1016)", () => {
  it("prefers the column", () => {
    expect(heldReviewStatus("deferred", JSON.stringify(["review:approved"]))).toBe("deferred");
  });
  it("falls back to a known legacy label", () => {
    expect(heldReviewStatus(null, JSON.stringify(["x", "review:approved"]))).toBe("approved");
  });
  it("ignores an unknown label, no label, and malformed labels", () => {
    expect(heldReviewStatus(null, JSON.stringify(["review:bogus"]))).toBeNull();
    expect(heldReviewStatus(null, JSON.stringify(["x"]))).toBeNull();
    expect(heldReviewStatus(null, "not json")).toBeNull();
    expect(heldReviewStatus(null, null)).toBeNull();
  });
});
