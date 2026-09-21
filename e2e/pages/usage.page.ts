/**
 * Page Object for the project usage page (`/projects/:id/usage`).
 *
 * Epic #594 / Issue #607 — Usage Dashboard UI.
 * Uses accessible locators and data-testid hooks that ship with the UI.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class ProjectUsagePage {
  readonly page: Page;
  readonly root: Locator;
  readonly heading: Locator;
  readonly loadingIndicator: Locator;
  readonly errorAlert: Locator;
  readonly backLink: Locator;

  // Headline tiles
  readonly headlineSection: Locator;
  readonly tileWindowTokens: Locator;
  readonly tileMtdTokens: Locator;
  readonly tileWindowCost: Locator;
  readonly tileProjectedCost: Locator;

  // Budget section
  readonly budgetCard: Locator;
  readonly budgetProgressBar: Locator;
  readonly overBudgetAlert: Locator;
  readonly noBudgetCard: Locator;

  // Token budget gauge (Epic #594)
  readonly budgetGauge: Locator;

  // Enhanced usage section (Epic #594)
  readonly enhancedUsageSection: Locator;
  readonly rangeSelect: Locator;
  readonly groupBySelect: Locator;
  readonly csvExportButton: Locator;
  readonly enhancedBarChart: Locator;

  // By-day chart (SVG)
  readonly byDayChart: Locator;
  readonly byDayEmpty: Locator;

  // By-provider table
  readonly byProviderTable: Locator;
  readonly byProviderEmpty: Locator;

  // Agent step breakdown (Epic #596 / #620)
  readonly agentStepBreakdown: Locator;
  readonly agentStepChart: Locator;
  readonly agentStepEmpty: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.getByTestId("usage-root");
    this.heading = page.getByRole("heading", { name: /^Usage —/ });
    this.loadingIndicator = page.getByTestId("usage-loading");
    this.errorAlert = page.getByTestId("usage-error");
    this.backLink = page.getByTestId("usage-back-link");

    // Headline tiles
    this.headlineSection = page.getByTestId("usage-headline");
    this.tileWindowTokens = page.getByTestId("tile-window-tokens");
    this.tileMtdTokens = page.getByTestId("tile-mtd-tokens");
    this.tileWindowCost = page.getByTestId("tile-window-cost");
    this.tileProjectedCost = page.getByTestId("tile-projected-cost");

    // Budget section
    this.budgetCard = page.getByTestId("usage-budget-card");
    this.budgetProgressBar = page.getByRole("progressbar");
    this.overBudgetAlert = page.getByTestId("usage-over-budget");
    this.noBudgetCard = page.getByTestId("usage-no-budget");

    // Token budget gauge (Epic #594)
    this.budgetGauge = page.getByTestId("token-budget-gauge");

    // Enhanced usage section (Epic #594)
    this.enhancedUsageSection = page.getByTestId("enhanced-usage-section");
    this.rangeSelect = page.getByTestId("usage-range-select");
    this.groupBySelect = page.getByTestId("usage-groupby-select");
    this.csvExportButton = page.getByTestId("usage-csv-export");
    this.enhancedBarChart = page.getByTestId("enhanced-bar-chart");

    // By-day chart (SVG)
    this.byDayChart = page.getByTestId("usage-by-day-chart");
    this.byDayEmpty = page.getByTestId("usage-by-day-empty");

    // By-provider table
    this.byProviderTable = page.getByTestId("usage-by-provider-table");
    this.byProviderEmpty = page.getByTestId("usage-by-provider-empty");

    // Agent step breakdown (Epic #596 / #620)
    this.agentStepBreakdown = page.getByTestId("agent-step-breakdown");
    this.agentStepChart = page.getByTestId("agent-step-chart");
    this.agentStepEmpty = page.getByTestId("agent-step-empty");
  }

  async goto(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/usage`, { waitUntil: "load" });
  }

  async waitForLoaded(): Promise<void> {
    // Wait for either the root content or an error alert to appear
    await expect(this.root.or(this.errorAlert)).toBeVisible({ timeout: 30_000 });
  }

  async selectRange(value: "7d" | "30d" | "90d"): Promise<void> {
    await this.rangeSelect.selectOption(value);
  }

  async selectGroupBy(value: "day" | "model" | "user" | "agentStep"): Promise<void> {
    await this.groupBySelect.selectOption(value);
  }

  async clickCsvExport(): Promise<void> {
    await this.csvExportButton.click();
  }
}
