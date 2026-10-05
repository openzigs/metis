/**
 * Issue #121 extended — advanced connection page branch coverage.
 * Tests the vault ref validation, inline branch editing, and
 * multi-repo scenarios to cover deep conditional branches.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
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

// #373 — Deep Ingest's outcome arrives on the job bus; a fake socket delivers it.
const socketHandlers = new Map<string, Set<(data: unknown) => void>>();
const fakeSocket = {
  emit: vi.fn(),
  on: vi.fn((name: string, fn: (data: unknown) => void) => {
    if (!socketHandlers.has(name)) socketHandlers.set(name, new Set());
    socketHandlers.get(name)!.add(fn);
  }),
  off: vi.fn((name: string, fn: (data: unknown) => void) => {
    socketHandlers.get(name)?.delete(fn);
  }),
};
const fireSocket = (name: string, data: unknown) =>
  socketHandlers.get(name)?.forEach((fn) => fn(data));
vi.mock("@/lib/socket-client", () => ({ useSocket: () => fakeSocket }));

vi.mock("@/components/connectors/db-connector-wizard", () => ({
  DbConnectorWizard: () => <div data-testid="db-connector-wizard" />,
}));

vi.mock("@/components/projects/rebuild-cache-button", () => ({
  RebuildCacheButton: () => <button>Rebuild</button>,
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
}));

import { repoConnectorsApi, dbConnectorsApi, suggestedConnectorsApi } from "@/lib/connectors-api";
import { projectsApi } from "@/lib/projects-api";
import { toast } from "sonner";
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
    // #268 — the ✕ glyph is no longer the button's name ("multiplication x"
    // to a screen reader); it is labelled for what it does.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Cancel branch edit" })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel branch edit" }));
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

  it("runs Deep Ingest as a job: Ingesting… after the 202, then the result from the bus (#373)", async () => {
    deepIngest.mockResolvedValueOnce({ jobId: "job-373", connectorId: "r1", status: "started" });
    repoList.mockResolvedValue([makeRepo({ id: "r1" })]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Deep Ingest/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Deep Ingest/i }));
    await waitFor(() => expect(deepIngest).toHaveBeenCalledWith("proj-1", "r1"));
    await waitFor(() =>
      expect(fakeSocket.emit).toHaveBeenCalledWith("subscribe:job", { jobId: "job-373" }),
    );
    // The request answered, but the ingest is still running.
    expect(screen.getByRole("button", { name: /Ingesting/i })).toBeDisabled();
    expect(screen.queryByText(/Deep ingest complete/i)).not.toBeInTheDocument();

    act(() =>
      fireSocket("job:lifecycle", {
        kind: "repo-ingest",
        jobId: "job-373",
        projectId: "proj-1",
        status: "completed",
        progress: 100,
        message: "Deep ingest complete: 8 of 10 files parsed, 150 symbols, 45 RAG chunks.",
        ts: 1,
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByText("Deep ingest complete: 8 of 10 files parsed, 150 symbols, 45 RAG chunks."),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /Deep Ingest/i })).toBeEnabled();
  });

  it("shows a failed Deep Ingest job's generic error (#373)", async () => {
    deepIngest.mockResolvedValueOnce({ jobId: "job-373f", connectorId: "r1", status: "started" });
    repoList.mockResolvedValue([makeRepo({ id: "r1" })]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Deep Ingest/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Deep Ingest/i }));
    await waitFor(() =>
      expect(fakeSocket.emit).toHaveBeenCalledWith("subscribe:job", { jobId: "job-373f" }),
    );
    act(() =>
      fireSocket("job:lifecycle", {
        kind: "repo-ingest",
        jobId: "job-373f",
        projectId: "proj-1",
        status: "failed",
        error: "Repository ingestion failed.",
        ts: 1,
      }),
    );
    const alert = (await screen.findAllByRole("alert")).find((el) =>
      el.textContent?.includes("Deep ingest failed"),
    );
    expect(alert).toBeDefined();
    expect(alert).toHaveTextContent("Repository ingestion failed.");
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

  it("#715 — shows the code graph's size apart from the incremental delta", async () => {
    refreshIngest.mockResolvedValueOnce({
      pulled: true,
      filesChanged: 0,
      codeGraph: {
        filesScanned: 655,
        filesParsed: 0,
        filesSkipped: 655,
        symbolsUpserted: 0,
        edgesUpserted: 0,
        filesUnchanged: 421,
        graphFiles: 421,
        graphSymbols: 4252,
        graphEdges: 28636,
        durationMs: 1000,
      },
      sourceKnowledge: { documentsCreated: 0, documentsUpdated: 0, chunkCount: 2675 },
      cloneSizeBytes: 0,
    });
    repoList.mockResolvedValue([makeRepo({ id: "r1" })]);
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: /^Sync$/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^Sync$/ }));
    const totals = await screen.findByTestId("sync-graph-totals");
    expect(totals).toHaveTextContent(/421 files · 4,?252 symbols · 28,?636 edges/);
    expect(screen.getByText("Changed files re-parsed")).toBeInTheDocument();
    expect(screen.getByText("0 · 421 unchanged")).toBeInTheDocument();
    expect(screen.queryByText(/655 scanned/)).not.toBeInTheDocument();
  });

  it("warns instead of reporting success when the sync landed but scheduling failed (#449)", async () => {
    const warning =
      "The repository was ingested, but scheduling automatic document regeneration failed.";
    refreshIngest.mockResolvedValueOnce({
      pulled: true,
      filesChanged: 0,
      codeGraph: {
        filesScanned: 1,
        filesParsed: 1,
        filesSkipped: 0,
        symbolsUpserted: 1,
        edgesUpserted: 0,
        durationMs: 1,
      },
      sourceKnowledge: { documentsCreated: 0, documentsUpdated: 1, chunkCount: 1 },
      cloneSizeBytes: 0,
      regenerationScheduled: false,
      warning,
    });
    repoList.mockResolvedValue([makeRepo({ id: "r1" })]);
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: /^Sync$/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^Sync$/ }));
    expectAnnouncedOnce(await screen.findByText(warning), warning);
    expect(screen.getByText(/Sync finished with a warning/)).toBeInTheDocument();
    expect(screen.queryByText(/Sync complete\b/)).not.toBeInTheDocument();
  });

  /**
   * #498 — the toast is the one announcement: sonner's toaster is itself a live
   * region, so the inline copy must not be one too (role="alert" or "status"
   * would make a screen reader read the warning twice).
   */
  function expectAnnouncedOnce(inline: HTMLElement, warning: string) {
    expect(toast.warning).toHaveBeenCalledExactlyOnceWith(warning);
    expect(toast.success).not.toHaveBeenCalled();
    expect(inline.closest('[role="alert"],[role="status"],[aria-live]')).toBeNull();
  }

  it("does not say 'Sync complete' when the sync's ingest partly failed (#498)", async () => {
    const warning =
      "Sync completed with 2 failures: 2 source files could not be ingested. " +
      "Automatic document regeneration was skipped; run Sync again to retry.";
    refreshIngest.mockResolvedValueOnce({
      pulled: true,
      filesChanged: 2,
      codeGraph: {
        filesScanned: 4,
        filesParsed: 2,
        filesSkipped: 2,
        symbolsUpserted: 3,
        edgesUpserted: 1,
        durationMs: 10,
      },
      sourceKnowledge: { documentsCreated: 0, documentsUpdated: 1, chunkCount: 4 },
      cloneSizeBytes: 0,
      regenerationScheduled: false,
      failureCount: 2,
      warning,
    });
    repoList.mockResolvedValue([makeRepo({ id: "r1" })]);
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: /^Sync$/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^Sync$/ }));
    expectAnnouncedOnce(await screen.findByText(warning), warning);
    expect(screen.getByText(/Sync finished with a warning/)).toBeInTheDocument();
    expect(screen.queryByText(/Sync complete\b/)).not.toBeInTheDocument();
  });
});

describe("ConnectionsPage — DB allow list fields", () => {
  it("renders allowed tables and columns inputs", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText(/Allowed tables/i)).toBeInTheDocument());
    expect(screen.getByLabelText(/Allowed columns/i)).toBeInTheDocument();
  });
});

// Issue #364 — a local-directory connector has no Git host: no token to set,
// and it is never tested, so its stored `status` stays "pending" for good.
describe("ConnectionsPage — non-Git repository connectors (#364)", () => {
  it("shows no Token row and the ingest outcome instead of 'pending' for a local directory", async () => {
    repoList.mockResolvedValue([
      makeRepo({
        provider: "local",
        ownerOrOrg: null,
        repoName: null,
        hasLocalSource: true,
        secretRef: "",
        status: "pending",
        sourceIngest: { effectiveStatus: "completed" },
      }),
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Main Repo")).toBeInTheDocument());
    expect(screen.queryByText("Token:")).not.toBeInTheDocument();
    expect(screen.queryByText(/not set — click to add/i)).not.toBeInTheDocument();
    expect(screen.getByText("ingested")).toBeInTheDocument();
    expect(screen.queryByText("pending")).not.toBeInTheDocument();
  });

  it("colours a failed local ingest destructive, from the same state as its label", async () => {
    repoList.mockResolvedValue([
      makeRepo({
        provider: "local",
        ownerOrOrg: null,
        repoName: null,
        hasLocalSource: true,
        secretRef: "",
        status: "pending",
        sourceIngest: { effectiveStatus: "failed" },
      }),
    ]);
    renderPage();
    const badge = await screen.findByText("ingest failed");
    expect(badge.className).toContain("text-destructive");
  });

  it("keeps the Token row for a Git connector", async () => {
    repoList.mockResolvedValue([makeRepo({ secretRef: "" })]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Main Repo")).toBeInTheDocument());
    expect(screen.getByText("Token:")).toBeInTheDocument();
  });
});
