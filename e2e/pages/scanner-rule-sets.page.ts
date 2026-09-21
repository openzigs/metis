/**
 * Page object for the bug-scanner rule-sets editor (Epic #708 / #718):
 *   /projects/[id]/rule-sets
 *
 * The page is rich in stable `data-testid`s (scanner-*), so we lean on them for
 * the form controls and on accessible roles for the heading.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class ScannerRuleSetsPage {
  readonly page: Page;
  readonly root: Locator;
  readonly heading: Locator;
  readonly createCard: Locator;
  readonly newSetName: Locator;
  readonly newSetSubmit: Locator;
  readonly noSets: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.getByTestId("scanner-rule-sets-root");
    this.heading = page.getByRole("heading", { name: "Bug-scanner rule sets" });
    this.createCard = page.getByTestId("scanner-create-set-card");
    this.newSetName = page.getByTestId("scanner-new-set-name");
    this.newSetSubmit = page.getByTestId("scanner-new-set-submit");
    this.noSets = page.getByTestId("scanner-no-sets");
  }

  async goto(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/rule-sets`, { waitUntil: "load" });
  }

  async expectLoaded(): Promise<void> {
    await expect(this.root).toBeVisible({ timeout: 20_000 });
    await expect(this.heading).toBeVisible();
  }

  /** Card for a created set, addressed by its server id. */
  setCard(setId: string): Locator {
    return this.page.getByTestId(`scanner-set-${setId}`);
  }

  async createRuleSet(name: string): Promise<void> {
    await this.newSetName.fill(name);
    await this.newSetSubmit.click();
  }
}
