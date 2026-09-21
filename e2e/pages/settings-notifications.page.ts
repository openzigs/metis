/**
 * Page object for Settings → Notifications (`/settings/notifications`).
 *
 * Epic #608 (#613) rebuilt this page as a channel × event preference matrix
 * backed by the server-side preferences API (GET/PUT
 * /api/users/me/notification-preferences) — localStorage is no longer a data
 * source. Cells are addressed by the same `data-testid` scheme the page
 * renders: `settings-notifications-cell-${channel}-${event}` over the shared
 * `@metis/shared` vocabulary (channels `email | inApp | webhook | teams`,
 * events `analysisCompleted | requirementsApproved | issuesPublished |
 * systemAlerts | mention | slaDeadline`).
 */
import { expect, type Locator, type Page } from "@playwright/test";

export type NotificationChannel = "email" | "inApp" | "webhook" | "teams";
export type NotificationEvent =
  | "analysisCompleted"
  | "requirementsApproved"
  | "issuesPublished"
  | "systemAlerts"
  | "mention"
  | "slaDeadline";

export class SettingsNotificationsPage {
  readonly page: Page;
  readonly root: Locator;
  readonly heading: Locator;
  readonly matrix: Locator;
  readonly saveButton: Locator;
  readonly discardButton: Locator;
  readonly savedToast: Locator;
  readonly error: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.getByTestId("settings-notifications-root");
    this.heading = page.getByRole("heading", { name: "Notifications", exact: true });
    this.matrix = page.getByTestId("settings-notifications-matrix");
    this.saveButton = page.getByTestId("settings-notifications-save");
    this.discardButton = page.getByTestId("settings-notifications-discard");
    this.savedToast = page.getByTestId("settings-notifications-saved");
    this.error = page.getByTestId("settings-notifications-error");
  }

  async goto(): Promise<void> {
    await this.page.goto("/settings/notifications", { waitUntil: "load" });
  }

  /** Wait until the matrix has hydrated from the preferences API. */
  async expectLoaded(): Promise<void> {
    await expect(this.root).toBeVisible({ timeout: 30_000 });
    await expect(this.heading).toBeVisible();
    // The matrix renders only after GET /api/users/me/notification-preferences
    // resolves (cold Next.js dev compile can make the first hit slow).
    await expect(this.matrix).toBeVisible({ timeout: 30_000 });
  }

  /** One checkbox cell of the channel × event matrix. */
  cell(channel: NotificationChannel, event: NotificationEvent): Locator {
    return this.page.getByTestId(`settings-notifications-cell-${channel}-${event}`);
  }

  /** Drive a cell to the desired checked state (no-op when already there). */
  async setCell(
    channel: NotificationChannel,
    event: NotificationEvent,
    enabled: boolean,
  ): Promise<void> {
    await this.cell(channel, event).setChecked(enabled);
  }

  /**
   * Persist the current draft and wait for the transient "Saved" confirmation,
   * which the page shows only after the PUT round-trip succeeded.
   */
  async save(): Promise<void> {
    await expect(this.saveButton).toBeEnabled();
    await this.saveButton.click();
    await expect(this.savedToast).toBeVisible({ timeout: 15_000 });
  }
}
