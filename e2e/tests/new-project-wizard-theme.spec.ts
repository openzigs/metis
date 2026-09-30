/**
 * #273 — the first-run New-project wizard, checked in light and dark themes.
 *
 * | # | Criterion (#273)                                         | Test                                          |
 * |---|----------------------------------------------------------|-----------------------------------------------|
 * | 3 | "checked in light and dark themes"                       | every wizard step's text clears 4.5:1, per theme |
 * | 1 | wizard creates the project and lands on its Overview      | Create lands on the Overview, theme intact    |
 *
 * As in `theme-surfaces.spec.ts`, each theme runs with the browser's
 * `prefers-color-scheme` set OPPOSITE to the theme picked in the app's toggle —
 * the combination that exposed #265.
 *
 * The wizard is the Home Projects widget's EMPTY-state action, and this suite
 * shares one database across specs, so the widget's list call is answered with
 * an empty page. Everything else — auth, `POST /projects`, the Overview — is the
 * real stack. The source step is filled in (so its repository fields render and
 * are measured), then switched to "Skip" before Create: the deterministic stack
 * has no network, and a Deep Ingest would only fail in the background.
 */
import { test, expect, type Page } from "@playwright/test";
import { apiBase } from "../fixtures/api-base.js";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { chooseTheme, neutralTextContrast, type Theme } from "../fixtures/theme-contrast.js";
import { LoginPage } from "../pages/login.page.js";

const API_BASE = apiBase();
const DIALOG = '[role="dialog"]';

/** Answer the Home Projects widget's `GET /projects?limit=5` with no projects. */
async function emptyProjectsWidget(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.endsWith("/api/projects") && url.searchParams.get("limit") === "5",
    (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ json: { items: [], total: 0, limit: 5, offset: 0 } })
        : route.continue(),
  );
}

/** Measure the open dialog, save a screenshot, and require every neutral text to clear 4.5:1. */
async function expectLegible(
  page: Page,
  shot: string,
  mustInclude: string[],
  outputPath: (name: string) => string,
): Promise<void> {
  await page.screenshot({ path: outputPath(shot) });
  const samples = await neutralTextContrast(page, DIALOG);
  const texts = samples.map((s) => s.text);
  for (const t of mustInclude) expect(texts, `measured text on ${shot}`).toContain(t);
  expect(
    samples.filter((s) => s.ratio < 4.5),
    `low-contrast text on ${shot}`,
  ).toEqual([]);
}

const SCENARIOS: Array<{ os: Theme; theme: Theme }> = [
  { os: "dark", theme: "light" },
  { os: "light", theme: "dark" },
];

for (const { os, theme } of SCENARIOS) {
  test.describe(`New-project wizard — ${theme} theme on a ${os} OS (#273)`, () => {
    test.describe.configure({ timeout: 120_000 });
    test.use({ colorScheme: os });

    test.beforeEach(async ({ page }) => {
      await primeAdminUser(API_BASE);
      const login = new LoginPage(page);
      await login.goto();
      await login.login(ADMIN_USER.username, ADMIN_USER.password);
    });

    test("every step is legible, and Create lands on the Overview", async ({ page }, testInfo) => {
      const out = (name: string) => testInfo.outputPath(`${name}-${theme}.png`);
      const suffix = `${theme}-${Date.now()}`;

      await emptyProjectsWidget(page);
      await page.goto("/dashboard", { waitUntil: "load" });
      const widget = page.getByTestId("widget-projects");
      await expect(widget.getByText("No projects yet")).toBeVisible();
      await chooseTheme(page, theme);
      // Picking Light can leave the theme menu open; close it so it is not in the screenshots.
      await page.keyboard.press("Escape");
      await expect(page.getByTestId(`theme-${theme}`)).toBeHidden();

      await test.step("Name", async () => {
        await widget.getByTestId("new-project-wizard-button").click();
        await expect(page.getByRole("dialog", { name: "New project" })).toBeVisible();
        await page.getByTestId("wizard-name-input").fill(`Wizard ${suffix}`);
        await expect(page.getByTestId("wizard-slug-input")).toHaveValue(`wizard-${suffix}`);
        await expectLegible(page, "wizard-name", ["New project", "Slug", "2. Source"], out);
        await page.getByRole("button", { name: "Next" }).click();
      });

      await test.step("Source", async () => {
        await page.getByTestId("wizard-owner-input").fill("acme-corp");
        await page.getByTestId("wizard-repo-input").fill("my-app");
        await expectLegible(
          page,
          "wizard-source",
          ["Where is the code?", "Needed for a private repository."],
          out,
        );
        await page.getByLabel("Skip — add a source later").check();
        await expectLegible(page, "wizard-source-skip", ["Skip — add a source later"], out);
        await page.getByRole("button", { name: "Next" }).click();
      });

      await test.step("Ingest", async () => {
        await expect(page.getByTestId("wizard-summary")).toContainText("None");
        await expectLegible(page, "wizard-ingest", ["Project", "Source"], out);
        await page.getByTestId("wizard-create").click();
      });

      await test.step("Overview", async () => {
        await expect(page).toHaveURL(/\/projects\/[^/]+$/);
        await expect(page.getByTestId("project-pipeline")).toBeVisible({ timeout: 20_000 });
        if (theme === "dark") await expect(page.locator("html")).toHaveClass(/(^|\s)dark(\s|$)/);
        else await expect(page.locator("html")).not.toHaveClass(/(^|\s)dark(\s|$)/);
        await page.screenshot({ path: out("wizard-overview"), fullPage: true });
      });
    });
  });
}
