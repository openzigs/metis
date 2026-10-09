/**
 * Issue #979 — document and database citations rendered a literal "→"
 * because the arrow was written as a JS escape in JSX text, which JSX does not
 * interpret. The row now renders a real arrow.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DocumentCitation } from "./document-citation";

function renderRow(citation: Parameters<typeof DocumentCitation>[0]["citation"]) {
  return render(
    <ul>
      <DocumentCitation citation={citation} />
    </ul>,
  );
}

describe("DocumentCitation", () => {
  it("renders a real arrow, never the escape sequence", () => {
    renderRow({ documentId: "d1", filename: "spec.md", chunkIndex: 4 });
    const row = screen.getByTestId("document-citation");
    expect(row.textContent).toContain("→");
    expect(row.textContent).not.toContain("\\u2192");
  });

  it("shows the source label and chunk index", () => {
    renderRow({ documentId: "d1", filename: "spec.md", chunkIndex: 4 });
    expect(screen.getByTestId("document-citation")).toHaveTextContent(/spec\.md #\s*4/);
    expect(screen.getByTitle("spec.md")).toBeInTheDocument();
  });

  it("falls back to the document id when there is no filename", () => {
    renderRow({ documentId: "doc-42", chunkIndex: 0 });
    expect(screen.getByTestId("document-citation")).toHaveTextContent(/doc-42/);
  });

  it("quotes the snippet when present and omits it otherwise", () => {
    const { unmount } = renderRow({
      documentId: "d1",
      filename: "a.md",
      chunkIndex: 1,
      snippet: "must retry",
    });
    expect(screen.getByText('"must retry"')).toBeInTheDocument();
    unmount();
    renderRow({ documentId: "d1", filename: "a.md", chunkIndex: 1 });
    expect(screen.getByTestId("document-citation").querySelector("em")).toBeNull();
  });
});
