/**
 * Epic #196 / #224 — Top-level /databases tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
import DatabasesTopLevelPage from "@/app/(authed)/databases/page";
import { projectsApi } from "@/lib/projects-api";
import { dbConnectorsApi } from "@/lib/connectors-api";
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
const dbListMock = vi.mocked(dbConnectorsApi.list);

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

function db(id: string, projectId: string, label: string) {
  return {
    id,
    projectId,
    label,
    driver: "postgres" as const,
    host: "db.example.com",
    port: 5432,
    databaseName: label,
    username: "metis",
    secretRef: "",
    options: null,
    status: "connected" as const,
    errorMessage: null,
    lastTestedAt: null,
    lastIngestAt: null,
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
      <DatabasesTopLevelPage />
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
  dbListMock.mockImplementation(async (projectId: string) =>
    projectId === "p1" ? [db("d1", "p1", "primary")] : [db("d2", "p2", "warehouse")],
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("<DatabasesTopLevelPage />", () => {
  it("aggregates databases across every project", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("databases-top-table")).toBeInTheDocument());
    expect(screen.getByTestId("databases-top-row-d1")).toBeInTheDocument();
    expect(screen.getByTestId("databases-top-row-d2")).toBeInTheDocument();
  });

  it("filters by project", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("databases-top-table")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("databases-top-project-filter"), {
      target: { value: "p2" },
    });
    expect(screen.queryByTestId("databases-top-row-d1")).not.toBeInTheDocument();
    expect(screen.getByTestId("databases-top-row-d2")).toBeInTheDocument();
  });

  it("renders the empty state when no databases exist", async () => {
    dbListMock.mockResolvedValue([]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("databases-top-empty")).toBeInTheDocument());
  });

  it("surfaces a project list error inline", async () => {
    projectsListMock.mockRejectedValueOnce(new ApiError(500, "boom"));
    renderPage();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("boom"));
  });

  it("links rows to the owning project's connections tab", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("databases-top-row-d1")).toBeInTheDocument());
    expect(screen.getByTestId("databases-top-open-d1")).toHaveAttribute(
      "href",
      "/projects/p1/connections",
    );
  });
});
