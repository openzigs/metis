/**
 * Epic #164 — End-to-end coverage for the FinOps + safety surfaces.
 *
 * Verifies the API + UI behaviour the unit tests can't reach:
 *   1. PATCH /api/projects/:id/safety|budget|autopilot — RBAC + persistence.
 *   2. GET /api/projects/:id/usage — empty-state shape.
 *   3. The /projects/:id/usage UI page renders for an authenticated admin
 *      and shows the no-budget tile when the project has no cap.
 *   4. Toggling autopilot in the Settings card surfaces the warning banner.
 */
import { expect, request, test } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user";
import { apiBase } from "../fixtures/api-base";

const API_BASE = apiBase();

test.describe("Epic #164 — safety + FinOps", () => {
  test("API: PATCH safety/budget/autopilot persists and GET /usage returns the rollup", async () => {
    const { accessToken } = await primeAdminUser(API_BASE);
    const ctx = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
    });
    try {
      const slug = `e2e-finops-${Date.now()}`;
      const created = await ctx.post("/api/projects", {
        data: { name: `Finops ${slug}`, slug, description: "epic-164" },
      });
      expect(created.status(), await created.text()).toBe(201);
      const projectId = (await created.json()).data.id as string;

      // PATCH /safety — admin can switch modes.
      const safetyRes = await ctx.patch(`/api/projects/${projectId}/safety`, {
        data: { safetyMode: "strict" },
      });
      expect(safetyRes.status(), await safetyRes.text()).toBe(200);
      expect((await safetyRes.json()).data.safetyMode).toBe("strict");

      // PATCH /budget — admin only (admin.write).
      const budgetRes = await ctx.patch(`/api/projects/${projectId}/budget`, {
        data: { monthlyTokenBudget: 50_000 },
      });
      expect(budgetRes.status(), await budgetRes.text()).toBe(200);
      expect((await budgetRes.json()).data.monthlyTokenBudget).toBe(50_000);

      // PATCH /autopilot — enable + ceiling.
      const autopilotRes = await ctx.patch(`/api/projects/${projectId}/autopilot`, {
        data: { enabled: true, costCeilingCents: 500 },
      });
      expect(autopilotRes.status(), await autopilotRes.text()).toBe(200);
      const autopilotBody = (await autopilotRes.json()).data;
      expect(autopilotBody.autopilotEnabled).toBe(true);
      expect(autopilotBody.autopilotCostCeilingCents).toBe(500);

      // GET /usage — fresh project: zero usage, budget echoed back.
      const usageRes = await ctx.get(`/api/projects/${projectId}/usage`);
      expect(usageRes.status(), await usageRes.text()).toBe(200);
      const usage = (await usageRes.json()).data;
      expect(usage.totalTokens).toBe(0);
      expect(usage.monthlyTokenBudget).toBe(50_000);
      expect(Array.isArray(usage.byProvider)).toBe(true);
      expect(Array.isArray(usage.byDay)).toBe(true);

      // GET /safety-events — fresh project: no events.
      const evRes = await ctx.get(`/api/projects/${projectId}/safety-events`);
      expect(evRes.status()).toBe(200);
      const evBody = (await evRes.json()).data;
      expect(evBody.items).toEqual([]);
    } finally {
      await ctx.dispose();
    }
  });

  test("UI: usage page renders headline tiles + Settings exposes the autopilot warning", async ({
    page,
  }) => {
    // Browser login through the UI proxy so the auth cookie path runs.
    // Reuse the shared LoginPage page object: it handles the /api/auth/me
    // probe race and the cold Next.js dev compile timing that direct
    // page.goto + fill/click cannot reliably handle.
    const { LoginPage } = await import("../pages/login.page.js");
    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
    await expect(page).toHaveURL(/\/(dashboard|projects)\b/, { timeout: 60_000 });

    const slug = `e2e-finops-ui-${Date.now()}`;

    // Create the project via API in a parallel context so we don't depend
    // on the create-project dialog flow (covered by the full-flow suite).
    const { accessToken } = await primeAdminUser(API_BASE);
    const ctx = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
    });
    let projectId = "";
    try {
      const created = await ctx.post("/api/projects", {
        data: { name: `UI Finops ${slug}`, slug, description: "epic-164 ui" },
      });
      expect(created.status(), await created.text()).toBe(201);
      projectId = (await created.json()).data.id as string;
    } finally {
      await ctx.dispose();
    }

    // Navigate to the usage page directly.
    await page.goto(`/projects/${projectId}/usage`);
    await expect(page.getByTestId("usage-root")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("tile-mtd-tokens")).toContainText("0");
    await expect(page.getByTestId("usage-no-budget")).toBeVisible();

    // Back to the project detail and toggle autopilot.
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByTestId("autopilot-settings-card")).toBeVisible();
    await page.getByTestId("autopilot-toggle").click();
    await expect(page.getByTestId("autopilot-warning")).toBeVisible();
  });
});
