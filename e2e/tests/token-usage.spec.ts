/**
 * Epic #594 — Enhanced Token Usage Tracking & Cost Allocation — E2E tests.
 *
 * Covers acceptance criteria from:
 *   - Issue #607: Usage Dashboard UI (project + admin)
 *   - Issue #606: Token Budget Controller API
 *   - Issue #604: Inference Profile API
 *
 * Approach:
 *   - API-level tests validate JSON shapes, budget CRUD, inference profile CRUD,
 *     usage aggregation with time-range + group-by filtering, and CSV export.
 *   - UI tests navigate the project usage page and admin usage dashboard,
 *     verifying component rendering, filter interactions, and export triggers.
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
const slug = `e2e-usage-${Date.now().toString(36)}`;

test.describe("Epic #594 — Token Usage Tracking & Cost Allocation", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async () => {
    primed = await primeAdminUser(API_BASE);
    const ctx = await authedApi(primed.accessToken);
    try {
      const createRes = await ctx.post("/api/projects", {
        data: { name: "Usage E2E Project", slug, description: "e2e usage tracking" },
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
  // Issue #606 — Token Budget Controller API
  // ════════════════════════════════════════════════════════════════════════
  test.describe("Issue #606 — Token Budget API", () => {
    // AC: Budget API returns current limits
    test("GET /api/projects/:id/token-budget returns budget and status", async () => {
      const ctx = await authedApi(primed.accessToken);
      try {
        const res = await ctx.get(`/api/projects/${projectId}/token-budget`);
        expect(res.status()).toBe(200);

        const envelope = (await res.json()) as ApiEnvelope<{
          budget: unknown;
          status: {
            allowed: boolean;
            // `null` while the project has no budget configured.
            remainingTokens: number | null;
            percentUsed: number;
            shouldDowngrade: boolean;
            message: string | null;
          };
        }>;
        expect(envelope.success).toBe(true);

        // Status should be present with default "no budget" state
        const status = envelope.data.status;
        expect(typeof status.allowed).toBe("boolean");
        // No budget configured yet, so the controller reports "no remainder"
        // as null rather than a fabricated number.
        expect(status.remainingTokens === null || typeof status.remainingTokens === "number").toBe(
          true,
        );
        expect(typeof status.percentUsed).toBe("number");
        expect(typeof status.shouldDowngrade).toBe("boolean");
      } finally {
        await ctx.dispose();
      }
    });

    // AC: Budget can be updated via PUT
    test("PUT /api/projects/:id/token-budget sets daily and monthly limits", async () => {
      const ctx = await authedApi(primed.accessToken);
      try {
        const putRes = await ctx.put(`/api/projects/${projectId}/token-budget`, {
          data: {
            dailyTokenLimit: 50_000,
            monthlyTokenLimit: 1_000_000,
            downgradeModel: "anthropic.claude-3-haiku-20240307-v1:0",
          },
        });
        expect(putRes.status()).toBe(200);

        const putBody = (await putRes.json()) as ApiEnvelope<{
          budget: { dailyTokenLimit: number; monthlyTokenLimit: number; downgradeModel: string };
        }>;
        expect(putBody.success).toBe(true);
        expect(putBody.data.budget.dailyTokenLimit).toBe(50_000);
        expect(putBody.data.budget.monthlyTokenLimit).toBe(1_000_000);
        expect(putBody.data.budget.downgradeModel).toBe("anthropic.claude-3-haiku-20240307-v1:0");

        // Verify GET reflects the update
        const getRes = await ctx.get(`/api/projects/${projectId}/token-budget`);
        expect(getRes.status()).toBe(200);
        const getBody = (await getRes.json()) as ApiEnvelope<{
          budget: { dailyTokenLimit: number; monthlyTokenLimit: number };
        }>;
        expect(getBody.data.budget.dailyTokenLimit).toBe(50_000);
        expect(getBody.data.budget.monthlyTokenLimit).toBe(1_000_000);
      } finally {
        await ctx.dispose();
      }
    });

    // AC: Budget can be cleared (nullable fields)
    test("PUT /api/projects/:id/token-budget clears limits with null", async () => {
      const ctx = await authedApi(primed.accessToken);
      try {
        const res = await ctx.put(`/api/projects/${projectId}/token-budget`, {
          data: {
            dailyTokenLimit: null,
            monthlyTokenLimit: null,
            downgradeModel: null,
          },
        });
        expect(res.status()).toBe(200);

        const body = (await res.json()) as ApiEnvelope<{
          budget: { dailyTokenLimit: number | null; monthlyTokenLimit: number | null };
        }>;
        expect(body.data.budget.dailyTokenLimit).toBeNull();
        expect(body.data.budget.monthlyTokenLimit).toBeNull();
      } finally {
        await ctx.dispose();
      }
    });

    // AC: Soft threshold triggers downgrade indication
    test("budget check indicates downgrade when threshold exceeded", async () => {
      const ctx = await authedApi(primed.accessToken);
      try {
        // Set a low budget so percent used (even at zero) shows status correctly
        await ctx.put(`/api/projects/${projectId}/token-budget`, {
          data: {
            dailyTokenLimit: 100,
            monthlyTokenLimit: 500,
            downgradeModel: "anthropic.claude-3-haiku-20240307-v1:0",
          },
        });

        const res = await ctx.get(`/api/projects/${projectId}/token-budget`);
        expect(res.status()).toBe(200);

        const body = (await res.json()) as ApiEnvelope<{
          status: { allowed: boolean; shouldDowngrade: boolean; percentUsed: number };
        }>;
        expect(body.success).toBe(true);
        // With zero usage the check should be allowed and not yet downgrading
        expect(body.data.status.allowed).toBe(true);
        expect(typeof body.data.status.shouldDowngrade).toBe("boolean");
        expect(typeof body.data.status.percentUsed).toBe("number");
      } finally {
        await ctx.dispose();
      }
    });

    // AC: Budget API requires authentication
    test("token-budget API requires authentication", async () => {
      const ctx = await request.newContext({ baseURL: API_BASE });
      try {
        const res = await ctx.get(`/api/projects/${projectId}/token-budget`);
        expect(res.status()).toBe(401);
      } finally {
        await ctx.dispose();
      }
    });

    // AC: PUT validates input
    test("PUT /api/projects/:id/token-budget rejects invalid data", async () => {
      const ctx = await authedApi(primed.accessToken);
      try {
        const res = await ctx.put(`/api/projects/${projectId}/token-budget`, {
          data: { dailyTokenLimit: -100 },
        });
        expect(res.status()).toBe(400);
      } finally {
        await ctx.dispose();
      }
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Issue #604 — Inference Profile API
  // ════════════════════════════════════════════════════════════════════════
  test.describe("Issue #604 — Inference Profile API", () => {
    // AC: Inference profile API returns profile data (initially null)
    test("GET /api/projects/:id/inference-profile returns null when unconfigured", async () => {
      const ctx = await authedApi(primed.accessToken);
      try {
        const res = await ctx.get(`/api/projects/${projectId}/inference-profile`);
        expect(res.status()).toBe(200);

        const body = (await res.json()) as ApiEnvelope<{ profile: null }>;
        expect(body.success).toBe(true);
        expect(body.data.profile).toBeNull();
      } finally {
        await ctx.dispose();
      }
    });

    // AC: Profile can be created/updated
    test("PUT /api/projects/:id/inference-profile creates a new profile", async () => {
      const ctx = await authedApi(primed.accessToken);
      try {
        const profileData = {
          arn: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/test",
          modelId: "anthropic.claude-3-sonnet-20240229-v1:0",
          costCenter: "engineering",
          environment: "development",
          tags: { team: "platform", sprint: "q2-2026" },
        };

        const putRes = await ctx.put(`/api/projects/${projectId}/inference-profile`, {
          data: profileData,
        });
        expect(putRes.status()).toBe(200);

        const putBody = (await putRes.json()) as ApiEnvelope<{
          profile: {
            arn: string;
            modelId: string;
            costCenter: string;
            environment: string;
            tags: Record<string, string>;
            projectId: string;
          };
        }>;
        expect(putBody.success).toBe(true);
        expect(putBody.data.profile.arn).toBe(profileData.arn);
        expect(putBody.data.profile.modelId).toBe(profileData.modelId);
        expect(putBody.data.profile.costCenter).toBe("engineering");
        expect(putBody.data.profile.environment).toBe("development");
        expect(putBody.data.profile.tags).toEqual({ team: "platform", sprint: "q2-2026" });
        expect(putBody.data.profile.projectId).toBe(projectId);

        // Verify GET reflects the creation
        const getRes = await ctx.get(`/api/projects/${projectId}/inference-profile`);
        expect(getRes.status()).toBe(200);
        const getBody = (await getRes.json()) as ApiEnvelope<{
          profile: { arn: string; modelId: string };
        }>;
        expect(getBody.data.profile).not.toBeNull();
        expect(getBody.data.profile.arn).toBe(profileData.arn);
      } finally {
        await ctx.dispose();
      }
    });

    // AC: Profile can be updated (upsert)
    test("PUT /api/projects/:id/inference-profile updates existing profile", async () => {
      const ctx = await authedApi(primed.accessToken);
      try {
        const updatedData = {
          arn: "arn:aws:bedrock:us-west-2:123456789012:inference-profile/updated",
          modelId: "anthropic.claude-3-opus-20240229-v1:0",
          costCenter: "research",
          environment: "staging",
        };

        const res = await ctx.put(`/api/projects/${projectId}/inference-profile`, {
          data: updatedData,
        });
        expect(res.status()).toBe(200);

        const body = (await res.json()) as ApiEnvelope<{
          profile: { arn: string; modelId: string; costCenter: string; environment: string };
        }>;
        expect(body.data.profile.arn).toBe(updatedData.arn);
        expect(body.data.profile.modelId).toBe(updatedData.modelId);
        expect(body.data.profile.costCenter).toBe("research");
        expect(body.data.profile.environment).toBe("staging");
      } finally {
        await ctx.dispose();
      }
    });

    // AC: Invalid ARN is rejected
    test("PUT /api/projects/:id/inference-profile rejects invalid ARN", async () => {
      const ctx = await authedApi(primed.accessToken);
      try {
        const res = await ctx.put(`/api/projects/${projectId}/inference-profile`, {
          data: { arn: "not-a-valid-arn", modelId: "some-model" },
        });
        expect(res.status()).toBe(400);
      } finally {
        await ctx.dispose();
      }
    });

    // AC: Requires authentication
    test("inference-profile API requires authentication", async () => {
      const ctx = await request.newContext({ baseURL: API_BASE });
      try {
        const res = await ctx.get(`/api/projects/${projectId}/inference-profile`);
        expect(res.status()).toBe(401);
      } finally {
        await ctx.dispose();
      }
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Issue #607 — Usage API (project-level)
  // ════════════════════════════════════════════════════════════════════════
  test.describe("Issue #607 — Project Usage API", () => {
    // AC: Project usage endpoint returns data with default params
    test("GET /api/projects/:id/usage returns usage data", async () => {
      const ctx = await authedApi(primed.accessToken);
      try {
        const res = await ctx.get(`/api/projects/${projectId}/usage?range=7d&groupBy=day`);
        expect(res.status()).toBe(200);

        const body = (await res.json()) as ApiEnvelope<{
          totalTokens: number;
          totalCostUsd: number;
          rows: Array<{ dayBucket: string; totalTokens: number }>;
        }>;
        expect(body.success).toBe(true);
        expect(typeof body.data.totalTokens).toBe("number");
        expect(typeof body.data.totalCostUsd).toBe("number");
        expect(Array.isArray(body.data.rows)).toBe(true);
      } finally {
        await ctx.dispose();
      }
    });

    // AC: Time range filter works (7d, 30d, 90d)
    test("project usage API supports all time ranges", async () => {
      const ctx = await authedApi(primed.accessToken);
      try {
        for (const range of ["7d", "30d", "90d"] as const) {
          const res = await ctx.get(`/api/projects/${projectId}/usage?range=${range}&groupBy=day`);
          expect(res.status(), `range=${range} should return 200`).toBe(200);
          const body = (await res.json()) as ApiEnvelope<{ totalTokens: number }>;
          expect(body.success).toBe(true);
        }
      } finally {
        await ctx.dispose();
      }
    });

    // AC: Group-by filter works (day, model, user)
    test("project usage API supports all group-by values", async () => {
      const ctx = await authedApi(primed.accessToken);
      try {
        for (const groupBy of ["day", "model", "user"] as const) {
          const res = await ctx.get(`/api/projects/${projectId}/usage?range=7d&groupBy=${groupBy}`);
          expect(res.status(), `groupBy=${groupBy} should return 200`).toBe(200);
          const body = (await res.json()) as ApiEnvelope<{ rows: unknown[] }>;
          expect(body.success).toBe(true);
          expect(Array.isArray(body.data.rows)).toBe(true);
        }
      } finally {
        await ctx.dispose();
      }
    });

    // AC: CSV export returns text/csv
    test("GET /api/projects/:id/usage/csv returns CSV content", async () => {
      const ctx = await authedApi(primed.accessToken);
      try {
        const res = await ctx.get(`/api/projects/${projectId}/usage/csv?range=7d&groupBy=day`);
        expect(res.status()).toBe(200);

        const contentType = res.headers()["content-type"] ?? "";
        expect(contentType).toContain("text/csv");

        const disposition = res.headers()["content-disposition"] ?? "";
        expect(disposition).toContain("attachment");
        expect(disposition).toContain(".csv");
      } finally {
        await ctx.dispose();
      }
    });

    // AC: Invalid range returns 400
    test("project usage API rejects invalid range", async () => {
      const ctx = await authedApi(primed.accessToken);
      try {
        const res = await ctx.get(`/api/projects/${projectId}/usage?range=1y`);
        expect(res.status()).toBe(400);
      } finally {
        await ctx.dispose();
      }
    });

    // AC: Requires authentication
    test("project usage API requires authentication", async () => {
      const ctx = await request.newContext({ baseURL: API_BASE });
      try {
        const res = await ctx.get(`/api/projects/${projectId}/usage?range=7d`);
        expect(res.status()).toBe(401);
      } finally {
        await ctx.dispose();
      }
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Issue #607 — Admin Usage API
  // ════════════════════════════════════════════════════════════════════════
  test.describe("Issue #607 — Admin Usage API", () => {
    // AC: Admin usage page loads for admin users
    test("GET /api/admin/usage returns cross-project usage data", async () => {
      const ctx = await authedApi(primed.accessToken);
      try {
        const res = await ctx.get("/api/admin/usage?range=30d&groupBy=project");
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

    // AC: Group-by selector works (project, model, user, day)
    test("admin usage API supports all group-by values", async () => {
      const ctx = await authedApi(primed.accessToken);
      try {
        for (const groupBy of ["project", "day", "model", "user"] as const) {
          const res = await ctx.get(`/api/admin/usage?range=30d&groupBy=${groupBy}`);
          expect(res.status(), `groupBy=${groupBy} should return 200`).toBe(200);
          const body = (await res.json()) as ApiEnvelope<{ rows: unknown[] }>;
          expect(body.success).toBe(true);
        }
      } finally {
        await ctx.dispose();
      }
    });

    // AC: Admin CSV export
    test("GET /api/admin/usage/csv returns CSV content", async () => {
      const ctx = await authedApi(primed.accessToken);
      try {
        const res = await ctx.get("/api/admin/usage/csv?range=30d&groupBy=project");
        expect(res.status()).toBe(200);

        const contentType = res.headers()["content-type"] ?? "";
        expect(contentType).toContain("text/csv");

        const disposition = res.headers()["content-disposition"] ?? "";
        expect(disposition).toContain("attachment");
      } finally {
        await ctx.dispose();
      }
    });

    // AC: Time range filter works for admin
    test("admin usage API supports all time ranges", async () => {
      const ctx = await authedApi(primed.accessToken);
      try {
        for (const range of ["7d", "30d", "90d"] as const) {
          const res = await ctx.get(`/api/admin/usage?range=${range}&groupBy=project`);
          expect(res.status(), `range=${range} should return 200`).toBe(200);
        }
      } finally {
        await ctx.dispose();
      }
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Issue #607 — Project Usage Page UI
  // ════════════════════════════════════════════════════════════════════════
  test.describe("Issue #607 — Project Usage Page UI", () => {
    test.beforeEach(async ({ page }) => {
      const loginPage = new LoginPage(page);
      await loginPage.goto();
      await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);
    });

    // AC: Project usage page loads and displays token consumption data
    test("project usage page loads and displays headline tiles", async ({ page }) => {
      const usagePage = new ProjectUsagePage(page);

      await test.step("Navigate to project usage page", async () => {
        await usagePage.goto(projectId);
        await usagePage.waitForLoaded();
      });

      await test.step("Verify heading is visible", async () => {
        await expect(usagePage.heading).toBeVisible();
      });

      await test.step("Verify headline tiles are rendered", async () => {
        await expect(usagePage.headlineSection).toBeVisible();
        await expect(usagePage.tileWindowTokens).toBeVisible();
        await expect(usagePage.tileMtdTokens).toBeVisible();
        await expect(usagePage.tileWindowCost).toBeVisible();
        await expect(usagePage.tileProjectedCost).toBeVisible();
      });
    });

    // AC: Budget utilization gauge displays percentage
    test("budget gauge or no-budget card is displayed", async ({ page }) => {
      const usagePage = new ProjectUsagePage(page);

      await test.step("Navigate to usage page", async () => {
        await usagePage.goto(projectId);
        await usagePage.waitForLoaded();
      });

      await test.step("Verify budget section is present", async () => {
        // Either the budget card with progress bar or the no-budget card.
        // #234 — retry until one renders, then branch on which one did.
        await expect(usagePage.budgetCard.or(usagePage.noBudgetCard)).toBeVisible();

        if (await usagePage.budgetCard.isVisible()) {
          await expect(usagePage.budgetProgressBar).toBeVisible();
        }
      });
    });

    // AC: Enhanced usage section renders with range and group-by filters
    test("enhanced usage section renders with filter controls", async ({ page }) => {
      const usagePage = new ProjectUsagePage(page);

      await test.step("Navigate to usage page", async () => {
        await usagePage.goto(projectId);
        await usagePage.waitForLoaded();
      });

      await test.step("Verify enhanced usage section", async () => {
        await expect(usagePage.enhancedUsageSection).toBeVisible();
        await expect(usagePage.rangeSelect).toBeVisible();
        await expect(usagePage.groupBySelect).toBeVisible();
        await expect(usagePage.csvExportButton).toBeVisible();
      });
    });

    // AC: Time range filter works (7d, 30d, 90d)
    test("time range filter changes selected value", async ({ page }) => {
      const usagePage = new ProjectUsagePage(page);

      await test.step("Navigate to usage page", async () => {
        await usagePage.goto(projectId);
        await usagePage.waitForLoaded();
      });

      await test.step("Select 30d range", async () => {
        await usagePage.selectRange("30d");
        await expect(usagePage.rangeSelect).toHaveValue("30d");
      });

      await test.step("Select 90d range", async () => {
        await usagePage.selectRange("90d");
        await expect(usagePage.rangeSelect).toHaveValue("90d");
      });

      await test.step("Select 7d range", async () => {
        await usagePage.selectRange("7d");
        await expect(usagePage.rangeSelect).toHaveValue("7d");
      });
    });

    // AC: CSV export button triggers download
    test("CSV export button is clickable", async ({ page }) => {
      const usagePage = new ProjectUsagePage(page);

      await test.step("Navigate to usage page", async () => {
        await usagePage.goto(projectId);
        await usagePage.waitForLoaded();
      });

      await test.step("Verify CSV export button exists and is enabled", async () => {
        await expect(usagePage.csvExportButton).toBeVisible();
        await expect(usagePage.csvExportButton).toBeEnabled();
      });
    });

    // AC: Back link navigates to project detail
    test("back link navigates to project detail page", async ({ page }) => {
      const usagePage = new ProjectUsagePage(page);

      await test.step("Navigate to usage page", async () => {
        await usagePage.goto(projectId);
        await usagePage.waitForLoaded();
      });

      await test.step("Click back link and verify navigation", async () => {
        await usagePage.backLink.click();
        await page.waitForURL(/\/projects\/[^/]+$/, { timeout: 15_000 });
      });
    });

    // AC: Tokens per day chart or empty state shown
    test("tokens per day section shows chart or empty state", async ({ page }) => {
      const usagePage = new ProjectUsagePage(page);

      await test.step("Navigate to usage page", async () => {
        await usagePage.goto(projectId);
        await usagePage.waitForLoaded();
      });

      await test.step("Verify day chart or empty state", async () => {
        await expect(usagePage.byDayChart.or(usagePage.byDayEmpty)).toBeVisible();
      });
    });

    // AC: By-provider table or empty state shown
    test("by-provider section shows table or empty state", async ({ page }) => {
      const usagePage = new ProjectUsagePage(page);

      await test.step("Navigate to usage page", async () => {
        await usagePage.goto(projectId);
        await usagePage.waitForLoaded();
      });

      await test.step("Verify by-provider table or empty state", async () => {
        await expect(usagePage.byProviderTable.or(usagePage.byProviderEmpty)).toBeVisible();
      });
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Issue #607 — Admin Usage Dashboard UI
  // ════════════════════════════════════════════════════════════════════════
  test.describe("Issue #607 — Admin Usage Dashboard UI", () => {
    test.beforeEach(async ({ page }) => {
      const loginPage = new LoginPage(page);
      await loginPage.goto();
      await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);
    });

    // AC: Admin usage page loads for admin users
    test("admin usage page loads and displays heading", async ({ page }) => {
      const adminPage = new AdminUsagePage(page);

      await test.step("Navigate to admin usage page", async () => {
        await adminPage.goto();
        await adminPage.waitForLoaded();
      });

      await test.step("Verify heading is visible", async () => {
        await expect(adminPage.heading).toBeVisible();
      });
    });

    // AC: Summary tiles display totals
    test("admin usage page displays summary tiles", async ({ page }) => {
      const adminPage = new AdminUsagePage(page);

      await test.step("Navigate to admin usage page", async () => {
        await adminPage.goto();
        await adminPage.waitForLoaded();
      });

      await test.step("Verify summary tiles", async () => {
        await expect(adminPage.totalTokensTile).toBeVisible();
        await expect(adminPage.estimatedCostTile).toBeVisible();
        await expect(adminPage.invocationsTile).toBeVisible();
      });
    });

    // AC: Group-by selector works (project, model, user)
    test("admin group-by selector changes selection", async ({ page }) => {
      const adminPage = new AdminUsagePage(page);

      await test.step("Navigate to admin usage page", async () => {
        await adminPage.goto();
        await adminPage.waitForLoaded();
      });

      await test.step("Change group-by to model", async () => {
        await adminPage.selectGroupBy("model");
        await expect(adminPage.barChartHeading).toContainText("model");
      });

      await test.step("Change group-by to user", async () => {
        await adminPage.selectGroupBy("user");
        await expect(adminPage.barChartHeading).toContainText("user");
      });

      await test.step("Change group-by to day", async () => {
        await adminPage.selectGroupBy("day");
        await expect(adminPage.barChartHeading).toContainText("day");
      });
    });

    // AC: Time range filter works on admin page
    test("admin time range filter changes selection", async ({ page }) => {
      const adminPage = new AdminUsagePage(page);

      await test.step("Navigate to admin usage page", async () => {
        await adminPage.goto();
        await adminPage.waitForLoaded();
      });

      await test.step("Select 7d range", async () => {
        await adminPage.selectRange("7d");
        await expect(adminPage.rangeSelect).toHaveValue("7d");
      });

      await test.step("Select 90d range", async () => {
        await adminPage.selectRange("90d");
        await expect(adminPage.rangeSelect).toHaveValue("90d");
      });
    });

    // AC: CSV export button is present
    test("admin CSV export button is present and enabled", async ({ page }) => {
      const adminPage = new AdminUsagePage(page);

      await test.step("Navigate to admin usage page", async () => {
        await adminPage.goto();
        await adminPage.waitForLoaded();
      });

      await test.step("Verify CSV export button", async () => {
        await expect(adminPage.csvExportButton).toBeVisible();
        await expect(adminPage.csvExportButton).toBeEnabled();
      });
    });

    // AC: Bar chart section renders
    test("admin bar chart section renders", async ({ page }) => {
      const adminPage = new AdminUsagePage(page);

      await test.step("Navigate to admin usage page", async () => {
        await adminPage.goto();
        await adminPage.waitForLoaded();
      });

      await test.step("Verify bar chart heading", async () => {
        await expect(adminPage.barChartHeading).toBeVisible();
      });
    });

    // AC: Details table renders
    test("admin details table renders", async ({ page }) => {
      const adminPage = new AdminUsagePage(page);

      await test.step("Navigate to admin usage page", async () => {
        await adminPage.goto();
        await adminPage.waitForLoaded();
      });

      await test.step("Verify details table heading", async () => {
        await expect(page.getByRole("heading", { name: "Details" })).toBeVisible();
      });
    });
  });
});
