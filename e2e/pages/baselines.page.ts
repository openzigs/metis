/**
 * Page Object — project baselines list + compare
 * (`/projects/[id]/baselines`, ui/src/app/(authed)/projects/[id]/baselines).
 *
 * Covers the immutable baseline surface (#620): the baseline list, the
 * two-select compare picker, and the field-level "Changed" section rendered by
 * `BaselineCompareView` (which reuses the review `VersionDiff`).
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class BaselinesPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly baselineList: Locator;
  readonly compareSelectA: Locator;
  readonly compareSelectB: Locator;
  readonly compareResult: Locator;
  readonly changedSection: Locator;

  constructor(page: Page) {
    this.page = page;
    // `exact` matters: the page also renders an h2 "Compare two baselines".
    this.heading = page.getByRole("heading", { name: "Baselines", exact: true });
    this.baselineList = page.getByRole("list", { name: "Baselines" });
    this.compareSelectA = page.getByTestId("compare-select-a");
    this.compareSelectB = page.getByTestId("compare-select-b");
    this.compareResult = page.getByTestId("baseline-compare");
    this.changedSection = page.getByTestId("compare-changed");
  }

  async goto(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/baselines`, { waitUntil: "load" });
    await this.expectReady();
  }

  /** Wait for the baselines page to render (use after a login `next` nav). */
  async expectReady(): Promise<void> {
    await expect(this.heading).toBeVisible();
  }

  /** Row link for a specific baseline id. */
  row(baselineId: string): Locator {
    return this.page.getByTestId(`baseline-row-${baselineId}`);
  }

  /** Pick two baselines (by id) to trigger the compare query. */
  async compare(baselineIdA: string, baselineIdB: string): Promise<void> {
    await this.compareSelectA.selectOption(baselineIdA);
    await this.compareSelectB.selectOption(baselineIdB);
    await expect(this.compareResult).toBeVisible();
  }

  /** The field-level change block for a given requirement inside the compare view. */
  changedEntry(requirementId: string): Locator {
    return this.page.getByTestId(`compare-changed-${requirementId}`);
  }
}
