import { expect, type Locator, type Page, type Response } from "@playwright/test";

/**
 * #297 — how long the quarantine list may take to refresh after an action that
 * refreshes it. The refresh is one indexed SQLite read behind the Next proxy:
 * measured at 5–15 ms in the API and ~10–100 ms end to end on the e2e stack.
 * 15 s is the suite's own `expect` timeout, so a starved runner keeps two orders
 * of magnitude of headroom, while a refresh that never answers fails HERE, by
 * name, instead of running out the 120 s test timeout on an unbounded wait.
 */
export const LIST_REFRESH_BOUND_MS = 15_000;

export interface ListRefreshWatch {
  /** Passes once a quarantine-list GET made since the watch began answered 200. */
  expectRefreshed(): Promise<void>;
}

export class QuarantinePage {
  readonly row: Locator;
  readonly retry: Locator;
  readonly retrying: Locator;
  readonly approvalError: Locator;
  readonly empty: Locator;

  constructor(
    private readonly page: Page,
    filename: string,
  ) {
    this.row = page.getByRole("listitem").filter({
      has: page.getByText(filename, { exact: true }),
    });
    this.retry = this.row.getByRole("button", { name: "Retry indexing", exact: true });
    this.retrying = this.row.getByRole("button", { name: "Retrying indexing…", exact: true });
    this.approvalError = page.getByRole("alert").filter({
      hasText: "Unable to finish approval/indexing:",
    });
    this.empty = page.getByText("Quarantine is empty.", { exact: true });
  }

  /**
   * Record the quarantine-list GETs this page makes from now on. Start it BEFORE
   * the action that should refresh the list, then `expectRefreshed()`.
   */
  watchListRefreshes(projectId: string): ListRefreshWatch {
    const listPath = `/api/projects/${projectId}/quarantine`;
    const statuses: number[] = [];
    const onResponse = (response: Response): void => {
      if (response.request().method() === "GET" && new URL(response.url()).pathname === listPath)
        statuses.push(response.status());
    };
    this.page.on("response", onResponse);
    return {
      expectRefreshed: async () => {
        try {
          await expect
            .poll(() => statuses, {
              message: `quarantine list refresh (GET ${listPath}) answered 200`,
              timeout: LIST_REFRESH_BOUND_MS,
            })
            .toContain(200);
        } finally {
          this.page.off("response", onResponse);
        }
      },
    };
  }

  async goto(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/settings`);
    await expect(this.page.getByRole("heading", { name: "Quarantine", exact: true })).toBeVisible();
  }

  async reload(): Promise<void> {
    await this.page.reload();
  }

  async expectReconciling(error: string, hidden?: string): Promise<void> {
    await expect(this.row).toContainText(
      "Approval saved. Index cleanup is incomplete; retry indexing to finish.",
    );
    await expect(this.row).toContainText(error);
    if (hidden) await expect(this.row).not.toContainText(hidden);
    await expect(this.retry).toBeEnabled();
    await expect(this.row.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
    await expect(this.row.getByRole("button", { name: "Reject", exact: true })).toHaveCount(0);
    await expect(this.row.getByRole("checkbox")).toHaveCount(0);
    await expect(this.empty).toHaveCount(0);
  }
}
