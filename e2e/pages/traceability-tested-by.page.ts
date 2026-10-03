/**
 * Page object for "Tested by" and the untested-requirements list (#816, Epic
 * #812): the per-requirement chain's "Tested by" section on the Requirements
 * tab, and the "Untested requirements" panel on the Traceability tab.
 *
 * Locators are accessible-first (roles, names, text); the `data-testid` hooks
 * the components ship are used only where a role would be ambiguous.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import type { AnalysisTab } from "./analysis-inline.page.js";

export class TraceabilityTestedByPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly untestedPanel: Locator;
  readonly untestedSummary: Locator;
  readonly loadMore: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { name: /^Requirements Analysis —/ });
    this.untestedPanel = page.getByRole("region", { name: "Untested requirements" });
    this.untestedSummary = page.getByTestId("untested-summary");
    this.loadMore = this.untestedPanel.getByRole("button", { name: "Load more" });
  }

  async goto(projectId: string, tab: AnalysisTab): Promise<void> {
    await this.page.goto(`/projects/${projectId}/analysis?tab=${tab}`, { waitUntil: "load" });
    await expect(this.heading).toBeVisible({ timeout: 30_000 });
  }

  /** A requirement's card on the Requirements tab. */
  requirementCard(requirementId: string): Locator {
    return this.page.locator(`[id="requirement-${requirementId}"]`);
  }

  /** The "Tested by" section inside one requirement card. */
  testedBy(requirementId: string): Locator {
    return this.requirementCard(requirementId).getByRole("region", { name: /^Tested by/ });
  }

  /** One untested requirement's link in the panel. */
  untestedLink(title: string): Locator {
    return this.untestedPanel.getByRole("link", { name: title });
  }
}
