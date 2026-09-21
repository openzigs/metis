/**
 * Coverage — Top-level cross-project connector catalogues (Epic #196 / #224).
 *
 *   /databases    — every database connector across accessible projects.
 *   /repositories — every repo connector across accessible projects.
 *
 * Both pages list projects via `GET /api/projects` then fan out to the
 * per-project connector route. A project freshly created in the test appears
 * in the "Filter by project" select. With no connectors wired, the list card
 * settles on its empty state (not an infinite "Loading…"); the spec asserts
 * the header, the filter control (incl. the new project as an option), and
 * that the list resolves to a terminal state — all without a /api/api/
 * double prefix and with the projects query returning 200.
 *
 * Acceptance criteria:
 *   AC: each page renders its heading + filter card + list card.
 *   AC: the "Filter by project" select contains "All projects" + the seeded
 *       project name.
 *   AC: the list resolves to a terminal empty state (no infinite loading).
 *   AC: GET /api/projects returns 200 and no /api/api/ request is issued.
 */
import { test, expect, type Page } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { createProjectViaApi, type CreatedProject } from "../fixtures/project-helpers.js";
import { LoginPage } from "../pages/login.page.js";
import { watchForDoubleApiPrefix } from "../fixtures/no-double-api-prefix.js";
import { DatabasesTopPage, RepositoriesTopPage } from "../pages/global-connectors.page.js";

const API_BASE = apiBase();

async function awaitProjectsList(page: Page) {
  return page.waitForResponse(
    (res) => /\/api\/projects(\?|$)/.test(res.url()) && res.request().method() === "GET",
    { timeout: 30_000 },
  );
}

test.describe("Global connector catalogues (#224)", () => {
  test.describe.configure({ timeout: 120_000 });

  let project: CreatedProject;

  test.beforeEach(async ({ page }) => {
    const { accessToken } = await primeAdminUser(API_BASE);
    project = await createProjectViaApi(API_BASE, accessToken, "e2e-globalconn");

    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  test("/databases renders header, filter, and a terminal list state", async ({ page }) => {
    const guard = watchForDoubleApiPrefix(page);
    const dbs = new DatabasesTopPage(page);

    const projectsResponse = awaitProjectsList(page);
    await dbs.goto();
    await dbs.expectLoaded();

    await test.step("the projects query returns 200", async () => {
      const res = await projectsResponse;
      expect(res.status()).toBe(200);
      expect(res.url()).not.toContain("/api/api/");
    });

    await test.step("filter control lists All projects + the new project", async () => {
      await expect(dbs.controls).toBeVisible();
      await expect(dbs.projectFilter).toBeVisible();
      await expect(dbs.projectFilter.locator("option", { hasText: "All projects" })).toHaveCount(1);
      await expect(dbs.projectFilter.locator("option", { hasText: project.name })).toHaveCount(1);
    });

    await test.step("the list resolves to its empty state (no infinite loading)", async () => {
      await expect(dbs.listCard).toBeVisible();
      await expect(dbs.emptyState()).toBeVisible({ timeout: 20_000 });
    });

    guard.assertClean();
  });

  test("/repositories renders header, filter, and a terminal list state", async ({ page }) => {
    const guard = watchForDoubleApiPrefix(page);
    const repos = new RepositoriesTopPage(page);

    const projectsResponse = awaitProjectsList(page);
    await repos.goto();
    await repos.expectLoaded();

    await test.step("the projects query returns 200", async () => {
      const res = await projectsResponse;
      expect(res.status()).toBe(200);
      expect(res.url()).not.toContain("/api/api/");
    });

    await test.step("filter control lists All projects + the new project", async () => {
      await expect(repos.controls).toBeVisible();
      await expect(repos.projectFilter).toBeVisible();
      await expect(repos.projectFilter.locator("option", { hasText: "All projects" })).toHaveCount(
        1,
      );
      await expect(repos.projectFilter.locator("option", { hasText: project.name })).toHaveCount(1);
    });

    await test.step("the list resolves to its empty state (no infinite loading)", async () => {
      await expect(repos.listCard).toBeVisible();
      await expect(repos.emptyState()).toBeVisible({ timeout: 20_000 });
    });

    guard.assertClean();
  });
});
