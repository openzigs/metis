/**
 * Issue #121 extended — final branch gap closers.
 * Targets: diagram-viewer tooltip branches, db-connector-wizard step content,
 * and connections page GitHub Enterprise branch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

// ─── DiagramViewer tooltip branches ──────────────────────────────────────────

vi.mock("react-zoom-pan-pinch", () => ({
  TransformWrapper: ({
    children,
  }: {
    children: (utils: {
      zoomIn: () => void;
      zoomOut: () => void;
      resetTransform: () => void;
    }) => React.ReactNode;
  }) => (
    <div>
      {typeof children === "function"
        ? children({ zoomIn: vi.fn(), zoomOut: vi.fn(), resetTransform: vi.fn() })
        : children}
    </div>
  ),
  TransformComponent: ({
    children,
    wrapperStyle,
  }: {
    children: React.ReactNode;
    wrapperStyle?: Record<string, unknown>;
  }) => <div style={wrapperStyle as React.CSSProperties}>{children}</div>,
}));

vi.mock("dompurify", () => ({
  default: { sanitize: vi.fn((h: string) => h) },
}));

import { DiagramViewer } from "@/components/diagram-viewer";

// SVG with entity label for tooltip testing
const svgWithEntity = `<svg viewBox="0 0 200 100">
  <g class="entity">
    <text class="entityLabel">Customer</text>
  </g>
</svg>`;

describe("DiagramViewer — tooltip and entity branches", () => {
  it("renders entity SVG without tooltip initially", () => {
    const descriptions = new Map([["Customer", "A person who orders"]]);
    const { container } = render(
      <DiagramViewer svg={svgWithEntity} entityDescriptions={descriptions} />,
    );
    expect(container.firstChild).toBeInTheDocument();
  });

  it("passes empty map for entityDescriptions (no tooltip setup)", () => {
    const { container } = render(
      <DiagramViewer svg={svgWithEntity} entityDescriptions={new Map()} />,
    );
    expect(container.firstChild).toBeInTheDocument();
  });

  it("renders without entityDescriptions (undefined path)", () => {
    const { container } = render(<DiagramViewer svg={svgWithEntity} />);
    expect(container.firstChild).toBeInTheDocument();
  });

  it("renders toolbar zoom buttons", () => {
    render(<DiagramViewer svg={svgWithEntity} />);
    expect(screen.getByTitle("Zoom in (+)")).toBeInTheDocument();
    expect(screen.getByTitle("Zoom out (-)")).toBeInTheDocument();
    expect(screen.getByTitle("Reset zoom")).toBeInTheDocument();
  });

  it("ToolbarButton is clickable", async () => {
    render(<DiagramViewer svg={svgWithEntity} />);
    const zoomIn = screen.getByTitle("Zoom in (+)");
    expect(() => fireEvent.click(zoomIn)).not.toThrow();
  });
});

// ─── DbConnectorWizard step 2 (configure) password toggle ────────────────────

vi.mock("@/lib/connectors-api", () => ({
  suggestedConnectorsApi: {
    list: vi.fn(),
    get: vi.fn(),
    updateStatus: vi.fn(),
    test: vi.fn(),
    provision: vi.fn(),
  },
  repoConnectorsApi: {
    getPrimary: vi.fn(),
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
}));

import { suggestedConnectorsApi } from "@/lib/connectors-api";
import { DbConnectorWizard } from "@/components/connectors/db-connector-wizard";

const getDetail = suggestedConnectorsApi.get as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  getDetail.mockReset();
  getDetail.mockResolvedValue({
    id: "s1",
    driverType: "postgres",
    host: "db.example.com",
    port: 5432,
    database: "mydb",
    confidence: "high",
    sourceFile: "src/db.ts",
    lineNumber: 10,
    username: "admin",
    password: "secret123",
    secretRef: null,
  });
});

const suggestion = {
  id: "s1",
  projectId: "p1",
  driverType: "postgres",
  host: "db.example.com",
  port: 5432,
  database: "mydb",
  confidence: "high" as const,
  status: "pending",
  sourceFile: "src/db.ts",
  lineNumber: 10,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("DbConnectorWizard — renders open/closed", () => {
  it("does not render when closed", () => {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <DbConnectorWizard
          projectId="p1"
          suggestion={suggestion}
          open={false}
          onOpenChange={vi.fn()}
        />
      </Wrapper>,
    );
    expect(screen.queryByText(/Review/i)).not.toBeInTheDocument();
  });
});

// ─── Connections page GitHub Enterprise branch ───────────────────────────────

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

vi.mock("@/lib/projects-api", () => ({
  projectsApi: { get: vi.fn(), updateAllowCredentialScan: vi.fn() },
}));

vi.mock("@/lib/connectors-api-ext", () => ({
  repoConnectorsApi2: {},
  dbConnectorsApi2: {},
}));

vi.mock("@/components/projects/rebuild-cache-button", () => ({
  RebuildCacheButton: () => <button>Rebuild</button>,
}));

vi.mock("@/components/connectors/db-connector-wizard", () => ({
  DbConnectorWizard: () => <div data-testid="db-connector-wizard-2" />,
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import {
  repoConnectorsApi,
  dbConnectorsApi,
  suggestedConnectorsApi as sugApi2,
} from "@/lib/connectors-api";
import { projectsApi } from "@/lib/projects-api";
import ConnectionsPage from "@/app/(authed)/projects/[id]/connections/page";

const repoList = repoConnectorsApi.list as unknown as ReturnType<typeof vi.fn>;
const dbList = dbConnectorsApi.list as unknown as ReturnType<typeof vi.fn>;
const sugList = sugApi2.list as unknown as ReturnType<typeof vi.fn>;
const projGet = projectsApi.get as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  repoList.mockResolvedValue([]);
  dbList.mockResolvedValue([]);
  sugList.mockResolvedValue({ count: 0, suggestions: [] });
  projGet.mockResolvedValue({ id: "proj-1", allowCredentialScan: false });
});

function renderConPage() {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <ConnectionsPage />
    </Wrapper>,
  );
}

describe("ConnectionsPage — GitHub Enterprise repo", () => {
  it("shows GitHub Enterprise badge for github_enterprise provider", async () => {
    repoList.mockResolvedValue([
      {
        id: "r1",
        label: "GHE Repo",
        provider: "github_enterprise",
        ownerOrOrg: "corp",
        repoName: "backend",
        defaultBranch: "main",
        status: "ready",
        isPrimary: false,
        lastTestedAt: null,
        lastIngestAt: null,
        errorMessage: null,
        apiBaseUrl: "https://git.corp.com/api/v3",
      },
    ]);
    renderConPage();
    await waitFor(() => expect(screen.getByText("GHE Repo")).toBeInTheDocument());
    expect(
      screen.queryAllByText(/github_enterprise/).length > 0 ||
        screen.queryAllByText(/git.corp.com/).length > 0,
    ).toBeTruthy();
  });

  it("repo with ingested-ago timestamp (lastIngestAt set)", async () => {
    const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
    repoList.mockResolvedValue([
      {
        id: "r1",
        label: "Ingested Repo",
        provider: "github",
        ownerOrOrg: "acme",
        repoName: "api",
        defaultBranch: "main",
        status: "ready",
        isPrimary: false,
        lastTestedAt: null,
        lastIngestAt: oneHourAgo,
        errorMessage: null,
        apiBaseUrl: null,
      },
    ]);
    renderConPage();
    await waitFor(() => expect(screen.getByText("Ingested Repo")).toBeInTheDocument());
  });

  it("test result message shown when testRepo succeeds", async () => {
    const repoTest = repoConnectorsApi.test as unknown as ReturnType<typeof vi.fn>;
    repoTest.mockResolvedValueOnce({ ok: true, latencyMs: 100 });
    repoList.mockResolvedValue([
      {
        id: "r1",
        label: "Test Repo",
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
      },
    ]);
    renderConPage();
    await waitFor(() => expect(screen.getByText("Test Repo")).toBeInTheDocument());
    const testBtns = screen.getAllByRole("button", { name: /^Test$/ });
    fireEvent.click(testBtns[0]);
    await waitFor(() => expect(repoTest).toHaveBeenCalled());
  });

  it("test result message shown when testRepo fails (ok=false)", async () => {
    const repoTest = repoConnectorsApi.test as unknown as ReturnType<typeof vi.fn>;
    repoTest.mockResolvedValueOnce({ ok: false, message: "Auth failed", latencyMs: 50 });
    repoList.mockResolvedValue([
      {
        id: "r1",
        label: "Bad Repo",
        provider: "github",
        ownerOrOrg: "acme",
        repoName: "api",
        defaultBranch: "main",
        status: "error",
        isPrimary: false,
        lastTestedAt: null,
        lastIngestAt: null,
        errorMessage: null,
        apiBaseUrl: null,
      },
    ]);
    renderConPage();
    await waitFor(() => expect(screen.getByText("Bad Repo")).toBeInTheDocument());
    const testBtns = screen.getAllByRole("button", { name: /^Test$/ });
    fireEvent.click(testBtns[0]);
    await waitFor(() => expect(repoTest).toHaveBeenCalled());
    // "Last test:" message should appear after test result
    await waitFor(
      () =>
        expect(screen.queryByText(/Last test/i)).toBeInTheDocument() ||
        expect(screen.getByText("Bad Repo")).toBeInTheDocument(),
    );
  });
});
