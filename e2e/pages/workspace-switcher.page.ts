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
    // The trigger renders the ACTIVE workspace's name, which depends on what
    // else the suite has created — match the stable test id instead.
    this.trigger = page.getByTestId("workspace-switcher");
    this.dropdown = page.getByRole("menu");
    this.workspaceLabel = page.getByText("Workspaces");
  }

  /**
   * Open the workspace switcher dropdown.
   *
   * Waits for any previous menu to finish closing first. Right after a
   * selection the old menu is still animating out: the label check below then
   * passes against it, the trigger click is swallowed as an outside-dismiss,
   * and the menu never reopens. The production UI build is fast enough to hit
   * this every time (#342).
   */
  async open(): Promise<void> {
    await expect(this.dropdown).toBeHidden();
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
    await expect(this.dropdown).toBeHidden();
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
