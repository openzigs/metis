/**
 * #2060 — page object for the analysis view's Governing rules panel (#1876,
 * `ui/src/components/analysis/governing-findings-panel.tsx`) on the Findings
 * tab, and the clarifying question a Needs BA input finding links to on the
 * Questions tab.
 *
 * Accessible locators only (`e2e/README.md`): the panel is the region named by
 * its "Governing rules" heading, each requirement's findings a named group,
 * each finding an article named "<control id>: <status>", and its clause, note
 * and decision note are found by their labels.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export type GoverningStatusLabel = "Compliant" | "Gap" | "Needs BA input";

export class GoverningFindingsPage {
  readonly page: Page;
  readonly panel: Locator;
  /** #2339 — the panel's way to the workspace's Governing documents page. */
  readonly workspaceDocumentsLink: Locator;

  constructor(page: Page) {
    this.page = page;
    this.panel = page.getByRole("region", { name: "Governing rules" });
    this.workspaceDocumentsLink = this.panel.getByRole("link", {
      name: "Open this workspace's governing documents",
    });
  }

  /** Open the project's latest run on the Findings tab and wait for the panel. */
  async goto(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/analysis?tab=findings`, { waitUntil: "load" });
    await expect(this.page.getByRole("heading", { name: /^Requirements Analysis —/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(this.panel).toBeVisible({ timeout: 30_000 });
  }

  async reload(): Promise<void> {
    await this.page.reload({ waitUntil: "load" });
    await expect(this.panel).toBeVisible({ timeout: 30_000 });
  }

  /** The summary sentence of the cited revision. */
  summary(text: string): Locator {
    return this.panel.getByText(text, { exact: false });
  }

  /** One requirement's findings. */
  requirementGroup(requirementId: string): Locator {
    return this.panel.getByRole("group", { name: `Governing rules for ${requirementId}` });
  }

  /** One finding, named by its control id and status. */
  finding(controlId: string, status: GoverningStatusLabel): Locator {
    return this.panel.getByRole("article", { name: `${controlId}: ${status}` });
  }

  /** The status badge, whose screen-reader text reads "Status: <label>". */
  statusBadge(finding: Locator, status: GoverningStatusLabel): Locator {
    return finding.getByText(`Status: ${status}`, { exact: true });
  }

  controlId(finding: Locator, controlId: string): Locator {
    return finding.getByText(controlId, { exact: true });
  }

  /** The quoted clause, labelled "Clause <clause ref>". */
  clause(finding: Locator, clauseRef: string): Locator {
    return finding.getByLabel(`Clause ${clauseRef}`, { exact: true });
  }

  noteInput(finding: Locator, controlId: string): Locator {
    return finding.getByLabel(`Note for ${controlId} (optional)`, { exact: true });
  }

  acceptButton(finding: Locator): Locator {
    return finding.getByRole("button", { name: "Accept", exact: true });
  }

  rejectButton(finding: Locator): Locator {
    return finding.getByRole("button", { name: "Reject", exact: true });
  }

  /**
   * "Accepted by <name> on <date>" / "Rejected by …": the line whose text
   * holds "<decision> by <name>" (a substring match: the date is the locale's).
   */
  decisionLine(finding: Locator, decision: "Accepted" | "Rejected", deciderName: string): Locator {
    return finding.getByText(`${decision} by ${deciderName}`);
  }

  /** The decision's note, quoted. */
  decisionNote(finding: Locator): Locator {
    return finding.getByLabel("Decision note", { exact: true });
  }

  clarifyingQuestionLink(finding: Locator): Locator {
    return finding.getByRole("link", { name: "Answer the clarifying question", exact: true });
  }

  /** Accept or Reject a finding with a note, and wait for the server's read-back. */
  async decide(
    finding: Locator,
    controlId: string,
    decision: "Accepted" | "Rejected",
    note: string,
    deciderName: string,
  ): Promise<void> {
    await this.noteInput(finding, controlId).fill(note);
    const button =
      decision === "Accepted" ? this.acceptButton(finding) : this.rejectButton(finding);
    await button.click();
    // Nothing is shown optimistically: the line appears once the findings are read back.
    await expect(this.decisionLine(finding, decision, deciderName)).toBeVisible({
      timeout: 15_000,
    });
  }

  /** The Questions tab, selected. */
  get questionsTab(): Locator {
    return this.page.getByRole("tab", { name: /^Questions/, selected: true });
  }

  /** A clarifying question's answer box, labelled by the question itself. */
  questionAnswer(question: string): Locator {
    return this.page.getByLabel(question, { exact: true });
  }
}
