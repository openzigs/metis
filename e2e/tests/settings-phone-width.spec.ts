/**
 * #508 — `/settings/mcp` and `/settings/auth` at phone width (390px).
 *
 * Both pages used to scroll sideways: their tab rows neither wrapped nor
 * scrolled, so the page's `scrollWidth` grew past the viewport (560 and 466).
 * And the header's workspace switcher drew over the current-page crumb,
 * because a breadcrumb item may shrink (`min-w-0`) while the switcher button
 * inside it could not.
 *
 * #529 — no longer overlapping was not enough: the one header row left the
 * breadcrumb ~100px, so the current-page crumb was cut to 1–2 characters. Below
 * `sm` the breadcrumb now takes a second header row of its own, and the
 * current-page crumb keeps its width while the switchers truncate. The project
 * switcher is measured on a project page too.
 *
 * The class contract that fixes each of these is pinned by the vitest suite
 * (ui/tests/phone-width-overflow.test.tsx), which runs in CI; this spec checks
 * the layout it produces in a real browser.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { createProjectViaApi } from "../fixtures/project-helpers.js";
import { LoginPage } from "../pages/login.page.js";

const PHONE = { width: 390, height: 844 };

async function documentScrollWidth(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth);
}

async function expectNoOverlap(a: Locator, b: Locator): Promise<void> {
  const boxA = await a.boundingBox();
  const boxB = await b.boundingBox();
  expect(boxA).not.toBeNull();
  expect(boxB).not.toBeNull();
  const [left, right] = boxA!.x <= boxB!.x ? [boxA!, boxB!] : [boxB!, boxA!];
  expect(left.x + left.width).toBeLessThanOrEqual(right.x + 0.5);
}

/**
 * The current-page crumb shows its whole label — nothing truncated away, which
 * is what cut it to "M" / "A." before #529 — fully inside the viewport.
 */
async function expectReadableCrumb(current: Locator, label: string | RegExp): Promise<void> {
  await expect(current).toHaveText(label);
  await expect(current).toBeInViewport({ ratio: 1 });
  const { width, truncated } = await current.evaluate((el) => ({
    width: el.getBoundingClientRect().width,
    truncated: el.scrollWidth > el.clientWidth,
  }));
  expect(truncated, `"${String(label)}" crumb is truncated at ${width}px`).toBe(false);
}

test.describe("Settings at phone width (#508)", () => {
  test.beforeEach(async ({ page }) => {
    await new LoginPage(page).loginAsAdmin();
    await page.setViewportSize(PHONE);
  });

  for (const { path, tabList } of [
    { path: "/settings/mcp", tabList: "MCP platform sections" },
    { path: "/settings/auth", tabList: undefined },
  ]) {
    test(`${path} does not scroll horizontally; its tabs scroll within themselves`, async ({
      page,
    }) => {
      await page.goto(path, { waitUntil: "load" });
      const list = tabList
        ? page.getByRole("tablist", { name: tabList })
        : page.getByRole("tablist").first();
      await expect(list).toBeVisible();

      expect(await documentScrollWidth(page)).toBe(PHONE.width);
      // The last tab is reachable by scrolling the tab list, not the page.
      const overflows = await list.evaluate((el) => el.scrollWidth > el.clientWidth);
      expect(overflows).toBe(true);
      await list.getByRole("tab").last().scrollIntoViewIfNeeded();
      await expect(list.getByRole("tab").last()).toBeInViewport();
      expect(await documentScrollWidth(page)).toBe(PHONE.width);
    });

    test(`${path}: the workspace switcher does not overlap the current-page crumb`, async ({
      page,
    }) => {
      await page.goto(path, { waitUntil: "load" });
      const crumbs = page.getByTestId("header-breadcrumb");
      const switcher = crumbs.getByTestId("workspace-switcher");
      const current = crumbs.locator('[aria-current="page"]');
      await expect(switcher).toBeVisible();
      await expect(current).toBeVisible();
      await expectNoOverlap(switcher, current);
    });
  }

  test("/settings/mcp: the current-page crumb is readable (#529)", async ({ page }) => {
    await page.goto("/settings/mcp", { waitUntil: "load" });
    const crumbs = page.getByTestId("header-breadcrumb");
    await expect(crumbs.getByTestId("workspace-switcher")).toBeVisible();
    await expectReadableCrumb(crumbs.locator('[aria-current="page"]'), /^MCP servers$/);
    expect(await documentScrollWidth(page)).toBe(PHONE.width);
  });
});

test.describe("Project pages at phone width (#529)", () => {
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const { accessToken } = await primeAdminUser(apiBase());
    // A long name: the switcher must truncate it rather than squeeze the crumb.
    ({ id: projectId } = await createProjectViaApi(apiBase(), accessToken, "e2e-phone-header"));
    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
    await page.setViewportSize(PHONE);
  });

  for (const { sub, label } of [
    { sub: "", label: "Overview" },
    { sub: "/requirements", label: "Review" },
  ]) {
    test(`/projects/:id${sub}: both switchers and a readable crumb, none overlapping`, async ({
      page,
    }) => {
      await page.goto(`/projects/${projectId}${sub}`, { waitUntil: "load" });
      const crumbs = page.getByTestId("header-breadcrumb");
      const workspace = crumbs.getByTestId("workspace-switcher");
      const project = crumbs.getByRole("button", { name: /^Active project: IA Test e2e-phone/ });
      const current = crumbs.locator('[aria-current="page"]');
      await expect(workspace).toBeVisible();
      await expect(project).toBeVisible();

      await expectReadableCrumb(current, label);
      await expectNoOverlap(workspace, project);
      await expectNoOverlap(project, current);
      // Each switcher keeps at least its icon and chevron: still a usable target.
      for (const sw of [workspace, project]) {
        expect((await sw.boundingBox())!.width).toBeGreaterThanOrEqual(32);
        await expect(sw).toBeInViewport({ ratio: 1 });
      }
      expect(await documentScrollWidth(page)).toBe(PHONE.width);
    });
  }
});
