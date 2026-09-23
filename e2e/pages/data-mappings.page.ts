/**
 * Page object for the requirement "Data mappings" panel — Epic #889 (#894).
 *
 * The panel (`ui/src/components/traceability/data-mappings-panel.tsx`) renders
 * inline under each requirement on `/projects/:id/analysis`, next to the
 * findings / requirements review section. It lists linked tables/columns with
 * a confidence badge, exposes an add-mapping form, per-row remove controls, and
 * a "Suggest mappings" button that surfaces LLM candidates with an Accept
 * control.
 *
 * All locators are accessible-by-role / by-label. The panel exposes itself as a
 * landmark `region` with the accessible name "Data mappings" (a `<section>` with
 * an `aria-label`). The suggestions block is a nested `<div aria-label="Suggested
 * data mappings">` — a plain div has no implicit `region` role, so it is located
 * by its `data-mapping-suggestions` test id rather than by role.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class DataMappingsPage {
  readonly page: Page;

  /** The panel landmark for a single requirement. */
  readonly panel: Locator;
  readonly heading: Locator;
  readonly addMappingButton: Locator;
  readonly cancelButton: Locator;
  readonly suggestButton: Locator;
  readonly emptyState: Locator;

  /** Linked-mappings list + rows. */
  readonly linkedList: Locator;
  readonly mappingRows: Locator;

  /** Add-mapping form fields. */
  readonly connectorSelect: Locator;
  readonly schemaInput: Locator;
  readonly tableInput: Locator;
  readonly columnInput: Locator;
  readonly noteInput: Locator;
  readonly saveButton: Locator;

  /** Suggestions block. */
  readonly suggestionsRegion: Locator;
  readonly suggestionNote: Locator;
  readonly candidates: Locator;

  constructor(page: Page) {
    this.page = page;
    // `exact: true` is essential: "Suggested data mappings" is also a region
    // and would match a substring "Data mappings".
    this.panel = page.getByRole("region", { name: "Data mappings", exact: true });
    this.heading = this.panel.getByRole("heading", { name: "Data mappings" });
    this.addMappingButton = this.panel.getByRole("button", { name: "Add mapping" });
    this.cancelButton = this.panel.getByRole("button", { name: "Cancel" });
    this.suggestButton = this.panel.getByRole("button", { name: "Suggest mappings" });
    this.emptyState = this.panel.getByText("No data mappings linked yet.");

    this.linkedList = this.panel.getByRole("list", { name: "Linked data mappings" });
    this.mappingRows = this.panel.getByTestId("data-mapping-row");

    this.connectorSelect = this.panel.getByLabel("Database connector");
    this.schemaInput = this.panel.getByLabel("Schema");
    this.tableInput = this.panel.getByLabel("Table", { exact: true });
    this.columnInput = this.panel.getByLabel("Column");
    this.noteInput = this.panel.getByLabel("Note");
    this.saveButton = this.panel.getByRole("button", { name: "Save mapping" });

    // The suggestions block is a nested <div aria-label> inside the panel —
    // not a landmark region — so locate it by its stable test id.
    this.suggestionsRegion = this.panel.getByTestId("data-mapping-suggestions");
    this.suggestionNote = this.suggestionsRegion.getByRole("status");
    this.candidates = this.suggestionsRegion.getByTestId("data-mapping-candidate");
  }

  /** Navigate to the analysis tab; the most recent run auto-selects. */
  async goto(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/analysis`);
    await expect(this.panel).toBeVisible({ timeout: 30_000 });
  }

  /** Open the add-mapping form (idempotent). */
  async openAddForm(): Promise<void> {
    if (!(await this.saveButton.isVisible().catch(() => false))) {
      await this.addMappingButton.click();
    }
    await expect(this.saveButton).toBeVisible();
  }

  /** Fill and submit the add-mapping form against a connector chosen by label. */
  async addMapping(opts: {
    connectorLabel: string;
    schema?: string;
    table: string;
    column?: string;
    note?: string;
  }): Promise<void> {
    await this.openAddForm();
    // Radix Select — a button + listbox portal, not a native <select>, so
    // `selectOption` does not apply: open it and pick the option by name.
    await this.connectorSelect.click();
    await this.page.getByRole("option", { name: opts.connectorLabel }).click();
    if (opts.schema) await this.schemaInput.fill(opts.schema);
    await this.tableInput.fill(opts.table);
    if (opts.column) await this.columnInput.fill(opts.column);
    if (opts.note) await this.noteInput.fill(opts.note);
    await this.saveButton.click();
  }

  /** A linked-mapping row narrowed by its target-path text. */
  mappingRow(targetPath: string): Locator {
    return this.mappingRows.filter({ hasText: targetPath });
  }

  /** The Remove button for a given linked mapping (accessible name carries the path). */
  removeButton(targetPath: string): Locator {
    return this.panel.getByRole("button", { name: `Remove mapping ${targetPath}` });
  }

  /** A suggested candidate row narrowed by its target-path text. */
  candidate(targetPath: string): Locator {
    return this.candidates.filter({ hasText: targetPath });
  }

  /** The Accept button for a given suggested candidate. */
  acceptButton(targetPath: string): Locator {
    return this.suggestionsRegion.getByRole("button", {
      name: `Accept suggestion ${targetPath}`,
    });
  }
}
