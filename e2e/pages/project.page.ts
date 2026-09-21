/**
 * Projects-list and project-detail page object for the full-flow suite.
 *
 * Encapsulates the "create project" dialog and the document uploader on the
 * project detail page. Uses the small set of `data-testid` hooks that ship
 * with the UI (these are part of the public test contract — see
 * `ui/src/app/(authed)/projects/page.tsx` and `document-uploader.tsx`).
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class ProjectsPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly newProjectButton: Locator;
  readonly nameInput: Locator;
  readonly slugInput: Locator;
  readonly submitButton: Locator;
  readonly list: Locator;

  // Primary repo section in create-project dialog (Epic #640)
  readonly toggleRepoSection: Locator;
  readonly repoOwnerInput: Locator;
  readonly repoNameInput: Locator;
  readonly repoApiBaseInput: Locator;
  readonly repoSecretInput: Locator;
  readonly repoValidationError: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { name: "Projects" });
    this.newProjectButton = page.getByTestId("new-project-button");
    this.nameInput = page.getByTestId("project-name-input");
    this.slugInput = page.getByTestId("project-slug-input");
    this.submitButton = page.getByTestId("project-create-submit");
    this.list = page.getByTestId("project-list");

    // Epic #640 — source repository fields in create-project dialog
    this.toggleRepoSection = page.getByTestId("toggle-repo-section");
    this.repoOwnerInput = page.getByTestId("repo-owner-input");
    this.repoNameInput = page.getByTestId("repo-name-input");
    this.repoApiBaseInput = page.getByTestId("repo-api-base-input");
    this.repoSecretInput = page.getByTestId("repo-secret-input");
    this.repoValidationError = page.getByText("Both Owner and Repository are required");
  }

  async goto(): Promise<void> {
    await this.page.goto("/projects");
    await expect(this.heading).toBeVisible();
  }

  async createProject(name: string, slug: string): Promise<void> {
    await this.newProjectButton.click();
    await this.nameInput.fill(name);
    await this.slugInput.fill(slug);
    await this.submitButton.click();
    // Dialog closes; project card appears in the list with the slug.
    // The card renders the slug in BOTH an <h2> heading and a <code> badge,
    // so first() avoids a strict-mode violation.
    await expect(this.list.getByText(slug, { exact: true }).first()).toBeVisible({
      timeout: 10_000,
    });
  }

  /**
   * Epic #640 — create a project with an optional primary repo. Opens the
   * "Source Repository" section and fills in the owner/repo fields.
   */
  async createProjectWithPrimaryRepo(
    name: string,
    slug: string,
    repo: { owner: string; repoName: string; apiBaseUrl?: string; secretRef?: string },
  ): Promise<void> {
    await this.newProjectButton.click();
    await this.nameInput.fill(name);
    await this.slugInput.fill(slug);
    await this.toggleRepoSection.click();
    await expect(this.repoOwnerInput).toBeVisible();
    await this.repoOwnerInput.fill(repo.owner);
    await this.repoNameInput.fill(repo.repoName);
    if (repo.apiBaseUrl) await this.repoApiBaseInput.fill(repo.apiBaseUrl);
    if (repo.secretRef) await this.repoSecretInput.fill(repo.secretRef);
    await this.submitButton.click();
    await expect(this.list.getByText(slug, { exact: true }).first()).toBeVisible({
      timeout: 10_000,
    });
  }

  async openProject(slug: string): Promise<void> {
    await this.list.getByText(slug, { exact: true }).first().click();
    await this.page.waitForURL(/\/projects\/[^/]+$/, { timeout: 10_000 });
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
