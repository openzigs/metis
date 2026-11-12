/**
 * #2368 — write actions are offered only to a role that holds the permission
 * the server checks for them.
 *
 * The server already refuses each one (403); the defect was that the UI
 * offered the form anyway, so a `developer` filled it in and was refused only
 * after submitting. Each gate reads `permissions` from `/api/auth/me` (the
 * signed-in `AuthUser`) with the same key the route checks:
 *   - New project (the /projects dialog and the Home wizard): `project.create`
 *   - Add repo / database connector forms, and a suggested connector's
 *     Configure (a pre-filled database connector form): `connector.write`
 *   - The project card's Delete menu item: `project.delete`
 * A role without the key sees nothing, or a one-line reason in its place.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PermissionKey } from "@metis/shared";
import { makeWrapper, userWith } from "./test-utils";

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
  projectsApi: {
    list: vi.fn(),
    remove: vi.fn(),
    get: vi.fn(),
    updateAllowCredentialScan: vi.fn(),
  },
}));

vi.mock("@/lib/connectors-api", () => ({
  repoConnectorsApi: { list: vi.fn() },
  dbConnectorsApi: { list: vi.fn(), identities: vi.fn() },
  suggestedConnectorsApi: { list: vi.fn(), updateStatus: vi.fn() },
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

import { projectsApi } from "@/lib/projects-api";
import { dbConnectorsApi, repoConnectorsApi, suggestedConnectorsApi } from "@/lib/connectors-api";
import ProjectsPage from "@/app/(authed)/projects/page";
import ConnectionsPage from "@/app/(authed)/projects/[id]/connections/page";
import { NewProjectDialog } from "@/components/projects/new-project-wizard";
import { DatabaseResourceManager } from "@/components/connectors/database-resource-manager";

/**
 * The signed-in user, holding exactly `permissions`. `userWith` keeps
 * TEST_USER's `admin` role, so each gate is shown to read the `/me`
 * permissions, not the role name.
 */
function as(...permissions: PermissionKey[]) {
  return makeWrapper({ initialUser: userWith(...permissions) });
}

const ONE_PROJECT = {
  items: [{ id: "p1", name: "Alpha", slug: "alpha", status: "active", description: null }],
  total: 1,
  limit: 50,
  offset: 0,
} as unknown as Awaited<ReturnType<typeof projectsApi.list>>;

const NO_PROJECTS = { items: [], total: 0, limit: 50, offset: 0 } as unknown as Awaited<
  ReturnType<typeof projectsApi.list>
>;

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  // #2197 — the pages validate the active workspace against GET /workspaces.
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        text: () => Promise.resolve(JSON.stringify({ success: true, data: [] })),
      }),
    ),
  );
  vi.mocked(projectsApi.list).mockResolvedValue(ONE_PROJECT);
  vi.mocked(projectsApi.get).mockResolvedValue({
    id: "proj-1",
    allowCredentialScan: false,
  } as never);
  vi.mocked(repoConnectorsApi.list).mockResolvedValue([]);
  vi.mocked(dbConnectorsApi.list).mockResolvedValue([]);
  vi.mocked(dbConnectorsApi.identities).mockResolvedValue([]);
  vi.mocked(suggestedConnectorsApi.list).mockResolvedValue({
    count: 1,
    suggestions: [
      {
        id: "s1",
        driverType: "postgres",
        confidence: "high",
        host: "db.local",
        port: 5432,
        database: "app",
        sourceFile: ".env",
        lineNumber: 3,
      },
    ],
  } as never);
});

afterEach(() => vi.unstubAllGlobals());

describe("/projects New project is gated on project.create (#2368)", () => {
  it("offers no New project button to a role without project.create, and says who can", async () => {
    render(<ProjectsPage />, { wrapper: as("project.read") });
    await screen.findByRole("heading", { level: 2, name: "Alpha" });
    expect(screen.queryByRole("button", { name: "New project" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("new-project-button")).not.toBeInTheDocument();
    expect(screen.getByTestId("new-project-forbidden")).toHaveTextContent(
      "Ask an admin or coordinator to create projects.",
    );
  });

  it("offers New project, and its wizard (#2349), to a role with project.create", async () => {
    const user = userEvent.setup();
    render(<ProjectsPage />, { wrapper: as("project.read", "project.create") });
    await user.click(screen.getByRole("button", { name: "New project" }));
    expect(await screen.findByTestId("wizard-name-input")).toBeInTheDocument();
    expect(screen.queryByTestId("new-project-forbidden")).not.toBeInTheDocument();
  });

  it("does not tell a role without project.create to create the first project", async () => {
    vi.mocked(projectsApi.list).mockResolvedValue(NO_PROJECTS);
    render(<ProjectsPage />, { wrapper: as("project.read") });
    expect(await screen.findByText(/No projects yet/)).toHaveTextContent(
      "No projects yet. Ask an admin or coordinator to create one.",
    );
  });

  it("invites a role with project.create to create the first project", async () => {
    vi.mocked(projectsApi.list).mockResolvedValue(NO_PROJECTS);
    render(<ProjectsPage />, { wrapper: as("project.read", "project.create") });
    expect(await screen.findByText(/No projects yet/)).toHaveTextContent(
      "No projects yet. Create one to get started.",
    );
  });
});

describe("/projects Delete is gated on project.delete (#2368)", () => {
  it("offers no project actions menu to a role without project.delete", async () => {
    render(<ProjectsPage />, { wrapper: as("project.read", "project.create", "project.update") });
    await screen.findByRole("heading", { level: 2, name: "Alpha" });
    expect(screen.queryByRole("button", { name: "Project actions" })).not.toBeInTheDocument();
  });

  it("offers Delete, and its confirmation, to a role with project.delete", async () => {
    const user = userEvent.setup();
    render(<ProjectsPage />, { wrapper: as("project.read", "project.delete") });
    await user.click(await screen.findByRole("button", { name: "Project actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("This cannot be undone.");
  });
});

describe("the Home New project wizard is gated on project.create (#2368)", () => {
  it("shows the reason, not the button, to a role without project.create", () => {
    render(<NewProjectDialog />, { wrapper: as("project.read") });
    expect(screen.queryByRole("button", { name: "New project" })).not.toBeInTheDocument();
    expect(screen.getByTestId("new-project-forbidden")).toHaveTextContent(
      "Ask an admin or coordinator to create projects.",
    );
  });

  it("offers the wizard button to a role with project.create", () => {
    render(<NewProjectDialog />, { wrapper: as("project.create") });
    expect(screen.getByRole("button", { name: "New project" })).toBeEnabled();
    expect(screen.queryByTestId("new-project-forbidden")).not.toBeInTheDocument();
  });
});

describe("Connections add forms are gated on connector.write (#2368)", () => {
  it("shows a developer neither add form, no vault picker and no Configure, but says who can", async () => {
    render(<ConnectionsPage />, { wrapper: as("connector.read", "connector.test") });
    expect(await screen.findByTestId("repo-connector-forbidden")).toHaveTextContent(
      "Ask an admin or coordinator to add repository connectors.",
    );
    expect(screen.getByTestId("db-connector-forbidden")).toHaveTextContent(
      "Ask an admin or coordinator to add database connectors.",
    );
    expect(screen.queryByRole("button", { name: /Add repo connector/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Add database connector/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Secret ref (vault)")).not.toBeInTheDocument();
    expect(screen.queryByTestId("repo-source-select")).not.toBeInTheDocument();
    // The suggestion still lists, so the analyst knows a database was found …
    expect(await screen.findByText(".env:3")).toBeInTheDocument();
    // … but its Configure opens a connector form the server would refuse.
    expect(screen.queryByRole("button", { name: "Configure" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
  });

  it("shows both add forms and the suggestion's actions to a role with connector.write", async () => {
    render(<ConnectionsPage />, { wrapper: as("connector.read", "connector.write") });
    expect(await screen.findByRole("button", { name: /Add repo connector/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add database connector/ })).toBeInTheDocument();
    expect(screen.queryByTestId("repo-connector-forbidden")).not.toBeInTheDocument();
    expect(screen.queryByTestId("db-connector-forbidden")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Configure" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeEnabled();
  });
});

/**
 * Every per-row write action on the Connections page is refused by the server
 * without `connector.write` (repo PATCH / set-primary / refresh-ingest /
 * deep-ingest / DELETE; db ingest / DELETE / link / unlink / reresolve), and
 * the credential-scan toggle without `project.update`. Test and Query stay.
 */
const REPOS = [
  {
    id: "r1",
    label: "main-repo",
    provider: "github_enterprise",
    ownerOrOrg: "acme",
    repoName: "app",
    defaultBranch: "main",
    secretRef: "${vault:gh}",
    apiBaseUrl: "https://git.acme.test/api/v3",
    isPrimary: true,
    status: "active",
  },
  {
    id: "r2",
    label: "second-repo",
    provider: "github",
    ownerOrOrg: "acme",
    repoName: "lib",
    defaultBranch: "dev",
    secretRef: null,
    apiBaseUrl: null,
    isPrimary: false,
    status: "active",
  },
];
const DBS = [
  {
    id: "d1",
    label: "warehouse",
    driver: "postgres",
    host: "db.local",
    port: 5432,
    databaseName: "app",
    status: "active",
    lastTestedAt: null,
    lastIngestAt: null,
    errorMessage: null,
  },
];

function withRows() {
  vi.mocked(repoConnectorsApi.list).mockResolvedValue(REPOS as never);
  vi.mocked(dbConnectorsApi.list).mockResolvedValue(DBS as never);
}

describe("Connections row actions are gated on the route's key (#2368)", () => {
  it("offers a role without connector.write or project.update only the read-only row actions", async () => {
    withRows();
    // Neighbouring keys: every connector key but write, and project.read.
    render(<ConnectionsPage />, {
      wrapper: as("connector.read", "connector.test", "connector.query", "project.read"),
    });
    expect(await screen.findByText("main-repo")).toBeInTheDocument();
    expect(await screen.findByText("warehouse")).toBeInTheDocument();
    // Read-only actions stay.
    expect(screen.getAllByRole("button", { name: "Test" })).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Query" })).toBeInTheDocument();
    // Writes are gone.
    for (const name of ["Delete", "Update", "Full re-read", "Ingest", "Set as primary"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByTitle("Click to change branch")).not.toBeInTheDocument();
    expect(screen.queryByTitle(/Click to choose the vault secret/)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/Click to change API base URL/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("allow-credential-scan-toggle")).not.toBeInTheDocument();
    // The values those editors held are still shown as text.
    expect(screen.getByText("dev")).toBeInTheDocument();
    expect(screen.getByText("https://git.acme.test/api/v3")).toBeInTheDocument();
  });

  it("offers every row write action to a role with connector.write", async () => {
    withRows();
    render(<ConnectionsPage />, { wrapper: as("connector.read", "connector.write") });
    expect(await screen.findByText("main-repo")).toBeInTheDocument();
    expect(await screen.findByText("warehouse")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: "Update" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Full re-read" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Ingest" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set as primary" })).toBeInTheDocument();
    expect(screen.getAllByTitle("Click to change branch")).toHaveLength(2);
    expect(screen.getAllByTitle(/Click to choose the vault secret/)).toHaveLength(2);
    expect(screen.getByTitle(/Click to change API base URL/)).toBeInTheDocument();
    // connector.write does not carry the project setting.
    expect(screen.queryByTestId("allow-credential-scan-toggle")).not.toBeInTheDocument();
  });

  it("offers the credential-scan toggle only with project.update", async () => {
    render(<ConnectionsPage />, { wrapper: as("connector.read", "project.update") });
    expect(await screen.findByTestId("allow-credential-scan-toggle")).toBeInTheDocument();
  });
});

describe("Shared-database manager follows connector.write (#2368)", () => {
  beforeEach(() => {
    // A project in a workspace, so the manager renders its empty state rather
    // than "no workspace".
    vi.mocked(projectsApi.get).mockResolvedValue({
      id: "proj-1",
      workspaceId: "ws-1",
      allowCredentialScan: false,
    } as never);
  });

  it("points a role without connector.write at an admin or coordinator when there are none", async () => {
    render(<ConnectionsPage />, { wrapper: as("connector.read", "connector.test") });
    expect(await screen.findByTestId("db-identity-empty")).toHaveTextContent(
      "Ask an admin or coordinator to add one.",
    );
    expect(screen.getByTestId("db-identity-empty")).not.toHaveTextContent("Add one above");
  });

  it("keeps 'Add one above' for a role with connector.write", async () => {
    render(<ConnectionsPage />, { wrapper: as("connector.read", "connector.write") });
    expect(await screen.findByTestId("db-identity-empty")).toHaveTextContent("Add one above");
  });

  function withIdentities() {
    vi.mocked(dbConnectorsApi.list).mockResolvedValue([
      { ...DBS[0], id: "c-linked", label: "linked-db" },
      { ...DBS[0], id: "c-free", label: "free-db" },
    ] as never);
    vi.mocked(dbConnectorsApi.identities).mockResolvedValue([
      {
        connectionId: "c-linked",
        databaseResourceId: "res-1",
        insufficientIdentity: false,
        sharingProjects: [],
      },
      {
        connectionId: "c-free",
        databaseResourceId: null,
        insufficientIdentity: false,
        sharingProjects: [],
      },
    ]);
  }

  it("hides Unlink, Re-resolve and Link without connector.write", async () => {
    withIdentities();
    render(<DatabaseResourceManager projectId="proj-1" workspaceId="ws-1" canWrite={false} />, {
      wrapper: as("connector.read"),
    });
    expect(await screen.findByTestId("db-unlinked-connection")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Unlink / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Re-resolve / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Link / })).not.toBeInTheDocument();
  });

  it("shows Unlink, Re-resolve and Link with connector.write", async () => {
    withIdentities();
    render(<DatabaseResourceManager projectId="proj-1" workspaceId="ws-1" canWrite />, {
      wrapper: as("connector.read", "connector.write"),
    });
    expect(await screen.findByRole("button", { name: /^Unlink / })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Re-resolve / })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Link / })).toBeInTheDocument();
  });
});
