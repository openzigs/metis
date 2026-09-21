/**
 * Page object for the runtime configuration UI at `/settings/api-keys`
 * (Epic #249, Phase 3 — Issue #264).
 *
 * The page renders three areas: Provider Prefs, the Runtime Configuration
 * tab (Tier-2 secrets + Tier-3 tunables + Tier-1 bootstrap rows) and the
 * Audit log tab. Tests use this POM to switch tabs and read row state
 * without coupling to the underlying React component layout. Where
 * possible we prefer role-based locators; the per-row controls fall back
 * to the deterministic `data-testid` attributes the page already exposes.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class ConfigurationPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly secretsTab: Locator;
  readonly auditTab: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { name: "Configuration", level: 1 });
    this.secretsTab = page.getByTestId("settings-tab-secrets");
    this.auditTab = page.getByTestId("settings-tab-audit");
  }

  async goto(): Promise<void> {
    await this.page.goto("/settings/api-keys", { waitUntil: "load" });
    await expect(this.heading).toBeVisible({ timeout: 30_000 });
  }

  async openConfigTab(): Promise<void> {
    await this.secretsTab.click();
  }

  async openAuditTab(): Promise<void> {
    await this.auditTab.click();
  }

  /** Resolve the source label cell for a tunable row (env | db | unset). */
  tunableSource(key: string): Locator {
    return this.page.getByTestId(`config-tunable-${key}-source`);
  }

  /** Resolve the source label cell for a secret row (env | vault | unset). */
  secretSource(key: string): Locator {
    return this.page.getByTestId(`config-secret-${key}-source`);
  }

  /** The displayed value for a bootstrap (read-only) row. */
  bootstrapValue(key: string): Locator {
    return this.page.getByTestId(`config-bootstrap-${key}-value`);
  }
}
