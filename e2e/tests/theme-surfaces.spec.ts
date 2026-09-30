/**
 * Theme toggle vs OS colour scheme — #265, #266 (from research #263, P-1/P-2).
 *
 * | # | Criterion                                                                | Test                                              |
 * |---|--------------------------------------------------------------------------|---------------------------------------------------|
 * | 1 | #265 Light chosen on a dark OS renders light surfaces (and vice versa)    | `dark:` utilities follow the chosen theme         |
 * | 2 | #266 Templates heading/panels legible (≥4.5:1) in both themes            | Templates screen text clears 4.5:1                |
 * | 3 | #266 Analysis panels legible (≥4.5:1) in both themes                     | Analysis screen neutral text clears 4.5:1         |
 * | 4 | #429 Toasts follow the theme chosen in the app's toggle                  | a toast renders in the chosen theme               |
 *
 * Each case runs twice with the browser's `prefers-color-scheme` set OPPOSITE
 * to the theme picked in the app's own toggle, which is the combination that
 * exposed the bug: before #265, `dark:` utilities followed the OS while the
 * token colours followed the toggle.
 *
 * Colours are compared in sRGB by painting the computed value onto a canvas,
 * because Tailwind 4's palette computes to `oklch(...)` in Chromium.
 */
import { test, expect, type Page } from "@playwright/test";
import {
  backgroundLuminance,
  chooseTheme,
  neutralTextContrast,
  type Theme,
} from "../fixtures/theme-contrast.js";
import { apiBase } from "../fixtures/api-base.js";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { createProjectViaApi } from "../fixtures/project-helpers.js";
import { LoginPage } from "../pages/login.page.js";
import { TemplateSettingsPage } from "../pages/template-settings.page.js";

const API_BASE = apiBase();

/**
 * Relative luminance of the TEXT colour a `prose dark:prose-invert` probe
 * paints. Tailwind only compiles classes that appear in source, so the probe
 * must use a `dark:` utility the app still ships. #301 moved every raw palette
 * class (and with them every `dark:bg-*` twin) onto theme tokens, so the probe
 * moved from `bg-green-50 dark:bg-green-950` to the markdown renderers'
 * `dark:prose-invert`: dark body text on the Light theme, light on Dark.
 */
async function probeLuminance(page: Page): Promise<number> {
  return page.evaluate(() => {
    const probe = document.createElement("div");
    probe.className = "prose dark:prose-invert";
    probe.textContent = "probe";
    probe.style.cssText = "position:fixed;left:0;top:0";
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    const lin = (c: number) => {
      const x = c / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  });
}

const SCENARIOS: Array<{ os: Theme; theme: Theme }> = [
  { os: "dark", theme: "light" },
  { os: "light", theme: "dark" },
];

for (const { os, theme } of SCENARIOS) {
  test.describe(`${theme} theme on a ${os} OS (#265, #266)`, () => {
    test.describe.configure({ timeout: 120_000 });
    test.use({ colorScheme: os });

    let projectId: string;

    test.beforeEach(async ({ page }) => {
      const primed = await primeAdminUser(API_BASE);
      projectId = (await createProjectViaApi(API_BASE, primed.accessToken, "e2e-theme")).id;
      const login = new LoginPage(page);
      await login.goto();
      await login.login(ADMIN_USER.username, ADMIN_USER.password);
    });

    test("dark: utilities follow the chosen theme, not the OS (#265)", async ({ page }) => {
      const templates = new TemplateSettingsPage(page);
      await templates.goto(projectId);
      await expect(templates.heading).toBeVisible();
      await chooseTheme(page, theme);

      const luminance = await probeLuminance(page);
      if (theme === "light")
        expect(luminance, "prose dark:prose-invert probe text").toBeLessThan(0.15);
      else expect(luminance, "prose dark:prose-invert probe text").toBeGreaterThan(0.4);
    });

    test("Templates screen text clears 4.5:1 (#266)", async ({ page }, testInfo) => {
      const templates = new TemplateSettingsPage(page);
      await templates.goto(projectId);
      await chooseTheme(page, theme);
      await templates.waitForTemplatesLoaded();
      await expect(templates.heading).toBeVisible();

      await page.screenshot({
        path: testInfo.outputPath(`templates-${theme}.png`),
        fullPage: true,
      });
      const samples = await neutralTextContrast(page, "main");
      expect(samples.map((s) => s.text)).toContain("Issue Templates");
      expect(samples.filter((s) => s.ratio < 4.5)).toEqual([]);
    });

    test("a toast renders in the chosen theme, not sonner's light default (#429)", async ({
      page,
    }, testInfo) => {
      await page.goto(`/projects/${projectId}/settings`, { waitUntil: "load" });
      const card = page.getByTestId("autopilot-settings-card");
      await expect(card).toBeVisible({ timeout: 15_000 });
      await chooseTheme(page, theme);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId(`theme-${theme}`)).toBeHidden();

      await card.getByTestId("autopilot-ceiling-input").fill("5");
      await card.getByTestId("autopilot-save-button").click();
      const toast = page.locator("[data-sonner-toast]").filter({
        hasText: "Autopilot settings saved",
      });
      await expect(toast).toBeVisible({ timeout: 10_000 });
      await page.screenshot({ path: testInfo.outputPath(`toast-${theme}.png`) });

      await expect(page.locator("[data-sonner-toaster]")).toHaveAttribute(
        "data-sonner-theme",
        theme,
      );
      // richColors success: pale green on Light, near-black green on Dark.
      const luminance = await backgroundLuminance(toast);
      if (theme === "light") expect(luminance, "toast background").toBeGreaterThan(0.6);
      else expect(luminance, "toast background").toBeLessThan(0.1);
    });

    test("Analysis screen neutral text clears 4.5:1 (#266)", async ({ page }, testInfo) => {
      await page.goto(`/projects/${projectId}/analysis`, { waitUntil: "load" });
      await expect(page.getByRole("heading", { name: /Requirements Analysis/ })).toBeVisible();
      await chooseTheme(page, theme);

      await page.screenshot({ path: testInfo.outputPath(`analysis-${theme}.png`), fullPage: true });
      const samples = await neutralTextContrast(page, "main");
      expect(samples.length).toBeGreaterThan(0);
      expect(samples.filter((s) => s.ratio < 4.5)).toEqual([]);
    });
  });
}
