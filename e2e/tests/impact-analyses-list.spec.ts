/**
 * Coverage — Impact analyses list at `/impact-analyses` and the `/new` entry
 * point (Epic #159 / #166 / #164).
 *
 * The list page renders a table of analyses or its empty state from
 * `GET /api/impact-analyses`. The "New analysis" button links to
 * `/impact-analyses/new`, which renders the create form (document-source
 * selector + multi-project picker + run button).
 *
 * Acceptance criteria:
 *   AC: /impact-analyses renders its list table OR empty state from a 200.
 *   AC: the "New analysis" CTA navigates to /impact-analyses/new.
 *   AC: /impact-analyses/new renders the create form scaffold.
 *   AC: neither page issues a /api/api/ double-prefixed request.
 */
import { test, expect } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { watchForDoubleApiPrefix } from "../fixtures/no-double-api-prefix.js";

const API_BASE = apiBase();

test.describe("Impact analyses list (#166) + new entry point (#164)", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await primeAdminUser(API_BASE);
    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  test("lists analyses (or empty state) and links into the new-analysis form", async ({ page }) => {
    const guard = watchForDoubleApiPrefix(page);

    const listResponse = page.waitForResponse(
      (res) => /\/api\/impact-analyses(\?|$)/.test(res.url()) && res.request().method() === "GET",
      { timeout: 30_000 },
    );

    await page.goto("/impact-analyses", { waitUntil: "load" });

    await test.step("the list query returns 200", async () => {
      const res = await listResponse;
      expect(res.status(), `GET ${res.url()} should not 404`).toBe(200);
      expect(res.url()).not.toContain("/api/api/");
    });

    await test.step("the list scaffold renders the table or the empty state", async () => {
      await expect(page.getByTestId("impact-list-root")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Impact analysis" })).toBeVisible();
      const table = page.getByTestId("impact-list-table");
      const empty = page.getByTestId("impact-list-empty");
      await expect
        .poll(async () => (await table.isVisible()) || (await empty.isVisible()))
        .toBe(true);
    });

    await test.step("the New analysis CTA routes to the create form", async () => {
      await page.getByTestId("impact-list-new").click();
      await expect(page).toHaveURL(/\/impact-analyses\/new$/);
      await expect(page.getByTestId("impact-new-root")).toBeVisible();
      await expect(page.getByRole("heading", { name: "New impact analysis" })).toBeVisible();
      // The schema-impact toggle is part of the working create form.
      await expect(page.getByTestId("impact-new-schema-toggle")).toBeVisible();
    });

    guard.assertClean();
  });
});
