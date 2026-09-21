/**
 * Page object for the PR-review surfaces (Epic #394 P2 / #404):
 *   - List:   /projects/[id]/pulls
 *   - Detail: /projects/[id]/pulls/[prNumber]?owner=…&repo=…
 *
 * Accessible-locator first (headings, buttons, text). The list table has no
 * test ids, so rows are addressed via their semantic content; the detail page
 * exposes a single `re-run-button` test id for the Re-run control.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class PullReviewsListPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly subtitle: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { name: "PR reviews" });
    this.subtitle = page.getByText("History of automated PR reviews", { exact: false });
  }

  async goto(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/pulls`, { waitUntil: "load" });
  }

  /** The legitimate empty state for a project with no recorded reviews. */
  emptyState(): Locator {
    return this.page.getByText("No PR reviews recorded yet", { exact: false });
  }

  /** The error state copy (Failed to load reviews…). */
  errorState(): Locator {
    return this.page.getByText("Failed to load reviews", { exact: false });
  }

  /** The "Showing N of M reviews" footer that only renders when the query resolved. */
  footer(): Locator {
    return this.page.getByText(/Showing \d+ of \d+ reviews/);
  }

  async expectLoaded(): Promise<void> {
    await expect(this.heading).toBeVisible({ timeout: 20_000 });
    await expect(this.subtitle).toBeVisible();
  }
}

export class PullReviewDetailPage {
  readonly page: Page;
  readonly backLink: Locator;
  readonly reRunButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.backLink = page.getByRole("link", { name: "← Back to PR reviews" });
    this.reRunButton = page.getByTestId("re-run-button");
  }

  async goto(
    projectId: string,
    prNumber: number,
    repo: { owner: string; name: string },
  ): Promise<void> {
    const qs = new URLSearchParams({ owner: repo.owner, repo: repo.name }).toString();
    await this.page.goto(`/projects/${projectId}/pulls/${prNumber}?${qs}`, {
      waitUntil: "load",
    });
  }

  /** The graceful "no review recorded" 404 surface. */
  noReviewState(): Locator {
    return this.page.getByText("No automated review has been recorded for this PR yet", {
      exact: false,
    });
  }

  /** The missing-URL-parameter guard surface. */
  missingParamsState(): Locator {
    return this.page.getByText("Missing required URL parameters", { exact: false });
  }
}
