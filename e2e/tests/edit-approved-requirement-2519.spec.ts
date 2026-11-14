/**
 * Issue #2519 — editing an approved requirement, end to end (#2219, #2224).
 *
 * An analyst edits a requirement a review has approved:
 *   1. the Edit dialog warns that saving reopens the approval, naming the
 *      approved version, the approver and the version the save creates;
 *   2. after the save the requirement card reads "Changed since approval ·
 *      awaiting re-review", linked to the review, instead of `draft`;
 *   3. the review page shows the out-of-date banner under its header;
 *   4. the requester clicks Request re-review, confirms, and the review goes
 *      back to In review on the new wording: the banner and the action go away,
 *      and the earlier round's baseline stays linked.
 *
 * The review is created, submitted and approved over the real REST surface
 * (`fixtures/review-helpers.ts`), as `review-approval.spec.ts` does; the steps
 * the issue names are driven through the browser. The requirement is seeded
 * into the e2e SQLite DB, because the offline-stub AI provider cannot emit one.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { seedRequirementViaCli } from "../fixtures/seed-helpers.js";
import {
  REQUESTER,
  REVIEWER,
  authedApi,
  createProject,
  createReview,
  e2eDatabaseUrl,
  getReview,
  loginViaUi,
  primeUser,
  recordDecision,
  seedCompletedAnalysis,
  submitReview,
} from "../fixtures/review-helpers.js";
import { AnalysisPage } from "../pages/analysis-inline.page.js";
import { RequirementCardPage } from "../pages/requirement-card.page.js";
import { ReviewDetailPage } from "../pages/reviews.page.js";

const REVIEW_TITLE = "Approve before the analyst edits it";

/** The requirement's current version, as the approval read reports it. */
async function currentVersion(api: APIRequestContext, requirementId: string): Promise<number> {
  const res = await api.get(`/api/requirements/${requirementId}/approval`);
  expect(res.ok(), `requirement approval: ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { data: { version: number } }).data.version;
}

test.describe("Issue #2519 — edit an approved requirement, then request a re-review", () => {
  test.describe.configure({ timeout: 300_000 });

  let requesterApi: APIRequestContext | undefined;
  let reviewerApi: APIRequestContext | undefined;

  test.afterEach(async () => {
    await requesterApi?.dispose();
    await reviewerApi?.dispose();
  });

  test("warning in the Edit dialog → reopened card → review banner → Request re-review → In review", async ({
    page,
  }) => {
    const requester = await primeUser(REQUESTER);
    const reviewer = await primeUser(REVIEWER);
    requesterApi = await authedApi(requester.accessToken);
    reviewerApi = await authedApi(reviewer.accessToken);

    const projectId = await createProject(requesterApi, "e2e-2519-reopen");
    const analysisId = await seedCompletedAnalysis(requesterApi, projectId);
    const requirementId = seedRequirementViaCli({
      projectId,
      analysisId,
      databaseUrl: e2eDatabaseUrl(),
    });

    const reviewId = await createReview(requesterApi, projectId, {
      title: REVIEW_TITLE,
      reviewerIds: [reviewer.userId],
      requirementIds: [requirementId],
    });
    await submitReview(requesterApi, reviewId);
    expect((await recordDecision(reviewerApi, reviewId, "approved")).status).toBe("approved");
    const approvedBaseline = (await getReview(requesterApi, reviewId)).baseline;
    expect(approvedBaseline, "the approval created a baseline").not.toBeNull();
    const approvedVersion = await currentVersion(requesterApi, requirementId);

    const card = new RequirementCardPage(page, requirementId);

    await test.step("the Edit dialog warns that saving reopens the approval", async () => {
      await loginViaUi(page, REQUESTER);
      await new AnalysisPage(page).goto(projectId, "requirements");
      await card.expectVisible();
      await expect(card.reopenedLink, "not reopened before the edit").toHaveCount(0);

      await card.openEdit();
      await expect(card.approvalWarning).toHaveText(
        `Approved as v${approvedVersion} by Test Coordinator; saving creates v${approvedVersion + 1} and reopens review.`,
      );
    });

    await test.step("saving the edit reopens the approval on the card", async () => {
      await card.saveTitle("Reworded after the approval");
      await expect(card.header).toContainText("Reworded after the approval");
      await expect(card.reopenedLink).toBeVisible();
      await expect(card.reopenedLink).toHaveAttribute("href", `/reviews/${reviewId}`);
      expect(await currentVersion(requesterApi!, requirementId)).toBe(approvedVersion + 1);
    });

    const detail = new ReviewDetailPage(page);

    await test.step("the review page says a requirement changed since approval", async () => {
      await card.reopenedLink.click();
      await page.waitForURL(`**/reviews/${reviewId}`);
      await detail.expectReady();
      await detail.expectStatus("Approved");
      await expect(detail.outOfDateBanner).toHaveText("1 requirement changed since approval.");
    });

    await test.step("Request re-review returns the review to In review", async () => {
      await detail.requestReReview();
      await detail.expectStatus("In review");
      await expect(detail.outOfDateBanner).toBeHidden();
      await expect(detail.requestReReviewButton).toBeHidden();
      // #2224 — the earlier round's baseline stays linked until the next approval.
      await expect(detail.page.getByTestId("review-header")).toContainText(
        `Baseline from the earlier approval: ${approvedBaseline!.name}`,
      );
      expect((await getReview(requesterApi!, reviewId)).status).toBe("in_review");
    });
  });
});
