/**
 * Unit tests for the document upload widget — drag/drop, client-side
 * validation, and per-file upload status reporting.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MAX_DOCUMENT_BYTES } from "@metis/shared";
import { DocumentUploader } from "@/components/projects/document-uploader";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/projects-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects-api")>("@/lib/projects-api");
  return {
    ...actual,
    documentsApi: {
      ...actual.documentsApi,
      upload: vi.fn(),
    },
  };
});

import { documentsApi } from "@/lib/projects-api";

const mockUpload = documentsApi.upload as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockUpload.mockReset();
});

function renderUploader(onUploaded?: (...args: unknown[]) => void) {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <DocumentUploader projectId="proj_aaaa1" onUploaded={onUploaded as never} />
    </Wrapper>,
  );
}

function makeFile(name: string, size: number, type: string): File {
  const buf = new Uint8Array(size);
  return new File([buf], name, { type });
}

describe("DocumentUploader", () => {
  it("renders the dropzone", () => {
    renderUploader();
    expect(screen.getByTestId("upload-dropzone")).toBeInTheDocument();
  });

  it("rejects files larger than MAX_DOCUMENT_BYTES client-side", async () => {
    renderUploader();
    const input = screen.getByTestId("upload-file-input") as HTMLInputElement;
    const huge = makeFile("huge.md", MAX_DOCUMENT_BYTES + 1, "text/markdown");
    fireEvent.change(input, { target: { files: [huge] } });
    expect(await screen.findByTestId("upload-status-error")).toBeInTheDocument();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("rejects unsupported MIME types client-side", async () => {
    renderUploader();
    const input = screen.getByTestId("upload-file-input") as HTMLInputElement;
    const bad = makeFile("evil.exe", 10, "application/x-msdownload");
    fireEvent.change(input, { target: { files: [bad] } });
    expect(await screen.findByTestId("upload-status-error")).toBeInTheDocument();
  });

  // SC 3.3.3 (#663): the unsupported-type error names the accepted formats so
  // the user knows exactly which correction to make.
  it("suggests the accepted file formats for an unsupported type (#663)", async () => {
    renderUploader();
    const input = screen.getByTestId("upload-file-input") as HTMLInputElement;
    const bad = makeFile("evil.exe", 10, "application/x-msdownload");
    fireEvent.change(input, { target: { files: [bad] } });
    const err = await screen.findByTestId("upload-status-error");
    expect(err).toHaveTextContent(/Unsupported file type — use one of:/i);
    expect(err).toHaveTextContent(/pdf/i);
  });

  it("uploads a valid markdown file and calls onUploaded", async () => {
    const onUploaded = vi.fn();
    mockUpload.mockResolvedValue({
      document: {
        id: "doc_aaaa1",
        projectId: "proj_aaaa1",
        filename: "notes.md",
        mimeType: "text/markdown",
        sizeBytes: 5,
        status: "ready",
        chunkCount: 1,
        uploadedAt: new Date().toISOString(),
      },
      ingest: { status: "ready", chunkCount: 1 },
    });
    renderUploader(onUploaded);
    const file = makeFile("notes.md", 5, "text/markdown");
    fireEvent.change(screen.getByTestId("upload-file-input"), { target: { files: [file] } });
    await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("upload-status-done")).toBeInTheDocument();
    expect(onUploaded).toHaveBeenCalled();
  });

  it("surfaces server errors per-file", async () => {
    mockUpload.mockRejectedValue(Object.assign(new Error("file too large"), { name: "ApiError" }));
    renderUploader();
    fireEvent.change(screen.getByTestId("upload-file-input"), {
      target: { files: [makeFile("notes.md", 5, "text/markdown")] },
    });
    expect(await screen.findByTestId("upload-status-error")).toBeInTheDocument();
  });

  it("dropzone has the expected ARIA semantics", () => {
    renderUploader();
    const dz = screen.getByTestId("upload-dropzone");
    expect(dz.getAttribute("role")).toBe("button");
    expect(dz.getAttribute("tabindex")).toBe("0");
  });

  it("falls back to extension sniff for octet-stream", async () => {
    mockUpload.mockResolvedValue({
      document: {
        id: "doc_aaaa1",
        projectId: "proj_aaaa1",
        filename: "n.md",
        mimeType: "text/markdown",
        sizeBytes: 1,
        status: "ready",
        chunkCount: 0,
        uploadedAt: new Date().toISOString(),
      },
      ingest: { status: "ready", chunkCount: 0 },
    });
    renderUploader();
    fireEvent.change(screen.getByTestId("upload-file-input"), {
      target: { files: [makeFile("n.md", 5, "application/octet-stream")] },
    });
    await waitFor(() => expect(mockUpload).toHaveBeenCalled());
  });
});
