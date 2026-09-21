/**
 * Page Object for the Test Coverage page (Epic #856, sub-issue #865).
 *
 * Route: `/projects/:projectId/test-coverage`.
 *
 * The page object exposes only user-visible affordances; all selectors use
 * accessible roles, labels or text. Where the UI deliberately exposes a
 * `data-testid` as part of its public test contract (e.g. the visually-
 * hidden file input) we lean on `getByLabel` to keep tests semantic.
 */
import {
  expect,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
} from "@playwright/test";

export class TestCoveragePage {
  readonly page: Page;
  readonly projectId: string;

  // Header / shell
  readonly heading: Locator;
  readonly description: Locator;

  // Import section
  readonly importHeading: Locator;
  readonly uploadInput: Locator; // hidden <input type="file"> with aria-label
  readonly pasteButton: Locator;
  readonly importsEmptyState: Locator;

  // Paste dialog
  readonly pasteDialog: Locator;
  readonly pasteFormatSelect: Locator;
  readonly pasteLabelInput: Locator;
  readonly pasteTextarea: Locator;
  readonly pasteSubmit: Locator;

  // Runs section
  readonly runsHeading: Locator;
  readonly newRunButton: Locator;
  readonly runsEmptyState: Locator;
  readonly coverageSummary: Locator;
  readonly coveragePct: Locator;

  // Matrix
  readonly matrixHeading: Locator;
  readonly matrixGrid: Locator;

  // Suggestions / gaps / exports
  readonly suggestionsHeading: Locator;
  readonly suggestionRow: Locator;
  readonly lowConfidenceBadge: Locator;
  readonly exportButton: Locator;

  // Export dialog
  readonly exportDialog: Locator;
  readonly exportFormatSelect: Locator;
  readonly exportOverrideCheckbox: Locator;
  readonly exportSubmit: Locator;

  constructor(page: Page, projectId: string) {
    this.page = page;
    this.projectId = projectId;

    this.heading = page.getByRole("heading", { name: "Test Coverage", exact: true });
    this.description = page.getByText(/Import existing tests, run gap analysis/);

    this.importHeading = page.getByRole("heading", { name: "Import test cases" });
    this.uploadInput = page.getByLabel("Upload test cases");
    this.pasteButton = page.getByRole("button", { name: "Paste text" });
    this.importsEmptyState = page.getByText(/No imports yet/);

    this.pasteDialog = page.getByRole("dialog", { name: "Paste test cases" });
    this.pasteFormatSelect = this.pasteDialog.getByLabel("Paste format");
    this.pasteLabelInput = this.pasteDialog.getByLabel("Label");
    this.pasteTextarea = page.getByTestId("tc-paste-textarea");
    this.pasteSubmit = this.pasteDialog.getByRole("button", { name: /^Import|^Importing/ });

    this.runsHeading = page.getByRole("heading", { name: "Coverage runs" });
    this.newRunButton = page.getByRole("button", { name: /Start new run|Starting…/ });
    this.runsEmptyState = page.getByText(/No runs yet/);
    this.coverageSummary = page.getByTestId("tc-summary");
    this.coveragePct = page.getByTestId("tc-coverage-pct");

    this.matrixHeading = page.getByRole("heading", { name: "Coverage matrix" });
    this.matrixGrid = page.getByRole("grid");

    this.suggestionsHeading = page.getByRole("heading", { name: /Suggested tests/ });
    this.suggestionRow = page.getByTestId("tc-suggestion-row");
    this.lowConfidenceBadge = page.getByText("low confidence", { exact: true });
    this.exportButton = page.getByRole("button", { name: "Export…" });

    this.exportDialog = page.getByRole("dialog", { name: "Export coverage report" });
    this.exportFormatSelect = this.exportDialog.getByLabel("Export format");
    this.exportOverrideCheckbox = this.exportDialog.getByLabel(/Override low-confidence guard/);
    this.exportSubmit = this.exportDialog.getByRole("button", {
      name: /^Download|^Exporting/,
    });
  }

  async goto(): Promise<void> {
    await this.page.goto(`/projects/${this.projectId}/test-coverage`, { waitUntil: "load" });
    await expect(this.heading).toBeVisible();
  }

  async openPasteDialog(): Promise<void> {
    await this.pasteButton.click();
    await expect(this.pasteDialog).toBeVisible();
  }

  async pasteCsv(label: string, csv: string): Promise<void> {
    await this.openPasteDialog();
    await this.pasteFormatSelect.selectOption("csv");
    await this.pasteLabelInput.fill(label);
    await this.pasteTextarea.fill(csv);
    await this.pasteSubmit.click();
    await expect(this.pasteDialog).toBeHidden();
  }

  async uploadFile(filePath: string): Promise<void> {
    await this.uploadInput.setInputFiles(filePath);
  }

  async startNewRun(): Promise<void> {
    await this.newRunButton.click();
  }

  /**
   * Wait until the summary card (coverage %, gaps, suggestions) is visible.
   * This implicitly waits for at least one run to reach `succeeded` because
   * the report query only fires once `latestRunId` is set and the report
   * payload is non-empty.
   */
  async waitForSummary(timeoutMs = 90_000): Promise<void> {
    await expect(this.coverageSummary).toBeVisible({ timeout: timeoutMs });
    await expect(this.coveragePct).toHaveText(/%/);
  }

  async openExport(): Promise<void> {
    await this.exportButton.click();
    await expect(this.exportDialog).toBeVisible();
  }

  /**
   * Trigger an export and return the resulting download. The caller is
   * responsible for verifying the filename / payload.
   */
  async downloadExport(
    format: "excel" | "gherkin",
    options: { override?: boolean } = {},
  ): Promise<import("@playwright/test").Download> {
    await this.openExport();
    await this.exportFormatSelect.selectOption(format);
    if (options.override) {
      await this.exportOverrideCheckbox.check();
    }
    const [download] = await Promise.all([
      this.page.waitForEvent("download", { timeout: 60_000 }),
      this.exportSubmit.click(),
    ]);
    return download;
  }
}

/**
 * Summary returned by the JUnit round-trip upload (Epic #260, issue #45).
 * Mirrors the server's `JunitUploadSummary` plus the resolved `runId`.
 */
export interface JunitUploadSummary {
  runId: string;
  total: number;
  matched: number;
  updated: number;
  unmatched: string[];
  ambiguous: string[];
  byStatus: { passed: number; failed: number; skipped: number };
}

/**
 * API-level page object for the backend-only test-coverage endpoints added in
 * Epic #260 (#44 POM export, #45 JUnit round-trip). These flows have NO UI, so
 * — matching the request-context style the existing test-coverage spec uses for
 * its Mode A/B API assertions — they are exercised through an
 * {@link APIRequestContext} rather than the browser.
 */
export class TestCoverageApi {
  constructor(
    private readonly ctx: APIRequestContext,
    readonly projectId: string,
  ) {}

  /** Base path for this project's test-coverage surface. */
  private base(): string {
    return `/api/projects/${this.projectId}/test-coverage`;
  }

  /**
   * #44 — request the Playwright POM scaffold export for a run. Returns the raw
   * {@link APIResponse} so callers can assert status, headers, and body.
   */
  async exportPlaywrightPom(
    runId: string,
    options: { suggestionIds?: string[]; overrideLowConfidence?: boolean } = {},
  ): Promise<APIResponse> {
    return this.ctx.post(`${this.base()}/exports`, {
      data: {
        runId,
        target: "playwright-pom",
        ...(options.suggestionIds ? { suggestionIds: options.suggestionIds } : {}),
        ...(options.overrideLowConfidence !== undefined
          ? { overrideLowConfidence: options.overrideLowConfidence }
          : {}),
      },
    });
  }

  /**
   * #45 — upload a JUnit XML document (multipart field `file`). `runId` is
   * optional; when omitted the server attaches results to the most-recent
   * completed run. Returns the raw {@link APIResponse}.
   */
  async uploadJunit(
    xml: string | Buffer,
    options: { runId?: string; filename?: string } = {},
  ): Promise<APIResponse> {
    const buffer = typeof xml === "string" ? Buffer.from(xml, "utf8") : xml;
    return this.ctx.post(`${this.base()}/junit`, {
      multipart: {
        file: {
          name: options.filename ?? "junit.xml",
          mimeType: "application/xml",
          buffer,
        },
        ...(options.runId ? { runId: options.runId } : {}),
      },
    });
  }

  /** Convenience: upload JUnit and assert a 200 + unwrap the summary envelope. */
  async uploadJunitOk(
    xml: string | Buffer,
    options: { runId?: string; filename?: string } = {},
  ): Promise<JunitUploadSummary> {
    const res = await this.uploadJunit(xml, options);
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as { success: boolean; data: JunitUploadSummary };
    expect(body.success).toBe(true);
    return body.data;
  }
}
