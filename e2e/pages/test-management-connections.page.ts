/**
 * Page Object for the Test Management Connections page (Epic #856,
 * sub-issue #871).
 *
 * Route: `/projects/:projectId/test-coverage/connections`.
 *
 * Saved Xray / Zephyr / TestRail connections — the page surfaces the public
 * `tmc-*` testid contract because rows are dynamically keyed by id.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export type TmcKind = "xray" | "zephyr" | "testrail";

export class TestManagementConnectionsPage {
  readonly page: Page;
  readonly projectId: string;

  readonly root: Locator;
  readonly heading: Locator;
  readonly backLink: Locator;
  readonly addButton: Locator;

  // Form (visible only after clicking Add)
  readonly form: Locator;
  readonly kindSelect: Locator;
  readonly labelInput: Locator;
  readonly baseUrlInput: Locator;
  readonly clientIdInput: Locator;
  readonly clientSecretInput: Locator;
  readonly bearerTokenInput: Locator;
  readonly emailInput: Locator;
  readonly apiKeyInput: Locator;
  readonly submitButton: Locator;
  readonly cancelButton: Locator;
  readonly formError: Locator;

  // List
  readonly emptyState: Locator;

  constructor(page: Page, projectId: string) {
    this.page = page;
    this.projectId = projectId;

    this.root = page.getByTestId("tmc-page");
    this.heading = page.getByRole("heading", { name: /Test Management Connections/i });
    this.backLink = page.getByTestId("tmc-back-to-coverage");
    this.addButton = page.getByTestId("tmc-add");

    this.form = page.getByTestId("tmc-add-form");
    this.kindSelect = page.getByTestId("tmc-kind");
    this.labelInput = page.getByTestId("tmc-label");
    this.baseUrlInput = page.getByTestId("tmc-baseUrl");
    this.clientIdInput = page.getByTestId("tmc-clientId");
    this.clientSecretInput = page.getByTestId("tmc-clientSecret");
    this.bearerTokenInput = page.getByTestId("tmc-bearerToken");
    this.emailInput = page.getByTestId("tmc-email");
    this.apiKeyInput = page.getByTestId("tmc-apiKey");
    this.submitButton = page.getByTestId("tmc-submit");
    this.cancelButton = page.getByTestId("tmc-cancel");
    this.formError = page.getByTestId("tmc-form-error");

    this.emptyState = page.getByTestId("tmc-empty");
  }

  async goto(): Promise<void> {
    await this.page.goto(`/projects/${this.projectId}/test-coverage/connections`, {
      waitUntil: "load",
    });
    await expect(this.heading).toBeVisible();
  }

  async openAddForm(): Promise<void> {
    await this.addButton.click();
    await expect(this.form).toBeVisible();
  }

  async submitTestRail(opts: {
    label: string;
    baseUrl: string;
    email: string;
    apiKey: string;
  }): Promise<void> {
    await this.openAddForm();
    await this.kindSelect.selectOption("testrail");
    await this.labelInput.fill(opts.label);
    await this.baseUrlInput.fill(opts.baseUrl);
    await this.emailInput.fill(opts.email);
    await this.apiKeyInput.fill(opts.apiKey);
    await this.submitButton.click();
  }

  async submitXray(opts: {
    label: string;
    baseUrl: string;
    clientId: string;
    clientSecret: string;
  }): Promise<void> {
    await this.openAddForm();
    await this.kindSelect.selectOption("xray");
    await this.labelInput.fill(opts.label);
    await this.baseUrlInput.fill(opts.baseUrl);
    await this.clientIdInput.fill(opts.clientId);
    await this.clientSecretInput.fill(opts.clientSecret);
    await this.submitButton.click();
  }

  row(id: string): Locator {
    return this.page.getByTestId(`tmc-row-${id}`);
  }

  testButton(id: string): Locator {
    return this.page.getByTestId(`tmc-test-${id}`);
  }

  deleteButton(id: string): Locator {
    return this.page.getByTestId(`tmc-delete-${id}`);
  }

  status(id: string): Locator {
    return this.page.getByTestId(`tmc-status-${id}`);
  }

  testResult(id: string): Locator {
    return this.page.getByTestId(`tmc-test-result-${id}`);
  }
}
