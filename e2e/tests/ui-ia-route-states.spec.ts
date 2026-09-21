/**
 * UI Information-Architecture overhaul — route states & feedback (Epic #133).
 *
 * Covers:
 *   S1 #143 — route-segment not-found state with an escape affordance
 *   S1 #143 / S2 #144 — shared Skeleton loading state announced to AT
 *                       (role="status") while a segment's data is in flight
 *   S3 #147 — user feedback is standardized on Sonner toasts
 *
 * Note on S4 #145 (secure ErrorState): the sanitizing error boundary only
 * renders on a render-time throw, which no page triggers deterministically in
 * the offline-stub stack (data-fetch failures are handled inline). Its
 * sanitization + retry/escape affordances are covered by unit tests
 * (sanitize-error + error-state RTL). Here we assert the not-found boundary —
 * now reached via notFound() on a 404 project fetch (#143) — keeps a working
 * escape affordance and leaks no stack/secret-looking text.
 */
import { test, expect } from "@playwright/test";
import { apiBase } from "../fixtures/api-base.js";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { createProjectViaApi } from "../fixtures/project-helpers.js";
import { LoginPage } from "../pages/login.page.js";

const API_BASE = apiBase();

test.describe("UI IA — route states & feedback (#133)", () => {
  test.describe.configure({ timeout: 120_000 });

  let projectId: string;
  let accessToken: string;

  test.beforeEach(async ({ page }) => {
    const primed = await primeAdminUser(API_BASE);
    accessToken = primed.accessToken;
    const project = await createProjectViaApi(API_BASE, accessToken);
    projectId = project.id;

    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  // S1 #143: a missing project (404) calls notFound(), which renders the shared
  // route-segment not-found.tsx boundary inside the app shell — so the sidebar
  // remains a working escape affordance, and nothing leaks.
  test("not-found state keeps a working escape affordance and leaks nothing", async ({ page }) => {
    await page.goto("/projects/does-not-exist-00000000", { waitUntil: "load" });

    await expect(page.getByTestId("authed-not-found")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Page not found")).toBeVisible();

    // No stack frames / absolute paths / secret-looking blobs.
    const body = (await page.locator("body").innerText()).toLowerCase();
    expect(body).not.toMatch(/\bat\s+.+\(.*:\d+:\d+\)/);
    expect(body).not.toContain("eyj"); // JWT prefix
    expect(body).not.toMatch(/sk-[a-z0-9]{8,}/);

    await test.step("the boundary's own escape link returns to the dashboard", async () => {
      await page
        .getByTestId("authed-not-found")
        .getByRole("link", { name: /back to dashboard/i })
        .click();
      await expect(page).toHaveURL(/\/dashboard$/);
    });
  });

  // S1 #143 / S2 #144: while a segment's data is loading the shared Skeleton
  // announces a polite status region.
  test("segment loading shows an announced skeleton, then content", async ({ page }) => {
    // Shape the network so the documents query stays in flight long enough to
    // observe the skeleton. This delays the response; it is not a blind sleep.
    await page.route(/\/api\/projects\/[^/]+\/documents(\?.*)?$/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.continue();
    });

    await page.goto(`/projects/${projectId}/documents`, { waitUntil: "commit" });

    const loading = page.getByRole("status").filter({ hasText: "Loading documents…" });
    await expect(loading).toBeVisible({ timeout: 10_000 });

    await page.unroute(/\/api\/projects\/[^/]+\/documents(\?.*)?$/);

    // Freshly created project → the list resolves to the empty state.
    await expect(page.getByText("No documents yet.")).toBeVisible({ timeout: 15_000 });
  });

  // S3 #147: saving autopilot settings surfaces feedback via a Sonner toast.
  test("save feedback is delivered through a Sonner toast", async ({ page }) => {
    await page.goto(`/projects/${projectId}`, { waitUntil: "load" });

    const card = page.getByTestId("autopilot-settings-card");
    await expect(card).toBeVisible({ timeout: 15_000 });

    await card.getByTestId("autopilot-toggle").check();
    await card.getByTestId("autopilot-save-button").click();

    await expect(page.getByText("Autopilot settings saved")).toBeVisible({ timeout: 10_000 });
  });
});
