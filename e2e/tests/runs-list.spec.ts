/**
 * Coverage — Agent Runs at `/runs` and the run-review drill-in (Epic #158/#192).
 *
 * `/runs` lists agent-run replay parents in a table (or an empty state when no
 * runs exist yet). The deterministic e2e stack starts with an isolated DB, so
 * the table may be empty — the spec asserts the resilient "table OR empty
 * state" contract and that the runs query succeeds.
 *
 * The `/runs/[id]/review` page renders the PR-Reviewer output. With no review
 * record attached it shows its `run-review-empty` state; the spec asserts the
 * page renders one of its known states (panel | empty | error) without
 * crashing — proving the route + query wiring is intact.
 *
 * Acceptance criteria:
 *   AC: /runs renders the Agent Runs table OR the empty state from a 200.
 *   AC: drilling into /runs/[id]/review renders a known state, not a crash.
 *   AC: neither page issues a /api/api/ double-prefixed request.
 */
import { test, expect } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { watchForDoubleApiPrefix } from "../fixtures/no-double-api-prefix.js";

const API_BASE = apiBase();

test.describe("Agent Runs (#158) — list + review drill-in", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await primeAdminUser(API_BASE);
    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  test("the runs index renders the table or empty state from a 200", async ({ page }) => {
    const guard = watchForDoubleApiPrefix(page);

    const runsResponse = page.waitForResponse(
      (res) => /\/api\/runs(\?|$)/.test(res.url()) && res.request().method() === "GET",
      { timeout: 30_000 },
    );

    await page.goto("/runs", { waitUntil: "load" });

    await test.step("the runs list query returns 200", async () => {
      const res = await runsResponse;
      expect(res.status(), `GET ${res.url()} should not 404`).toBe(200);
      expect(res.url()).not.toContain("/api/api/");
    });

    await test.step("the page renders its scaffold + table-or-empty", async () => {
      await expect(page.getByTestId("runs-page")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Agent Runs" })).toBeVisible();
      // Project-ID filter input is part of the working list surface.
      await expect(page.getByLabel("Project ID")).toBeVisible();

      const table = page.getByTestId("runs-table");
      const empty = page.getByTestId("runs-empty");
      await expect
        .poll(async () => (await table.isVisible()) || (await empty.isVisible()))
        .toBe(true);
    });

    guard.assertClean();
  });

  test("the run-review page renders a known state for a run id", async ({ page }) => {
    const guard = watchForDoubleApiPrefix(page);

    // Synthetic id: with no matching review record the page shows its empty (or
    // error) state. Either proves the route + query wiring is intact.
    await page.goto("/runs/run_e2e_nonexistent/review", { waitUntil: "load" });

    await expect(page.getByTestId("run-review-page")).toBeVisible();
    await expect(page.getByRole("heading", { name: "PR Review" })).toBeVisible();

    const empty = page.getByTestId("run-review-empty");
    const error = page.getByTestId("run-review-error");
    const panel = page.getByText("Loading review…", { exact: true });
    await expect
      .poll(
        async () =>
          (await empty.isVisible()) || (await error.isVisible()) || (await panel.isVisible()),
      )
      .toBe(true);

    guard.assertClean();
  });
});
