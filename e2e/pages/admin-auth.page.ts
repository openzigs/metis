/**
 * Admin Auth configuration page object.
 *
 * Epic #748, Issue #756: Admin UI /admin/auth configuration.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class AdminAuthPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly description: Locator;
  readonly accessDenied: Locator;
  readonly statusMessage: Locator;

  // Tab triggers
  readonly samlTab: Locator;
  readonly oidcTab: Locator;
  readonly scimTab: Locator;
  readonly mappingsTab: Locator;

  // SAML form fields
  readonly samlProviderName: Locator;
  readonly samlEntityId: Locator;
  readonly samlAcsUrl: Locator;
  readonly samlMetadataXml: Locator;
  readonly samlEnabledCheckbox: Locator;
  readonly samlSaveButton: Locator;

  // OIDC form fields
  readonly oidcProviderName: Locator;
  readonly oidcDiscoveryUrl: Locator;
  readonly oidcClientId: Locator;
  readonly oidcClientSecret: Locator;
  readonly oidcRedirectUri: Locator;
  readonly oidcEnabledCheckbox: Locator;
  readonly oidcSaveButton: Locator;

  // SCIM
  readonly scimRotateButton: Locator;
  readonly scimTokenDisplay: Locator;

  // Mappings
  readonly defaultRoleSelect: Locator;
  readonly addMappingButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { name: "Authentication Configuration" });
    this.description = page.getByText(
      "Manage SSO providers, SCIM provisioning, and role mappings.",
    );
    this.accessDenied = page.getByText("Access denied. Admin role required.");
    this.statusMessage = page.getByRole("status");

    // Tabs
    this.samlTab = page.getByRole("tab", { name: "SAML 2.0" });
    this.oidcTab = page.getByRole("tab", { name: "OIDC" });
    this.scimTab = page.getByRole("tab", { name: "SCIM" });
    this.mappingsTab = page.getByRole("tab", { name: "Role Mappings" });

    // SAML
    this.samlProviderName = page.getByLabel("Provider Name");
    this.samlEntityId = page.getByLabel("SP Entity ID");
    this.samlAcsUrl = page.getByLabel("ACS URL");
    this.samlMetadataXml = page.getByLabel("IdP Metadata XML");
    this.samlEnabledCheckbox = page.getByLabel("Enable SAML Provider");
    this.samlSaveButton = page.getByRole("button", { name: "Save SAML Configuration" });

    // OIDC
    this.oidcProviderName = page.getByLabel("Provider Name");
    this.oidcDiscoveryUrl = page.getByLabel("Discovery URL");
    this.oidcClientId = page.getByLabel("Client ID");
    this.oidcClientSecret = page.getByLabel("Client Secret");
    this.oidcRedirectUri = page.getByLabel("Redirect URI");
    this.oidcEnabledCheckbox = page.getByLabel("Enable OIDC Provider");
    this.oidcSaveButton = page.getByRole("button", { name: "Save OIDC Configuration" });

    // SCIM
    this.scimRotateButton = page.getByRole("button", { name: "Rotate SCIM Token" });
    this.scimTokenDisplay = page.getByText("New SCIM Token (shown once):");

    // Mappings
    this.defaultRoleSelect = page.getByLabel("Default Role (when no mapping matches)");
    this.addMappingButton = page.getByRole("button", { name: "+ Add Mapping" });
  }

  async goto(): Promise<void> {
    await this.page.goto("/admin/auth", { waitUntil: "load" });
  }

  async expectPageLoaded(): Promise<void> {
    await expect(this.heading).toBeVisible();
    await expect(this.description).toBeVisible();
  }

  async selectSamlTab(): Promise<void> {
    await this.samlTab.click();
  }

  async selectOidcTab(): Promise<void> {
    await this.oidcTab.click();
  }

  async selectScimTab(): Promise<void> {
    await this.scimTab.click();
  }

  async selectMappingsTab(): Promise<void> {
    await this.mappingsTab.click();
  }

  async fillSamlConfig(config: {
    name?: string;
    entityId: string;
    acsUrl: string;
    metadataXml: string;
    enabled?: boolean;
  }): Promise<void> {
    if (config.name) {
      await this.samlProviderName.clear();
      await this.samlProviderName.fill(config.name);
    }
    await this.samlEntityId.fill(config.entityId);
    await this.samlAcsUrl.fill(config.acsUrl);
    await this.samlMetadataXml.fill(config.metadataXml);
    if (config.enabled) {
      await this.samlEnabledCheckbox.check();
    }
  }

  async fillOidcConfig(config: {
    name?: string;
    discoveryUrl: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    enabled?: boolean;
  }): Promise<void> {
    if (config.name) {
      await this.oidcProviderName.clear();
      await this.oidcProviderName.fill(config.name);
    }
    await this.oidcDiscoveryUrl.fill(config.discoveryUrl);
    await this.oidcClientId.fill(config.clientId);
    await this.oidcClientSecret.fill(config.clientSecret);
    await this.oidcRedirectUri.fill(config.redirectUri);
    if (config.enabled) {
      await this.oidcEnabledCheckbox.check();
    }
  }

  /** Get a mapping row's claim value input by index (0-based). */
  getMappingClaimInput(index: number): Locator {
    return this.page.getByPlaceholder("Group claim value").nth(index);
  }

  /** Get a mapping row's remove button by index (0-based). */
  getMappingRemoveButton(index: number): Locator {
    return this.page.getByRole("button", { name: "✕" }).nth(index);
  }
}
