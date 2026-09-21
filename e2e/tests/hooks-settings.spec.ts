/**
 * Regression — `/settings/hooks` must not double-prefix `/api/api/` (P0 fix on
 * `fix/sdk-alignment-api-double-prefix`).
 *
 * The hooks list query (`sdkApi.listHooks(projectId)` →
 * `/projects/:id/hooks`) only fires once a Project ID is entered (the query is
 * `enabled: !!projectId`). So the spec creates a project via the API, types its
 * id into the page's `hk-project-id` input, then asserts the resulting hooks
 * query returns 200 over the correctly-prefixed `/api/projects/:id/hooks` path.
 *
 * Before the fix this request was `/api/api/projects/:id/hooks` → 404, masked as
 * the "No subscriptions." empty state.
 *
 * Acceptance criteria:
 *   AC: entering a project id fires GET /api/projects/:id/hooks → 200 (not 404).
 *   AC: navigating /settings/hooks + querying hooks issues NO /api/api/ request.
 *   AC: the subscriptions list (or its legitimate empty state) renders from 200.
 */
import { test, expect } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { createProjectViaApi } from "../fixtures/project-helpers.js";
import { LoginPage } from "../pages/login.page.js";
import { watchForDoubleApiPrefix } from "../fixtures/no-double-api-prefix.js";

const API_BASE = apiBase();

test.describe("Settings → Hooks — no /api/api/ double prefix (#114)", () => {
  test.describe.configure({ timeout: 120_000 });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const { accessToken } = await primeAdminUser(API_BASE);
    const project = await createProjectViaApi(API_BASE, accessToken, "e2e-hooks");
    projectId = project.id;

    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  test("hooks list query succeeds (200) over the single-prefix path", async ({ page }) => {
    const guard = watchForDoubleApiPrefix(page);

    await page.goto("/settings/hooks", { waitUntil: "load" });
    await expect(page.getByTestId("hooks-root")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Hooks" })).toBeVisible();

    // Arm the response listener BEFORE typing the id so we never miss the
    // hooks query that the project-id input enables.
    const hooksResponse = page.waitForResponse(
      (res) =>
        new RegExp(`/api/projects/${projectId}/hooks(\\?|$)`).test(res.url()) &&
        res.request().method() === "GET",
      { timeout: 30_000 },
    );

    await test.step("entering a project id fires the hooks query", async () => {
      await page.getByTestId("hk-project-id").fill(projectId);
    });

    await test.step("the hooks query returns 200 (not 404)", async () => {
      const res = await hooksResponse;
      expect(res.status(), `GET ${res.url()} should not 404`).toBe(200);
      expect(res.url()).not.toContain("/api/api/");
      const body = (await res.json()) as { success: boolean; data: unknown[] };
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
    });

    await test.step("the subscriptions card renders from the 200", async () => {
      // A fresh project has no hooks, so the legitimate empty state is expected;
      // what matters is it comes from a 200, asserted above, not a masked 404.
      await expect(page.getByTestId("hooks-list")).toBeVisible();
      await expect(page.getByText("No subscriptions.", { exact: true })).toBeVisible();
    });

    guard.assertClean();
  });
});
