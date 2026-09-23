/**
 * Page Object for the Invitation Accept page.
 *
 * Epic #759, Issue #768.
 * Route: /invites/[token]
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class InviteAcceptPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly workspaceName: Locator;
  readonly acceptButton: Locator;
  readonly errorCard: Locator;
  readonly expiredHeading: Locator;
  readonly invalidHeading: Locator;
  readonly successHeading: Locator;
  readonly inviterName: Locator;
  readonly inviteeEmail: Locator;
  readonly roleLabel: Locator;

  constructor(page: Page) {
    this.page = page;
    // shadcn's CardTitle renders a <div>, not a heading element (see
    // packages/ui-kit/src/components/card.tsx), so these are text locators.
    this.heading = page.getByText("Workspace Invitation", { exact: true });
    this.workspaceName = page.locator(".rounded-lg.border p.text-lg");
    this.acceptButton = page.getByRole("button", { name: "Accept invitation" });
    this.errorCard = page.getByText("Invalid Invitation", { exact: true });
    this.expiredHeading = page.getByText("Invitation Expired", { exact: true });
    this.invalidHeading = page.getByText("Invalid Invitation", { exact: true });
    this.successHeading = page.getByText("Welcome!", { exact: true });
    this.inviterName = page.getByText(/invited you to join/);
    this.inviteeEmail = page.getByText(/Invitation for/);
    this.roleLabel = page.getByText(/^Role:/);
  }

  async goto(token: string): Promise<void> {
    await this.page.goto(`/invites/${token}`);
    // Wait for loading to finish
    await this.page.waitForLoadState("networkidle");
  }

  /** Assert the invite page shows valid invitation details. */
  async expectValidInvite(opts: {
    workspaceName: string;
    inviterName: string;
    email: string;
  }): Promise<void> {
    await expect(this.heading).toBeVisible();
    await expect(this.workspaceName).toContainText(opts.workspaceName);
    await expect(this.inviterName).toContainText(opts.inviterName);
    await expect(this.inviteeEmail).toContainText(opts.email);
    await expect(this.acceptButton).toBeEnabled();
  }

  /** Accept the invitation. */
  async accept(): Promise<void> {
    await this.acceptButton.click();
  }

  /** Assert the success state after accepting. */
  async expectAccepted(workspaceName: string): Promise<void> {
    await expect(this.successHeading).toBeVisible();
    await expect(this.page.getByText(workspaceName)).toBeVisible();
  }

  /** Assert the expired/invalid error state. */
  async expectExpired(): Promise<void> {
    await expect(this.expiredHeading).toBeVisible();
  }

  /** Assert the generic invalid token state. */
  async expectInvalid(): Promise<void> {
    await expect(this.invalidHeading).toBeVisible();
  }
}
