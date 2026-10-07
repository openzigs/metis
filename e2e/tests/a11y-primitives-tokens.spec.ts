/**
 * Accessible primitives (#268) and semantic status / chart tokens (#267),
 * checked in a real browser in BOTH themes (from research #263, P-3/P-4).
 *
 * | # | Criterion                                                             | Test                                          |
 * |---|-----------------------------------------------------------------------|-----------------------------------------------|
 * | 1 | #268 Tabs: arrow keys / Home / End; axe WCAG 2.2 AA clean             | Library tabs are keyboard-operable + axe      |
 * | 2 | #268 Dialog: focus trap, Escape, focus return; axe clean              | Sync drift dialog                             |
 * | 3 | #268 AlertDialog replaces window.confirm; axe clean                   | Jira connection delete confirmation (#818)    |
 * | 4 | #267 status tokens ≥4.5:1, chart tokens ≥3:1, in the COMPILED CSS     | status + chart token contrast probe           |
 * | 5 | #267 amber/warning badges ≥4.5:1 in the light theme (#285 carry-over) | covered by 4 (`text-warning` on its tint)     |
 *
 * The unit suite already computes the token ratios from `globals.css`. This
 * spec checks what the browser actually paints: a token that is missing from
 * `@theme inline`, or a class Tailwind never generated, passes the unit test
 * and fails here.
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { apiBase } from "../fixtures/api-base.js";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { createProjectViaApi } from "../fixtures/project-helpers.js";
import { seedDriftViaCli } from "../fixtures/seed-drift.js";
import { LoginPage } from "../pages/login.page.js";
import { AppShellPage } from "../pages/app-shell.page.js";
import { SyncPage } from "../pages/sync.page.js";
import { JiraPage } from "../pages/jira.page.js";

const API_BASE = apiBase();
const WCAG_22_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

type Theme = "light" | "dark";

async function chooseTheme(page: Page, theme: Theme): Promise<void> {
  const shell = new AppShellPage(page);
  await expect(shell.themeToggle).toBeEnabled();
  await shell.themeToggle.click();
  await page.getByTestId(`theme-${theme}`).click();
  if (theme === "dark") await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/);
  else await expect(page.locator("html")).not.toHaveClass(/(^|\s)dark(\s|$)/);
}

/** axe over one region only — the rest of the app is not this change's to fix. */
async function expectNoAxeViolations(page: Page, selector: string): Promise<void> {
  // Overlays fade/zoom in (tw-animate-css); axe measuring mid-animation reads
  // a partly transparent foreground as a contrast failure. Let them settle.
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );
  const results = await new AxeBuilder({ page }).include(selector).withTags(WCAG_22_AA).analyze();
  const summary = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.map((n) => `${n.target.join(" ")} — ${n.failureSummary ?? ""}`).slice(0, 5),
  }));
  expect(summary).toEqual([]);
}

function databaseUrl(): string {
  return process.env.E2E_DB_FILE
    ? `file:${process.env.E2E_DB_FILE}`
    : (process.env.E2E_DATABASE_URL ?? "file:./e2e/test-results/stack-data/metis-e2e.db");
}

interface Probe {
  name: string;
  ratio: number;
  min: number;
}

/**
 * Paint each status pairing with the app's own utility classes, then measure
 * the rendered colours (via a canvas, because Tailwind 4 computes to oklch/hsl
 * strings) and composite translucent backgrounds over the page background.
 */
async function measureTokenContrast(page: Page): Promise<Probe[]> {
  return page.evaluate(() => {
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
    const lum = ([r, g, b]: [number, number, number]) => {
      const lin = (c: number) => {
        const x = c / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const ratio = (a: [number, number, number], b: [number, number, number]) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const page = rgba(getComputedStyle(document.body).backgroundColor);
    const pageRgb: [number, number, number] = [page[0], page[1], page[2]];

    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:0;top:0;opacity:1;pointer-events:none";
    document.body.appendChild(host);
    const paint = (cls: string) => {
      const el = document.createElement("span");
      el.className = cls;
      el.textContent = "Aa";
      host.appendChild(el);
      const s = getComputedStyle(el);
      return { fg: rgba(s.color), bg: rgba(s.backgroundColor) };
    };

    const out: { name: string; ratio: number; min: number }[] = [];
    for (const status of ["success", "warning", "info"]) {
      // Soft badge / alert: `bg-X-muted text-X` (Badge + Alert variants).
      const soft = paint(`bg-${status}-muted text-${status}`);
      const softBg = over(soft.bg, pageRgb);
      out.push({
        name: `text-${status} on bg-${status}-muted`,
        ratio: ratio(over(soft.fg, softBg), softBg),
        min: 4.5,
      });
      // Plain status text on the page.
      const text = paint(`text-${status}`);
      out.push({
        name: `text-${status} on the page`,
        ratio: ratio(over(text.fg, pageRgb), pageRgb),
        min: 4.5,
      });
      // Solid fill: read the variables (`bg-warning` etc. are not all used in
      // source yet, so Tailwind may not have generated the utilities).
      const v = (name: string) =>
        rgba(`hsl(${getComputedStyle(document.documentElement).getPropertyValue(name).trim()})`);
      const fill = over(v(`--${status}`), pageRgb);
      out.push({
        name: `--${status}-foreground on --${status}`,
        ratio: ratio(over(v(`--${status}-foreground`), fill), fill),
        min: 4.5,
      });
      // A class Tailwind never generated would inherit the body colour and
      // "pass" by accident — so require the status text to differ from it.
      const bodyFg = rgba(getComputedStyle(document.body).color);
      out.push({
        name: `text-${status} is generated (differs from body text)`,
        ratio: text.fg.slice(0, 3).some((c, k) => Math.abs(c - bodyFg[k]) > 8) ? 1 : 0,
        min: 1,
      });
    }
    const destructive = paint("bg-destructive/10 text-destructive");
    const dBg = over(destructive.bg, pageRgb);
    out.push({
      name: "text-destructive on bg-destructive/10",
      ratio: ratio(over(destructive.fg, dBg), dBg),
      min: 4.5,
    });
    const dSolid = paint("bg-destructive text-destructive-foreground");
    const dsBg = over(dSolid.bg, pageRgb);
    out.push({
      name: "text-destructive-foreground on bg-destructive",
      ratio: ratio(over(dSolid.fg, dsBg), dsBg),
      min: 4.5,
    });

    // Chart series are painted through `hsl(var(--chart-N))` (ForecastChart),
    // so read the variables the page actually resolves.
    const root = getComputedStyle(document.documentElement);
    for (let i = 1; i <= 5; i += 1) {
      const c = rgba(`hsl(${root.getPropertyValue(`--chart-${i}`).trim()})`);
      out.push({
        name: `--chart-${i} against the page`,
        ratio: ratio(over(c, pageRgb), pageRgb),
        min: 3,
      });
    }
    host.remove();
    return out;
  });
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`${theme} theme — accessible primitives + tokens (#267, #268)`, () => {
    test.describe.configure({ timeout: 120_000 });

    let projectId: string;
    let accessToken: string;

    test.beforeEach(async ({ page }) => {
      const primed = await primeAdminUser(API_BASE);
      accessToken = primed.accessToken;
      projectId = (await createProjectViaApi(API_BASE, accessToken, `e2e-a11y-${theme}`)).id;
      const login = new LoginPage(page);
      await login.goto();
      await login.login(ADMIN_USER.username, ADMIN_USER.password);
    });

    test("Library tabs are keyboard-operable and axe-clean (#268)", async ({ page }) => {
      await page.goto("/library", { waitUntil: "load" });
      const tablist = page.getByRole("tablist", { name: "Library sections" });
      await expect(tablist).toBeVisible();
      await chooseTheme(page, theme);

      // #31 — Skills and Agents replaced Browse as the first two Library tabs.
      const skills = tablist.getByRole("tab", { name: "Skills" });
      const agents = tablist.getByRole("tab", { name: "Agents" });
      const connectors = tablist.getByRole("tab", { name: "Connectors" });
      await skills.focus();
      await page.keyboard.press("ArrowRight");
      await expect(agents).toBeFocused();
      await expect(agents).toHaveAttribute("aria-selected", "true");
      const panelId = await agents.getAttribute("aria-controls");
      await expect(page.locator(`[id="${panelId}"]`)).toHaveAttribute("role", "tabpanel");
      await page.keyboard.press("End");
      await expect(connectors).toBeFocused();
      await page.keyboard.press("Home");
      await expect(skills).toBeFocused();
      await expect(skills).toHaveAttribute("aria-selected", "true");

      await expectNoAxeViolations(page, "[data-testid='library-root']");
    });

    test("the drift Dialog traps focus, closes on Escape, returns focus (#268)", async ({
      page,
    }) => {
      seedDriftViaCli({ projectId, databaseUrl: databaseUrl(), field: "title" });
      const sync = new SyncPage(page);
      await sync.goto(projectId);
      await chooseTheme(page, theme);

      const row = page.getByRole("button", { name: /title changed/ }).first();
      await row.focus();
      await page.keyboard.press("Enter");
      await expect(sync.diffModal).toBeVisible();
      for (let i = 0; i < 10; i += 1) {
        await page.keyboard.press("Tab");
        expect(
          await sync.diffModal.evaluate((d) => d.contains(document.activeElement)),
          `focus escaped the dialog after ${i + 1} Tab presses`,
        ).toBe(true);
      }
      await expectNoAxeViolations(page, "[role='dialog']");
      await page.keyboard.press("Escape");
      await expect(sync.diffModal).toBeHidden();
      await expect(row).toBeFocused();
    });

    test("an AlertDialog, not window.confirm, gates delete (#268)", async ({ page }) => {
      const now = new Date().toISOString();
      // #818 — re-pointed from the removed Xray/Zephyr/TestRail page at the Jira
      // connection delete, which uses the same ConfirmDialog primitive.
      const row = {
        id: "conn-a11y",
        projectId,
        label: "A11y Jira",
        edition: "cloud",
        baseUrl: "https://a11y.atlassian.net",
        username: "a11y@example.com",
        secretMasked: "••••••••",
        proxyUrl: null,
        tlsRejectUnauthorized: true,
        hasTlsCa: false,
        status: "untested",
        errorMessage: null,
        lastTestedAt: null,
        createdById: "u1",
        createdAt: now,
        updatedAt: now,
      };
      let deleted = false;
      await page.route("**/api/jira/connections**", (route) => {
        if (route.request().method() === "DELETE") {
          deleted = true;
          return route.fulfill({ status: 204, body: "" });
        }
        if (route.request().method() === "GET") {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ success: true, data: deleted ? [] : [row] }),
          });
        }
        return route.fallback();
      });
      // A native dialog would be a regression: fail loudly instead of hanging.
      page.on("dialog", (d) => {
        void d.dismiss();
        throw new Error(`native ${d.type()} dialog opened: ${d.message()}`);
      });

      const jira = new JiraPage(page);
      await jira.goto(projectId);
      await chooseTheme(page, theme);
      const del = jira.connectionCard(row.label).getByRole("button", { name: "Delete" });
      await del.click();

      const confirm = page.getByRole("alertdialog", {
        name: "Delete this Jira connection?",
      });
      await expect(confirm).toBeVisible();
      await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
      await expectNoAxeViolations(page, "[role='alertdialog']");

      await page.keyboard.press("Escape");
      await expect(confirm).toBeHidden();
      await expect(del).toBeFocused();
      expect(deleted).toBe(false);

      await del.click();
      await confirm.getByRole("button", { name: "Delete" }).click();
      await expect(del).toBeHidden();
      expect(deleted).toBe(true);
    });

    test("status tokens clear 4.5:1 and chart tokens 3:1 as painted (#267)", async ({
      page,
    }, testInfo) => {
      await page.goto("/library", { waitUntil: "load" });
      await expect(page.getByRole("tablist", { name: "Library sections" })).toBeVisible();
      await chooseTheme(page, theme);
      const probes = await measureTokenContrast(page);
      await testInfo.attach(`token-contrast-${theme}.json`, {
        body: JSON.stringify(probes, null, 2),
        contentType: "application/json",
      });
      expect(probes.length).toBe(19);
      expect(probes.filter((p) => !(p.ratio >= p.min))).toEqual([]);
    });
  });
}
