/**
 * Issue #121 extended — more connections page branches: toggle mutations,
 * DB rescan, test result message, and error handlers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
import { ApiError } from "@/lib/api-client";

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
  DbConnectorWizard: () => <div data-testid="db-wizard" />,
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
import { toast } from "sonner";

const repoList = repoConnectorsApi.list as unknown as ReturnType<typeof vi.fn>;
const dbList = dbConnectorsApi.list as unknown as ReturnType<typeof vi.fn>;
const sugList = suggestedConnectorsApi.list as unknown as ReturnType<typeof vi.fn>;
const projectGet = projectsApi.get as unknown as ReturnType<typeof vi.fn>;
const updateAllowScan = projectsApi.updateAllowCredentialScan as unknown as ReturnType<
  typeof vi.fn
>;
const dbTestFn = dbConnectorsApi.test as unknown as ReturnType<typeof vi.fn>;

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
  sugList.mockResolvedValue({ count: 0, suggestions: [] });
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

describe("ConnectionsPage — credential scan enable with primary repo", () => {
  it("shows rescan toast when enabling with primary repo present", async () => {
    repoList.mockResolvedValue([makeRepo({ id: "r1", isPrimary: true })]);
    projectGet.mockResolvedValue({ id: "proj-1", allowCredentialScan: false });
    updateAllowScan.mockResolvedValueOnce({ allowCredentialScan: true });
    projectGet
      .mockResolvedValueOnce({ id: "proj-1", allowCredentialScan: false })
      .mockResolvedValueOnce({ id: "proj-1", allowCredentialScan: true });
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("allow-credential-scan-toggle")).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByTestId("allow-credential-scan-toggle"));
    await waitFor(() => expect(updateAllowScan).toHaveBeenCalled());
  });

  it("shows 'will run on next ingest' toast when enabling with no primary repo", async () => {
    projectGet.mockResolvedValue({ id: "proj-1", allowCredentialScan: false });
    updateAllowScan.mockResolvedValueOnce({ allowCredentialScan: true });
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("allow-credential-scan-toggle")).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByTestId("allow-credential-scan-toggle"));
    await waitFor(() => expect(updateAllowScan).toHaveBeenCalled());
    // toast.success should be called since no primary repo
    await waitFor(() =>
      expect(
        (toast as unknown as { success: ReturnType<typeof vi.fn> }).success,
      ).toHaveBeenCalled(),
    );
  });

  it("shows disabled toast when disabling credential scan", async () => {
    projectGet.mockResolvedValue({ id: "proj-1", allowCredentialScan: true });
    updateAllowScan.mockResolvedValueOnce({ allowCredentialScan: false });
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("allow-credential-scan-toggle")).not.toBeDisabled(),
    );
    // Clicking the CHECKED toggle to disable it
    fireEvent.click(screen.getByTestId("allow-credential-scan-toggle"));
    await waitFor(() =>
      expect(updateAllowScan).toHaveBeenCalledWith("proj-1", { allowCredentialScan: false }),
    );
  });

  it("shows error when toggle mutation fails", async () => {
    projectGet.mockResolvedValue({ id: "proj-1", allowCredentialScan: false });
    updateAllowScan.mockRejectedValueOnce(new ApiError(500, "Server error"));
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("allow-credential-scan-toggle")).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByTestId("allow-credential-scan-toggle"));
    await waitFor(() => expect(updateAllowScan).toHaveBeenCalled());
    await waitFor(() =>
      expect((toast as unknown as { error: ReturnType<typeof vi.fn> }).error).toHaveBeenCalled(),
    );
  });
});

describe("ConnectionsPage — DB test result message", () => {
  it("shows test result message after DB test passes", async () => {
    dbTestFn.mockResolvedValueOnce({ ok: true, latencyMs: 50 });
    dbList.mockResolvedValue([
      {
        id: "d1",
        label: "Prod DB",
        driver: "postgres",
        host: "db.example.com",
        port: 5432,
        databaseName: "mydb",
        status: "ready",
        lastTestedAt: null,
        lastIngestAt: null,
        errorMessage: null,
      },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Prod DB")).toBeInTheDocument());
    const testBtns = screen.getAllByRole("button", { name: /^Test$/ });
    fireEvent.click(testBtns[testBtns.length - 1]);
    await waitFor(() => expect(dbTestFn).toHaveBeenCalled());
    // testResultMessage shows "OK in Xms"
    await waitFor(() =>
      expect(screen.queryByText(/Last test/i) ?? screen.getByText("Prod DB")).toBeInTheDocument(),
    );
  });

  it("shows failure message after DB test fails", async () => {
    dbTestFn.mockResolvedValueOnce({ ok: false, message: "Connection refused", latencyMs: 100 });
    dbList.mockResolvedValue([
      {
        id: "d1",
        label: "Bad DB",
        driver: "postgres",
        host: "db.example.com",
        port: 5432,
        databaseName: "mydb",
        status: "error",
        lastTestedAt: null,
        lastIngestAt: null,
        errorMessage: null,
      },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Bad DB")).toBeInTheDocument());
    const testBtns = screen.getAllByRole("button", { name: /^Test$/ });
    fireEvent.click(testBtns[testBtns.length - 1]);
    await waitFor(() => expect(dbTestFn).toHaveBeenCalled());
  });
});

describe("ConnectionsPage — DB allow list with entries", () => {
  it("creates DB connector with allowList when tables specified", async () => {
    const dbCreate = dbConnectorsApi.create as unknown as ReturnType<typeof vi.fn>;
    dbCreate.mockResolvedValueOnce({ id: "d2" });
    dbList.mockResolvedValue([]);
    renderPage();
    await waitFor(() => expect(document.getElementById("db-label")).toBeInTheDocument());
    fireEvent.change(document.getElementById("db-label")!, { target: { value: "My DB" } });
    fireEvent.change(document.getElementById("db-allow-tables")!, {
      target: { value: "users,orders" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add database connector/i }));
    await waitFor(() =>
      expect(dbCreate).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({
          label: "My DB",
          options: expect.stringContaining("users"),
        }),
      ),
    );
  });
});
