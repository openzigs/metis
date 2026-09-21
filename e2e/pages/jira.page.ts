/**
 * Jira integration page object — Epic #556 (Issues #562 + #563).
 *
 * Encapsulates the connection management and issue viewer sections on
 * `/projects/:id/jira`. Uses accessible locators and test-id hooks.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class JiraPage {
  readonly page: Page;

  // ── Page header ────────────────────────────────────────────────────
  readonly heading: Locator;
  readonly subtitle: Locator;

  // ── Connection management section ──────────────────────────────────
  readonly connectionsHeading: Locator;
  readonly addConnectionButton: Locator;
  readonly connectionForm: Locator;
  readonly connectionList: Locator;
  readonly emptyConnectionsMessage: Locator;

  // ── Connection form fields ─────────────────────────────────────────
  readonly labelInput: Locator;
  readonly editionSelect: Locator;
  readonly baseUrlInput: Locator;
  readonly usernameInput: Locator;
  readonly tokenInput: Locator;
  readonly proxyUrlInput: Locator;
  readonly tlsCheckbox: Locator;
  readonly submitButton: Locator;
  readonly cancelButton: Locator;
  readonly formError: Locator;

  // ── Issue browser section ──────────────────────────────────────────
  readonly issueBrowserHeading: Locator;
  readonly jiraProjectSelect: Locator;
  readonly jqlFilterInput: Locator;
  readonly searchButton: Locator;
  readonly issueTable: Locator;
  readonly issueDetailPanel: Locator;
  readonly analyzeSelectedButton: Locator;
  readonly loadingIndicator: Locator;
  readonly emptySearchState: Locator;

  // ── Pagination ─────────────────────────────────────────────────────
  readonly prevPageButton: Locator;
  readonly nextPageButton: Locator;

  constructor(page: Page) {
    this.page = page;

    // Page-level
    this.heading = page.getByRole("heading", { name: "Jira Integration" });
    this.subtitle = page.getByText(
      "Connect to Jira Cloud or Data Center instances to browse and analyze issues.",
    );

    // Connection management
    this.connectionsHeading = page.getByRole("heading", { name: "Connections" });
    this.addConnectionButton = page.getByTestId("add-jira-connection");
    this.connectionForm = page.getByTestId("jira-connection-form");
    this.connectionList = page.getByTestId("jira-connection-list");
    this.emptyConnectionsMessage = page.getByText("No Jira connections yet.");

    // Form fields — use htmlFor-linked labels
    this.labelInput = page.getByLabel("Label");
    this.editionSelect = page.locator("#jira-edition");
    this.baseUrlInput = page.getByLabel("Base URL");
    this.usernameInput = page.locator("#jira-user");
    this.tokenInput = page.locator("#jira-token");
    this.proxyUrlInput = page.getByLabel("Proxy URL (optional)");
    this.tlsCheckbox = page.getByLabel("Verify TLS certificates");
    this.submitButton = page.getByRole("button", { name: /Add Connection|Update/ });
    this.cancelButton = page.getByRole("button", { name: "Cancel" });
    this.formError = page.locator("span.text-red-600");

    // Issue browser
    this.issueBrowserHeading = page.getByRole("heading", { name: "Issue Browser" });
    this.jiraProjectSelect = page.locator("#jira-project-select");
    this.jqlFilterInput = page.getByLabel("JQL Filter");
    this.searchButton = page.getByRole("button", { name: /Search|Searching/ });
    this.issueTable = page.getByTestId("jira-issue-table");
    this.issueDetailPanel = page.getByTestId("jira-issue-detail");
    this.analyzeSelectedButton = page.getByTestId("analyze-selected");
    this.loadingIndicator = page.getByText("Loading issues…");
    this.emptySearchState = page.getByText("Select a project and click Search to browse issues.");

    // Pagination
    this.prevPageButton = page.getByRole("button", { name: "← Previous" });
    this.nextPageButton = page.getByRole("button", { name: "Next →" });
  }

  async goto(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/jira`);
    await expect(this.heading).toBeVisible();
  }

  // ── Connection management helpers ──────────────────────────────────

  async openAddForm(): Promise<void> {
    await this.addConnectionButton.click();
    await expect(this.connectionForm).toBeVisible();
  }

  async fillConnectionForm(opts: {
    label: string;
    edition?: "cloud" | "datacenter";
    baseUrl: string;
    username: string;
    token: string;
    proxyUrl?: string;
    verifyTls?: boolean;
  }): Promise<void> {
    await this.labelInput.fill(opts.label);
    if (opts.edition) {
      await this.editionSelect.selectOption(opts.edition);
    }
    await this.baseUrlInput.fill(opts.baseUrl);
    await this.usernameInput.fill(opts.username);
    await this.tokenInput.fill(opts.token);
    if (opts.proxyUrl) {
      await this.proxyUrlInput.fill(opts.proxyUrl);
    }
    if (opts.verifyTls === false) {
      await this.tlsCheckbox.uncheck();
    }
  }

  async submitForm(): Promise<void> {
    await this.submitButton.click();
  }

  async cancelForm(): Promise<void> {
    await this.cancelButton.click();
  }

  /** Get a connection card by its label text. */
  connectionCard(label: string): Locator {
    return this.connectionList.locator("li").filter({ hasText: label });
  }

  /** Get the status badge text for a connection card. */
  statusBadge(card: Locator): Locator {
    return card.locator("span").filter({ hasText: /^(untested|ok|error)$/ });
  }

  /** Get the edition badge for a connection card. */
  editionBadge(card: Locator): Locator {
    return card.getByText(/^(cloud|datacenter)$/);
  }

  /** Click the Test button on a connection card. */
  async clickTest(card: Locator): Promise<void> {
    await card.getByRole("button", { name: "Test" }).click();
  }

  /** Click the Edit button on a connection card. */
  async clickEdit(card: Locator): Promise<void> {
    await card.getByRole("button", { name: "Edit" }).click();
  }

  /** Click the Delete button on a connection card. */
  async clickDelete(card: Locator): Promise<void> {
    await card.getByRole("button", { name: "Delete" }).click();
  }

  // ── Issue browser helpers ──────────────────────────────────────────

  /** Click a preset filter button by label. */
  presetFilter(label: string): Locator {
    return this.page.getByRole("button", { name: label, exact: true });
  }

  /** Get an issue row by its Jira key. */
  issueRow(key: string): Locator {
    return this.page.getByTestId(`jira-issue-row-${key}`);
  }

  /** Get the select-all checkbox in the issue table header. */
  selectAllCheckbox(): Locator {
    return this.issueTable.locator("thead input[type='checkbox']");
  }

  /** Get the checkbox in a specific issue row. */
  issueCheckbox(row: Locator): Locator {
    return row.locator("input[type='checkbox']");
  }

  /** Get the close button on the detail panel. */
  detailCloseButton(): Locator {
    return this.issueDetailPanel.getByRole("button", { name: "Close" });
  }
}
