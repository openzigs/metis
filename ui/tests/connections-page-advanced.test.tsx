/**
 * Issue #121 extended — advanced connection page branch coverage.
 * Tests the vault ref validation, inline branch editing, and
 * multi-repo scenarios to cover deep conditional branches.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  useConnectorProgress: vi.fn(() => ({ progressMap: {}, clearProgress: vi.fn() })),
  useConnectorDiscovery: vi.fn(),
}));

vi.mock("@/components/connectors/db-connector-wizard", () => ({
  DbConnectorWizard: () => <div data-testid="db-connector-wizard" />,
}));

vi.mock("@/components/projects/rebuild-cache-button", () => ({
  RebuildCacheButton: () => <button>Rebuild</button>,
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import { repoConnectorsApi, dbConnectorsApi, suggestedConnectorsApi } from "@/lib/connectors-api";
import { projectsApi } from "@/lib/projects-api";
import ConnectionsPage from "@/app/(authed)/projects/[id]/connections/page";

const repoList = repoConnectorsApi.list as unknown as ReturnType<typeof vi.fn>;
const dbList = dbConnectorsApi.list as unknown as ReturnType<typeof vi.fn>;
const suggestedList = suggestedConnectorsApi.list as unknown as ReturnType<typeof vi.fn>;
const projectGet = projectsApi.get as unknown as ReturnType<typeof vi.fn>;
const setPrimary = repoConnectorsApi.setPrimary as unknown as ReturnType<typeof vi.fn>;
const deepIngest = repoConnectorsApi.deepIngest as unknown as ReturnType<typeof vi.fn>;
const refreshIngest = repoConnectorsApi.refreshIngest as unknown as ReturnType<typeof vi.fn>;

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
});

function renderPage() {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <ConnectionsPage />
    </Wrapper>,
  );
}

describe("ConnectionsPage — vault ref validation", () => {
  it("shows vault ref warning when secret ref is invalid", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(document.getElementById("repo-secret")).toBeInTheDocument());
    // Open the vault picker and switch to free-text ("custom") entry.
    await user.click(document.getElementById("repo-secret")!);
    await user.click(await screen.findByText(/Enter custom ref/i));
    const secretInput = await waitFor(() => {
      const el = document.getElementById("repo-secret-custom");
      expect(el).toBeInTheDocument();
      return el!;
    });
    fireEvent.change(secretInput, { target: { value: "not-a-vault-ref" } });
    await waitFor(() => expect(screen.getByText(/Secret ref must look like/i)).toBeInTheDocument());
  });

  it("no warning when secret ref is empty (valid: empty = no auth)", async () => {
    renderPage();
    await waitFor(() => expect(document.getElementById("repo-secret")).toBeInTheDocument());
    // Empty secret ref should not show a warning
    expect(screen.queryByText(/Secret ref must look like/i)).not.toBeInTheDocument();
  });

  it("no warning for valid vault ref ${vault:name}", async () => {
    renderPage();
    await waitFor(() => expect(document.getElementById("repo-secret")).toBeInTheDocument());
    const secretInput = document.getElementById("repo-secret")!;
    fireEvent.change(secretInput, { target: { value: "${vault:gh-token}" } });
    expect(screen.queryByText(/Secret ref must look like/i)).not.toBeInTheDocument();
  });
});

describe("ConnectionsPage — inline branch editing", () => {
  it("shows inline edit input when branch name is clicked", async () => {
    repoList.mockResolvedValue([makeRepo({ id: "r1", defaultBranch: "main" })]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Main Repo")).toBeInTheDocument());
    // Click the "main" branch text button
    const branchBtn = screen.getByTitle("Click to change branch");
    fireEvent.click(branchBtn);
    // After click, an inline text input should appear
    await waitFor(() => {
      // The editingBranchId is now set, so the input renders
      const inputs = document.querySelectorAll('input[class*="h-5"]');
      expect(inputs.length > 0 || document.querySelector(".h-5.w-32")).toBeTruthy();
    });
  });

  it("closes inline edit on ✕ click", async () => {
    repoList.mockResolvedValue([makeRepo({ id: "r1", defaultBranch: "main" })]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Main Repo")).toBeInTheDocument());
    fireEvent.click(screen.getByTitle("Click to change branch"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "\u2715" })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "\u2715" }));
    // After cancel, the original branch text button should be visible again
    await waitFor(() => expect(screen.getByTitle("Click to change branch")).toBeInTheDocument());
  });
});

describe("ConnectionsPage — two repos (set primary + deep ingest)", () => {
  it("shows 'Set as primary' button when there are multiple repos and one is not primary", async () => {
    repoList.mockResolvedValue([
      makeRepo({ id: "r1", isPrimary: false }),
      makeRepo({ id: "r2", isPrimary: true, label: "Second Repo" }),
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("set-primary-r1")).toBeInTheDocument());
  });

  it("calls setPrimary when 'Set as primary' is clicked", async () => {
    setPrimary.mockResolvedValueOnce({});
    repoList.mockResolvedValue([
      makeRepo({ id: "r1", isPrimary: false }),
      makeRepo({ id: "r2", isPrimary: true, label: "Secondary" }),
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("set-primary-r1")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("set-primary-r1"));
    await waitFor(() => expect(setPrimary).toHaveBeenCalledWith("proj-1", "r1"));
  });
});

describe("ConnectionsPage — deep ingest and refresh ingest", () => {
  it("shows Deep Ingest and Sync buttons for repo", async () => {
    repoList.mockResolvedValue([makeRepo({ id: "r1" })]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Deep Ingest/i })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /^Sync$/ })).toBeInTheDocument();
  });

  it("calls deepIngest when Deep Ingest is clicked and shows result summary", async () => {
    deepIngest.mockResolvedValueOnce({
      codeGraph: { filesScanned: 10, filesParsed: 8, symbolsUpserted: 150, edgesUpserted: 200 },
      sourceKnowledge: { documentsCreated: 3, chunkCount: 45 },
      cloneSizeBytes: 5242880,
    });
    repoList.mockResolvedValue([makeRepo({ id: "r1" })]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Deep Ingest/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Deep Ingest/i }));
    await waitFor(() => expect(deepIngest).toHaveBeenCalledWith("proj-1", "r1"));
    await waitFor(() => expect(screen.getByText(/Deep ingest complete/i)).toBeInTheDocument());
  });

  it("calls refreshIngest when Sync is clicked and shows result summary", async () => {
    refreshIngest.mockResolvedValueOnce({
      pulled: true,
      filesChanged: 3,
      codeGraph: {
        filesScanned: 5,
        filesParsed: 3,
        filesSkipped: 2,
        symbolsUpserted: 50,
        edgesUpserted: 80,
        durationMs: 1000,
      },
      sourceKnowledge: { documentsCreated: 1, documentsUpdated: 2, chunkCount: 15 },
      cloneSizeBytes: 1048576,
    });
    repoList.mockResolvedValue([makeRepo({ id: "r1" })]);
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: /^Sync$/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^Sync$/ }));
    await waitFor(() => expect(refreshIngest).toHaveBeenCalledWith("proj-1", "r1"));
    await waitFor(() => expect(screen.getByText(/Sync complete/i)).toBeInTheDocument());
  });
});

describe("ConnectionsPage — DB allow list fields", () => {
  it("renders allowed tables and columns inputs", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText(/Allowed tables/i)).toBeInTheDocument());
    expect(screen.getByLabelText(/Allowed columns/i)).toBeInTheDocument();
  });
});
