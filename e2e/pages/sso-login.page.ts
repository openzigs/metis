/**
 * SSO Login page object — extends login page with SSO-specific locators.
 *
 * Epic #748, Issue #755: Login page provider auto-detect + branded buttons.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class SSOLoginPage {
  readonly page: Page;
  readonly title: Locator;
  readonly username: Locator;
  readonly password: Locator;
  readonly submit: Locator;
  readonly ssoSection: Locator;
  readonly separator: Locator;

  constructor(page: Page) {
    this.page = page;
    this.title = page.getByText("Sign in to METIS", { exact: true });
    this.username = page.getByLabel("Username");
    this.password = page.getByLabel("Password");
    this.submit = page.getByRole("button", { name: /Sign in/ });
    this.ssoSection = page.locator("[class*='space-y-3']").first();
    this.separator = page.getByText("or");
  }

  async goto(): Promise<void> {
    await this.page.goto("/login", { waitUntil: "load" });
    await expect(this.title).toBeVisible();
    await this.page.waitForLoadState("networkidle").catch(() => undefined);
  }

  /** Get all SSO provider buttons currently displayed. */
  getSSOButton(providerName: string): Locator {
    return this.page.getByRole("button", { name: `Sign in with ${providerName}` });
  }

  /** Get all visible SSO buttons. */
  getAllSSOButtons(): Locator {
    return this.page.getByRole("button", { name: /Sign in with / });
  }

  /** Check that the standard username/password form is visible. */
  async expectStandardLoginVisible(): Promise<void> {
    await expect(this.username).toBeVisible();
    await expect(this.password).toBeVisible();
    await expect(this.submit).toBeVisible();
  }

  /** Check that the separator between SSO buttons and form is visible. */
  async expectSSOSeparatorVisible(): Promise<void> {
    await expect(this.separator).toBeVisible();
  }
}
