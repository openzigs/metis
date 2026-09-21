/**
 * Project tab-bar page object (N2 #142 / N3 #141 / R1 #156).
 *
 * The former 17-item horizontal-scroll tab bar was collapsed into a small set
 * of primary tabs plus a "More" overflow menu on desktop, and a single
 * dropdown on sub-`md` viewports. This POM exposes both surfaces.
 *
 * See ui/src/components/projects/project-tabs.tsx for the source of truth.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class ProjectTabsPage {
  readonly page: Page;
  readonly nav: Locator;
  /** Desktop "More" overflow trigger. */
  readonly moreTrigger: Locator;
  /** Sub-`md` single-dropdown trigger. */
  readonly mobileTrigger: Locator;

  constructor(page: Page) {
    this.page = page;
    this.nav = page.getByTestId("project-tabs");
    this.moreTrigger = page.getByTestId("project-tabs-more");
    this.mobileTrigger = page.getByTestId("project-tabs-mobile");
  }

  /** A primary inline tab rendered as a direct link (Overview / Documents / Analysis). */
  primaryLink(name: string): Locator {
    return this.nav.getByRole("link", { name, exact: true });
  }

  /** A primary tab that is a grouped dropdown (Code / Quality / Docs). */
  groupTrigger(label: string): Locator {
    return this.nav.getByTestId(`project-tab-group-${label.toLowerCase()}`);
  }

  /** A menu item inside any open Radix dropdown (overflow or group). */
  menuItem(name: string): Locator {
    return this.page.getByRole("menuitem", { name, exact: true });
  }

  async openMore(): Promise<void> {
    await this.moreTrigger.click();
  }

  async openGroup(label: string): Promise<void> {
    await this.groupTrigger(label).click();
  }

  async openMobileMenu(): Promise<void> {
    await this.mobileTrigger.click();
  }

  async expectVisible(): Promise<void> {
    await expect(this.nav).toBeVisible({ timeout: 15_000 });
  }
}
