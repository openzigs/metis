import { expect, type Locator, type Page } from "@playwright/test";

export class QuarantinePage {
  readonly row: Locator;
  readonly retry: Locator;
  readonly retrying: Locator;
  readonly approvalError: Locator;
  readonly empty: Locator;

  constructor(
    private readonly page: Page,
    filename: string,
  ) {
    this.row = page.getByRole("listitem").filter({
      has: page.getByText(filename, { exact: true }),
    });
    this.retry = this.row.getByRole("button", { name: "Retry indexing", exact: true });
    this.retrying = this.row.getByRole("button", { name: "Retrying indexing…", exact: true });
    this.approvalError = page.getByRole("alert").filter({
      hasText: "Unable to finish approval/indexing:",
    });
    this.empty = page.getByText("Quarantine is empty.", { exact: true });
  }

  async goto(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/settings`);
    await expect(this.page.getByRole("heading", { name: "Quarantine", exact: true })).toBeVisible();
  }

  async reload(): Promise<void> {
    await this.page.reload();
  }

  async expectReconciling(error: string): Promise<void> {
    await expect(this.row).toContainText(
      "Approval saved. Index cleanup is incomplete; retry indexing to finish.",
    );
    await expect(this.row).toContainText(error);
    await expect(this.retry).toBeEnabled();
    await expect(this.row.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
    await expect(this.row.getByRole("button", { name: "Reject", exact: true })).toHaveCount(0);
    await expect(this.row.getByRole("checkbox")).toHaveCount(0);
    await expect(this.empty).toHaveCount(0);
  }
}
