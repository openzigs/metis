/**
 * Page Object for the Workspace Switcher component in the app header.
 *
 * Epic #759, Issue #766.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class WorkspaceSwitcherPage {
  readonly page: Page;
  readonly trigger: Locator;
  readonly dropdown: Locator;
  readonly workspaceLabel: Locator;

  constructor(page: Page) {
    this.page = page;
    // The trigger button contains the workspace name and chevron icon
    this.trigger = page.getByRole("button", { name: /Workspace|ChevronsUpDown/ });
    this.dropdown = page.getByRole("menu");
    this.workspaceLabel = page.getByText("Workspaces");
  }

  /** Open the workspace switcher dropdown. */
  async open(): Promise<void> {
    await this.trigger.click();
    await expect(this.workspaceLabel).toBeVisible();
  }

  /** Get all workspace menu items. */
  getWorkspaceItems(): Locator {
    return this.dropdown.getByRole("menuitem");
  }

  /** Get a specific workspace item by name. */
  getWorkspaceByName(name: string): Locator {
    return this.dropdown.getByRole("menuitem").filter({ hasText: name });
  }

  /** Switch to a workspace by name. */
  async switchTo(name: string): Promise<void> {
    await this.open();
    await this.getWorkspaceByName(name).click();
  }

  /** Assert the trigger shows a specific active workspace name. */
  async expectActiveWorkspace(name: string): Promise<void> {
    await expect(this.trigger).toContainText(name);
  }

  /** Assert the switcher is visible (user has multiple workspaces). */
  async expectVisible(): Promise<void> {
    await expect(this.trigger).toBeVisible();
  }

  /** Assert the switcher is hidden (user has 0 or 1 workspace). */
  async expectHidden(): Promise<void> {
    await expect(this.trigger).not.toBeVisible();
  }

  /** Assert the active indicator dot is present on a specific workspace. */
  async expectActiveIndicatorOn(name: string): Promise<void> {
    await this.open();
    const item = this.getWorkspaceByName(name);
    // Active workspace has a small dot indicator (bg-primary circle)
    await expect(item.locator("span.rounded-full")).toBeVisible();
  }
}
