/**
 * Page objects for the top-level cross-project connector catalogues (Epic
 * #196 / #224):
 *   - Databases:    /databases
 *   - Repositories: /repositories
 *
 * Both share the same shape: a header, a filter card with a "Filter by
 * project" select, and a list card that renders either an aggregate table
 * or an empty state.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class DatabasesTopPage {
  readonly page: Page;
  readonly root: Locator;
  readonly heading: Locator;
  readonly controls: Locator;
  readonly projectFilter: Locator;
  readonly listCard: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.getByTestId("databases-top-root");
    this.heading = page.getByRole("heading", { name: "Databases", exact: true });
    this.controls = page.getByTestId("databases-top-controls");
    this.projectFilter = page.getByTestId("databases-top-project-filter");
    this.listCard = page.getByTestId("databases-top-list-card");
  }

  async goto(): Promise<void> {
    await this.page.goto("/databases", { waitUntil: "load" });
  }

  async expectLoaded(): Promise<void> {
    await expect(this.root).toBeVisible({ timeout: 20_000 });
    await expect(this.heading).toBeVisible();
  }

  emptyState(): Locator {
    return this.page.getByTestId("databases-top-empty");
  }

  table(): Locator {
    return this.page.getByTestId("databases-top-table");
  }
}

export class RepositoriesTopPage {
  readonly page: Page;
  readonly root: Locator;
  readonly heading: Locator;
  readonly controls: Locator;
  readonly projectFilter: Locator;
  readonly listCard: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.getByTestId("repositories-top-root");
    this.heading = page.getByRole("heading", { name: "Repositories", exact: true });
    this.controls = page.getByTestId("repositories-top-controls");
    this.projectFilter = page.getByTestId("repositories-top-project-filter");
    this.listCard = page.getByTestId("repositories-top-list-card");
  }

  async goto(): Promise<void> {
    await this.page.goto("/repositories", { waitUntil: "load" });
  }

  async expectLoaded(): Promise<void> {
    await expect(this.root).toBeVisible({ timeout: 20_000 });
    await expect(this.heading).toBeVisible();
  }

  emptyState(): Locator {
    return this.page.getByTestId("repositories-top-empty");
  }

  table(): Locator {
    return this.page.getByTestId("repositories-top-table");
  }
}
