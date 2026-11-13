/**
 * E2E — Issue #2347 (epic #2328): the Requirements tab is the real list, and
 * the approval ladder has a way back after a rejection. Driven by the non-admin
 * analyst the definition of done names (the mock `developer` role) and a
 * reviewer (`coordinator`).
 *
 * | Acceptance criterion (#2347)                                   | Test                          |
 * |----------------------------------------------------------------|-------------------------------|
 * | the tab lists requirements across change requests, by title    | requests review … approves    |
 * | request review (analyst) and approve (coordinator) from a row  | requests review … approves    |
 * | the ladder stated where the analyst chooses                    | requests review … approves    |
 * | after a rejection, what and why, and Revise and resubmit       | revises and resubmits         |
 *
 * The run and requirements are seeded through the CLI seam the review suites
 * use; everything after that goes through the real UI as the analyst.
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

test.describe("Requirements tab and the approval ladder (#2347)", () => {
  test.describe.configure({ timeout: 180_000 });

  let projectId: string;
  let analysisId: string;
  let reqA: string;
  let reqB: string;
  const crTitle = `Checkout ladder ${Date.now()}`;

  test.beforeEach(async ({ page }) => {
    const { api: admin } = await apiAs({
      username: ADMIN_USER.username,
      password: ADMIN_USER.password,
    });
    const slug = `e2e-req-list-${Date.now()}`;
    const res = await admin.post("/api/projects", {
      data: { name: `Req list ${slug}`, slug, description: "requirements list e2e" },
    });
    expect(res.status(), await res.text()).toBe(201);
    const body = (await res.json()) as {
      id?: string;
      data?: { id?: string; project?: { id?: string } };
    };
    projectId = (body.data?.project?.id ?? body.data?.id ?? body.id) as string;

    // The reviewer must exist to be found by the reviewer search.
    await primeUser(REVIEWER);
    const { api, userId } = await apiAs(ANALYST);
    const databaseUrl = e2eDatabaseUrl();
    analysisId = seedGroundedAnalysisViaCli({ projectId, startedById: userId, databaseUrl });
    reqA = seedRequirementViaCli({ projectId, analysisId, databaseUrl });
    reqB = seedRequirementViaCli({ projectId, analysisId, databaseUrl });
    const renamed = await api.patch(`/api/projects/${projectId}/analyses/${analysisId}`, {
      data: { title: crTitle },
    });
    expect(renamed.status(), await renamed.text()).toBe(200);
    await api.dispose();

    // The seed writes approved requirements; put A back to awaiting review so
    // there is something to approve (read through the list, which carries the
    // version the guarded PUT needs).
    const page1 = await admin.get(`/api/projects/${projectId}/requirements?pageSize=100`);
    expect(page1.status(), await page1.text()).toBe(200);
    const rows = (
      (await page1.json()) as { data: { items: Array<{ id: string; version: number }> } }
    ).data.items;
    const a = rows.find((r) => r.id === reqA);
    expect(a, "seeded requirement listed").toBeTruthy();
    const reset = await admin.put(`/api/requirements/${reqA}`, {
      data: { reviewStatus: "draft", version: a!.version },
    });
    expect(reset.ok(), await reset.text()).toBeTruthy();
    await admin.dispose();

    const login = new LoginPage(page);
    await login.goto();
    await login.login(ANALYST.username, ANALYST.password);
  });

  test("requests review of one from the list, and a coordinator approves another", async ({
    page,
  }) => {
    await page.goto(`/projects/${projectId}/requirements`, { waitUntil: "load" });

    await test.step("the list shows both, each with its change request by title", async () => {
      const rowA = page.getByTestId(`requirements-row-${reqA}`);
      await expect(rowA).toBeVisible({ timeout: 30_000 });
      await expect(rowA.getByRole("link", { name: crTitle })).toBeVisible();
      await expect(page.getByTestId(`requirements-row-${reqB}`)).toBeVisible();
      await expect(page.getByTestId("approval-ladder")).toContainText("Formal review and baseline");
      await expect(page.getByTestId("approval-ladder-note")).toContainText(
        "approved ones included",
      );
    });

    await test.step("the analyst (developer) may not approve directly, and is told so", async () => {
      // #1566 — Approve and Edit are `project.update` writes, which `developer` lacks.
      await expect(page.getByTestId(`requirements-approve-${reqA}`)).toBeDisabled();
    });

    await test.step("the analyst ticks a row and requests a review of it", async () => {
      const rowB = page.getByTestId(`requirements-row-${reqB}`);
      await rowB.getByRole("checkbox").check();
      await page.getByTestId("request-review").click();
      await expect(page.getByTestId("request-review-scope")).toHaveText(
        "This review covers 1 of 1 requirement.",
      );
      await page.getByLabel("Reviewers").fill("coordinator");
      await page.getByRole("button", { name: /^Add / }).first().click();
      await page.getByRole("button", { name: /^Request review of 1 requirement$/ }).click();
      await expect(page.getByTestId("request-review-done")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId(`requirements-review-${reqB}`)).toHaveText("In review", {
        timeout: 30_000,
      });
    });

    await test.step("a coordinator approves one from its row; Approve is then gone", async () => {
      await page.context().clearCookies();
      const login = new LoginPage(page);
      await login.goto();
      await login.login(REVIEWER.username, REVIEWER.password);
      await page.goto(`/projects/${projectId}/requirements`, { waitUntil: "load" });
      await page.getByTestId(`requirements-approve-${reqA}`).click({ timeout: 30_000 });
      await expect(page.getByTestId(`requirements-status-${reqA}`)).toHaveText("Approved", {
        timeout: 30_000,
      });
      await expect(page.getByTestId(`requirements-approve-${reqA}`)).toHaveCount(0);
    });

    await test.step("the status filter narrows the list on the server", async () => {
      await page.getByTestId("requirements-filter-status").selectOption("approved");
      await expect(page.getByTestId(`requirements-row-${reqB}`)).toHaveCount(0, {
        timeout: 30_000,
      });
      await expect(page.getByTestId(`requirements-row-${reqA}`)).toBeVisible();
    });
  });

  test("after a rejection: what and why, then Revise and resubmit", async ({ page }) => {
    const { api } = await apiAs(ANALYST);
    const { api: reviewerApi, userId: reviewerId } = await apiAs(REVIEWER);
    const reviewId = await createReview(api, projectId, {
      title: `Sign off ${crTitle}`,
      reviewerIds: [reviewerId],
      requirementIds: [reqA, reqB],
    });
    await submitReview(api, reviewId);
    await recordDecision(reviewerApi, reviewId, "rejected", "Refund rules are missing");

    await page.goto(`/reviews/${reviewId}`, { waitUntil: "load" });
    await expect(page.getByTestId("review-rejected-notice")).toContainText(
      "Refund rules are missing",
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("review-rejected-notice")).toContainText(
      "including any that were already approved",
    );
    await page.getByTestId(`revise-review-${reviewId}`).click();
    const resubmit = page.getByTestId(`resubmit-review-${reviewId}`);
    await expect(resubmit).toBeVisible({ timeout: 30_000 });
    await resubmit.click();
    await expect(page.getByTestId(`resubmit-review-${reviewId}`)).toHaveCount(0, {
      timeout: 30_000,
    });
    const after = await api.get(`/api/reviews/${reviewId}`);
    const status = ((await after.json()) as { data: { review: { status: string } } }).data.review
      .status;
    expect(status).toBe("in_review");

    await Promise.all([api.dispose(), reviewerApi.dispose()]);
  });
});
