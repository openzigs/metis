/**
 * Page object for the project Documents management page (N3 #141):
 *   /projects/[id]/documents
 *
 * Covers the header, the "Add documents" affordances (file uploader, URL
 * ingest, text ingest), and the document list / empty state.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class ProjectDocumentsPage {
  readonly page: Page;
  readonly root: Locator;
  readonly heading: Locator;
  readonly addHeading: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.getByTestId("project-documents-root");
    this.heading = page.getByRole("heading", { name: "Documents", exact: true });
    this.addHeading = page.getByRole("heading", { name: "Add documents", exact: true });
  }

  async goto(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/documents`, { waitUntil: "load" });
  }

  async expectLoaded(): Promise<void> {
    await expect(this.root).toBeVisible({ timeout: 20_000 });
    await expect(this.heading).toBeVisible();
  }

  documentList(): Locator {
    return this.page.getByTestId("document-list");
  }

  emptyState(): Locator {
    return this.page.getByText("No documents yet.", { exact: true });
  }

  /** The file uploader dropzone affordance. */
  uploadDropzone(): Locator {
    return this.page.getByTestId("upload-dropzone");
  }

  /** The URL-ingest form (input + submit). */
  urlIngestForm(): Locator {
    return this.page.getByTestId("url-ingest-form");
  }

  /** The paste-text ingest form. */
  textIngestForm(): Locator {
    return this.page.getByTestId("text-ingest-form");
  }

  /** #2547 — one document's row in the list. */
  documentRow(documentId: string): Locator {
    return this.page.getByTestId(`document-row-${documentId}`);
  }

  /** #2547 — the "Restricted" badge on a document's row. */
  restrictedBadge(documentId: string): Locator {
    return this.page.getByTestId(`document-restricted-badge-${documentId}`);
  }

  /** #2547 — the row action that opens the document's access-list editor. */
  accessToggle(documentId: string): Locator {
    return this.page.getByTestId(`document-access-toggle-${documentId}`);
  }

  /**
   * #2547 — restrict a document to one role through its access-list editor.
   * #2555 — the role comes from the role list, and `person` (a display name)
   * is found by searching the project's people and picked, never typed as an id.
   */
  async restrictToRole(documentId: string, role: string, person?: string): Promise<void> {
    await this.accessToggle(documentId).click();
    const editor = this.documentRow(documentId).getByTestId("acl-editor");
    await expect(editor).toBeVisible();
    await editor.getByLabel("Kind", { exact: true }).selectOption("role");
    await editor.getByLabel("Role", { exact: true }).selectOption(role);
    await editor.getByRole("button", { name: "Add", exact: true }).click();
    if (person) {
      await editor.getByLabel("Kind", { exact: true }).selectOption("user");
      await editor.getByLabel("Person", { exact: true }).fill(person);
      await editor.getByRole("button", { name: new RegExp(`^${person}`) }).click();
      await expect(editor.getByTestId("acl-subjects")).toContainText(person);
    }
    await editor.getByRole("button", { name: "Save access list" }).click();
    await expect(editor).toBeHidden({ timeout: 15_000 });
  }
}
