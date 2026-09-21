/**
 * Page Object for the admin usage dashboard (`/admin/usage`).
 *
 * Epic #594 / Issue #607 — Admin Usage Dashboard.
 * Uses accessible locators; raw selectors are forbidden.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class AdminUsagePage {
  readonly page: Page;
  readonly heading: Locator;

  // Controls
  readonly rangeSelect: Locator;
  readonly groupBySelect: Locator;
  readonly csvExportButton: Locator;

  // Summary tiles
  readonly totalTokensTile: Locator;
  readonly estimatedCostTile: Locator;
  readonly invocationsTile: Locator;

  // Bar chart
  readonly barChartHeading: Locator;

  // Details table
  readonly detailsTable: Locator;

  // Loading & error states
  readonly loadingText: Locator;
  readonly errorText: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { name: "Token Usage Dashboard" });

    // Controls — no data-testid on the admin page, use accessible locators.
    // The selects are native <select> elements. We locate by their current
    // visible option text or their role.
    this.rangeSelect = page.getByRole("combobox").first();
    this.groupBySelect = page.getByRole("combobox").nth(1);
    this.csvExportButton = page.getByRole("button", { name: "Export CSV" });

    // Summary tiles — identified by their label text
    this.totalTokensTile = page.getByText("Total Tokens").locator("..");
    this.estimatedCostTile = page.getByText("Estimated Cost").locator("..");
    this.invocationsTile = page.getByText("Invocations").locator("..");

    // Bar chart section
    this.barChartHeading = page.getByRole("heading", { name: /Token Usage by/ });

    // Details table
    this.detailsTable = page
      .getByRole("heading", { name: "Details" })
      .locator("..")
      .locator("table");

    // States
    this.loadingText = page.getByText("Loading usage data…");
    this.errorText = page.getByText("Error loading usage data");
  }

  async goto(): Promise<void> {
    await this.page.goto("/admin/usage", { waitUntil: "load" });
  }

  async waitForLoaded(): Promise<void> {
    await expect(this.heading).toBeVisible({ timeout: 30_000 });
    // Wait for data to load (loading text disappears)
    await expect(this.loadingText).not.toBeVisible({ timeout: 30_000 });
  }

  async selectRange(value: "7d" | "30d" | "90d"): Promise<void> {
    await this.rangeSelect.selectOption({ value });
  }

  async selectGroupBy(value: "project" | "day" | "model" | "user"): Promise<void> {
    await this.groupBySelect.selectOption({ value });
  }

  async clickCsvExport(): Promise<void> {
    await this.csvExportButton.click();
  }
}
