/**
 * Run-detail page object — Epic #395 #419.
 *
 * Encapsulates the sandbox affordances on `/runs/[id]`:
 *   - the SandboxStatusBadge next to the run heading
 *   - the SandboxSessionTable disclosure block
 *
 * These are part of the test contract — see
 * `ui/src/components/sandbox/SandboxStatusBadge.tsx` and
 * `ui/src/components/sandbox/SandboxSessionTable.tsx`.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class RunPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly sessionTableToggle: Locator;
  readonly sessionTable: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { level: 1 });
    this.sessionTableToggle = page.getByTestId("sandbox-session-table-toggle");
    this.sessionTable = page.getByTestId("sandbox-session-table");
  }

  async goto(runId: string): Promise<void> {
    await this.page.goto(`/runs/${encodeURIComponent(runId)}`);
    await expect(this.heading).toBeVisible();
  }

  /**
   * Returns the visible text of the most-recent-session badge,
   * or null when the run has no sandbox sessions.
   */
  async getSandboxBadgeText(): Promise<string | null> {
    const badge = this.page.locator("[data-sandbox-badge]").first();
    if ((await badge.count()) === 0) return null;
    return (await badge.textContent())?.trim() ?? null;
  }

  /**
   * Returns the count of sandbox session rows. Opens the disclosure
   * if it is not already expanded.
   */
  async getSandboxSessionRowCount(): Promise<number> {
    if ((await this.sessionTableToggle.getAttribute("aria-expanded")) !== "true") {
      await this.sessionTableToggle.click();
    }
    return this.page.locator("[data-sandbox-session-id]").count();
  }
}
