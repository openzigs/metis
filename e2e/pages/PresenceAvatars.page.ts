/**
 * PresenceAvatars page object — Epic #728 / Issue #738.
 *
 * Encapsulates the presence avatar bar rendered by the PresenceAvatars
 * component in artifact headers. The container has `aria-label="N user(s)
 * viewing"` and each avatar has `aria-label="{username}"`.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class PresenceAvatarsPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * The outer presence container element.
   * Matches the `aria-label` set in PresenceAvatars.tsx.
   */
  container(): Locator {
    return this.page.locator('[aria-label$="user(s) viewing"]');
  }

  /**
   * Individual user avatar by username.
   */
  avatarFor(username: string): Locator {
    return this.page.locator(`[aria-label="${username}"]`);
  }

  /**
   * Overflow badge (+N).
   */
  overflowBadge(): Locator {
    return this.page.locator('[aria-label^="+"]');
  }

  /**
   * Assert at least one user is shown in the presence bar.
   */
  async expectPresent(timeout = 5_000): Promise<void> {
    await expect(this.container()).toBeVisible({ timeout });
  }

  /**
   * Assert a specific user appears in the presence bar.
   */
  async expectUserPresent(username: string, timeout = 5_000): Promise<void> {
    await expect(this.avatarFor(username)).toBeVisible({ timeout });
  }

  /**
   * Assert a specific user is NOT shown.
   */
  async expectUserAbsent(username: string): Promise<void> {
    await expect(this.avatarFor(username)).not.toBeVisible({ timeout: 3_000 });
  }

  /**
   * Assert the container shows exactly N visible avatars
   * (excludes the overflow badge).
   */
  async expectAvatarCount(n: number, timeout = 5_000): Promise<void> {
    // Each avatar has a deterministic aria-label equal to the username.
    // We count elements that have a two-letter text label and are inside
    // the container.
    await expect(this.container().locator("[title]")).toHaveCount(n, { timeout });
  }
}
