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
import crypto from "node:crypto";
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { seedDriftViaCli, type SeedDriftResult } from "../fixtures/seed-drift.js";
import { LoginPage } from "../pages/login.page.js";
import { SyncPage } from "../pages/sync.page.js";

const API_BASE = apiBase();
// Must match `playwright.config.ts`'s server env, which defaults the same way.
const JIRA_WEBHOOK_SECRET = process.env.JIRA_WEBHOOK_SECRET ?? "e2e-jira-sync-secret";
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? "e2e-closed-loop-secret";

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

/**
 * Seed a drift event directly in the e2e database via CLI helper.
 *
 * Returns the whole seeded chain, not just the drift id: `externalIssueId` is
 * what a real webhook has to carry for the reconciler to match it, which is the
 * only way to get a `drift:detected` broadcast (a direct row insert emits
 * nothing).
 */
function seedDrift(
  projectId: string,
  opts?: { field?: string; localValue?: string; externalValue?: string },
): SeedDriftResult {
  return seedDriftViaCli({
    projectId,
    databaseUrl: databaseUrl(),
    field: opts?.field,
    localValue: opts?.localValue,
    externalValue: opts?.externalValue,
  });
}

/** HMAC over the exact body bytes the server will verify. */
function signBody(secret: string, body: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Post a signed Jira `issue_updated` webhook for an already-published issue.
 * This is what drives `reconcileIssueChange` → a new `DriftEvent` row → the
 * `drift:detected` broadcast the badge listens to (#78). Seeding a row via the
 * CLI writes straight to SQLite and emits nothing, so it cannot exercise the
 * live-update path at all.
 */
async function postJiraIssueEditedWebhook(
  api: APIRequestContext,
  opts: { externalIssueId: string; issueKey: string; title: string; body: string },
): Promise<void> {
  const payload = JSON.stringify({
    webhookEvent: "jira:issue_updated",
    timestamp: Date.now(),
    issue: {
      id: opts.externalIssueId,
      key: opts.issueKey,
      fields: {
        summary: opts.title,
        description: opts.body,
        status: { name: "To Do" },
        labels: ["e2e", "sync-test"],
        assignee: null,
      },
    },
    changelog: {
      items: [{ field: "summary", fromString: "Original METIS title", toString: opts.title }],
    },
    user: { displayName: "e2e-external-editor" },
  });
  const res = await api.post("/api/webhooks/jira/issues", {
    headers: {
      "content-type": "application/json",
      "x-atlassian-webhook-id": crypto.randomUUID(),
      "x-hub-signature": signBody(JIRA_WEBHOOK_SECRET, payload),
    },
    data: payload,
  });
  expect(res.status(), await res.text()).toBe(200);
  // `handled:false` means the reconciler matched no PublishedIssue or found no
  // diff — i.e. no DriftEvent and no broadcast. Assert it here so a harness
  // regression fails loudly instead of as a mystery badge that never moves.
  const json = (await res.json()) as { ok: boolean; handled: boolean; reason?: string };
  expect(json, JSON.stringify(json)).toMatchObject({ ok: true, handled: true });
}

/**
 * Post a signed GitHub `issues.edited` webhook for an already-published issue.
 *
 * #96 — until this fix the drift reconciler's GitHub receiver was shadowed by
 * the spec-kit task-sync route on the same path, so a delivery like this one
 * answered `NO_TASK_EXPORT` and never produced a `DriftEvent`. The single
 * receiver now runs both pipelines and reports drift under `drift`.
 */
async function postGithubIssueEditedWebhook(
  api: APIRequestContext,
  opts: { externalIssueId: string; issueNumber: number; title: string; body: string },
): Promise<void> {
  const payload = JSON.stringify({
    action: "edited",
    issue: {
      id: opts.issueNumber,
      node_id: opts.externalIssueId,
      number: opts.issueNumber,
      title: opts.title,
      body: opts.body,
      state: "open",
      labels: [{ name: "e2e" }, { name: "sync-test" }],
      assignees: [],
    },
    changes: { title: { from: "Original METIS title" } },
    repository: { full_name: "e2e-org/e2e-repo" },
    sender: { login: "e2e-external-editor" },
  });
  const res = await api.post("/api/webhooks/github/issues", {
    headers: {
      "content-type": "application/json",
      "x-github-event": "issues",
      "x-github-delivery": crypto.randomUUID(),
      "x-hub-signature-256": signBody(GITHUB_WEBHOOK_SECRET, payload),
    },
    data: payload,
  });
  expect(res.status(), await res.text()).toBe(200);
  const json = (await res.json()) as { ok: boolean; drift?: { handled: boolean } };
  expect(json, JSON.stringify(json)).toMatchObject({ ok: true, drift: { handled: true } });
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
  // #78 mounted `DriftBadge` on the project Overview's Publish stage, so this
  // is live again. It asserts the COUNT, not just visibility: a badge that
  // renders a hardcoded or stale number would pass a visibility-only check.
  test("should display drift badge with correct count", async ({ page }) => {
    seedDrift(projectId);
    seedDrift(projectId, { field: "body" });

    const loginPage = new LoginPage(page);
    await loginPage.loginAsAdmin();

    await test.step("Navigate to project detail", async () => {
      await page.goto(`/projects/${projectId}`);
    });

    await test.step("Verify drift badge renders the pending count", async () => {
      const badge = page.getByRole("button", { name: /pending drift/ });
      await expect(badge).toBeVisible();
      await expect(badge).toHaveText("2");
      await expect(badge).toHaveAccessibleName("View 2 pending drift events");
    });
  });

  // AC: Click on badge navigates to sync page filtered to that requirement
  // Live again since #78 mounted the badge on the project Overview.
  test("should navigate to sync page when badge is clicked", async ({ page }) => {
    seedDrift(projectId);

    const loginPage = new LoginPage(page);
    await loginPage.loginAsAdmin();

    await test.step("Navigate to project", async () => {
      await page.goto(`/projects/${projectId}`);
    });

    await test.step("Click drift badge", async () => {
      const badge = page.getByRole("button", { name: /pending drift/ });
      await expect(badge).toBeVisible();
      await badge.click();
    });

    await test.step("Verify navigation to sync page", async () => {
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/sync`));
      const syncPage = new SyncPage(page);
      await expect(syncPage.heading).toBeVisible();
    });
  });

  // #90 — the badge is a real control: reachable and activatable by keyboard.
  test("should navigate to sync page when the badge is activated by keyboard", async ({ page }) => {
    seedDrift(projectId);

    const loginPage = new LoginPage(page);
    await loginPage.loginAsAdmin();
    await page.goto(`/projects/${projectId}`);

    const badge = page.getByRole("button", { name: "View 1 pending drift event" });
    await expect(badge).toBeVisible();
    await badge.focus();
    await expect(badge).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/sync`));
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
      const badge = page.getByRole("button", { name: /pending drift/ });
      await expect(badge).not.toBeVisible();
    });
  });

  // AC: Badge live-updates via Socket.IO
  //
  // Live again since #78 wired `drift:detected`, the project-room event the
  // badge's count hook listens to.
  //
  // This DRIVES A REAL SIGNED WEBHOOK rather than seeding a second row: the
  // CLI seeder writes straight to SQLite, so it produces no broadcast at all
  // and the "live update" would be indistinguishable from a page that never
  // updated. The assertion is the count changing 1 → 2 with no reload.
  // #96 — driven from BOTH receivers. The GitHub one was unreachable before #96
  // (shadowed by the spec-kit route), which is why this used to be Jira-only.
  for (const source of ["github", "jira"] as const) {
    test(`should live-update badge count when a ${source} drift event arrives via Socket.IO`, async ({
      page,
    }) => {
      const seeded = seedDrift(projectId);

      const loginPage = new LoginPage(page);
      await loginPage.loginAsAdmin();

      const badge = page.getByRole("button", { name: /pending drift/ });

      await test.step("Navigate to project and verify initial badge", async () => {
        await page.goto(`/projects/${projectId}`);
        await expect(badge).toBeVisible();
        await expect(badge).toHaveText("1");
      });

      await test.step(`An external ${source} edit arrives by webhook while the page is open`, async () => {
        const edit = {
          externalIssueId: seeded.externalIssueId,
          title: "Externally edited while the badge was on screen",
          body: seeded.draftBody,
        };
        if (source === "github") {
          await postGithubIssueEditedWebhook(api, { ...edit, issueNumber: seeded.issueNumber });
        } else {
          await postJiraIssueEditedWebhook(api, { ...edit, issueKey: `E2E-${seeded.issueNumber}` });
        }
      });

      await test.step("Badge count updates without page refresh", async () => {
        await expect(badge).toHaveText("2");
      });
    });
  }
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
