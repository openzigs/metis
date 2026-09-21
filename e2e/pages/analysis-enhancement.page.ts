/**
 * Page object for the Requirements Enhancement UI — Epic #597 (Issue #625).
 *
 * Encapsulates the analysis config page enhancement toggles, the
 * ClarificationDialog component, the EvidenceReview panel, and the
 * EnhancementStatus indicator. Uses accessible locators exclusively.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class AnalysisEnhancementPage {
  readonly page: Page;

  // ── Page header ────────────────────────────────────────────────────
  readonly heading: Locator;

  // ── Enhancement options section ────────────────────────────────────
  readonly enhancementOptions: Locator;
  readonly webResearchToggle: Locator;
  readonly clarificationToggle: Locator;

  // ── Enhancement status indicator ───────────────────────────────────
  readonly enhancementStatus: Locator;

  // ── Start analysis ─────────────────────────────────────────────────
  readonly runAnalysisButton: Locator;

  // ── Clarification dialog panel ─────────────────────────────────────
  readonly clarificationPanel: Locator;
  readonly clarificationHeading: Locator;
  readonly roundIndicator: Locator;
  readonly submitAnswersButton: Locator;
  readonly clarificationComplete: Locator;

  // ── Evidence review panel ──────────────────────────────────────────
  readonly evidenceReviewHeading: Locator;
  readonly evidenceEmptyMessage: Locator;

  constructor(page: Page) {
    this.page = page;

    this.heading = page.getByRole("heading", { name: /Analysis/ });

    // Enhancement toggles — these are labeled checkboxes inside the
    // "Enhancement Options" section of the analysis config card.
    this.enhancementOptions = page.getByText("Enhancement Options");
    this.webResearchToggle = page.getByText("Enhance with web research");
    this.clarificationToggle = page.getByText("Ask clarifying questions");

    // Enhancement status — the pipeline progress indicator appears when
    // at least one toggle is enabled.
    this.enhancementStatus = page.locator(".flex.items-center.gap-1").filter({
      has: page.getByText("Extract Requirements"),
    });

    // Run analysis button
    this.runAnalysisButton = page.getByRole("button", { name: "Run analysis" });

    // Clarification dialog
    this.clarificationPanel = page.locator("div").filter({
      has: page.getByRole("heading", { name: "Clarifying Questions" }),
    });
    this.clarificationHeading = page.getByRole("heading", {
      name: "Clarifying Questions",
    });
    this.roundIndicator = page.getByText(/Round \d+ \/ \d+/);
    this.submitAnswersButton = page.getByRole("button", { name: "Submit Answers" });
    this.clarificationComplete = page.getByText("Clarification Complete");

    // Evidence review
    this.evidenceReviewHeading = page.getByRole("heading", {
      name: "Evidence Review",
    });
    this.evidenceEmptyMessage = page.getByText("No web research evidence to review.");
  }

  async goto(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/analysis`);
    await expect(this.heading).toBeVisible({ timeout: 30_000 });
  }

  // ── Enhancement toggle helpers ─────────────────────────────────────

  async enableWebResearch(): Promise<void> {
    const label = this.page.getByText("Enhance with web research");
    await label.click();
  }

  async enableClarification(): Promise<void> {
    const label = this.page.getByText("Ask clarifying questions");
    await label.click();
  }

  async isWebResearchChecked(): Promise<boolean> {
    // The checkbox is the input inside the label containing the text
    const label = this.page.locator("label").filter({ hasText: "Enhance with web research" });
    const input = label.locator("input[type='checkbox']");
    return input.isChecked();
  }

  async isClarificationChecked(): Promise<boolean> {
    const label = this.page.locator("label").filter({ hasText: "Ask clarifying questions" });
    const input = label.locator("input[type='checkbox']");
    return input.isChecked();
  }

  // ── Enhancement status helpers ─────────────────────────────────────

  getStatusStep(label: string): Locator {
    return this.enhancementStatus.getByText(label);
  }

  // ── Clarification helpers ──────────────────────────────────────────

  async fillAnswer(questionIndex: number, answer: string): Promise<void> {
    const inputs = this.clarificationPanel.getByPlaceholder("Your answer...");
    await inputs.nth(questionIndex).fill(answer);
  }

  async submitAnswers(): Promise<void> {
    await this.submitAnswersButton.click();
  }

  // ── Evidence review helpers ────────────────────────────────────────

  getApproveButton(index: number): Locator {
    return this.page.getByRole("button", { name: "✓ Approve" }).nth(index);
  }

  getRejectButton(index: number): Locator {
    return this.page.getByRole("button", { name: "✕ Reject" }).nth(index);
  }

  getTrustBadge(trust: "High Trust" | "Medium Trust" | "Low Trust"): Locator {
    return this.page.getByText(trust);
  }

  getNeedsReviewBadge(): Locator {
    return this.page.getByText("Needs Review");
  }

  getSourceLink(title: string): Locator {
    return this.page.getByRole("link", { name: title });
  }
}
