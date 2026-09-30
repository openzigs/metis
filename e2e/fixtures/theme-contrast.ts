/**
 * Shared theme helpers for the light/dark e2e checks — #265/#266 first, then
 * the #273 New-project wizard. Picks a theme through the real header toggle and
 * measures WCAG contrast of the neutral text a screen paints.
 *
 * Colours are compared in sRGB by painting the computed value onto a canvas,
 * because Tailwind 4's palette computes to `oklch(...)` in Chromium.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { AppShellPage } from "../pages/app-shell.page.js";

export type Theme = "light" | "dark";

export interface TextSample {
  text: string;
  ratio: number;
}

/** Pick a theme through the real header toggle, then wait for next-themes to apply it. */
export async function chooseTheme(page: Page, theme: Theme): Promise<void> {
  const shell = new AppShellPage(page);
  await expect(shell.themeToggle).toBeEnabled();
  await shell.themeToggle.click();
  await page.getByTestId(`theme-${theme}`).click();
  if (theme === "dark") await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/);
  else await expect(page.locator("html")).not.toHaveClass(/(^|\s)dark(\s|$)/);
}

/** Relative luminance of `el`'s computed background colour, measured in sRGB via a canvas. */
export async function backgroundLuminance(el: Locator): Promise<number> {
  return el.evaluate((node) => {
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.fillStyle = getComputedStyle(node).backgroundColor;
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
export async function neutralTextContrast(page: Page, rootSelector: string): Promise<TextSample[]> {
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
