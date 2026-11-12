/**
 * Project navigation follows the analyst's job — #2334 (epic #2328), on top of
 * #28 / #29 (epic #26).
 *
 * Covers:
 *   #2334 — the tabs read Overview · Knowledge · Change requests · Requirements ·
 *           Deliverables · ⚙, left to right; ⚙ is named "Project settings" and
 *           holds the code views (the Code tab is gone); Change Analysis is
 *           "Compare analyses" under Requirements; every pre-existing project
 *           route still resolves at the same URL and lights its new tab and
 *           sub-item; each moved page is reachable in two clicks
 *   #28 — there is no "More" overflow; every primary tab is one click; a
 *         section's pages sit in a sub-nav; Skills are reached from Library
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

const TABS = [
  "Overview",
  "Knowledge",
  "Change requests",
  "Requirements",
  "Deliverables",
  "Project settings",
];

/**
 * Every project route that existed before #2334, with the primary tab and the
 * sub-nav page that must light on it. No route moved — each still loads at its
 * own path (`/repositories` was already a redirect to Connections; `/sync` is
 * reached from published issues, not from the sub-nav).
 */
const ROUTES: ReadonlyArray<{ path: string; tab: string; item?: string; landsOn?: string }> = [
  { path: "", tab: "Overview" },
  { path: "/connections", tab: "Knowledge", item: "Connections" },
  { path: "/documents", tab: "Knowledge", item: "Documents" },
  { path: "/repositories", tab: "Knowledge", item: "Connections", landsOn: "/connections" },
  { path: "/analysis", tab: "Change requests", item: "Requirements Analysis" },
  { path: "/import", tab: "Change requests", item: "Import" },
  { path: "/jira", tab: "Change requests", item: "Jira" },
  { path: "/impact", tab: "Change requests", item: "Impact Analysis" },
  { path: "/requirements", tab: "Requirements", item: "Review" },
  { path: "/baselines", tab: "Requirements", item: "Baselines" },
  { path: "/discussions", tab: "Requirements", item: "Discussions" },
  { path: "/changes", tab: "Requirements", item: "Compare analyses" },
  { path: "/documentation", tab: "Deliverables", item: "Documentation" },
  { path: "/settings/templates", tab: "Deliverables", item: "Templates" },
  { path: "/publish", tab: "Deliverables", item: "Publish" },
  { path: "/sync", tab: "Deliverables" },
  { path: "/settings", tab: "Project settings", item: "General" },
  { path: "/settings/models", tab: "Project settings", item: "Models" },
  { path: "/plugins", tab: "Project settings", item: "Plugins" },
  { path: "/overview", tab: "Project settings", item: "Code Overview" },
  { path: "/pulls", tab: "Project settings", item: "Pull Requests" },
  { path: "/spec-kit", tab: "Project settings", item: "Spec Kit" },
  // #31 — /usage now redirects to Settings → Usage & cost; it is no project page.
];

test.describe("Project navigation follows the analyst's job (#2334, #28, #29)", () => {
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

  test("the tab bar reads the six tabs left to right, with no More menu", async ({ page }) => {
    await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
    const tabs = new ProjectTabsPage(page);
    await tabs.expectVisible();

    // The ⚙ tab is an icon; its name ("Project settings") is visually-hidden text.
    await expect(tabs.nav.getByRole("link")).toHaveText(TABS);
    const gear = tabs.primaryLink("Project settings");
    await expect(gear).toBeVisible();
    await expect(gear).toHaveAttribute("title", "Project settings");
    await expect(page.getByRole("button", { name: /more project sections/i })).toHaveCount(0);
    await expect(page.getByTestId("project-tabs-more")).toHaveCount(0);
  });

  test("each primary tab is one click from the bar and lands on its first page", async ({
    page,
  }) => {
    await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
    const tabs = new ProjectTabsPage(page);
    await tabs.expectVisible();

    const landings: Array<[string, string]> = [
      ["Knowledge", "/connections"],
      ["Change requests", "/analysis"],
      ["Requirements", "/requirements"],
      ["Deliverables", "/documentation"],
      ["Project settings", "/settings"],
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

    const knowledge = page.getByRole("navigation", { name: "Knowledge pages" });
    await expect(knowledge.getByRole("link")).toHaveText(["Connections", "Documents"]);

    await tabs.subnavLink("Documents").click();
    await expect(page).toHaveURL((url) => url.pathname === `/projects/${projectId}/documents`);
    await expect(page.getByTestId("project-documents-root")).toBeVisible();
    await expect(tabs.subnavLink("Documents")).toHaveAttribute("aria-current", "page");
    await expect(tabs.primaryLink("Knowledge")).toHaveAttribute("aria-current", "true");

    await tabs.primaryLink("Change requests").click();
    await expect(
      page.getByRole("navigation", { name: "Change requests pages" }).getByRole("link"),
    ).toHaveText(["Requirements Analysis", "Import", "Jira", "Impact Analysis"]);

    await tabs.openPage("Requirements", "Compare analyses");
    await expect(page).toHaveURL((url) => url.pathname === `/projects/${projectId}/changes`);
    await expect(
      page.getByRole("navigation", { name: "Requirements pages" }).getByRole("link"),
    ).toHaveText(["Review", "Baselines", "Discussions", "Compare analyses"]);

    await tabs.primaryLink("Deliverables").click();
    await expect(
      page.getByRole("navigation", { name: "Deliverables pages" }).getByRole("link"),
    ).toHaveText(["Documentation", "Templates", "Publish"]);

    await tabs.primaryLink("Project settings").click();
    await expect(
      page.getByRole("navigation", { name: "Project settings pages" }).getByRole("link"),
    ).toHaveText([
      "General",
      "Models",
      "Plugins",
      "Usage",
      "Code Overview",
      "Pull Requests",
      "Spec Kit",
    ]);
  });

  // Every page that moved tab is two clicks from the project: its tab, then its
  // sub-nav link, landing on the URL it always had.
  const MOVED: ReadonlyArray<[string, string, string]> = [
    ["Change requests", "Import", "/import"],
    ["Change requests", "Jira", "/jira"],
    ["Requirements", "Compare analyses", "/changes"],
    ["Deliverables", "Publish", "/publish"],
    ["Project settings", "Code Overview", "/overview"],
    ["Project settings", "Pull Requests", "/pulls"],
    ["Project settings", "Spec Kit", "/spec-kit"],
  ];
  test("each moved page is two clicks from the project, at its old URL", async ({ page }) => {
    const tabs = new ProjectTabsPage(page);
    for (const [tab, item, suffix] of MOVED) {
      await test.step(`${tab} › ${item}`, async () => {
        await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
        await tabs.expectVisible();
        await tabs.openPage(tab, item);
        await expect(page).toHaveURL((url) => url.pathname === `/projects/${projectId}${suffix}`);
        await expect(tabs.subnavLink(item)).toHaveAttribute("aria-current", "page");
      });
    }
  });

  test("Skills are not in the project tabs — Library carries the project picker", async ({
    page,
  }) => {
    await page.goto(`/projects/${projectId}/documentation`, { waitUntil: "load" });
    const tabs = new ProjectTabsPage(page);
    await tabs.expectVisible();
    // (The global sidebar links Library itself; the project navigation must not.)
    await expect(tabs.nav.locator('a[href^="/library"]')).toHaveCount(0);
    await expect(tabs.subnav.locator('a[href^="/library"]')).toHaveCount(0);

    await page.goto("/library", { waitUntil: "load" });
    // #31 — the picker is the Skills/Agents scope filter.
    const picker = page.getByLabel("Scope");
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

    // #2349 — five numbered steps of the analyst's job, then Publish (optional).
    const checklist = page.getByTestId("project-checklist");
    await expect(
      checklist.getByRole("heading", { name: "Get started", exact: true }),
    ).toBeVisible();
    await expect(checklist.getByRole("listitem")).toHaveCount(6);
    await expect(checklist.getByRole("heading", { level: 3 })).toHaveText([
      "1.Add knowledge",
      "2.Ready: ask a question",
      "3.New change request",
      "4.Review",
      "5.Deliverable",
      "Publish (optional)",
    ]);

    await test.step("no settings controls on the Overview", async () => {
      await expect(page.getByTestId("ai-provider-picker")).toHaveCount(0);
      await expect(page.getByTestId("autopilot-settings-card")).toHaveCount(0);
      await expect(page.getByTestId("archive-button")).toHaveCount(0);
    });

    await test.step("the code summary link names where it lives now", async () => {
      await expect(page.getByTestId("pipeline-code-overview-link").locator("..")).toContainText(
        "The code summary lives under Project settings",
      );
    });

    await test.step("every step deep-links to where it is done", async () => {
      const targets: Array<[string, string]> = [
        ["sources", "/connections"],
        ["ingest", "/connections"],
        ["analyze", "/analysis"],
        ["review", "/requirements"],
        ["docs", "/documentation"],
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

    await tabs.primaryLink("Project settings").click();
    await expect(page).toHaveURL((url) => url.pathname === `/projects/${projectId}/settings`);
    await expect(
      page.getByRole("heading", { name: "Project settings", exact: true, level: 1 }),
    ).toBeVisible();
    await expect(page.getByTestId("ai-provider-picker")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("autopilot-settings-card")).toBeVisible();

    await tabs.openPage("Project settings", "Code Overview");
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
    test(`existing route ${route.path || "/"} still resolves and lights ${route.tab}${
      route.item ? ` › ${route.item}` : ""
    }`, async ({ page }) => {
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
      if (route.item) {
        await expect(tabs.subnavLink(route.item)).toHaveAttribute("aria-current", "page");
      }
    });
  }
});
