/**
 * RequirementCollab page object — Epic #34 (collaboration on the analysis page).
 *
 * Encapsulates the per-requirement collaboration controls mounted on
 * `/projects/:id/analysis` (commit 38265fb):
 *   - "Comments" toggle  → data-testid `req-comments-<reqId>` (opens CommentPanel)
 *   - AssigneePicker     → "Add assignee" button + "Search users…" input
 *   - SLABadge           → aria-label "SLA deadline: …" / "No SLA deadline"
 *   - "Edit" → RequirementEditModal whose save can yield a 409 → MergeConflictModal
 *
 * Selectors prefer the stable `data-testid`s already on the page and accessible
 * role/name locators; verified against the real mounted DOM.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class RequirementCollabPage {
  readonly page: Page;
  readonly requirementId: string;
  /** The collaboration row container for this requirement. */
  readonly collabRow: Locator;
  /** The card wrapping the whole requirement (contains the Edit button). */
  readonly card: Locator;

  constructor(page: Page, requirementId: string) {
    this.page = page;
    this.requirementId = requirementId;
    this.collabRow = page.getByTestId(`req-collab-${requirementId}`);
    // The collab row is rendered inside the requirement card; climb to the card.
    this.card = this.collabRow.locator("xpath=ancestor::div[contains(@class,'rounded')][1]");
  }

  /** Wait until this requirement's collaboration row is on screen. */
  async waitForVisible(): Promise<void> {
    await expect(this.collabRow).toBeVisible({ timeout: 30_000 });
  }

  /** The "Comments" toggle button for this requirement. */
  commentsButton(): Locator {
    return this.page.getByTestId(`req-comments-${this.requirementId}`);
  }

  /** The SLA badge (matched by its aria-label prefix). */
  slaBadge(): Locator {
    return this.collabRow.locator('[aria-label^="SLA deadline:"], [aria-label="No SLA deadline"]');
  }

  /** The "Add assignee" toggle inside the AssigneePicker. */
  addAssigneeButton(): Locator {
    return this.collabRow.getByRole("button", { name: "Add assignee" });
  }

  /** The assignee search input (appears after opening the picker). */
  assigneeSearchInput(): Locator {
    return this.collabRow.getByPlaceholder("Search users…");
  }

  /** An assignee chip showing `@username`. */
  assigneeChip(username: string): Locator {
    return this.collabRow.getByText(`@${username}`);
  }

  /**
   * Open the edit modal for this requirement (the first "Edit" button in the
   * card). The modal is a shared Dialog titled "Edit requirement".
   */
  async openEditModal(): Promise<Locator> {
    await this.card.getByRole("button", { name: "Edit" }).first().click();
    const modal = this.page.getByRole("dialog").filter({ hasText: "Edit requirement" });
    await expect(modal).toBeVisible({ timeout: 10_000 });
    return modal;
  }
}
