/**
 * Page object for the requirement "Version history" tab — Epic #770 (#773/#774/#775).
 *
 * The tab (`ui/src/components/requirements/RequirementHistoryTab.tsx`) renders
 * inline under each requirement on `/projects/:id/analysis` when the per-row
 * "History" toggle is pressed. It shows a newest-first timeline of versions,
 * lets the operator select any two versions for a side-by-side diff, exposes a
 * CSV/JSON export menu, and (for coordinators/admins) per-version restore.
 *
 * Locators are accessible-by-role / by-test-id. The diff viewer is mocked away
 * in unit tests but is the real `react-diff-viewer-continued` here.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class HistoryTabPage {
  readonly page: Page;

  readonly historyToggle: Locator;
  readonly panel: Locator;
  readonly timeline: Locator;
  readonly versionButtons: Locator;
  readonly exportButton: Locator;
  readonly diff: Locator;
  readonly restoreButtons: Locator;

  constructor(page: Page) {
    this.page = page;
    // EXACT match: the per-requirement action button is labelled exactly
    // "History". A loose match would also grab the header project-switcher,
    // whose accessible name ("Active project: Version History …") contains the
    // substring "History" when the project is named after this feature.
    this.historyToggle = page.getByRole("button", { name: "History", exact: true }).first();
    this.panel = page.getByTestId("requirement-history-tab");
    this.timeline = this.panel.getByRole("list", { name: "Version timeline" });
    this.versionButtons = this.timeline.getByRole("button", { name: /Version \d+/ });
    this.exportButton = this.panel.getByRole("button", { name: /Export/ });
    this.diff = this.panel.getByTestId("version-diff");
    this.restoreButtons = this.panel.getByRole("button", { name: "Restore" });
  }

  /** Navigate to the analysis tab; the most recent run auto-selects. */
  async goto(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/analysis`);
    await expect(this.historyToggle).toBeVisible({ timeout: 30_000 });
  }

  /** Open the inline history panel (idempotent). */
  async open(): Promise<void> {
    if (!(await this.panel.isVisible().catch(() => false))) {
      await this.historyToggle.click();
    }
    await expect(this.panel).toBeVisible({ timeout: 30_000 });
  }

  /** A timeline entry button narrowed to an exact version number. */
  versionButton(version: number): Locator {
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- test-only Playwright locator; `version` is a number supplied by the test itself, never external input.
    return this.timeline.getByRole("button", { name: new RegExp(`Version ${version}\\b`) });
  }

  /**
   * Open the Export dropdown and pick a format. Caller is responsible for
   * wrapping this in a `page.waitForEvent("download")` race so the click that
   * triggers the download is observed.
   */
  async selectExport(format: "CSV" | "JSON"): Promise<void> {
    await this.exportButton.click();
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- test-only Playwright locator; `format` is a "CSV" | "JSON" literal union from the test, never external input.
    await this.page.getByRole("menuitem", { name: new RegExp(format) }).click();
  }
}
