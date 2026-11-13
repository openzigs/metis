/**
 * E2E — Issue #2343 (epic #2328): tell the analyst when something needs them,
 * driven by the non-admin analyst the definition of done names (the mock
 * `developer` role) and a reviewer (`coordinator`).
 *
 * | Acceptance criterion (#2343)                                   | Test                                   |
 * |----------------------------------------------------------------|----------------------------------------|
 * | a finished (or failed) analysis leaves a bell item that lands  | a change request that ends …           |
 * | on the change request                                          |                                        |
 * | "Review assigned to you" as a state on the change request      | the reviewer and the analyst see …     |
 * | "Your review request was rejected" as a state, and a bell item | the reviewer and the analyst see …     |
 * | that lands on the review                                       |                                        |
 *
 * The e2e stack runs offline, so a live run ends `failed`: the bell item says
 * so in plain words and still lands on the change request, where it can be
 * started again. Either outcome is accepted, since only the landing is under
 * test. The review states use a seeded completed run and requirement, through
 * the CLI seam the review suites use.
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER } from "../fixtures/seed-user.js";
import { LoginPage } from "../pages/login.page.js";
import { apiBase } from "../fixtures/api-base.js";
import {
  REVIEWER,
  createReview,
  e2eDatabaseUrl,
  primeUser,
  recordDecision,
  submitReview,
  waitForNotification,
} from "../fixtures/review-helpers.js";
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

/** The first of the analyst's job notifications about this project, once one arrives. */
async function jobNotification(
  api: APIRequestContext,
  projectId: string,
  timeoutMs = 90_000,
): Promise<{ type: string; title: string; href: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await api.get("/api/notifications");
    if (res.ok()) {
      const items =
        (
          (await res.json()) as {
            data?: { notifications?: Array<{ type: string; title: string; href: string | null }> };
          }
        ).data?.notifications ?? [];
      const found = items.find(
        (n) => n.type.startsWith("job_") && (n.href ?? "").startsWith(`/projects/${projectId}/`),
      );
      if (found) return { type: found.type, title: found.title, href: found.href as string };
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`no job notification for project ${projectId} within ${timeoutMs}ms`);
}

test.describe("Telling the analyst when something needs them (#2343)", () => {
  test.describe.configure({ timeout: 180_000 });

  let projectId: string;

  test.beforeEach(async () => {
    // The admin creates the project with no workspace, so it is open to the
    // analyst and the reviewer; everything after this is theirs.
    const { api: admin } = await apiAs({
      username: ADMIN_USER.username,
      password: ADMIN_USER.password,
    });
    const slug = `e2e-job-notify-${Date.now()}`;
    const res = await admin.post("/api/projects", {
      data: { name: `Job notify ${slug}`, slug, description: "job notifications e2e" },
    });
    expect(res.status(), await res.text()).toBe(201);
    const body = (await res.json()) as {
      id?: string;
      data?: { id?: string; project?: { id?: string } };
    };
    projectId = (body.data?.project?.id ?? body.data?.id ?? body.id) as string;
    expect(projectId).toBeTruthy();
    await admin.dispose();
  });

  test("a change request that ends leaves a bell item that lands on it", async ({ page }) => {
    const title = `Checkout notify ${Date.now()}`;
    const { api } = await apiAs(ANALYST);

    await test.step("the analyst starts a change request with defaults", async () => {
      const login = new LoginPage(page);
      await login.goto();
      await login.login(ANALYST.username, ANALYST.password);
      await page.goto(`/projects/${projectId}/analysis`, { waitUntil: "load" });
      const toggle = page.getByTestId("start-analysis-toggle");
      await expect(toggle).toBeVisible({ timeout: 30_000 });
      if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
      await page.getByTestId("change-request-title-input").fill(title);
      await page.getByRole("button", { name: "Run with defaults" }).click();
      await expect(page.getByTestId("analysis-past-run-title").first()).toHaveText(title, {
        timeout: 30_000,
      });
    });

    let href = "";
    await test.step("when it ends, a bell row names it and links to it", async () => {
      const note = await jobNotification(api, projectId);
      expect(["job_completed", "job_failed"]).toContain(note.type);
      expect(note.title).toContain(`Change request "${title}"`);
      expect(note.href).toMatch(new RegExp(`^/projects/${projectId}/analysis\\?analysisId=`));
      href = note.href;
    });

    await test.step("away from the project, the bell item lands on the change request", async () => {
      await page.goto("/", { waitUntil: "load" });
      await page.getByTestId("notifications-bell").click();
      const list = page.getByTestId("notifications-list");
      await expect(list).toContainText(`Change request "${title}"`, { timeout: 30_000 });
      await list
        .locator("li", { hasText: `Change request "${title}"` })
        .getByRole("link", { name: /Open/ })
        .click();
      await expect(page).toHaveURL(new RegExp(href.replace(/[?]/g, "\\?")));
      await expect(page.getByTestId("change-request-title")).toHaveText(title, {
        timeout: 30_000,
      });
    });

    await api.dispose();
  });

  test("the reviewer and the analyst see the review's state on the change request", async ({
    page,
  }) => {
    const { api: analystApi, userId: analystId } = await apiAs(ANALYST);
    const { api: reviewerApi, userId: reviewerId } = await apiAs(REVIEWER);
    const databaseUrl = e2eDatabaseUrl();
    const analysisId = seedGroundedAnalysisViaCli({
      projectId,
      startedById: analystId,
      databaseUrl,
    });
    const requirementId = seedRequirementViaCli({ projectId, analysisId, databaseUrl });
    const reviewTitle = `Sign off ${Date.now()}`;
    const reviewId = await createReview(analystApi, projectId, {
      title: reviewTitle,
      reviewerIds: [reviewerId],
      requirementIds: [requirementId],
    });
    await submitReview(analystApi, reviewId);
    const runPage = `/projects/${projectId}/analysis?analysisId=${analysisId}`;

    await test.step("the reviewer sees 'Review assigned to you', linked to the review", async () => {
      const login = new LoginPage(page);
      await login.goto();
      await login.login(REVIEWER.username, REVIEWER.password);
      await page.goto(runPage, { waitUntil: "load" });
      const assigned = page.getByTestId("change-request-review-assigned");
      await expect(assigned).toContainText("Review assigned to you", { timeout: 30_000 });
      await expect(assigned).toContainText(reviewTitle);
      await expect(assigned.getByRole("link", { name: "Open review" })).toHaveAttribute(
        "href",
        `/reviews/${reviewId}`,
      );
      const note = await waitForNotification(reviewerApi, "review_requested");
      expect(note.title).toBe("Review assigned to you");
    });

    await test.step("after a rejection the analyst sees it on the change request", async () => {
      await recordDecision(reviewerApi, reviewId, "rejected", "Needs the refund rules");
      await page.context().clearCookies();
      const login = new LoginPage(page);
      await login.goto();
      await login.login(ANALYST.username, ANALYST.password);
      await page.goto(runPage, { waitUntil: "load" });
      await expect(page.getByTestId("change-request-review-rejected")).toContainText(
        "Your review request was rejected",
        { timeout: 30_000 },
      );
      const note = await waitForNotification(analystApi, "review_rejected");
      expect(note.title).toBe("Your review request was rejected");
    });

    await Promise.all([analystApi.dispose(), reviewerApi.dispose()]);
  });
});
