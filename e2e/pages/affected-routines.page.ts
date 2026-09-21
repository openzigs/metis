/**
 * Affected procedures & functions page object — Epic #293 Phase 2 (#302).
 *
 * Encapsulates the routine-aware parts of the impact-analysis detail page
 * (`/impact-analyses/:id`):
 *
 *   - the "Affected procedures & functions" sub-section inside
 *     `AffectedTablesSection` (routines surfaced alongside affected tables), and
 *   - the routine rows that flow through the Phase 1
 *     `UsageClassificationSection` (used/unreferenced/uncertain).
 *
 * Locators are accessible-first where the markup exposes roles/labels/text, and
 * fall back to the components' stable `data-testid` / data-attribute hooks for
 * structural assertions (mirrors `usage-classification.page.ts`).
 */
import { type Locator, type Page } from "@playwright/test";

export class AffectedRoutinesPage {
  readonly page: Page;

  // ── Detail page chrome ─────────────────────────────────────────────
  readonly detailRoot: Locator;
  readonly detailStatus: Locator;
  readonly projectSection: Locator;

  // ── Affected procedures & functions sub-section (AffectedTablesSection) ──
  readonly schemaImpactSection: Locator;
  /** The "Affected procedures & functions" sub-section wrapper. */
  readonly routinesSection: Locator;
  /** Its visible heading text. */
  readonly routinesHeading: Locator;
  /** Every affected-routine row. */
  readonly routineRows: Locator;
  /** Affected relational tables (proves routines render *alongside* tables). */
  readonly tableRows: Locator;

  // ── Usage classification section (Phase 1 UI, now fed routines) ─────
  readonly usageSection: Locator;
  readonly usageRows: Locator;

  constructor(page: Page) {
    this.page = page;

    this.detailRoot = page.getByTestId("impact-detail-root");
    this.detailStatus = page.getByTestId("impact-detail-status");
    this.projectSection = page.getByTestId("project-impact-section");

    this.schemaImpactSection = page.getByTestId("schema-impact-section");
    this.routinesSection = page.getByTestId("schema-impact-routines-section");
    this.routinesHeading = this.routinesSection.getByText("Affected procedures & functions", {
      exact: false,
    });
    this.routineRows = this.routinesSection.getByTestId("schema-impact-routine");
    this.tableRows = this.schemaImpactSection.getByTestId("schema-impact-table");

    this.usageSection = page.getByRole("region", { name: "Used objects" });
    this.usageRows = this.usageSection.getByTestId("usage-classification-row");
  }

  /** Navigate to the impact-analysis detail page for a seeded analysis id. */
  async goto(analysisId: string): Promise<void> {
    await this.page.goto(`/impact-analyses/${analysisId}`);
  }

  /** Affected-routine rows of a given object kind (`procedure` | `function`). */
  routineRowsByKind(kind: "procedure" | "function"): Locator {
    return this.routinesSection.locator(
      `[data-testid="schema-impact-routine"][data-object-kind="${kind}"]`,
    );
  }

  /** The affected-routine row whose qualified name matches. */
  routineRowByName(name: string): Locator {
    return this.routinesSection.locator(
      `[data-testid="schema-impact-routine"][data-routine-name="${name}"]`,
    );
  }

  /** The verify-only note `<pre>` inside an affected-routine row. */
  noteIn(row: Locator): Locator {
    return row.getByTestId("schema-routine-note");
  }

  /** The kind badge inside an affected-routine row. */
  kindBadgeIn(row: Locator): Locator {
    return row.getByTestId("schema-routine-kind");
  }

  /** Usage-classification rows whose object kind is a routine kind. */
  usageRowByName(name: string): Locator {
    return this.usageRows.filter({ hasText: name });
  }

  /** Usage-classification rows of a given usage class. */
  usageRowsForClass(usageClass: "used" | "unreferenced" | "uncertain"): Locator {
    return this.usageSection.locator(
      `[data-testid="usage-classification-row"][data-usage-class="${usageClass}"]`,
    );
  }

  /** The usage badge within a usage-classification row. */
  usageBadgeIn(row: Locator): Locator {
    return row.getByTestId("usage-badge");
  }

  /** The uncertain-reason label within a usage-classification row. */
  uncertainReasonIn(row: Locator): Locator {
    return row.getByTestId("usage-uncertain-reason");
  }
}
