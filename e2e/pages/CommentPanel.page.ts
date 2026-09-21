/**
 * CommentPanel page object — Epic #34 (collaboration).
 *
 * Encapsulates the right-rail slide-out Sheet that lists comment threads
 * for a requirement or Spec Kit artifact and allows creating new threads.
 *
 * The component (`ui/src/components/comments/CommentPanel.tsx`) renders a
 * shadcn <Sheet side="right"> as a `role="dialog"`. Its title is supplied by
 * the caller via the `title` prop, e.g. "Comments — spec.md" on the spec-kit
 * page or "Requirement comments" on the analysis page. New comments are posted
 * through the embedded MentionInput (a <textarea>) and a "Post" button.
 * Replies/edit/delete live in the nested CommentThread component.
 *
 * Locators are accessible-first (role / placeholder / aria-label) and were
 * verified against the real mounted DOM, not assumed.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class CommentPanelPage {
  readonly page: Page;

  /** The Sheet container — present in the DOM when the panel is open. */
  readonly panel: Locator;
  /** "No comments yet." empty-state text. */
  readonly emptyState: Locator;
  /** The new-comment body textarea (the MentionInput). */
  readonly newBodyInput: Locator;
  /** "Post" submit button for the new comment. */
  readonly submitButton: Locator;
  /** Close (X) button in the panel header (aria-label="Close comments"). */
  readonly closeButton: Locator;
  /** The @mention autocomplete dropdown (role="listbox"). */
  readonly mentionListbox: Locator;

  constructor(page: Page) {
    this.page = page;
    // The Sheet renders a <div role="dialog">; the only dialog on these pages
    // when open is the comment panel (its accessible description references
    // "Comment threads").
    this.panel = page.getByRole("dialog");
    this.emptyState = this.panel.getByText("No comments yet.");
    // MentionInput renders a <textarea> with this exact placeholder.
    this.newBodyInput = this.panel.getByPlaceholder("Write a comment… Use @username to mention");
    this.submitButton = this.panel.getByRole("button", { name: "Post" });
    this.closeButton = this.panel.getByRole("button", { name: "Close comments" });
    this.mentionListbox = this.panel.getByRole("listbox", { name: "User suggestions" });
  }

  /**
   * Wait for the panel to be visible (after the triggering button opens it).
   */
  async waitForOpen(): Promise<void> {
    await expect(this.panel).toBeVisible({ timeout: 10_000 });
  }

  /**
   * Post a new top-level comment.
   */
  async postComment(body: string): Promise<void> {
    await this.newBodyInput.fill(body);
    await expect(this.submitButton).toBeEnabled();
    await this.submitButton.click();
    // Body field clears after a successful submit.
    await expect(this.newBodyInput).toHaveValue("", { timeout: 10_000 });
  }

  /**
   * Type an `@`-prefixed query into the comment box and select the first
   * autocomplete suggestion matching `username`. Mirrors the keyboard path a
   * user takes: type "@coor", wait for the dropdown, then Enter to insert.
   */
  async mentionUser(username: string, prefixLen = 4): Promise<void> {
    const prefix = username.slice(0, Math.max(1, prefixLen));
    await this.newBodyInput.click();
    // Type slowly so the React `@` trigger + debounced user search fires.
    await this.newBodyInput.pressSequentially(`@${prefix}`, { delay: 30 });
    await expect(this.mentionListbox).toBeVisible({ timeout: 10_000 });
    await expect(this.mentionOption(username)).toBeVisible();
    await this.mentionOption(username).click();
    // The inserted token should contain the full @username. Use a plain string
    // containment check (not a dynamic RegExp) to avoid any regex-injection risk.
    const insertedValue = await this.newBodyInput.inputValue();
    expect(insertedValue).toContain(`@${username}`);
  }

  /**
   * A single @mention autocomplete suggestion by username.
   */
  mentionOption(username: string): Locator {
    return this.mentionListbox.getByRole("option").filter({ hasText: `@${username}` });
  }

  /**
   * Locate a specific comment bubble by matching its body text.
   */
  commentBubble(text: string): Locator {
    return this.panel.getByText(text);
  }

  /**
   * The reply input inside an open thread (CommentThread's MentionInput).
   */
  replyInput(): Locator {
    return this.panel.getByPlaceholder("Reply… Use @username to mention");
  }

  /**
   * The "Reply" submit button inside an open thread.
   */
  replyButton(): Locator {
    return this.panel.getByRole("button", { name: "Reply" });
  }

  /**
   * Close the panel.
   */
  async close(): Promise<void> {
    await this.closeButton.click();
    await expect(this.panel).not.toBeVisible({ timeout: 5_000 });
  }
}
