/**
 * Projects-list and project-detail page object for the full-flow suite.
 *
 * Encapsulates the New-project wizard (`new-project-wizard.tsx`, opened from the
 * Projects list) and the document uploader on the project detail page. Uses the
 * small set of `data-testid` hooks that ship with the UI (these are part of the
 * public test contract — see `ui/src/app/(authed)/projects/page.tsx` and
 * `document-uploader.tsx`).
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class ProjectsPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly newProjectButton: Locator;
  readonly list: Locator;
  /** #2368 — shown in New project's place to a role without `project.create`. */
  readonly createForbidden: Locator;
  /** Each card's overflow menu; its only item is Delete (`project.delete`). */
  readonly projectActions: Locator;

  // #2349 — "New project" opens the New-project wizard (name → source → create
  // → change request); the Projects list's own Create form is gone.
  readonly wizard: Locator;
  readonly nameInput: Locator;
  readonly slugInput: Locator;
  readonly nextButton: Locator;
  readonly createButton: Locator;
  readonly skipToOverviewButton: Locator;
  readonly newChangeRequestButton: Locator;

  // The wizard's repository source (Epic #640's primary repo).
  readonly repoSourceOption: Locator;
  readonly repoOwnerInput: Locator;
  readonly repoNameInput: Locator;
  readonly repoApiBaseInput: Locator;
  readonly repoValidationError: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { name: "Projects", exact: true });
    this.newProjectButton = page.getByTestId("new-project-button");
    this.list = page.getByTestId("project-list");
    this.createForbidden = page.getByText("Ask an admin or coordinator to create projects.");
    this.projectActions = page.getByRole("button", { name: "Project actions" });

    this.wizard = page.getByRole("dialog", { name: "New project" });
    this.nameInput = page.getByTestId("wizard-name-input");
    this.slugInput = page.getByTestId("wizard-slug-input");
    this.nextButton = this.wizard.getByRole("button", { name: "Next", exact: true });
    this.createButton = page.getByTestId("wizard-create");
    this.skipToOverviewButton = page.getByTestId("wizard-skip");
    this.newChangeRequestButton = page.getByTestId("wizard-new-change-request");

    this.repoSourceOption = this.wizard.getByLabel("A GitHub repository");
    this.repoOwnerInput = page.getByTestId("wizard-owner-input");
    this.repoNameInput = page.getByTestId("wizard-repo-input");
    this.repoApiBaseInput = this.wizard.getByLabel("API base URL (optional)");
    this.repoValidationError = page.getByText("Both Owner and Repository are required");
  }

  async goto(): Promise<void> {
    await this.page.goto("/projects");
    await expect(this.heading).toBeVisible();
  }

  /** Open the wizard and fill its Name step, leaving it on the Source step. */
  async startProject(name: string, slug: string): Promise<void> {
    await this.newProjectButton.click();
    await expect(this.wizard).toBeVisible();
    await this.nameInput.fill(name);
    await this.slugInput.fill(slug);
    await this.nextButton.click();
  }

  /** A documents-only project, through to the wizard's last step. */
  async createDocumentsOnlyProject(name: string, slug: string): Promise<void> {
    await this.startProject(name, slug);
    await this.nextButton.click();
    await this.createButton.click();
    await expect(this.newChangeRequestButton).toBeVisible({ timeout: 15_000 });
  }

  async createProject(name: string, slug: string): Promise<void> {
    await this.createDocumentsOnlyProject(name, slug);
    await this.skipToOverviewButton.click();
    await this.expectOnNewProjectOverview(name);
  }

  /**
   * #370 — a successful Create lands on the new project's Overview, and the
   * header breadcrumb's project switcher names the new project rather than the
   * previously active one.
   */
  async expectOnNewProjectOverview(name: string): Promise<void> {
    await this.page.waitForURL(/\/projects\/[^/]+$/, { timeout: 15_000 });
    await expect(
      this.page.getByTestId("project-overview-root").getByRole("heading", { name, exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      this.page
        .getByTestId("header-breadcrumb")
        .getByRole("button", { name: `Active project: ${name}`, exact: true }),
    ).toBeVisible({ timeout: 10_000 });
  }

  /**
   * Epic #640 — create a project with a primary repo: the wizard's "A GitHub
   * repository" source. Creating it also starts the repository's Deep Ingest
   * (#273), which fails in the background on a stack with no network; the
   * project and its link are made either way.
   */
  async createProjectWithPrimaryRepo(
    name: string,
    slug: string,
    repo: { owner: string; repoName: string; apiBaseUrl?: string },
  ): Promise<void> {
    await this.startProject(name, slug);
    await this.repoSourceOption.check();
    await expect(this.repoOwnerInput).toBeVisible();
    await this.repoOwnerInput.fill(repo.owner);
    await this.repoNameInput.fill(repo.repoName);
    if (repo.apiBaseUrl) await this.repoApiBaseInput.fill(repo.apiBaseUrl);
    await this.nextButton.click();
    await this.createButton.click();
    await this.skipToOverviewButton.click();
    await this.expectOnNewProjectOverview(name);
  }

  async openProject(slug: string): Promise<void> {
    // Create now leaves the browser on the new project (#370), so come back to
    // the list first rather than assume it is on screen.
    if (!/\/projects\/?$/.test(new URL(this.page.url()).pathname)) await this.goto();
    // The card renders the slug in BOTH an <h2> heading and a <code> badge,
    // so first() avoids a strict-mode violation.
    await this.list.getByText(slug, { exact: true }).first().click();
    await this.page.waitForURL(/\/projects\/[^/]+$/, { timeout: 10_000 });
  }

  /**
   * Open the project and walk the real tab bar to its ⚙ Settings page, where
   * the project form and the primary-repo card live (#28 moved them off the
   * landing page, which is now the pipeline Overview).
   */
  async openProjectSettings(slug: string): Promise<void> {
    await this.openProject(slug);
    await this.page
      .getByTestId("project-tabs")
      .getByRole("link", { name: "Project settings", exact: true })
      .click();
    await this.page.waitForURL(/\/projects\/[^/]+\/settings$/, { timeout: 15_000 });
  }
}

export class ProjectDetailPage {
  readonly page: Page;
  readonly dropzone: Locator;
  readonly fileInput: Locator;
  readonly uploadQueue: Locator;
  readonly documentList: Locator;
  readonly aiProviderPicker: Locator;
  readonly aiProviderSelect: Locator;
  readonly aiProviderSave: Locator;
  readonly aiModelPicker: Locator;
  readonly aiModelInput: Locator;
  readonly aiModelSave: Locator;

  // Issue #858 (Epic #852) — database-aware analysis settings card.
  readonly databaseAwareCard: Locator;
  readonly databaseAwareSelect: Locator;
  readonly databaseAwareSaveButton: Locator;
  readonly databaseAwareSavedToast: Locator;
  readonly databaseAwareResolvedState: Locator;
  readonly databaseAwareNoSchemaDataHint: Locator;
  readonly databaseAwareConnectLink: Locator;

  constructor(page: Page) {
    this.page = page;
    this.dropzone = page.getByTestId("upload-dropzone");
    this.fileInput = page.getByTestId("upload-file-input");
    this.uploadQueue = page.getByTestId("upload-queue");
    this.documentList = page.getByTestId("document-list");
    this.aiProviderPicker = page.getByTestId("ai-provider-picker");
    this.aiProviderSelect = page.getByTestId("ai-provider-select");
    this.aiProviderSave = page.getByTestId("ai-provider-save");
    this.aiModelPicker = page.getByTestId("ai-model-picker");
    this.aiModelInput = page.getByTestId("ai-model-input");
    this.aiModelSave = page.getByTestId("ai-model-save");

    this.databaseAwareCard = page.getByTestId("database-aware-analysis-settings-card");
    this.databaseAwareSelect = page.getByTestId("database-aware-analysis-select");
    this.databaseAwareSaveButton = page.getByTestId("database-aware-analysis-save-button");
    this.databaseAwareSavedToast = page.getByTestId("database-aware-analysis-saved-toast");
    this.databaseAwareResolvedState = page.getByTestId("database-aware-analysis-resolved-state");
    this.databaseAwareNoSchemaDataHint = page.getByTestId(
      "database-aware-analysis-no-schema-data-hint",
    );
    this.databaseAwareConnectLink = page.getByTestId("database-aware-analysis-connect-link");
  }

  /**
   * Walk the real project navigation from the landing page to Knowledge →
   * Documents, where the uploader lives (#28 moved it off the landing page).
   */
  async openDocumentsViaTabs(): Promise<void> {
    await this.page
      .getByTestId("project-tabs")
      .getByRole("link", { name: "Knowledge", exact: true })
      .click();
    await this.page.getByTestId("project-subnav").getByRole("link", { name: "Documents" }).click();
    await this.page.waitForURL(/\/projects\/[^/]+\/documents$/, { timeout: 15_000 });
    await expect(this.dropzone).toBeVisible({ timeout: 30_000 });
  }

  /**
   * Open the project's Knowledge → Documents page, where the uploader lives.
   * The project landing page is the pipeline Overview (#28/#29) and carries
   * no dropzone.
   */
  async gotoDocuments(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/documents`, { waitUntil: "load" });
    await expect(this.dropzone).toBeVisible({ timeout: 30_000 });
  }

  /**
   * Drive the real Library/Project UI uploader: set files on the hidden
   * input, then wait for the queue row to reach a terminal status. We do
   * NOT call the API directly — the React component fires the multipart
   * POST itself.
   */
  async uploadFiles(absolutePaths: string[]): Promise<void> {
    await expect(this.dropzone).toBeVisible();
    await this.fileInput.setInputFiles(absolutePaths);
    await expect(this.uploadQueue).toBeVisible();
    // Wait for every queued upload to settle. The component sets a status
    // chip per item: "done" on success or "error" on failure. The queue
    // list also contains a trailing "Clear list" button row, so we filter
    // to rows that own a status chip rather than counting raw <li>.
    const queueRows = this.uploadQueue.locator('li:has([data-testid^="upload-status-"])');
    await expect(queueRows).toHaveCount(absolutePaths.length, { timeout: 10_000 });
    for (let i = 0; i < absolutePaths.length; i += 1) {
      const row = queueRows.nth(i);
      await expect(
        row.locator('[data-testid="upload-status-done"], [data-testid="upload-status-error"]'),
      ).toBeVisible({ timeout: 30_000 });
    }
  }

  async expectDocumentNames(filenames: readonly string[]): Promise<void> {
    await expect(this.documentList).toBeVisible({ timeout: 15_000 });
    for (const name of filenames) {
      await expect(this.documentList.getByText(name)).toBeVisible();
    }
  }
}
