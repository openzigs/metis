/**
 * Epic #770 — Requirement Version History & Per-Row Audit Trail.
 *
 * Exercises the user-facing history surface (#773 timeline + diff, #774 restore,
 * #775 export) on `/projects/:id/analysis` against the REAL server endpoints:
 *   GET  /api/requirements/:id/history          (#772)
 *   POST /api/requirements/:id/restore/:version (#772)
 *   GET  /api/requirements/:id/history/export    (#775)
 *
 * Acceptance criteria mapped:
 *   #773 AC — History tab renders a newest-first version timeline; selecting two
 *             versions reveals a side-by-side diff; timeline is keyboard
 *             navigable (entries are real <button>s with aria-pressed).
 *   #774 AC — Restore is gated to coordinators/admins, requires an explicit
 *             "Restore version N" confirmation, and creates a NEW version N+1
 *             without overwriting history.
 *   #775 AC — Export downloads the FULL history as CSV/JSON.
 *
 * Determinism notes:
 *   - The offline-stub AI provider can't emit structured requirements, so a
 *     Requirement is seeded directly into the e2e SQLite DB (same fixture as
 *     `data-mappings-panel.spec.ts`). Version rows are then created by issuing
 *     REAL PUT updates through the #771 history-appending update path.
 */
import { test, expect, request, type APIRequestContext, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { seedRequirementViaCli } from "../fixtures/seed-helpers.js";
import { LoginPage } from "../pages/login.page.js";
import { HistoryTabPage } from "../pages/history-tab.page.js";

const API_BASE = apiBase();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function authedApi(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

async function createProject(api: APIRequestContext, suffix: string): Promise<string> {
  const slug = `e2e-770-${suffix}-${Date.now()}`;
  const res = await api.post("/api/projects", {
    data: { name: `Version History ${slug}`, slug, description: "epic-770 e2e" },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  return (body.data?.project?.id ?? body.data?.id ?? body.id) as string;
}

async function seedCompletedAnalysis(api: APIRequestContext, projectId: string): Promise<string> {
  const startRes = await api.post(`/api/projects/${projectId}/analyses`, {
    data: { documentIds: [] },
  });
  expect([201, 202]).toContain(startRes.status());
  const startBody = await startRes.json();
  const analysisId = (startBody.data?.id ?? startBody.id) as string;
  expect(analysisId).toBeTruthy();

  for (let i = 0; i < 90; i++) {
    const res = await api.get(`/api/analyses/${analysisId}`);
    if (res.ok()) {
      const body = await res.json();
      const status = body.data?.status ?? body.status;
      if (["completed", "failed", "cancelled"].includes(status)) return analysisId;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Analysis ${analysisId} did not reach terminal state`);
}

function e2eDatabaseUrl(): string {
  const dbFile =
    process.env.E2E_DB_FILE ??
    path.join(__dirname, "..", "test-results", "stack-data", "metis-e2e.db");
  return `file:${dbFile}`;
}

/** Issue a REAL update so the #771 service appends a version-history row. */
async function updateRequirementTitle(
  token: string,
  requirementId: string,
  title: string,
): Promise<void> {
  const ctx = await authedApi(token);
  try {
    const res = await ctx.put(`/api/requirements/${requirementId}`, { data: { title } });
    expect(res.ok(), `update requirement: ${await res.text()}`).toBeTruthy();
  } finally {
    await ctx.dispose();
  }
}

async function fetchHistory(
  token: string,
  requirementId: string,
): Promise<{ versions: Array<{ version: number }>; currentVersion: number }> {
  const ctx = await authedApi(token);
  try {
    const res = await ctx.get(`/api/requirements/${requirementId}/history`);
    expect(res.ok(), `history: ${await res.text()}`).toBeTruthy();
    return (await res.json()).data;
  } finally {
    await ctx.dispose();
  }
}

/**
 * A non-coordinator user (developer is below `coordinator` in the role
 * hierarchy). It carries `project.read` — so it can VIEW the history timeline —
 * but lacks `project.update`, so restore is hidden in the UI and rejected by the
 * API. Used to prove the #774 admin/coordinator gating.
 */
const DEVELOPER_USER = { username: "developer", password: "password" } as const;

async function loginViaUi(
  page: Page,
  creds: { username: string; password: string } = ADMIN_USER,
): Promise<void> {
  const loginPage = new LoginPage(page);
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await loginPage.goto();
    await loginPage.username.fill(creds.username);
    await loginPage.password.fill(creds.password);
    try {
      await Promise.all([
        page.waitForResponse(
          (res) => res.url().endsWith("/api/auth/login") && res.request().method() === "POST",
          { timeout: 30_000 },
        ),
        loginPage.submit.click(),
      ]);
      await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
    }
  }
}

test.describe("Epic #770 — Requirement version history", () => {
  let token: string;
  let projectId: string;
  let requirementId: string;

  test.beforeEach(async ({ page }) => {
    test.setTimeout(300_000);

    const primed = await primeAdminUser(API_BASE);
    token = primed.accessToken;

    await loginViaUi(page);

    const api = await authedApi(token);
    projectId = await createProject(api, "history");
    const analysisId = await seedCompletedAnalysis(api, projectId);
    await api.dispose();

    requirementId = seedRequirementViaCli({
      projectId,
      analysisId,
      databaseUrl: e2eDatabaseUrl(),
    });
    expect(requirementId).toBeTruthy();

    // Two real edits → two version-history rows (the #771 update path appends a
    // changed-fields-only row per mutation).
    await updateRequirementTitle(token, requirementId, "Title after first edit");
    await updateRequirementTitle(token, requirementId, "Title after second edit");
  });

  // #773 — timeline renders and a two-version selection reveals the diff.
  test("renders the version timeline and a side-by-side diff", async ({ page }) => {
    const history = new HistoryTabPage(page);
    await history.goto(projectId);

    await test.step("open the inline history panel", async () => {
      await history.open();
      await expect(history.timeline).toBeVisible();
      // At least the two edits we made are present.
      expect(await history.versionButtons.count()).toBeGreaterThanOrEqual(2);
    });

    await test.step("selecting two versions reveals the diff", async () => {
      const buttons = history.versionButtons;
      await buttons.nth(0).click();
      await buttons.nth(1).click();
      await expect(history.diff).toBeVisible();
    });

    await test.step("timeline entries expose aria-pressed for keyboard a11y", async () => {
      await expect(history.versionButtons.first()).toHaveAttribute("aria-pressed", "true");
    });
  });

  // #773 — the timeline is keyboard navigable: a user can select two versions
  // and reveal the diff using only the keyboard (no pointer).
  test("selects two versions and renders the diff via the keyboard", async ({ page }) => {
    const history = new HistoryTabPage(page);
    await history.goto(projectId);
    await history.open();
    await expect(history.timeline).toBeVisible();

    const buttons = history.versionButtons;
    expect(await buttons.count()).toBeGreaterThanOrEqual(2);

    await test.step("activate the newest version with Enter", async () => {
      // `press` focuses the element first, proving it is keyboard-focusable.
      await buttons.nth(0).press("Enter");
      await expect(buttons.nth(0)).toHaveAttribute("aria-pressed", "true");
    });

    await test.step("activate a second version with Space", async () => {
      await buttons.nth(1).press(" ");
      await expect(buttons.nth(1)).toHaveAttribute("aria-pressed", "true");
    });

    await test.step("the side-by-side diff renders from a keyboard-only selection", async () => {
      await expect(history.diff).toBeVisible();
    });
  });

  // #774 — restore creates a NEW version N+1 and preserves history.
  test("restores a prior version, creating a new version without overwriting", async ({ page }) => {
    const before = await fetchHistory(token, requirementId);
    const currentVersion = before.currentVersion;
    const targetVersion = before.versions[before.versions.length - 1].version;
    const originalVersions = before.versions.map((v) => v.version);

    const history = new HistoryTabPage(page);
    await history.goto(projectId);
    await history.open();

    await test.step("open the restore confirmation for the oldest listed version", async () => {
      // Admin sees a Restore button per row; use the last (oldest) one.
      const restore = history.restoreButtons.last();
      await restore.click();
      await expect(page.getByText(/This creates a new version/)).toBeVisible();
    });

    await test.step("confirm requires the exact phrase", async () => {
      const confirmInput = page.getByLabel("Confirmation phrase");
      const confirmBtn = page.getByRole("button", { name: "Restore" }).last();
      await expect(confirmBtn).toBeDisabled();
      // A near-miss phrase must NOT enable the destructive action.
      await confirmInput.fill(`restore version ${targetVersion}`);
      await expect(confirmBtn).toBeDisabled();
      await confirmInput.fill(`Restore version ${targetVersion}`);
      await expect(confirmBtn).toBeEnabled();
      await confirmBtn.click();
    });

    await test.step("a new version N+1 was created server-side", async () => {
      await expect
        .poll(async () => (await fetchHistory(token, requirementId)).currentVersion)
        .toBeGreaterThan(currentVersion);
    });

    await test.step("history is preserved — every prior version still exists", async () => {
      const after = await fetchHistory(token, requirementId);
      const afterVersions = after.versions.map((v) => v.version);
      // None of the original version rows were overwritten or dropped.
      for (const v of originalVersions) {
        expect(afterVersions).toContain(v);
      }
      // The restore appended exactly one new row on top of the prior history.
      expect(after.versions.length).toBe(before.versions.length + 1);
    });
  });

  // #775 — export downloads the FULL history as CSV.
  test("exports the full version history as CSV", async ({ page }) => {
    const history = new HistoryTabPage(page);
    await history.goto(projectId);
    await history.open();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      history.exportButton.click().then(async () => {
        await page.getByRole("menuitem", { name: /CSV/ }).click();
      }),
    ]);

    expect(download.suggestedFilename()).toContain("history");
    expect(download.suggestedFilename()).toContain(".csv");
  });

  // #775 — the second export format (JSON) is also available from the dropdown
  // and downloads every version (not just the current page).
  test("exports the full version history as JSON", async ({ page }) => {
    const total = (await fetchHistory(token, requirementId)).versions.length;

    const history = new HistoryTabPage(page);
    await history.goto(projectId);
    await history.open();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      history.selectExport("JSON"),
    ]);

    expect(download.suggestedFilename()).toContain("history");
    expect(download.suggestedFilename()).toContain(".json");

    await test.step("the downloaded JSON contains every version", async () => {
      const filePath = await download.path();
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as { total: number; versions: Array<{ version: number }> };
      // Export is the FULL history, so its count matches the server's total.
      expect(parsed.versions.length).toBe(total);
      expect(parsed.total).toBe(total);
    });
  });

  // #775 — CSV export covers ALL versions and is RFC 4180-quoted. We seed a
  // field containing a comma and a double-quote, then assert the serializer
  // wraps it in quotes and doubles the embedded quote.
  test("CSV export covers all versions and applies RFC 4180 quoting", async ({ page }) => {
    // A title that MUST be quoted (comma) with an escaped inner quote. Leading
    // char is a letter so it is not treated as a spreadsheet formula.
    const trickyTitle = 'Audit, "v3" edit';
    await updateRequirementTitle(token, requirementId, trickyTitle);

    const total = (await fetchHistory(token, requirementId)).versions.length;

    const history = new HistoryTabPage(page);
    await history.goto(projectId);
    await history.open();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      history.selectExport("CSV"),
    ]);

    const filePath = await download.path();
    const csv = await fs.readFile(filePath, "utf8");

    await test.step("every version is present (header + one row per version)", async () => {
      // RFC 4180 records are CRLF-separated; the field itself contains no CRLF.
      const records = csv.split("\r\n").filter((line) => line.length > 0);
      // 1 header row + one data row per version.
      expect(records.length).toBe(total + 1);
    });

    await test.step("the comma/quote field is RFC 4180-quoted", async () => {
      // raw `Audit, "v3" edit` → `"Audit, ""v3"" edit"`.
      expect(csv).toContain('"Audit, ""v3"" edit"');
    });
  });

  // #774 — restore is gated to admins/coordinators. A developer can VIEW the
  // timeline but must NOT see any Restore affordance.
  test("hides the restore action from non-coordinator users", async ({ page }) => {
    await loginViaUi(page, DEVELOPER_USER);

    const history = new HistoryTabPage(page);
    await history.goto(projectId);
    await history.open();

    await test.step("the developer can still read the version timeline", async () => {
      await expect(history.timeline).toBeVisible();
      expect(await history.versionButtons.count()).toBeGreaterThanOrEqual(2);
    });

    await test.step("no Restore button is rendered for the developer", async () => {
      await expect(history.restoreButtons).toHaveCount(0);
    });
  });
});
