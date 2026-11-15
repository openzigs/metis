/**
 * #2547 — the new-change-request document picker marks a restricted document,
 * and a member the document is restricted away from cannot select it (#2546:
 * it is listed, but neither selectable nor counted as used).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { DocumentRow } from "@/lib/projects-api";

vi.mock("@/hooks/use-repo-names", () => ({ useRepoNames: () => new Map() }));
const createFromUrl = vi.fn();
vi.mock("@/lib/projects-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/projects-api")>();
  return {
    ...actual,
    documentsApi: {
      ...actual.documentsApi,
      createFromUrl: (...a: unknown[]) => createFromUrl(...a),
    },
  };
});
vi.mock("@/components/projects/document-uploader", () => ({
  DocumentUploader: () => <div data-testid="stub-uploader" />,
}));
vi.mock("@/components/projects/text-ingest-form", () => ({
  TextIngestForm: () => <div data-testid="stub-text-form" />,
}));

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
      "Readable by the coordinator role and admins",
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

describe("AddDocumentsPanel — list states and the URL form", () => {
  it("says it is loading, or that there are no documents yet", () => {
    const { unmount } = render(
      <QueryClientProvider client={new QueryClient()}>
        <AddDocumentsPanel
          projectId="p1"
          docs={[]}
          selectedDocs={[]}
          onSelectedDocsChange={vi.fn()}
          onInvalidateDocs={async () => undefined}
          loading
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Loading documents…")).toBeInTheDocument();
    unmount();
    renderPanel([]);
    expect(screen.getByText(/No documents yet/)).toBeInTheDocument();
  });

  it("warns while a selected document is still ingesting, and shows its status", () => {
    renderPanel([doc({ id: "d-new", status: "processing" })], ["d-new"]);
    expect(screen.getByTestId("add-documents-status-d-new")).toHaveTextContent("processing");
    expect(screen.getByTestId("add-documents-warning")).toHaveTextContent(
      "1 selected document is still ingesting",
    );
  });

  it("unticks a selected document", () => {
    const { onSelectedDocsChange } = renderPanel([doc({ id: "d1" })], ["d1"]);
    fireEvent.click(checkboxOf("d1"));
    expect(onSelectedDocsChange).toHaveBeenCalledWith([]);
  });

  it("expands the add controls and suggests a fix for a URL it cannot fetch", () => {
    renderPanel([]);
    const toggle = screen.getByTestId("add-documents-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("add-documents-controls")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("add-documents-url-input"), {
      target: { value: "example.com/spec.md" },
    });
    fireEvent.click(screen.getByTestId("add-documents-url-submit"));
    expect(screen.getByTestId("add-documents-url-error")).toHaveTextContent(/https:\/\//);
    fireEvent.change(screen.getByTestId("add-documents-url-input"), {
      target: { value: "ftp://example.com/spec.md" },
    });
    fireEvent.click(screen.getByTestId("add-documents-url-submit"));
    expect(screen.getByTestId("add-documents-url-error")).toBeInTheDocument();
  });

  it("fetches a URL, waits for the list to refresh, then selects the new document", async () => {
    createFromUrl.mockResolvedValueOnce({ document: doc({ id: "d-url" }) });
    const onInvalidateDocs = vi.fn(async () => undefined);
    const onSelectedDocsChange = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AddDocumentsPanel
          projectId="p1"
          docs={[]}
          selectedDocs={["d-old"]}
          onSelectedDocsChange={onSelectedDocsChange}
          onInvalidateDocs={onInvalidateDocs}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId("add-documents-toggle"));
    fireEvent.change(screen.getByTestId("add-documents-url-input"), {
      target: { value: "https://example.com/spec.md" },
    });
    fireEvent.click(screen.getByTestId("add-documents-url-submit"));
    await waitFor(() => expect(onSelectedDocsChange).toHaveBeenCalledWith(["d-old", "d-url"]));
    expect(createFromUrl).toHaveBeenCalledWith("p1", { url: "https://example.com/spec.md" });
    expect(onInvalidateDocs).toHaveBeenCalled();
  });

  it("shows the server's message when a URL cannot be fetched", async () => {
    createFromUrl.mockRejectedValueOnce(new Error("boom"));
    renderPanel([]);
    fireEvent.click(screen.getByTestId("add-documents-toggle"));
    fireEvent.change(screen.getByTestId("add-documents-url-input"), {
      target: { value: "https://example.com/x.md" },
    });
    fireEvent.click(screen.getByTestId("add-documents-url-submit"));
    expect(await screen.findByTestId("add-documents-url-error")).toHaveTextContent(
      "Failed to fetch URL",
    );
  });
});

describe("AddDocumentsPanel — documents awaiting review (#2555)", () => {
  it("labels a document still awaiting review, and leaves an approved one unlabelled", () => {
    renderPanel([
      doc({ id: "d-q", filename: "draft.md", indexState: "quarantined" }),
      doc({ id: "d-ok", filename: "spec.md", indexState: "indexed" }),
    ]);
    expect(screen.getByTestId("add-documents-review-d-q")).toHaveTextContent("awaiting review");
    expect(screen.queryByTestId("add-documents-review-d-ok")).toBeNull();
  });
});
