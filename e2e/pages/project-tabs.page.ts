/**
 * Project tab-bar page object (#28, epic #26; R1 #156).
 *
 * The tabs follow the pipeline — Overview · Sources · Analyze · Requirements ·
 * Docs · Publish · Code · ⚙ — each a direct link, with the active section's
 * pages in a sub-nav beneath. There is no "More" overflow. Below `md` the bar
 * collapses into a single dropdown.
 *
 * See ui/src/components/projects/project-tabs.tsx for the source of truth.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class ProjectTabsPage {
  readonly page: Page;
  /** The primary bar, `<nav aria-label="Project sections">`. */
  readonly nav: Locator;
  /** The active section's pages, `<nav aria-label="<Section> pages">`. */
  readonly subnav: Locator;
  /** Sub-`md` single-dropdown trigger. */
  readonly mobileTrigger: Locator;

  constructor(page: Page) {
    this.page = page;
    this.nav = page.getByRole("navigation", { name: "Project sections" });
    this.subnav = page.getByTestId("project-subnav");
    this.mobileTrigger = page.getByTestId("project-tabs-mobile");
  }

  /** A primary tab by its accessible name ("Overview", "Sources", …, "Settings"). */
  primaryLink(name: string): Locator {
    return this.nav.getByRole("link", { name, exact: true });
  }

  /** A page link in the active section's sub-nav. */
  subnavLink(name: string): Locator {
    return this.subnav.getByRole("link", { name, exact: true });
  }

  /** A menu item inside the open mobile dropdown. */
  menuItem(name: string): Locator {
    return this.page.getByRole("menuitem", { name, exact: true });
  }

  /** Open a section from the tab bar, then one of its pages from the sub-nav. */
  async openPage(section: string, pageName: string): Promise<void> {
    await this.primaryLink(section).click();
    await this.subnavLink(pageName).click();
  }

  async openMobileMenu(): Promise<void> {
    await this.mobileTrigger.click();
  }

  async expectVisible(): Promise<void> {
    await expect(this.nav).toBeVisible({ timeout: 15_000 });
  }
}
