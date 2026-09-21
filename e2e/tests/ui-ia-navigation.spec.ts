/**
 * UI Information-Architecture overhaul — navigation & layout (Epic #133).
 *
 * Covers:
 *   N1 #140 — grouped sidebar sections (Work / Knowledge / Automation / Platform)
 *   N5 #153 — platform resources (Vault/Repositories/Databases/MCP) live ONLY in
 *             the sidebar, not duplicated as Settings-hub management cards
 *   N6 #154 — nested settings layout persists the secondary nav across sub-pages
 *   N7 #152 — consolidated breadcrumb hierarchy (Workspace › Project) replaces
 *             the former dual header switcher
 *
 * All locators are user-facing (role / label / testid); all assertions are
 * web-first.
 */
import { test, expect } from "@playwright/test";
import { apiBase } from "../fixtures/api-base.js";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { createProjectViaApi } from "../fixtures/project-helpers.js";
import { LoginPage } from "../pages/login.page.js";
import { AppShellPage, SIDEBAR_SECTIONS } from "../pages/app-shell.page.js";
import { SettingsHubPage } from "../pages/settings-hub.page.js";

const API_BASE = apiBase();

test.describe("UI IA — navigation & layout (#133)", () => {
  test.describe.configure({ timeout: 120_000 });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const primed = await primeAdminUser(API_BASE);
    const project = await createProjectViaApi(API_BASE, primed.accessToken);
    projectId = project.id;

    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  // N1 #140: the sidebar renders four labeled sections.
  test("sidebar renders the four grouped sections", async ({ page }) => {
    const shell = new AppShellPage(page);
    await page.goto("/dashboard", { waitUntil: "load" });
    await shell.expectLoaded();

    for (const section of SIDEBAR_SECTIONS) {
      await expect(shell.sectionHeading(section)).toBeVisible();
    }
  });

  // N1 #140: representative links in each section navigate to the right route.
  test("sidebar links navigate to their routes", async ({ page }) => {
    const shell = new AppShellPage(page);
    await page.goto("/dashboard", { waitUntil: "load" });
    await shell.expectLoaded();

    const cases: Array<[string, RegExp]> = [
      ["Projects", /\/projects$/], // Work
      ["Library", /\/library$/], // Knowledge
      ["Skills", /\/skills$/], // Automation
      ["Vault", /\/vault$/], // Platform
    ];

    for (const [label, urlRe] of cases) {
      await test.step(`navigate via "${label}"`, async () => {
        await shell.navLink(label).click();
        await expect(page).toHaveURL(urlRe);
      });
    }
  });

  // N3 #141 reachability: the split-out "Documents" surface is a sidebar
  // destination under the Knowledge section.
  test('"Documents" is reachable from the Knowledge section', async ({ page }) => {
    const shell = new AppShellPage(page);
    await page.goto("/dashboard", { waitUntil: "load" });
    await shell.expectLoaded();

    await expect(shell.sectionHeading("Knowledge")).toBeVisible();
    await shell.navLink("Documents").click();
    await expect(page).toHaveURL(/\/documents$/);
  });

  // N5 #153: the Settings hub must NOT carry duplicate platform-resource
  // management cards — those live only in the sidebar.
  test("settings hub does not duplicate platform resources", async ({ page }) => {
    const settings = new SettingsHubPage(page);
    await settings.goto();
    await expect(settings.hubRoot).toBeVisible({ timeout: 15_000 });

    // No management cards for vault / repositories / databases in the hub.
    await expect(page.getByTestId("settings-hub-link-vault")).toHaveCount(0);
    await expect(page.getByTestId("settings-hub-link-repositories")).toHaveCount(0);
    await expect(page.getByTestId("settings-hub-link-databases")).toHaveCount(0);

    // The Integrations card explicitly points users at the sidebar instead.
    await expect(settings.hubLink("settings-hub-link-integrations")).toContainText(
      /live in the sidebar/i,
    );

    // …and the canonical homes really are in the sidebar.
    const shell = new AppShellPage(page);
    await expect(shell.sectionHeading("Platform")).toBeVisible();
    await expect(shell.navLink("Vault")).toBeVisible();
    await expect(shell.navLink("Repositories")).toBeVisible();
    await expect(shell.navLink("Databases")).toBeVisible();
  });

  // N6 #154: the nested settings layout keeps a persistent secondary nav
  // across settings sub-pages, and the active item tracks the route.
  test("settings secondary nav persists across sub-pages", async ({ page }) => {
    const settings = new SettingsHubPage(page);

    await page.goto("/settings/profile", { waitUntil: "load" });
    await expect(settings.settingsLayout).toBeVisible({ timeout: 15_000 });
    await expect(settings.settingsNav).toBeVisible();
    await expect(settings.navLink("Profile")).toHaveAttribute("aria-current", "page");

    await test.step("navigate to Appearance — nav persists, active item updates", async () => {
      await settings.navLink("Appearance").click();
      await expect(page).toHaveURL(/\/settings\/appearance$/);
      await expect(settings.settingsNav).toBeVisible();
      await expect(settings.navLink("Appearance")).toHaveAttribute("aria-current", "page");
      await expect(settings.navLink("Profile")).not.toHaveAttribute("aria-current", "page");
    });

    await test.step("navigate to Notifications — nav still persists", async () => {
      await settings.navLink("Notifications").click();
      await expect(page).toHaveURL(/\/settings\/notifications$/);
      await expect(settings.settingsNav).toBeVisible();
      await expect(settings.navLink("Notifications")).toHaveAttribute("aria-current", "page");
    });
  });

  // N7 #152: a single breadcrumb (Workspace › Project) replaces the two
  // adjacent header switchers.
  test("header shows one consolidated breadcrumb, not a dual switcher", async ({ page }) => {
    const shell = new AppShellPage(page);
    await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
    await shell.expectLoaded();

    // Exactly one breadcrumb landmark in the header.
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toHaveCount(1);

    // Both crumbs live inside that single breadcrumb container.
    await expect(shell.workspaceCrumb).toBeVisible();
    await expect(shell.projectCrumb).toBeVisible();

    // The project crumb reflects the active project (single switcher, not two).
    await expect(shell.projectCrumb).toHaveCount(1);
  });
});
