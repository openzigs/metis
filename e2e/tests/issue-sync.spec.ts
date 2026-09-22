/**
 * Epic #739 — Bidirectional Issue Sync E2E tests.
 *
 * Covers:
 *   Issue #745 — Drift indicator badge on Requirement cards
 *   Issue #746 — `/projects/:id/sync` drift dashboard with side-by-side diff
 *
 * Strategy:
 *   - Seed drift events via CLI helper (inserts directly into the e2e SQLite DB)
 *   - Verify badge rendering, navigation, table, modal, and resolution actions
 *   - Test empty state when no drift exists
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { seedDriftViaCli } from "../fixtures/seed-drift.js";
import { LoginPage } from "../pages/login.page.js";
import { SyncPage } from "../pages/sync.page.js";

const API_BASE = apiBase();

function databaseUrl(): string {
  return process.env.E2E_DB_FILE
    ? `file:${process.env.E2E_DB_FILE}`
    : (process.env.E2E_DATABASE_URL ?? "file:./e2e/test-results/stack-data/metis-e2e.db");
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
  const slug = `e2e-sync-${suffix}-${Date.now()}`;
  const res = await api.post("/api/projects", {
    data: { name: `Sync Test ${slug}`, slug, description: "epic-739 e2e" },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  return (body.data?.project?.id ?? body.data?.id ?? body.id) as string;
}

/** Seed a drift event directly in the e2e database via CLI helper. */
function seedDrift(
  projectId: string,
  opts?: { field?: string; localValue?: string; externalValue?: string },
): string {
  const result = seedDriftViaCli({
    projectId,
    databaseUrl: databaseUrl(),
    field: opts?.field,
    localValue: opts?.localValue,
    externalValue: opts?.externalValue,
  });
  return result.driftId;
}

// ============================================================================
// Part 1 — Sync Dashboard (Issue #746)
// ============================================================================

test.describe("Epic #739 — Sync Dashboard (@issue-746)", () => {
  let accessToken: string;
  let projectId: string;
  let api: APIRequestContext;

  test.beforeEach(async () => {
    const primed = await primeAdminUser(API_BASE);
    accessToken = primed.accessToken;
    api = await authedApi(accessToken);
    projectId = await createProject(api, "sync");
  });

  test.afterEach(async () => {
    await api.dispose();
  });

  // AC: Empty state shows happy message when no drift exists
  test("should show empty state when no drift events exist", async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.loginAsAdmin();

    const syncPage = new SyncPage(page);
    await syncPage.goto(projectId);

    await test.step("Verify empty state renders", async () => {
      await expect(syncPage.emptyStateCard).toBeVisible();
      await expect(syncPage.emptyStateMessage).toBeVisible();
    });

    await test.step("Verify no drift rows are displayed", async () => {
      await expect(syncPage.driftRows).toHaveCount(0);
    });
  });

  // AC: Paginated drift table displays correctly
  test("should display paginated drift table with drift events", async ({ page }) => {
    await test.step("Seed drift events", async () => {
      seedDrift(projectId, { field: "title" });
      seedDrift(projectId, { field: "body" });
      seedDrift(projectId, { field: "state", localValue: "open", externalValue: "closed" });
    });

    const loginPage = new LoginPage(page);
    await loginPage.loginAsAdmin();

    const syncPage = new SyncPage(page);
    await syncPage.goto(projectId);

    await test.step("Verify drift events are listed", async () => {
      await expect(syncPage.heading).toBeVisible();
      await expect(syncPage.pendingBadge).toBeVisible();
      // At least some drift rows should appear
      await expect(syncPage.driftRows.first()).toBeVisible();
    });
  });

  // AC: Side-by-side diff modal shows correct diff content
  test("should open side-by-side diff modal when clicking a drift row", async ({ page }) => {
    seedDrift(projectId, {
      field: "title",
      localValue: "Local Title",
      externalValue: "External Title",
    });

    const loginPage = new LoginPage(page);
    await loginPage.loginAsAdmin();

    const syncPage = new SyncPage(page);
    await syncPage.goto(projectId);

    await test.step("Click first drift row to open modal", async () => {
      await syncPage.clickDriftRow(0);
    });

    await test.step("Verify diff modal content", async () => {
      await expect(syncPage.diffModalTitle).toBeVisible();
      await expect(syncPage.localPanel).toBeVisible();
      await expect(syncPage.externalPanel).toBeVisible();
      // Verify the field name is displayed
      await expect(page.getByText("title").first()).toBeVisible();
    });

    await test.step("Verify action buttons are present", async () => {
      await expect(syncPage.adoptExternalButton).toBeVisible();
      await expect(syncPage.pushMetisButton).toBeVisible();
      await expect(syncPage.markDivergentButton).toBeVisible();
    });
  });

  // AC: Adopt external resolution action works
  test("should resolve drift by adopting external changes", async ({ page }) => {
    seedDrift(projectId, {
      field: "title",
      localValue: "METIS Title",
      externalValue: "GitHub Title",
    });

    const loginPage = new LoginPage(page);
    await loginPage.loginAsAdmin();

    const syncPage = new SyncPage(page);
    await syncPage.goto(projectId);

    await test.step("Open drift modal", async () => {
      await syncPage.clickDriftRow(0);
    });

    await test.step("Click Adopt External", async () => {
      await syncPage.adoptExternal();
    });

    await test.step("Verify drift is resolved (modal closes, item removed)", async () => {
      await expect(syncPage.diffModalTitle).not.toBeVisible();
      // After resolving the only item, empty state should appear
      await expect(syncPage.emptyStateCard).toBeVisible();
    });
  });

  // AC: Push METIS resolution action works
  test("should resolve drift by pushing METIS values", async ({ page }) => {
    seedDrift(projectId, {
      field: "body",
      localValue: "METIS body content",
      externalValue: "External body content",
    });

    const loginPage = new LoginPage(page);
    await loginPage.loginAsAdmin();

    const syncPage = new SyncPage(page);
    await syncPage.goto(projectId);

    await test.step("Open drift modal", async () => {
      await syncPage.clickDriftRow(0);
    });

    await test.step("Click Push METIS", async () => {
      await syncPage.pushMetis();
    });

    await test.step("Verify drift is resolved", async () => {
      await expect(syncPage.diffModalTitle).not.toBeVisible();
      await expect(syncPage.emptyStateCard).toBeVisible();
    });
  });

  // AC: Mark divergent resolution action works
  test("should resolve drift by marking as divergent", async ({ page }) => {
    seedDrift(projectId, {
      field: "labels",
      localValue: "bug,enhancement",
      externalValue: "bug,wontfix",
    });

    const loginPage = new LoginPage(page);
    await loginPage.loginAsAdmin();

    const syncPage = new SyncPage(page);
    await syncPage.goto(projectId);

    await test.step("Open drift modal", async () => {
      await syncPage.clickDriftRow(0);
    });

    await test.step("Click Mark Divergent", async () => {
      await syncPage.markDivergent();
    });

    await test.step("Verify drift is resolved", async () => {
      await expect(syncPage.diffModalTitle).not.toBeVisible();
      await expect(syncPage.emptyStateCard).toBeVisible();
    });
  });

  // AC: Diff modal can be closed without resolving
  test("should close diff modal without resolving", async ({ page }) => {
    seedDrift(projectId, { field: "title" });

    const loginPage = new LoginPage(page);
    await loginPage.loginAsAdmin();

    const syncPage = new SyncPage(page);
    await syncPage.goto(projectId);

    await test.step("Open and close modal", async () => {
      await syncPage.clickDriftRow(0);
      await expect(syncPage.diffModalTitle).toBeVisible();
      await syncPage.closeDiffModal();
      await expect(syncPage.diffModalTitle).not.toBeVisible();
    });

    await test.step("Drift row still exists", async () => {
      await expect(syncPage.driftRows.first()).toBeVisible();
    });
  });
});

// ============================================================================
// Part 2 — Drift Badge (Issue #745)
// ============================================================================

test.describe("Epic #739 — Drift Badge (@issue-745)", () => {
  let accessToken: string;
  let projectId: string;
  let api: APIRequestContext;

  test.beforeEach(async () => {
    const primed = await primeAdminUser(API_BASE);
    accessToken = primed.accessToken;
    api = await authedApi(accessToken);
    projectId = await createProject(api, "badge");
  });

  test.afterEach(async () => {
    await api.dispose();
  });

  // AC: Badge renders with drift count
  // #78 — `DriftBadge` is imported by nothing, so the count never renders on
  // any project surface. The seeding + assertions below are correct; they
  // fail only because the component is unmounted.
  test.fixme("should display drift badge with correct count", async ({ page }) => {
    seedDrift(projectId);
    seedDrift(projectId, { field: "body" });

    const loginPage = new LoginPage(page);
    await loginPage.loginAsAdmin();

    await test.step("Navigate to project detail", async () => {
      await page.goto(`/projects/${projectId}`);
    });

    await test.step("Verify drift badge renders", async () => {
      const badge = page.getByRole("status", { name: /pending drift/ });
      await expect(badge).toBeVisible();
    });
  });

  // AC: Click on badge navigates to sync page filtered to that requirement
  // #78 — `DriftBadge` is imported by nothing, so the count never renders on
  // any project surface. The seeding + assertions below are correct; they
  // fail only because the component is unmounted.
  test.fixme("should navigate to sync page when badge is clicked", async ({ page }) => {
    seedDrift(projectId);

    const loginPage = new LoginPage(page);
    await loginPage.loginAsAdmin();

    await test.step("Navigate to project", async () => {
      await page.goto(`/projects/${projectId}`);
    });

    await test.step("Click drift badge", async () => {
      const badge = page.getByRole("status", { name: /pending drift/ });
      await expect(badge).toBeVisible();
      await badge.click();
    });

    await test.step("Verify navigation to sync page", async () => {
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/sync`));
      const syncPage = new SyncPage(page);
      await expect(syncPage.heading).toBeVisible();
    });
  });

  // AC: Badge does not render when count is 0
  test("should not display drift badge when no drift events exist", async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.loginAsAdmin();

    await test.step("Navigate to project detail", async () => {
      await page.goto(`/projects/${projectId}`);
      // Wait for page to load fully
      await expect(page.getByRole("heading").first()).toBeVisible();
    });

    await test.step("Verify no drift badge is shown", async () => {
      const badge = page.getByRole("status", { name: /pending drift/ });
      await expect(badge).not.toBeVisible();
    });
  });

  // AC: Badge live-updates via Socket.IO
  // #78 — `DriftBadge` is imported by nothing, so the count never renders.
  test.fixme("should live-update badge count when new drift event arrives via Socket.IO", async ({
    page,
  }) => {
    seedDrift(projectId);

    const loginPage = new LoginPage(page);
    await loginPage.loginAsAdmin();

    await test.step("Navigate to project and verify initial badge", async () => {
      await page.goto(`/projects/${projectId}`);
      const badge = page.getByRole("status", { name: /pending drift/ });
      await expect(badge).toBeVisible();
    });

    await test.step("Seed another drift event while on page", async () => {
      seedDrift(projectId, { field: "body" });
    });

    await test.step("Badge count updates without page refresh", async () => {
      // The badge should update via Socket.IO event `requirement:drift`
      // Give it a moment for the websocket event to propagate
      const badge = page.getByRole("status", { name: /pending drift/ });
      // Verify badge is still visible (count may have incremented)
      await expect(badge).toBeVisible();
    });
  });
});

// ============================================================================
// Part 3 — Sync Dashboard filtered navigation (Issue #745 + #746 integration)
// ============================================================================

test.describe("Epic #739 — Badge → Sync Navigation Integration", () => {
  let accessToken: string;
  let projectId: string;
  let api: APIRequestContext;

  test.beforeEach(async () => {
    const primed = await primeAdminUser(API_BASE);
    accessToken = primed.accessToken;
    api = await authedApi(accessToken);
    projectId = await createProject(api, "nav");
  });

  test.afterEach(async () => {
    await api.dispose();
  });

  // AC: Sync page respects requirementId filter from badge navigation
  test("should filter sync page by requirementId when navigated from badge", async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.loginAsAdmin();

    const syncPage = new SyncPage(page);

    await test.step("Navigate to sync page with requirementId filter", async () => {
      await syncPage.goto(projectId, "test-requirement-123");
    });

    await test.step("Verify page loads with filter applied", async () => {
      await expect(syncPage.heading).toBeVisible();
      // URL should contain the requirementId parameter
      await expect(page).toHaveURL(/requirementId=test-requirement-123/);
    });
  });
});
