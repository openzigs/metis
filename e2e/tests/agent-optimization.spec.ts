/**
 * Epic #596 — Agent & Skill Token Optimization — E2E tests.
 *
 * Covers acceptance criteria from:
 *   - Issue #620: Per-Agent-Step Token Instrumentation (UI + API)
 *   - Issue #616: AST Summary Cache (API endpoint)
 *
 * Approach:
 *   - API-level tests validate `groupBy=agentStep` for project + admin usage
 *     endpoints and the AST cache rebuild endpoint.
 *   - UI tests navigate the project usage page and verify the agent step
 *     breakdown section renders correctly with the new groupBy option.
 *
 * Prerequisites: Playwright webServer boots API (4101) and UI (3101) with
 * AI_PROVIDER=offline-stub.
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER, primeAdminUser, type PrimeResult } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { ProjectUsagePage } from "../pages/usage.page.js";
import { AdminUsagePage } from "../pages/admin-usage.page.js";

const API_BASE = apiBase();

/** Envelope shape returned by the Express ok() wrapper. */
interface ApiEnvelope<T> {
  success: boolean;
  data: T;
}

async function authedApi(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Shared project state — created once in beforeAll and used across all tests.
// ────────────────────────────────────────────────────────────────────────────
let primed: PrimeResult;
let projectId: string;
const slug = `e2e-agent-opt-${Date.now().toString(36)}`;

test.describe("Epic #596 — Agent & Skill Token Optimization", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async () => {
    primed = await primeAdminUser(API_BASE);
    const ctx = await authedApi(primed.accessToken);
    try {
      const createRes = await ctx.post("/api/projects", {
        data: { name: "Agent Opt E2E Project", slug, description: "e2e agent optimization" },
      });
      expect(createRes.status()).toBe(201);
      const body = (await createRes.json()) as ApiEnvelope<{ id: string }>;
      projectId = body.data.id;
      expect(projectId).toBeTruthy();
    } finally {
      await ctx.dispose();
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  // Issue #620 — agentStep groupBy in Usage API
  // ════════════════════════════════════════════════════════════════════════
  test.describe("Issue #620 — agentStep Usage API", () => {
    // AC: Usage API supports groupBy=agentStep for dashboard queries
    test("GET /api/projects/:id/usage?groupBy=agentStep returns valid data", async () => {
      const ctx = await authedApi(primed.accessToken);
      try {
        const res = await ctx.get(`/api/projects/${projectId}/usage?range=7d&groupBy=agentStep`);
        expect(res.status()).toBe(200);

        const body = (await res.json()) as ApiEnvelope<{
          totalTokens: number;
          totalCostUsd: number;
          rows: unknown[];
        }>;
        expect(body.success).toBe(true);
        expect(typeof body.data.totalTokens).toBe("number");
        expect(typeof body.data.totalCostUsd).toBe("number");
        expect(Array.isArray(body.data.rows)).toBe(true);
      } finally {
        await ctx.dispose();
      }
    });

    // AC: Admin usage endpoint also supports groupBy=agentStep
    test("GET /api/admin/usage?groupBy=agentStep returns valid data", async () => {
      const ctx = await authedApi(primed.accessToken);
      try {
        const res = await ctx.get("/api/admin/usage?range=7d&groupBy=agentStep");
        expect(res.status()).toBe(200);

        const body = (await res.json()) as ApiEnvelope<{
          totalTokens: number;
          totalCostUsd: number;
          rows: unknown[];
        }>;
        expect(body.success).toBe(true);
        expect(typeof body.data.totalTokens).toBe("number");
        expect(Array.isArray(body.data.rows)).toBe(true);
      } finally {
        await ctx.dispose();
      }
    });

    // AC: CSV export supports agentStep grouping
    test("GET /api/projects/:id/usage/csv?groupBy=agentStep returns CSV", async () => {
      const ctx = await authedApi(primed.accessToken);
      try {
        const res = await ctx.get(
          `/api/projects/${projectId}/usage/csv?range=7d&groupBy=agentStep`,
        );
        expect(res.status()).toBe(200);

        const contentType = res.headers()["content-type"] ?? "";
        expect(contentType).toContain("text/csv");
      } finally {
        await ctx.dispose();
      }
    });

    // AC: agentStep groupBy requires authentication
    test("agentStep usage query requires authentication", async () => {
      const ctx = await request.newContext({ baseURL: API_BASE });
      try {
        const res = await ctx.get(`/api/projects/${projectId}/usage?range=7d&groupBy=agentStep`);
        expect(res.status()).toBe(401);
      } finally {
        await ctx.dispose();
      }
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Issue #616 — AST Summary Cache Rebuild API
  // ════════════════════════════════════════════════════════════════════════
  test.describe("Issue #616 — AST Cache Rebuild API", () => {
    // AC: API to trigger cache rebuild exists and responds
    test("POST /api/projects/:id/repositories/:repoId/rebuild-cache returns response", async () => {
      const ctx = await authedApi(primed.accessToken);
      try {
        // Use a non-existent repo ID — should return 404 (repo not found)
        // which proves the route is registered and auth works.
        const res = await ctx.post(
          `/api/projects/${projectId}/repositories/nonexistent-repo/rebuild-cache`,
        );
        expect(res.status()).toBe(404);

        const body = (await res.json()) as { success: boolean; error?: { code: string } };
        expect(body.success).toBe(false);
        expect(body.error?.code).toBe("NOT_FOUND");
      } finally {
        await ctx.dispose();
      }
    });

    // AC: Cache rebuild endpoint requires authentication
    test("rebuild-cache endpoint requires authentication", async () => {
      const ctx = await request.newContext({ baseURL: API_BASE });
      try {
        const res = await ctx.post(
          `/api/projects/${projectId}/repositories/any-repo/rebuild-cache`,
        );
        expect(res.status()).toBe(401);
      } finally {
        await ctx.dispose();
      }
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Issue #620 — Project Usage Page UI — Agent Step Breakdown
  // ════════════════════════════════════════════════════════════════════════
  test.describe("Issue #620 — Agent Step Breakdown UI", () => {
    test.beforeEach(async ({ page }) => {
      const loginPage = new LoginPage(page);
      await loginPage.goto();
      await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);
    });

    // AC: Usage dashboard shows agent-level token breakdown (new chart)
    test("agent step breakdown section is visible on usage page", async ({ page }) => {
      const usagePage = new ProjectUsagePage(page);

      await test.step("Navigate to project usage page", async () => {
        await usagePage.goto(projectId);
        await usagePage.waitForLoaded();
      });

      await test.step("Verify agent step breakdown section renders", async () => {
        await expect(usagePage.agentStepBreakdown).toBeVisible();
        await expect(
          page.getByRole("heading", { name: "Token Usage by Agent Step" }),
        ).toBeVisible();
      });
    });

    // AC: Agent step breakdown shows chart or empty state
    test("agent step breakdown shows chart or empty state", async ({ page }) => {
      const usagePage = new ProjectUsagePage(page);

      await test.step("Navigate to project usage page", async () => {
        await usagePage.goto(projectId);
        await usagePage.waitForLoaded();
      });

      await test.step("Verify chart or empty state is displayed", async () => {
        // #234 — the card renders while its query is still loading, with
        // neither child yet, so a one-shot isVisible() pair raced it. Retry
        // until one of the two settled states appears.
        await expect(usagePage.agentStepBreakdown).toBeVisible();
        await expect(usagePage.agentStepChart.or(usagePage.agentStepEmpty)).toBeVisible();
      });
    });

    // AC: groupBy select includes agentStep option
    test("groupBy select includes 'By Agent Step' option", async ({ page }) => {
      const usagePage = new ProjectUsagePage(page);

      await test.step("Navigate to project usage page", async () => {
        await usagePage.goto(projectId);
        await usagePage.waitForLoaded();
      });

      await test.step("Verify agentStep option exists in groupBy select", async () => {
        await expect(usagePage.groupBySelect).toBeVisible();
        const options = usagePage.groupBySelect.locator("option");
        await expect(options.filter({ hasText: "By Agent Step" })).toHaveCount(1);
      });

      await test.step("Select agentStep groupBy and verify value", async () => {
        await usagePage.selectGroupBy("agentStep");
        await expect(usagePage.groupBySelect).toHaveValue("agentStep");
      });
    });

    // AC: Agent step breakdown heading persists across range changes
    test("agent step breakdown persists when time range changes", async ({ page }) => {
      const usagePage = new ProjectUsagePage(page);

      await test.step("Navigate to project usage page", async () => {
        await usagePage.goto(projectId);
        await usagePage.waitForLoaded();
      });

      await test.step("Change range to 30d and verify section persists", async () => {
        await usagePage.selectRange("30d");
        await expect(usagePage.agentStepBreakdown).toBeVisible();
        await expect(
          page.getByRole("heading", { name: "Token Usage by Agent Step" }),
        ).toBeVisible();
      });
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Issue #620 — Admin Usage Dashboard — agentStep groupBy
  // ════════════════════════════════════════════════════════════════════════
  test.describe("Issue #620 — Admin Usage with agentStep", () => {
    test.beforeEach(async ({ page }) => {
      const loginPage = new LoginPage(page);
      await loginPage.goto();
      await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);
    });

    // AC: Admin usage API supports agentStep; verify admin page still loads
    test("admin usage page still loads and functions with agentStep support", async ({ page }) => {
      const adminPage = new AdminUsagePage(page);

      await test.step("Navigate to admin usage page", async () => {
        await adminPage.goto();
        await adminPage.waitForLoaded();
      });

      await test.step("Verify heading and summary tiles", async () => {
        await expect(adminPage.heading).toBeVisible();
        await expect(adminPage.totalTokensTile).toBeVisible();
      });

      await test.step("Existing group-by options still work", async () => {
        await adminPage.selectGroupBy("model");
        await expect(adminPage.barChartHeading).toContainText("model");
        await adminPage.selectGroupBy("project");
        await expect(adminPage.barChartHeading).toContainText("project");
      });
    });
  });
});
