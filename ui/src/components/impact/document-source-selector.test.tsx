/**
 * #2547 — the impact analysis's "existing document" picker marks a restricted
 * document, and a member it is restricted away from cannot pick it.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DocumentSourceSelector, type SourceDocument } from "./document-source-selector";

function renderSelector(documents: SourceDocument[]) {
  render(
    <DocumentSourceSelector
      mode="document"
      onModeChange={vi.fn()}
      text=""
      onTextChange={vi.fn()}
      documents={documents}
      documentId={null}
      onDocumentChange={vi.fn()}
    />,
  );
}

describe("DocumentSourceSelector — #2547 restricted documents", () => {
  it("labels a restricted document and disables one the member cannot read", () => {
    renderSelector([
      { id: "d-open", filename: "handbook.md", projectName: "HR" },
      { id: "d-mine", filename: "plan.md", projectName: "HR", restricted: true },
      {
        id: "d-pay",
        filename: "payroll.md",
        projectName: "HR",
        restricted: true,
        unreadable: true,
      },
    ]);
    const open = screen.getByRole("option", { name: "handbook.md (HR)" });
    const mine = screen.getByRole("option", { name: "plan.md (HR) — restricted" });
    const pay = screen.getByRole("option", {
      name: "payroll.md (HR) — restricted, you cannot read it",
    });
    expect(open).not.toBeDisabled();
    expect(mine).not.toBeDisabled();
    expect(pay).toBeDisabled();
  });
});
