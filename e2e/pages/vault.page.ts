/**
 * Vault page object (`/vault`, Epic #196 / #222).
 *
 * #1554 — revealing a secret needs a sign-in with MFA, so the spec that signs
 * in through an Entra-profile IdP reveals one here.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { uiBase } from "../fixtures/api-base.js";

export class VaultPage {
  readonly page: Page;
  readonly entries: Locator;
  /** The opened entry's Plaintext section. */
  readonly plaintext: Locator;
  readonly revealButton: Locator;
  readonly copyButton: Locator;
  readonly revealError: Locator;

  constructor(page: Page) {
    this.page = page;
    this.entries = page.getByRole("table", { name: "Vault entries" });
    this.plaintext = page.getByTestId("vault-entry-reveal");
    this.revealButton = this.plaintext.getByRole("button", { name: "Reveal (audited)" });
    this.copyButton = this.plaintext.getByRole("button", { name: "Copy" });
    this.revealError = this.plaintext.getByRole("alert");
  }

  async goto(): Promise<void> {
    await this.page.goto(`${uiBase()}/vault`);
    await expect(this.entries).toBeVisible();
  }

  /** Open the entry whose row shows `label`. */
  async open(label: string): Promise<void> {
    await this.entries
      .getByRole("row")
      .filter({ hasText: label })
      .getByRole("button", { name: "Open" })
      .click();
    await expect(this.page.getByRole("heading", { name: label, exact: true })).toBeVisible();
  }
}
