/**
 * #2424 — page object for the shared scope picker (#2351,
 * `ui/src/components/scope/scope-picker.tsx`), which chat, a new impact
 * analysis and the portfolio check all render: one button, named by the page
 * ("Project scope", "Projects to analyse", "Products to check"), and a popover
 * with "This project", "Whole workspace" and the "Chosen products" list.
 * Accessible locators only: roles, names and visible text.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class ScopePickerPage {
  readonly page: Page;
  /** The picker's button; its text is the scope chosen. */
  readonly button: Locator;
  readonly popover: Locator;
  readonly thisProject: Locator;
  readonly wholeWorkspace: Locator;
  readonly chosen: Locator;

  constructor(page: Page, buttonName: string) {
    this.page = page;
    this.button = page.getByRole("button", { name: buttonName, exact: true });
    this.popover = page.getByRole("dialog", { name: "Choose what to search" });
    this.thisProject = this.popover.getByRole("button", { name: /^This project/ });
    this.wholeWorkspace = this.popover.getByRole("button", { name: /^Whole workspace/ });
    this.chosen = this.popover.getByRole("group", { name: "Chosen products" });
  }

  async open(): Promise<void> {
    await expect(this.button).toBeEnabled({ timeout: 30_000 });
    if ((await this.button.getAttribute("aria-expanded")) !== "true") await this.button.click();
    await expect(this.popover).toBeVisible();
  }

  /** Escape closes the popover and gives the focus back to the button. */
  async close(): Promise<void> {
    await this.page.keyboard.press("Escape");
    await expect(this.popover).toBeHidden();
    await expect(this.button).toBeFocused();
  }

  /** A product (chat and impact: a project) in the Chosen products list, by name. */
  item(name: string): Locator {
    return this.chosen.getByRole("checkbox", { name, exact: true });
  }

  async pickWholeWorkspace(): Promise<void> {
    await this.open();
    await expect(this.wholeWorkspace).toBeEnabled({ timeout: 30_000 });
    await this.wholeWorkspace.click();
    await expect(this.popover).toBeHidden();
  }

  /** Tick each product in turn; the popover stays open between ticks, then closes. */
  async choose(names: readonly string[]): Promise<void> {
    await this.open();
    for (const name of names) {
      await this.item(name).check();
      await expect(this.item(name)).toBeChecked();
    }
    await this.close();
  }
}
