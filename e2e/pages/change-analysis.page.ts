/**
 * Change Analysis page object — Epic #557 (Issues #564–#569).
 *
 * Encapsulates the change analysis workflow page at
 * `/projects/:id/changes`. Uses accessible locators and test-id hooks.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class ChangeAnalysisPage {
  readonly page: Page;

  // ── Page header ────────────────────────────────────────────────────
  readonly heading: Locator;
  readonly subtitle: Locator;

  // ── Trigger form ───────────────────────────────────────────────────
  readonly triggerForm: Locator;
  readonly triggerHeading: Locator;
  readonly baseAnalysisSelect: Locator;
  readonly headAnalysisSelect: Locator;
  readonly compareButton: Locator;
  readonly triggerError: Locator;

  // ── Analysis history list ──────────────────────────────────────────
  readonly analysisHistoryHeading: Locator;
  readonly analysisList: Locator;
  readonly emptyListMessage: Locator;
  readonly loadingMessage: Locator;

  // ── Detail panel ───────────────────────────────────────────────────
  readonly detailPanel: Locator;
  readonly detailHeading: Locator;
  readonly detailPlaceholder: Locator;
  readonly changesList: Locator;
  readonly noChangesMessage: Locator;

  // ── Project navigation ─────────────────────────────────────────────
  readonly projectTabs: Locator;
  readonly requirementsTab: Locator;
  readonly changesTab: Locator;

  constructor(page: Page) {
    this.page = page;

    // Page-level
    // #2334 — titled "Compare analyses" so it is not read as a change request.
    this.heading = page.getByRole("heading", { name: "Compare analyses", exact: true });
    this.subtitle = page.getByText(
      "Compare requirements between analysis runs to detect additions, removals, and modifications.",
    );

    // Trigger form
    this.triggerForm = page.getByTestId("trigger-form");
    this.triggerHeading = page.getByRole("heading", { name: "Trigger New Analysis", exact: true });
    this.baseAnalysisSelect = page.getByTestId("base-analysis-select");
    this.headAnalysisSelect = page.getByTestId("head-analysis-select");
    this.compareButton = page.getByTestId("trigger-btn");
    this.triggerError = this.triggerForm.locator("p.text-destructive");

    // Analysis history
    this.analysisHistoryHeading = page.getByRole("heading", {
      name: "Analysis History",
      exact: true,
    });
    this.analysisList = page.getByTestId("analysis-list");
    this.emptyListMessage = page.getByText("No comparisons yet.");
    this.loadingMessage = page.getByText("Loading…");

    // Detail panel
    this.detailPanel = page.getByTestId("change-detail");
    this.detailHeading = page.getByRole("heading", { name: "Comparison details", exact: true });
    this.detailPlaceholder = page.getByText("Select a change analysis to view details");
    this.changesList = page.getByTestId("changes-list");
    this.noChangesMessage = page.getByText("No changes detected.");

    // Project navigation. Since #2334 the page is "Compare analyses" in the
    // Requirements section: the Requirements tab is in the bar, the page in the
    // section's sub-nav.
    this.projectTabs = page.getByTestId("project-tabs");
    this.requirementsTab = this.projectTabs.getByRole("link", {
      name: "Requirements",
      exact: true,
    });
    this.changesTab = page
      .getByTestId("project-subnav")
      .getByRole("link", { name: "Compare analyses", exact: true });
  }

  async goto(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/changes`);
    await expect(this.heading).toBeVisible();
  }

  // ── Analysis item helpers ──────────────────────────────────────────

  /** Get a change analysis item button by its short id prefix. */
  analysisItem(idPrefix: string): Locator {
    return this.analysisList.getByTestId(`ca-item-${idPrefix}`);
  }

  /** Click a change analysis item to load its detail. */
  async selectAnalysis(id: string): Promise<void> {
    await this.analysisList
      .locator(`[data-testid^="ca-item-"]`)
      .filter({ hasText: id.slice(0, 8) })
      .click();
    await expect(this.detailPanel).toBeVisible();
  }

  // ── Detail panel helpers ───────────────────────────────────────────

  /** Get the stat card by label text (Additions, Removals, Modifications). */
  statCard(label: string): Locator {
    return this.detailPanel.locator("div").filter({ hasText: label }).locator("div.text-2xl");
  }

  /** Get a change card by its id. */
  changeCard(changeId: string): Locator {
    return this.page.getByTestId(`change-card-${changeId}`);
  }

  /** Click the Approve button for a given change. */
  async approveChange(changeId: string): Promise<void> {
    await this.page.getByTestId(`approve-${changeId}`).click();
  }

  /** Click the Reject button for a given change. */
  async rejectChange(changeId: string): Promise<void> {
    await this.page.getByTestId(`reject-${changeId}`).click();
  }

  /** Get the status badge within a change card. */
  reviewStatusBadge(card: Locator): Locator {
    return card.locator("span").filter({ hasText: /^(pending|approved|rejected)$/ });
  }

  /** Get the severity badge within a change card. */
  severityBadge(card: Locator): Locator {
    return card.locator("span").filter({ hasText: /^(critical|high|medium|low)$/ });
  }

  /** Get the impact score text within a change card. */
  impactScore(card: Locator): Locator {
    return card.getByText(/Impact: \d+%/);
  }
}
