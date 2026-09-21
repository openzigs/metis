/**
 * Documentation page object for the Auto Documentation Generator (Epic #486).
 *
 * Covers:
 * - Generate Documentation modal (scope selector, submit)
 * - Document list (cards with status, timestamps)
 * - Rich Markdown Previewer (content, TOC, mermaid, math)
 * - Export buttons (PDF, Word)
 * - Version history / diff
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class DocumentationPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly generateButton: Locator;
  readonly generationSummary: Locator;
  readonly indexingSummary: Locator;
  readonly degradedBanner: Locator;

  // Generate form
  readonly generateForm: Locator;
  readonly titleInput: Locator;
  readonly scopeSelect: Locator;
  readonly submitGenerate: Locator;
  readonly cancelGenerate: Locator;

  // Document list
  readonly docsList: Locator;

  // Document detail
  readonly backButton: Locator;
  readonly exportPdfButton: Locator;
  readonly exportWordButton: Locator;
  readonly deleteButton: Locator;

  // Markdown previewer
  readonly markdownPreviewer: Locator;
  readonly markdownContent: Locator;
  readonly tocNav: Locator;

  // Version history
  readonly versionHistory: Locator;

  // Schema Graph Explorer (Epic #895)
  readonly documentTab: Locator;
  readonly graphTab: Locator;
  readonly schemaGraphPanel: Locator;
  readonly schemaGraphExplorer: Locator;
  readonly schemaSearchInput: Locator;
  readonly schemaFullscreenToggle: Locator;
  readonly schemaDetailDrawer: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { name: "Documentation" });
    this.generateButton = page.getByTestId("generate-docs-btn");
    this.generationSummary = page.getByText("Generation", { exact: true });
    this.indexingSummary = page.getByTestId("doc-indexing-summary");
    this.degradedBanner = page
      .locator('div[role="alert"]')
      .filter({
        hasText:
          /worth verifying|grounded within normal tolerance|Flagged sections contain statements/i,
      })
      .first();

    // Generate form
    this.generateForm = page.getByTestId("generate-form");
    this.titleInput = page.getByTestId("doc-title-input");
    this.scopeSelect = page.getByTestId("doc-scope-select");
    this.submitGenerate = page.getByTestId("submit-generate");
    this.cancelGenerate = page.getByRole("button", { name: "Cancel" });

    // Document list
    this.docsList = page.getByTestId("docs-list");

    // Document detail
    this.backButton = page.getByRole("button", { name: /Back/ });
    this.exportPdfButton = page.getByRole("button", { name: "Export PDF" });
    this.exportWordButton = page.getByRole("button", { name: "Export Word" });
    this.deleteButton = page.getByRole("button", { name: "Delete" });

    // Markdown previewer
    this.markdownPreviewer = page.getByTestId("markdown-previewer");
    this.markdownContent = page.getByTestId("markdown-content");
    this.tocNav = page.getByTestId("markdown-toc");

    // Version history
    this.versionHistory = page.getByTestId("version-history");

    // Schema Graph Explorer (Epic #895)
    this.documentTab = page.getByTestId("doc-tab-document");
    this.graphTab = page.getByTestId("doc-tab-graph");
    this.schemaGraphPanel = page.getByTestId("schema-graph-panel");
    this.schemaGraphExplorer = page.getByTestId("schema-graph-explorer");
    this.schemaSearchInput = page.getByTestId("schema-search-input");
    this.schemaFullscreenToggle = page.getByTestId("schema-fullscreen-toggle");
    this.schemaDetailDrawer = page.getByTestId("schema-detail-drawer");
  }

  schemaNode(tableName: string): Locator {
    return this.page.getByTestId(`schema-node-${tableName}`);
  }

  async openGraphTab(): Promise<void> {
    await this.graphTab.click();
    await expect(this.schemaGraphPanel).toBeVisible();
  }

  async goto(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/documentation`);
    await expect(this.heading).toBeVisible();
  }

  async openGenerateForm(): Promise<void> {
    await this.generateButton.click();
    await expect(this.generateForm).toBeVisible();
  }

  async generateDoc(title: string, scope: "full" | "module" | "symbol" = "full"): Promise<void> {
    await this.openGenerateForm();
    await this.titleInput.clear();
    await this.titleInput.fill(title);
    await this.scopeSelect.selectOption(scope);
    await this.submitGenerate.click();
    // Form should disappear after submission
    await expect(this.generateForm).not.toBeVisible({ timeout: 30_000 });
  }

  async selectDocument(title: string): Promise<void> {
    await this.docsList.getByText(title).click();
    await expect(this.exportPdfButton).toBeVisible({ timeout: 15_000 });
  }

  card(title: string): Locator {
    return this.docsList
      .getByTestId(/^doc-card-/)
      .filter({ has: this.page.getByRole("heading", { name: title, exact: true }) });
  }

  async openDocumentFromList(title: string): Promise<void> {
    await this.card(title).click();
    await expect(this.backButton).toBeVisible({ timeout: 15_000 });
    await expect(this.indexingSummary).toBeVisible({ timeout: 15_000 });
  }

  async goBackToList(): Promise<void> {
    await this.backButton.click();
    await expect(this.docsList).toBeVisible();
  }

  async exportPdf(): Promise<void> {
    await this.exportPdfButton.click();
  }

  async exportWord(): Promise<void> {
    await this.exportWordButton.click();
  }

  async clickTocEntry(text: string): Promise<void> {
    await this.tocNav.getByRole("link", { name: text }).click();
  }
}
