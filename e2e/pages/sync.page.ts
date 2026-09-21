/**
 * Epic #739 / Issue #746 — Sync dashboard page object.
 *
 * Encapsulates the `/projects/:id/sync` drift dashboard: paginated drift
 * table, side-by-side diff modal, resolution actions, and empty state.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class SyncPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly pendingBadge: Locator;
  readonly emptyStateCard: Locator;
  readonly emptyStateHeading: Locator;
  readonly emptyStateMessage: Locator;
  readonly driftRows: Locator;
  readonly prevButton: Locator;
  readonly nextButton: Locator;
  readonly pageIndicator: Locator;

  // Diff modal
  readonly diffModal: Locator;
  readonly diffModalTitle: Locator;
  readonly diffModalClose: Locator;
  readonly adoptExternalButton: Locator;
  readonly pushMetisButton: Locator;
  readonly markDivergentButton: Locator;
  readonly localPanel: Locator;
  readonly externalPanel: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { name: "Issue Sync" });
    this.pendingBadge = page.getByText(/\d+ pending/);
    this.emptyStateCard = page.getByText("All synced up!");
    this.emptyStateHeading = page.getByRole("heading", { name: "All synced up!" });
    this.emptyStateMessage = page.getByText("No drift detected between your published issues");

    // Drift rows — card elements that are clickable
    this.driftRows = page.locator("[class*='cursor-pointer']").filter({ hasText: "changed" });

    // Pagination
    this.prevButton = page.getByRole("button", { name: "Previous" });
    this.nextButton = page.getByRole("button", { name: "Next" });
    this.pageIndicator = page.getByText(/Page \d+ of \d+/);

    // Diff modal (fixed overlay)
    this.diffModal = page.locator("[class*='fixed inset-0']");
    this.diffModalTitle = page.getByRole("heading", { name: "Drift Details" });
    this.diffModalClose = page.getByRole("button", { name: "✕" });
    this.adoptExternalButton = page.getByRole("button", { name: "← Adopt External" });
    this.pushMetisButton = page.getByRole("button", { name: "Push METIS →" });
    this.markDivergentButton = page.getByRole("button", { name: "Mark Divergent" });
    this.localPanel = page.getByText("Local (METIS)");
    this.externalPanel = page.getByText("External");
  }

  async goto(projectId: string, requirementId?: string): Promise<void> {
    const url = requirementId
      ? `/projects/${projectId}/sync?requirementId=${requirementId}`
      : `/projects/${projectId}/sync`;
    await this.page.goto(url);
    await expect(this.heading).toBeVisible();
  }

  async clickDriftRow(index: number): Promise<void> {
    await this.driftRows.nth(index).click();
    await expect(this.diffModalTitle).toBeVisible();
  }

  async adoptExternal(): Promise<void> {
    await this.adoptExternalButton.click();
  }

  async pushMetis(): Promise<void> {
    await this.pushMetisButton.click();
  }

  async markDivergent(): Promise<void> {
    await this.markDivergentButton.click();
  }

  async closeDiffModal(): Promise<void> {
    await this.diffModalClose.click();
  }
}
