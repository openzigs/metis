/**
 * MergeConflict page object — Epic #728 / Issue #738.
 *
 * Encapsulates the <Dialog> that appears when a PUT /requirements/:id returns
 * HTTP 409 VERSION_CONFLICT. The modal shows per-field diffs between the
 * user's version and the server's version and allows resolution.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class MergeConflictPage {
  readonly page: Page;

  /** The conflict resolution dialog. */
  readonly modal: Locator;
  /** Dialog heading. */
  readonly heading: Locator;
  /** "Your version" label (appears in per-field diffs). */
  readonly yourVersionLabel: Locator;
  /** "Server version" label. */
  readonly serverVersionLabel: Locator;
  /** "Keep server version" radio / button. */
  readonly keepServerButton: Locator;
  /** "Keep my version" radio / button. */
  readonly keepClientButton: Locator;
  /** Manual merge radio. */
  readonly manualMergeButton: Locator;
  /** Final "Save resolved" / submit button. */
  readonly saveButton: Locator;
  /** Dismiss button (cancel without saving). */
  readonly dismissButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.modal = page.getByRole("dialog").filter({ hasText: "Merge Conflict" });
    this.heading = this.modal.getByRole("heading", { name: "Merge Conflict" });
    // Per-field diff labels — only rendered when at least one field differs.
    // One label pair PER conflicting field, so narrow to the first.
    this.yourVersionLabel = this.modal.getByText("Your version").first();
    this.serverVersionLabel = this.modal.getByText("Server version").first();
    // Radio options carry the full descriptive label from MergeConflictModal.tsx.
    this.keepServerButton = this.modal.getByRole("radio", {
      name: /accept server version/i,
    });
    this.keepClientButton = this.modal.getByRole("radio", {
      name: /keep my version/i,
    });
    this.manualMergeButton = this.modal.getByRole("radio", {
      name: /manual merge/i,
    });
    // Final action button reads "Resolve & Save".
    this.saveButton = this.modal.getByRole("button", { name: /resolve & save/i });
    this.dismissButton = this.modal.getByRole("button", { name: /cancel/i });
  }

  /**
   * Assert the modal is visible and showing conflict information.
   */
  async expectVisible(): Promise<void> {
    await expect(this.modal).toBeVisible({ timeout: 10_000 });
    await expect(this.heading).toBeVisible();
    await expect(this.yourVersionLabel).toBeVisible();
    await expect(this.serverVersionLabel).toBeVisible();
  }

  /**
   * Resolve by keeping the server's version.
   */
  async resolveWithServer(): Promise<void> {
    await this.keepServerButton.check();
    await this.saveButton.click();
    await expect(this.modal).not.toBeVisible({ timeout: 10_000 });
  }

  /**
   * Resolve by keeping the client's version.
   */
  async resolveWithClient(): Promise<void> {
    await this.keepClientButton.check();
    await this.saveButton.click();
    await expect(this.modal).not.toBeVisible({ timeout: 10_000 });
  }

  /**
   * Dismiss without saving.
   */
  async dismiss(): Promise<void> {
    await this.dismissButton.click();
    await expect(this.modal).not.toBeVisible({ timeout: 5_000 });
  }
}
