/**
 * Products page objects for the Multi-Repository Product Documentation
 * feature (Epic #544 / Issues #547 + #554).
 *
 * Covers:
 * - Product list page (create, empty state, product cards)
 * - Product detail page (repos section, add/remove repos)
 * - Product documentation viewer (architecture, per-service, API contracts)
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class ProductsListPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly subheading: Locator;
  readonly newProductButton: Locator;
  readonly emptyState: Locator;
  readonly productGrid: Locator;
  readonly loadingIndicator: Locator;

  // Create product dialog
  readonly dialogTitle: Locator;
  readonly nameInput: Locator;
  readonly slugInput: Locator;
  readonly descriptionInput: Locator;
  readonly createSubmit: Locator;
  readonly createError: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { name: "Products" });
    this.subheading = page.getByText("Multi-repository product documentation");
    this.newProductButton = page.getByTestId("new-product-button");
    this.emptyState = page.getByText("No products yet");
    this.productGrid = page.locator(".grid");
    this.loadingIndicator = page.getByText("Loading…");

    // Create product dialog
    this.dialogTitle = page.getByRole("heading", { name: "Create product" });
    this.nameInput = page.getByLabel("Name");
    this.slugInput = page.getByLabel("Slug");
    this.descriptionInput = page.getByLabel("Description");
    this.createSubmit = page.getByRole("button", { name: "Create" });
    this.createError = page.locator(".text-destructive");
  }

  async goto(): Promise<void> {
    await this.page.goto("/products");
    await expect(this.heading).toBeVisible();
  }

  async openCreateDialog(): Promise<void> {
    await this.newProductButton.click();
    await expect(this.dialogTitle).toBeVisible();
  }

  async fillCreateForm(opts: { name: string; slug: string; description?: string }): Promise<void> {
    await this.nameInput.fill(opts.name);
    await this.slugInput.fill(opts.slug);
    if (opts.description) {
      await this.descriptionInput.fill(opts.description);
    }
  }

  async submitCreate(): Promise<void> {
    await this.createSubmit.click();
  }

  async createProduct(opts: { name: string; slug: string; description?: string }): Promise<void> {
    await this.openCreateDialog();
    await this.fillCreateForm(opts);
    await this.submitCreate();
    // Dialog should close after success
    await expect(this.dialogTitle).not.toBeVisible({ timeout: 10_000 });
  }

  getProductCard(name: string): Locator {
    return this.page.locator("a").filter({ hasText: name });
  }

  async openProduct(name: string): Promise<void> {
    await this.getProductCard(name).click();
    await this.page.waitForURL(/\/products\/[^/]+$/, { timeout: 10_000 });
  }
}

export class ProductDetailPage {
  readonly page: Page;
  readonly productName: Locator;
  readonly productDescription: Locator;
  readonly backButton: Locator;

  // Repos section
  readonly reposHeading: Locator;
  readonly addRepoButton: Locator;
  readonly repoEmptyState: Locator;

  // Add repo dialog
  readonly addRepoDialogTitle: Locator;
  readonly repoConnectionInput: Locator;
  readonly repoRoleSelect: Locator;
  readonly addRepoSubmit: Locator;
  readonly addRepoError: Locator;

  // Documentation section
  readonly docsHeading: Locator;
  readonly docsEmptyState: Locator;

  constructor(page: Page) {
    this.page = page;
    this.productName = page.getByRole("heading", { level: 1 });
    this.productDescription = page.locator("p.text-muted-foreground").first();
    this.backButton = page.getByRole("link", { name: "" }).locator("button");

    // Repos section
    this.reposHeading = page.getByRole("heading", { name: "Repositories" });
    this.addRepoButton = page.getByTestId("add-repo-button");
    this.repoEmptyState = page.getByText("No repositories associated yet");

    // Add repo dialog
    this.addRepoDialogTitle = page.getByRole("heading", {
      name: "Add repository to product",
    });
    this.repoConnectionInput = page.getByLabel("Repository Connection ID");
    this.repoRoleSelect = page.getByLabel("Role");
    this.addRepoSubmit = page.getByRole("button", { name: "Add Repository" });
    this.addRepoError = page.locator(".text-destructive");

    // Documentation section
    this.docsHeading = page.getByRole("heading", { name: "Documentation" });
    this.docsEmptyState = page.getByText("Generated documentation will appear here");
  }

  async openAddRepoDialog(): Promise<void> {
    await this.addRepoButton.click();
    await expect(this.addRepoDialogTitle).toBeVisible();
  }

  async fillRepoForm(connectionId: string, role?: string): Promise<void> {
    await this.repoConnectionInput.fill(connectionId);
    if (role) {
      await this.repoRoleSelect.selectOption(role);
    }
  }

  async submitAddRepo(): Promise<void> {
    await this.addRepoSubmit.click();
  }

  async addRepo(connectionId: string, role?: string): Promise<void> {
    await this.openAddRepoDialog();
    await this.fillRepoForm(connectionId, role);
    await this.submitAddRepo();
    // Dialog should close after success
    await expect(this.addRepoDialogTitle).not.toBeVisible({ timeout: 10_000 });
  }

  getRepoCard(name: string): Locator {
    return this.page.locator('[class*="Card"]').filter({ hasText: name });
  }

  getRemoveRepoButton(repoCard: Locator): Locator {
    return repoCard.getByRole("button");
  }

  async removeRepo(repoName: string): Promise<void> {
    const card = this.getRepoCard(repoName);
    await this.getRemoveRepoButton(card).click();
  }
}
