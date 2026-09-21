/**
 * Page object for the scan-triage detail view (Epic #708 / #719):
 *   /projects/[id]/scans/[scanId]
 *
 * Exposes the header, the triage card, and the two terminal data states:
 * the legitimate "No findings yet" empty state (for a real scan with zero
 * findings) and the graceful error surface a nonexistent scan id renders
 * (the findings query 404s → "Scan not found").
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class ScanTriagePage {
  readonly page: Page;
  readonly root: Locator;
  readonly heading: Locator;
  readonly card: Locator;
  readonly backLink: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.getByTestId("scanner-triage-root");
    this.heading = page.getByRole("heading", { name: "Scan triage" });
    this.card = page.getByTestId("scanner-triage-card");
    this.backLink = page.getByRole("link", { name: "← Back to project" });
  }

  async goto(projectId: string, scanId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/scans/${scanId}`, { waitUntil: "load" });
  }

  async expectLoaded(): Promise<void> {
    await expect(this.root).toBeVisible({ timeout: 20_000 });
    await expect(this.heading).toBeVisible();
  }

  emptyState(): Locator {
    return this.page.getByTestId("scanner-triage-empty");
  }

  /** The findings query alert text for a nonexistent scan (404 → "Scan not found"). */
  errorAlert(): Locator {
    return this.card.getByRole("alert");
  }
}
