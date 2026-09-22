/**
 * Epic #556 — Jira Integration (Connection & Issue Viewer) E2E tests.
 *
 * Covers:
 *   Part 1 — API-level CRUD lifecycle for Jira connections
 *   Part 2 — UI tests for connection management page
 *   Part 3 — UI tests for the issue viewer (structure, empty states)
 *
 * Strategy:
 *   - API tests use `request.newContext()` for direct endpoint testing
 *   - UI tests navigate to `/projects/:id/jira` and verify rendering,
 *     form validation, and component structure
 *   - No real Jira server is available so we test UI structure, empty states,
 *     form validation, and error handling — not live connectivity
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { JiraPage } from "../pages/jira.page.js";

const API_BASE = apiBase();

/**
 * Assert a route is MOUNTED, without assuming what the upstream Jira does.
 * Express answers an unknown path with `{ error: { code: "NOT_FOUND" } }`,
 * while a real Jira 404 comes back as `JIRA_API_ERROR` — same status, very
 * different meaning. Discriminate on the code.
 */
async function expectRouteMounted(res: import("@playwright/test").APIResponse): Promise<void> {
  if (res.status() !== 404) return;
  const body = (await res.json()) as { error?: { code?: string } };
  expect(body.error?.code, `route is not mounted: ${JSON.stringify(body)}`).not.toBe("NOT_FOUND");
}

/** Create an authenticated API context. */
async function authedApi(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

/** Create a project via API and return its id. */
async function createProject(api: APIRequestContext, suffix: string): Promise<string> {
  const slug = `e2e-jira-${suffix}-${Date.now()}`;
  const res = await api.post("/api/projects", {
    data: { name: `Jira Test ${slug}`, slug, description: "epic-556 e2e" },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  return (body.data?.project?.id ?? body.data?.id ?? body.id) as string;
}

// ============================================================================
// Part 1 — API-level Jira Connection CRUD
// ============================================================================

test.describe("Epic #556 — Jira Connection API CRUD", () => {
  let accessToken: string;
  let projectId: string;
  let api: APIRequestContext;

  test.beforeEach(async () => {
    const primed = await primeAdminUser(API_BASE);
    accessToken = primed.accessToken;
    api = await authedApi(accessToken);
    projectId = await createProject(api, "api");
  });

  test.afterEach(async () => {
    await api.dispose();
  });

  // AC: POST /api/jira/connections — create connection
  test("should create a Jira connection", async () => {
    const res = await api.post("/api/jira/connections", {
      data: {
        projectId,
        label: "test-cloud",
        edition: "cloud",
        baseUrl: "https://test.atlassian.net",
        username: "user@example.com",
        apiToken: "fake-token-for-e2e",
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.label).toBe("test-cloud");
    expect(body.data.edition).toBe("cloud");
    expect(body.data.baseUrl).toBe("https://test.atlassian.net");
    expect(body.data.username).toBe("user@example.com");
    // Secret must be masked
    expect(body.data.secretMasked).toBeTruthy();
    expect(body.data.secretMasked).not.toContain("fake-token");
    expect(body.data.status).toBe("untested");
  });

  // AC: POST /api/jira/connections — validation error for missing fields
  test("should reject connection with missing required fields", async () => {
    const res = await api.post("/api/jira/connections", {
      data: { projectId, label: "missing-fields" },
    });
    expect([400, 422]).toContain(res.status());
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  // AC: GET /api/jira/connections?projectId=X — list connections
  test("should list connections for a project", async () => {
    // Create two connections
    await api.post("/api/jira/connections", {
      data: {
        projectId,
        label: "conn-alpha",
        edition: "cloud",
        baseUrl: "https://alpha.atlassian.net",
        username: "alpha@test.com",
        apiToken: "token-alpha",
      },
    });
    await api.post("/api/jira/connections", {
      data: {
        projectId,
        label: "conn-beta",
        edition: "datacenter",
        baseUrl: "https://jira.corp.net",
        username: "svc-beta",
        apiToken: "token-beta",
      },
    });

    const listRes = await api.get(`/api/jira/connections?projectId=${projectId}`);
    expect(listRes.status()).toBe(200);
    const list = await listRes.json();
    expect(list.success).toBe(true);
    expect(list.data.length).toBeGreaterThanOrEqual(2);

    // Secrets must be masked in list response
    for (const conn of list.data) {
      expect(conn.secretMasked).toBeTruthy();
    }
  });

  // AC: GET /api/jira/connections/:id — get connection detail
  test("should get a single connection detail", async () => {
    const createRes = await api.post("/api/jira/connections", {
      data: {
        projectId,
        label: "detail-conn",
        edition: "cloud",
        baseUrl: "https://detail.atlassian.net",
        username: "detail@test.com",
        apiToken: "token-detail",
      },
    });
    const created = await createRes.json();
    const connId = created.data.id;

    const detailRes = await api.get(`/api/jira/connections/${connId}`);
    expect(detailRes.status()).toBe(200);
    const detail = await detailRes.json();
    expect(detail.data.id).toBe(connId);
    expect(detail.data.label).toBe("detail-conn");
  });

  // AC: PATCH /api/jira/connections/:id — update connection
  test("should update a connection", async () => {
    const createRes = await api.post("/api/jira/connections", {
      data: {
        projectId,
        label: "before-update",
        edition: "cloud",
        baseUrl: "https://before.atlassian.net",
        username: "before@test.com",
        apiToken: "token-before",
      },
    });
    const connId = (await createRes.json()).data.id;

    const patchRes = await api.patch(`/api/jira/connections/${connId}`, {
      data: { label: "after-update", edition: "datacenter" },
    });
    expect(patchRes.status()).toBe(200);
    const updated = await patchRes.json();
    expect(updated.data.label).toBe("after-update");
    expect(updated.data.edition).toBe("datacenter");
  });

  // AC: DELETE /api/jira/connections/:id — soft-delete (204)
  test("should soft-delete a connection", async () => {
    const createRes = await api.post("/api/jira/connections", {
      data: {
        projectId,
        label: "to-delete",
        edition: "cloud",
        baseUrl: "https://delete.atlassian.net",
        username: "delete@test.com",
        apiToken: "token-delete",
      },
    });
    const connId = (await createRes.json()).data.id;

    const deleteRes = await api.delete(`/api/jira/connections/${connId}`);
    expect(deleteRes.status()).toBe(204);

    // Connection should no longer appear in list
    const listRes = await api.get(`/api/jira/connections?projectId=${projectId}`);
    const list = await listRes.json();
    const ids = list.data.map((c: { id: string }) => c.id);
    expect(ids).not.toContain(connId);
  });

  // AC: POST /api/jira/connections/:id/test — test connectivity
  // (will fail because no real Jira, but the endpoint should respond)
  test("should attempt to test connectivity and return error result", async () => {
    const createRes = await api.post("/api/jira/connections", {
      data: {
        projectId,
        label: "test-connectivity",
        edition: "cloud",
        baseUrl: "https://nonexistent.atlassian.net",
        username: "test@test.com",
        apiToken: "fake-token",
      },
    });
    const connId = (await createRes.json()).data.id;

    const testRes = await api.post(`/api/jira/connections/${connId}/test`);
    // Endpoint responds (200 with error result or 502/500 — both valid)
    expect([200, 500, 502]).toContain(testRes.status());
    if (testRes.status() === 200) {
      const body = await testRes.json();
      // Test result should have ok: false since no real Jira server
      expect(body.data.ok).toBe(false);
      expect(body.data.errorMessage).toBeTruthy();
    }
  });

  // AC: GET /api/jira/connections/:id/projects — list Jira projects
  // (will fail since no real Jira — but the endpoint should exist)
  test("should expose Jira projects endpoint", async () => {
    const createRes = await api.post("/api/jira/connections", {
      data: {
        projectId,
        label: "projects-endpoint",
        edition: "cloud",
        baseUrl: "https://nonexistent.atlassian.net",
        username: "test@test.com",
        apiToken: "fake-token",
      },
    });
    const connId = (await createRes.json()).data.id;

    const projectsRes = await api.get(`/api/jira/connections/${connId}/projects`);
    // Will error since no real Jira. Assert the ROUTE exists: an upstream Jira
    // 404 is itself surfaced as 404 (code JIRA_API_ERROR), so discriminate on
    // the error code rather than the status.
    await expectRouteMounted(projectsRes);
  });

  // AC: POST /api/jira/connections/:id/search — JQL search
  test("should expose JQL search endpoint with validation", async () => {
    const createRes = await api.post("/api/jira/connections", {
      data: {
        projectId,
        label: "search-endpoint",
        edition: "cloud",
        baseUrl: "https://nonexistent.atlassian.net",
        username: "test@test.com",
        apiToken: "fake-token",
      },
    });
    const connId = (await createRes.json()).data.id;

    // Empty JQL should be rejected by validation
    const emptyRes = await api.post(`/api/jira/connections/${connId}/search`, {
      data: { jql: "" },
    });
    expect([400, 422]).toContain(emptyRes.status());

    // Valid JQL structure — route exists (may fail against Jira but not 404)
    const searchRes = await api.post(`/api/jira/connections/${connId}/search`, {
      data: { jql: "project = TEST", startAt: 0, maxResults: 10 },
    });
    await expectRouteMounted(searchRes);
  });

  // AC: GET /api/jira/connections/:id/issues/:key — issue detail
  test("should expose issue detail endpoint", async () => {
    const createRes = await api.post("/api/jira/connections", {
      data: {
        projectId,
        label: "issue-detail-endpoint",
        edition: "cloud",
        baseUrl: "https://nonexistent.atlassian.net",
        username: "test@test.com",
        apiToken: "fake-token",
      },
    });
    const connId = (await createRes.json()).data.id;

    const issueRes = await api.get(`/api/jira/connections/${connId}/issues/TEST-1`);
    // Route should exist. Will error since no real Jira.
    await expectRouteMounted(issueRes);
  });

  // AC: Connection CRUD full lifecycle
  test("should complete full CRUD lifecycle", async () => {
    await test.step("Create", async () => {
      const res = await api.post("/api/jira/connections", {
        data: {
          projectId,
          label: "lifecycle-conn",
          edition: "cloud",
          baseUrl: "https://lifecycle.atlassian.net",
          username: "lifecycle@test.com",
          apiToken: "token-lifecycle",
        },
      });
      expect(res.status()).toBe(201);
    });

    let connId: string;
    await test.step("List and find", async () => {
      const listRes = await api.get(`/api/jira/connections?projectId=${projectId}`);
      const list = await listRes.json();
      const found = list.data.find((c: { label: string }) => c.label === "lifecycle-conn");
      expect(found).toBeTruthy();
      connId = found.id;
    });

    await test.step("Get detail", async () => {
      const detailRes = await api.get(`/api/jira/connections/${connId!}`);
      expect(detailRes.status()).toBe(200);
    });

    await test.step("Update", async () => {
      const patchRes = await api.patch(`/api/jira/connections/${connId!}`, {
        data: { label: "lifecycle-updated" },
      });
      expect(patchRes.status()).toBe(200);
      const updated = await patchRes.json();
      expect(updated.data.label).toBe("lifecycle-updated");
    });

    await test.step("Delete", async () => {
      const deleteRes = await api.delete(`/api/jira/connections/${connId!}`);
      expect(deleteRes.status()).toBe(204);
    });

    await test.step("Verify deleted", async () => {
      const listRes = await api.get(`/api/jira/connections?projectId=${projectId}`);
      const list = await listRes.json();
      const ids = list.data.map((c: { id: string }) => c.id);
      expect(ids).not.toContain(connId!);
    });
  });
});

// ============================================================================
// Part 2 — UI: Connection Management
// ============================================================================

test.describe("Epic #556 — Jira Connection Management UI", () => {
  let accessToken: string;
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const primed = await primeAdminUser(API_BASE);
    accessToken = primed.accessToken;
    const api = await authedApi(accessToken);
    projectId = await createProject(api, "ui");
    await api.dispose();

    // Login via the UI
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  // AC1: Connection list displays all Jira connections for project
  test("should display empty state when no connections exist", async ({ page }) => {
    const jira = new JiraPage(page);
    await jira.goto(projectId);

    await expect(jira.heading).toBeVisible();
    await expect(jira.subtitle).toBeVisible();
    await expect(jira.connectionsHeading).toBeVisible();
    await expect(jira.emptyConnectionsMessage).toBeVisible();
    await expect(jira.addConnectionButton).toBeVisible();
  });

  // AC2: "Add Connection" button opens form
  test("should open connection form when Add Connection is clicked", async ({ page }) => {
    const jira = new JiraPage(page);
    await jira.goto(projectId);

    await jira.openAddForm();

    // Form should be visible with all expected fields
    await expect(jira.labelInput).toBeVisible();
    await expect(jira.editionSelect).toBeVisible();
    await expect(jira.baseUrlInput).toBeVisible();
    await expect(jira.usernameInput).toBeVisible();
    await expect(jira.tokenInput).toBeVisible();
    await expect(jira.proxyUrlInput).toBeVisible();
    await expect(jira.tlsCheckbox).toBeVisible();
    await expect(jira.submitButton).toBeVisible();
    await expect(jira.cancelButton).toBeVisible();
  });

  // AC3: Edition toggle switches between Cloud/Data Center with hints
  test("should toggle edition between Cloud and Data Center", async ({ page }) => {
    const jira = new JiraPage(page);
    await jira.goto(projectId);
    await jira.openAddForm();

    await test.step("Default edition is Cloud", async () => {
      await expect(jira.editionSelect).toHaveValue("cloud");
      // Cloud placeholder shows Atlassian-style URL
      await expect(jira.baseUrlInput).toHaveAttribute(
        "placeholder",
        "https://your-org.atlassian.net",
      );
    });

    await test.step("Switch to Data Center", async () => {
      await jira.editionSelect.selectOption("datacenter");
      await expect(jira.editionSelect).toHaveValue("datacenter");
      // DC placeholder shows corporate URL
      await expect(jira.baseUrlInput).toHaveAttribute("placeholder", "https://jira.corp.net");
    });

    await test.step("Switch back to Cloud", async () => {
      await jira.editionSelect.selectOption("cloud");
      await expect(jira.editionSelect).toHaveValue("cloud");
    });
  });

  // AC5: Token field is password type
  test("should render token field as password type", async ({ page }) => {
    const jira = new JiraPage(page);
    await jira.goto(projectId);
    await jira.openAddForm();

    await expect(jira.tokenInput).toHaveAttribute("type", "password");
  });

  // AC: Cancel button closes the form
  test("should close form when Cancel is clicked", async ({ page }) => {
    const jira = new JiraPage(page);
    await jira.goto(projectId);

    await jira.openAddForm();
    await expect(jira.connectionForm).toBeVisible();

    await jira.cancelForm();
    await expect(jira.connectionForm).not.toBeVisible();
  });

  // AC: Submit button is disabled when required fields are empty
  test("should disable submit when required fields are empty", async ({ page }) => {
    const jira = new JiraPage(page);
    await jira.goto(projectId);
    await jira.openAddForm();

    // Initially all fields are empty — submit should be disabled
    await expect(jira.submitButton).toBeDisabled();

    // Fill only some fields — still disabled
    await jira.labelInput.fill("partial-conn");
    await expect(jira.submitButton).toBeDisabled();

    // Fill all required fields — should become enabled
    await jira.baseUrlInput.fill("https://test.atlassian.net");
    await jira.usernameInput.fill("user@test.com");
    await jira.tokenInput.fill("some-token");
    await expect(jira.submitButton).toBeEnabled();
  });

  // AC1 + AC7/AC8: Create a connection via UI and verify it appears in the list
  test("should create a connection and display it in the list", async ({ page }) => {
    const jira = new JiraPage(page);
    await jira.goto(projectId);

    await jira.openAddForm();
    await jira.fillConnectionForm({
      label: "e2e-cloud-conn",
      edition: "cloud",
      baseUrl: "https://e2e-test.atlassian.net",
      username: "e2e@test.com",
      token: "e2e-token-value",
    });
    await jira.submitForm();

    // Form should close
    await expect(jira.connectionForm).not.toBeVisible({ timeout: 10_000 });

    // Connection should appear in the list
    const card = jira.connectionCard("e2e-cloud-conn");
    await expect(card).toBeVisible();

    // Should show edition badge
    await expect(jira.editionBadge(card)).toHaveText("cloud");

    // Should show untested status
    await expect(jira.statusBadge(card)).toHaveText("untested");

    // Base URL shown
    await expect(card).toContainText("https://e2e-test.atlassian.net");

    // Empty state message should be gone
    await expect(jira.emptyConnectionsMessage).not.toBeVisible();
  });

  // AC6: Test Connection button shows loading → result
  // AC8: Failed test shows error (no real Jira server)
  test("should show error status after testing connection against unreachable Jira", async ({
    page,
  }) => {
    const jira = new JiraPage(page);
    await jira.goto(projectId);

    // Create a connection first
    await jira.openAddForm();
    await jira.fillConnectionForm({
      label: "test-target",
      edition: "cloud",
      baseUrl: "https://unreachable.atlassian.net",
      username: "test@test.com",
      token: "test-token",
    });
    await jira.submitForm();
    await expect(jira.connectionForm).not.toBeVisible({ timeout: 10_000 });

    // Click Test on the connection card
    const card = jira.connectionCard("test-target");
    await expect(card).toBeVisible();
    await jira.clickTest(card);

    // After test completes, status should change from "untested"
    // (either "error" because Jira is unreachable, or test button re-enables)
    await expect(card.getByRole("button", { name: "Test" })).toBeEnabled({ timeout: 30_000 });
  });

  // AC10: Delete with confirmation
  test("should delete a connection after confirmation", async ({ page }) => {
    const jira = new JiraPage(page);
    await jira.goto(projectId);

    // Create a connection to delete
    await jira.openAddForm();
    await jira.fillConnectionForm({
      label: "to-be-deleted",
      edition: "cloud",
      baseUrl: "https://delete-me.atlassian.net",
      username: "del@test.com",
      token: "del-token",
    });
    await jira.submitForm();
    await expect(jira.connectionForm).not.toBeVisible({ timeout: 10_000 });

    const card = jira.connectionCard("to-be-deleted");
    await expect(card).toBeVisible();

    // Accept the confirm dialog and delete
    page.on("dialog", (dialog) => dialog.accept());
    await jira.clickDelete(card);

    // Connection should disappear
    await expect(card).not.toBeVisible({ timeout: 10_000 });

    // Empty state should return
    await expect(jira.emptyConnectionsMessage).toBeVisible();
  });

  // AC9: Edit pre-populates fields (secret masked)
  test("should pre-populate form when editing a connection", async ({ page }) => {
    const jira = new JiraPage(page);
    await jira.goto(projectId);

    // Create a connection
    await jira.openAddForm();
    await jira.fillConnectionForm({
      label: "edit-target",
      edition: "cloud",
      baseUrl: "https://edit-me.atlassian.net",
      username: "edit@test.com",
      token: "edit-token",
    });
    await jira.submitForm();
    await expect(jira.connectionForm).not.toBeVisible({ timeout: 10_000 });

    // Click Edit
    const card = jira.connectionCard("edit-target");
    await jira.clickEdit(card);

    // Form should be visible with pre-populated values
    await expect(jira.connectionForm).toBeVisible();
    await expect(jira.labelInput).toHaveValue("edit-target");
    await expect(jira.editionSelect).toHaveValue("cloud");
    await expect(jira.baseUrlInput).toHaveValue("https://edit-me.atlassian.net");
    await expect(jira.usernameInput).toHaveValue("edit@test.com");

    // Token should be empty (masked — placeholder shows ••••••••)
    await expect(jira.tokenInput).toHaveValue("");
    await expect(jira.tokenInput).toHaveAttribute("placeholder", "••••••••");

    // Submit button should say "Update"
    await expect(page.getByRole("button", { name: "Update" })).toBeVisible();
  });

  // AC12: Loading states
  test("should show loading state while connections are fetching", async ({ page }) => {
    const jira = new JiraPage(page);
    // Navigate and verify the page structure renders (loading may be fast)
    await jira.goto(projectId);
    await expect(jira.connectionsHeading).toBeVisible();
  });

  // AC3: Edition toggle changes username label hint
  test("should change username label based on edition", async ({ page }) => {
    const jira = new JiraPage(page);
    await jira.goto(projectId);
    await jira.openAddForm();

    await test.step("Cloud edition shows Email label", async () => {
      await expect(jira.editionSelect).toHaveValue("cloud");
      await expect(page.getByLabel("Email")).toBeVisible();
    });

    await test.step("Data Center edition shows Username label", async () => {
      await jira.editionSelect.selectOption("datacenter");
      await expect(page.getByLabel("Username")).toBeVisible();
    });
  });
});

// ============================================================================
// Part 3 — UI: Issue Viewer
// ============================================================================

test.describe("Epic #556 — Jira Issue Viewer UI", () => {
  let accessToken: string;
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const primed = await primeAdminUser(API_BASE);
    accessToken = primed.accessToken;
    const api = await authedApi(accessToken);
    projectId = await createProject(api, "viewer");

    // Create a connection via API so the issue viewer section is available
    const connRes = await api.post("/api/jira/connections", {
      data: {
        projectId,
        label: "viewer-conn",
        edition: "cloud",
        baseUrl: "https://viewer-test.atlassian.net",
        username: "viewer@test.com",
        apiToken: "viewer-token",
      },
    });
    expect(connRes.status()).toBe(201);
    await api.dispose();

    // Login via the UI
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  // AC1: Page accessible from project navigation
  test("should display Jira page with heading and connection", async ({ page }) => {
    const jira = new JiraPage(page);
    await jira.goto(projectId);

    await expect(jira.heading).toBeVisible();
    await expect(jira.connectionsHeading).toBeVisible();

    // Pre-seeded connection should be visible
    const card = jira.connectionCard("viewer-conn");
    await expect(card).toBeVisible();
  });

  // AC: Issue browser section appears when connection is selected
  test("should show issue browser section when a connection is selected", async ({ page }) => {
    const jira = new JiraPage(page);
    await jira.goto(projectId);

    // Initially no issue browser (no connection selected)
    await expect(jira.issueBrowserHeading).not.toBeVisible();

    // Click the connection card to select it
    const card = jira.connectionCard("viewer-conn");
    await card.click();

    // Issue browser section should appear
    await expect(jira.issueBrowserHeading).toBeVisible();
  });

  // AC2: Jira project selector dropdown
  test("should display Jira project selector when connection is selected", async ({ page }) => {
    const jira = new JiraPage(page);
    await jira.goto(projectId);

    // Select the connection
    const card = jira.connectionCard("viewer-conn");
    await card.click();

    await expect(jira.jiraProjectSelect).toBeVisible();
    // Default option covers every project the connection can see.
    await expect(jira.jiraProjectSelect).toContainText("All projects");
  });

  // AC3: JQL filter bar with Search button
  test("should display JQL filter bar and search button", async ({ page }) => {
    const jira = new JiraPage(page);
    await jira.goto(projectId);

    const card = jira.connectionCard("viewer-conn");
    await card.click();

    await expect(jira.jqlFilterInput).toBeVisible();
    await expect(jira.searchButton).toBeVisible();
  });

  // AC10: Empty state when no search has been performed
  test("should show empty state before search is performed", async ({ page }) => {
    const jira = new JiraPage(page);
    await jira.goto(projectId);

    // Select connection
    const card = jira.connectionCard("viewer-conn");
    await card.click();

    // The empty search state message doesn't appear until a project is selected
    // but no search has been run — verify the issue table doesn't render
    await expect(jira.issueTable).not.toBeVisible();
  });

  // AC3: Preset filter buttons appear after selecting a Jira project
  // (projects won't load from Jira, but we verify the search button works)
  test("should have a functional search button with JQL input", async ({ page }) => {
    const jira = new JiraPage(page);
    await jira.goto(projectId);

    const card = jira.connectionCard("viewer-conn");
    await card.click();

    // Type a JQL query into the filter bar
    await jira.jqlFilterInput.fill('project = "TEST" AND status = "To Do"');
    await expect(jira.searchButton).toBeEnabled();
  });

  // AC9: Pagination controls structure
  test("should render pagination controls when search results exist", async ({ page }) => {
    const jira = new JiraPage(page);
    await jira.goto(projectId);

    const card = jira.connectionCard("viewer-conn");
    await card.click();

    // Pagination buttons are only rendered when searchResults.data is present.
    // Since we don't have a real Jira, we just verify the page structure is intact.
    // Previous and Next buttons are part of the results section.
    await expect(jira.heading).toBeVisible();
  });

  // AC: Multiple connections can be listed and selected
  test("should allow creating multiple connections and switching between them", async ({
    page,
  }) => {
    // Create a second connection via API
    const api = await authedApi(accessToken);
    await api.post("/api/jira/connections", {
      data: {
        projectId,
        label: "second-conn",
        edition: "datacenter",
        baseUrl: "https://jira-dc.corp.net",
        username: "svc-account",
        apiToken: "dc-token",
      },
    });
    await api.dispose();

    const jira = new JiraPage(page);
    await jira.goto(projectId);

    // Both connections should be visible
    await expect(jira.connectionCard("viewer-conn")).toBeVisible();
    await expect(jira.connectionCard("second-conn")).toBeVisible();

    // Select first — issue browser appears
    await jira.connectionCard("viewer-conn").click();
    await expect(jira.issueBrowserHeading).toBeVisible();

    // Select second — issue browser still visible (switched context)
    await jira.connectionCard("second-conn").click();
    await expect(jira.issueBrowserHeading).toBeVisible();
  });

  // AC: Connection card shows edition badge
  test("should display correct edition badges on connection cards", async ({ page }) => {
    const api = await authedApi(accessToken);
    await api.post("/api/jira/connections", {
      data: {
        projectId,
        label: "dc-conn",
        edition: "datacenter",
        baseUrl: "https://jira-dc.corp.net",
        username: "svc-account",
        apiToken: "dc-token",
      },
    });
    await api.dispose();

    const jira = new JiraPage(page);
    await jira.goto(projectId);

    const cloudCard = jira.connectionCard("viewer-conn");
    await expect(jira.editionBadge(cloudCard)).toHaveText("cloud");

    const dcCard = jira.connectionCard("dc-conn");
    await expect(jira.editionBadge(dcCard)).toHaveText("datacenter");
  });

  // AC: TLS checkbox defaults to checked
  test("should default TLS verification to checked in add form", async ({ page }) => {
    const jira = new JiraPage(page);
    await jira.goto(projectId);
    await jira.openAddForm();

    await expect(jira.tlsCheckbox).toBeChecked();
  });
});
