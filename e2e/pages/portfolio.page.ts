/**
 * #1629 — page objects for portfolio gap and impact analysis (epic #1608):
 * the entry page `/portfolio` (#1626) and one check, `/portfolio/:id` (#1626,
 * #1627). Accessible locators only: roles, labels and visible text.
 */
import { expect, type Download, type Locator, type Page } from "@playwright/test";

export class PortfolioEntryPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly statement: Locator;
  readonly allProducts: Locator;
  readonly submit: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", {
      name: "Portfolio coverage",
      level: 1,
      exact: true,
    });
    this.statement = page.getByLabel("Requirement statement");
    this.allProducts = page.getByRole("radio", { name: "All products I can access" });
    this.submit = page.getByRole("button", { name: "Check coverage" });
  }

  async goto(): Promise<void> {
    await this.page.goto("/portfolio");
    await expect(this.heading).toBeVisible();
  }

  /** Check `statement` across every product the user can access; returns the check's id. */
  async checkAcrossPortfolio(statement: string): Promise<string> {
    await this.statement.fill(statement);
    await expect(this.allProducts).toBeChecked();
    await Promise.all([
      this.page.waitForURL(/\/portfolio\/[^/]+$/, { timeout: 30_000 }),
      this.submit.click(),
    ]);
    const id = new URL(this.page.url()).pathname.split("/").pop();
    expect(id, "the check opens at /portfolio/:id").toBeTruthy();
    return id!;
  }
}

export class PortfolioCheckPage {
  readonly page: Page;
  readonly matrix: Locator;
  readonly impact: Locator;
  readonly exportButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.matrix = page.getByRole("table", {
      name: "Coverage of the requirement by each product in scope",
    });
    this.impact = page.getByRole("region", { name: "Impact on your products" });
    this.exportButton = page.getByRole("button", { name: "Export Markdown" });
  }

  async goto(id: string): Promise<void> {
    await this.page.goto(`/portfolio/${id}`);
  }

  /** The one-sentence answer, once the check has finished. */
  headline(text: string | RegExp): Locator {
    return this.page.getByRole("heading", { level: 2, name: text });
  }

  /** Wait for the check to finish: the matrix and the export are there once it has. */
  async waitForAnswer(answer: string | RegExp): Promise<void> {
    await expect(this.headline(answer)).toBeVisible({ timeout: 90_000 });
    await expect(this.exportButton).toBeEnabled();
  }

  /** A product's row in the coverage matrix, by its name as the reader sees it. */
  matrixRow(name: string): Locator {
    return this.matrix.getByRole("row").filter({
      has: this.page.getByRole("rowheader", { name, exact: true }),
    });
  }

  /** A product's card under "Impact on your products", by its heading. */
  impactCard(name: string): Locator {
    return this.impact.getByRole("listitem").filter({
      has: this.page.getByRole("heading", { level: 3, name, exact: true }),
    });
  }

  async exportMarkdown(): Promise<Download> {
    const [download] = await Promise.all([
      this.page.waitForEvent("download"),
      this.exportButton.click(),
    ]);
    return download;
  }
}
