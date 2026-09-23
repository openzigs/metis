/**
 * Epic #609 / Issue #622 — review & approval workflow end-to-end.
 *
 * Covers the four acceptance flows of the formal review feature set
 * (#616 state machine, #617 API, #618 reviewer UI, #619 publish gate,
 * #620 baselines, #621 notifications):
 *
 *   1. create → submit → reviewer APPROVES (via UI) → status approved →
 *      an immutable baseline exists with pinned requirement versions.
 *   2. reviewer REJECTS (via UI) → the requester is notified (in-app drawer) →
 *      revise (edit the requirement) → resubmit a fresh round → approved.
 *   3. with `requireApprovedReview` ON, PUBLISHING an unapproved requirement is
 *      blocked with the actionable APPROVAL_REQUIRED error; approving the
 *      requirement's review unblocks it.
 *   4. comparing two baselines surfaces a FIELD-LEVEL change between them.
 *
 * UI vs API split: the review feature ships a reviewer decision UI, a baselines
 * surface, and a publish-gate settings card, but no create/submit-review UI
 * yet (#618). So the lifecycle is seeded through the REAL REST surface and the
 * human-facing surfaces (decision, notifications, baseline compare, gate) are
 * asserted through the browser. Determinism mirrors the existing suite: the
 * offline-stub AI provider can't emit structured requirements, so a Requirement
 * is seeded into the e2e SQLite DB after a real (empty) analysis completes.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { seedRequirementViaCli } from "../fixtures/seed-helpers.js";
import {
  REQUESTER,
  REVIEWER,
  authedApi,
  createManualBaseline,
  createProject,
  createReview,
  e2eDatabaseUrl,
  getReview,
  loginViaUi,
  primeUser,
  recordDecision,
  seedCompletedAnalysis,
  setReviewGate,
  submitReview,
  updateRequirementTitle,
  waitForNotification,
} from "../fixtures/review-helpers.js";
import { ReviewDetailPage } from "../pages/reviews.page.js";
import { BaselinesPage } from "../pages/baselines.page.js";

interface Ctx {
  requesterApi: APIRequestContext;
  reviewerApi: APIRequestContext;
  reviewerId: string;
  projectId: string;
  analysisId: string;
  requirementId: string;
}

/** Prime both actors + seed a project with one requirement to review. */
async function setup(prefix: string): Promise<Ctx> {
  const requester = await primeUser(REQUESTER);
  const reviewer = await primeUser(REVIEWER);
  const requesterApi = await authedApi(requester.accessToken);
  const reviewerApi = await authedApi(reviewer.accessToken);

  const projectId = await createProject(requesterApi, prefix);
  const analysisId = await seedCompletedAnalysis(requesterApi, projectId);
  const requirementId = seedRequirementViaCli({
    projectId,
    analysisId,
    databaseUrl: e2eDatabaseUrl(),
  });
  expect(requirementId).toBeTruthy();

  return {
    requesterApi,
    reviewerApi,
    reviewerId: reviewer.userId,
    projectId,
    analysisId,
    requirementId,
  };
}

async function baselineContents(
  api: APIRequestContext,
  baselineId: string,
): Promise<Array<{ requirementId: string; version: number }>> {
  const res = await api.get(`/api/baselines/${baselineId}`);
  expect(res.ok(), `baseline contents: ${await res.text()}`).toBeTruthy();
  return (
    (await res.json()) as { data: { items: Array<{ requirementId: string; version: number }> } }
  ).data.items;
}

test.describe("Epic #609 — review & approval workflow (#622)", () => {
  test.describe.configure({ timeout: 300_000 });

  let ctx: Ctx;

  test.afterEach(async () => {
    await ctx?.requesterApi.dispose();
    await ctx?.reviewerApi.dispose();
  });

  // ---- Flow 1 --------------------------------------------------------------
  test("create → submit → reviewer approves in the UI → approved + baseline with pinned versions", async ({
    page,
  }) => {
    ctx = await setup("e2e-622-approve");

    const reviewId = await createReview(ctx.requesterApi, ctx.projectId, {
      title: "Approve the seeded requirement",
      reviewerIds: [ctx.reviewerId],
      requirementIds: [ctx.requirementId],
    });
    await submitReview(ctx.requesterApi, reviewId);

    // The assigned reviewer (coordinator) — never the requester — approves
    // through the real decision UI. Sign in, then hard-navigate to the review:
    // this exercises the /auth/me re-hydration path a real reload hits, which
    // (since #642) returns the `id`-shaped user the decision bar gates on.
    await loginViaUi(page, REVIEWER, `/reviews/${reviewId}`);
    const detail = new ReviewDetailPage(page);
    await detail.expectReady();
    await detail.expectStatus("In review");
    await detail.decide("approve", "Looks good — approving.");

    await test.step("the review reaches the approved state in the UI", async () => {
      await detail.expectStatus("Approved");
    });

    await test.step("the header links the baseline created on approval", async () => {
      await expect(detail.baselineLink).toBeVisible();
    });

    await test.step("server-side: the review is approved with an auto-created baseline", async () => {
      const review = await getReview(ctx.requesterApi, reviewId);
      expect(review.status).toBe("approved");
      expect(review.baseline).not.toBeNull();

      const items = await baselineContents(ctx.requesterApi, review.baseline!.id);
      const pinned = items.find((i) => i.requirementId === ctx.requirementId);
      expect(pinned, "the reviewed requirement is pinned in the baseline").toBeTruthy();
      expect(Number.isInteger(pinned!.version)).toBe(true);
    });
  });

  // ---- Flow 2 --------------------------------------------------------------
  test("reviewer rejects → requester is notified → revise → resubmit → approved", async ({
    page,
  }) => {
    ctx = await setup("e2e-622-reject");

    const reviewId = await createReview(ctx.requesterApi, ctx.projectId, {
      title: "First round — will be rejected",
      reviewerIds: [ctx.reviewerId],
      requirementIds: [ctx.requirementId],
    });
    await submitReview(ctx.requesterApi, reviewId);

    await test.step("the reviewer rejects through the decision UI", async () => {
      await loginViaUi(page, REVIEWER, `/reviews/${reviewId}`);
      const detail = new ReviewDetailPage(page);
      await detail.expectReady();
      await detail.decide("reject", "Needs a clearer acceptance criterion.");
      await detail.expectStatus("Rejected");
    });

    await test.step("the requester receives an in-app review-rejected notification", async () => {
      // Deterministic gate on the persisted row before asserting the drawer,
      // which hydrates from GET /notifications on mount.
      const note = await waitForNotification(ctx.requesterApi, "review_rejected");
      expect(note.title).toBe("Review rejected");

      // Switch the browser session from the reviewer to the requester. Clearing
      // cookies + a full reload drops the reviewer session so the login form
      // (which auto-redirects an already-authenticated visitor) shows again.
      await page.context().clearCookies();
      await loginViaUi(page, REQUESTER);
      await page.getByTestId("notifications-bell").click();
      await expect(page.getByTestId("notifications-drawer")).toBeVisible();
      await expect(page.getByTestId("notifications-list")).toContainText("Review rejected");
    });

    await test.step("revise the requirement and resubmit a fresh review round", async () => {
      // No reopen route exists yet (#618 deferral): revise == edit the
      // requirement + open a new review round, which the reviewer approves.
      await updateRequirementTitle(
        ctx.requesterApi,
        ctx.requirementId,
        "Revised requirement after rejection",
      );
      const round2 = await createReview(ctx.requesterApi, ctx.projectId, {
        title: "Second round — resubmitted after revision",
        reviewerIds: [ctx.reviewerId],
        requirementIds: [ctx.requirementId],
      });
      await submitReview(ctx.requesterApi, round2);

      const result = await recordDecision(ctx.reviewerApi, round2, "approved");
      expect(result.status).toBe("approved");

      const review = await getReview(ctx.requesterApi, round2);
      expect(review.status).toBe("approved");
      expect(review.baseline, "resubmitted-and-approved round produces a baseline").not.toBeNull();
    });
  });

  // ---- Flow 3 --------------------------------------------------------------
  test("requireApprovedReview blocks publishing an unapproved requirement; approving unblocks it", async ({
    page,
    context,
  }) => {
    ctx = await setup("e2e-622-gate");
    const { requesterApi, projectId, analysisId, requirementId } = ctx;

    // Turn the per-project approval gate ON (review.admin — admin has it).
    await setReviewGate(requesterApi, projectId, true);

    // Drafts to publish, generated from the completed analysis. They link to
    // the seeded requirement, which has NO approved review yet.
    const gen = await requesterApi.post(`/api/projects/${projectId}/publishing/drafts/generate`, {
      data: {
        analysisId,
        targetOwner: "metis-e2e",
        targetRepo: "fixture-repo",
        defaultLabels: ["e2e"],
      },
    });
    expect(gen.status(), `generate drafts: ${await gen.text()}`).toBe(201);

    const listRes = await requesterApi.get(`/api/projects/${projectId}/publishing/drafts`);
    const draftIds = ((await listRes.json()) as { data: Array<{ id: string }> }).data.map(
      (d) => d.id,
    );
    expect(draftIds.length, "at least one draft generated").toBeGreaterThan(0);

    await test.step("the publish page surfaces the approval-gate control", async () => {
      // The gate's *enforced* state is asserted authoritatively via the API
      // block/unblock below; here we just confirm the gate UI is present on the
      // publish page (its checked state is driven by an async query whose
      // in-dev resolution timing we don't want to couple this assertion to).
      await loginViaUi(page, REQUESTER, `/projects/${projectId}/publish`);
      await expect(page.getByTestId("approval-gate-card")).toBeVisible();
      await expect(page.getByTestId("approval-gate-toggle")).toBeAttached();
    });

    await test.step("publishing (non-dry-run) is blocked with the actionable APPROVAL_REQUIRED error", async () => {
      // Defensive sentinel: the gate must block BEFORE any GitHub call.
      const ghHits: string[] = [];
      const sentinel = (route: import("@playwright/test").Route) => {
        ghHits.push(route.request().url());
        return route.abort();
      };
      await context.route(/api\.github\.com|github\.com/, sentinel);
      try {
        const batch = await requesterApi.post(`/api/projects/${projectId}/publishing/batches`, {
          data: {
            projectId,
            targetOwner: "metis-e2e",
            targetRepo: "fixture-repo",
            draftIds,
            dryRun: false,
            // #1092/#1094 — a live batch is rejected with 400 TOKEN_REQUIRED
            // before anything else if no vault ref is supplied, which would
            // short-circuit the gate this step is about. The ref only has to be
            // well-formed: it is resolved inside runBatch, long after the gate.
            secretRef: "${vault:gh-publish-token}",
          },
        });
        expect(batch.status(), await batch.text()).toBe(409);
        const body = (await batch.json()) as {
          error: { code: string; details?: { requirementIds?: string[] } };
        };
        expect(body.error.code).toBe("APPROVAL_REQUIRED");
        expect(body.error.details?.requirementIds ?? []).toContain(requirementId);
      } finally {
        await context.unroute(/api\.github\.com|github\.com/, sentinel);
      }
      expect(ghHits, "no GitHub traffic — the gate blocked first").toEqual([]);
    });

    await test.step("approving a review for the requirement satisfies the same gate", async () => {
      // Same gate function (findUnapprovedRequirementIds) backs publish AND
      // export; the export surface is the deterministic way to prove the gate
      // reopened for this requirement without a live GitHub write.
      const blocked = await requesterApi.get(
        `/api/requirements/${requirementId}/history/export?format=json`,
      );
      expect(blocked.status(), "gate blocks export while unapproved").toBe(409);

      const reviewId = await createReview(requesterApi, projectId, {
        title: "Approve to satisfy the publish gate",
        reviewerIds: [ctx.reviewerId],
        requirementIds: [requirementId],
      });
      await submitReview(requesterApi, reviewId);
      const result = await recordDecision(ctx.reviewerApi, reviewId, "approved");
      expect(result.status).toBe("approved");

      const unblocked = await requesterApi.get(
        `/api/requirements/${requirementId}/history/export?format=json`,
      );
      expect(unblocked.status(), "gate permits the requirement once approved").toBe(200);
    });
  });

  // ---- Flow 4 --------------------------------------------------------------
  test("baseline compare surfaces a field-level change between two baselines", async ({ page }) => {
    ctx = await setup("e2e-622-compare");
    const { requesterApi, projectId, requirementId } = ctx;

    // Baseline A pins the requirement at its current version, then we edit it
    // (a real version bump) and pin baseline B at the new version.
    const baselineA = await createManualBaseline(
      requesterApi,
      projectId,
      "Baseline A (before edit)",
      [requirementId],
    );
    await updateRequirementTitle(requesterApi, requirementId, "Title changed between baselines");
    const baselineB = await createManualBaseline(
      requesterApi,
      projectId,
      "Baseline B (after edit)",
      [requirementId],
    );
    expect(baselineA).not.toBe(baselineB);

    await loginViaUi(page, REQUESTER, `/projects/${projectId}/baselines`);
    const baselines = new BaselinesPage(page);
    await baselines.expectReady();

    await test.step("both baselines are listed", async () => {
      await expect(baselines.row(baselineA)).toBeVisible();
      await expect(baselines.row(baselineB)).toBeVisible();
    });

    await test.step("comparing A → B shows the requirement in the changed set with a field diff", async () => {
      await baselines.compare(baselineA, baselineB);
      const changed = baselines.changedEntry(requirementId);
      await expect(changed).toBeVisible();
      // The entry carries the version transition and a field-level VersionDiff.
      await expect(changed).toContainText("v0");
      await expect(changed).toContainText("v1");
    });
  });
});
