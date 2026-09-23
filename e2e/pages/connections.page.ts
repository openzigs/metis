/**
 * Connections page object for Epic #467 — Automatic DB Connector Discovery.
 *
 * Encapsulates the Suggested Connectors section and the DB connector form
 * on `/projects/:id/connections`. Uses accessible locators and test-id hooks.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class ConnectionsPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly suggestionsBadge: Locator;
  readonly suggestedSection: Locator;
  readonly suggestedCards: Locator;

  // Repo connector form fields
  readonly repoLabelInput: Locator;
  readonly repoOwnerInput: Locator;
  readonly repoNameInput: Locator;
  readonly repoApiBaseInput: Locator;
  readonly repoSecretInput: Locator;
  readonly addRepoButton: Locator;

  // DB connector form fields (use id-based locators since "Label" appears twice)
  readonly dbLabelInput: Locator;
  readonly dbDriverSelect: Locator;
  readonly dbHostInput: Locator;
  readonly dbPortInput: Locator;
  readonly dbDatabaseInput: Locator;
  // #882 — per-connector table/column allow-list inputs. These labels are
  // unique on the page, so accessible label locators are unambiguous here.
  readonly dbAllowTablesInput: Locator;
  readonly dbAllowColumnsInput: Locator;
  readonly addDbButton: Locator;

  // Primary repo elements (Epic #640)
  readonly primaryBadge: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { name: "Connections" });
    this.suggestionsBadge = page.getByText(/\d+ suggestion/);
    this.suggestedSection = page.getByRole("heading", {
      name: "Suggested Database Connectors",
    });
    // The shadcn Card renders utility classes only — there is no "Card" in the
    // class attribute to match on. Scope to the suggestions section and take
    // the grid's children, each of which owns a Configure button.
    this.suggestedCards = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Suggested Database Connectors" }) })
      .locator(":scope > div > div")
      .filter({ has: page.getByRole("button", { name: "Configure" }) });

    // Repo form inputs (use id selectors to avoid ambiguity with DB form)
    this.repoLabelInput = page.locator("#repo-label");
    this.repoOwnerInput = page.locator("#repo-owner");
    this.repoNameInput = page.locator("#repo-name");
    this.repoApiBaseInput = page.locator("#repo-base");
    this.repoSecretInput = page.locator("#repo-secret");
    this.addRepoButton = page.getByRole("button", { name: "Add repo connector" });

    // DB form inputs by their htmlFor-linked labels (using id selectors
    // since getByLabel("Label") would be ambiguous — repo form also has one)
    this.dbLabelInput = page.locator("#db-label");
    this.dbDriverSelect = page.locator("#db-driver");
    this.dbHostInput = page.locator("#db-host");
    this.dbPortInput = page.locator("#db-port");
    this.dbDatabaseInput = page.locator("#db-name");
    // #882 — allow-list editor. Labels "Allowed tables (optional)" /
    // "Allowed columns (optional)" are unique, so accessible locators are safe.
    this.dbAllowTablesInput = page.getByLabel("Allowed tables (optional)");
    this.dbAllowColumnsInput = page.getByLabel("Allowed columns (optional)");
    this.addDbButton = page.getByRole("button", { name: "Add database connector" });

    // Epic #640 — primary badge
    this.primaryBadge = page.getByTestId("primary-badge");
  }

  async goto(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/connections`);
    await expect(this.heading).toBeVisible();
  }

  /** Add a repo connector via the form. */
  async addRepoConnector(opts: {
    label: string;
    owner: string;
    repoName: string;
    apiBaseUrl?: string;
  }): Promise<void> {
    await this.repoLabelInput.fill(opts.label);
    await this.repoOwnerInput.fill(opts.owner);
    await this.repoNameInput.fill(opts.repoName);
    if (opts.apiBaseUrl) await this.repoApiBaseInput.fill(opts.apiBaseUrl);
    await this.addRepoButton.click();
    // Wait for the new connector to appear in the list (it can render in more
    // than one panel, so take the first).
    await expect(this.page.getByText(opts.label).first()).toBeVisible({ timeout: 10_000 });
  }

  /** Click "Set as primary" on a repo connector by its id. */
  async setAsPrimary(connectorId: string): Promise<void> {
    await this.page.getByTestId(`set-primary-${connectorId}`).click();
  }

  /**
   * #882 — Create a DB connector via the form, optionally with a table/column
   * allow-list. Only `label` is required by the form; host/driver/etc. are
   * unnecessary for persisting the allow-list. Resolves once the new connector
   * appears in the database connectors list.
   */
  async addDbConnector(opts: {
    label: string;
    allowTables?: string;
    allowColumns?: string;
  }): Promise<void> {
    await this.dbLabelInput.fill(opts.label);
    if (opts.allowTables !== undefined) await this.dbAllowTablesInput.fill(opts.allowTables);
    if (opts.allowColumns !== undefined) await this.dbAllowColumnsInput.fill(opts.allowColumns);
    await this.addDbButton.click();
    await expect(this.page.getByText(opts.label).first()).toBeVisible({ timeout: 10_000 });
  }

  /** Get a suggestion card by its driver type label. */
  suggestionCard(driverType: string): Locator {
    return this.suggestedCards.filter({ hasText: driverType });
  }

  /** Get the confidence badge within a suggestion card. */
  confidenceBadge(card: Locator): Locator {
    return card.getByText(/^(high|medium|low)$/);
  }

  /** Get the host:port/database info text from a card. */
  connectionInfo(card: Locator): Locator {
    return card.locator("p.font-mono");
  }

  /** Get the source file info from a card. */
  sourceFileInfo(card: Locator): Locator {
    return card.locator("p.truncate");
  }

  /** Click the Configure button on a suggestion card (opens wizard). */
  async clickConfigure(card: Locator): Promise<void> {
    await card.getByRole("button", { name: "Configure" }).click();
  }

  /** Legacy alias retained for older specs. */
  async clickConnect(card: Locator): Promise<void> {
    await this.clickConfigure(card);
  }

  /** Click the Dismiss button on a suggestion card. */
  async clickDismiss(card: Locator): Promise<void> {
    await card.getByRole("button", { name: "Dismiss" }).click();
  }

  // ── Epic #701 wizard locators ─────────────────────────────────────────
  /** The wizard dialog itself — scopes every control below to it. */
  wizardDialog(): Locator {
    return this.page.getByRole("dialog", { name: "Configure database connector" });
  }
  wizardStep(step: "review" | "configure" | "test" | "provision"): Locator {
    return this.page.getByTestId(`wizard-step-${step}`);
  }
  wizardSection(step: "review" | "configure" | "test" | "provision"): Locator {
    return this.page.getByTestId(`wizard-${step}`);
  }
  wizardNext(): Locator {
    // `exact` matters: Next.js dev mode injects an "Open Next.js Dev Tools"
    // button, which a substring match on "Next" also selects.
    return this.wizardDialog().getByRole("button", { name: "Next", exact: true });
  }
  wizardRunTest(): Locator {
    return this.wizardDialog().getByRole("button", { name: "Run test" });
  }
  wizardProvision(): Locator {
    return this.wizardDialog().getByRole("button", { name: "Provision" });
  }
  wizardPasswordInput(): Locator {
    // `exact` matters: the reveal button is labelled "Show password".
    return this.wizardDialog().getByLabel("Password", { exact: true });
  }
  wizardShowPasswordButton(): Locator {
    return this.wizardDialog().getByRole("button", { name: "Show password" });
  }
  allowCredentialScanToggle(): Locator {
    return this.page.getByTestId("allow-credential-scan-toggle");
  }
}
