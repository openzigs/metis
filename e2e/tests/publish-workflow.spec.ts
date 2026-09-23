/**
 * Coverage — Publishing tab at `/projects/[id]/publish` (Phase 9).
 *
 * Verifies the page renders its three working surfaces against a freshly
 * created project:
 *   1. "Generate drafts from analysis" form (analysis id + owner/repo inputs).
 *   2. "New publish batch" controls including the dry-run toggle and the
 *      dry-run-aware primary button.
 *   3. "Recent batches" table (empty state for a new project).
 *
 * Also asserts the page never issues a `/api/api/` double-prefixed request.
 *
 * Locators: accessible roles/labels first (form labels via getByLabel,
 * headings via getByRole) with the page's data-testids as the stable fallback
 * for the dry-run/batch controls.
 *
 * Acceptance criteria:
 *   AC: the Generate-drafts form renders with Analysis ID / owner / repo inputs.
 *   AC: the dry-run batch controls render; the primary button reflects dry-run.
 *   AC: the Recent batches table renders (empty state for a new project).
 */
import { test, expect } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { createProjectViaApi } from "../fixtures/project-helpers.js";
import { LoginPage } from "../pages/login.page.js";
import { watchForDoubleApiPrefix } from "../fixtures/no-double-api-prefix.js";

const API_BASE = apiBase();

test.describe("Publishing tab (#publishing) — generate / batch / recent", () => {
  test.describe.configure({ timeout: 120_000 });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const { accessToken } = await primeAdminUser(API_BASE);
    const project = await createProjectViaApi(API_BASE, accessToken, "e2e-publish");
    projectId = project.id;

    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  test("renders generate-drafts form, dry-run batch controls and recent batches", async ({
    page,
  }) => {
    const guard = watchForDoubleApiPrefix(page);

    await page.goto(`/projects/${projectId}/publish`, { waitUntil: "load" });

    await test.step("Publishing header renders", async () => {
      await expect(page.getByRole("heading", { name: "Publishing" })).toBeVisible();
    });

    await test.step("Generate-drafts form exposes its inputs", async () => {
      await expect(
        page.getByRole("heading", { name: "Generate drafts from analysis" }),
      ).toBeVisible();
      // The opaque "Analysis ID" text box became a picker over the project's
      // own analyses; the label is now just "Analysis".
      await expect(page.getByLabel("Analysis")).toBeVisible();
      await expect(page.getByLabel("Target owner")).toBeVisible();
      await expect(page.getByLabel("Target repo")).toBeVisible();
      // Generate is gated off until all three fields are present.
      await expect(page.getByRole("button", { name: "Generate" })).toBeDisabled();
    });

    await test.step("New publish batch dry-run controls render", async () => {
      await expect(page.getByRole("heading", { name: "New publish batch" })).toBeVisible();
      const dryRun = page.getByLabel("Dry run (no GitHub writes)");
      await expect(dryRun).toBeVisible();
      // Defaults to dry-run, so the primary CTA reads "Run dry-run".
      await expect(dryRun).toBeChecked();
      await expect(page.getByRole("button", { name: "Run dry-run" })).toBeVisible();
      // Optional batch metadata toggles are present.
      await expect(page.getByTestId("copilot-workspace-toggle")).toBeVisible();
      await expect(page.getByTestId("projects-v2-toggle")).toBeVisible();
    });

    await test.step("toggling dry-run off flips the primary CTA label", async () => {
      await page.getByLabel("Dry run (no GitHub writes)").uncheck();
      await expect(page.getByRole("button", { name: "Publish now" })).toBeVisible();
    });

    await test.step("Recent batches table renders with the empty state", async () => {
      await expect(page.getByRole("heading", { name: "Recent batches" })).toBeVisible();
      await expect(page.getByText("No batches yet.", { exact: true })).toBeVisible();
    });

    guard.assertClean();
  });
});
