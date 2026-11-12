/**
 * E2E — Issue #2341 (epic #2328): the change request.
 *
 * "New change request" on the project's Change requests tab starts a titled
 * run in one flow with "Run with defaults"; the run is listed by its title, its
 * page opens with the title, the settings it ran with and the eight-step header,
 * it can be renamed in place, and Publish names it by title.
 *
 * The run's outcome does not matter here (the e2e stack runs offline), only
 * that it exists under the name it was given.
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { LoginPage } from "../pages/login.page.js";
import { apiBase } from "../fixtures/api-base.js";

const API_BASE = apiBase();

async function authedApi(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

test.describe("Change request — titled, run with defaults, renamed (#2341)", () => {
  test.describe.configure({ timeout: 120_000 });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const primed = await primeAdminUser(API_BASE);
    const slug = `e2e-change-request-${Date.now()}`;
    const api = await authedApi(primed.accessToken);
    const res = await api.post("/api/projects", {
      data: { name: `Change request ${slug}`, slug, description: "change request e2e" },
    });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as {
      id?: string;
      data?: { id?: string; project?: { id?: string } };
    };
    projectId = (body.data?.project?.id ?? body.data?.id ?? body.id) as string;
    expect(projectId).toBeTruthy();
    await api.dispose();

    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);
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
      await expect(page.getByRole("heading", { name: "New change request" })).toBeVisible();
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

    await test.step("rename it in place", async () => {
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
});
