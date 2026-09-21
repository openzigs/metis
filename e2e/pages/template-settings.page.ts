/**
 * Template Settings page object — Epic #595 / Issue #614.
 *
 * Encapsulates the template list, create/edit form, preview panel,
 * clone, and delete flows at `/projects/:id/settings/templates`.
 * Uses accessible locators (getByRole, getByLabel, getByText) only.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class TemplateSettingsPage {
  readonly page: Page;

  // ── List view ──────────────────────────────────────────────────────
  readonly heading: Locator;
  readonly newTemplateButton: Locator;
  readonly loadingIndicator: Locator;
  readonly emptyState: Locator;
  readonly templateCards: Locator;

  // ── Create / Edit form ─────────────────────────────────────────────
  readonly formHeadingCreate: Locator;
  readonly templateNameInput: Locator;
  readonly platformSelect: Locator;
  readonly templateTypeSelect: Locator;
  readonly addSectionButton: Locator;
  readonly saveButton: Locator;
  readonly cancelButton: Locator;

  // ── Preview panel ──────────────────────────────────────────────────
  readonly previewHeading: Locator;
  readonly githubToggle: Locator;
  readonly jiraToggle: Locator;
  readonly githubPreviewLabel: Locator;
  readonly jiraPreviewLabel: Locator;

  // ── Confirmation dialog (delete) ───────────────────────────────────
  readonly confirmDeleteButton: Locator;
  readonly cancelDeleteButton: Locator;

  constructor(page: Page) {
    this.page = page;

    // List view
    this.heading = page.getByRole("heading", { name: "Issue Templates" });
    this.newTemplateButton = page.getByRole("button", { name: /New Template/ });
    this.loadingIndicator = page.getByText("Loading templates…");
    this.emptyState = page.getByText("No templates yet");
    this.templateCards = page
      .locator('[class*="card"]')
      .filter({ has: page.getByRole("button", { name: "Edit" }) });

    // Create/Edit form
    this.formHeadingCreate = page.getByRole("heading", { name: "Create Template" });
    this.templateNameInput = page.getByLabel("Template name");
    this.platformSelect = page.getByLabel("Platform");
    this.templateTypeSelect = page.getByLabel("Template type");
    this.addSectionButton = page.getByRole("button", { name: /Add Section/ });
    this.saveButton = page.getByRole("button", { name: "Save Template" });
    this.cancelButton = page.getByRole("button", { name: "Cancel" });

    // Preview panel
    this.previewHeading = page.getByText("Preview");
    this.githubToggle = page.getByRole("button", { name: "GitHub" });
    this.jiraToggle = page.getByRole("button", { name: "Jira" });
    this.githubPreviewLabel = page.getByText("GitHub Markdown Preview");
    this.jiraPreviewLabel = page.getByText("Jira Preview");

    // Delete confirmation
    this.confirmDeleteButton = page.getByRole("button", { name: "Confirm" });
    this.cancelDeleteButton = page.getByRole("button", { name: "Cancel" });
  }

  async goto(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/settings/templates`, { waitUntil: "load" });
    // Wait for either the heading (list loaded) or loading indicator
    await expect(this.heading.or(this.loadingIndicator)).toBeVisible({ timeout: 30_000 });
    // Then wait for the heading specifically (templates loaded)
    await expect(this.heading).toBeVisible({ timeout: 30_000 });
  }

  /** Wait for template list to finish loading and return the card count. */
  async waitForTemplatesLoaded(): Promise<number> {
    // Wait for the loading indicator to disappear
    await expect(this.loadingIndicator).not.toBeVisible({ timeout: 15_000 });
    return this.templateCards.count();
  }

  /** Get a template card by its name text. */
  templateCard(name: string): Locator {
    return this.templateCards.filter({ hasText: name });
  }

  /** Get the "Default" badge on a template card. */
  defaultBadge(name: string): Locator {
    return this.templateCard(name).getByText("Default");
  }

  /** Get the platform text on a template card. */
  platformText(name: string): Locator {
    return this.templateCard(name).getByText(/Platform:/);
  }

  /** Get the type text on a template card. */
  typeText(name: string): Locator {
    return this.templateCard(name).getByText(/Type:/);
  }

  /** Click "Edit" on a specific template card. */
  async editTemplate(name: string): Promise<void> {
    await this.templateCard(name).getByRole("button", { name: "Edit" }).click();
  }

  /** Click "Clone" on a specific template card. */
  async cloneTemplate(name: string): Promise<void> {
    await this.templateCard(name).getByRole("button", { name: "Clone" }).click();
  }

  /** Click "Delete" on a specific template card (first click — shows confirm). */
  async clickDeleteTemplate(name: string): Promise<void> {
    await this.templateCard(name).getByRole("button", { name: "Delete" }).click();
  }

  /** Confirm deletion after clicking Delete. */
  async confirmDelete(): Promise<void> {
    await this.confirmDeleteButton.click();
  }

  /** Cancel deletion after clicking Delete. */
  async cancelDelete(): Promise<void> {
    // Use the Cancel button inside the confirmation row (not the form Cancel).
    await this.cancelDeleteButton.last().click();
  }

  /** Check if Delete button is present for a template card. */
  deleteButton(name: string): Locator {
    return this.templateCard(name).getByRole("button", { name: "Delete" });
  }

  // ── Create form helpers ────────────────────────────────────────────

  /** Open the create template form. */
  async openCreateForm(): Promise<void> {
    await this.newTemplateButton.click();
    await expect(this.formHeadingCreate).toBeVisible();
  }

  /** Fill in template meta fields. */
  async fillTemplateMeta(opts: {
    name: string;
    platform?: "github" | "jira" | "universal";
    templateType?: "epic" | "feature" | "story" | "bug" | "task";
  }): Promise<void> {
    await this.templateNameInput.fill(opts.name);
    if (opts.platform) {
      await this.platformSelect.selectOption(opts.platform);
    }
    if (opts.templateType) {
      await this.templateTypeSelect.selectOption(opts.templateType);
    }
  }

  /** Save the current form. */
  async save(): Promise<void> {
    await this.saveButton.click();
  }

  /** Cancel the current form and return to list view. */
  async cancelForm(): Promise<void> {
    await this.cancelButton.click();
    await expect(this.heading).toBeVisible();
  }

  // ── Section editor helpers ─────────────────────────────────────────

  /** Get all section editors currently displayed. */
  get sectionEditors(): Locator {
    return this.page.getByLabel("Section key").locator("..").locator("..").locator("..");
  }

  /** Get a section's label input by index. */
  sectionLabelInput(index: number): Locator {
    return this.page.getByLabel("Section label").nth(index);
  }

  /** Get a section's type select by index. */
  sectionTypeSelect(index: number): Locator {
    return this.page.getByLabel("Section type").nth(index);
  }

  /** Get a section's required checkbox by index. */
  sectionRequiredCheckbox(index: number): Locator {
    return this.page.getByLabel("Required").nth(index);
  }

  /** Get a section's placeholder input by index. */
  sectionPlaceholderInput(index: number): Locator {
    return this.page.getByLabel("Section placeholder").nth(index);
  }

  /** Remove a section by its key text. */
  async removeSection(key: string): Promise<void> {
    await this.page.getByRole("button", { name: `Remove section ${key}` }).click();
  }
}
