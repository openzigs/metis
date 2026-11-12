/**
 * #2339 — page object for the header of every `/workspaces/<id>` page
 * (`ui/src/components/workspaces/workspace-nav.tsx`): the workspace's name,
 * the way back to the project the user came from, and the section tabs.
 *
 * Accessible locators only (`e2e/README.md`): the tabs are links inside the
 * navigation named "Workspace"; the back link is named "Back to <project>".
 */
import { expect, type Locator, type Page } from "@playwright/test";

export type WorkspaceSection = "Overview" | "Traceability" | "Governing documents";

export class WorkspaceNavPage {
  readonly page: Page;
  readonly nav: Locator;

  constructor(page: Page) {
    this.page = page;
    this.nav = page.getByRole("navigation", { name: "Workspace" });
  }

  tab(section: WorkspaceSection): Locator {
    return this.nav.getByRole("link", { name: section, exact: true });
  }

  /** Open a section by its tab and wait for its page title. */
  async openSection(section: Exclude<WorkspaceSection, "Overview">): Promise<void> {
    await this.tab(section).click();
    await expect(
      this.page.getByRole("heading", { level: 1, name: section, exact: true }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(this.tab(section)).toHaveAttribute("aria-current", "page");
  }

  /** Assert the header names the workspace the user is in. */
  async expectWorkspace(name: string): Promise<void> {
    await expect(this.page.getByText(`Workspace: ${name}`)).toBeVisible();
  }

  backTo(projectName: string): Locator {
    return this.page.getByRole("link", { name: `Back to ${projectName}` });
  }
}
