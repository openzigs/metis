/**
 * Page object for the workspace traceability rollup — Epic #610 (#626).
 *
 * The rollup (`ui/src/components/traceability/workspace-traceability-rollup.tsx`,
 * rendered by `/workspaces/:id/traceability`) is a read-only surface: a
 * per-project coverage table plus a Mermaid map of the workspace's cross-project
 * `RequirementLink` edges. When at least one cross-project link exists the map
 * renders either as SVG (`rollup-link-map`) or, if the browser Mermaid render
 * fails, as its source text (`rollup-mermaid-source`); with none it shows the
 * `rollup-no-links` empty state.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class WorkspaceTraceabilityPage {
  readonly page: Page;

  readonly rollup: Locator;
  readonly summaryTable: Locator;
  readonly projectRows: Locator;
  readonly noLinks: Locator;
  readonly linkMap: Locator;
  readonly mermaidSource: Locator;
  readonly mapLoading: Locator;

  constructor(page: Page) {
    this.page = page;
    this.rollup = page.getByTestId("workspace-traceability-rollup");
    this.summaryTable = page.getByTestId("rollup-summary-table");
    this.projectRows = page.getByTestId("rollup-project-row");
    this.noLinks = page.getByTestId("rollup-no-links");
    this.linkMap = page.getByTestId("rollup-link-map");
    this.mermaidSource = page.getByTestId("rollup-mermaid-source");
    this.mapLoading = page.getByTestId("rollup-map-loading");
  }

  async goto(workspaceId: string): Promise<void> {
    await this.page.goto(`/workspaces/${workspaceId}/traceability`);
    await expect(this.rollup).toBeVisible({ timeout: 30_000 });
  }

  /** A per-project coverage row narrowed to a specific project name. */
  projectRow(name: string): Locator {
    return this.projectRows.filter({ hasText: name });
  }

  /** Resolve once the cross-project link map has rendered (SVG or source). */
  async expectLinkMapRendered(): Promise<void> {
    await expect(this.noLinks).toBeHidden();
    await expect(this.linkMap.or(this.mermaidSource)).toBeVisible({ timeout: 15_000 });
  }
}
