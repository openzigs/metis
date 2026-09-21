/**
 * Epic #856 — sub-issue #871: Test Management Connections UI flow.
 *
 * Mocks the `/api/test-management/connections*` surface so the spec
 * exercises the React CRUD + Test page deterministically without
 * requiring a real Xray / Zephyr / TestRail endpoint (which would also
 * trip the SSRF guard in CI).
 *
 * Scenarios:
 *   1. Empty state → Add TestRail connection → row renders with the
 *      "untested" status and the saved label/kind.
 *   2. Click Test → success branch surfaces the latency-aware OK message
 *      via the `tmc-test-result-{id}` testid.
 *   3. Click Test → failure branch surfaces the error message verbatim.
 *   4. Delete row → row disappears and confirm dialog is honoured.
 *   5. Validation error blocks submission when required kind-specific
 *      fields are missing (testrail email/apiKey, xray clientId/secret).
 *   6. The "Manage saved connections →" link on the Test Coverage page
 *      navigates here, completing the round-trip the operator sees.
 */
import { test, expect, request } from "@playwright/test";
import { primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { TestManagementConnectionsPage } from "../pages/test-management-connections.page.js";

const API_BASE = apiBase();

interface MockConn {
  id: string;
  projectId: string;
  label: string;
  kind: "xray" | "zephyr" | "testrail";
  baseUrl: string;
  authConfig: Record<string, unknown>;
  proxyConfig: unknown;
  tlsConfig: unknown;
  status: "untested" | "ok" | "error";
  errorMessage: string | null;
  lastTestedAt: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

test.describe("Epic #856 — #871 Test Management Connections", () => {
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const { accessToken } = await primeAdminUser(API_BASE);
    const ctx = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
    });
    const slug = `e2e-tmc-${Date.now()}`;
    const res = await ctx.post("/api/projects", {
      data: { name: `TMC ${slug}`, slug, description: "epic-856 #871 e2e" },
    });
    expect(res.status(), await res.text()).toBe(201);
    projectId = (await res.json()).data.id as string;
    await ctx.dispose();

    const login = new LoginPage(page);
    await login.goto();
    await login.login("admin", "password");
  });

  test("create → test (success) → delete a saved TestRail connection", async ({ page }) => {
    const store: MockConn[] = [];

    await page.route("**/api/test-management/connections**", (route) => {
      const url = route.request().url();
      const method = route.request().method();

      // /connections/:id/test  (POST)
      const testMatch = url.match(/\/api\/test-management\/connections\/([^/?]+)\/test/);
      if (testMatch && method === "POST") {
        const id = testMatch[1]!;
        const row = store.find((c) => c.id === id);
        if (row) {
          row.status = "ok";
          row.errorMessage = null;
          row.lastTestedAt = new Date().toISOString();
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data: { ok: true, latencyMs: 42 } }),
        });
      }

      // /connections/:id  (DELETE / GET / PATCH)
      const detailMatch = url.match(/\/api\/test-management\/connections\/([^/?]+)(?:\?|$)/);
      if (detailMatch && method === "DELETE") {
        const id = detailMatch[1]!;
        const idx = store.findIndex((c) => c.id === id);
        if (idx >= 0) store.splice(idx, 1);
        return route.fulfill({ status: 204, body: "" });
      }

      // /connections (POST = create, GET = list)
      if (method === "POST") {
        const body = route.request().postDataJSON() as {
          label: string;
          kind: MockConn["kind"];
          baseUrl: string;
          authConfig: Record<string, unknown>;
        };
        const now = new Date().toISOString();
        const row: MockConn = {
          id: `conn-${store.length + 1}`,
          projectId,
          label: body.label,
          kind: body.kind,
          baseUrl: body.baseUrl,
          authConfig: body.authConfig ?? {},
          proxyConfig: null,
          tlsConfig: null,
          status: "untested",
          errorMessage: null,
          lastTestedAt: null,
          createdById: "admin",
          createdAt: now,
          updatedAt: now,
        };
        store.push(row);
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data: row }),
        });
      }

      if (method === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data: store }),
        });
      }

      return route.fallback();
    });

    page.on("dialog", (d) => d.accept());

    const tmc = new TestManagementConnectionsPage(page, projectId);
    await tmc.goto();

    await expect(tmc.emptyState).toBeVisible();

    await tmc.submitTestRail({
      label: "Prod TestRail",
      baseUrl: "https://example.testrail.io",
      email: "ops@example.com",
      apiKey: "secret",
    });

    const rowId = "conn-1";
    await expect(tmc.row(rowId)).toBeVisible();
    await expect(tmc.row(rowId)).toContainText("Prod TestRail");
    await expect(tmc.row(rowId)).toContainText("testrail");
    await expect(tmc.status(rowId)).toHaveText(/untested/i);

    await tmc.testButton(rowId).click();
    await expect(tmc.testResult(rowId)).toContainText(/OK/i);
    await expect(tmc.testResult(rowId)).toContainText("42");

    await tmc.deleteButton(rowId).click();
    await expect(tmc.row(rowId)).toBeHidden();
    await expect(tmc.emptyState).toBeVisible();
  });

  test("Test connectivity failure surfaces the server error message", async ({ page }) => {
    const seed: MockConn = {
      id: "conn-bad",
      projectId,
      label: "Bad",
      kind: "xray",
      baseUrl: "https://xray.example.com",
      authConfig: {},
      proxyConfig: null,
      tlsConfig: null,
      status: "error",
      errorMessage: "401 Unauthorized",
      lastTestedAt: null,
      createdById: "admin",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await page.route("**/api/test-management/connections**", (route) => {
      const url = route.request().url();
      if (url.includes("/conn-bad/test")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: { ok: false, latencyMs: 0, errorMessage: "401 Unauthorized" },
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [seed] }),
      });
    });

    const tmc = new TestManagementConnectionsPage(page, projectId);
    await tmc.goto();
    await expect(tmc.row("conn-bad")).toBeVisible();
    await tmc.testButton("conn-bad").click();
    await expect(tmc.testResult("conn-bad")).toContainText(/401/);
  });

  test("validation blocks submit when kind-specific creds are missing", async ({ page }) => {
    await page.route("**/api/test-management/connections**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [] }),
      }),
    );

    const tmc = new TestManagementConnectionsPage(page, projectId);
    await tmc.goto();
    await tmc.openAddForm();
    await tmc.kindSelect.selectOption("xray");
    await tmc.labelInput.fill("Incomplete");
    await tmc.baseUrlInput.fill("https://xray.example.com");
    await tmc.submitButton.click();
    await expect(tmc.formError).toContainText(/Xray/);
  });

  test("Test Coverage page link navigates to the connections page", async ({ page }) => {
    // Empty connections list — page should still render the manage link.
    await page.route("**/api/test-management/connections**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [] }),
      }),
    );

    await page.goto(`/projects/${projectId}/test-coverage`);
    const link = page.getByTestId("tc-manage-saved-connections-link");
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/test-coverage/connections$`));
    await expect(page.getByTestId("tmc-page")).toBeVisible();
  });
});
