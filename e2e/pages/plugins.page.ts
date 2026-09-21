/**
 * Plugins import/export page object — Issue #123.
 *
 * Encapsulates the PluginsManager on `/projects/:id/plugins`. Uses the card's
 * data-testid hooks (see `ui/src/components/projects/plugins-manager.tsx`).
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class PluginsPage {
  readonly page: Page;
  readonly root: Locator;
  readonly nameInput: Locator;
  readonly versionInput: Locator;
  readonly descriptionInput: Locator;
  readonly exportButton: Locator;
  readonly exportError: Locator;
  readonly importFile: Locator;
  readonly importSuccess: Locator;
  readonly importError: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.getByTestId("plugins-manager");
    this.nameInput = page.getByTestId("plugin-name");
    this.versionInput = page.getByTestId("plugin-version");
    this.descriptionInput = page.getByTestId("plugin-description");
    this.exportButton = page.getByTestId("plugin-export-button");
    this.exportError = page.getByTestId("plugin-export-error");
    this.importFile = page.getByTestId("plugin-import-file");
    this.importSuccess = page.getByTestId("plugin-import-success");
    this.importError = page.getByTestId("plugin-import-error");
  }

  async goto(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/plugins`);
    await expect(this.root).toBeVisible({ timeout: 15_000 });
  }
}
