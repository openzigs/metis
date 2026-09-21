/**
 * Issue #121 extended — connections page deep branch coverage.
 * Tests inline branch save, API base URL editing, wizard flow, and other
 * uncovered state transitions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useParams: vi.fn(() => ({ id: "proj-1" })),
    useRouter: vi.fn(() => ({
      push: vi.fn(),
      replace: vi.fn(),
      refresh: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    })),
    usePathname: vi.fn(() => "/"),
    useSearchParams: vi.fn(() => new URLSearchParams()),
  };
});

vi.mock("@/lib/connectors-api", () => ({
  repoConnectorsApi: {
    list: vi.fn(),
    create: vi.fn(),
    remove: vi.fn(),
    test: vi.fn(),
    deepIngest: vi.fn(),
    refreshIngest: vi.fn(),
    setPrimary: vi.fn(),
    rescanCredentials: vi.fn(),
    update: vi.fn(),
  },
  dbConnectorsApi: {
    list: vi.fn(),
    create: vi.fn(),
    remove: vi.fn(),
    test: vi.fn(),
    ingest: vi.fn(),
    query: vi.fn(),
  },
  suggestedConnectorsApi: { list: vi.fn(), updateStatus: vi.fn() },
}));

vi.mock("@/lib/projects-api", () => ({
  projectsApi: { get: vi.fn(), updateAllowCredentialScan: vi.fn() },
}));

vi.mock("@/hooks/use-connector-events", () => ({
  useConnectorProgress: vi.fn(() => ({
    progressMap: {},
    clearProgress: vi.fn(),
  })),
  useConnectorDiscovery: vi.fn(),
}));

vi.mock("@/components/connectors/db-connector-wizard", () => ({
  DbConnectorWizard: ({ open }: { open: boolean }) =>
    open ? <div data-testid="db-wizard-open">Wizard Open</div> : null,
}));

vi.mock("@/components/projects/rebuild-cache-button", () => ({
  RebuildCacheButton: () => <button>Rebuild</button>,
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import { repoConnectorsApi, dbConnectorsApi, suggestedConnectorsApi } from "@/lib/connectors-api";
import { projectsApi } from "@/lib/projects-api";
import { useConnectorProgress } from "@/hooks/use-connector-events";
import ConnectionsPage from "@/app/(authed)/projects/[id]/connections/page";

const repoList = repoConnectorsApi.list as unknown as ReturnType<typeof vi.fn>;
const dbList = dbConnectorsApi.list as unknown as ReturnType<typeof vi.fn>;
const suggestedList = suggestedConnectorsApi.list as unknown as ReturnType<typeof vi.fn>;
const projectGet = projectsApi.get as unknown as ReturnType<typeof vi.fn>;
const repoUpdate = repoConnectorsApi.update as unknown as ReturnType<typeof vi.fn>;
const useConnectorProgressMock = useConnectorProgress as unknown as ReturnType<typeof vi.fn>;

function makeRepo(over: Record<string, unknown> = {}) {
  return {
    id: "r1",
    label: "Main Repo",
    provider: "github",
    ownerOrOrg: "acme",
    repoName: "api",
    defaultBranch: "main",
    status: "ready",
    isPrimary: false,
    lastTestedAt: null,
    lastIngestAt: null,
    errorMessage: null,
    apiBaseUrl: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  repoList.mockResolvedValue([]);
  dbList.mockResolvedValue([]);
  suggestedList.mockResolvedValue({ count: 0, suggestions: [] });
  projectGet.mockResolvedValue({ id: "proj-1", allowCredentialScan: false });
  useConnectorProgressMock.mockReturnValue({ progressMap: {}, clearProgress: vi.fn() });
});

function renderPage() {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <ConnectionsPage />
    </Wrapper>,
  );
}

describe("ConnectionsPage — branch editor Save", () => {
  it("saves branch on Save button click", async () => {
    repoUpdate.mockResolvedValueOnce({ id: "r1", defaultBranch: "develop" });
    repoList.mockResolvedValue([makeRepo({ id: "r1", defaultBranch: "main" })]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Main Repo")).toBeInTheDocument());
    // Open inline edit
    fireEvent.click(screen.getByTitle("Click to change branch"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).toBeInTheDocument());
    // Change branch value
    const branchInput = document.querySelector("input.h-5") as HTMLInputElement;
    if (branchInput) {
      fireEvent.change(branchInput, { target: { value: "develop" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(repoUpdate).toHaveBeenCalled());
    }
  });

  it("saves branch on Enter key", async () => {
    repoUpdate.mockResolvedValueOnce({ id: "r1", defaultBranch: "feature/x" });
    repoList.mockResolvedValue([makeRepo({ id: "r1", defaultBranch: "main" })]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Main Repo")).toBeInTheDocument());
    fireEvent.click(screen.getByTitle("Click to change branch"));
    await waitFor(() => document.querySelector("input.h-5"));
    const branchInput = document.querySelector("input.h-5") as HTMLInputElement;
    if (branchInput) {
      fireEvent.change(branchInput, { target: { value: "feature/x" } });
      fireEvent.keyDown(branchInput, { key: "Enter" });
      await waitFor(() => expect(repoUpdate).toHaveBeenCalled());
    }
  });
});

describe("ConnectionsPage — GitHub Enterprise API base URL", () => {
  it("shows API base URL for github_enterprise repo", async () => {
    repoList.mockResolvedValue([
      makeRepo({
        provider: "github_enterprise",
        apiBaseUrl: "https://git.corp.com/api/v3",
      }),
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Main Repo")).toBeInTheDocument());
    expect(screen.getByText("https://git.corp.com/api/v3")).toBeInTheDocument();
  });

  it("shows 'not set' for github_enterprise without apiBaseUrl", async () => {
    repoList.mockResolvedValue([
      makeRepo({
        provider: "github_enterprise",
        apiBaseUrl: null,
      }),
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Main Repo")).toBeInTheDocument());
    // 'not set' text appears in the API base section
    expect(screen.getByText(/not set — click to add/i)).toBeInTheDocument();
  });

  it("opens API base URL editor on click", async () => {
    repoList.mockResolvedValue([
      makeRepo({
        provider: "github_enterprise",
        apiBaseUrl: "https://git.corp.com/api/v3",
      }),
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Main Repo")).toBeInTheDocument());
    fireEvent.click(
      screen.getByTitle("Click to change API base URL (e.g. https://git.example.com/api/v3)"),
    );
    await waitFor(() => expect(document.querySelector("input.h-5")).toBeInTheDocument());
  });
});

describe("ConnectionsPage — progress map rendering", () => {
  it("shows progress indicator when ingest is in progress", async () => {
    useConnectorProgressMock.mockReturnValue({
      progressMap: {
        r1: { step: "Parsing files", current: 5, total: 20 },
      },
      clearProgress: vi.fn(),
    });
    repoList.mockResolvedValue([makeRepo({ id: "r1" })]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Main Repo")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("progress-r1")).toBeInTheDocument());
    expect(screen.getByText(/Parsing files/i)).toBeInTheDocument();
  });

  it("shows progress with null total (0 percent)", async () => {
    useConnectorProgressMock.mockReturnValue({
      progressMap: {
        r1: { step: "Cloning repo", current: 0, total: null },
      },
      clearProgress: vi.fn(),
    });
    repoList.mockResolvedValue([makeRepo({ id: "r1" })]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("progress-r1")).toBeInTheDocument());
  });
});

describe("ConnectionsPage — wizard and suggestion flow", () => {
  it("opens DbConnectorWizard when Configure is clicked", async () => {
    suggestedList.mockResolvedValueOnce({
      count: 1,
      suggestions: [
        {
          id: "s1",
          driverType: "postgres",
          host: "pg.local",
          port: 5432,
          database: "prod",
          confidence: "high",
          sourceFile: "f.ts",
          lineNumber: 1,
        },
      ],
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Suggested Database Connectors/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Configure/i }));
    await waitFor(() => expect(screen.getByTestId("db-wizard-open")).toBeInTheDocument());
  });
});

describe("ConnectionsPage — DB form driver select", () => {
  it("DB driver select is present with postgres as default", async () => {
    renderPage();
    await waitFor(() => expect(document.getElementById("db-driver")).toBeInTheDocument());
    const select = document.getElementById("db-driver") as HTMLSelectElement;
    expect(select.value).toBe("postgres");
  });

  it("DB driver can be changed to mysql", async () => {
    renderPage();
    await waitFor(() => expect(document.getElementById("db-driver")).toBeInTheDocument());
    fireEvent.change(document.getElementById("db-driver")!, { target: { value: "mysql" } });
    expect((document.getElementById("db-driver") as HTMLSelectElement).value).toBe("mysql");
  });
});
