/**
 * Page object for the "re-synthesis withheld" notice on the Analysis page's
 * Requirements tab — Issue #780: review what a withheld re-synthesis would
 * change, then apply it (after a confirmation) or dismiss it.
 *
 * Locators are accessible-only: roles and accessible names, plus the notice's
 * `data-testid` contract from #769.
 */
import { type Locator, type Page, expect } from "@playwright/test";

export class WithheldReplacementPage {
  readonly page: Page;
  readonly notice: Locator;
  readonly reviewButton: Locator;
  readonly dismissButton: Locator;
  readonly comparison: Locator;
  readonly applyButton: Locator;
  readonly confirmDialog: Locator;
  readonly confirmApplyButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.notice = page.getByTestId("requirement-replacement-withheld");
    this.reviewButton = this.notice.getByRole("button", { name: "Review changes" });
    this.dismissButton = this.notice.getByRole("button", { name: "Dismiss changes" });
    this.comparison = this.notice.getByRole("region", {
      name: "Changes the new result would make",
    });
    this.applyButton = this.comparison.getByRole("button", { name: "Apply changes" });
    this.confirmDialog = page.getByRole("alertdialog", { name: "Apply the new requirements?" });
    this.confirmApplyButton = this.confirmDialog.getByRole("button", { name: "Apply changes" });
  }

  async goto(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/analysis?tab=requirements`, { waitUntil: "load" });
    await expect(this.page.getByRole("heading", { name: /^Requirements Analysis —/ })).toBeVisible({
      timeout: 30_000,
    });
  }

  /** A section of the comparison: "New requirements", "Changed requirements", ... */
  section(name: string): Locator {
    return this.comparison.getByRole("region", { name });
  }

  async reviewChanges(): Promise<void> {
    await this.reviewButton.click();
    await expect(this.comparison).toBeVisible();
  }

  async applyAndConfirm(): Promise<void> {
    await this.applyButton.click();
    await expect(this.confirmDialog).toBeVisible();
    await this.confirmApplyButton.click();
  }
}
