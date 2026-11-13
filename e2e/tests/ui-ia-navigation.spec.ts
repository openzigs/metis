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
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { apiBase } from "../fixtures/api-base.js";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { createProjectViaApi } from "../fixtures/project-helpers.js";
import { seedRequirementViaCli } from "../fixtures/seed-helpers.js";
import {
  authedApi,
  createProject,
  createReview,
  e2eDatabaseUrl,
  primeUser,
  recordDecision,
  seedCompletedAnalysis,
  submitReview,
} from "../fixtures/review-helpers.js";
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

  // #27: the sidebar is one flat level of object-level destinations — seven
  // since Reviews became one (#2332).
  test("sidebar renders seven destinations and no section headings", async ({ page }) => {
    const shell = new AppShellPage(page);
    await page.goto("/dashboard", { waitUntil: "load" });
    await shell.expectLoaded();

    // Scope to the "Sections" nav: the aside also holds the METIS brand link.
    const sections = shell.sidebar.getByRole("navigation", { name: "Sections" });
    await expect(sections.getByRole("link")).toHaveCount(SIDEBAR_ENTRIES.length);
    for (const entry of SIDEBAR_ENTRIES) {
      await expect(shell.navLink(entry)).toBeVisible();
    }
    await expect(sections.getByRole("heading")).toHaveCount(0);
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
      ["Reviews", /\/reviews$/],
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

    // #2353 — exactly these four: one Portfolio tab, no Products, Portfolio
    // coverage, Repositories or Databases tab.
    await expect(shell.hubTabs("Projects").getByRole("link")).toHaveText([
      "All projects",
      "Portfolio",
      "Documents",
      "Impact analyses",
    ]);

    for (const [tab, urlRe] of [
      ["Portfolio", /\/portfolio$/],
      ["Documents", /\/documents$/],
      ["Impact analyses", /\/impact-analyses$/],
      ["All projects", /\/projects$/],
    ] as const) {
      await test.step(`open "${tab}"`, async () => {
        await shell.hubTab("Projects", tab).click();
        await expect(page).toHaveURL(urlRe);
        await expect(shell.hubTab("Projects", tab)).toHaveAttribute("aria-current", "page");
        await expect(shell.navLink("Projects")).toHaveAttribute("aria-current", "true");
      });
    }
  });

  // #27: routes that left the sidebar still resolve — bookmarks keep working —
  // and land inside their new hub.
  test("former sidebar routes still resolve inside their hub", async ({ page }) => {
    const shell = new AppShellPage(page);
    const cases: Array<[string, "Projects" | "Chat" | "Activity" | "Settings", string]> = [
      // #2353 — Products is a section of the Portfolio tab.
      ["/products", "Projects", "Portfolio"],
      ["/impact-analyses", "Projects", "Impact analyses"],
      ["/workbench", "Chat", "Workbench"],
      ["/runs", "Activity", "Runs"],
      ["/sessions", "Activity", "Sessions"],
      ["/scheduler", "Activity", "Scheduler"],
      ["/vault", "Settings", "Vault"],
      // #31 — Admin is part of Settings, not a tab of its own.
      ["/settings/workspaces", "Settings", "Settings"],
    ];
    for (const [path, entry, tab] of cases) {
      await test.step(path, async () => {
        await page.goto(path, { waitUntil: "load" });
        await shell.expectLoaded();
        await expect(shell.navLink(entry)).toHaveAttribute("aria-current", "true");
        await expect(shell.hubTab(entry, tab)).toHaveAttribute("aria-current", "page");
      });
    }

    // #2332 — /reviews still resolves from old links, now as its own entry.
    await test.step("/reviews", async () => {
      await page.goto("/reviews", { waitUntil: "load" });
      await shell.expectLoaded();
      await expect(shell.navLink("Reviews")).toHaveAttribute("aria-current", "page");
      await expect(shell.hubTabs("Activity")).toHaveCount(0);
    });
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

    // …and those homes really are one tab away (#27). #2353 — repositories and
    // databases are a project's own, in its Knowledge tab, not a Projects tab.
    const shell = new AppShellPage(page);
    await expect(shell.hubTab("Settings", "Vault")).toBeVisible();
    await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
    await expect(page.getByTestId("project-tab-knowledge")).toHaveAttribute(
      "href",
      `/projects/${projectId}/connections`,
    );
  });

  // #2353 — the four retired Projects tabs' URLs still land somewhere sensible:
  // Products and Portfolio coverage on the merged Portfolio tab, Repositories
  // and Databases on the project list, or on the Knowledge tab of a project
  // the link names.
  test("old Projects tab URLs land on Portfolio or a project's Knowledge tab", async ({ page }) => {
    const shell = new AppShellPage(page);

    await test.step("/products opens Portfolio's Products section", async () => {
      await page.goto("/products", { waitUntil: "load" });
      await expect(page).toHaveURL(/\/portfolio\?tab=products$/);
      await shell.expectLoaded();
      await expect(shell.hubTab("Projects", "Portfolio")).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("tab", { name: "Products" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(page.getByTestId("new-product-button")).toBeVisible();
    });

    await test.step("/portfolio opens the coverage check", async () => {
      await page.goto("/portfolio", { waitUntil: "load" });
      await shell.expectLoaded();
      await expect(
        page.getByRole("heading", { level: 1, name: "Portfolio", exact: true }),
      ).toBeVisible();
      await expect(shell.hubTab("Projects", "Portfolio")).toHaveAttribute("aria-current", "page");
      await expect(page.getByLabel("Requirement statement")).toBeVisible();
    });

    for (const path of ["/repositories", "/databases"]) {
      await test.step(`${path} lands on the project list`, async () => {
        await page.goto(path, { waitUntil: "load" });
        await expect(page).toHaveURL(/\/projects$/);
        await shell.expectLoaded();
        await expect(shell.hubTab("Projects", "All projects")).toHaveAttribute(
          "aria-current",
          "page",
        );
      });

      await test.step(`${path}?projectId= lands on that project's Knowledge tab`, async () => {
        await page.goto(`${path}?projectId=${projectId}`, { waitUntil: "load" });
        await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/connections$`));
        await shell.expectLoaded();
        await expect(page.getByTestId("project-tab-knowledge")).toHaveAttribute(
          "aria-current",
          "page",
        );
      });
    }
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

// #2332 — what an analyst who is not a system admin sees. Mock auth signs the
// `developer` user in, the role it gives an analyst.
const ANALYST = { username: "developer", password: "password" } as const;

/** Pages hidden from a non-admin, with the label each carried in the shell. */
const HIDDEN_PAGES: ReadonlyArray<[path: string, label: string]> = [
  ["/tasks", "Tasks"],
  ["/runs", "Runs"],
  ["/scheduler", "Scheduler"],
  ["/vault", "Vault"],
  ["/eval/leaderboard", "Eval"],
  ["/settings/api-keys", "Configuration"],
  ["/settings/mcp", "MCP servers"],
  ["/settings/acp", "ACP tokens"],
  ["/settings/hooks", "Hooks"],
  ["/settings/triggers", "Triggers"],
];

/** Open the ⌘K palette, retrying until React has bound the shortcut. */
async function openCommandPalette(page: Page): Promise<void> {
  const palette = page.getByTestId("command-palette");
  await expect(async () => {
    if (!(await palette.isVisible())) await page.keyboard.press("Control+KeyK");
    await expect(palette).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

/**
 * The in-review reviews waiting on the analyst's decision, as the server
 * counts them: the query the sidebar's count makes (#2370).
 */
async function assignedCount(api: APIRequestContext): Promise<number> {
  const res = await api.get(
    "/api/reviews?assignee=me&status=in_review&decision=pending&pageSize=1",
  );
  expect(res.ok(), `count reviews: ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as { data: { total: number } }).data.total;
}

test.describe("#2332 — a non-admin analyst's navigation", () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeEach(async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.login(ANALYST.username, ANALYST.password);
  });

  test("the sidebar and tab bars offer no operations or developer page", async ({ page }) => {
    const shell = new AppShellPage(page);
    await page.goto("/dashboard", { waitUntil: "load" });
    await shell.expectLoaded();

    const sections = shell.sidebar.getByRole("navigation", { name: "Sections" });
    await expect(sections.getByRole("link")).toHaveCount(SIDEBAR_ENTRIES.length);
    for (const [path] of HIDDEN_PAGES) {
      await expect(shell.sidebar.locator(`a[href="${path}"]`)).toHaveCount(0);
    }

    await test.step("Activity lands on Sessions, with no one-tab bar", async () => {
      await shell.navLink("Activity").click();
      await expect(page).toHaveURL(/\/sessions$/);
      await expect(shell.hubTabs("Activity")).toHaveCount(0);
    });

    await test.step("Settings lists no developer section, with no one-tab bar", async () => {
      await shell.navLink("Settings").click();
      await expect(page).toHaveURL(/\/settings$/);
      await expect(shell.hubTabs("Settings")).toHaveCount(0);
      const settingsNav = page.getByRole("navigation", { name: "Settings" });
      await expect(settingsNav.getByRole("link", { name: "Profile", exact: true })).toBeVisible();
      for (const [path, label] of HIDDEN_PAGES.filter(([p]) => p.startsWith("/settings/"))) {
        await expect(settingsNav.getByRole("link", { name: label, exact: true })).toHaveCount(0);
        await expect(page.locator(`main a[href="${path}"]`)).toHaveCount(0);
      }
    });
  });

  test("a hidden page opened by URL says so and offers a way back", async ({ page }) => {
    const shell = new AppShellPage(page);
    for (const [path] of HIDDEN_PAGES) {
      await test.step(path, async () => {
        await page.goto(path, { waitUntil: "load" });
        await shell.expectLoaded();
        await expect(shell.noAccess).toBeVisible();
      });
    }
    await page.getByRole("link", { name: "Back to dashboard" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  // #2370 — a run's own page stays open to the analyst (a project's PR
  // reviews link there), but nothing on it leads to the Runs list they are
  // refused: not the "All runs" link, not the breadcrumb's Runs crumb.
  test("a run's page names Runs without linking to it", async ({ page }) => {
    const shell = new AppShellPage(page);
    await page.goto("/runs/e2e-2370-run", { waitUntil: "load" });
    await shell.expectLoaded();
    await expect(page.getByTestId("run-detail-page")).toBeVisible();
    await expect(shell.noAccess).toHaveCount(0);
    await expect(shell.breadcrumb).toContainText("Runs");
    await expect(page.locator('a[href="/runs"]')).toHaveCount(0);
    await expect(page.getByRole("link", { name: /All runs/ })).toHaveCount(0);
  });

  test("the command palette offers none of the hidden pages", async ({ page }) => {
    const shell = new AppShellPage(page);
    await page.goto("/dashboard", { waitUntil: "load" });
    await shell.expectLoaded();
    await openCommandPalette(page);
    const input = page.getByTestId("command-palette-input");
    for (const [path, label] of HIDDEN_PAGES) {
      await test.step(label, async () => {
        await input.fill(label);
        await expect(page.locator(`[role="option"][data-href="${path}"]`)).toHaveCount(0);
      });
    }
    // A page the analyst keeps is still found.
    await input.fill("Reviews");
    await expect(page.locator('[role="option"][data-href="/reviews"]')).toHaveCount(1);
  });

  // #2353 — an analyst's Projects hub: one Portfolio tab holding the products
  // and the coverage check, offered by the palette too; none of the four tabs
  // it replaced, in the tab bar or the palette.
  test("the Projects hub and the palette offer Portfolio and none of the retired tabs", async ({
    page,
  }) => {
    const shell = new AppShellPage(page);
    await page.goto("/projects", { waitUntil: "load" });
    await shell.expectLoaded();
    await expect(shell.hubTabs("Projects").getByRole("link")).toHaveText([
      "All projects",
      "Portfolio",
      "Documents",
      "Impact analyses",
    ]);

    await test.step("Portfolio holds the check and the products", async () => {
      await shell.hubTab("Projects", "Portfolio").click();
      await expect(page).toHaveURL(/\/portfolio$/);
      await expect(page.getByLabel("Requirement statement")).toBeVisible();
      await page.getByRole("tab", { name: "Products" }).click();
      await expect(
        page.getByRole("heading", { level: 2, name: "Products", exact: true }),
      ).toBeVisible();
    });

    await test.step("the palette", async () => {
      await openCommandPalette(page);
      const input = page.getByTestId("command-palette-input");
      await input.fill("Portfolio");
      await expect(page.locator('[role="option"][data-href="/portfolio"]')).toHaveCount(1);
      for (const [label, path] of [
        ["Products", "/products"],
        ["Repositories", "/repositories"],
        ["Databases", "/databases"],
      ] as const) {
        await input.fill(label);
        await expect(page.locator(`[role="option"][data-href="${path}"]`)).toHaveCount(0);
      }
      await input.fill("Portfolio coverage");
      await expect(page.getByRole("option", { name: "Portfolio coverage" })).toHaveCount(0);
    });
  });

  test("Reviews counts the reviews assigned to me, and drops one when I decide it", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const requester = await primeUser({
      username: ADMIN_USER.username,
      password: ADMIN_USER.password,
    });
    const analyst = await primeUser(ANALYST);
    const requesterApi = await authedApi(requester.accessToken);
    const analystApi = await authedApi(analyst.accessToken);
    try {
      const shell = new AppShellPage(page);
      const projectId = await createProject(requesterApi, "e2e-2332-reviews");
      const analysisId = await seedCompletedAnalysis(requesterApi, projectId);
      const requirementId = seedRequirementViaCli({
        projectId,
        analysisId,
        databaseUrl: e2eDatabaseUrl(),
      });
      const reviewId = await createReview(requesterApi, projectId, {
        title: "Review for the analyst's sidebar count",
        reviewerIds: [analyst.userId],
        requirementIds: [requirementId],
      });
      await submitReview(requesterApi, reviewId);

      const before = await assignedCount(analystApi);
      expect(before).toBeGreaterThan(0);
      await page.goto("/dashboard", { waitUntil: "load" });
      await shell.expectLoaded();
      await expect(shell.reviewsCount).toHaveText(before > 99 ? "99+" : String(before));
      await expect(shell.navLink("Reviews")).toHaveAccessibleDescription(
        `${before} ${before === 1 ? "review" : "reviews"} assigned to you`,
      );

      await test.step("deciding it in this tab drops it from the count", async () => {
        await recordDecision(analystApi, reviewId, "approved");
        const after = await assignedCount(analystApi);
        expect(after).toBe(before - 1);
        // The sidebar re-reads on focus and every minute; a reload is the
        // deterministic trigger here.
        await page.reload({ waitUntil: "load" });
        await shell.expectLoaded();
        if (after === 0) await expect(shell.reviewsCount).toHaveCount(0);
        else await expect(shell.reviewsCount).toHaveText(after > 99 ? "99+" : String(after));
      });
    } finally {
      await requesterApi.dispose();
      await analystApi.dispose();
    }
  });
});
