/**
 * Project detail settings — AI provider and model pickers.
 *
 * Verifies the per-project AI provider select and model input on
 * `/projects/[id]`. These controls were added in PR #234 and are
 * exercised here as part of the doc-parser-upgrades epic (#239) to
 * confirm they render and accept user input without regressions.
 *
 * Acceptance criteria tested:
 *   AC: AI provider picker renders with options and saves
 *   AC: AI model picker accepts free-form input and saves
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { LoginPage } from "../pages/login.page.js";
import { ProjectDetailPage } from "../pages/project.page.js";
import { apiBase } from "../fixtures/api-base.js";

const API_BASE = apiBase();

async function authedApi(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

test.describe("Project settings — AI pickers (#234)", () => {
  test.describe.configure({ timeout: 120_000 });

  let accessToken: string;
  let projectId: string;
  let projectSlug: string;

  test.beforeEach(async ({ page }) => {
    const primed = await primeAdminUser(API_BASE);
    accessToken = primed.accessToken;

    projectSlug = `e2e-settings-${Date.now()}`;
    const api = await authedApi(accessToken);
    const res = await api.post("/api/projects", {
      data: {
        name: `Settings Test ${projectSlug}`,
        slug: projectSlug,
        description: "settings e2e",
      },
    });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as { success: boolean; data: { project: { id: string } } };
    projectId = body.data.project.id;
    await api.dispose();

    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  // AC: AI provider picker renders with selectable options and saves
  test("should display AI provider picker with options", async ({ page }) => {
    await page.goto(`/projects/${projectId}/settings`, { waitUntil: "load" });
    const detail = new ProjectDetailPage(page);

    await test.step("Verify provider picker is visible", async () => {
      await expect(detail.aiProviderPicker).toBeVisible({ timeout: 15_000 });
    });

    await test.step("Verify provider select has options", async () => {
      const options = detail.aiProviderSelect.locator("option");
      // At minimum: "Global default" + at least one provider key.
      await expect(options).not.toHaveCount(0);
      await expect(
        detail.aiProviderSelect.locator("option", { hasText: "Global default" }),
      ).toBeVisible();
    });

    await test.step("Select a provider and save", async () => {
      // Pick the second option (first real provider key).
      const secondOption = detail.aiProviderSelect.locator("option").nth(1);
      const value = await secondOption.getAttribute("value");
      expect(value).toBeTruthy();
      await detail.aiProviderSelect.selectOption({ index: 1 });
      await detail.aiProviderSave.click();
      await expect(page.getByText("Saved")).toBeVisible({ timeout: 10_000 });
    });
  });

  // AC (#114): local-gemma is selectable and persists as the project provider
  test("should select local-gemma in the provider picker and persist it", async ({ page }) => {
    await page.goto(`/projects/${projectId}/settings`, { waitUntil: "load" });
    const detail = new ProjectDetailPage(page);

    await test.step("Verify provider picker is visible", async () => {
      await expect(detail.aiProviderPicker).toBeVisible({ timeout: 15_000 });
    });

    await test.step("local-gemma option is present", async () => {
      await expect(
        detail.aiProviderSelect.locator("option", { hasText: "local-gemma" }),
      ).toHaveCount(1);
    });

    await test.step("Select local-gemma and save", async () => {
      await detail.aiProviderSelect.selectOption("local-gemma");
      await detail.aiProviderSave.click();
      await expect(page.getByText("Saved")).toBeVisible({ timeout: 10_000 });
    });

    await test.step("Persisted value is local-gemma", async () => {
      const api = await authedApi(accessToken);
      const res = await api.get(`/api/projects/${projectId}`);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as {
        data: { aiProviderId: string | null };
      };
      expect(body.data.aiProviderId).toBe("local-gemma");
      await api.dispose();
    });
  });

  // AC: AI model picker accepts free-form model id and saves
  test("should accept model id in AI model picker", async ({ page }) => {
    await page.goto(`/projects/${projectId}/settings`, { waitUntil: "load" });
    const detail = new ProjectDetailPage(page);

    await test.step("Verify model picker is visible", async () => {
      await expect(detail.aiModelPicker).toBeVisible({ timeout: 15_000 });
    });

    await test.step("Enter a model id and save", async () => {
      await detail.aiModelInput.fill("us.anthropic.claude-sonnet-4-6");
      await detail.aiModelSave.click();
      await expect(page.getByText("Saved")).toBeVisible({ timeout: 10_000 });
    });

    await test.step("Clear model id and save (revert to global default)", async () => {
      await detail.aiModelInput.clear();
      await detail.aiModelSave.click();
      await expect(page.getByText("Saved")).toBeVisible({ timeout: 10_000 });
    });
  });
});
