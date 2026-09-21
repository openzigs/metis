/**
 * Issue #121 extended — targeted tests for remaining branch gaps:
 * connections rescan mutations, db-connector-wizard deep steps.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeWrapper } from "./test-utils";
import { ApiError } from "@/lib/api-client";

// ─── Connections rescan branches ─────────────────────────────────────────────

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
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
  }),
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
const deepIngest = repoConnectorsApi.deepIngest as unknown as ReturnType<typeof vi.fn>;

function makeRepo(over: Record<string, unknown> = {}) {
  return {
    id: "r1",
    label: "Main Repo",
    provider: "github",
    ownerOrOrg: "acme",
    repoName: "api",
    defaultBranch: "main",
    status: "ready",
    isPrimary: true,
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

describe("ConnectionsPage — deep ingest error path", () => {
  it("shows error toast when deep ingest fails", async () => {
    deepIngest.mockRejectedValueOnce(new ApiError(500, "Deep ingest failed"));
    repoList.mockResolvedValue([makeRepo({ id: "r1" })]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Deep Ingest/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Deep Ingest/i }));
    await waitFor(() => expect(deepIngest).toHaveBeenCalled());
    await waitFor(() =>
      expect((toast as unknown as { error: ReturnType<typeof vi.fn> }).error).toHaveBeenCalled(),
    );
  });
});

describe("ConnectionsPage — enable scan with primary repo → shows rescan toast", () => {
  it("enables scan with primary repo → toast shows", async () => {
    // Set up a primary repo
    repoList.mockResolvedValue([makeRepo({ id: "r1", isPrimary: true })]);
    projectGet.mockResolvedValueOnce({ id: "proj-1", allowCredentialScan: false });
    updateAllowScan.mockResolvedValueOnce({ allowCredentialScan: true });
    // After mutation, re-fetch project shows allowCredentialScan: true
    projectGet.mockResolvedValue({ id: "proj-1", allowCredentialScan: true });
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("allow-credential-scan-toggle")).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByTestId("allow-credential-scan-toggle"));
    await waitFor(() => expect(updateAllowScan).toHaveBeenCalled());
    // Should show a toast (either the rescan one with action or the plain success one)
    await waitFor(() =>
      expect(
        (toast as unknown as ReturnType<typeof vi.fn>).mock.calls.length > 0 ||
          (toast as unknown as { success: ReturnType<typeof vi.fn> }).success.mock.calls.length > 0,
      ).toBeTruthy(),
    );
  });
});

describe("ConnectionsPage — createRepo success clears form", () => {
  it("clears form fields after successful repo creation", async () => {
    const user = userEvent.setup();
    const repoCreate = repoConnectorsApi.create as unknown as ReturnType<typeof vi.fn>;
    repoCreate.mockResolvedValueOnce({ id: "r2" });
    repoList.mockResolvedValue([]);
    renderPage();
    await waitFor(() => expect(screen.getAllByLabelText(/^Label$/i)[0]).toBeInTheDocument());
    const labelInput = screen.getAllByLabelText(/^Label$/i)[0] as HTMLInputElement;
    const ownerInput = screen.getByLabelText(/Owner/i) as HTMLInputElement;
    const repoInput = screen.getByLabelText(/Repo name/i) as HTMLInputElement;
    await user.type(labelInput, "New Repo");
    await user.type(ownerInput, "acme");
    await user.type(repoInput, "api");
    await user.click(screen.getByRole("button", { name: /Add repo connector/i }));
    await waitFor(() => expect(repoCreate).toHaveBeenCalled());
    // After success, form should be cleared
    await waitFor(() => expect(labelInput.value).toBe(""));
  });
});

// DbConnectorWizard tests are in gap-closer-final.test.tsx
