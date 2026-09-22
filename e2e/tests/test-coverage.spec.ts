/**
 * Epic #856 — Test Coverage Gap Analysis end-to-end coverage.
 *
 * Two flows exercised against the seeded admin token (AI_OFFLINE=1 so the
 * gap-analysis run is deterministic and cheap):
 *
 *   Mode A — operator uploads test cases (CSV), kicks off a coverage run,
 *   waits for `completed`, fetches the report, then downloads the Excel
 *   export.
 *
 *   Mode B — same project, no extra imports needed. After the same run we
 *   download the Gherkin export of any AI-generated suggestions. If the
 *   run produced low-confidence suggestions, the export honours the
 *   override flag (audit-logged on the server).
 */
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user";
import { apiBase } from "../fixtures/api-base";
import { isOfflineAiStub, OFFLINE_AI_SKIP_REASON } from "../fixtures/ai-mode.js";
// A live analysis always ends `failed` under the offline-stub provider, so the
// shared helper seeds a COMPLETED analysis straight into the e2e database.
import { seedCompletedAnalysis } from "../fixtures/review-helpers.js";
import { seedRequirementViaCli } from "../fixtures/seed-helpers";
import { LoginPage } from "../pages/login.page";
import { TestCoveragePage } from "../pages/test-coverage.page";

const API_BASE = apiBase();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the e2e SQLite database URL the CLI seed helpers write to. Mirrors
 * `data-mappings-panel.spec.ts` so requirement seeding hits the same DB the
 * stack reads from. (#279)
 */
function e2eDatabaseUrl(): string {
  const dbFile =
    process.env.E2E_DB_FILE ??
    path.join(__dirname, "..", "test-results", "stack-data", "metis-e2e.db");
  return `file:${dbFile}`;
}

/**
 * Start an analysis and poll its snapshot to a terminal state, returning the
 * analysisId. Works offline (AI_OFFLINE=1) — the same pattern data-mappings
 * relies on. The requirement seeder needs a real analysisId to attach to. (#279)
 */

/**
 * Seed one or more requirements the canonical e2e way (#279): there is NO HTTP
 * create endpoint for requirements, so we seed an analysis to terminal and
 * insert each requirement via the CLI helper (writes straight to the e2e DB).
 * Returns the seeded requirement ids.
 */
async function seedRequirementsViaCli(
  api: APIRequestContext,
  projectId: string,
  count: number,
): Promise<string[]> {
  const analysisId = await seedCompletedAnalysis(api, projectId);
  const databaseUrl = e2eDatabaseUrl();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(seedRequirementViaCli({ projectId, analysisId, databaseUrl }));
  }
  return ids;
}

interface Envelope<T> {
  success: boolean;
  data: T;
}

async function adminContext(): Promise<APIRequestContext> {
  const { accessToken } = await primeAdminUser(API_BASE);
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
  });
}

async function waitForRun(
  ctx: APIRequestContext,
  projectId: string,
  runId: string,
  timeoutMs = 60_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "queued";
  while (Date.now() < deadline) {
    const res = await ctx.get(`/api/projects/${projectId}/test-coverage/runs/${runId}`);
    if (res.status() === 200) {
      const body = (await res.json()) as Envelope<{ status: string }>;
      lastStatus = body.data.status;
      if (lastStatus === "completed" || lastStatus === "failed") return lastStatus;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return lastStatus;
}

test.describe("Epic #856 — Test Coverage", () => {
  test("Mode A: upload CSV → run → report → export Excel", async () => {
    const ctx = await adminContext();
    try {
      const slug = `e2e-tc-a-${Date.now()}`;
      const created = await ctx.post("/api/projects", {
        data: { name: `TC Mode A ${slug}`, slug, description: "epic-856" },
      });
      expect(created.status(), await created.text()).toBe(201);
      const projectId = (await created.json()).data.id as string;

      // Seed a requirement so the matrix has something to evaluate. There is no
      // HTTP create endpoint for requirements (#279) — seed via the CLI helper.
      await seedRequirementsViaCli(ctx, projectId, 1);

      // Paste a tiny CSV import (no file system needed).
      const pasteRes = await ctx.post(`/api/projects/${projectId}/test-coverage/imports/paste`, {
        data: {
          source: "csv",
          label: "Smoke set",
          text:
            "title,steps,expected\n" +
            "Login,Submit valid creds,Dashboard shown\n" +
            "Logout,Click sign out,Login page shown",
        },
      });
      expect(pasteRes.status(), await pasteRes.text()).toBe(201);

      // Kick off a coverage run.
      const runRes = await ctx.post(`/api/projects/${projectId}/test-coverage/runs`, { data: {} });
      expect(runRes.status(), await runRes.text()).toBe(202);
      const runId = ((await runRes.json()) as Envelope<{ id: string }>).data.id;

      const status = await waitForRun(ctx, projectId, runId);
      expect(status).toBe("completed");

      // Fetch the structured report.
      const reportRes = await ctx.get(
        `/api/projects/${projectId}/test-coverage/runs/${runId}/report`,
      );
      expect(reportRes.status()).toBe(200);
      const report = (
        (await reportRes.json()) as Envelope<{
          summary: { total: number; covered: number; gaps: number; coveragePct: number };
          suggestions: unknown[];
          mappings: unknown[];
          gaps: unknown[];
        }>
      ).data;
      // The report nests its headline numbers under `summary` (see the
      // /runs/:runId/report handler); there is no top-level
      // `coveragePercentage`.
      expect(typeof report.summary.coveragePct).toBe("number");

      // Download the Excel export.
      const excelRes = await ctx.post(`/api/projects/${projectId}/test-coverage/exports`, {
        data: { runId, target: "excel" },
      });
      expect(excelRes.status(), await excelRes.text()).toBe(200);
      expect(excelRes.headers()["content-type"] ?? "").toContain("spreadsheetml");
      const excelBody = await excelRes.body();
      expect(excelBody.byteLength).toBeGreaterThan(0);
    } finally {
      await ctx.dispose();
    }
  });

  test("Mode B: export Gherkin honours the low-confidence override gate", async () => {
    const ctx = await adminContext();
    try {
      const slug = `e2e-tc-b-${Date.now()}`;
      const created = await ctx.post("/api/projects", {
        data: { name: `TC Mode B ${slug}`, slug, description: "epic-856" },
      });
      expect(created.status(), await created.text()).toBe(201);
      const projectId = (await created.json()).data.id as string;

      // Seed two requirements only — encourages low-confidence suggestions.
      // No HTTP create endpoint exists (#279); seed via the CLI helper.
      await seedRequirementsViaCli(ctx, projectId, 2);

      const runRes = await ctx.post(`/api/projects/${projectId}/test-coverage/runs`, { data: {} });
      expect(runRes.status(), await runRes.text()).toBe(202);
      const runId = ((await runRes.json()) as Envelope<{ id: string }>).data.id;

      const status = await waitForRun(ctx, projectId, runId);
      expect(status).toBe("completed");

      // First export attempt without override may be blocked when
      // low-confidence suggestions exist. Either outcome (200 with file or
      // 400 LOW_CONFIDENCE_BLOCKED) is valid — but the second attempt with
      // the override flag MUST succeed.
      const first = await ctx.post(`/api/projects/${projectId}/test-coverage/exports`, {
        data: { runId, target: "gherkin" },
      });
      expect([200, 400]).toContain(first.status());
      if (first.status() === 400) {
        const body = (await first.json()) as Envelope<unknown> & {
          error?: { code?: string };
        };
        expect(body.error?.code).toBe("LOW_CONFIDENCE_BLOCKED");
      }

      const second = await ctx.post(`/api/projects/${projectId}/test-coverage/exports`, {
        data: { runId, target: "gherkin", overrideLowConfidence: true },
      });
      expect(second.status(), await second.text()).toBe(200);
      const ct = second.headers()["content-type"] ?? "";
      expect(ct.includes("application/zip") || ct.includes("text/plain")).toBe(true);
      const bytes = await second.body();

      // Gherkin export writes one feature per SUGGESTION. Suggestion
      // generation needs a model that returns structured JSON, which the
      // deterministic harness's offline-stub provider cannot do, so a run here
      // legitimately produces none — and then the export is empty. Assert
      // against the run's actual suggestion count rather than assuming.
      const reportRes = await ctx.get(
        `/api/projects/${projectId}/test-coverage/runs/${runId}/report`,
      );
      const suggestionCount = ((await reportRes.json()) as Envelope<{ suggestions: unknown[] }>)
        .data.suggestions.length;
      if (suggestionCount > 0) {
        expect(bytes.byteLength).toBeGreaterThan(0);
      } else {
        expect(bytes.byteLength).toBe(0);
      }
    } finally {
      await ctx.dispose();
    }
  });
});

/**
 * Browser-driven UI coverage for the Test Coverage page (issue #865).
 *
 * The flows below drive the real Next.js page at
 * `/projects/:id/test-coverage`. They exercise the public test contract of
 * the page (accessible labels, roles, plus a small number of testids the UI
 * deliberately exports) so a regression in the rendered surface — not just
 * the API — fails the suite.
 *
 * To keep wall-clock time bounded, the suite seeds project + requirements +
 * a CSV import via the API, then performs the user-visible actions
 * (Start new run, view summary, open matrix, export) in the browser.
 */
test.describe("Epic #856 — Test Coverage UI", () => {
  test.describe.configure({ timeout: 180_000 });

  async function createSeededProject(ctx: APIRequestContext, label: string): Promise<string> {
    const slug = `e2e-tc-ui-${label}-${Date.now()}`;
    const created = await ctx.post("/api/projects", {
      data: { name: `TC UI ${slug}`, slug, description: "epic-856 ui" },
    });
    expect(created.status(), await created.text()).toBe(201);
    return ((await created.json()) as Envelope<{ id: string }>).data.id;
  }

  // There is no HTTP create endpoint for requirements (#279); seed each one
  // via the CLI helper (one seeded analysis, N requirements). `titles` is kept
  // to preserve the per-test intent / count, though the seeded rows derive
  // their titles from the seed script.
  async function seedRequirements(
    ctx: APIRequestContext,
    projectId: string,
    titles: string[],
  ): Promise<void> {
    await seedRequirementsViaCli(ctx, projectId, titles.length);
  }

  // AC #865 — page header is visible and the import card surfaces the
  // upload + paste affordances and the empty state copy when no imports
  // exist.
  test("renders empty state with import + run affordances", async ({ page }) => {
    const apiCtx = await adminContext();
    let projectId = "";
    try {
      projectId = await createSeededProject(apiCtx, "empty");
      const login = new LoginPage(page);
      await login.goto();
      await login.login(ADMIN_USER.username, ADMIN_USER.password);

      const tc = new TestCoveragePage(page, projectId);
      await tc.goto();

      await expect(tc.heading).toBeVisible();
      await expect(tc.description).toBeVisible();
      await expect(tc.importHeading).toBeVisible();
      await expect(tc.pasteButton).toBeEnabled();
      await expect(tc.importsEmptyState).toBeVisible();
      await expect(tc.runsHeading).toBeVisible();
      await expect(tc.runsEmptyState).toBeVisible();
      await expect(tc.newRunButton).toBeEnabled();

      // Coverage matrix / suggestions sections only render once there's a
      // completed run.
      await expect(tc.matrixHeading).toBeHidden();
      await expect(tc.suggestionsHeading).toBeHidden();
    } finally {
      await apiCtx.dispose();
    }
  });

  // AC #865 — operator can paste CSV via the dialog and the import shows
  // up in the imports list once the mutation succeeds.
  test("Mode A — paste CSV via the dialog appears in the imports list", async ({ page }) => {
    const apiCtx = await adminContext();
    try {
      const projectId = await createSeededProject(apiCtx, "paste");
      const login = new LoginPage(page);
      await login.goto();
      await login.login(ADMIN_USER.username, ADMIN_USER.password);

      const tc = new TestCoveragePage(page, projectId);
      await tc.goto();

      await tc.pasteCsv(
        "Smoke set",
        "title,steps,expected\nLogin,Submit creds,Dashboard\nLogout,Click out,Login\n",
      );

      // The empty state should be replaced by the imports list rendering at
      // least one row (filename or source label, followed by case counts).
      await expect(tc.importsEmptyState).toBeHidden({ timeout: 10_000 });
      await expect(page.getByText(/Smoke set|csv/).first()).toBeVisible();
      await expect(page.getByText(/2 cases/)).toBeVisible();
    } finally {
      await apiCtx.dispose();
    }
  });

  // AC #865 — operator uploads a real CSV file via the hidden, aria-labelled
  // file input (the UI's primary "upload" affordance).
  test("Mode A — upload CSV via hidden file input appears in the imports list", async ({
    page,
  }) => {
    const apiCtx = await adminContext();
    try {
      const projectId = await createSeededProject(apiCtx, "upload");
      const login = new LoginPage(page);
      await login.goto();
      await login.login(ADMIN_USER.username, ADMIN_USER.password);

      const tc = new TestCoveragePage(page, projectId);
      await tc.goto();

      const csv =
        "title,steps,expected\nCase A,do thing,result\nCase B,do another,result\nCase C,do third,result\n";
      await tc.uploadInput.setInputFiles({
        name: "tests.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(csv, "utf8"),
      });

      await expect(tc.importsEmptyState).toBeHidden({ timeout: 10_000 });
      await expect(page.getByText("tests.csv")).toBeVisible();
      await expect(page.getByText(/3 cases/)).toBeVisible();
    } finally {
      await apiCtx.dispose();
    }
  });

  // AC #868 + #875 — after a successful run the page reveals the coverage
  // summary (percentage + gaps + suggestions counts), the requirements ×
  // tests matrix (role=grid), and the suggestions card with an Export
  // button. Excel export downloads through the browser, and the Gherkin
  // export with the override checkbox also downloads. Suggestion review
  // dialog surfaces the Given/When/Then breakdown.
  test("Mode A — run → summary, matrix, gaps, suggestions, exports", async ({ page }) => {
    // The suggestions card, its review dialog and the Gherkin export all need
    // at least one generated suggestion.
    test.skip(isOfflineAiStub(), OFFLINE_AI_SKIP_REASON);
    const apiCtx = await adminContext();
    try {
      const projectId = await createSeededProject(apiCtx, "run");
      await seedRequirements(apiCtx, projectId, [
        "User can sign in",
        "User can sign out",
        "User can reset password",
      ]);

      // Seed an import via the API so the run has cases to match against.
      const pasteRes = await apiCtx.post(`/api/projects/${projectId}/test-coverage/imports/paste`, {
        data: {
          source: "csv",
          label: "Seeded",
          text:
            "title,steps,expected\n" +
            "Login,Submit creds,Dashboard\n" +
            "Logout,Click sign out,Login page\n",
        },
      });
      expect(pasteRes.status(), await pasteRes.text()).toBe(201);

      const login = new LoginPage(page);
      await login.goto();
      await login.login(ADMIN_USER.username, ADMIN_USER.password);

      const tc = new TestCoveragePage(page, projectId);
      await tc.goto();

      // Kick off the run from the UI.
      await tc.startNewRun();

      // At least one run row should render (the page polls runs every 4s).
      await expect(page.getByTestId("tc-run-row").first()).toBeVisible({ timeout: 30_000 });

      // Coverage summary + percentage badge appears once the run succeeds.
      await tc.waitForSummary();
      await expect(tc.coveragePct).toHaveText(/\d+(?:\.\d+)?%/);

      // Matrix card is rendered with a grid role.
      await expect(tc.matrixHeading).toBeVisible();
      await expect(tc.matrixGrid).toBeVisible();

      // Suggestions card is rendered with the Export button.
      await expect(tc.suggestionsHeading).toBeVisible();
      await expect(tc.exportButton).toBeVisible();

      // Suggestion review dialog surfaces the Given/When/Then sections.
      const firstSuggestion = tc.suggestionRow.first();
      await expect(firstSuggestion).toBeVisible();
      await firstSuggestion.getByRole("button", { name: "Review" }).click();
      const reviewDialog = page.getByRole("dialog");
      await expect(reviewDialog).toBeVisible();
      await expect(reviewDialog.getByText("Given", { exact: true })).toBeVisible();
      await expect(reviewDialog.getByText("When", { exact: true })).toBeVisible();
      await expect(reviewDialog.getByText("Then", { exact: true })).toBeVisible();
      await reviewDialog.getByRole("button", { name: "Reject" }).click();
      await expect(reviewDialog).toBeHidden();

      // Excel export downloads a real file with the .xlsx-ish filename.
      const excel = await tc.downloadExport("excel");
      const excelName = excel.suggestedFilename();
      expect(excelName.length).toBeGreaterThan(0);
      const excelPath = await excel.path();
      expect(excelPath, "download was streamed to disk").toBeTruthy();

      // Gherkin export with the low-confidence override also downloads.
      // (The override flag is audit-logged server-side — we only assert
      // the user-visible download here.)
      const gherkin = await tc.downloadExport("gherkin", { override: true });
      expect(gherkin.suggestedFilename().length).toBeGreaterThan(0);
      const gherkinPath = await gherkin.path();
      expect(gherkinPath).toBeTruthy();
    } finally {
      await apiCtx.dispose();
    }
  });

  // AC (Mode B) — a project with requirements but ZERO test cases can still
  // trigger a run from the UI; the pipeline skips matching and surfaces
  // suggestions for the uncovered requirements. We assert the user-visible
  // outcome: the suggestions card renders after the run completes.
  test("Mode B — cold start with zero test cases still produces suggestions", async ({ page }) => {
    test.skip(isOfflineAiStub(), OFFLINE_AI_SKIP_REASON);
    const apiCtx = await adminContext();
    try {
      const projectId = await createSeededProject(apiCtx, "coldstart");
      await seedRequirements(apiCtx, projectId, ["Cold start req A", "Cold start req B"]);

      const login = new LoginPage(page);
      await login.goto();
      await login.login(ADMIN_USER.username, ADMIN_USER.password);

      const tc = new TestCoveragePage(page, projectId);
      await tc.goto();

      // No imports — the empty state is still visible.
      await expect(tc.importsEmptyState).toBeVisible();

      await tc.startNewRun();
      await expect(page.getByTestId("tc-run-row").first()).toBeVisible({ timeout: 30_000 });
      await tc.waitForSummary();

      // Coverage on zero tests is 0%.
      await expect(tc.coveragePct).toHaveText(/^0(?:\.0+)?%$/);

      // Suggestions card is the cold-start payoff for the operator.
      await expect(tc.suggestionsHeading).toBeVisible();
      await expect(tc.suggestionRow.first()).toBeVisible();
    } finally {
      await apiCtx.dispose();
    }
  });
});
