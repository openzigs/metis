/**
 * Impact result "files to edit" page object — #1762.
 *
 * The edit-candidate part of one impact card on `/impact-analyses/:id`: the
 * files to edit, each with what found it, the AI's checked reason and code
 * line, a doubtful badge, and the "not found" message.
 *
 * Locators are text- and role-first where the markup exposes them, and fall
 * back to the components' stable `data-testid` hooks for structure.
 */
import { type Locator, type Page } from "@playwright/test";

export class ImpactEditCandidatesPage {
  readonly page: Page;
  readonly detailRoot: Locator;
  readonly card: Locator;
  readonly headline: Locator;
  readonly editCandidates: Locator;
  readonly files: Locator;
  readonly notFound: Locator;
  readonly blastRadius: Locator;

  constructor(page: Page) {
    this.page = page;
    this.detailRoot = page.getByTestId("impact-detail-root");
    this.card = page.getByTestId("project-impact-section").getByTestId("changed-requirement-group");
    this.headline = this.card.getByTestId("impact-headline");
    this.editCandidates = this.card.getByTestId("edit-candidates");
    this.files = this.card.getByTestId("edit-candidate-file-group");
    this.notFound = this.card.getByRole("status").filter({
      hasText: "METIS could not find the code this change touches",
    });
    this.blastRadius = this.card.getByTestId("blast-radius-impacts");
  }

  async goto(analysisId: string): Promise<void> {
    await this.page.goto(`/impact-analyses/${analysisId}`, { waitUntil: "load" });
  }

  /** Each file group's path, in the order shown (the group's first monospace line). */
  async filePaths(): Promise<string[]> {
    const paths: string[] = [];
    for (const group of await this.files.all()) {
      paths.push((await group.locator("p.font-mono").first().textContent()) ?? "");
    }
    return paths;
  }

  /** One file's group, by its path. */
  file(filePath: string): Locator {
    return this.files.filter({ hasText: filePath });
  }

  foundBy(filePath: string): Locator {
    return this.file(filePath).getByTestId("edit-candidate-found-by");
  }

  why(filePath: string): Locator {
    return this.file(filePath).getByTestId("edit-candidate-why");
  }

  code(filePath: string): Locator {
    return this.file(filePath).getByTestId("edit-candidate-code");
  }

  doubtfulBadge(filePath: string): Locator {
    return this.file(filePath).getByTestId("edit-candidate-doubtful");
  }
}
