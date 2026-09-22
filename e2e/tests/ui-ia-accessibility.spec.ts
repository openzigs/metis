/**
 * UI Information-Architecture overhaul — accessibility affordances (Epic #133).
 *
 * Covers:
 *   A1 #149 — icon-only controls expose accessible names
 *   A2 #150 — controls are keyboard-focusable and meet the minimum hit-target
 *             size (WCAG 2.2 AA: 24×24 CSS px)
 *
 * Note on A3 #148 (muted-foreground contrast): colour-contrast ratios are not
 * deterministically assertable through Playwright without an axe integration,
 * which this suite does not wire up. A3 is covered by the design-token unit
 * tests / visual review and is reported as not-mapped for e2e below.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { apiBase } from "../fixtures/api-base.js";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { createProjectViaApi } from "../fixtures/project-helpers.js";
import { LoginPage } from "../pages/login.page.js";
import { AppShellPage } from "../pages/app-shell.page.js";
import { ProjectTabsPage } from "../pages/project-tabs.page.js";

const API_BASE = apiBase();

async function expectMinTarget(locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(24);
  expect(box!.height).toBeGreaterThanOrEqual(24);
}

/**
 * Open the ⌘K command palette. The shortcut is bound by a `useEffect` in
 * `command-palette.tsx`, so a press that lands before React hydrates the shell
 * is swallowed — retry until the dialog appears rather than pressing once and
 * hoping (the difference between a flaky spec and a deterministic one).
 */
async function openCommandPalette(page: Page): Promise<void> {
  const palette = page.getByTestId("command-palette");
  await expect(async () => {
    // The shortcut toggles, so never press again once the palette is open.
    if (!(await palette.isVisible())) {
      await page.keyboard.press("Control+KeyK");
    }
    await expect(palette).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

test.describe("UI IA — accessibility affordances (#133)", () => {
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

  // WCAG SC 1.3.5 Identify Input Purpose (#659). On the real login route the
  // credential inputs must expose the H98 autocomplete purpose tokens so
  // assistive tech and browser autofill can identify the field's purpose. This
  // locks the integrated contract that the vitest component suite asserts in
  // isolation.
  test("login credential inputs expose H98 autocomplete purpose tokens (#659)", async ({
    browser,
  }) => {
    // The describe-level beforeEach signs in, and /login bounces an already
    // authenticated session straight to the app (#408). Assert the form from a
    // fresh, signed-out context so the login route actually renders.
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const login = new LoginPage(page);
      await login.goto();
      await expect(login.username).toHaveAttribute("autocomplete", "username");
      await expect(login.password).toHaveAttribute("autocomplete", "current-password");
    } finally {
      await context.close();
    }
  });

  // A1 #149: header icon-only controls have accessible names (queryable by role+name).
  test("header icon-only controls have accessible names", async ({ page }) => {
    const shell = new AppShellPage(page);
    await page.goto("/dashboard", { waitUntil: "load" });
    await shell.expectLoaded();

    await expect(shell.notificationsButton).toBeVisible();
    await expect(page.getByRole("button", { name: /^Notifications/ })).toBeVisible();
    await expect(shell.themeToggle).toBeVisible();
  });

  // A1 #149: the mobile hamburger is icon-only but exposes "Open navigation".
  test("mobile navigation toggle has an accessible name", async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 800 });
    await page.goto("/dashboard", { waitUntil: "load" });

    const menuButton = page.getByRole("button", { name: "Open navigation" });
    await expect(menuButton).toBeVisible();
    // Assert the vertical hit target (h-10). Width can collapse under extreme
    // horizontal crowding on narrow viewports, so we don't assert it here.
    const box = await menuButton.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(24);
  });

  // A1 #149: icon-only project navigation exposes an accessible name. Since #28
  // the "More" overflow is gone; the icon-only control is the ⚙ settings tab.
  test("icon-only project settings tab has an accessible name", async ({ page }) => {
    await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
    const tabs = new ProjectTabsPage(page);
    await tabs.expectVisible();

    await expect(tabs.primaryLink("Settings")).toBeVisible();
    await expect(page.getByRole("button", { name: "More project sections" })).toHaveCount(0);
  });

  // A2 #150: icon-only controls are keyboard-focusable and meet the min target size.
  test("icon-only controls are focusable and large enough", async ({ page }) => {
    const shell = new AppShellPage(page);
    await page.goto(`/projects/${projectId}`, { waitUntil: "load" });
    await shell.expectLoaded();

    await test.step("notifications + theme controls meet the 24px minimum", async () => {
      await expectMinTarget(shell.notificationsButton);
      await expectMinTarget(shell.themeToggle);
    });

    await test.step("the ⚙ settings tab is keyboard-focusable", async () => {
      const gear = new ProjectTabsPage(page).primaryLink("Settings");
      await gear.focus();
      await expect(gear).toBeFocused();
      await expectMinTarget(gear);
    });
  });

  // Issue #661 — WCAG 2.2 SC 3.2.6 Consistent Help (AA). A persistent Help
  // affordance must appear in an *identical relative location* on every
  // authenticated page: immediately to the right of the theme toggle and left of
  // the user menu. This asserts that consistent presence + position on the real
  // routes across a representative sample (dashboard, a project page, settings),
  // and that the affordance opens a labelled dialog offering an allowed help
  // mechanism (a documentation / support link). Component-level accessible-name
  // and dialog semantics are locked by the vitest suite (help-menu.test.tsx).
  test("Help affordance sits right of the theme toggle on every page (#661)", async ({ page }) => {
    const shell = new AppShellPage(page);
    const routes: Array<{ label: string; path: string }> = [
      { label: "dashboard", path: "/dashboard" },
      { label: "project", path: `/projects/${projectId}/overview` },
      { label: "settings", path: "/settings" },
    ];

    for (const route of routes) {
      await test.step(`${route.label} (${route.path})`, async () => {
        await page.goto(route.path, { waitUntil: "load" });
        await shell.expectLoaded();

        // Present, keyboard-focusable, with the accessible name "Help".
        await expect(shell.helpButton).toBeVisible();
        await expect(page.getByRole("button", { name: "Help" })).toBeVisible();
        await shell.helpButton.focus();
        await expect(shell.helpButton).toBeFocused();

        // Consistent position: right of the theme toggle, left of the user menu.
        const themeBox = await shell.themeToggle.boundingBox();
        const helpBox = await shell.helpButton.boundingBox();
        const userBox = await page.getByRole("button", { name: /^Account menu for/ }).boundingBox();
        expect(themeBox).not.toBeNull();
        expect(helpBox).not.toBeNull();
        expect(userBox).not.toBeNull();
        expect(helpBox!.x).toBeGreaterThan(themeBox!.x);
        expect(helpBox!.x).toBeLessThan(userBox!.x);
      });
    }

    await test.step("opens a labelled dialog with a help mechanism", async () => {
      await shell.helpButton.click();
      const dialog = page.getByRole("dialog", { name: /help/i });
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("link", { name: /user guide|documentation|support|issue/i }).first(),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    });
  });

  // Issue #662 — WCAG 2.2 SC 2.4.11 Focus Not Obscured (Minimum, AA). A
  // keyboard-focused control must never be ENTIRELY hidden behind the sticky
  // header (`sticky top-0 h-16`, header.tsx) or any other overlay. We walk the
  // tab order on each major scrollable/sticky page and, at every stop, assert
  // that some part of the focused control actually paints on top (i.e. is
  // visible), using `document.elementFromPoint` so the check honours real
  // stacking order rather than a naive geometry test. The global
  // `scroll-padding-top` (globals.css) is what keeps focus clear of the header
  // when the browser scrolls a control into view; remove it and the deep
  // controls on a scrolled page fail this assertion.
  test("keyboard focus is never fully obscured by the sticky header (#662)", async ({ page }) => {
    const routes: Array<{ label: string; path: string }> = [
      { label: "dashboard", path: "/dashboard" },
      { label: "overview", path: `/projects/${projectId}/overview` },
      { label: "documentation", path: `/projects/${projectId}/documentation` },
      { label: "publish", path: `/projects/${projectId}/publish` },
      { label: "settings", path: "/settings" },
      { label: "chat", path: "/chat" },
    ];

    for (const route of routes) {
      await test.step(`${route.label} (${route.path})`, async () => {
        await page.goto(route.path, { waitUntil: "load" });
        await expect(page.getByRole("banner")).toBeVisible();

        // Walk the tab order. After each stop, if a real control holds focus,
        // assert a visible slice of it paints on top somewhere on screen.
        for (let i = 0; i < 20; i++) {
          await page.keyboard.press("Tab");
          const focused = page.locator(":focus");
          if ((await focused.count()) === 0) continue;

          const info = await focused.evaluate((el) => {
            const tag = el.tagName;
            if (tag === "BODY" || tag === "HTML") return { skip: true, visible: true, name: "" };
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) {
              return { skip: true, visible: true, name: "" };
            }
            // Sample a grid across the element; if any in-viewport point hits
            // the element (or a descendant), part of it paints on top and is
            // therefore not fully obscured by the sticky header / an overlay.
            const xs = [rect.left + 2, rect.left + rect.width / 2, rect.right - 2];
            const ys = [rect.top + 2, rect.top + rect.height / 2, rect.bottom - 2];
            let visible = false;
            for (const x of xs) {
              for (const y of ys) {
                if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
                const hit = document.elementFromPoint(x, y);
                if (hit && (hit === el || el.contains(hit))) {
                  visible = true;
                  break;
                }
              }
              if (visible) break;
            }
            const name =
              el.getAttribute("aria-label") ?? (el.textContent ?? "").trim().slice(0, 40);
            return { skip: false, visible, name };
          });

          if (info.skip) continue;
          expect(
            info.visible,
            `focused control "${info.name}" on ${route.path} is fully obscured (SC 2.4.11)`,
          ).toBe(true);
        }
      });
    }
  });

  // Issue #58 — screen-reader audit across the top-10 surfaces. Every page must
  // sit inside the shell `main` landmark and expose exactly one top-level
  // heading so an SR user can orient by landmark/heading on arrival. Page-level
  // control/label semantics are locked in by the vitest component suite; this
  // asserts the integrated landmark+heading contract on the real routes.
  test("top-10 pages expose the main landmark and a single h1", async ({ page }) => {
    const routes: Array<{ label: string; path: string; h1: RegExp }> = [
      { label: "dashboard", path: "/dashboard", h1: /Dashboard/ },
      { label: "projects", path: "/projects", h1: /Projects/ },
      // #29 — the code summary is "Code Overview"; only the landing page is "Overview".
      { label: "overview", path: `/projects/${projectId}/overview`, h1: /Code Overview/ },
      { label: "analysis", path: `/projects/${projectId}/analysis`, h1: /Requirements Analysis/ },
      {
        label: "requirements",
        path: `/projects/${projectId}/documentation`,
        h1: /Documentation/,
      },
      { label: "publishing", path: `/projects/${projectId}/publish`, h1: /Publishing/ },
      { label: "mcp", path: "/settings/mcp", h1: /MCP platform/ },
      { label: "settings", path: "/settings", h1: /Settings/ },
      { label: "admin", path: "/admin", h1: /Admin/ },
      { label: "chat", path: "/chat", h1: /Chat/ },
    ];

    for (const route of routes) {
      await test.step(`${route.label} (${route.path})`, async () => {
        await page.goto(route.path, { waitUntil: "load" });
        // Landmark: content is inside the shell `main`.
        await expect(page.getByRole("main")).toBeVisible();
        // Exactly one top-level heading, naming the page.
        const h1s = page.getByRole("heading", { level: 1 });
        await expect(h1s).toHaveCount(1);
        await expect(h1s).toHaveText(route.h1);
      });
    }
  });
});

// Issue #60 — mobile-tuned data tables. Below the 768px breakpoint the top data
// tables must reflow to a stacked card list (WCAG 1.4.10 Reflow) rather than a
// horizontally scrolling <table>, while interactive controls keep a ≥44px touch
// target (WCAG 2.5.8). Component-level semantics are locked in by the vitest
// suite (src/components/tables/responsive-table.test.tsx); this asserts the
// integrated behaviour on the real /documents route with a seeded document.
test.describe("UI mobile — data tables reflow to cards <768px (#60)", () => {
  test.describe.configure({ timeout: 120_000 });

  const TABLE_NAME = "Documents across projects";

  test.beforeEach(async ({ page }) => {
    const primed = await primeAdminUser(API_BASE);
    const project = await createProjectViaApi(API_BASE, primed.accessToken);

    // Seed one document so the /documents table renders rows (synchronous
    // text ingest lands `ready` immediately — no polling needed).
    const res = await page.request.post(`${API_BASE}/api/projects/${project.id}/documents/text`, {
      headers: { Authorization: `Bearer ${primed.accessToken}` },
      data: { filename: `mobile-${Date.now()}.md`, content: "# Mobile reflow fixture\n" },
    });
    expect(res.ok(), await res.text()).toBeTruthy();

    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  test("renders a card list (not a scrolling table) at 375px", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto("/documents", { waitUntil: "load" });

    // The mobile layout is a labelled list of cards…
    const cardList = page.getByRole("list", { name: TABLE_NAME });
    await expect(cardList).toBeVisible();
    await expect(cardList.getByRole("listitem").first()).toBeVisible();

    // …and the desktop <table> is removed from the a11y tree (display:none),
    // so no horizontally scrolling table is exposed to assistive tech.
    await expect(page.getByRole("table", { name: TABLE_NAME })).toHaveCount(0);

    // The row's action link keeps a ≥44px touch target on mobile.
    const openLink = cardList.getByRole("link", { name: /In project/ }).first();
    await expect(openLink).toBeVisible();
    const box = await openLink.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });

  test("renders a semantic table at desktop width (≥768px)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/documents", { waitUntil: "load" });

    // At desktop width the real table is exposed and the card list is hidden.
    await expect(page.getByRole("table", { name: TABLE_NAME })).toBeVisible();
    await expect(page.getByRole("list", { name: TABLE_NAME })).toHaveCount(0);
  });
});

// Issue #61 — mobile-tuned command palette. Below the 768px breakpoint the ⌘K
// palette presents as a bottom sheet rather than the centered desktop dialog,
// while keeping its combobox/listbox screen-reader semantics. Component-level
// behaviour is locked in by the vitest suite
// (ui/tests/command-palette-mobile.test.tsx); this asserts the integrated
// variant switch on the real authenticated shell.
test.describe("UI mobile — command palette bottom sheet <768px (#61)", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await primeAdminUser(API_BASE);
    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  test("opens as a bottom sheet with combobox/listbox semantics at 375px", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto("/dashboard", { waitUntil: "load" });

    // Ctrl+K opens the palette (the component accepts metaKey or ctrlKey).
    await openCommandPalette(page);

    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible();
    // Bottom-sheet variant, not the centered dialog.
    await expect(page.getByTestId("command-palette")).toHaveAttribute("data-variant", "sheet");
    // Screen-reader affordances survive the mobile variant.
    await expect(page.getByRole("combobox", { name: "Search commands" })).toBeVisible();
    await expect(page.getByRole("listbox")).toBeVisible();
  });

  test("opens as the centered dialog variant at desktop width (≥768px)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/dashboard", { waitUntil: "load" });

    await openCommandPalette(page);

    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    await expect(page.getByTestId("command-palette")).toHaveAttribute("data-variant", "dialog");
  });
});
