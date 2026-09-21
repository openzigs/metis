/**
 * Page object for the cross-project requirement links panel — Epic #610 (#625).
 *
 * The panel (`ui/src/components/requirements/requirement-links-panel.tsx`) renders
 * inline under each requirement on `/projects/:id/analysis`. It lists a
 * requirement's typed links in both directions with a distinct project badge +
 * deep-link for cross-project counterparts, and hosts the add-link dialog: a
 * link-type picker plus a workspace-scoped, debounced requirement search.
 *
 * These specs seed exactly ONE requirement per project, so the panel / dialog
 * locators are unique on the page and need no per-requirement scoping. Locators
 * are accessible-by-role / by-label / by-test-id.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class RequirementLinksPage {
  readonly page: Page;

  readonly panel: Locator;
  readonly addLinkButton: Locator;
  readonly dialog: Locator;
  readonly searchInput: Locator;
  readonly linkRows: Locator;
  readonly crossProjectBadge: Locator;
  readonly noResults: Locator;

  constructor(page: Page) {
    this.page = page;
    this.panel = page.getByTestId("requirement-links-panel");
    this.addLinkButton = this.panel.getByRole("button", { name: "Add link" });
    // Radix derives the dialog's accessible name from its <DialogTitle> ("Link a
    // requirement"), which overrides the container's aria-label. Only one dialog
    // is ever open at a time, so an unnamed role match is unambiguous.
    this.dialog = page.getByRole("dialog");
    this.searchInput = this.dialog.getByLabel("Search requirements");
    this.linkRows = this.panel.getByTestId("requirement-link-row");
    this.crossProjectBadge = this.panel.getByTestId("cross-project-badge");
    this.noResults = this.dialog.getByText("No matching requirements found.");
  }

  /** Navigate to the analysis tab; the most recent run auto-selects. */
  async goto(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/analysis`);
    await expect(this.panel).toBeVisible({ timeout: 30_000 });
  }

  /** Open the add-link dialog (idempotent). */
  async openAddDialog(): Promise<void> {
    if (!(await this.dialog.isVisible().catch(() => false))) {
      await this.addLinkButton.click();
    }
    await expect(this.dialog).toBeVisible({ timeout: 15_000 });
  }

  /** Type a search term; the panel debounces (300ms) before querying. */
  async search(term: string): Promise<void> {
    await this.searchInput.fill(term);
  }

  /** A search-result "Link" button, narrowed to a specific requirement title. */
  resultLinkButton(title: string): Locator {
    return this.dialog.getByRole("button", { name: `Link to ${title}` });
  }

  /** Search for and link the requirement whose title matches `title`. */
  async linkTo(title: string): Promise<void> {
    await this.search(title);
    const link = this.resultLinkButton(title);
    await expect(link).toBeVisible({ timeout: 15_000 });
    await link.click();
    // The dialog closes and the panel refreshes on a successful create.
    await expect(this.dialog).toBeHidden({ timeout: 15_000 });
  }

  /** A rendered link row that carries a cross-project badge for `projectName`. */
  crossProjectRow(projectName: string): Locator {
    return this.linkRows.filter({ hasText: projectName });
  }
}
