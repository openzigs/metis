/**
 * #2547 — the impact analysis's "existing document" picker marks a restricted
 * document the caller may read (one they cannot is dropped by the page, #2546).
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
  it("labels a restricted document and leaves an open one as it was", () => {
    renderSelector([
      { id: "d-open", filename: "handbook.md", projectName: "HR" },
      { id: "d-mine", filename: "plan.md", projectName: "HR", restricted: true },
    ]);
    expect(screen.getByRole("option", { name: "handbook.md (HR)" })).not.toBeDisabled();
    expect(screen.getByRole("option", { name: "plan.md (HR) — restricted" })).not.toBeDisabled();
    expect(screen.queryByTestId("source-documents-awaiting-review")).toBeNull();
  });
});

describe("DocumentSourceSelector — #2555 documents awaiting review", () => {
  it("labels a quarantined document and counts them under the list", () => {
    renderSelector([
      { id: "d-open", filename: "handbook.md", projectName: "HR" },
      { id: "d-q1", filename: "draft.md", projectName: "HR", awaitingReview: true },
      {
        id: "d-q2",
        filename: "pay.md",
        projectName: "HR",
        restricted: true,
        awaitingReview: true,
      },
    ]);
    expect(screen.getByRole("option", { name: "draft.md (HR) — awaiting review" })).toBeVisible();
    expect(
      screen.getByRole("option", { name: "pay.md (HR) — restricted, awaiting review" }),
    ).toBeVisible();
    expect(screen.getByTestId("source-documents-awaiting-review")).toHaveTextContent(
      "2 of these documents are awaiting review",
    );
  });

  it("says one in the singular", () => {
    renderSelector([{ id: "d-q1", filename: "draft.md", projectName: "HR", awaitingReview: true }]);
    expect(screen.getByTestId("source-documents-awaiting-review")).toHaveTextContent(
      "1 of these documents is awaiting review",
    );
  });
});
