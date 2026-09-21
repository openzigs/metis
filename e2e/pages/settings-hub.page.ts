/**
 * Settings hub + nested settings layout page object (N5 #153 / N6 #154).
 *
 * - The hub (`/settings`) cards every settings sub-surface. Platform resources
 *   (Vault / Repositories / Databases) are intentionally NOT carded here — they
 *   live only in the sidebar (N5 #153).
 * - Every `/settings/*` sub-page is wrapped by a nested layout that keeps a
 *   persistent secondary nav visible (N6 #154).
 *
 * See ui/src/app/(authed)/settings/{page,layout}.tsx and ui/src/lib/settings-nav.ts.
 */
import { type Locator, type Page } from "@playwright/test";

export class SettingsHubPage {
  readonly page: Page;
  readonly hubRoot: Locator;
  /** Persistent settings secondary nav (rendered by the nested layout). */
  readonly settingsLayout: Locator;
  readonly settingsNav: Locator;

  constructor(page: Page) {
    this.page = page;
    this.hubRoot = page.getByTestId("settings-hub-root");
    this.settingsLayout = page.getByTestId("settings-layout");
    this.settingsNav = page.getByRole("navigation", { name: "Settings" });
  }

  async goto(): Promise<void> {
    await this.page.goto("/settings", { waitUntil: "load" });
  }

  hubLink(testId: string): Locator {
    return this.page.getByTestId(testId);
  }

  /** A link inside the persistent settings secondary nav. */
  navLink(name: string): Locator {
    return this.settingsNav.getByRole("link", { name, exact: true });
  }
}
