import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DocumentRow } from "@/lib/projects-api";
import { AddDocumentsPanel } from "@/components/analysis/add-documents-panel";

// Stub the heavy upload children so we can drive their callbacks directly and
// keep the test focused on AddDocumentsPanel's selection / invalidation logic.
vi.mock("@/components/projects/document-uploader", () => ({
  DocumentUploader: ({ onUploaded }: { onUploaded?: (doc: DocumentRow) => void }) => (
    <button
      type="button"
      data-testid="stub-uploader"
      onClick={() => onUploaded?.(makeDoc("doc-uploaded", "upload.md", "pending"))}
    >
      stub-upload
    </button>
  ),
}));
vi.mock("@/components/projects/text-ingest-form", () => ({
  TextIngestForm: ({ onIngested }: { onIngested?: (doc: DocumentRow) => void }) => (
    <button
      type="button"
      data-testid="stub-text"
      onClick={() => onIngested?.(makeDoc("doc-text", "note.md", "ready"))}
    >
      stub-text
    </button>
  ),
}));

const createFromUrl = vi.fn();
vi.mock("@/lib/projects-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects-api")>("@/lib/projects-api");
  return {
    ...actual,
    documentsApi: {
      ...actual.documentsApi,
      createFromUrl: (...args: unknown[]) => createFromUrl(...args),
    },
  };
});

function makeDoc(id: string, filename: string, status: DocumentRow["status"]): DocumentRow {
  return {
    id,
    projectId: "proj-1",
    filename,
    mimeType: "text/markdown",
    sizeBytes: 10,
    status,
    chunkCount: 0,
    uploadedAt: new Date().toISOString(),
  };
}

interface HarnessProps {
  docs: DocumentRow[];
  onInvalidateDocs?: () => Promise<unknown>;
  initialSelected?: string[];
  onSelectedChange?: (ids: string[]) => void;
}

function Harness({ docs, onInvalidateDocs, initialSelected = [], onSelectedChange }: HarnessProps) {
  const [selected, setSelected] = useState<string[]>(initialSelected);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <AddDocumentsPanel
        projectId="proj-1"
        docs={docs}
        selectedDocs={selected}
        onSelectedDocsChange={(ids) => {
          setSelected(ids);
          onSelectedChange?.(ids);
        }}
        onInvalidateDocs={onInvalidateDocs ?? (async () => undefined)}
      />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  createFromUrl.mockReset();
});

describe("AddDocumentsPanel (#906)", () => {
  it("renders collapsed controls with an aria-expanded toggle", () => {
    render(<Harness docs={[]} />);
    const toggle = screen.getByTestId("add-documents-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("add-documents-controls")).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("add-documents-controls")).toBeInTheDocument();
  });

  it("lets ready documents be selected and disables in-flight ones", () => {
    const onSelectedChange = vi.fn();
    render(
      <Harness
        docs={[
          makeDoc("d-ready", "ready.md", "ready"),
          makeDoc("d-pending", "pending.md", "pending"),
        ]}
        onSelectedChange={onSelectedChange}
      />,
    );
    const readyCheckbox = screen.getByTestId("add-documents-row-d-ready").querySelector("input")!;
    const pendingCheckbox = screen
      .getByTestId("add-documents-row-d-pending")
      .querySelector("input")!;
    expect(pendingCheckbox).toBeDisabled();
    expect(readyCheckbox).not.toBeDisabled();
    fireEvent.click(readyCheckbox);
    expect(onSelectedChange).toHaveBeenCalledWith(["d-ready"]);
  });

  it("surfaces the ingest status of in-flight documents", () => {
    render(<Harness docs={[makeDoc("d-proc", "proc.md", "processing")]} />);
    expect(screen.getByTestId("add-documents-status-d-proc")).toHaveTextContent("processing");
  });

  it("renders connector ids as a friendly 'basename — repo' label with the raw id in the tooltip (#427)", () => {
    const rawId =
      "connector:repo:cmexample0000000000acmerp:src/main/java/com/acme/ShipmentAllocationsVO.java";
    render(<Harness docs={[makeDoc(rawId, rawId, "ready")]} />);
    const row = screen.getByTestId(`add-documents-row-${rawId}`);
    // Friendly label is shown; the noisy connector prefix is hidden from view.
    expect(row).toHaveTextContent("ShipmentAllocationsVO.java — acmerp");
    expect(row.textContent).not.toContain("connector:repo:");
    // The full raw id remains available via the title tooltip (copyable).
    const labelSpan = row.querySelector("span[title]")!;
    expect(labelSpan).toHaveAttribute("title", rawId);
  });

  it("passes a plain uploaded filename through unchanged (graceful degradation) (#427)", () => {
    const name = "D100 - UC101 Regional Hubs.docx";
    render(<Harness docs={[makeDoc("d-plain", name, "ready")]} />);
    const row = screen.getByTestId("add-documents-row-d-plain");
    expect(row).toHaveTextContent(name);
    expect(row.querySelector("span[title]")).toHaveAttribute("title", name);
  });

  it("warns when a selected document is not yet ready", () => {
    render(
      <Harness
        docs={[makeDoc("d-pending", "pending.md", "pending")]}
        initialSelected={["d-pending"]}
      />,
    );
    expect(screen.getByTestId("add-documents-warning")).toHaveTextContent(/still ingesting/i);
  });

  it("auto-selects an uploaded doc only after the cache invalidation resolves", async () => {
    const order: string[] = [];
    const onInvalidateDocs = vi.fn(async () => {
      order.push("invalidate");
    });
    const onSelectedChange = vi.fn(() => order.push("select"));
    render(
      <Harness docs={[]} onInvalidateDocs={onInvalidateDocs} onSelectedChange={onSelectedChange} />,
    );
    fireEvent.click(screen.getByTestId("add-documents-toggle"));
    fireEvent.click(screen.getByTestId("stub-uploader"));
    await waitFor(() => expect(onSelectedChange).toHaveBeenCalledWith(["doc-uploaded"]));
    expect(order).toEqual(["invalidate", "select"]);
  });

  it("ingests a URL and auto-selects the resulting document", async () => {
    createFromUrl.mockResolvedValue({
      document: makeDoc("doc-url", "from-url.md", "pending"),
      ingest: { status: "pending", chunkCount: 0 },
      source: { url: "https://example.com/x.md" },
    });
    const onSelectedChange = vi.fn();
    render(<Harness docs={[]} onSelectedChange={onSelectedChange} />);
    fireEvent.click(screen.getByTestId("add-documents-toggle"));
    fireEvent.change(screen.getByTestId("add-documents-url-input"), {
      target: { value: "https://example.com/x.md" },
    });
    fireEvent.click(screen.getByTestId("add-documents-url-submit"));
    await waitFor(() =>
      expect(createFromUrl).toHaveBeenCalledWith("proj-1", { url: "https://example.com/x.md" }),
    );
    await waitFor(() => expect(onSelectedChange).toHaveBeenCalledWith(["doc-url"]));
  });

  // SC 3.3.3 (#663): a scheme-less URL has a client-detectable cause — suggest
  // the https-prefixed value client-side instead of surfacing only the raw
  // server error. The API is NOT called until the URL is well-formed.
  it("suggests an https URL for a scheme-less value without calling the API (#663)", async () => {
    render(<Harness docs={[]} />);
    fireEvent.click(screen.getByTestId("add-documents-toggle"));
    fireEvent.change(screen.getByTestId("add-documents-url-input"), {
      target: { value: "example.com/spec.md" },
    });
    fireEvent.click(screen.getByTestId("add-documents-url-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("add-documents-url-error")).toHaveTextContent(
        /did you mean “https:\/\/example\.com\/spec\.md”/i,
      ),
    );
    expect(createFromUrl).not.toHaveBeenCalled();
  });

  // SC 3.3.3 (#663): a non-http(s) scheme is swapped to https in the suggestion.
  it("suggests https for an unsupported scheme without calling the API (#663)", async () => {
    render(<Harness docs={[]} />);
    fireEvent.click(screen.getByTestId("add-documents-toggle"));
    fireEvent.change(screen.getByTestId("add-documents-url-input"), {
      target: { value: "ftp://example.com/spec.md" },
    });
    fireEvent.click(screen.getByTestId("add-documents-url-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("add-documents-url-error")).toHaveTextContent(
        /only http and https/i,
      ),
    );
    expect(createFromUrl).not.toHaveBeenCalled();
  });

  it("shows an error when the URL ingest fails", async () => {
    const { ApiError } = await import("@/lib/api-client");
    createFromUrl.mockRejectedValue(new ApiError(400, "Bad URL", "BAD"));
    render(<Harness docs={[]} />);
    fireEvent.click(screen.getByTestId("add-documents-toggle"));
    fireEvent.change(screen.getByTestId("add-documents-url-input"), {
      target: { value: "https://bad" },
    });
    fireEvent.click(screen.getByTestId("add-documents-url-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("add-documents-url-error")).toHaveTextContent("Bad URL"),
    );
  });
});
