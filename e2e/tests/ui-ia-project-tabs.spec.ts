/**
 * Project navigation follows the pipeline — #28 / #29 (epic #26).
 *
 * Covers:
 *   #28 — the tabs read Overview · Sources · Analyze · Requirements · Docs ·
 *         Publish · Code · ⚙, left to right; there is no "More" overflow; every
 *         primary tab is one click; a section's pages sit in a sub-nav; every
 *         pre-existing project route still resolves and lights its tab; Skills
 *         are reached from Library, not from Docs
 *   #29 — the landing page is the only "Overview", shows a numbered first-run
 *         checklist whose steps deep-link to where each is done, and carries no
 *         settings form — that lives behind ⚙
 *   R1 #156 — below `md` the whole bar collapses to a single dropdown
 */
import { test, expect } from "@playwright/test";
import { apiBase } from "../fixtures/api-base.js";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { createProjectViaApi } from "../fixtures/project-helpers.js";
import { LoginPage } from "../pages/login.page.js";
import { ProjectTabsPage } from "../pages/project-tabs.page.js";

const API_BASE = apiBase();

const PIPELINE = [
  "Overview",
  "Sources",
  "Analyze",
  "Requirements",
  "Docs",
  "Publish",
  "Code",
  "Settings",
];

/**
 * Every project route that existed before #28, plus the three it added, with
 * the primary tab that must light on it. No route moved — each still loads at
 * its own path (`/repositories` was already a redirect to Connections).
 */
const ROUTES: ReadonlyArray<{ path: string; tab: string; landsOn?: string }> = [
  { path: "", tab: "Overview" },
  { path: "/connections", tab: "Sources" },
  { path: "/documents", tab: "Sources" },
  { path: "/import", tab: "Sources" },
  { path: "/jira", tab: "Sources" },
  { path: "/repositories", tab: "Sources", landsOn: "/connections" },
  { path: "/analysis", tab: "Analyze" },
  { path: "/impact", tab: "Analyze" },
  { path: "/spec-kit", tab: "Analyze" },
  { path: "/requirements", tab: "Requirements" },
  { path: "/baselines", tab: "Requirements" },
  { path: "/discussions", tab: "Requirements" },
  { path: "/documentation", tab: "Docs" },
  { path: "/settings/templates", tab: "Docs" },
  { path: "/publish", tab: "Publish" },
  { path: "/sync", tab: "Publish" },
  { path: "/overview", tab: "Code" },
  { path: "/changes", tab: "Code" },
  { path: "/pulls", tab: "Code" },
  { path: "/rule-sets", tab: "Code" },
  { path: "/scans", tab: "Code" },
  { path: "/test-coverage", tab: "Code" },
  { path: "/test-coverage/connections", tab: "Code" },
  { path: "/settings", tab: "Settings" },
  { path: "/settings/models", tab: "Settings" },
  { path: "/plugins", tab: "Settings" },
  { path: "/usage", tab: "Settings" },
];

test.describe("Project navigation follows the pipeline (#28, #29)", () => {
  test.describe.configure({ timeout: 180_000 });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const primed = await primeAdminUser(API_BASE);
    const project = await createProjectViaApi(API_BASE, primed.accessToken);
    projectId = project.id;

    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  test("the tab bar reads left to right in pipeline order, with no More menu", async ({ page }) => {
    await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
    const tabs = new ProjectTabsPage(page);
    await tabs.expectVisible();

    // The ⚙ tab is an icon; its name ("Settings") is visually-hidden text.
    await expect(tabs.nav.getByRole("link")).toHaveText(PIPELINE);
    await expect(tabs.primaryLink("Settings")).toBeVisible();
    await expect(page.getByRole("button", { name: /more project sections/i })).toHaveCount(0);
    await expect(page.getByTestId("project-tabs-more")).toHaveCount(0);
  });

  test("each primary tab is one click from the bar and lands on its first step", async ({
    page,
  }) => {
    await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
    const tabs = new ProjectTabsPage(page);
    await tabs.expectVisible();

    const landings: Array<[string, string]> = [
      ["Sources", "/connections"],
      ["Analyze", "/analysis"],
      ["Requirements", "/requirements"],
      ["Docs", "/documentation"],
      ["Publish", "/publish"],
      ["Code", "/overview"],
      ["Settings", "/settings"],
      ["Overview", ""],
    ];
    for (const [tab, suffix] of landings) {
      await test.step(`${tab} → ${suffix || "/"}`, async () => {
        await tabs.primaryLink(tab).click();
        await expect(page).toHaveURL((url) => url.pathname === `/projects/${projectId}${suffix}`);
        await expect(tabs.primaryLink(tab)).toHaveAttribute("aria-current", "page");
      });
    }
  });

  test("a section's pages sit in a labelled sub-nav under the bar", async ({ page }) => {
    await page.goto(`/projects/${projectId}/connections`, { waitUntil: "load" });
    const tabs = new ProjectTabsPage(page);
    await tabs.expectVisible();

    const sources = page.getByRole("navigation", { name: "Sources pages" });
    await expect(sources.getByRole("link")).toHaveText([
      "Connections",
      "Documents",
      "Import",
      "Jira",
    ]);

    await tabs.subnavLink("Documents").click();
    await expect(page).toHaveURL((url) => url.pathname === `/projects/${projectId}/documents`);
    await expect(page.getByTestId("project-documents-root")).toBeVisible();
    await expect(tabs.subnavLink("Documents")).toHaveAttribute("aria-current", "page");
    await expect(tabs.primaryLink("Sources")).toHaveAttribute("aria-current", "true");

    await tabs.openPage("Code", "Changes");
    await expect(page).toHaveURL((url) => url.pathname === `/projects/${projectId}/changes`);
    await expect(page.getByRole("navigation", { name: "Code pages" }).getByRole("link")).toHaveText(
      ["Code Overview", "Changes", "Pull Requests", "Bug Rules", "Bug Scans", "Test Coverage"],
    );
  });

  test("Skills are not in the project tabs — Library carries the project picker", async ({
    page,
  }) => {
    await page.goto(`/projects/${projectId}/documentation`, { waitUntil: "load" });
    const tabs = new ProjectTabsPage(page);
    await tabs.expectVisible();
    await expect(page.getByRole("navigation", { name: "Docs pages" }).getByRole("link")).toHaveText(
      ["Documentation", "Templates"],
    );
    // (The global sidebar links Library itself; the project navigation must not.)
    await expect(tabs.nav.locator('a[href^="/library"]')).toHaveCount(0);
    await expect(tabs.subnav.locator('a[href^="/library"]')).toHaveCount(0);

    await page.goto("/library", { waitUntil: "load" });
    const picker = page.getByLabel("Manage skills and agents for");
    await expect(picker.locator("option", { hasText: /IA Test/ }).first()).toBeAttached();
    await picker.selectOption(projectId);
    await expect(page).toHaveURL(
      (url) => url.pathname === "/library" && url.searchParams.get("projectId") === projectId,
    );
  });

  test("the Overview is a first-run checklist, not a settings form", async ({ page }) => {
    await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
    const root = page.getByTestId("project-overview-root");
    await expect(root).toBeVisible({ timeout: 30_000 });

    const checklist = page.getByTestId("first-run-checklist");
    await expect(checklist.getByRole("heading", { name: "Get started" })).toBeVisible();
    await expect(checklist.getByRole("listitem")).toHaveCount(5);

    await test.step("no settings controls on the Overview", async () => {
      await expect(page.getByTestId("ai-provider-picker")).toHaveCount(0);
      await expect(page.getByTestId("autopilot-settings-card")).toHaveCount(0);
      await expect(page.getByTestId("archive-button")).toHaveCount(0);
    });

    await test.step("every step deep-links to where it is done", async () => {
      const targets: Array<[string, string]> = [
        ["sources", "/connections"],
        ["ingest", "/connections"],
        ["analyze", "/analysis"],
        ["review", "/requirements"],
        ["publish", "/publish"],
      ];
      for (const [step, suffix] of targets) {
        await expect(page.getByTestId(`pipeline-action-${step}`)).toHaveAttribute(
          "href",
          `/projects/${projectId}${suffix}`,
        );
      }
      await page.getByTestId("pipeline-action-sources").click();
      await expect(page).toHaveURL((url) => url.pathname === `/projects/${projectId}/connections`);
    });
  });

  test("the settings form lives behind ⚙, and only one page is named Overview", async ({
    page,
  }) => {
    await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
    const tabs = new ProjectTabsPage(page);
    await tabs.expectVisible();

    await tabs.primaryLink("Settings").click();
    await expect(page).toHaveURL((url) => url.pathname === `/projects/${projectId}/settings`);
    await expect(page.getByRole("heading", { name: "Project settings", level: 1 })).toBeVisible();
    await expect(page.getByTestId("ai-provider-picker")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("autopilot-settings-card")).toBeVisible();

    await tabs.openPage("Code", "Code Overview");
    await expect(page.getByRole("heading", { level: 1, name: /^Code Overview — / })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: /^Project Overview/ })).toHaveCount(0);
  });

  test("collapses to a single dropdown below the md breakpoint", async ({ page }) => {
    await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
    const tabs = new ProjectTabsPage(page);
    await tabs.expectVisible();

    await test.step("desktop viewport shows inline tabs, not the mobile dropdown", async () => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await expect(tabs.primaryLink("Overview")).toBeVisible();
      await expect(tabs.mobileTrigger).toBeHidden();
    });

    await test.step("sub-md viewport collapses to the dropdown", async () => {
      await page.setViewportSize({ width: 640, height: 800 });
      await expect(tabs.mobileTrigger).toBeVisible();
      await expect(tabs.primaryLink("Overview")).toBeHidden();
    });

    await test.step("the dropdown exposes every destination", async () => {
      await tabs.openMobileMenu();
      await expect(tabs.menuItem("Overview")).toBeVisible();
      await expect(tabs.menuItem("Documents")).toBeVisible();
      await expect(tabs.menuItem("Publish")).toBeVisible();
      await expect(tabs.menuItem("Usage")).toBeVisible();
    });
  });

  for (const route of ROUTES) {
    test(`existing route ${route.path || "/"} still resolves and lights ${route.tab}`, async ({
      page,
    }) => {
      const response = await page.goto(`/projects/${projectId}${route.path}`, {
        waitUntil: "load",
      });
      expect(response?.status() ?? 0).toBeLessThan(400);
      if (route.landsOn) {
        await expect(page).toHaveURL(
          (url) => url.pathname === `/projects/${projectId}${route.landsOn}`,
        );
      }
      const tabs = new ProjectTabsPage(page);
      await tabs.expectVisible();
      await expect(tabs.primaryLink(route.tab)).toHaveAttribute("aria-current", /^(page|true)$/);
      await expect(tabs.nav.locator("[aria-current]")).toHaveCount(1);
    });
  }
});
