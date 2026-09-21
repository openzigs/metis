/**
 * Page object for the Microsoft Teams integration settings page (epic #547):
 *   - /settings/integrations/teams
 *
 * Wraps the workspace-scoped install form, connection status, disconnect, and
 * the manifest builder. Uses the page's data-testids for stable selection.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class TeamsIntegrationPage {
  readonly page: Page;
  readonly root: Locator;
  readonly heading: Locator;
  readonly workspaceSelect: Locator;
  readonly card: Locator;
  readonly statusConnected: Locator;
  readonly statusDisconnected: Locator;
  readonly installForm: Locator;
  readonly appId: Locator;
  readonly appPassword: Locator;
  readonly appType: Locator;
  readonly tenantId: Locator;
  readonly label: Locator;
  readonly installSubmit: Locator;
  readonly installedView: Locator;
  readonly uninstall: Locator;
  readonly notice: Locator;
  readonly actionError: Locator;
  // Manifest builder
  readonly manifestBuilder: Locator;
  readonly manifestPackage: Locator;
  readonly manifestHost: Locator;
  readonly manifestBuild: Locator;
  readonly manifestEndpoint: Locator;
  readonly manifestDownload: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.getByTestId("teams-integration-page");
    this.heading = page.getByRole("heading", { name: "Microsoft Teams", exact: true });
    this.workspaceSelect = page.getByTestId("teams-workspace-select");
    this.card = page.getByTestId("teams-card");
    this.statusConnected = page.getByTestId("teams-status-connected");
    this.statusDisconnected = page.getByTestId("teams-status-disconnected");
    this.installForm = page.getByTestId("teams-install-form");
    this.appId = page.getByTestId("teams-app-id");
    this.appPassword = page.getByTestId("teams-app-password");
    this.appType = page.getByTestId("teams-app-type");
    this.tenantId = page.getByTestId("teams-tenant-id");
    this.label = page.getByTestId("teams-label");
    this.installSubmit = page.getByTestId("teams-install-submit");
    this.installedView = page.getByTestId("teams-installed-view");
    this.uninstall = page.getByTestId("teams-uninstall");
    this.notice = page.getByTestId("teams-notice");
    this.actionError = page.getByTestId("teams-action-error");
    this.manifestBuilder = page.getByTestId("teams-manifest-builder");
    this.manifestPackage = page.getByTestId("teams-manifest-package");
    this.manifestHost = page.getByTestId("teams-manifest-host");
    this.manifestBuild = page.getByTestId("teams-manifest-build");
    this.manifestEndpoint = page.getByTestId("teams-manifest-endpoint");
    this.manifestDownload = page.getByTestId("teams-manifest-download");
  }

  async goto(): Promise<void> {
    await this.page.goto("/settings/integrations/teams", { waitUntil: "load" });
  }

  async expectLoaded(): Promise<void> {
    await expect(this.root).toBeVisible({ timeout: 20_000 });
    await expect(this.heading).toBeVisible();
  }

  /** Select the workspace by its visible name in the selector. */
  async selectWorkspace(name: string): Promise<void> {
    await expect(this.workspaceSelect).toBeEnabled({ timeout: 20_000 });
    await this.workspaceSelect.selectOption({ label: name });
  }

  /** Fill + submit the install form with the given bot credentials. */
  async install(opts: { appId: string; appPassword: string; label?: string }): Promise<void> {
    await expect(this.installForm).toBeVisible({ timeout: 20_000 });
    await this.appId.fill(opts.appId);
    await this.appPassword.fill(opts.appPassword);
    if (opts.label) await this.label.fill(opts.label);
    await this.installSubmit.click();
  }

  /** Build the manifest and return the surfaced messaging endpoint value. */
  async buildManifest(opts: { packageId: string; publicHost: string }): Promise<string> {
    await this.manifestPackage.fill(opts.packageId);
    await this.manifestHost.fill(opts.publicHost);
    await this.manifestBuild.click();
    await expect(this.manifestEndpoint).toBeVisible({ timeout: 20_000 });
    return (await this.manifestEndpoint.inputValue()) ?? "";
  }

  async disconnect(): Promise<void> {
    await this.uninstall.click();
  }
}
