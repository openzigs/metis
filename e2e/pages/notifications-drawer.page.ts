/**
 * Notifications drawer page object (#416, #104, #1318).
 *
 * The bell in the app header opens a right-hand Sheet listing in-app
 * notifications; each item shows a title, a message and an "Open →" link.
 * Locators are user-facing (role / accessible name).
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class NotificationsDrawerPage {
  readonly page: Page;
  /** The header bell; its accessible name carries the unread count. */
  readonly bell: Locator;
  readonly drawer: Locator;
  /** Each notification is a list item in the drawer's list. */
  readonly items: Locator;

  constructor(page: Page) {
    this.page = page;
    this.bell = page.getByRole("button", { name: /^Notifications/ });
    this.drawer = page.getByRole("dialog", { name: "Notifications" });
    this.items = this.drawer.getByRole("listitem");
  }

  async open(): Promise<void> {
    await this.bell.click();
    await expect(this.drawer).toBeVisible();
  }

  /** The list item(s) containing `text` (its title or message). */
  item(text: string): Locator {
    return this.items.filter({ hasText: text });
  }

  /** The item's "Open →" link. */
  openLink(item: Locator): Locator {
    return item.getByRole("link", { name: /open/i });
  }
}
