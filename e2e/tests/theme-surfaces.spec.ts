/**
 * Theme toggle vs OS colour scheme — #265, #266 (from research #263, P-1/P-2).
 *
 * | # | Criterion                                                                | Test                                              |
 * |---|--------------------------------------------------------------------------|---------------------------------------------------|
 * | 1 | #265 Light chosen on a dark OS renders light surfaces (and vice versa)    | `dark:` utilities follow the chosen theme         |
 * | 2 | #266 Templates heading/panels legible (≥4.5:1) in both themes            | Templates screen text clears 4.5:1                |
 * | 3 | #266 Analysis panels legible (≥4.5:1) in both themes                     | Analysis screen neutral text clears 4.5:1         |
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
import { apiBase } from "../fixtures/api-base.js";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { createProjectViaApi } from "../fixtures/project-helpers.js";
import { LoginPage } from "../pages/login.page.js";
import { AppShellPage } from "../pages/app-shell.page.js";
import { TemplateSettingsPage } from "../pages/template-settings.page.js";

const API_BASE = apiBase();

type Theme = "light" | "dark";

interface TextSample {
  text: string;
  ratio: number;
}

/** Pick a theme through the real header toggle, then wait for next-themes to apply it. */
async function chooseTheme(page: Page, theme: Theme): Promise<void> {
  const shell = new AppShellPage(page);
  await expect(shell.themeToggle).toBeEnabled();
  await shell.themeToggle.click();
  await page.getByTestId(`theme-${theme}`).click();
  if (theme === "dark") await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/);
  else await expect(page.locator("html")).not.toHaveClass(/(^|\s)dark(\s|$)/);
}

/**
 * Relative luminance of the background a `bg-green-50 dark:bg-green-950` probe
 * paints. Tailwind only compiles classes that appear in source, so the probe
 * must use a pair the app still ships (3 call sites at #267). #267 moved
 * `derivation-badge.tsx` — the previous probe's source, `bg-white
 * dark:bg-zinc-900` — onto semantic tokens; when the raw-palette follow-up
 * removes the last `dark:bg-green-950`, move this probe again.
 */
async function probeLuminance(page: Page): Promise<number> {
  return page.evaluate(() => {
    const probe = document.createElement("div");
    probe.className = "bg-green-50 dark:bg-green-950";
    probe.style.cssText = "position:fixed;left:0;top:0;width:4px;height:4px";
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).backgroundColor;
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

/**
 * WCAG contrast of every visible text element inside `root` whose colour is
 * neutral (grey), composited over its effective background. Coloured status
 * text (amber/red/emerald…) is left to the semantic-token work in #263 P-3.
 */
async function neutralTextContrast(page: Page, rootSelector: string): Promise<TextSample[]> {
  return page.evaluate((selector) => {
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const rgba = (color: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "rgba(0,0,0,0)";
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (
      top: [number, number, number, number],
      under: [number, number, number],
    ): [number, number, number] => [
      top[0] * top[3] + under[0] * (1 - top[3]),
      top[1] * top[3] + under[1] * (1 - top[3]),
      top[2] * top[3] + under[2] * (1 - top[3]),
    ];
    const backgroundOf = (el: Element): [number, number, number] => {
      const layers: [number, number, number, number][] = [];
      for (let node: Element | null = el; node; node = node.parentElement) {
        const layer = rgba(getComputedStyle(node).backgroundColor);
        if (layer[3] > 0) layers.push(layer);
        if (layer[3] >= 1) break;
      }
      let base: [number, number, number] = [255, 255, 255];
      for (const layer of layers.reverse()) base = over(layer, base);
      return base;
    };
    const lum = ([r, g, b]: [number, number, number]) => {
      const lin = (c: number) => {
        const x = c / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };

    const root = document.querySelector(selector);
    if (!root) return [];
    const samples: { text: string; ratio: number }[] = [];
    for (const el of Array.from(root.querySelectorAll("*"))) {
      const ownText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? "")
        .join("")
        .trim();
      if (!ownText) continue;
      const style = getComputedStyle(el);
      const box = (el as HTMLElement).getBoundingClientRect();
      if (style.visibility === "hidden" || style.display === "none" || box.width === 0) continue;
      if (
        Number(style.opacity) < 1 ||
        (el as HTMLElement).closest("[disabled], [aria-disabled='true']")
      )
        continue; // SC 1.4.3 exempts inactive components.
      const text = rgba(style.color);
      if (Math.max(text[0], text[1], text[2]) - Math.min(text[0], text[1], text[2]) > 16) continue;
      const bg = backgroundOf(el);
      const fg = over(text, bg);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      samples.push({ text: ownText.slice(0, 60), ratio: (hi + 0.05) / (lo + 0.05) });
    }
    return samples;
  }, rootSelector);
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
        expect(luminance, "bg-green-50 dark:bg-green-950 probe").toBeGreaterThan(0.8);
      else expect(luminance, "bg-green-50 dark:bg-green-950 probe").toBeLessThan(0.05);
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
