/**
 * Page objects for the Settings sub-pages (Epic #196):
 *   - Profile:      /settings/profile (#220)
 *   - Integrations: /settings/integrations (#221)
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class SettingsProfilePage {
  readonly page: Page;
  readonly root: Locator;
  readonly heading: Locator;
  readonly card: Locator;
  readonly username: Locator;
  readonly displayName: Locator;
  readonly email: Locator;
  readonly role: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.getByTestId("settings-profile-root");
    this.heading = page.getByRole("heading", { name: "Profile", exact: true });
    this.card = page.getByTestId("settings-profile-card");
    this.username = page.getByTestId("settings-profile-username");
    this.displayName = page.getByTestId("settings-profile-display-name");
    this.email = page.getByTestId("settings-profile-email");
    this.role = page.getByTestId("settings-profile-role");
  }

  async goto(): Promise<void> {
    await this.page.goto("/settings/profile", { waitUntil: "load" });
  }

  async expectLoaded(): Promise<void> {
    await expect(this.root).toBeVisible({ timeout: 20_000 });
    await expect(this.heading).toBeVisible();
  }
}

export class SettingsIntegrationsPage {
  readonly page: Page;
  readonly root: Locator;
  readonly heading: Locator;
  readonly grid: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.getByTestId("settings-integrations-root");
    this.heading = page.getByRole("heading", { name: "Integrations", exact: true });
    this.grid = page.getByTestId("settings-integrations-grid");
  }

  async goto(): Promise<void> {
    await this.page.goto("/settings/integrations", { waitUntil: "load" });
  }

  async expectLoaded(): Promise<void> {
    await expect(this.root).toBeVisible({ timeout: 20_000 });
    await expect(this.heading).toBeVisible();
  }

  link(testId: string): Locator {
    return this.page.getByTestId(testId);
  }
}
