/**
 * Model Selection page object — Epic #593 (Issues #600, #602).
 *
 * Encapsulates the ModelRecommendation component rendered on the analysis
 * config page (`/projects/:id/analysis`). Uses accessible locators only.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class ModelSelectionPanel {
  readonly page: Page;

  // ── Panel root ─────────────────────────────────────────────────────
  readonly panelHeading: Locator;
  readonly overrideSelect: Locator;

  // ── Model info ─────────────────────────────────────────────────────
  readonly modelName: Locator;
  readonly budgetDowngradedBadge: Locator;

  // ── Reasoning & cost badges ────────────────────────────────────────
  readonly reasoningBadge: Locator;
  readonly tokenBadge: Locator;
  readonly costBadge: Locator;

  // ── Rationale text ─────────────────────────────────────────────────
  readonly rationale: Locator;

  // ── Loading state ──────────────────────────────────────────────────
  readonly loadingIndicator: Locator;

  constructor(page: Page) {
    this.page = page;

    this.panelHeading = page.getByText("Model Selection", { exact: true });
    this.overrideSelect = page.getByLabel("Model override");
    this.loadingIndicator = page.getByText("Loading model recommendation…");

    // The model name is a <span> with font-mono class inside the panel.
    // We locate by role-less text within the panel container. The panel is
    // the parent of "Model Selection" heading.
    const panel = page.locator(".space-y-2", { has: this.panelHeading });
    this.modelName = panel.locator("span.font-mono");
    this.budgetDowngradedBadge = panel.getByText("Budget downgraded");

    // Reasoning depth badge — contains " reasoning" suffix
    this.reasoningBadge = panel.getByText(/reasoning$/);
    // Token estimate badge — starts with "~" and ends with "tokens"
    this.tokenBadge = panel.getByText(/^~[\d,]+ tokens$/);
    // Cost badge — starts with "~$"
    this.costBadge = panel.getByText(/^~\$/);
    // Rationale — the <p> paragraph in the panel
    this.rationale = panel.locator("p");
  }

  /** Wait for the recommendation data to load (loading indicator disappears). */
  async waitForLoaded(): Promise<void> {
    await expect(this.panelHeading).toBeVisible({ timeout: 15_000 });
  }

  /** Select a model override from the dropdown. */
  async selectOverride(value: "auto" | "force-haiku" | "force-sonnet"): Promise<void> {
    await this.overrideSelect.selectOption(value);
  }

  /** Get the current override dropdown value. */
  async currentOverride(): Promise<string> {
    return this.overrideSelect.inputValue();
  }

  /** Get the displayed model name text. */
  async getModelName(): Promise<string> {
    return (await this.modelName.textContent()) ?? "";
  }

  /** Get the reasoning depth text (e.g. "Simple reasoning"). */
  async getReasoningDepth(): Promise<string> {
    return (await this.reasoningBadge.textContent()) ?? "";
  }

  /** Get the rationale text. */
  async getRationale(): Promise<string> {
    return (await this.rationale.textContent()) ?? "";
  }
}
