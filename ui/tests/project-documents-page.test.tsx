/**
 * N3 (#141) — Project Documents page (split out of the project index).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

const notFound = vi.fn();

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    notFound: () => notFound(),
    useParams: () => ({ id: "p1" }),
    usePathname: () => "/projects/p1/documents",
    useRouter: () => ({
      push: vi.fn(),
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
      refresh: vi.fn(),
    }),
    useSearchParams: () => new URLSearchParams(),
  };
});

const { socketStub } = vi.hoisted(() => ({
  socketStub: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

vi.mock("@/lib/socket-client", () => ({
  useSocket: () => socketStub,
}));

vi.mock("@/components/projects/document-uploader", () => ({
  DocumentUploader: () => <div data-testid="mock-uploader" />,
}));
vi.mock("@/components/projects/url-ingest-form", () => ({
  UrlIngestForm: () => <div data-testid="mock-url-ingest" />,
}));
vi.mock("@/components/projects/text-ingest-form", () => ({
  TextIngestForm: () => <div data-testid="mock-text-ingest" />,
}));

vi.mock("@/lib/projects-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects-api")>("@/lib/projects-api");
  return {
    ...actual,
    projectsApi: { ...actual.projectsApi, get: vi.fn() },
    documentsApi: { ...actual.documentsApi, list: vi.fn(), remove: vi.fn() },
  };
});

import { projectsApi, documentsApi } from "@/lib/projects-api";
import { ApiError } from "@/lib/api-client";
import ProjectDocumentsPage from "@/app/(authed)/projects/[id]/documents/page";

const get = projectsApi.get as unknown as ReturnType<typeof vi.fn>;
const list = documentsApi.list as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  get.mockReset();
  list.mockReset();
  notFound.mockReset();
  socketStub.on.mockReset();
  socketStub.off.mockReset();
  socketStub.emit.mockReset();
});

describe("ProjectDocumentsPage", () => {
  it("renders the Documents heading and uploader affordances", async () => {
    get.mockResolvedValue({ id: "p1", name: "Proj", slug: "proj", status: "active" });
    list.mockResolvedValue({ items: [] });
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <ProjectDocumentsPage />
      </Wrapper>,
    );
    expect(screen.getByRole("heading", { name: "Documents", level: 1 })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("mock-uploader")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("No documents yet.")).toBeInTheDocument());
  });

  it("lists existing documents", async () => {
    get.mockResolvedValue({ id: "p1", name: "Proj", slug: "proj", status: "active" });
    list.mockResolvedValue({
      items: [
        {
          id: "d1",
          filename: "spec.md",
          status: "ready",
          chunkCount: 3,
          sizeBytes: 2048,
          errorMessage: null,
        },
      ],
    });
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <ProjectDocumentsPage />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByTestId("document-row-d1")).toBeInTheDocument());
    expect(screen.getByText("spec.md")).toBeInTheDocument();
  });

  it("disables uploads for archived projects", async () => {
    get.mockResolvedValue({ id: "p1", name: "Proj", slug: "proj", status: "archived" });
    list.mockResolvedValue({ items: [] });
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <ProjectDocumentsPage />
      </Wrapper>,
    );
    await waitFor(() =>
      expect(
        screen.getByText("This project is archived; uploads are disabled."),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("mock-uploader")).not.toBeInTheDocument();
  });

  it("triggers the not-found boundary when the project fetch 404s (#143)", async () => {
    get.mockRejectedValue(new ApiError(404, "Not found"));
    list.mockResolvedValue({ items: [] });
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <ProjectDocumentsPage />
      </Wrapper>,
    );
    await waitFor(() => expect(notFound).toHaveBeenCalled());
  });

  it("does not trigger the not-found boundary on a non-404 error", async () => {
    get.mockRejectedValue(new ApiError(500, "Server error"));
    list.mockResolvedValue({ items: [] });
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <ProjectDocumentsPage />
      </Wrapper>,
    );
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(notFound).not.toHaveBeenCalled();
  });

  it("refetches the list on a `document:status` push instead of staying stale (background ingest bug)", async () => {
    get.mockResolvedValue({ id: "p1", name: "Proj", slug: "proj", status: "active" });
    list.mockResolvedValue({
      items: [
        {
          id: "d1",
          filename: "spec.md",
          status: "queued",
          chunkCount: 0,
          sizeBytes: 2048,
          errorMessage: null,
        },
      ],
    });
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <ProjectDocumentsPage />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByTestId("document-row-d1")).toBeInTheDocument());

    // Subscribes to the project's room so the server's ingest-lifecycle
    // broadcast reaches this page.
    expect(socketStub.emit).toHaveBeenCalledWith("subscribe:project", { projectId: "p1" });

    const callsBefore = list.mock.calls.length;
    const [, onDocumentStatus] = socketStub.on.mock.calls.find(
      ([event]) => event === "document:status",
    )!;

    list.mockResolvedValue({
      items: [
        {
          id: "d1",
          filename: "spec.md",
          status: "ready",
          chunkCount: 12,
          sizeBytes: 2048,
          errorMessage: null,
        },
      ],
    });
    onDocumentStatus({ projectId: "p1", documentId: "d1", status: "ready", chunkCount: 12 });

    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(callsBefore));
    await waitFor(() => expect(screen.getByText(/12 chunks/)).toBeInTheDocument());
  });
});
