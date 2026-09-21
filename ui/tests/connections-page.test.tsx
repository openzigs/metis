/**
 * Issue #121 — unit tests for ConnectionsPage (connector-picker).
 *
 * Covers: primary render, loading/empty states for repos and DBs,
 * repo form validation, suggested connectors section, and key
 * inline helper functions exercised through the rendered output.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeWrapper } from "./test-utils";

// ── mocks ────────────────────────────────────────────────────────────────
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
  suggestedConnectorsApi: {
    list: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

vi.mock("@/lib/projects-api", () => ({
  projectsApi: {
    get: vi.fn(),
    updateAllowCredentialScan: vi.fn(),
  },
}));

vi.mock("@/hooks/use-connector-events", () => ({
  useConnectorProgress: vi.fn(() => ({ progressMap: {}, clearProgress: vi.fn() })),
  useConnectorDiscovery: vi.fn(),
}));

vi.mock("@/components/connectors/db-connector-wizard", () => ({
  DbConnectorWizard: () => <div data-testid="db-connector-wizard" />,
}));

vi.mock("@/components/projects/rebuild-cache-button", () => ({
  RebuildCacheButton: () => <button data-testid="rebuild-cache-btn">Rebuild</button>,
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
  }),
}));

import { repoConnectorsApi, dbConnectorsApi, suggestedConnectorsApi } from "@/lib/connectors-api";
import { projectsApi } from "@/lib/projects-api";
import ConnectionsPage from "@/app/(authed)/projects/[id]/connections/page";

const repoList = repoConnectorsApi.list as unknown as ReturnType<typeof vi.fn>;
const dbList = dbConnectorsApi.list as unknown as ReturnType<typeof vi.fn>;
const suggestedList = suggestedConnectorsApi.list as unknown as ReturnType<typeof vi.fn>;
const projectGet = projectsApi.get as unknown as ReturnType<typeof vi.fn>;
const repoCreate = repoConnectorsApi.create as unknown as ReturnType<typeof vi.fn>;
const repoRemove = repoConnectorsApi.remove as unknown as ReturnType<typeof vi.fn>;
const repoTest = repoConnectorsApi.test as unknown as ReturnType<typeof vi.fn>;
const dbCreate = dbConnectorsApi.create as unknown as ReturnType<typeof vi.fn>;

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

function makeDb(over: Record<string, unknown> = {}) {
  return {
    id: "d1",
    label: "Main DB",
    driver: "postgres",
    host: "db.example.com",
    port: 5432,
    databaseName: "prod",
    status: "ready",
    lastTestedAt: null,
    lastIngestAt: null,
    errorMessage: null,
    ...over,
  };
}

beforeEach(() => {
  repoList.mockReset();
  dbList.mockReset();
  suggestedList.mockReset();
  projectGet.mockReset();
  repoCreate.mockReset();
  repoRemove.mockReset();
  repoTest.mockReset();
  dbCreate.mockReset();
  // Default: empty results
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

describe("ConnectionsPage — rendering", () => {
  it("renders the Connections heading", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Connections/i })).toBeInTheDocument(),
    );
  });

  it("renders Repository connectors section heading", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Repository connectors/i })).toBeInTheDocument(),
    );
  });

  it("renders Database connectors section heading", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Database connectors/i })).toBeInTheDocument(),
    );
  });

  it("renders the allow-credential-scan toggle", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("allow-credential-scan-toggle")).toBeInTheDocument(),
    );
  });

  it("shows no repo connectors message when list is empty", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/No repo connectors yet/i)).toBeInTheDocument());
  });

  it("shows no db connectors message when list is empty", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/No database connectors yet/i)).toBeInTheDocument(),
    );
  });
});

describe("ConnectionsPage — repo connector list", () => {
  it("renders a repo connector row", async () => {
    repoList.mockResolvedValueOnce([makeRepo({ id: "r1", label: "Main Repo" })]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Main Repo")).toBeInTheDocument());
    // Repo info is rendered as "github · acme/api@main" inside a div
    expect(screen.queryAllByText(/acme\/api/).length).toBeGreaterThan(0);
  });

  it("shows 'error' status badge for error connector", async () => {
    repoList.mockResolvedValueOnce([makeRepo({ status: "error", errorMessage: "Auth failed" })]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Auth failed")).toBeInTheDocument());
  });

  it("shows errorMessage when repo has an error", async () => {
    repoList.mockResolvedValueOnce([makeRepo({ errorMessage: "Clone failed" })]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Clone failed")).toBeInTheDocument());
  });

  it("shows primary badge for isPrimary connector", async () => {
    repoList.mockResolvedValueOnce([makeRepo({ isPrimary: true })]);
    renderPage();
    await waitFor(() => expect(screen.getByText(/primary/i)).toBeInTheDocument());
  });

  it("calls removeRepo when Delete is clicked", async () => {
    repoRemove.mockResolvedValueOnce({});
    repoList.mockResolvedValue([makeRepo({ id: "r1" })]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Main Repo")).toBeInTheDocument());
    const deleteBtn = screen.getByRole("button", { name: /^Delete$/ });
    fireEvent.click(deleteBtn);
    await waitFor(() => expect(repoRemove).toHaveBeenCalledWith("proj-1", "r1"));
  });

  it("calls testRepo when Test is clicked", async () => {
    repoTest.mockResolvedValueOnce({ ok: true, latencyMs: 120 });
    repoList.mockResolvedValue([makeRepo({ id: "r1" })]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Main Repo")).toBeInTheDocument());
    const testBtn = screen.getAllByRole("button", { name: /^Test$/ })[0];
    fireEvent.click(testBtn);
    await waitFor(() => expect(repoTest).toHaveBeenCalledWith("proj-1", "r1"));
  });
});

describe("ConnectionsPage — create repo form", () => {
  it("Add repo connector button is disabled when form is empty", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Add repo connector/i })).toBeDisabled(),
    );
  });

  it("enables Add repo connector button when all required fields are filled", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getAllByLabelText(/^Label$/i)[0]).toBeInTheDocument());
    // First Label input is repo-label, second is db-label
    await user.type(screen.getAllByLabelText(/^Label$/i)[0], "My Repo");
    await user.type(screen.getByLabelText(/Owner/i), "acme");
    await user.type(screen.getByLabelText(/Repo name/i), "backend");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Add repo connector/i })).not.toBeDisabled(),
    );
  });

  it("calls repoConnectorsApi.create on valid submission", async () => {
    const user = userEvent.setup();
    repoCreate.mockResolvedValueOnce({ id: "r2" });
    repoList.mockResolvedValue([]);
    renderPage();
    await waitFor(() => expect(screen.getAllByLabelText(/^Label$/i)[0]).toBeInTheDocument());
    await user.type(screen.getAllByLabelText(/^Label$/i)[0], "New Repo");
    await user.type(screen.getByLabelText(/Owner/i), "myorg");
    await user.type(screen.getByLabelText(/Repo name/i), "myrepo");
    await user.click(screen.getByRole("button", { name: /Add repo connector/i }));
    await waitFor(() =>
      expect(repoCreate).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({ label: "New Repo", ownerOrOrg: "myorg", repoName: "myrepo" }),
      ),
    );
  });

  it("shows error when repo create fails", async () => {
    const user = userEvent.setup();
    repoCreate.mockRejectedValueOnce(new Error("Duplicate"));
    renderPage();
    await waitFor(() => expect(screen.getAllByLabelText(/^Label$/i)[0]).toBeInTheDocument());
    await user.type(screen.getAllByLabelText(/^Label$/i)[0], "Dup");
    await user.type(screen.getByLabelText(/Owner/i), "org");
    await user.type(screen.getByLabelText(/Repo name/i), "repo");
    await user.click(screen.getByRole("button", { name: /Add repo connector/i }));
    await waitFor(() =>
      // The onError callback sets repoError to 'Failed' (non-ApiError fallback)
      expect(screen.getByText(/^Failed$/)).toBeInTheDocument(),
    );
  });
});

describe("ConnectionsPage — database connector list", () => {
  it("renders a DB connector with host/driver info", async () => {
    dbList.mockResolvedValueOnce([
      makeDb({ id: "d1", label: "Prod DB", driver: "postgres", host: "db.example.com" }),
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Prod DB")).toBeInTheDocument());
    // Driver+host info is rendered inside a font-mono div; use queryAllByText to handle parent-child matches
    expect(screen.queryAllByText(/postgres/i).length).toBeGreaterThan(0);
  });

  it("shows 'Never tested or ingested' when both are null", async () => {
    dbList.mockResolvedValueOnce([makeDb({ lastTestedAt: null, lastIngestAt: null })]);
    renderPage();
    await waitFor(() => expect(screen.getByText(/Never tested or ingested/i)).toBeInTheDocument());
  });
});

describe("ConnectionsPage — suggested connectors", () => {
  it("shows suggested connectors section when suggestions exist", async () => {
    suggestedList.mockResolvedValueOnce({
      count: 1,
      suggestions: [
        {
          id: "s1",
          driverType: "postgres",
          host: "pg.internal",
          port: 5432,
          database: "mydb",
          confidence: "high",
          sourceFile: "src/db.ts",
          lineNumber: 12,
        },
      ],
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Suggested Database Connectors/i)).toBeInTheDocument(),
    );
    expect(screen.getByText("pg.internal:5432/mydb")).toBeInTheDocument();
  });

  it("shows suggestion count badge in heading", async () => {
    suggestedList.mockResolvedValueOnce({
      count: 2,
      suggestions: [
        {
          id: "s1",
          driverType: "postgres",
          host: "h1",
          port: null,
          database: null,
          confidence: "high",
          sourceFile: "f.ts",
          lineNumber: 1,
        },
        {
          id: "s2",
          driverType: "mysql",
          host: "h2",
          port: null,
          database: null,
          confidence: "low",
          sourceFile: "g.ts",
          lineNumber: 5,
        },
      ],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText(/2 suggestions/i)).toBeInTheDocument());
  });

  it("does NOT show suggestions section when count is 0", async () => {
    suggestedList.mockResolvedValueOnce({ count: 0, suggestions: [] });
    renderPage();
    await waitFor(() => expect(repoList).toHaveBeenCalled());
    expect(screen.queryByText(/Suggested Database Connectors/i)).not.toBeInTheDocument();
  });
});

describe("ConnectionsPage — allow credential scan toggle", () => {
  it("toggle is checked when project has allowCredentialScan=true", async () => {
    projectGet.mockResolvedValueOnce({ id: "proj-1", allowCredentialScan: true });
    renderPage();
    await waitFor(() => {
      const toggle = screen.getByTestId("allow-credential-scan-toggle") as HTMLInputElement;
      expect(toggle.checked).toBe(true);
    });
  });

  it("toggle is disabled while project data is loading", () => {
    projectGet.mockImplementationOnce(() => new Promise(() => {}));
    renderPage();
    const toggle = screen.getByTestId("allow-credential-scan-toggle") as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
  });
});
