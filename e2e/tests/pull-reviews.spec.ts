/**
 * Coverage — PR-review history list + detail (Epic #394 P2 / #404).
 *
 *   List:   /projects/[id]/pulls
 *   Detail: /projects/[id]/pulls/[prNumber]?owner=…&repo=…
 *
 * A freshly created project has never had a PR review recorded, so:
 *   - the list renders its legitimate "No PR reviews recorded yet" empty state
 *     from a 200 (NOT a masked /api/api/ 404), and the "Showing N of M" footer
 *     confirms the query resolved;
 *   - the detail page for any PR number renders the graceful "No automated
 *     review has been recorded for this PR yet" 404 surface (retry:false), with
 *     a Re-run button still present, plus the back link to the list.
 *
 * Acceptance criteria:
 *   AC: the list heading + subtitle render.
 *   AC: the never-reviewed project shows the empty state, sourced from a 200.
 *   AC: the detail page renders the back link, the Re-run button, and the
 *       graceful no-review-recorded surface for an unknown PR.
 *   AC: neither route issues a /api/api/ double-prefixed request.
 */
import { test, expect } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { createProjectViaApi, type CreatedProject } from "../fixtures/project-helpers.js";
import { LoginPage } from "../pages/login.page.js";
import { watchForDoubleApiPrefix } from "../fixtures/no-double-api-prefix.js";
import { PullReviewsListPage, PullReviewDetailPage } from "../pages/pull-reviews.page.js";

const API_BASE = apiBase();

test.describe("PR reviews — list + detail (#404)", () => {
  test.describe.configure({ timeout: 120_000 });

  let project: CreatedProject;

  test.beforeEach(async ({ page }) => {
    const { accessToken } = await primeAdminUser(API_BASE);
    project = await createProjectViaApi(API_BASE, accessToken, "e2e-pulls");

    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  test("list renders header + empty state from a 200 (no double prefix)", async ({ page }) => {
    const guard = watchForDoubleApiPrefix(page);
    const list = new PullReviewsListPage(page);

    // Arm the listener for the list query before navigating so we never miss it.
    const reviewsResponse = page.waitForResponse(
      (res) =>
        new RegExp(`/api/projects/${project.id}/pr-reviews(\\?|$)`).test(res.url()) &&
        res.request().method() === "GET",
      { timeout: 30_000 },
    );

    await list.goto(project.id);

    await test.step("header + subtitle render", async () => {
      await list.expectLoaded();
    });

    await test.step("the list query returns 200 (not a masked 404)", async () => {
      const res = await reviewsResponse;
      expect(res.status(), `GET ${res.url()} should not 404`).toBe(200);
      expect(res.url()).not.toContain("/api/api/");
      const body = (await res.json()) as { success: boolean; data: { items: unknown[] } };
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data.items)).toBe(true);
    });

    await test.step("a never-reviewed project shows the empty state + footer", async () => {
      await expect(list.emptyState()).toBeVisible({ timeout: 20_000 });
      await expect(list.errorState()).toHaveCount(0);
      await expect(list.footer()).toContainText("Showing 0 of 0 reviews");
    });

    guard.assertClean();
  });

  test("detail renders the graceful no-review surface for an unknown PR", async ({ page }) => {
    const guard = watchForDoubleApiPrefix(page);
    const detail = new PullReviewDetailPage(page);

    await detail.goto(project.id, 12345, { owner: "octo", name: "demo" });

    await test.step("back link to the list renders", async () => {
      await expect(detail.backLink).toBeVisible({ timeout: 20_000 });
    });

    await test.step("the no-review-recorded 404 surface renders gracefully", async () => {
      await expect(detail.noReviewState()).toBeVisible({ timeout: 20_000 });
    });

    guard.assertClean();
  });
});
