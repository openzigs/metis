/**
 * Issue #121 extended — additional targeted tests for ConnectionsPage DB
 * operations, query runner, and credential-scan toggle to improve branch
 * and function coverage toward the 80 % gate.
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
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import { repoConnectorsApi, dbConnectorsApi, suggestedConnectorsApi } from "@/lib/connectors-api";
import { projectsApi } from "@/lib/projects-api";
import ConnectionsPage from "@/app/(authed)/projects/[id]/connections/page";

const repoList = repoConnectorsApi.list as unknown as ReturnType<typeof vi.fn>;
const dbList = dbConnectorsApi.list as unknown as ReturnType<typeof vi.fn>;
const suggestedList = suggestedConnectorsApi.list as unknown as ReturnType<typeof vi.fn>;
const projectGet = projectsApi.get as unknown as ReturnType<typeof vi.fn>;
const dbCreate = dbConnectorsApi.create as unknown as ReturnType<typeof vi.fn>;
const dbRemove = dbConnectorsApi.remove as unknown as ReturnType<typeof vi.fn>;
const dbTest = dbConnectorsApi.test as unknown as ReturnType<typeof vi.fn>;
const dbIngest = dbConnectorsApi.ingest as unknown as ReturnType<typeof vi.fn>;
const dbQuery = dbConnectorsApi.query as unknown as ReturnType<typeof vi.fn>;
const updateAllowScan = projectsApi.updateAllowCredentialScan as unknown as ReturnType<
  typeof vi.fn
>;
const suggestedUpdateStatus = suggestedConnectorsApi.updateStatus as unknown as ReturnType<
  typeof vi.fn
>;

function makeDb(over: Record<string, unknown> = {}) {
  return {
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

describe("ConnectionsPage — DB connector form", () => {
  it("Add database connector button is disabled when label is empty", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Add database connector/i })).toBeDisabled(),
    );
  });

  it("enables Add database connector button when label is filled", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText(/^Label$/i, { selector: "#db-label" })).toBeInTheDocument(),
    );
    await user.type(screen.getByLabelText(/^Label$/i, { selector: "#db-label" }), "My DB");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Add database connector/i })).not.toBeDisabled(),
    );
  });

  it("calls dbConnectorsApi.create on form submission", async () => {
    const user = userEvent.setup();
    dbCreate.mockResolvedValueOnce({ id: "d2" });
    renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText(/^Label$/i, { selector: "#db-label" })).toBeInTheDocument(),
    );
    await user.type(screen.getByLabelText(/^Label$/i, { selector: "#db-label" }), "New DB");
    await user.click(screen.getByRole("button", { name: /Add database connector/i }));
    await waitFor(() =>
      expect(dbCreate).toHaveBeenCalledWith("proj-1", expect.objectContaining({ label: "New DB" })),
    );
  });

  it("shows error when DB create fails", async () => {
    const user = userEvent.setup();
    dbCreate.mockRejectedValueOnce(new Error("Connection refused"));
    renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText(/^Label$/i, { selector: "#db-label" })).toBeInTheDocument(),
    );
    await user.type(screen.getByLabelText(/^Label$/i, { selector: "#db-label" }), "Failing DB");
    await user.click(screen.getByRole("button", { name: /Add database connector/i }));
    await waitFor(() => expect(screen.getByText(/^Failed$/)).toBeInTheDocument());
  });
});

describe("ConnectionsPage — DB connector actions", () => {
  it("calls dbConnectorsApi.remove when Delete is clicked for a DB", async () => {
    dbRemove.mockResolvedValueOnce({});
    dbList.mockResolvedValue([makeDb({ id: "d1" })]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Prod DB")).toBeInTheDocument());
    // Multiple Delete buttons may exist (one per item); get the last one (DB section)
    const deleteButtons = screen.getAllByRole("button", { name: /^Delete$/ });
    fireEvent.click(deleteButtons[deleteButtons.length - 1]);
    await waitFor(() => expect(dbRemove).toHaveBeenCalledWith("proj-1", "d1"));
  });

  it("calls dbConnectorsApi.test when Test is clicked", async () => {
    dbTest.mockResolvedValueOnce({ ok: true, latencyMs: 50 });
    dbList.mockResolvedValue([makeDb({ id: "d1" })]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Prod DB")).toBeInTheDocument());
    const testButtons = screen.getAllByRole("button", { name: /^Test$/ });
    fireEvent.click(testButtons[testButtons.length - 1]);
    await waitFor(() => expect(dbTest).toHaveBeenCalledWith("proj-1", "d1"));
  });

  it("calls dbConnectorsApi.ingest when Ingest is clicked", async () => {
    dbIngest.mockResolvedValueOnce({});
    dbList.mockResolvedValue([makeDb({ id: "d1" })]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Prod DB")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^Ingest$/ }));
    await waitFor(() => expect(dbIngest).toHaveBeenCalledWith("proj-1", "d1"));
  });

  it("shows DB error message when connector has an error", async () => {
    dbList.mockResolvedValueOnce([makeDb({ errorMessage: "SSL cert error" })]);
    renderPage();
    await waitFor(() => expect(screen.getByText("SSL cert error")).toBeInTheDocument());
  });

  it("shows DB status badge", async () => {
    dbList.mockResolvedValueOnce([makeDb({ status: "error" })]);
    renderPage();
    await waitFor(() => expect(screen.getByText("error")).toBeInTheDocument());
  });
});

describe("ConnectionsPage — SQL query runner", () => {
  it("opens query form when Query button is clicked", async () => {
    dbList.mockResolvedValue([makeDb({ id: "d1" })]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Prod DB")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^Query$/ }));
    await waitFor(() => expect(screen.getByLabelText(/Read-only SQL/i)).toBeInTheDocument());
  });

  it("closes query form when Close is clicked", async () => {
    dbList.mockResolvedValue([makeDb({ id: "d1" })]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Prod DB")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^Query$/ }));
    await waitFor(() => expect(screen.getByLabelText(/Read-only SQL/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^Close$/ }));
    await waitFor(() => expect(screen.queryByLabelText(/Read-only SQL/i)).not.toBeInTheDocument());
  });

  it("calls dbQuery and shows result", async () => {
    dbQuery.mockResolvedValueOnce([{ id: 1 }]);
    dbList.mockResolvedValue([makeDb({ id: "d1" })]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Prod DB")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^Query$/ }));
    await waitFor(() => expect(screen.getByLabelText(/Read-only SQL/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^Run$/ }));
    await waitFor(() =>
      // JSON.stringify renders with spaces: {\n  "id": 1\n}
      expect(screen.queryAllByText(/"id"/i).length).toBeGreaterThan(0),
    );
  });

  it("shows query error on failure", async () => {
    dbQuery.mockRejectedValueOnce(new Error("bad query"));
    dbList.mockResolvedValue([makeDb({ id: "d1" })]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Prod DB")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^Query$/ }));
    await waitFor(() => expect(screen.getByLabelText(/Read-only SQL/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^Run$/ }));
    await waitFor(() =>
      // non-ApiError falls back to 'Query failed'
      expect(screen.getByText(/Query failed/i)).toBeInTheDocument(),
    );
  });
});

describe("ConnectionsPage — credential scan toggle mutation", () => {
  it("calls updateAllowCredentialScan when toggle changes to true", async () => {
    updateAllowScan.mockResolvedValueOnce({ allowCredentialScan: true });
    projectGet.mockResolvedValueOnce({ id: "proj-1", allowCredentialScan: false });
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("allow-credential-scan-toggle")).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByTestId("allow-credential-scan-toggle"));
    await waitFor(() =>
      expect(updateAllowScan).toHaveBeenCalledWith("proj-1", { allowCredentialScan: true }),
    );
  });
});

describe("ConnectionsPage — dismiss suggestion", () => {
  it("calls suggestedConnectorsApi.updateStatus when Dismiss is clicked", async () => {
    suggestedUpdateStatus.mockResolvedValueOnce({});
    suggestedList.mockResolvedValueOnce({
      count: 1,
      suggestions: [
        {
          id: "s1",
          driverType: "postgres",
          host: "pg.local",
          port: null,
          database: "db",
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
    fireEvent.click(screen.getByRole("button", { name: /Dismiss/i }));
    await waitFor(() =>
      expect(suggestedUpdateStatus).toHaveBeenCalledWith("proj-1", "s1", "dismissed"),
    );
  });
});
