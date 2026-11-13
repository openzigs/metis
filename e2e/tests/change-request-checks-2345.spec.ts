/**
 * E2E — Issue #2345 (epic #2328): impact analysis and the portfolio check on
 * the change request's path, driven by the non-admin analyst the definition of
 * done names (the mock `developer` role: it holds `analysis.run`, and none of
 * the admin permissions).
 *
 * | Test plan item (#2345)                                         | Step                                   |
 * |----------------------------------------------------------------|----------------------------------------|
 * | start an impact analysis from a change request, typing nothing | Run impact analysis from the card      |
 * | start a portfolio check from a change request                  | Run portfolio check from the card      |
 * | each result is listed on the change request, newest first      | both lists show a Latest result        |
 * | a result links back to its change request; one click returns   | open each result, click back           |
 *
 * The e2e stack runs offline, so a result's outcome does not matter (it may end
 * `failed`), only that it exists, is linked to the change request and links
 * back. A completed run and an approved requirement are seeded through the CLI
 * seam the other suites use.
 */
import { test, expect, request } from "@playwright/test";
import { ADMIN_USER } from "../fixtures/seed-user.js";
import { LoginPage } from "../pages/login.page.js";
import { apiBase } from "../fixtures/api-base.js";
import { e2eDatabaseUrl, primeUser } from "../fixtures/review-helpers.js";
import { seedGroundedAnalysisViaCli, seedRequirementViaCli } from "../fixtures/seed-helpers.js";

const API_BASE = apiBase();
/** The non-admin analyst (`server/src/lib/auth/mock-provider.ts`). */
const ANALYST = { username: "developer", password: "password" } as const;

test.describe("Change request — impact and portfolio from its page, by an analyst (#2345)", () => {
  test.describe.configure({ timeout: 120_000 });

  test("starts both checks from the change request and returns to it from each result", async ({
    page,
  }) => {
    const title = `Password reset ${Date.now()}`;
    let projectId = "";
    let analysisId = "";

    await test.step("seed a project, a completed change request and a requirement", async () => {
      const { accessToken: adminToken } = await primeUser({
        username: ADMIN_USER.username,
        password: ADMIN_USER.password,
      });
      const admin = await request.newContext({
        baseURL: API_BASE,
        extraHTTPHeaders: { Authorization: `Bearer ${adminToken}` },
      });
      const slug = `e2e-cr-checks-${Date.now()}`;
      const res = await admin.post("/api/projects", {
        data: { name: `Change request checks ${slug}`, slug, description: "#2345 e2e" },
      });
      expect(res.status(), await res.text()).toBe(201);
      const body = (await res.json()) as {
        id?: string;
        data?: { id?: string; project?: { id?: string } };
      };
      projectId = (body.data?.project?.id ?? body.data?.id ?? body.id) as string;
      await admin.dispose();

      const { accessToken, userId } = await primeUser(ANALYST);
      const databaseUrl = e2eDatabaseUrl();
      analysisId = seedGroundedAnalysisViaCli({ projectId, startedById: userId, databaseUrl });
      seedRequirementViaCli({ projectId, analysisId, databaseUrl });
      const api = await request.newContext({
        baseURL: API_BASE,
        extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
      });
      const renamed = await api.patch(`/api/projects/${projectId}/analyses/${analysisId}`, {
        data: { title },
      });
      expect(renamed.status(), await renamed.text()).toBe(200);
      await api.dispose();

      const loginPage = new LoginPage(page);
      await loginPage.goto();
      await loginPage.login(ANALYST.username, ANALYST.password);
    });

    const changeRequestPage = `/projects/${projectId}/analysis?analysisId=${analysisId}`;
    const card = page.getByTestId("change-request-checks");

    await test.step("Run impact analysis from the card: the result is listed on it", async () => {
      await page.goto(changeRequestPage, { waitUntil: "load" });
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("change-request-checks-source")).toContainText("1 requirement");
      await page.getByTestId("change-request-run-impact").click();
      await expect(page.getByTestId("change-request-impact-result").first()).toContainText(
        "Latest",
        { timeout: 30_000 },
      );
    });

    await test.step("Run portfolio check from the card: the result is listed on it", async () => {
      await page.getByTestId("change-request-run-portfolio").click();
      await expect(page.getByTestId("change-request-portfolio-result").first()).toContainText(
        "Latest",
        { timeout: 30_000 },
      );
      // The seeded requirement is approved: the check is not labelled pre-approval.
      await expect(page.getByTestId("portfolio-pre-approval")).toHaveCount(0);
    });

    await test.step("the impact result links back to the change request in one click", async () => {
      await page.getByTestId("change-request-impact-result").first().getByRole("link").click();
      const back = page.getByTestId("impact-detail-back");
      await expect(back).toContainText(`Back to the change request: ${title}`, {
        timeout: 30_000,
      });
      await back.click();
      await expect(page.getByTestId("change-request-title")).toHaveText(title, {
        timeout: 30_000,
      });
    });

    await test.step("the portfolio result links back to the change request in one click", async () => {
      await page.getByTestId("change-request-portfolio-result").first().getByRole("link").click();
      const back = page.getByTestId("portfolio-detail-back-to-change-request");
      await expect(back).toContainText(`Back to the change request: ${title}`, {
        timeout: 30_000,
      });
      await back.click();
      await expect(page.getByTestId("change-request-title")).toHaveText(title, {
        timeout: 30_000,
      });
    });

    await test.step("the Impact and Portfolio steps link to the newest results", async () => {
      await expect(page.getByTestId("change-request-step-impact")).toHaveAttribute(
        "href",
        /^\/impact-analyses\//,
      );
      await expect(page.getByTestId("change-request-step-portfolio")).toHaveAttribute(
        "href",
        /^\/portfolio\//,
      );
    });
  });
});
