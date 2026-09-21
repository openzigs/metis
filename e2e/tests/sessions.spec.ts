/**
 * Regression — `/sessions` must not double-prefix `/api/api/` (P0 fix on
 * `fix/sdk-alignment-api-double-prefix`).
 *
 * Before the fix, `sdkApi.listResumable()` requested `/api/api/ai/sessions?...`
 * which 404'd; the page swallowed it as a silent empty state. After the fix the
 * proxied `/api/ai/sessions?status=resumable` call returns 200 and the page
 * renders either its list or the legitimate "No resumable sessions." empty
 * state from that 200.
 *
 * Acceptance criteria:
 *   AC: navigating /sessions issues NO request whose URL contains /api/api/.
 *   AC: the GET /api/ai/sessions?status=resumable call returns 200 (not 404).
 *   AC: the page renders its list OR its empty state (from the 200), not a crash.
 */
import { test, expect } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { watchForDoubleApiPrefix } from "../fixtures/no-double-api-prefix.js";

const API_BASE = apiBase();

test.describe("Sessions page — no /api/api/ double prefix (#122)", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await primeAdminUser(API_BASE);
    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  test("renders the resumable-sessions surface from a 200 with no double prefix", async ({
    page,
  }) => {
    const guard = watchForDoubleApiPrefix(page);

    // Capture the resumable-sessions response so we can assert its status.
    const sessionsResponse = page.waitForResponse(
      (res) =>
        /\/api\/ai\/sessions\b/.test(res.url()) &&
        res.url().includes("status=resumable") &&
        res.request().method() === "GET",
      { timeout: 30_000 },
    );

    await page.goto("/sessions", { waitUntil: "load" });

    await test.step("the resumable-sessions query returns 200 (not 404)", async () => {
      const res = await sessionsResponse;
      expect(res.status(), `GET ${res.url()} should not 404`).toBe(200);
      // The double-prefixed URL never reaches a real route, so a 200 here is
      // itself proof the prefix is correct — but assert the URL shape too.
      expect(res.url()).not.toContain("/api/api/");
    });

    await test.step("the page renders its list or the legitimate empty state", async () => {
      await expect(page.getByTestId("sessions-root")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
      // Either at least one session row OR the empty-state copy that the page
      // shows when the 200 returns an empty array.
      const rows = page.locator('[data-testid^="sess-row-"]');
      const empty = page.getByText("No resumable sessions.", { exact: true });
      await expect
        .poll(async () => (await rows.count()) > 0 || (await empty.isVisible()))
        .toBe(true);
    });

    guard.assertClean();
  });
});
