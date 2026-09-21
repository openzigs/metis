import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DraftDiffDialog, diffLines } from "@/components/publishing/draft-diff-dialog";
import {
  BulkApproveDialog,
  computeApprovalCounts,
} from "@/components/publishing/bulk-approve-dialog";

describe("diffLines", () => {
  it("returns 'same' for an unchanged document", () => {
    const out = diffLines("a\nb\nc", "a\nb\nc");
    expect(out.every((l) => l.kind === "same")).toBe(true);
    expect(out).toHaveLength(3);
  });

  it("flags an inserted line as 'add'", () => {
    const out = diffLines("a\nc", "a\nb\nc");
    expect(out.find((l) => l.text === "b")?.kind).toBe("add");
  });

  it("flags a removed line as 'remove'", () => {
    const out = diffLines("a\nb\nc", "a\nc");
    expect(out.find((l) => l.text === "b")?.kind).toBe("remove");
  });

  it("treats a line edit as remove + add", () => {
    const out = diffLines("hello world", "hello there");
    const kinds = out.map((l) => l.kind).sort();
    expect(kinds).toEqual(["add", "remove"]);
  });
});

describe("DraftDiffDialog", () => {
  it("renders the body when no previousBody is given", () => {
    render(
      <DraftDiffDialog
        open={true}
        onOpenChange={() => {}}
        title="My epic"
        body="line one\nline two"
      />,
    );
    expect(screen.getByText(/My epic/)).toBeInTheDocument();
    expect(screen.getByTestId("draft-diff-summary")).toHaveTextContent(/No previous version/);
  });

  it("shows additions and removals when previousBody differs", () => {
    render(
      <DraftDiffDialog
        open={true}
        onOpenChange={() => {}}
        title="My feature"
        body={"a\nb\nc"}
        previousBody={"a\nc"}
      />,
    );
    const summary = screen.getByTestId("draft-diff-summary");
    expect(summary).toHaveTextContent("+1");
    expect(summary).toHaveTextContent("=2");
  });
});

describe("computeApprovalCounts", () => {
  it("classifies drafts by status correctly", () => {
    const counts = computeApprovalCounts([
      { id: "1", status: "draft" },
      { id: "2", status: "draft" },
      { id: "3", status: "approved" },
      { id: "4", status: "published" },
      { id: "5", status: "failed" },
    ]);
    expect(counts).toEqual({ total: 5, created: 2, updated: 1, skipped: 2 });
  });
});

describe("BulkApproveDialog", () => {
  it("invokes onConfirm when the action button is clicked", () => {
    const onConfirm = vi.fn();
    render(
      <BulkApproveDialog
        open={true}
        onOpenChange={() => {}}
        counts={{ total: 3, created: 2, updated: 1, skipped: 0 }}
        pending={false}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByTestId("bulk-approve-counts")).toHaveTextContent("2");
    fireEvent.click(screen.getByRole("button", { name: /Approve 3/ }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("disables the action button when nothing actionable is selected", () => {
    render(
      <BulkApproveDialog
        open={true}
        onOpenChange={() => {}}
        counts={{ total: 2, created: 0, updated: 0, skipped: 2 }}
        pending={false}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Approve 0/ })).toBeDisabled();
  });

  it("shows a pending label when an approval is in flight", () => {
    render(
      <BulkApproveDialog
        open={true}
        onOpenChange={() => {}}
        counts={{ total: 2, created: 2, updated: 0, skipped: 0 }}
        pending={true}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText(/Approving/)).toBeInTheDocument();
  });
});
