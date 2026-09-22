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
    // Exact match: once an SSO IdP is enabled the login page also renders
    // "Sign in with <IdP>" buttons, which a /Sign in/ regex also matches.
    this.submit = page.getByRole("button", { name: "Sign in", exact: true });
    this.ssoSection = page.locator("[class*='space-y-3']").first();
    // `exact` matters: a substring match on "or" also hits the card
    // description ("… Tool for Issue Synthesis").
    this.separator = page.getByText("or", { exact: true });
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
