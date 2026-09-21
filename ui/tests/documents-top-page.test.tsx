/**
 * Epic #196 / #223 — Top-level /documents tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
import DocumentsTopLevelPage from "@/app/(authed)/documents/page";
import { documentsApi, projectsApi } from "@/lib/projects-api";
import { ApiError } from "@/lib/api-client";

vi.mock("@/lib/projects-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects-api")>("@/lib/projects-api");
  return {
    ...actual,
    projectsApi: { list: vi.fn() },
    documentsApi: { list: vi.fn() },
  };
});

const projectsListMock = vi.mocked(projectsApi.list);
const documentsListMock = vi.mocked(documentsApi.list);

function project(id: string, name: string) {
  return {
    id,
    name,
    slug: id,
    status: "active" as const,
    createdById: "u_1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function doc(id: string, projectId: string, filename: string) {
  return {
    id,
    projectId,
    filename,
    mimeType: "text/markdown",
    sizeBytes: 100,
    status: "ready" as const,
    chunkCount: 4,
    uploadedAt: new Date(`2026-04-2${id.slice(-1)}T12:00:00Z`).toISOString(),
  };
}

function renderPage() {
  const Wrapper = makeWrapper({ withAuth: false });
  render(
    <Wrapper>
      <DocumentsTopLevelPage />
    </Wrapper>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  projectsListMock.mockResolvedValue({
    items: [project("p1", "Alpha"), project("p2", "Beta")],
    total: 2,
    limit: 100,
    offset: 0,
  });
  documentsListMock.mockImplementation(async (projectId: string) => ({
    items:
      projectId === "p1"
        ? [doc("d1", "p1", "alpha-1.md"), doc("d2", "p1", "alpha-2.md")]
        : [doc("d3", "p2", "beta-1.md")],
    total: projectId === "p1" ? 2 : 1,
    limit: 100,
    offset: 0,
  }));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("<DocumentsTopLevelPage />", () => {
  it("aggregates documents across every accessible project", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("documents-top-table")).toBeInTheDocument());
    expect(screen.getByTestId("documents-top-row-d1")).toBeInTheDocument();
    expect(screen.getByTestId("documents-top-row-d2")).toBeInTheDocument();
    expect(screen.getByTestId("documents-top-row-d3")).toBeInTheDocument();
    expect(screen.getByText(/3 documents visible/)).toBeInTheDocument();
  });

  it("filters by project when the dropdown changes", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("documents-top-table")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("documents-top-project-filter"), {
      target: { value: "p2" },
    });
    expect(screen.queryByTestId("documents-top-row-d1")).not.toBeInTheDocument();
    expect(screen.getByTestId("documents-top-row-d3")).toBeInTheDocument();
  });

  it("renders the empty-state when no documents are visible", async () => {
    documentsListMock.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("documents-top-empty")).toBeInTheDocument());
  });

  it("surfaces a project list error inline", async () => {
    projectsListMock.mockRejectedValueOnce(new ApiError(500, "boom"));
    renderPage();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("boom"));
  });

  it("renders the upload hint card", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("documents-top-upload-hint")).toBeInTheDocument(),
    );
  });

  it("links each row back into the owning project's documents tab", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("documents-top-row-d1")).toBeInTheDocument());
    expect(screen.getByTestId("documents-top-open-d1")).toHaveAttribute(
      "href",
      "/projects/p1/documents",
    );
  });
});
