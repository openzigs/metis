/**
 * Page Object — review detail (`/reviews/[id]`, ui/src/app/(authed)/reviews).
 *
 * Encapsulates the reviewer decision surface (#618): the status badge, the
 * approve/reject DecisionBar, the optional decision note, and the
 * baseline-created link the header renders after a terminal approval (#620).
 *
 * Locators prefer accessible affordances (roles, labels, visible text) with
 * the component data-testids as the stable fallback for the decision controls.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class ReviewDetailPage {
  readonly page: Page;
  readonly statusBadge: Locator;
  readonly decisionBar: Locator;
  readonly noteField: Locator;
  readonly approveButton: Locator;
  readonly rejectButton: Locator;
  readonly baselineLink: Locator;

  constructor(page: Page) {
    this.page = page;
    this.statusBadge = page.getByTestId("review-status-badge");
    this.decisionBar = page.getByTestId("decision-bar");
    this.noteField = page.getByLabel("Decision note (optional)");
    this.approveButton = page.getByTestId("decision-approve");
    this.rejectButton = page.getByTestId("decision-reject");
    // "Baseline created on approval: <name>" — the produced baseline link.
    this.baselineLink = page.getByTestId("review-header").getByRole("link", { name: /.+/ });
  }

  async goto(reviewId: string): Promise<void> {
    await this.page.goto(`/reviews/${reviewId}`, { waitUntil: "load" });
    await this.expectReady();
  }

  /** Wait for the review detail shell to render (use after a login `next` nav). */
  async expectReady(): Promise<void> {
    await expect(this.page.getByTestId("review-detail")).toBeVisible();
  }

  /** Record a decision, optionally with a note, and wait for the request to settle. */
  async decide(decision: "approve" | "reject", note?: string): Promise<void> {
    await expect(this.decisionBar).toBeVisible();
    if (note) await this.noteField.fill(note);
    const button = decision === "approve" ? this.approveButton : this.rejectButton;
    await Promise.all([
      this.page.waitForResponse(
        (res) =>
          res.url().includes("/api/reviews/") &&
          res.url().endsWith("/decision") &&
          res.request().method() === "POST",
        { timeout: 30_000 },
      ),
      button.click(),
    ]);
  }

  /** Assert the header status badge shows the given human label (e.g. "Approved"). */
  async expectStatus(label: string): Promise<void> {
    await expect(this.statusBadge).toHaveText(label);
  }
}
