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
        await expect(shell.navLink("Projects")).toHaveAttribute("aria-current", "true");
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

/** The in-review reviews assigned to the analyst, as the server counts them. */
async function assignedCount(api: APIRequestContext): Promise<number> {
  const res = await api.get("/api/reviews?assignee=me&status=in_review&pageSize=1");
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
