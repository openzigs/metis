/**
 * UI Information-Architecture overhaul — navigation & layout (Epic #133).
 *
 * Covers:
 *   #27     — six object-level sidebar entries (Home / Projects / Chat /
 *             Activity / Library / Settings); the pages they absorbed are hub
 *             tabs and keep their URLs (replaces N1 #140's grouped sections)
 *   N5 #153 — platform resources (Vault/Repositories/Databases/MCP) have their
 *             own pages, not duplicated as Settings-hub management cards
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
import { AppShellPage, SIDEBAR_ENTRIES } from "../pages/app-shell.page.js";
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

  // #27: the sidebar is one flat level of six object-level destinations.
  test("sidebar renders six destinations and no section headings", async ({ page }) => {
    const shell = new AppShellPage(page);
    await page.goto("/dashboard", { waitUntil: "load" });
    await shell.expectLoaded();

    await expect(shell.sidebar.getByRole("link")).toHaveCount(SIDEBAR_ENTRIES.length);
    for (const entry of SIDEBAR_ENTRIES) {
      await expect(shell.navLink(entry)).toBeVisible();
    }
    await expect(shell.sidebar.getByRole("heading")).toHaveCount(0);
  });

  // #27: each sidebar entry lands on its first page.
  test("sidebar links navigate to their routes", async ({ page }) => {
    const shell = new AppShellPage(page);
    await page.goto("/dashboard", { waitUntil: "load" });
    await shell.expectLoaded();

    const cases: Array<[string, RegExp]> = [
      ["Projects", /\/projects$/],
      ["Chat", /\/chat$/],
      ["Activity", /\/tasks$/],
      ["Library", /\/library$/],
      ["Settings", /\/settings$/],
      ["Home", /\/dashboard$/],
    ];

    for (const [label, urlRe] of cases) {
      await test.step(`navigate via "${label}"`, async () => {
        await shell.navLink(label).click();
        await expect(page).toHaveURL(urlRe);
      });
    }
  });

  // #27: the cross-project lookups are one "All projects" view away, not three
  // sidebar pages — and the sidebar keeps Projects highlighted on each of them.
  test("cross-project lookups are Projects tabs", async ({ page }) => {
    const shell = new AppShellPage(page);
    await page.goto("/projects", { waitUntil: "load" });
    await shell.expectLoaded();

    for (const [tab, urlRe] of [
      ["Documents", /\/documents$/],
      ["Repositories", /\/repositories$/],
      ["Databases", /\/databases$/],
      ["All projects", /\/projects$/],
    ] as const) {
      await test.step(`open "${tab}"`, async () => {
        await shell.hubTab("Projects", tab).click();
        await expect(page).toHaveURL(urlRe);
        await expect(shell.hubTab("Projects", tab)).toHaveAttribute("aria-current", "page");
        await expect(shell.navLink("Projects")).toHaveAttribute("aria-current", "page");
      });
    }
  });

  // #27: routes that left the sidebar still resolve — bookmarks keep working —
  // and land inside their new hub.
  test("former sidebar routes still resolve inside their hub", async ({ page }) => {
    const shell = new AppShellPage(page);
    const cases: Array<[string, "Projects" | "Chat" | "Activity" | "Settings", string]> = [
      ["/products", "Projects", "Products"],
      ["/impact-analyses", "Projects", "Impact analyses"],
      ["/workbench", "Chat", "Workbench"],
      ["/runs", "Activity", "Runs"],
      ["/sessions", "Activity", "Sessions"],
      ["/scheduler", "Activity", "Scheduler"],
      ["/reviews", "Activity", "Reviews"],
      ["/vault", "Settings", "Vault"],
      ["/admin", "Settings", "Admin"],
    ];
    for (const [path, entry, tab] of cases) {
      await test.step(path, async () => {
        await page.goto(path, { waitUntil: "load" });
        await shell.expectLoaded();
        await expect(shell.navLink(entry)).toHaveAttribute("aria-current", "page");
        await expect(shell.hubTab(entry, tab)).toHaveAttribute("aria-current", "page");
      });
    }
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

    // The Integrations card explicitly points users at their real homes.
    await expect(settings.hubLink("settings-hub-link-integrations")).toContainText(
      /live under Projects/i,
    );

    // …and those homes really are one tab away (#27).
    const shell = new AppShellPage(page);
    await expect(shell.hubTab("Settings", "Vault")).toBeVisible();
    await page.goto("/projects", { waitUntil: "load" });
    await expect(shell.hubTab("Projects", "Repositories")).toBeVisible();
    await expect(shell.hubTab("Projects", "Databases")).toBeVisible();
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
