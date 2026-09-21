/**
 * App-shell page object for the UI Information-Architecture overhaul (Epic #133).
 *
 * Encapsulates the authed shell chrome: the grouped sidebar (N1 #140), the
 * consolidated breadcrumb header that replaced the dual workspace/project
 * switcher (N7 #152), and the icon-only header controls whose accessible names
 * are asserted by the a11y suite (A1 #149).
 *
 * Locators are user-facing only (role / label / testid) so DOM refactors don't
 * break the contract.
 */
import { expect, type Locator, type Page } from "@playwright/test";

/** Canonical grouped sidebar sections (N1 #140 — see ui/src/lib/navigation.ts). */
export const SIDEBAR_SECTIONS = ["Work", "Knowledge", "Automation", "Platform"] as const;
export type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];

export class AppShellPage {
  readonly page: Page;
  /** Persistent desktop sidebar (md+ only). */
  readonly sidebar: Locator;
  /** Mobile navigation drawer (Radix Sheet). */
  readonly mobileDrawer: Locator;
  /** Icon-only hamburger that opens the mobile drawer (md-and-below only). */
  readonly menuButton: Locator;
  /** Consolidated breadcrumb nav in the header (N7 #152). */
  readonly breadcrumb: Locator;
  readonly workspaceCrumb: Locator;
  readonly projectCrumb: Locator;
  readonly notificationsButton: Locator;
  readonly themeToggle: Locator;
  /** Persistent Help affordance — icon button right of the theme toggle (#661). */
  readonly helpButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.sidebar = page.getByTestId("sidebar");
    this.mobileDrawer = page.getByTestId("sidebar-drawer");
    this.menuButton = page.getByRole("button", { name: "Open navigation" });
    this.breadcrumb = page.getByTestId("header-breadcrumb");
    // WorkspaceSwitcher trigger — text-labeled ghost button.
    this.workspaceCrumb = this.breadcrumb.getByRole("button", { name: /Workspace/ });
    // ProjectSwitcher trigger — aria-label="Active project: <name>".
    this.projectCrumb = this.breadcrumb.getByRole("button", { name: /^Active project:/ });
    this.notificationsButton = page.getByTestId("notifications-bell");
    this.themeToggle = page.getByRole("button", { name: "Toggle theme" });
    this.helpButton = page.getByTestId("help-trigger");
  }

  /** Heading element for a grouped sidebar section (e.g. "Knowledge"). */
  sectionHeading(name: SidebarSection): Locator {
    return this.sidebar.getByRole("heading", { name, exact: true });
  }

  /** A navigation link inside the desktop sidebar, scoped so it never collides
   * with same-named links elsewhere (e.g. the project tab "Documents"). */
  navLink(name: string): Locator {
    return this.sidebar.getByRole("link", { name, exact: true });
  }

  async expectLoaded(): Promise<void> {
    await expect(this.sidebar).toBeVisible({ timeout: 15_000 });
    await expect(this.breadcrumb).toBeVisible();
  }

  async openMobileDrawer(): Promise<void> {
    await this.menuButton.click();
    await expect(this.mobileDrawer).toBeVisible();
  }
}
