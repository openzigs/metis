/**
 * Page object for the Analysis page's finding cards — Epic #176 (Issues #177 /
 * #180). Encapsulates:
 *   - the persona-attribution chip rendered on each finding card (Layer 1,
 *     #177): avatar + name + role, with a flat fallback to the raw agent key,
 *   - the per-finding "Deep Dive → Issue" action and the dialog it opens
 *     (Layer 2, #180): the editable issue draft, publish action, resulting
 *     issue link(s), and the loading / error / disabled states.
 *
 * Locators are accessible-only: roles, labels, text, and the `data-testid` /
 * `data-agent-key` hooks the PR ships as its explicit e2e test contract
 * (`PersonaTag`, `DeepDiveDialog`). No CSS-class or XPath identification.
 */
import { type Locator, type Page, expect } from "@playwright/test";

export class AnalysisFindingsPage {
  readonly page: Page;

  // ── Page + findings region ─────────────────────────────────────────────
  readonly heading: Locator;
  readonly findingsHeading: Locator;
  readonly noFindings: Locator;

  // ── Deep Dive dialog ───────────────────────────────────────────────────
  readonly dialog: Locator;
  readonly dialogLoading: Locator;
  readonly dialogError: Locator;
  readonly dialogRetry: Locator;
  readonly titleInput: Locator;
  readonly problemInput: Locator;
  readonly filesInput: Locator;
  readonly reqsInput: Locator;
  readonly criteriaInput: Locator;
  readonly labelsInput: Locator;
  readonly publishButton: Locator;
  readonly cancelButton: Locator;
  readonly links: Locator;
  readonly linkItems: Locator;

  constructor(page: Page) {
    this.page = page;

    this.heading = page.getByRole("heading", { name: /^Requirements Analysis —/ });
    this.findingsHeading = page
      .getByTestId("findings-section")
      .getByRole("heading", { name: "Findings", exact: true });
    this.noFindings = page.getByText("No findings yet.", { exact: true });

    this.dialog = page.getByTestId("deep-dive-dialog");
    this.dialogLoading = page.getByTestId("deep-dive-loading");
    this.dialogError = page.getByTestId("deep-dive-error");
    this.dialogRetry = page.getByTestId("deep-dive-retry");
    this.titleInput = page.getByTestId("deep-dive-title");
    this.problemInput = page.getByTestId("deep-dive-problem");
    this.filesInput = page.getByTestId("deep-dive-files");
    this.reqsInput = page.getByTestId("deep-dive-reqs");
    this.criteriaInput = page.getByTestId("deep-dive-criteria");
    this.labelsInput = page.getByTestId("deep-dive-labels");
    this.publishButton = page.getByTestId("deep-dive-publish");
    this.cancelButton = this.dialog.getByRole("button", { name: /Cancel|Close/ });
    this.links = page.getByTestId("deep-dive-links");
    this.linkItems = page.getByTestId("deep-dive-link");
  }

  async goto(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/analysis`, { waitUntil: "load" });
    await expect(this.heading).toBeVisible({ timeout: 30_000 });
  }

  /** A finding's title text (rendered exactly, one per seeded finding). */
  findingTitle(title: string): Locator {
    return this.page.getByText(title, { exact: true });
  }

  // ── Persona attribution (Layer 1, #177) ────────────────────────────────

  /**
   * The persona chip for a given agent key. The chip carries both
   * `data-testid="persona-tag"` and `data-agent-key="<key>"`, so the two are
   * combined to address a single finding's chip without depending on DOM
   * structure. Scope to the card region (not the dialog) so card assertions
   * are stable when the dialog is closed.
   */
  personaTag(agentKey: string): Locator {
    return this.page
      .getByTestId("persona-tag")
      .and(this.page.locator(`[data-agent-key="${agentKey}"]`));
  }

  personaName(agentKey: string): Locator {
    return this.personaTag(agentKey).getByTestId("persona-tag-name");
  }

  personaRole(agentKey: string): Locator {
    return this.personaTag(agentKey).getByTestId("persona-tag-role");
  }

  /** All persona chips on the page (one per finding card in the flat list). */
  allPersonaTags(): Locator {
    return this.page.getByTestId("persona-tag");
  }

  // ── Deep Dive action (Layer 2, #180) ────────────────────────────────────

  /**
   * The finding card containing `title`. Filtering a generic `div` by its
   * accessible content (the title text) *and* the deep-dive action button
   * matches the card and all its ancestors; the innermost match (`.last()`)
   * is the card itself.
   */
  findingCard(title: string): Locator {
    return this.page
      .locator("div")
      .filter({ has: this.page.getByText(title, { exact: true }) })
      .filter({ has: this.page.getByTestId("deep-dive-action") })
      .last();
  }

  deepDiveButton(title: string): Locator {
    return this.findingCard(title).getByTestId("deep-dive-action");
  }

  async openDeepDive(title: string): Promise<void> {
    await this.deepDiveButton(title).click();
    await expect(this.dialog).toBeVisible();
  }

  /** The persona chip shown inside the dialog header. */
  get dialogPersona(): Locator {
    return this.dialog.getByTestId("persona-tag");
  }

  async fillDraft(fields: {
    title?: string;
    problem?: string;
    files?: string;
    reqs?: string;
    criteria?: string;
    labels?: string;
  }): Promise<void> {
    if (fields.title !== undefined) await this.titleInput.fill(fields.title);
    if (fields.problem !== undefined) await this.problemInput.fill(fields.problem);
    if (fields.files !== undefined) await this.filesInput.fill(fields.files);
    if (fields.reqs !== undefined) await this.reqsInput.fill(fields.reqs);
    if (fields.criteria !== undefined) await this.criteriaInput.fill(fields.criteria);
    if (fields.labels !== undefined) await this.labelsInput.fill(fields.labels);
  }

  async publish(): Promise<void> {
    await this.publishButton.click();
  }

  /** A created-issue link by its rendered "provider: key" label. */
  link(label: string): Locator {
    return this.linkItems.filter({ hasText: label });
  }
}
