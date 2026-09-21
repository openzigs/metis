/**
 * Usage Classification section page object — Epic #292 (#298).
 *
 * Encapsulates the per-object used/unreferenced/uncertain classification UI
 * (`UsageClassificationSection`) rendered inside a project-impact section on the
 * impact-analysis detail page (`/impact-analyses/:id`).
 *
 * Locators are accessible-first: the section is a labelled `region`, the filter
 * is a native checkbox reachable by its accessible name, and individual rows /
 * badges are addressed by role + text where possible, falling back to the
 * component's stable `data-testid` hooks for structural assertions.
 */
import { type Locator, type Page } from "@playwright/test";

export class UsageClassificationPage {
  readonly page: Page;

  // ── Detail page chrome ─────────────────────────────────────────────
  readonly detailRoot: Locator;
  readonly detailStatus: Locator;
  readonly projectSection: Locator;

  // ── Usage classification section ───────────────────────────────────
  /** The labelled region — accessible name "Used objects". */
  readonly section: Locator;
  /** Native checkbox toggle — accessible name "Only show used objects". */
  readonly onlyUsedToggle: Locator;
  readonly rows: Locator;
  readonly badges: Locator;
  /** The safety / framing note shown above the list. */
  readonly safetyNote: Locator;

  constructor(page: Page) {
    this.page = page;

    this.detailRoot = page.getByTestId("impact-detail-root");
    this.detailStatus = page.getByTestId("impact-detail-status");
    this.projectSection = page.getByTestId("project-impact-section");

    this.section = page.getByRole("region", { name: "Used objects" });
    this.onlyUsedToggle = page.getByRole("checkbox", { name: "Only show used objects" });
    this.rows = this.section.getByTestId("usage-classification-row");
    this.badges = this.section.getByTestId("usage-badge");
    this.safetyNote = this.section.getByText("Unreferenced objects are review candidates only", {
      exact: false,
    });
  }

  /** Navigate to the impact-analysis detail page for a seeded analysis id. */
  async goto(analysisId: string): Promise<void> {
    await this.page.goto(`/impact-analyses/${analysisId}`);
  }

  /** All rows for a given usage class, addressed via the row's own data attribute. */
  rowsForClass(usageClass: "used" | "unreferenced" | "uncertain"): Locator {
    return this.section.locator(
      `[data-testid="usage-classification-row"][data-usage-class="${usageClass}"]`,
    );
  }

  /** The row whose object name (mono span) matches the given text. */
  rowByName(name: string): Locator {
    return this.rows.filter({ hasText: name });
  }

  /** The usage badge within a given row. */
  badgeIn(row: Locator): Locator {
    return row.getByTestId("usage-badge");
  }

  /** The uncertain-reason label within a given row. */
  uncertainReasonIn(row: Locator): Locator {
    return row.getByTestId("usage-uncertain-reason");
  }
}
