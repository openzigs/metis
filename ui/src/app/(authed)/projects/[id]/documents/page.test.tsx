/**
 * Issue #69 — the Documents page treated a quarantined document as still
 * ingesting.
 *
 * A document held in quarantine keeps `status = processing` (`indexState =
 * quarantined`), and the page's poll predicate looked at `status` alone. So a
 * project with one quarantined document re-fetched `GET /documents` every 3
 * seconds for ever, and listed the row as "processing · N chunks" with nothing
 * saying it was waiting for a reviewer. #66 fixed the same reading on the
 * Overview; this is the Documents page.
 *
 * The poll tests run on fake timers and count calls. The "still polls while a
 * document is genuinely ingesting" case is the control: without it, a page that
 * had simply stopped polling altogether would pass the quarantine assertion.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentListPage, DocumentRow } from "@/lib/projects-api";

const listDocuments = vi.fn();
const removeDocument = vi.fn();
let projectStatus = "active";

/** Handlers the page registers on the socket, keyed by event name. */
const socketHandlers = new Map<string, (payload: unknown) => void>();
const socketMock = {
  emit: vi.fn(),
  on: vi.fn((event: string, handler: (payload: unknown) => void) => {
    socketHandlers.set(event, handler);
  }),
  off: vi.fn((event: string) => socketHandlers.delete(event)),
};
let socketAvailable = false;

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return { ...actual, useParams: () => ({ id: PROJECT_ID }), notFound: vi.fn() };
});
vi.mock("@/lib/socket-client", () => ({
  useSocket: () => (socketAvailable ? socketMock : null),
}));
vi.mock("@/lib/projects-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/projects-api")>();
  return {
    ...actual,
    projectsApi: {
      ...actual.projectsApi,
      get: async () => ({ id: PROJECT_ID, status: projectStatus }),
    },
    documentsApi: {
      ...actual.documentsApi,
      list: (...a: unknown[]) => listDocuments(...a),
      remove: (...a: unknown[]) => removeDocument(...a),
    },
  };
});
// The ingest forms do their own I/O. Stand them in with a button that fires the
// page's callback, so the "re-read the list after an ingest" wiring is covered
// without dragging the real upload/fetch machinery into a page test.
vi.mock("@/components/projects/document-uploader", () => ({
  DocumentUploader: ({ onUploaded }: { onUploaded: () => void }) => (
    <button onClick={onUploaded}>stub-uploaded</button>
  ),
}));
vi.mock("@/components/projects/url-ingest-form", () => ({
  UrlIngestForm: ({ onIngested }: { onIngested: () => void }) => (
    <button onClick={onIngested}>stub-url-ingested</button>
  ),
}));
vi.mock("@/components/projects/text-ingest-form", () => ({
  TextIngestForm: ({ onIngested }: { onIngested: () => void }) => (
    <button onClick={onIngested}>stub-text-ingested</button>
  ),
}));

const PROJECT_ID = "proj-69";

const { default: ProjectDocumentsPage } =
  await import("@/app/(authed)/projects/[id]/documents/page");

function doc(over: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: "d1",
    projectId: PROJECT_ID,
    filename: "spec.pdf",
    mimeType: "application/pdf",
    sizeBytes: 2048,
    status: "processing",
    indexState: null,
    chunkCount: 4,
    uploadedAt: "2026-09-22T10:00:00.000Z",
    ...over,
  };
}

function page(items: DocumentRow[]): DocumentListPage {
  return { items, total: items.length, limit: 25, offset: 0 };
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ProjectDocumentsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  listDocuments.mockReset();
  removeDocument.mockReset();
  removeDocument.mockResolvedValue(undefined);
  socketHandlers.clear();
  socketMock.emit.mockClear();
  socketAvailable = false;
  projectStatus = "active";
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Documents page — #69 quarantined documents", () => {
  /**
   * The fake clock is installed BEFORE render: React Query schedules the
   * refetch interval during the first render, and a clock swapped in afterwards
   * never owns that timer — both cases then read "one call", and the quarantine
   * assertion passes against the unfixed page. `shouldAdvanceTime` keeps
   * Testing Library's own real-time polling working.
   */
  async function renderAndRun(items: DocumentRow[]): Promise<void> {
    listDocuments.mockResolvedValue(page(items));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPage();
    await screen.findByTestId("document-list");
    await vi.advanceTimersByTimeAsync(12_000);
  }

  it("stops polling when the only unfinished document is quarantined", async () => {
    await renderAndRun([doc({ indexState: "quarantined" })]);
    expect(listDocuments).toHaveBeenCalledTimes(1);
  });

  it("still polls while a document is genuinely ingesting", async () => {
    await renderAndRun([doc({ status: "processing", indexState: null })]);
    expect(listDocuments.mock.calls.length).toBeGreaterThan(1);
  });

  it("reads a quarantined row as awaiting review, not as processing", async () => {
    listDocuments.mockResolvedValue(page([doc({ indexState: "quarantined" })]));
    renderPage();

    const row = await screen.findByTestId("document-row-d1");
    expect(row).toHaveTextContent(/awaiting review/i);
    expect(row).not.toHaveTextContent(/processing/i);
  });

  it("links a quarantined row to the quarantine queue", async () => {
    listDocuments.mockResolvedValue(page([doc({ indexState: "quarantined" })]));
    renderPage();

    const link = await screen.findByRole("link", { name: /review/i });
    expect(link).toHaveAttribute("href", `/projects/${PROJECT_ID}/settings#quarantine`);
  });

  it("leaves an ordinary document's status wording alone", async () => {
    listDocuments.mockResolvedValue(page([doc({ id: "d2", status: "ready", chunkCount: 7 })]));
    renderPage();

    const row = await screen.findByTestId("document-row-d2");
    await waitFor(() => expect(row).toHaveTextContent(/ready · 7 chunks/i));
    expect(screen.queryByRole("link", { name: /review/i })).toBeNull();
  });
});

describe("Documents page — surrounding behaviour", () => {
  it("re-reads the list when an ingest reports it finished", async () => {
    listDocuments.mockResolvedValue(page([]));
    renderPage();
    await screen.findByText("No documents yet.");

    for (const label of ["stub-uploaded", "stub-url-ingested", "stub-text-ingested"]) {
      fireEvent.click(screen.getByText(label));
    }
    await waitFor(() => expect(listDocuments.mock.calls.length).toBeGreaterThan(1));
  });

  it("re-reads the list on a document:status push for this project only", async () => {
    socketAvailable = true;
    listDocuments.mockResolvedValue(page([doc()]));
    renderPage();
    await screen.findByTestId("document-list");
    expect(socketMock.emit).toHaveBeenCalledWith("subscribe:project", { projectId: PROJECT_ID });

    const before = listDocuments.mock.calls.length;
    await act(async () => {
      socketHandlers.get("document:status")?.({ projectId: "someone-else" });
    });
    expect(listDocuments.mock.calls.length).toBe(before);

    await act(async () => {
      socketHandlers.get("document:status")?.({ projectId: PROJECT_ID });
    });
    await waitFor(() => expect(listDocuments.mock.calls.length).toBeGreaterThan(before));
  });

  it("deletes a document through the API", async () => {
    listDocuments.mockResolvedValue(page([doc()]));
    renderPage();
    await screen.findByTestId("document-row-d1");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(removeDocument).toHaveBeenCalledWith(PROJECT_ID, "d1"));
  });

  it("disables uploads on an archived project", async () => {
    projectStatus = "archived";
    listDocuments.mockResolvedValue(page([]));
    renderPage();

    expect(await screen.findByText(/archived; uploads are disabled/i)).toBeInTheDocument();
    expect(screen.queryByText("stub-uploaded")).toBeNull();
  });
});
