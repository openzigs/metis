/**
 * #2547 — the new-change-request document picker marks a restricted document,
 * and a member the document is restricted away from cannot select it (#2546:
 * it is listed, but neither selectable nor counted as used).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { DocumentRow } from "@/lib/projects-api";

vi.mock("@/hooks/use-repo-names", () => ({ useRepoNames: () => new Map() }));

const { AddDocumentsPanel } = await import("./add-documents-panel");

function doc(over: Partial<DocumentRow>): DocumentRow {
  return {
    id: "d1",
    projectId: "p1",
    filename: "spec.md",
    source: "upload",
    mimeType: "text/markdown",
    sizeBytes: 100,
    status: "ready",
    chunkCount: 1,
    uploadedAt: "2026-11-15T10:00:00.000Z",
    ...over,
  };
}

const toCoordinators = [{ kind: "role" as const, value: "coordinator" }];

function renderPanel(docs: DocumentRow[], selectedDocs: string[] = []) {
  const onSelectedDocsChange = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AddDocumentsPanel
        projectId="p1"
        docs={docs}
        selectedDocs={selectedDocs}
        onSelectedDocsChange={onSelectedDocsChange}
        onInvalidateDocs={async () => undefined}
      />
    </QueryClientProvider>,
  );
  return { onSelectedDocsChange };
}

const checkboxOf = (id: string) =>
  screen.getByTestId(`add-documents-row-${id}`).querySelector("input") as HTMLInputElement;

describe("AddDocumentsPanel — #2547 restricted documents", () => {
  it("marks a restricted document the member can read, and lets them select it", () => {
    const { onSelectedDocsChange } = renderPanel([
      doc({ id: "d-pay", access: { restricted: true, canRead: true, subjects: toCoordinators } }),
    ]);
    expect(screen.getByTestId("add-documents-restricted-badge-d-pay")).toHaveTextContent(
      "Readable by role coordinator and admins",
    );
    expect(screen.queryByTestId("add-documents-restricted-d-pay")).toBeNull();
    expect(checkboxOf("d-pay")).not.toBeDisabled();
    fireEvent.click(checkboxOf("d-pay"));
    expect(onSelectedDocsChange).toHaveBeenCalledWith(["d-pay"]);
  });

  it("lists a document restricted away from the member as unselectable, naming no reader", () => {
    renderPanel(
      [
        doc({
          id: "d-pay",
          filename: "Restricted",
          restricted: true,
          access: { restricted: true, canRead: false },
        }),
        doc({ id: "d-open", access: { restricted: false, canRead: true, subjects: [] } }),
      ],
      [],
    );
    expect(screen.getByTestId("add-documents-restricted-badge-d-pay")).toHaveTextContent(
      /^Restricted$/,
    );
    expect(screen.getByTestId("add-documents-restricted-d-pay")).toHaveTextContent(
      "You don't have access to this document",
    );
    expect(checkboxOf("d-pay")).toBeDisabled();
    expect(checkboxOf("d-pay")).not.toBeChecked();
    expect(checkboxOf("d-open")).not.toBeDisabled();
    expect(screen.queryByTestId("add-documents-restricted-badge-d-open")).toBeNull();
  });

  it("drops a selected document from the selection once a refetch marks it unreadable", () => {
    const { onSelectedDocsChange } = renderPanel(
      [doc({ id: "d-pay", access: { restricted: true, canRead: false } }), doc({ id: "d-open" })],
      ["d-pay", "d-open"],
    );
    expect(onSelectedDocsChange).toHaveBeenCalledWith(["d-open"]);
  });

  it("leaves the selection alone when every selected document is readable", () => {
    const { onSelectedDocsChange } = renderPanel(
      [doc({ id: "d-pay", restricted: true }), doc({ id: "d-open" })],
      ["d-open"],
    );
    expect(onSelectedDocsChange).not.toHaveBeenCalled();
  });
});
