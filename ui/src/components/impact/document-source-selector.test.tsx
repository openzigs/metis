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
  });
});
