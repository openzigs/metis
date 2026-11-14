/**
 * Page Object — one requirement card on the change request page
 * (`/projects/:id/analysis?tab=requirements`) and its Edit dialog.
 *
 * Issue #2519 — covers the approval surfaces #2219 and #2224 added there:
 *   - the Edit dialog's warning that saving reopens an approval;
 *   - the card's "Changed since approval · awaiting re-review" link, which
 *     replaces the bare `draft` status once an approved requirement is edited.
 *
 * Locators are accessible (roles, labels, link and button names). The card is
 * scoped by its header's `data-testid`, the only stable per-requirement hook.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export const REOPENED_LABEL = "Changed since approval · awaiting re-review";

export class RequirementCardPage {
  readonly page: Page;
  readonly requirementId: string;
  /** The card's header row: title, status line and actions. */
  readonly header: Locator;
  readonly editButton: Locator;
  readonly editDialog: Locator;
  /** The dialog's "saving reopens the approval" warning (#2219). */
  readonly approvalWarning: Locator;
  readonly titleInput: Locator;
  readonly saveButton: Locator;
  /** #2224 — the status line's link to the review whose approval reopened. */
  readonly reopenedLink: Locator;

  constructor(page: Page, requirementId: string) {
    this.page = page;
    this.requirementId = requirementId;
    this.header = page.getByTestId(`requirement-card-header-${requirementId}`);
    this.editButton = this.header.getByRole("button", { name: "Edit", exact: true });
    this.editDialog = page.getByRole("dialog", { name: "Edit requirement" });
    this.approvalWarning = this.editDialog
      .getByRole("status")
      .filter({ hasText: "saving creates" });
    this.titleInput = this.editDialog.getByLabel("Title", { exact: true });
    this.saveButton = this.editDialog.getByRole("button", { name: "Save", exact: true });
    this.reopenedLink = this.header.getByRole("link", { name: REOPENED_LABEL });
  }

  /** Wait for the card to render on the Requirements tab. */
  async expectVisible(): Promise<void> {
    await expect(this.header).toBeVisible({ timeout: 30_000 });
  }

  async openEdit(): Promise<void> {
    await this.editButton.click();
    await expect(this.editDialog).toBeVisible({ timeout: 10_000 });
  }

  /** Replace the title and save, waiting for the PUT to settle and the dialog to close. */
  async saveTitle(title: string): Promise<void> {
    await this.titleInput.fill(title);
    const [res] = await Promise.all([
      this.page.waitForResponse(
        (r) =>
          r.url().endsWith(`/api/requirements/${this.requirementId}`) &&
          r.request().method() === "PUT",
        { timeout: 30_000 },
      ),
      this.saveButton.click(),
    ]);
    expect(res.ok(), `save requirement: ${res.status()}`).toBeTruthy();
    await expect(this.editDialog).toBeHidden({ timeout: 10_000 });
  }
}
