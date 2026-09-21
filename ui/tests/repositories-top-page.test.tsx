/**
 * Epic #196 / #224 — Top-level /repositories tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
import RepositoriesTopLevelPage from "@/app/(authed)/repositories/page";
import { projectsApi } from "@/lib/projects-api";
import { repoConnectorsApi } from "@/lib/connectors-api";
import { ApiError } from "@/lib/api-client";

vi.mock("@/lib/projects-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects-api")>("@/lib/projects-api");
  return {
    ...actual,
    projectsApi: { list: vi.fn() },
  };
});
vi.mock("@/lib/connectors-api", () => ({
  repoConnectorsApi: { list: vi.fn() },
  dbConnectorsApi: { list: vi.fn() },
}));

const projectsListMock = vi.mocked(projectsApi.list);
const repoListMock = vi.mocked(repoConnectorsApi.list);

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

function repo(id: string, projectId: string, label: string) {
  return {
    id,
    projectId,
    label,
    provider: "github" as const,
    ownerOrOrg: "octocat",
    repoName: label,
    hasLocalSource: false,
    hasUploadArchive: false,
    defaultBranch: "main",
    isPrimary: false,
    apiBaseUrl: null,
    secretRef: "",
    status: "connected" as const,
    errorMessage: null,
    lastTestedAt: null,
    lastIngestAt: null,
    lastCommitSha: null,
    createdById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
}

function renderPage() {
  const Wrapper = makeWrapper({ withAuth: false });
  render(
    <Wrapper>
      <RepositoriesTopLevelPage />
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
  repoListMock.mockImplementation(async (projectId: string) =>
    projectId === "p1" ? [repo("r1", "p1", "monorepo")] : [repo("r2", "p2", "legacy")],
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("<RepositoriesTopLevelPage />", () => {
  it("aggregates repositories across projects", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("repositories-top-table")).toBeInTheDocument());
    expect(screen.getByTestId("repositories-top-row-r1")).toBeInTheDocument();
    expect(screen.getByTestId("repositories-top-row-r2")).toBeInTheDocument();
  });

  it("filters by project", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("repositories-top-table")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("repositories-top-project-filter"), {
      target: { value: "p1" },
    });
    expect(screen.getByTestId("repositories-top-row-r1")).toBeInTheDocument();
    expect(screen.queryByTestId("repositories-top-row-r2")).not.toBeInTheDocument();
  });

  it("renders the empty state when no repos exist", async () => {
    repoListMock.mockResolvedValue([]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("repositories-top-empty")).toBeInTheDocument());
  });

  it("surfaces a project list error inline", async () => {
    projectsListMock.mockRejectedValueOnce(new ApiError(500, "boom"));
    renderPage();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("boom"));
  });

  it("links rows to the owning project's connections tab", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("repositories-top-row-r1")).toBeInTheDocument());
    expect(screen.getByTestId("repositories-top-open-r1")).toHaveAttribute(
      "href",
      "/projects/p1/connections",
    );
  });
});
