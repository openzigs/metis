/**
 * Regression — the session list must not double-prefix `/api/api/` (P0 fix on
 * `fix/sdk-alignment-api-double-prefix`).
 *
 * #2350 — the `/sessions` page is folded into chat's history list: `/sessions`
 * redirects to `/chat`, whose "Your conversations" list reads the caller's own
 * sessions from `GET /api/ai/sessions`. The double-prefix guard moves with it.
 *
 * Acceptance criteria:
 *   AC: navigating /sessions lands on /chat and issues NO request whose URL contains /api/api/.
 *   AC: the GET /api/ai/sessions call returns 200 (not 404).
 *   AC: the history renders its list OR its empty state (from the 200), not a crash.
 */
import { test, expect } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { watchForDoubleApiPrefix } from "../fixtures/no-double-api-prefix.js";

const API_BASE = apiBase();

test.describe("Chat history — no /api/api/ double prefix (#122, #2350)", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await primeAdminUser(API_BASE);
    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  test("renders the history list from a 200 with no double prefix", async ({ page }) => {
    const guard = watchForDoubleApiPrefix(page);

    // Capture the history list's response so we can assert its status.
    const sessionsResponse = page.waitForResponse(
      (res) => /\/api\/ai\/sessions\?limit=/.test(res.url()) && res.request().method() === "GET",
      { timeout: 30_000 },
    );

    await page.goto("/sessions", { waitUntil: "load" });
    await expect(page).toHaveURL(/\/chat$/);

    await test.step("the history query returns 200 (not 404)", async () => {
      const res = await sessionsResponse;
      expect(res.status(), `GET ${res.url()} should not 404`).toBe(200);
      expect(res.url()).not.toContain("/api/api/");
    });

    await test.step("the history renders its list or its empty state", async () => {
      await expect(page.getByRole("navigation", { name: "Your conversations" })).toBeVisible();
      const rows = page.locator('[data-testid^="chat-history-"][href]');
      const empty = page.getByTestId("chat-history-empty");
      await expect
        .poll(async () => (await rows.count()) > 0 || (await empty.isVisible()))
        .toBe(true);
    });

    guard.assertClean();
  });
});
