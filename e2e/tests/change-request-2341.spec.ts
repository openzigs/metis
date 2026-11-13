/**
 * E2E — Issue #2341 (epic #2328): the change request, driven by the non-admin
 * analyst the definition of done names (the mock `developer` role: it holds
 * `analysis.run`, which starts and renames a change request, `issue.draft` and
 * `review.create`, and none of the admin permissions).
 *
 * | Test plan item (#2341)                                | Test                                         |
 * |-------------------------------------------------------|----------------------------------------------|
 * | start a change request with defaults                  | starts … and finds it by title               |
 * | see it by title in the run list                       | starts … and finds it by title               |
 * | the step header, keyboard reachable                   | starts … and finds it by title               |
 * | rename (an analyst may; analysis.run)                 | starts … and finds it by title               |
 * | Publish shows the title                               | starts … and finds it by title               |
 * | Docs scope shows the title                            | Docs scope and Reviews name a run by title   |
 * | Reviews show the title                                | Docs scope and Reviews name a run by title   |
 *
 * The live run's outcome does not matter (the e2e stack runs offline, so it
 * ends `failed`), only that it exists under the name it was given. Docs scope
 * lists COMPLETED runs only, and a review needs a requirement, so the second
 * test seeds a completed run and a requirement through the CLI seam the review
 * suite uses, then names the run through the real rename route as the analyst.
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER } from "../fixtures/seed-user.js";
import { LoginPage } from "../pages/login.page.js";
import { apiBase } from "../fixtures/api-base.js";
import { REVIEWER, createReview, e2eDatabaseUrl, primeUser } from "../fixtures/review-helpers.js";
import { seedGroundedAnalysisViaCli, seedRequirementViaCli } from "../fixtures/seed-helpers.js";

const API_BASE = apiBase();
/** The non-admin analyst (`server/src/lib/auth/mock-provider.ts`). */
const ANALYST = { username: "developer", password: "password" } as const;

async function apiAs(creds: { username: string; password: string }): Promise<{
  api: APIRequestContext;
  userId: string;
}> {
  const { accessToken, userId } = await primeUser(creds);
  const api = await request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
  });
  return { api, userId };
}

test.describe("Change request — titled, run with defaults, renamed, by an analyst (#2341)", () => {
  test.describe.configure({ timeout: 120_000 });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    // The admin creates the project with no workspace, so it is open to the
    // analyst too; everything after this is the analyst's.
    const { api: admin } = await apiAs({
      username: ADMIN_USER.username,
      password: ADMIN_USER.password,
    });
    const slug = `e2e-change-request-${Date.now()}`;
    const res = await admin.post("/api/projects", {
      data: { name: `Change request ${slug}`, slug, description: "change request e2e" },
    });
    expect(res.status(), await res.text()).toBe(201);
    const body = (await res.json()) as {
      id?: string;
      data?: { id?: string; project?: { id?: string } };
    };
    projectId = (body.data?.project?.id ?? body.data?.id ?? body.id) as string;
    expect(projectId).toBeTruthy();
    await admin.dispose();

    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(ANALYST.username, ANALYST.password);
  });

  test("starts a change request with defaults and finds it by title", async ({ page }) => {
    const title = `Checkout v2 ${Date.now()}`;
    const renamed = `${title} (renamed)`;

    await test.step("New change request: a title, then Run with defaults", async () => {
      await page.goto(`/projects/${projectId}/analysis`, { waitUntil: "load" });
      const toggle = page.getByTestId("start-analysis-toggle");
      await expect(toggle).toBeVisible({ timeout: 30_000 });
      await expect(toggle).toHaveText(/change request/);
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
      await expect(
        page.getByRole("heading", { name: "New change request", exact: true }),
      ).toBeVisible();
      // The up-front decisions are behind Options, closed.
      await expect(page.getByTestId("change-request-options-toggle")).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      await page.getByTestId("change-request-title-input").fill(title);
      await page.getByRole("button", { name: "Run with defaults" }).click();
    });

    await test.step("the run list and the page show the title, and the defaults used", async () => {
      await expect(page.getByTestId("analysis-past-run-title").first()).toHaveText(title, {
        timeout: 30_000,
      });
      await expect(page.getByTestId("change-request-title")).toHaveText(title);
      await expect(page.getByTestId("change-request-settings")).toContainText("Run with defaults");
    });

    await test.step("the step header lists eight steps, each state in words", async () => {
      const steps = page.getByRole("navigation", { name: "Change request steps" });
      await expect(steps.getByRole("link")).toHaveCount(8);
      await expect(steps.getByRole("link").first()).toContainText("1. Read");
      await expect(steps.getByRole("link").last()).toContainText("8. Hand-off");
      // Keyboard: a step is a focusable link.
      await steps.getByRole("link").first().focus();
      await expect(steps.getByRole("link").first()).toBeFocused();
    });

    await test.step("the analyst renames it in place", async () => {
      await page.getByRole("button", { name: "Rename change request" }).click();
      await page.getByTestId("change-request-rename-input").fill(renamed);
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByTestId("change-request-title")).toHaveText(renamed);
      await expect(page.getByTestId("analysis-past-run-title").first()).toHaveText(renamed);
    });

    await test.step("Publish names the run by its title", async () => {
      await page.goto(`/projects/${projectId}/publish`, { waitUntil: "load" });
      await expect(
        page.getByTestId("publish-analysis-select").locator("option", { hasText: renamed }),
      ).toHaveCount(1, { timeout: 30_000 });
    });
  });

  test("Docs scope and Reviews name a run by its title", async ({ page }) => {
    const title = `Refund policy ${Date.now()}`;
    const { api, userId } = await apiAs(ANALYST);
    const { userId: reviewerId } = await primeUser(REVIEWER);
    const databaseUrl = e2eDatabaseUrl();
    let reviewId = "";

    await test.step("seed a completed run and a requirement; the analyst names the run", async () => {
      const analysisId = seedGroundedAnalysisViaCli({
        projectId,
        startedById: userId,
        databaseUrl,
      });
      const requirementId = seedRequirementViaCli({ projectId, analysisId, databaseUrl });
      const renamed = await api.patch(`/api/projects/${projectId}/analyses/${analysisId}`, {
        data: { title },
      });
      expect(renamed.status(), await renamed.text()).toBe(200);
      reviewId = await createReview(api, projectId, {
        title: `Sign off ${title}`,
        reviewerIds: [reviewerId],
        requirementIds: [requirementId],
      });
    });

    await test.step("the Docs scope dropdown names the run by its title, the date after it", async () => {
      await page.goto(`/projects/${projectId}/documentation`, { waitUntil: "load" });
      await page.getByTestId("generate-docs-btn").click();
      await page.getByTestId("doc-scope-select").selectOption("requirements");
      const option = page.getByTestId("analysis-run-select").locator("option", { hasText: title });
      await expect(option).toHaveCount(1, { timeout: 30_000 });
      await expect(option).toHaveText(new RegExp(`^${title} · Run #\\d+ — `));
    });

    await test.step("the analyst's Reviews list names the review's change request", async () => {
      await page.goto("/reviews", { waitUntil: "load" });
      await page.getByTestId("reviews-tab-requested").click();
      await expect(page.getByTestId(`review-change-requests-${reviewId}`)).toHaveText(
        `Change request: ${title}`,
        { timeout: 30_000 },
      );
    });

    await api.dispose();
  });
});
