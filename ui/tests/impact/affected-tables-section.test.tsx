import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import type { ImpactAffectedTableView, ImpactTableFeedbackView } from "@metis/shared";
import { AffectedTablesSection } from "@/components/impact/affected-tables-section";

function feedbackEntry(over: Partial<ImpactTableFeedbackView> = {}): ImpactTableFeedbackView {
  return {
    id: "fb-1",
    impactItemId: "item-1",
    tableName: "crm.customers",
    columnName: null,
    verdict: "relevant",
    userId: "user-1",
    userDisplayName: "alice",
    createdAt: "2026-07-20T00:00:00.000Z",
    ...over,
  };
}

function tableEntry(over: Partial<ImpactAffectedTableView> = {}): ImpactAffectedTableView {
  return {
    id: "t-1",
    objectKind: "table",
    tableName: "crm.customers",
    columnName: null,
    columnType: null,
    changeKind: "reference",
    suggestedDdl: "-- Verify table crm.customers — referenced by impacted code",
    source: "mybatis",
    reconciliation: "matched",
    confidence: 0.85,
    ...over,
  };
}

describe("AffectedTablesSection", () => {
  it("renders nothing when there are no affected tables", () => {
    const { container } = render(<AffectedTablesSection tables={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("groups columns under their table and shows suggested DDL in a pre", () => {
    render(
      <AffectedTablesSection
        tables={[
          tableEntry(),
          tableEntry({
            id: "c-1",
            objectKind: "column",
            columnName: "email_address",
            columnType: "varchar(255)",
            source: "live-db",
            suggestedDdl:
              "-- Verify column crm.customers.email_address — referenced by impacted code",
          }),
        ]}
      />,
    );
    const group = screen.getByTestId("schema-impact-table");
    expect(group).toHaveAttribute("data-table-name", "crm.customers");
    expect(within(group).getByTestId("schema-impact-column")).toHaveAttribute(
      "data-column-name",
      "email_address",
    );
    const ddls = screen.getAllByTestId("schema-suggested-ddl");
    expect(ddls[0].tagName).toBe("PRE");
    expect(screen.getByText("varchar(255)")).toBeInTheDocument();
  });

  it("shows a Live DB provenance badge for live-db sources", () => {
    render(<AffectedTablesSection tables={[tableEntry({ source: "live-db" })]} />);
    const badge = screen.getByTestId("schema-provenance-badge");
    expect(badge).toHaveAttribute("data-source", "live-db");
    expect(badge).toHaveTextContent("Live DB");
  });

  it("labels inferred sources distinctly", () => {
    render(<AffectedTablesSection tables={[tableEntry({ source: "orm" })]} />);
    expect(screen.getByTestId("schema-provenance-badge")).toHaveTextContent("Inferred · ORM");
  });

  it("flags reconciliation mismatches", () => {
    render(
      <AffectedTablesSection
        tables={[
          tableEntry({
            id: "c-2",
            columnName: "nickname",
            changeKind: "add-column",
            reconciliation: "column-not-found",
            suggestedDdl: "ALTER TABLE crm.customers ADD COLUMN nickname <type>;",
          }),
        ]}
      />,
    );
    const flag = screen.getByTestId("schema-reconciliation-flag");
    expect(flag).toHaveAttribute("data-reconciliation", "column-not-found");
    expect(screen.getByTestId("schema-change-kind")).toHaveTextContent("add-column");
  });

  // Issue #958 — a live-DB match on a column: the field already exists, so a
  // BA should be told to verify whether the requirement is already implemented
  // instead of seeing a bare "reference" row with no signal.
  it("surfaces an 'already exists' badge for a matched column (#958)", () => {
    render(
      <AffectedTablesSection
        tables={[
          tableEntry(),
          tableEntry({
            id: "c-3",
            objectKind: "column",
            columnName: "email_address",
            columnType: "varchar(255)",
            source: "live-db",
            changeKind: "reference",
            reconciliation: "matched",
            suggestedDdl:
              "-- Verify column crm.customers.email_address — referenced by impacted code",
          }),
        ]}
      />,
    );
    const flag = screen.getByTestId("schema-reconciliation-flag");
    expect(flag).toHaveAttribute("data-reconciliation", "matched");
    expect(flag).toHaveTextContent("Already exists in live schema");
    expect(flag).not.toHaveClass("bg-destructive"); // non-destructive styling
  });

  // Issue #958 — a matched TABLE-level row (no columnName) carries no "already
  // implemented" signal by itself, so it must NOT show the badge — additive
  // only, never regresses the existing table-level matched rendering.
  it("does not show an 'already exists' badge for a matched table-level row", () => {
    render(<AffectedTablesSection tables={[tableEntry({ reconciliation: "matched" })]} />);
    expect(screen.queryByTestId("schema-reconciliation-flag")).not.toBeInTheDocument();
  });

  it("renders affected procedures/functions in their own section with a verify-only note (#302)", () => {
    render(
      <AffectedTablesSection
        tables={[
          tableEntry(),
          tableEntry({
            id: "fn-1",
            objectKind: "function",
            tableName: "app.calc_total",
            source: "live-db",
            reconciliation: null,
            suggestedDdl:
              "-- Verify function app.calc_total — invoked by impacted code (body not analyzed; Phase 3)",
          }),
          tableEntry({
            id: "p-1",
            objectKind: "procedure",
            tableName: "app.do_sync",
            source: "live-db",
            reconciliation: null,
            suggestedDdl:
              "-- Verify procedure app.do_sync — invoked by impacted code (body not analyzed; Phase 3)",
          }),
        ]}
      />,
    );
    const routinesSection = screen.getByTestId("schema-impact-routines-section");
    const rows = within(routinesSection).getAllByTestId("schema-impact-routine");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("data-routine-name", "app.calc_total");
    expect(within(rows[0]).getByTestId("schema-routine-kind")).toHaveTextContent("function");
    // The note is verify-only — no drop/alter affordance anywhere.
    const note = within(rows[0]).getByTestId("schema-routine-note");
    expect(note.tagName).toBe("PRE");
    expect(note).not.toHaveTextContent(/DROP|ALTER/);
  });

  it("does not render the routines section when there are no routines (#302)", () => {
    render(<AffectedTablesSection tables={[tableEntry()]} />);
    expect(screen.queryByTestId("schema-impact-routines-section")).not.toBeInTheDocument();
  });

  // Epic #295 Phase 4 (#310) — cross-project "used by N projects" indicator.
  it("shows a 'used by N other projects' badge when cross-project usage is provided", () => {
    render(
      <AffectedTablesSection
        tables={[tableEntry()]}
        crossProjectUsage={{
          "crm.customers": [
            { projectId: "p-2", projectName: "Beta", usageClass: "used", evidenceCount: 3 },
            { projectId: "p-3", projectName: "Gamma", usageClass: "uncertain", evidenceCount: 0 },
          ],
        }}
      />,
    );
    const badge = screen.getByTestId("cross-project-used-by");
    expect(badge).toHaveAttribute("data-project-count", "2");
    expect(badge).toHaveTextContent("used by 2 other projects");
    expect(badge).toHaveAttribute("title", expect.stringContaining("Beta, Gamma"));
  });

  it("singularizes the cross-project badge for a single project", () => {
    render(
      <AffectedTablesSection
        tables={[tableEntry()]}
        crossProjectUsage={{
          "crm.customers": [
            { projectId: "p-2", projectName: "Beta", usageClass: "used", evidenceCount: 1 },
          ],
        }}
      />,
    );
    expect(screen.getByTestId("cross-project-used-by")).toHaveTextContent(
      "used by 1 other project",
    );
  });

  it("renders no cross-project badge when usage map is absent or empty for the object", () => {
    render(<AffectedTablesSection tables={[tableEntry()]} crossProjectUsage={{}} />);
    expect(screen.queryByTestId("cross-project-used-by")).not.toBeInTheDocument();
  });

  // #950 — surface the #936 LLM relevance tier + rationale on primary tables.
  it("renders a relevance-tier badge (#950)", () => {
    render(
      <AffectedTablesSection
        tables={[
          tableEntry({
            relevanceTier: "likely",
            relevanceRationale: "Directly written by the changed persistence code.",
          }),
        ]}
      />,
    );
    const badge = screen.getByTestId("schema-relevance-tier");
    expect(badge).toHaveAttribute("data-relevance-tier", "likely");
    expect(badge).toHaveTextContent("Likely");
    // Issue #985 review follow-up — the rationale renders visibly via
    // RelevanceRationale (asserted below), so the badge must NOT also carry it
    // as a `title`; a redundant `title` would double-announce the same
    // sentence to screen readers.
    expect(badge).not.toHaveAttribute("title");
  });

  it("labels the possible tier distinctly (#950)", () => {
    render(<AffectedTablesSection tables={[tableEntry({ relevanceTier: "possible" })]} />);
    const badge = screen.getByTestId("schema-relevance-tier");
    expect(badge).toHaveAttribute("data-relevance-tier", "possible");
    expect(badge).toHaveTextContent("Possibly related");
  });

  // #1022 — the tangential (secondary) bucket is all `unlikely`; the badge +
  // rationale must render so the UI matches the Markdown export, which shows
  // `relevance: unlikely related` plus the rationale for these same tables.
  it("labels the unlikely tier and renders its rationale for the tangential bucket (#1022)", () => {
    render(
      <AffectedTablesSection
        tables={[
          tableEntry({
            relevanceTier: "unlikely",
            relevanceRationale: "Catalog data itself is not affected by the loyalty change.",
          }),
        ]}
      />,
    );
    const badge = screen.getByTestId("schema-relevance-tier");
    expect(badge).toHaveAttribute("data-relevance-tier", "unlikely");
    expect(badge).toHaveTextContent("Unlikely related");
    const rationale = screen.getByTestId("schema-relevance-rationale");
    expect(rationale).toHaveTextContent(
      "Catalog data itself is not affected by the loyalty change.",
    );
  });

  it("sorts likely tables before possible ones, ignoring alphabetical order (#950)", () => {
    render(
      <AffectedTablesSection
        tables={[
          // Alphabetically "a_possible" would come first; tier ordering must win.
          tableEntry({ id: "p", tableName: "a_possible", relevanceTier: "possible" }),
          tableEntry({ id: "l", tableName: "z_likely", relevanceTier: "likely" }),
        ]}
      />,
    );
    const names = screen
      .getAllByTestId("schema-impact-table")
      .map((el) => el.getAttribute("data-table-name"));
    expect(names).toEqual(["z_likely", "a_possible"]);
  });

  it("breaks likely-tier ties by confidence descending (#950)", () => {
    render(
      <AffectedTablesSection
        tables={[
          tableEntry({ id: "lo", tableName: "aaa", relevanceTier: "likely", confidence: 0.2 }),
          tableEntry({ id: "hi", tableName: "zzz", relevanceTier: "likely", confidence: 0.9 }),
        ]}
      />,
    );
    const names = screen
      .getAllByTestId("schema-impact-table")
      .map((el) => el.getAttribute("data-table-name"));
    expect(names).toEqual(["zzz", "aaa"]);
  });

  // Issue #985 (#1) — the LLM rationale must be VISIBLE, not only reachable
  // via the badge's hover `title` (invisible without a mouse: no keyboard/
  // touch path, absent from exports, unannounced to screen readers).
  it("renders the LLM rationale visibly, and not redundantly in the badge title (#985)", () => {
    render(
      <AffectedTablesSection
        tables={[
          tableEntry({
            relevanceTier: "likely",
            relevanceRationale: "Directly written by the changed persistence code.",
          }),
        ]}
      />,
    );
    const rationale = screen.getByTestId("schema-relevance-rationale");
    expect(rationale).toHaveTextContent("Directly written by the changed persistence code.");
    // Review follow-up — the badge must NOT also carry the rationale as a
    // `title`; that would double-announce the identical sentence to screen
    // readers now that it renders as visible text right below the badge.
    expect(screen.getByTestId("schema-relevance-tier")).not.toHaveAttribute("title");
  });

  it("tokenizes backticked identifiers in the rationale as inline <code> (#985 #3)", () => {
    render(
      <AffectedTablesSection
        tables={[
          tableEntry({
            relevanceTier: "possible",
            relevanceRationale: "Cancelling restores `crm.customers.loyalty_points`.",
          }),
        ]}
      />,
    );
    const rationale = screen.getByTestId("schema-relevance-rationale");
    const code = within(rationale).getByText("crm.customers.loyalty_points");
    expect(code.tagName).toBe("CODE");
  });

  it("omits the rationale block when there is no rationale text", () => {
    render(<AffectedTablesSection tables={[tableEntry({ relevanceTier: "likely" })]} />);
    expect(screen.queryByTestId("schema-relevance-rationale")).not.toBeInTheDocument();
  });

  it("omits the rationale block when the tier is null, even if a rationale exists", () => {
    render(
      <AffectedTablesSection
        tables={[
          tableEntry({ relevanceTier: null, relevanceRationale: "Would-be rationale text." }),
        ]}
      />,
    );
    expect(screen.queryByTestId("schema-relevance-rationale")).not.toBeInTheDocument();
  });

  it("renders no tier badge and keeps alphabetical order when tier is null (#950)", () => {
    render(
      <AffectedTablesSection
        tables={[
          tableEntry({ id: "b", tableName: "b_table", relevanceTier: null }),
          tableEntry({ id: "a", tableName: "a_table", relevanceTier: null }),
        ]}
      />,
    );
    expect(screen.queryByTestId("schema-relevance-tier")).not.toBeInTheDocument();
    const names = screen
      .getAllByTestId("schema-impact-table")
      .map((el) => el.getAttribute("data-table-name"));
    expect(names).toEqual(["a_table", "b_table"]);
  });

  // Regression guard (#319) — the cross-project Badge renders a <div>, so its
  // table-name container must NOT be a <p>; a <div> inside a <p> is invalid HTML
  // and triggers a React hydration error on every affected table with usage.
  it("does not nest the cross-project badge <div> inside a <p> (no hydration error)", () => {
    render(
      <AffectedTablesSection
        tables={[tableEntry()]}
        crossProjectUsage={{
          "crm.customers": [
            { projectId: "p-2", projectName: "Beta", usageClass: "used", evidenceCount: 3 },
          ],
        }}
      />,
    );
    const badge = screen.getByTestId("cross-project-used-by");
    // The badge itself is a <div> (shared @metis/ui-kit Badge) ...
    expect(badge.tagName).toBe("DIV");
    // ... so neither it nor any ancestor up to the table <li> may be a <p>.
    const tableLi = screen.getByTestId("schema-impact-table");
    for (let node = badge.parentElement; node && node !== tableLi; node = node.parentElement) {
      expect(node.tagName).not.toBe("P");
    }
    // And the table-name span sits in a non-paragraph flex container.
    const nameSpan = screen.getByText("crm.customers");
    expect(nameSpan.parentElement?.tagName).not.toBe("P");
    expect(nameSpan.parentElement?.tagName).toBe("DIV");
  });
});

describe("AffectedTablesSection — #957 DDL risk class + proposed/referenced split", () => {
  it("renders a 'Needs review' risk badge for a breaking change with a tooltip", () => {
    render(
      <AffectedTablesSection
        tables={[
          tableEntry({
            columnName: "ssn",
            changeKind: "drop-column",
            riskClass: "breaking",
            suggestedDdl: "ALTER TABLE crm.customers DROP COLUMN ssn;",
          }),
        ]}
      />,
    );
    const badge = screen.getByTestId("schema-risk-class");
    expect(badge).toHaveAttribute("data-risk-class", "breaking");
    expect(badge).toHaveTextContent("Needs review");
    expect(badge).toHaveAttribute("title", expect.stringContaining("review before applying"));
  });

  it("labels an expanding change as Additive and a neutral reference as Verify only", () => {
    const { rerender } = render(
      <AffectedTablesSection
        tables={[
          tableEntry({ columnName: "nickname", changeKind: "add-column", riskClass: "expanding" }),
        ]}
      />,
    );
    expect(screen.getByTestId("schema-risk-class")).toHaveTextContent("Additive");

    rerender(<AffectedTablesSection tables={[tableEntry({ riskClass: "neutral" })]} />);
    expect(screen.getByTestId("schema-risk-class")).toHaveTextContent("Verify only");
  });

  it("renders no risk badge for legacy rows without a risk class", () => {
    render(<AffectedTablesSection tables={[tableEntry({ riskClass: null })]} />);
    expect(screen.queryByTestId("schema-risk-class")).not.toBeInTheDocument();
  });

  it("surfaces the WORST risk across a table's rows (breaking wins over expanding)", () => {
    render(
      <AffectedTablesSection
        tables={[
          tableEntry({
            id: "c1",
            columnName: "a",
            changeKind: "add-column",
            riskClass: "expanding",
          }),
          tableEntry({
            id: "c2",
            columnName: "b",
            changeKind: "drop-column",
            riskClass: "breaking",
          }),
        ]}
      />,
    );
    const badges = screen.getAllByTestId("schema-risk-class");
    // One badge per table group; it reflects the most severe row.
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveAttribute("data-risk-class", "breaking");
  });

  it("splits proposed-change rows from referenced rows within a table", () => {
    render(
      <AffectedTablesSection
        tables={[
          // A verify-only reference (table-level) + a proposed new column.
          tableEntry(),
          tableEntry({
            id: "c-add",
            objectKind: "column",
            columnName: "loyalty_tier",
            changeKind: "add-column",
            riskClass: "expanding",
            suggestedDdl: "ALTER TABLE crm.customers ADD COLUMN loyalty_tier <type>;",
          }),
          tableEntry({
            id: "c-ref",
            objectKind: "column",
            columnName: "email_address",
            changeKind: "reference",
          }),
        ]}
      />,
    );
    const proposed = screen.getByTestId("proposed-change-block");
    expect(within(proposed).getByTestId("schema-impact-column")).toHaveAttribute(
      "data-column-name",
      "loyalty_tier",
    );
    const referenced = screen.getByTestId("referenced-by-block");
    // The referenced block holds the reference column, not the proposed one.
    expect(within(referenced).getByTestId("schema-impact-column")).toHaveAttribute(
      "data-column-name",
      "email_address",
    );
    expect(within(referenced).queryByText("loyalty_tier")).not.toBeInTheDocument();
  });

  it("renders only a proposed-change block when there are no reference rows", () => {
    render(
      <AffectedTablesSection
        tables={[
          tableEntry({
            id: "c-add",
            columnName: "nickname",
            changeKind: "add-column",
            riskClass: "expanding",
          }),
        ]}
      />,
    );
    expect(screen.getByTestId("proposed-change-block")).toBeInTheDocument();
    expect(screen.queryByTestId("referenced-by-block")).not.toBeInTheDocument();
  });

  it("collapses the referenced block into a <details> beyond five rows", () => {
    const referenced = Array.from({ length: 6 }, (_, i) =>
      tableEntry({
        id: `ref-${i}`,
        objectKind: "column",
        columnName: `col_${i}`,
        changeKind: "reference",
      }),
    );
    render(<AffectedTablesSection tables={referenced} />);
    const block = screen.getByTestId("referenced-by-block");
    expect(block.tagName).toBe("DETAILS");
    expect(block).toHaveAttribute("data-collapsed", "true");
    expect(within(block).getByText(/Referenced by impacted code \(6\)/)).toBeInTheDocument();
  });

  it("does not collapse the referenced block at five rows or fewer", () => {
    const referenced = Array.from({ length: 5 }, (_, i) =>
      tableEntry({
        id: `ref-${i}`,
        objectKind: "column",
        columnName: `col_${i}`,
        changeKind: "reference",
      }),
    );
    render(<AffectedTablesSection tables={referenced} />);
    const block = screen.getByTestId("referenced-by-block");
    expect(block.tagName).toBe("DIV");
  });
});

describe("AffectedTablesSection — #956 cross-project consumers", () => {
  it("renders consumers with usage attribution + tier label (has-consumers state)", () => {
    render(
      <AffectedTablesSection
        tables={[
          tableEntry({
            consumerResolution: "identity",
            consumers: [
              {
                projectId: "reporting",
                projectName: "Reporting",
                usage: "writtenBy",
                objectQualifiedName: "crm.customers",
              },
            ],
          }),
        ]}
      />,
    );
    const block = screen.getByTestId("cross-project-consumers");
    expect(block).toHaveAttribute("data-consumer-state", "has-consumers");
    expect(block).toHaveAttribute("data-consumer-resolution", "identity");
    const row = screen.getByTestId("cross-project-consumer-row");
    expect(row).toHaveAttribute("data-consumer-usage", "writtenBy");
    expect(row).toHaveTextContent("Reporting");
    expect(row).toHaveTextContent("writes via");
    expect(screen.getByTestId("consumer-tier-badge")).toHaveTextContent("verified identity");
  });

  it("labels the string-match tier as lower confidence", () => {
    render(
      <AffectedTablesSection
        tables={[
          tableEntry({
            consumerResolution: "string-match",
            consumers: [
              {
                projectId: "p2",
                projectName: "Other",
                usage: "readBy",
                objectQualifiedName: "crm.customers",
              },
            ],
          }),
        ]}
      />,
    );
    expect(screen.getByTestId("consumer-tier-badge")).toHaveTextContent(
      "name match (lower confidence)",
    );
  });

  it("distinguishes zero-consumers from could-not-verify", () => {
    const { rerender } = render(
      <AffectedTablesSection
        tables={[tableEntry({ consumerResolution: "identity", consumers: [] })]}
      />,
    );
    expect(screen.getByTestId("cross-project-consumers")).toHaveAttribute(
      "data-consumer-state",
      "none",
    );

    rerender(
      <AffectedTablesSection
        tables={[tableEntry({ consumerResolution: "unverifiable", consumers: [] })]}
      />,
    );
    const block = screen.getByTestId("cross-project-consumers");
    expect(block).toHaveAttribute("data-consumer-state", "could-not-verify");
    expect(block).toHaveTextContent("could not be verified");
  });

  it("renders NOTHING when consumers were not computed (single-project unchanged)", () => {
    render(<AffectedTablesSection tables={[tableEntry()]} />);
    expect(screen.queryByTestId("cross-project-consumers")).toBeNull();
  });
});

describe("AffectedTablesSection — #966 table relevance feedback", () => {
  it("renders no thumbs affordance when onMarkFeedback is omitted (existing callers unchanged)", () => {
    render(<AffectedTablesSection tables={[tableEntry()]} />);
    expect(screen.queryByTestId("table-feedback-controls")).toBeNull();
  });

  it("renders thumbs when onMarkFeedback is provided, with no marks yet", () => {
    const onMarkFeedback = vi.fn();
    render(<AffectedTablesSection tables={[tableEntry()]} onMarkFeedback={onMarkFeedback} />);
    const controls = screen.getByTestId("table-feedback-controls");
    expect(controls).toHaveAttribute("data-table-name", "crm.customers");
    expect(screen.queryByTestId("table-feedback-mark")).toBeNull();
  });

  it("marks a table relevant on thumbs-up click", () => {
    const onMarkFeedback = vi.fn();
    render(<AffectedTablesSection tables={[tableEntry()]} onMarkFeedback={onMarkFeedback} />);
    fireEvent.click(screen.getByTestId("table-feedback-relevant"));
    expect(onMarkFeedback).toHaveBeenCalledWith({
      tableName: "crm.customers",
      verdict: "relevant",
    });
  });

  it("marks a table not-relevant on thumbs-down click", () => {
    const onMarkFeedback = vi.fn();
    render(<AffectedTablesSection tables={[tableEntry()]} onMarkFeedback={onMarkFeedback} />);
    fireEvent.click(screen.getByTestId("table-feedback-not-relevant"));
    expect(onMarkFeedback).toHaveBeenCalledWith({
      tableName: "crm.customers",
      verdict: "not-relevant",
    });
  });

  it("renders every mark visibly (who marked it), not hidden behind a tooltip", () => {
    render(
      <AffectedTablesSection
        tables={[tableEntry()]}
        feedback={[
          feedbackEntry({ userId: "user-1", userDisplayName: "alice", verdict: "relevant" }),
          feedbackEntry({
            id: "fb-2",
            userId: "user-2",
            userDisplayName: "bob",
            verdict: "not-relevant",
          }),
        ]}
        onMarkFeedback={vi.fn()}
      />,
    );
    const marks = screen.getAllByTestId("table-feedback-mark");
    expect(marks).toHaveLength(2);
    expect(marks[0]).toHaveTextContent("alice");
    expect(marks[0]).toHaveAttribute("data-verdict", "relevant");
    expect(marks[1]).toHaveTextContent("bob");
    expect(marks[1]).toHaveAttribute("data-verdict", "not-relevant");
  });

  it("only matches table-level feedback rows (columnName null) to the table's controls", () => {
    render(
      <AffectedTablesSection
        tables={[tableEntry()]}
        feedback={[feedbackEntry({ columnName: "email" })]}
        onMarkFeedback={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("table-feedback-mark")).toBeNull();
  });

  it("toggles OFF (deletes) when clicking the already-active verdict", () => {
    const onMarkFeedback = vi.fn();
    const onDeleteFeedback = vi.fn();
    render(
      <AffectedTablesSection
        tables={[tableEntry()]}
        feedback={[feedbackEntry({ userId: "user-1", verdict: "relevant" })]}
        currentUserId="user-1"
        onMarkFeedback={onMarkFeedback}
        onDeleteFeedback={onDeleteFeedback}
      />,
    );
    const button = screen.getByTestId("table-feedback-relevant");
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(onDeleteFeedback).toHaveBeenCalledWith("fb-1");
    expect(onMarkFeedback).not.toHaveBeenCalled();
  });

  it("re-marks (does not toggle off) when clicking a DIFFERENT verdict than the caller's own mark", () => {
    const onMarkFeedback = vi.fn();
    const onDeleteFeedback = vi.fn();
    render(
      <AffectedTablesSection
        tables={[tableEntry()]}
        feedback={[feedbackEntry({ userId: "user-1", verdict: "relevant" })]}
        currentUserId="user-1"
        onMarkFeedback={onMarkFeedback}
        onDeleteFeedback={onDeleteFeedback}
      />,
    );
    fireEvent.click(screen.getByTestId("table-feedback-not-relevant"));
    expect(onMarkFeedback).toHaveBeenCalledWith({
      tableName: "crm.customers",
      verdict: "not-relevant",
    });
    expect(onDeleteFeedback).not.toHaveBeenCalled();
  });

  it("does not treat another user's mark as toggleable by the current caller", () => {
    const onMarkFeedback = vi.fn();
    const onDeleteFeedback = vi.fn();
    render(
      <AffectedTablesSection
        tables={[tableEntry()]}
        feedback={[feedbackEntry({ userId: "user-2", verdict: "relevant" })]}
        currentUserId="user-1"
        onMarkFeedback={onMarkFeedback}
        onDeleteFeedback={onDeleteFeedback}
      />,
    );
    const button = screen.getByTestId("table-feedback-relevant");
    expect(button).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(button);
    expect(onMarkFeedback).toHaveBeenCalledWith({
      tableName: "crm.customers",
      verdict: "relevant",
    });
    expect(onDeleteFeedback).not.toHaveBeenCalled();
  });
});
