/**
 * Page Object for the admin Embedding backends page (`/admin/embeddings`).
 *
 * Epic #930 — Pluggable multi-backend RAG embeddings (Issue #937 UI surface).
 * Uses accessible/role + data-testid locators; raw CSS selectors are avoided.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class AdminEmbeddingsPage {
  readonly page: Page;

  readonly heading: Locator;

  // Active backend card
  readonly activeBackendCard: Locator;
  readonly healthBadge: Locator;
  readonly activeKey: Locator;

  // Registered backends table
  readonly backendsTable: Locator;

  // Reindex panel
  readonly reindexPanel: Locator;
  readonly projectIdInput: Locator;
  readonly checkCoverageButton: Locator;
  readonly coverageReport: Locator;
  readonly needsReindexBadge: Locator;
  readonly coverageOkBadge: Locator;
  readonly reindexButton: Locator;
  readonly reindexResult: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { name: "Embedding backends" });

    this.activeBackendCard = page.getByTestId("active-backend");
    this.healthBadge = page.getByTestId("health-badge");
    this.activeKey = page.getByTestId("active-key");

    this.backendsTable = page.getByTestId("backends-table");

    this.reindexPanel = page.getByTestId("reindex-panel");
    this.projectIdInput = page.getByTestId("project-id-input");
    this.checkCoverageButton = page.getByRole("button", { name: "Check coverage" });
    this.coverageReport = page.getByTestId("coverage-report");
    this.needsReindexBadge = page.getByTestId("needs-reindex");
    this.coverageOkBadge = page.getByTestId("coverage-ok");
    this.reindexButton = page.getByTestId("reindex-button");
    this.reindexResult = page.getByTestId("reindex-result");
  }

  async goto(): Promise<void> {
    await this.page.goto("/admin/embeddings", { waitUntil: "load" });
  }

  async expectPageLoaded(): Promise<void> {
    await expect(this.heading).toBeVisible({ timeout: 30_000 });
    await expect(this.activeBackendCard).toBeVisible({ timeout: 30_000 });
  }

  /** Read the active backend key once the status query has resolved. */
  async activeBackendKey(): Promise<string> {
    await expect(this.activeKey).toBeVisible({ timeout: 30_000 });
    return (await this.activeKey.textContent())?.trim() ?? "";
  }

  /** Row in the registered-backends table for a given backend key. */
  backendRow(key: string): Locator {
    return this.backendsTable.locator("tbody tr", { hasText: key });
  }

  /**
   * Assert the active-backend card surfaces the resolved backend's
   * capabilities (model, dimension, network-egress requirement). Values come
   * from the admin status API so the assertion stays backend-agnostic — it
   * verifies the UI reflects whatever backend the deployment configured.
   */
  async expectActiveCapabilities(opts: {
    model: string;
    dimension: number;
    requiresEgress: boolean;
  }): Promise<void> {
    await expect(this.activeBackendCard.getByText("Model", { exact: true })).toBeVisible();
    await expect(this.activeBackendCard.getByText(opts.model, { exact: true })).toBeVisible();
    await expect(this.activeBackendCard.getByText("Dimension", { exact: true })).toBeVisible();
    await expect(
      this.activeBackendCard.getByText(String(opts.dimension), { exact: true }),
    ).toBeVisible();
    await expect(this.activeBackendCard.getByText("Network egress", { exact: true })).toBeVisible();
    await expect(
      this.activeBackendCard.getByText(
        opts.requiresEgress ? "Required" : "None (offline-capable)",
        { exact: true },
      ),
    ).toBeVisible();
  }

  async submitProjectId(projectId: string): Promise<void> {
    await this.projectIdInput.fill(projectId);
    await this.checkCoverageButton.click();
  }

  /** Trigger the reindex migration once a coverage report is showing. */
  async reindex(): Promise<void> {
    await this.reindexButton.click();
  }
}
