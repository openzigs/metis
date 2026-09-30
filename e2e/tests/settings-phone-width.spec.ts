/**
 * #508 — `/settings/mcp` and `/settings/auth` at phone width (390px).
 *
 * Both pages used to scroll sideways: their tab rows neither wrapped nor
 * scrolled, so the page's `scrollWidth` grew past the viewport (560 and 466).
 * And the header's workspace switcher drew over the current-page crumb,
 * because a breadcrumb item may shrink (`min-w-0`) while the switcher button
 * inside it could not.
 *
 * The class contract that fixes each of these is pinned by the vitest suite
 * (ui/tests/phone-width-overflow.test.tsx), which runs in CI; this spec checks
 * the layout it produces in a real browser.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
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
});
