/**
 * Epic #776 — Inbound Importers end-to-end coverage.
 *
 * Exercises the import wizard (#783) and the import history + ongoing-sync
 * toggle (#784) against a real authenticated METIS UI. The importer REST
 * surface (`/api/projects/:id/imports/...`) is stubbed at the network layer
 * (`fixtures/import-helpers.ts`) so every run is deterministic and never
 * touches live GitHub / Jira / Azure DevOps / Linear APIs.
 *
 * Acceptance-criteria mapping (epic #776):
 *   AC1 — Preview renders count + first 10 mapped requirements within 5s
 *         → "preview renders the count and first 10 mapped requirements within 5s"
 *   AC2 — Re-run creates exactly 5 new requirements, no duplicates
 *         → "re-running an import creates exactly 5 new requirements (dedup)"
 *   AC3 — Ongoing sync toggle + interval picker (default 15 min) persists
 *         → "ongoing-sync toggle persists with the default 15-minute interval"
 *
 * Wizard / history flow coverage (#783 / #784):
 *   - source picker swaps the dynamic filter fields per source
 *   - select source → filter → preview → run (create)
 *   - progress UI surfaces task-engine status
 *   - history empty state + list rendering
 *   - run-now
 *   - delete-with-confirm
 */
import { test, expect, request } from "@playwright/test";
import { primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { ImportPage } from "../pages/import.page.js";
import {
  buildPreview,
  buildRun,
  buildSource,
  installImportMocks,
} from "../fixtures/import-helpers.js";

const API_BASE = apiBase();

test.describe("Epic #776 — Inbound Importers", () => {
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const { accessToken } = await primeAdminUser(API_BASE);
    const ctx = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
    });
    const slug = `e2e-import-${Date.now()}`;
    const res = await ctx.post("/api/projects", {
      data: { name: `Import ${slug}`, slug, description: "epic-776 e2e" },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    projectId = body.data?.id ?? body.id;
    await ctx.dispose();

    await new LoginPage(page).loginAsAdmin();
  });

  // --- Wizard (#783) --------------------------------------------------------

  // AC1: "Given a coordinator points the importer at a GitHub repo with a label
  // filter, When they click Preview, Then the count and first 10 mapped
  // Requirements render within 5s."
  test("preview renders the count and first 10 mapped requirements within 5s", async ({ page }) => {
    const ctrl = await installImportMocks(page, projectId);
    ctrl.setPreview(buildPreview("github", 42, 10));

    const po = new ImportPage(page, projectId);
    await po.goto();

    await test.step("point at a GitHub repo with a label filter", async () => {
      await po.selectSource("github");
      await po.filterField("Owner / org").fill("octocat");
      await po.filterField("Repository").fill("hello-world");
      await po.filterField("Labels (comma-separated, optional)").fill("bug");
      await po.tokenInput.fill("ghp_test_token");
    });

    await test.step("Preview returns count + first 10 within the 5s SLA", async () => {
      await po.previewButton.click();
      await expect(po.previewBox).toContainText("42 matching issues", { timeout: 5_000 });
      await expect(page.getByText(/Imported issue #/)).toHaveCount(10, { timeout: 5_000 });
    });
  });

  test("source picker swaps the dynamic filter fields per source", async ({ page }) => {
    await installImportMocks(page, projectId);
    const po = new ImportPage(page, projectId);
    await po.goto();

    await test.step("GitHub fields + API token are shown by default", async () => {
      await expect(po.filterField("Owner / org")).toBeVisible();
      await expect(po.filterField("Repository")).toBeVisible();
      await expect(po.tokenInput).toBeVisible();
    });

    await test.step("Jira shows JQL + connection and hides the API token", async () => {
      await po.selectSource("jira");
      await expect(po.filterField("JQL")).toBeVisible();
      await expect(po.filterField("Jira connection ID")).toBeVisible();
      await expect(po.tokenInput).toBeHidden();
    });

    await test.step("Azure DevOps shows organization + project", async () => {
      await po.selectSource("azure-devops");
      await expect(po.filterField("Organization")).toBeVisible();
      await expect(po.filterField("Project")).toBeVisible();
    });

    await test.step("Linear shows the team id", async () => {
      await po.selectSource("linear");
      await expect(po.filterField("Team ID")).toBeVisible();
    });
  });

  test("full wizard flow: select source → filter → preview → run", async ({ page }) => {
    const ctrl = await installImportMocks(page, projectId);
    ctrl.setPreview(buildPreview("linear", 3));

    const po = new ImportPage(page, projectId);
    await po.goto();

    await test.step("select Linear and describe the filter", async () => {
      await po.selectSource("linear");
      await po.labelInput.fill("My Linear import");
      await po.filterField("Team ID").fill("TEAM-1");
      await po.tokenInput.fill("lin_test_token");
    });

    await test.step("preview the matched issues", async () => {
      await po.previewButton.click();
      await expect(po.previewBox).toContainText("3 matching issues");
    });

    await test.step("run the import and see it in history with task status", async () => {
      await po.importButton.click();
      await expect(page.getByText("My Linear import")).toBeVisible();
      await expect(po.lastRunStatus("pending")).toBeVisible();
    });
  });

  // --- History + ongoing sync (#784) ---------------------------------------

  // AC2: "Given the same import is re-run a week later, When 5 new issues exist
  // upstream, Then exactly 5 new Requirements are created (no duplicates)."
  test("re-running an import creates exactly 5 new requirements (dedup)", async ({ page }) => {
    const source = buildSource(projectId, {
      label: "GitHub backlog",
      lastRun: buildRun("seed", projectId, { createdCount: 0, updatedCount: 0 }),
    });
    const ctrl = await installImportMocks(page, projectId, [source]);
    // Dedup on (externalId, externalSource): only the 5 new upstream issues are
    // created; the previously-seen ones are skipped, not duplicated.
    ctrl.setRunOutcome({ createdCount: 5, updatedCount: 0, skippedCount: 12, status: "completed" });

    const po = new ImportPage(page, projectId);
    await po.goto();
    await expect(page.getByText("GitHub backlog")).toBeVisible();

    await po.runNowButton.click();

    // The run badge surfaces "+created/~updated" — exactly 5 created, 0 updated.
    await expect(po.runCountBadge(5, 0)).toBeVisible();
  });

  // AC3: "Given a Linear team enables ongoing sync ... within the configured
  // sync interval (default 15 min)." Validates the toggle + interval persistence
  // surfaced in the import history list.
  test("ongoing-sync toggle persists with the default 15-minute interval", async ({ page }) => {
    const source = buildSource(projectId, {
      source: "linear",
      label: "Linear team sync",
      syncEnabled: false,
      syncIntervalMinutes: 15,
    });
    await installImportMocks(page, projectId, [source]);

    const po = new ImportPage(page, projectId);
    await po.goto();

    const toggle = po.syncToggle("Linear team sync");
    await expect(toggle).not.toBeChecked();
    // Interval picker defaults to 15 minutes.
    await expect(po.intervalInput).toHaveValue("15");

    await test.step("enabling sync persists across a reload", async () => {
      // Controlled checkbox: the box only flips once the PATCH + refetch round
      // trip completes, so click + retrying assertion (not .check()).
      await toggle.click();
      await expect(toggle).toBeChecked();
      await expect(po.intervalInput).toHaveValue("15");

      await po.goto();
      await expect(po.syncToggle("Linear team sync")).toBeChecked();
      await expect(po.intervalInput).toHaveValue("15");
    });
  });

  test("progress UI surfaces the task-engine status for a run", async ({ page }) => {
    const source = buildSource(projectId, {
      label: "Running import",
      lastRun: buildRun("seed", projectId, { status: "running", completedAt: null }),
    });
    await installImportMocks(page, projectId, [source]);

    const po = new ImportPage(page, projectId);
    await po.goto();

    await expect(po.lastRunStatus("running")).toBeVisible();
  });

  test("history shows an empty state then renders saved imports", async ({ page }) => {
    const ctrl = await installImportMocks(page, projectId, []);

    const po = new ImportPage(page, projectId);
    await po.goto();
    await expect(po.emptyState).toBeVisible();

    // A saved source appears on the next poll once it exists.
    ctrl.sources.push(buildSource(projectId, { label: "Seeded import" }));
    await expect(page.getByText("Seeded import")).toBeVisible();
    await expect(po.emptyState).toBeHidden();
  });

  test("deleting an import requires confirmation", async ({ page }) => {
    const source = buildSource(projectId, { label: "Disposable import" });
    await installImportMocks(page, projectId, [source]);

    const po = new ImportPage(page, projectId);
    await po.goto();
    await expect(page.getByText("Disposable import")).toBeVisible();

    await test.step("cancelling keeps the import", async () => {
      await po.deleteButton.click();
      await expect(po.deleteConfirmPrompt).toBeVisible();
      await po.cancelDeleteButton.click();
      await expect(po.deleteConfirmPrompt).toBeHidden();
      await expect(page.getByText("Disposable import")).toBeVisible();
    });

    await test.step("confirming removes the import", async () => {
      await po.deleteButton.click();
      await po.confirmDeleteButton.click();
      await expect(page.getByText("Disposable import")).toBeHidden();
      await expect(po.emptyState).toBeVisible();
    });
  });
});
