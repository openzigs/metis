/**
 * Page Object for the Domain Eval tab on the eval leaderboard (Epic #803,
 * sub-issue #807). Route: `/eval/leaderboard` → "Domain Eval" tab.
 *
 * Selectors prefer accessible roles/labels; where the component exposes a
 * `data-testid` as its public test contract (rows keyed by runId, diff rows
 * keyed by item id) we use `getByTestId` so per-entity targeting stays stable.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class DomainEvalPage {
  readonly page: Page;

  // Leaderboard shell + tabs
  readonly root: Locator;
  readonly benchmarksTab: Locator;
  readonly domainTab: Locator;

  // Panel
  readonly panel: Locator;
  readonly heading: Locator;
  readonly daysFilter: Locator;

  // Trend chart
  readonly trendCard: Locator;
  readonly trendChart: Locator;
  readonly trendEmpty: Locator;

  // Runs table + states
  readonly runsTable: Locator;
  readonly runsLoading: Locator;
  readonly runsError: Locator;
  readonly runsEmpty: Locator;

  constructor(page: Page) {
    this.page = page;

    this.root = page.getByTestId("eval-leaderboard-root");
    this.benchmarksTab = page.getByRole("tab", { name: "Benchmarks" });
    this.domainTab = page.getByRole("tab", { name: "Domain Eval" });

    this.panel = page.getByTestId("domain-eval-panel");
    this.heading = page.getByRole("heading", { name: "BA Pipeline Domain Eval" });
    this.daysFilter = page.getByLabel("Domain eval time window");

    this.trendCard = page.getByTestId("domain-trend-card");
    this.trendChart = page.getByRole("img", { name: "Corpus F1 over time" });
    this.trendEmpty = page.getByTestId("domain-trend-empty");

    this.runsTable = page.getByTestId("domain-runs-table");
    this.runsLoading = page.getByTestId("domain-runs-loading");
    this.runsError = page.getByTestId("domain-runs-error");
    this.runsEmpty = page.getByTestId("domain-runs-empty");
  }

  async goto(): Promise<void> {
    await this.page.goto("/eval/leaderboard", { waitUntil: "domcontentloaded" });
    await expect(this.root).toBeVisible({ timeout: 15_000 });
  }

  /** Activate the Domain Eval tab and wait for the panel to render. */
  async openDomainTab(): Promise<void> {
    await this.domainTab.click();
    await expect(this.panel).toBeVisible();
  }

  /** A run row in the table, keyed by runId. */
  runRow(runId: string): Locator {
    return this.page.getByTestId(`domain-run-row-${runId}`);
  }

  /** The "Drift" badge inside a run row (only present when the run drifted). */
  driftBadge(runId: string): Locator {
    return this.page.getByTestId(`domain-drift-badge-${runId}`);
  }

  /** The trend-chart point marker for a run (carries `data-drift-alert`). */
  trendPoint(runId: string): Locator {
    return this.page.getByTestId(`domain-point-${runId}`);
  }

  /** Open the drill-in detail view for a run. */
  async inspectRun(runId: string): Promise<void> {
    await this.page.getByTestId(`domain-run-inspect-${runId}`).click();
    await expect(this.runDetail(runId)).toBeVisible();
  }

  runDetail(runId: string): Locator {
    return this.page.getByTestId(`domain-run-detail-${runId}`);
  }

  detailLoading(): Locator {
    return this.page.getByTestId("domain-detail-loading");
  }

  detailError(): Locator {
    return this.page.getByTestId("domain-detail-error");
  }

  async closeDetail(): Promise<void> {
    await this.page.getByTestId("domain-detail-close").click();
  }

  // --- Calibration ---------------------------------------------------------

  calibration(): Locator {
    return this.page.getByTestId("domain-calibration");
  }

  calibrationBin(bucket: string): Locator {
    return this.page.getByTestId(`domain-calibration-bin-${bucket}`);
  }

  // --- Per-item drill-in ---------------------------------------------------

  itemRow(itemId: string): Locator {
    return this.page.getByTestId(`domain-item-${itemId}`);
  }

  /** Expand a corpus item to reveal its expected-vs-actual field diff. */
  async expandItem(itemId: string): Promise<void> {
    const toggle = this.page.getByTestId(`domain-item-toggle-${itemId}`);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  }

  fieldDiff(itemId: string): Locator {
    return this.page.getByTestId(`domain-field-diff-${itemId}`);
  }

  /** A single aligned diff row (match | missed | hallucinated), by index. */
  diffRow(itemId: string, index: number): Locator {
    return this.page.getByTestId(`domain-diff-row-${itemId}-${index}`);
  }

  /** A diff row filtered to a given kind, scoped to one item's diff. */
  diffRowsByKind(itemId: string, kind: "match" | "missed" | "hallucinated"): Locator {
    return this.fieldDiff(itemId).locator(`[data-kind="${kind}"]`);
  }
}
