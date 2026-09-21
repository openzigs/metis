/**
 * Page object for the inbound-importer wizard + history tab — Epic #776
 * (`/projects/:id/import`, sub-issues #783 / #784).
 *
 * Uses accessible-by-role / by-label locators only so the tests survive markup
 * churn. Network stubbing lives in `fixtures/import-helpers.ts`.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import type { ImportSourceKind } from "../fixtures/import-helpers.js";

export class ImportPage {
  readonly page: Page;
  readonly projectId: string;

  readonly heading: Locator;
  readonly newImportTitle: Locator;
  readonly sourceSelect: Locator;
  readonly labelInput: Locator;
  readonly tokenInput: Locator;
  readonly baseUrlInput: Locator;
  readonly previewButton: Locator;
  readonly importButton: Locator;
  readonly formError: Locator;
  readonly previewBox: Locator;

  readonly historyTitle: Locator;
  readonly emptyState: Locator;
  readonly loadingState: Locator;
  readonly runNowButton: Locator;
  readonly deleteButton: Locator;
  readonly confirmDeleteButton: Locator;
  readonly cancelDeleteButton: Locator;
  readonly deleteConfirmPrompt: Locator;
  readonly intervalInput: Locator;

  constructor(page: Page, projectId: string) {
    this.page = page;
    this.projectId = projectId;

    this.heading = page.getByRole("heading", { name: "Import Requirements" });
    this.newImportTitle = page.getByText("New import", { exact: true });
    this.sourceSelect = page.getByLabel("Source");
    this.labelInput = page.getByLabel("Label", { exact: true });
    this.tokenInput = page.getByLabel("API token");
    this.baseUrlInput = page.getByLabel("Base URL (optional, self-hosted)");
    this.previewButton = page.getByRole("button", { name: "Preview" });
    this.importButton = page.getByRole("button", { name: "Import", exact: true });
    this.formError = page.getByText(/failed/i);
    // The preview result list ("N matching issue(s) · showing first M").
    this.previewBox = page.getByText(/matching issue/);

    this.historyTitle = page.getByText("Import history", { exact: true });
    this.emptyState = page.getByText("No imports yet.");
    this.loadingState = page.getByText("Loading import history…");
    this.runNowButton = page.getByRole("button", { name: "Run now" });
    this.deleteButton = page.getByRole("button", { name: "Delete", exact: true });
    this.confirmDeleteButton = page.getByRole("button", { name: "Confirm" });
    this.cancelDeleteButton = page.getByRole("button", { name: "Cancel" });
    this.deleteConfirmPrompt = page.getByText("Delete this import?");
    this.intervalInput = page.getByLabel("every", { exact: true });
  }

  async goto(): Promise<void> {
    await this.page.goto(`/projects/${this.projectId}/import`);
    await expect(this.heading).toBeVisible();
  }

  /** Pick an upstream source from the native <select>. */
  async selectSource(source: ImportSourceKind): Promise<void> {
    await this.sourceSelect.selectOption(source);
  }

  /** Get a dynamic filter field input by its visible label (exact, to avoid
   * colliding with the project switcher / tabs nav which also mention
   * "Project"). */
  filterField(label: string): Locator {
    return this.page.getByLabel(label, { exact: true });
  }

  /** The ongoing-sync checkbox for a named import (unique per label). */
  syncToggle(label: string): Locator {
    return this.page.getByRole("checkbox", { name: `Ongoing sync for ${label}` });
  }

  /** The "+created/~updated" run badge text, e.g. "+5/~0". */
  runCountBadge(created: number, updated: number): Locator {
    return this.page.getByText(`+${created}/~${updated}`);
  }

  /** A history row's status line, e.g. /last run: running/. */
  lastRunStatus(status: string): Locator {
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- test-only Playwright locator; `status` is a fixed string supplied by the test, never external input.
    return this.page.getByText(new RegExp(`last run: ${status}`));
  }
}
