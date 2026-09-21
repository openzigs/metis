/**
 * UI Information-Architecture overhaul — project tab bar (Epic #133).
 *
 * Covers:
 *   N2 #142 — the 17-item horizontal-scroll tab bar collapses to a small set of
 *             primary tabs plus a "More" overflow; every destination stays
 *             reachable
 *   N3 #141 — the project index tab is renamed "Overview"; "Documents" is split
 *             out to its own destination
 *   R1 #156 — below the `md` breakpoint the whole bar collapses to a single
 *             dropdown (no horizontal scroll)
 */
import { test, expect } from "@playwright/test";
import { apiBase } from "../fixtures/api-base.js";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { createProjectViaApi } from "../fixtures/project-helpers.js";
import { LoginPage } from "../pages/login.page.js";
import { ProjectTabsPage } from "../pages/project-tabs.page.js";

const API_BASE = apiBase();

test.describe("UI IA — project tabs (#133)", () => {
  test.describe.configure({ timeout: 120_000 });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const primed = await primeAdminUser(API_BASE);
    const project = await createProjectViaApi(API_BASE, primed.accessToken);
    projectId = project.id;

    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
    await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
  });

  // N2 #142: the bar shows a small set of primary tabs (no 17-item scroll) and
  // an explicit overflow affordance.
  test("renders a compact primary tab set plus a More overflow", async ({ page }) => {
    const tabs = new ProjectTabsPage(page);
    await tabs.expectVisible();

    await expect(tabs.primaryLink("Overview")).toBeVisible();
    await expect(tabs.primaryLink("Documents")).toBeVisible();
    await expect(tabs.primaryLink("Analysis")).toBeVisible();
    await expect(tabs.groupTrigger("Code")).toBeVisible();
    await expect(tabs.groupTrigger("Quality")).toBeVisible();
    await expect(tabs.groupTrigger("Docs")).toBeVisible();
    await expect(tabs.moreTrigger).toBeVisible();

    // Keep the inline primary set small — the whole point of N2. Count the
    // direct inline links + group triggers (excludes the dropdown contents,
    // which are not in the DOM until opened).
    const inlinePrimary = tabs.nav.locator(
      'a:visible, [data-testid^="project-tab-group-"]:visible',
    );
    const count = await inlinePrimary.count();
    expect(count).toBeLessThanOrEqual(7);
  });

  // N2 #142: a grouped tab (Code) exposes its destinations via a dropdown.
  test("grouped tab opens its destinations and navigates", async ({ page }) => {
    const tabs = new ProjectTabsPage(page);
    await tabs.expectVisible();

    await tabs.openGroup("Code");
    await expect(tabs.menuItem("Code Overview")).toBeVisible();
    await expect(tabs.menuItem("Changes")).toBeVisible();
    await expect(tabs.menuItem("Pull Requests")).toBeVisible();

    await tabs.menuItem("Changes").click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/changes$`));
  });

  // N2 #142: secondary destinations remain reachable through "More".
  test("overflow menu keeps secondary destinations reachable", async ({ page }) => {
    const tabs = new ProjectTabsPage(page);
    await tabs.expectVisible();

    await tabs.openMore();
    await expect(tabs.menuItem("Connections")).toBeVisible();
    await expect(tabs.menuItem("Usage")).toBeVisible();

    await tabs.menuItem("Usage").click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/usage$`));
  });

  // N3 #141: the index tab is "Overview" and renders the overview surface.
  test('"Overview" tab renders the project overview', async ({ page }) => {
    const tabs = new ProjectTabsPage(page);
    await tabs.expectVisible();

    await tabs.primaryLink("Overview").click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`));
    await expect(page.getByTestId("project-overview-root")).toBeVisible();
    await expect(tabs.primaryLink("Overview")).toHaveAttribute("aria-current", "page");
  });

  // N3 #141: Documents is its own destination, separate from Overview.
  test('"Documents" tab is split out to its own surface', async ({ page }) => {
    const tabs = new ProjectTabsPage(page);
    await tabs.expectVisible();

    await tabs.primaryLink("Documents").click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/documents$`));
    await expect(page.getByTestId("project-documents-root")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Documents", level: 1 })).toBeVisible();
  });

  // R1 #156: below `md` the bar collapses into a single dropdown.
  test("collapses to a single dropdown below the md breakpoint", async ({ page }) => {
    const tabs = new ProjectTabsPage(page);
    await tabs.expectVisible();

    await test.step("desktop viewport shows inline tabs, not the mobile dropdown", async () => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await expect(tabs.primaryLink("Overview")).toBeVisible();
      await expect(tabs.moreTrigger).toBeVisible();
      await expect(tabs.mobileTrigger).toBeHidden();
    });

    await test.step("sub-md viewport collapses to the dropdown", async () => {
      await page.setViewportSize({ width: 640, height: 800 });
      await expect(tabs.mobileTrigger).toBeVisible();
      await expect(tabs.primaryLink("Overview")).toBeHidden();
      await expect(tabs.moreTrigger).toBeHidden();
    });

    await test.step("the dropdown exposes every destination", async () => {
      await tabs.openMobileMenu();
      await expect(tabs.menuItem("Overview")).toBeVisible();
      await expect(tabs.menuItem("Documents")).toBeVisible();
      await expect(tabs.menuItem("Usage")).toBeVisible();
    });
  });
});
