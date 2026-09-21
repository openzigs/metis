/**
 * Token Breakdown page object for Epic #511 e2e suite.
 *
 * Encapsulates selectors for the TokenBreakdownChart component and the
 * project usage section. Uses accessible locators (aria-label, role, text)
 * so internal markup changes don't break tests.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class TokenBreakdownSection {
  readonly page: Page;
  readonly heading: Locator;
  readonly donutChart: Locator;
  readonly stackedBar: Locator;
  readonly totalTokensDisplay: Locator;
  readonly loadingIndicator: Locator;
  readonly errorMessage: Locator;
  readonly suggestionsBox: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { name: "Token Usage by Category" });
    this.donutChart = page.locator('svg[aria-label="Token category donut chart"]');
    this.stackedBar = page.locator('[role="img"][aria-label="Token category stacked bar"]');
    this.totalTokensDisplay = page.getByText("total tokens");
    this.loadingIndicator = page.getByText("Loading...");
    this.errorMessage = page.getByText("Failed to load breakdown");
    this.suggestionsBox = page.getByText("Optimization Suggestions");
  }

  /** Get the range filter buttons (24h, 7d, 30d). */
  rangeButton(range: "24h" | "7d" | "30d"): Locator {
    return this.page.getByRole("button", { name: range, exact: true });
  }

  /** Get all category legend items by their label text. */
  categoryItem(label: string): Locator {
    return this.page.getByText(label, { exact: true });
  }

  /** Click a time range filter button. */
  async selectRange(range: "24h" | "7d" | "30d"): Promise<void> {
    await this.rangeButton(range).click();
  }

  /** Assert the chart section is fully loaded with data. */
  async expectLoaded(): Promise<void> {
    await expect(this.heading).toBeVisible();
    await expect(this.donutChart).toBeVisible();
    await expect(this.stackedBar).toBeVisible();
    await expect(this.totalTokensDisplay).toBeVisible();
  }
}
