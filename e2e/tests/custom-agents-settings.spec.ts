/**
 * Regression — `/settings/agents` must not double-prefix `/api/api/` (P0 fix on
 * `fix/sdk-alignment-api-double-prefix`).
 *
 * This is the `/settings/agents` *settings surface* (the agents list + add-agent
 * form). It is distinct from `custom-agents.spec.ts`, which covers the
 * per-workspace authoring wizard and per-project enablement card. No overlap —
 * the two files exercise different routes/components.
 *
 * Before the fix, `sdkApi.listAgents()` requested
 * `/api/api/custom-agents?includeBuiltIns=1`, which 404'd; the page masked the
 * 404 as the silent "No agents yet." empty state. After the fix the proxied
 * `/api/custom-agents?includeBuiltIns=1` call returns 200 and the list renders.
 *
 * Determinism note on built-ins: the `/settings/agents` page calls
 * `sdkApi.listAgents()` with NO projectId, so the server resolves the query to
 * `{ projectId: null, isBuiltIn: true }` — i.e. it returns ONLY the built-in
 * fleet (project-scoped agents are excluded). Those built-ins are seeded by a
 * fire-and-forget `ensureBuiltInAgents()` at server boot that is *gated off
 * under NODE_ENV=test* and races page load in dev, so their count is NOT a
 * deterministic assertion in the isolated e2e stack. The durable regression
 * contract — the thing the P0 bug actually broke — is therefore asserted here:
 * the request must be correctly single-prefixed, return 200 (not the
 * double-prefixed 404), and the page must render its list/empty state FROM that
 * 200 rather than crashing. The masked-404 empty state is itself a 404, so a
 * confirmed 200 already proves the prefix is fixed.
 *
 * Acceptance criteria:
 *   AC: the GET /api/custom-agents?includeBuiltIns=1 query returns 200 (not 404).
 *   AC: navigating /settings/agents issues NO /api/api/ request.
 *   AC: the page renders its agents card (list or empty state) from that 200.
 */
import { test, expect } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { watchForDoubleApiPrefix } from "../fixtures/no-double-api-prefix.js";

const API_BASE = apiBase();

test.describe("Settings → Custom Agents — no /api/api/ double prefix (#112)", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await primeAdminUser(API_BASE);
    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  test("loads the agents list from a 200 over the single-prefix path", async ({ page }) => {
    const guard = watchForDoubleApiPrefix(page);

    // The list query carries includeBuiltIns=1. Capture it to assert 200.
    const listResponse = page.waitForResponse(
      (res) =>
        /\/api\/custom-agents\b/.test(res.url()) &&
        res.url().includes("includeBuiltIns=1") &&
        res.request().method() === "GET",
      { timeout: 30_000 },
    );

    await page.goto("/settings/agents", { waitUntil: "load" });

    await test.step("the custom-agents list query returns 200 (not 404)", async () => {
      const res = await listResponse;
      // Before the fix this was /api/api/custom-agents → 404. A 200 over the
      // single-prefix path is the core regression proof.
      expect(res.status(), `GET ${res.url()} should not 404`).toBe(200);
      expect(res.url()).not.toContain("/api/api/");
      const body = (await res.json()) as { success: boolean; data: unknown[] };
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
    });

    await test.step("the page renders its agents card from the 200", async () => {
      await expect(page.getByTestId("custom-agents-root")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Custom Agents" })).toBeVisible();
      const list = page.getByTestId("custom-agents-list");
      await expect(list).toBeVisible();
      // The card renders either real rows (when built-ins are seeded) or the
      // empty state — both derive from the confirmed 200, never a masked 404.
      const rows = list.locator('[data-testid^="ca-row-"]');
      const empty = list.getByText("No agents yet.", { exact: true });
      await expect
        .poll(async () => (await rows.count()) > 0 || (await empty.isVisible()))
        .toBe(true);
    });

    guard.assertClean();
  });
});
