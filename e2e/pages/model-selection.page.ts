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
  /** Badge shown in place of a number when there is no estimate. */
  readonly tokenUnavailableBadge: Locator;
  /** Caption shown instead of a number when the project has no completed run. */
  readonly noTokenEstimateCaption: Locator;
  readonly costBadge: Locator;

  // ── Rationale text ─────────────────────────────────────────────────
  readonly rationale: Locator;

  // ── Loading state ──────────────────────────────────────────────────
  readonly loadingIndicator: Locator;

  constructor(page: Page) {
    this.page = page;

    // The panel exports a test id (ModelRecommendation.tsx); a class-based
    // container lookup matched several ancestors and went strict-mode red.
    const panel = page.getByTestId("model-recommendation");
    this.panelHeading = panel.getByText("Model Selection", { exact: true });
    // A Radix Select: a labelled BUTTON that opens a listbox portal, not a
    // native <select>. `selectOption` / `inputValue` do not apply.
    this.overrideSelect = panel.getByRole("combobox", { name: "Model override" });
    this.loadingIndicator = page.getByText("Loading model recommendation…");

    this.modelName = panel.locator("span.font-mono");
    this.budgetDowngradedBadge = panel.getByText("Budget downgraded");

    // Reasoning depth badge. Anchored on the WHOLE label: a loose
    // "ends with reasoning" also matched the rationale sentence
    // ("… Sonnet required for deep reasoning").
    this.reasoningBadge = panel.getByText(/^(Simple|Moderate|Complex) reasoning$/);
    // Token estimate — "~N tokens" once the project has a run to size from,
    // otherwise the panel says so explicitly rather than inventing a number.
    this.tokenBadge = panel.getByText(/^~[\d,]+ tokens$/);
    this.tokenUnavailableBadge = panel.getByText(/^Token estimate unavailable$/);
    this.noTokenEstimateCaption = panel.getByText(/^No token estimate yet/);
    // Cost badge — starts with "~$"
    this.costBadge = panel.getByText(/^~\$/);
    // Rationale — the LAST <p> in the panel (the first is the estimate caption).
    this.rationale = panel.locator("p").last();
  }

  /** Wait for the recommendation data to load (loading indicator disappears). */
  async waitForLoaded(): Promise<void> {
    await expect(this.panelHeading).toBeVisible({ timeout: 15_000 });
  }

  /** The human label shown for an override value. */
  static readonly OVERRIDE_LABELS: Record<string, string> = {
    auto: "Auto",
    "force-haiku": "Force Haiku",
    "force-sonnet": "Force Sonnet",
    "force-fable": "Force Fable",
    "force-opus": "Force Opus",
  };

  /** Open the override dropdown and return its options (as a listbox). */
  async openOverride(): Promise<Locator> {
    await this.overrideSelect.click();
    const listbox = this.page.getByRole("listbox");
    await expect(listbox).toBeVisible();
    return listbox;
  }

  /** Select a model override from the dropdown. */
  async selectOverride(
    value: "auto" | "force-haiku" | "force-sonnet" | "force-fable" | "force-opus",
  ): Promise<void> {
    const listbox = await this.openOverride();
    await listbox
      .getByRole("option", { name: ModelSelectionPanel.OVERRIDE_LABELS[value], exact: true })
      .click();
    await expect(this.overrideSelect).toContainText(ModelSelectionPanel.OVERRIDE_LABELS[value]);
  }

  /** The override currently shown on the trigger (its human label). */
  async currentOverride(): Promise<string> {
    return (await this.overrideSelect.textContent())?.trim() ?? "";
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
