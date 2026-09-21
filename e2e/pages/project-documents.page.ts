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
    this.addHeading = page.getByRole("heading", { name: "Add documents" });
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
}
