/**
 * #1051 — the proposed columns impact analysis ruled out, shown with the
 * covering write path and the reason.
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { ImpactColumnProposalView } from "@metis/shared";
import type { CodeCitationRepo } from "@/lib/code-citation-blob-url";
import { ColumnProposalsSection } from "./column-proposals-section";

const WRITER = {
  qualifiedName: "internal/storage/entry.go::MarkAllAsReadBeforeDate",
  filePath: "internal/storage/entry.go",
  startLine: 523,
  endLine: 533,
};

function proposal(over: Partial<ImpactColumnProposalView> = {}): ImpactColumnProposalView {
  return {
    id: "cp-1",
    tableName: "users",
    columnName: "mark_read_delay",
    columnType: "INTEGER",
    suggestedDdl: "ALTER TABLE users ADD COLUMN mark_read_delay INTEGER;",
    reason:
      "An existing write path covers this: MarkAllAsReadBeforeDate (internal/storage/entry.go:523) already filters entries.published_at by its argument (before time.Time).",
    writer: WRITER,
    ...over,
  };
}

const REPO: CodeCitationRepo = {
  origin: "https://github.com",
  owner: "miniflux",
  repo: "v2",
  ref: "c4d54f87",
};

describe("ColumnProposalsSection — Not proposed (#1051)", () => {
  it("names the column, the covering write path with its file and line, and the reason", () => {
    render(<ColumnProposalsSection variant="rejected" proposals={[proposal()]} />);
    const section = screen.getByTestId("dropped-column-proposals");
    expect(within(section).getByText("Not proposed (1)")).toBeInTheDocument();
    expect(within(section).getByTestId("column-proposal-column").textContent).toBe(
      "users.mark_read_delay",
    );
    const writer = within(section).getByTestId("column-proposal-writer");
    expect(writer.textContent).toBe(
      "Existing write path: MarkAllAsReadBeforeDate (internal/storage/entry.go:523)",
    );
    expect(within(section).getByTestId("column-proposal-reason").textContent).toContain(
      "already filters entries.published_at",
    );
  });

  it("never shows a copyable ALTER TABLE for a column that is not proposed", () => {
    render(<ColumnProposalsSection variant="rejected" proposals={[proposal()]} />);
    expect(screen.queryByTestId("column-proposal-ddl")).not.toBeInTheDocument();
    expect(screen.getByTestId("dropped-column-proposals").textContent).not.toContain("ALTER TABLE");
  });

  it("links the write path to its file and line when the project's repo is known", () => {
    render(<ColumnProposalsSection variant="rejected" proposals={[proposal()]} repo={REPO} />);
    const link = within(screen.getByTestId("column-proposal-writer")).getByRole("link");
    expect(link.textContent).toBe("MarkAllAsReadBeforeDate");
    expect(link.getAttribute("href")).toContain("internal/storage/entry.go");
    expect(link.getAttribute("href")).toContain("#L523");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("is plain text when no repo is known", () => {
    render(<ColumnProposalsSection variant="rejected" proposals={[proposal()]} />);
    expect(
      within(screen.getByTestId("column-proposal-writer")).queryByRole("link"),
    ).not.toBeInTheDocument();
  });
});

describe("ColumnProposalsSection — Optional: settings persistence (#1051)", () => {
  it("is labelled as outside the migration, and shows its suggested DDL", () => {
    render(<ColumnProposalsSection variant="optional" proposals={[proposal()]} />);
    const section = screen.getByTestId("optional-column-proposals");
    expect(within(section).getByText("Optional: settings persistence (1)")).toBeInTheDocument();
    expect(section.textContent).toContain("Not part of the migration this change needs.");
    // …and says how to get a column the change does need (#791: in a covered
    // request the model cannot add one; the user's own DDL can).
    expect(section.textContent).toContain("write its ALTER TABLE statement in the request");
    expect(within(section).getByTestId("column-proposal-ddl").textContent).toBe(
      "ALTER TABLE users ADD COLUMN mark_read_delay INTEGER;",
    );
  });

  it("renders a preference with no covering write path, no type and no DDL", () => {
    render(
      <ColumnProposalsSection
        variant="optional"
        proposals={[proposal({ writer: null, columnType: null, suggestedDdl: null })]}
      />,
    );
    expect(screen.queryByTestId("column-proposal-writer")).not.toBeInTheDocument();
    expect(screen.queryByTestId("column-proposal-ddl")).not.toBeInTheDocument();
    expect(screen.getByTestId("column-proposal-column").textContent).toBe("users.mark_read_delay");
  });

  it("shows a write path whose line is unknown by its file alone", () => {
    render(
      <ColumnProposalsSection
        variant="optional"
        proposals={[proposal({ writer: { ...WRITER, startLine: null, endLine: null } })]}
      />,
    );
    expect(screen.getByTestId("column-proposal-writer").textContent).toBe(
      "Existing write path: MarkAllAsReadBeforeDate (internal/storage/entry.go)",
    );
  });
});

describe("ColumnProposalsSection — rendering rules (#1051)", () => {
  it("renders nothing for an empty list", () => {
    const { container } = render(<ColumnProposalsSection variant="rejected" proposals={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one row per proposal, counted in the heading", () => {
    render(
      <ColumnProposalsSection
        variant="rejected"
        proposals={[proposal(), proposal({ id: "cp-2", columnName: "mark_read_times" })]}
      />,
    );
    expect(screen.getByText("Not proposed (2)")).toBeInTheDocument();
    expect(screen.getAllByTestId("column-proposal-row")).toHaveLength(2);
  });

  it("renders model- and repository-supplied text as text, never as markup", () => {
    render(
      <ColumnProposalsSection
        variant="optional"
        proposals={[
          proposal({
            columnName: "<img src=x onerror=alert(1)>",
            reason: "<script>alert(1)</script>",
            suggestedDdl: "<b>ALTER</b>",
          }),
        ]}
      />,
    );
    const section = screen.getByTestId("optional-column-proposals");
    expect(section.querySelector("img")).toBeNull();
    expect(section.querySelector("script")).toBeNull();
    expect(section.querySelector("b")).toBeNull();
    expect(section.textContent).toContain("<script>alert(1)</script>");
  });
});

describe("ColumnProposalsSection — Proposed, not checked (#791)", () => {
  const unchecked = proposal({
    writer: null,
    reason:
      "Not checked: the SQL lineage named no write path for this request, so there was nothing to compare this column with. Review it as an unverified proposal.",
  });

  it("says the column is proposed above and was not checked, with the reason", () => {
    render(<ColumnProposalsSection variant="unchecked" proposals={[unchecked]} />);
    const section = screen.getByTestId("unchecked-column-proposals");
    expect(within(section).getByText("Proposed, not checked (1)")).toBeInTheDocument();
    // The note must not claim "no existing write path": a column is also unchecked
    // when write paths exist and the request has no age or date bound.
    expect(section.textContent).toContain("were not checked against the existing write paths");
    expect(section.textContent).toContain("Each row says why");
    expect(section.textContent).not.toContain("there was no existing write path");
    expect(section.textContent).toContain("Treat them as unverified.");
    expect(within(section).getByTestId("column-proposal-column").textContent).toBe(
      "users.mark_read_delay",
    );
    expect(within(section).getByTestId("column-proposal-reason").textContent).toContain(
      "Not checked: the SQL lineage named no write path",
    );
    // No write path to show, and the DDL is already in the table above.
    expect(within(section).queryByTestId("column-proposal-writer")).not.toBeInTheDocument();
    expect(section.textContent).not.toContain("ALTER TABLE");
  });

  it("does not claim that existing code covers a not-proposed column", () => {
    render(<ColumnProposalsSection variant="rejected" proposals={[proposal()]} />);
    const section = screen.getByTestId("dropped-column-proposals");
    expect(section.textContent).toContain("appears to cover these already");
    expect(section.textContent).not.toContain("so no new column is needed");
  });
});
