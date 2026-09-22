/**
 * Page object for the Analysis page's "Start a new analysis" Card, focused on
 * the inline document-upload panel (#906), the evaluate-new-requirements panel
 * (#907) and the pre-run summary (#907) added under epic #904.
 *
 * Selectors prefer accessible roles/labels; the small set of `data-testid`
 * hooks shipped by the new components are part of the test contract and used
 * where a role/label is ambiguous (e.g. status badges, char counter).
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class AnalysisPage {
  readonly page: Page;

  // ── Add documents panel (#906) ─────────────────────────────────────────
  readonly addDocsPanel: Locator;
  readonly addDocsToggle: Locator;
  readonly addDocsControls: Locator;
  readonly addDocsWarning: Locator;
  readonly urlInput: Locator;
  readonly urlSubmit: Locator;
  readonly urlError: Locator;

  // Reused ingest primitives surfaced inside the panel.
  readonly fileInput: Locator;
  readonly uploadStatusDone: Locator;
  readonly textIngestFilename: Locator;
  readonly textIngestContent: Locator;
  readonly textIngestSubmit: Locator;

  // ── Evaluate requirements panel (#907) ─────────────────────────────────
  readonly reqPanel: Locator;
  readonly reqToggle: Locator;
  readonly reqTextarea: Locator;
  readonly reqCounter: Locator;

  // ── Run summary + run button (#907) ────────────────────────────────────
  readonly runSummary: Locator;
  readonly runButton: Locator;
  readonly pendingWarning: Locator;

  // ── Capability signals (#733) ──────────────────────────────────────────
  readonly capabilityHint: Locator;
  readonly capabilityBanner: Locator;

  // ── Database-aware status indicator (#859) ─────────────────────────────
  readonly databaseAwareIndicator: Locator;
  readonly databaseAwareBadge: Locator;
  readonly databaseAwareSkippedHint: Locator;
  readonly databaseAwareConnectionsLink: Locator;

  constructor(page: Page) {
    this.page = page;

    this.addDocsPanel = page.getByTestId("add-documents-panel");
    this.addDocsToggle = page.getByTestId("add-documents-toggle");
    this.addDocsControls = page.getByTestId("add-documents-controls");
    this.addDocsWarning = page.getByTestId("add-documents-warning");
    this.urlInput = page.getByTestId("add-documents-url-input");
    this.urlSubmit = page.getByTestId("add-documents-url-submit");
    this.urlError = page.getByTestId("add-documents-url-error");

    this.fileInput = this.addDocsControls.getByTestId("upload-file-input");
    this.uploadStatusDone = this.addDocsControls.getByTestId("upload-status-done");
    this.textIngestFilename = page.getByTestId("text-ingest-filename");
    this.textIngestContent = page.getByTestId("text-ingest-content");
    this.textIngestSubmit = page.getByTestId("text-ingest-submit");

    this.reqPanel = page.getByTestId("evaluate-requirements-panel");
    this.reqToggle = page.getByTestId("evaluate-requirements-toggle");
    this.reqTextarea = page.getByTestId("evaluate-requirements-textarea");
    this.reqCounter = page.getByTestId("evaluate-requirements-counter");

    this.runSummary = page.getByTestId("analysis-run-summary");
    this.runButton = page.getByRole("button", { name: "Run analysis" });
    this.pendingWarning = page.getByText("Wait for selected documents to finish ingesting.");

    this.capabilityHint = page.getByTestId("analysis-capability-hint");
    this.capabilityBanner = page.getByTestId("analysis-capability-banner");

    this.databaseAwareIndicator = page.getByTestId("analysis-database-aware-indicator");
    this.databaseAwareBadge = page.getByTestId("database-aware-badge");
    this.databaseAwareSkippedHint = page.getByTestId("database-aware-skipped-hint");
    this.databaseAwareConnectionsLink = page.getByTestId("database-aware-connections-link");
  }

  async goto(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/analysis`, { waitUntil: "load" });
    await expect(this.page.getByRole("heading", { name: /^Requirements Analysis —/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(this.addDocsPanel).toBeVisible();
  }

  /** Expand the collapsible "Add documents" panel if it is collapsed. */
  async expandAddDocuments(): Promise<void> {
    if ((await this.addDocsToggle.getAttribute("aria-expanded")) !== "true") {
      await this.addDocsToggle.click();
    }
    await expect(this.addDocsControls).toBeVisible();
  }

  /** Expand the collapsible "Evaluate new requirements" panel if collapsed. */
  async expandRequirements(): Promise<void> {
    if ((await this.reqToggle.getAttribute("aria-expanded")) !== "true") {
      await this.reqToggle.click();
    }
    await expect(this.reqTextarea).toBeVisible();
  }

  /** Ingest a document by pasting text through the inline TextIngestForm. */
  async pasteText(filename: string, content: string): Promise<void> {
    await this.textIngestFilename.fill(filename);
    await this.textIngestContent.fill(content);
    await this.textIngestSubmit.click();
  }

  /** The row (label) for a document, located by its filename text. */
  docRow(filename: string): Locator {
    return this.addDocsPanel.locator("label").filter({ hasText: filename });
  }

  /** The selection checkbox inside a document row. */
  docCheckbox(filename: string): Locator {
    return this.docRow(filename).getByRole("checkbox");
  }

  // ── Findings + requirement grounding (#912 / #920) ─────────────────────

  /**
   * The findings panel heading for a completed run. The page auto-selects the
   * most recent run and renders its findings under this heading.
   */
  get findingsHeading(): Locator {
    return this.page
      .getByTestId("findings-section")
      .getByRole("heading", { name: "Findings", exact: true });
  }

  /** A finding's title text (rendered exactly, one per seeded finding). */
  findingTitle(title: string): Locator {
    return this.page.getByText(title, { exact: true });
  }

  /**
   * The "Grounded in REQ-…" / "Gap for REQ-…" requirement badge. The seeded
   * fixture uses unique requirement ids, so the badge text alone identifies
   * the finding it belongs to without depending on DOM structure.
   */
  groundingBadge(badgeText: string): Locator {
    return this.page.getByText(badgeText, { exact: false });
  }

  /**
   * A citation list item matched by its document filename. Citations render
   * inside a `<ul>` as accessible list items, so `getByRole("listitem")`
   * targets them without relying on class names.
   */
  citation(filename: string): Locator {
    return this.page.getByRole("listitem").filter({ hasText: filename });
  }

  /** The empty-context note rendered for a requirement-gap finding. */
  get noEvidenceNote(): Locator {
    return this.page.getByText("No supporting evidence retrieved from the selected documents.");
  }
}
