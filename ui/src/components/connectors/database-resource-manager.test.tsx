/**
 * DatabaseResourceManager tests — Epic #820 Phase 2 (#828).
 *
 * Covers the pure grouping/reason helpers and the full component surface:
 *   - loading / error / empty / no-workspace states are explicit (never blank);
 *   - linked connections render grouped by shared database with consumer
 *     projects, and a resolved-but-empty resource is visually distinct from a
 *     grouping that has consumers;
 *   - unlinked connections show the PRECISE reason (host vs database vs
 *     no-workspace) and only offer link/re-resolve when actually linkable;
 *   - the link and unlink flows go through a confirmation dialog and call the
 *     1a (#821) endpoints, with server errors surfaced cleanly (toast) and the
 *     optimistic change rolled back on failure;
 *   - the link target picker only offers same-workspace resources, so the UI
 *     never lets an operator link across workspaces.
 *
 * Queries are accessible (roles / labels / visible text / stable test ids).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { dbConnectorsApi, toast } = vi.hoisted(() => ({
  dbConnectorsApi: {
    identities: vi.fn(),
    list: vi.fn(),
    link: vi.fn(),
    unlink: vi.fn(),
    reresolve: vi.fn(),
  },
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/connectors-api", () => ({ dbConnectorsApi }));
vi.mock("sonner", () => ({ toast }));

import type { DatabaseConnector } from "@metis/shared";
import { ApiError } from "@/lib/api-client";
import type { ProjectDatabaseIdentity } from "@/lib/connectors-api";
import {
  DatabaseResourceManager,
  connectionEndpoint,
  groupIdentities,
  unlinkedReason,
} from "./database-resource-manager";

// ── factories ────────────────────────────────────────────────────────────────

function connector(over: Partial<DatabaseConnector> = {}): DatabaseConnector {
  return {
    id: "conn-1",
    projectId: "proj-1",
    label: "Primary DB",
    driver: "postgres",
    host: "db.example.com",
    port: 5432,
    databaseName: "orders",
    username: null,
    secretRef: "",
    options: null,
    status: "ready",
    errorMessage: null,
    lastTestedAt: null,
    lastIngestAt: null,
    createdById: null,
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as unknown as DatabaseConnector;
}

function identity(over: Partial<ProjectDatabaseIdentity> = {}): ProjectDatabaseIdentity {
  return {
    connectionId: "conn-1",
    databaseResourceId: null,
    insufficientIdentity: false,
    sharingProjects: [],
    ...over,
  };
}

function renderManager(props?: Partial<React.ComponentProps<typeof DatabaseResourceManager>>) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <DatabaseResourceManager projectId="proj-1" workspaceId="ws-1" {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  dbConnectorsApi.identities.mockResolvedValue([]);
  dbConnectorsApi.list.mockResolvedValue([]);
  dbConnectorsApi.link.mockResolvedValue({
    connectionId: "conn-1",
    databaseResourceId: "res-1",
    changed: true,
  });
  dbConnectorsApi.unlink.mockResolvedValue({
    connectionId: "conn-1",
    databaseResourceId: null,
    changed: true,
  });
  dbConnectorsApi.reresolve.mockResolvedValue({
    connectionId: "conn-1",
    databaseResourceId: "res-1",
    changed: true,
  });
});

// ── pure helpers ─────────────────────────────────────────────────────────────

describe("connectionEndpoint", () => {
  it("formats driver, host:port and database", () => {
    expect(connectionEndpoint(connector())).toBe("postgres · db.example.com:5432 / orders");
  });

  it("uses em dashes for missing host/database and omits an absent port", () => {
    expect(connectionEndpoint(connector({ host: null, port: null, databaseName: null }))).toBe(
      "postgres · — / —",
    );
  });
});

describe("unlinkedReason", () => {
  it("reports a missing host as the precise reason", () => {
    expect(
      unlinkedReason(connector({ host: null }), identity({ insufficientIdentity: true }), "ws-1"),
    ).toMatch(/host is not set/i);
  });

  it("reports a missing database name when the host is present", () => {
    expect(
      unlinkedReason(
        connector({ host: "h", databaseName: null }),
        identity({ insufficientIdentity: true }),
        "ws-1",
      ),
    ).toMatch(/database name is not set/i);
  });

  it("falls back to a generic identity reason when the connector detail is absent", () => {
    expect(unlinkedReason(undefined, identity({ insufficientIdentity: true }), "ws-1")).toMatch(
      /host is not set/i,
    );
  });

  it("reports both-required when insufficient but host+database look present", () => {
    // Defensive branch: the server flagged it insufficient even though the local
    // detail has both fields (e.g. whitespace/normalization differences).
    expect(unlinkedReason(connector(), identity({ insufficientIdentity: true }), "ws-1")).toMatch(
      /host and database name are required/i,
    );
  });

  it("reports the no-workspace blocker for a sufficient-identity connection", () => {
    expect(unlinkedReason(connector(), identity(), null)).toMatch(/no workspace/i);
  });

  it("reports 'not linked yet' for a linkable connection in a workspace", () => {
    expect(unlinkedReason(connector(), identity(), "ws-1")).toMatch(/not linked/i);
  });
});

describe("groupIdentities", () => {
  it("groups linked connections by resource and unions consumer projects", () => {
    const byId = new Map<string, DatabaseConnector>([
      ["conn-1", connector({ id: "conn-1" })],
      ["conn-2", connector({ id: "conn-2", label: "Replica" })],
    ]);
    const { resources, unlinked } = groupIdentities(
      [
        identity({
          connectionId: "conn-1",
          databaseResourceId: "res-1",
          sharingProjects: [{ projectId: "p2", name: "Beta" }],
        }),
        identity({
          connectionId: "conn-2",
          databaseResourceId: "res-1",
          sharingProjects: [
            { projectId: "p2", name: "Beta" },
            { projectId: "p3", name: "Gamma" },
          ],
        }),
      ],
      byId,
    );
    expect(unlinked).toHaveLength(0);
    expect(resources).toHaveLength(1);
    expect(resources[0].connections).toHaveLength(2);
    // Beta is shared by both connections but must appear only once.
    expect(resources[0].consumerProjects).toEqual([
      { projectId: "p2", name: "Beta" },
      { projectId: "p3", name: "Gamma" },
    ]);
  });

  it("separates unlinked connections and tolerates a missing connector detail", () => {
    const { resources, unlinked } = groupIdentities(
      [identity({ connectionId: "conn-9", databaseResourceId: null })],
      new Map(),
    );
    expect(resources).toHaveLength(0);
    expect(unlinked).toHaveLength(1);
    expect(unlinked[0].connection).toBeUndefined();
  });
});

// ── component: states ────────────────────────────────────────────────────────

describe("DatabaseResourceManager — states", () => {
  it("shows a loading state while the identity query is in flight", () => {
    dbConnectorsApi.identities.mockReturnValue(new Promise(() => {}));
    dbConnectorsApi.list.mockReturnValue(new Promise(() => {}));
    renderManager();
    expect(screen.getByTestId("db-identity-loading")).toBeInTheDocument();
  });

  it("shows an explicit empty state when there are no connectors", async () => {
    renderManager();
    expect(await screen.findByTestId("db-identity-empty")).toBeInTheDocument();
  });

  it("surfaces a load error with a retry action", async () => {
    dbConnectorsApi.identities.mockRejectedValue(new ApiError(500, "boom"));
    renderManager();
    expect(await screen.findByTestId("db-identity-error")).toBeInTheDocument();
    expect(screen.getByTestId("error-state-retry")).toBeInTheDocument();
  });

  it("renders an explicit no-workspace notice and lists connections read-only", async () => {
    dbConnectorsApi.identities.mockResolvedValue([identity({ connectionId: "conn-1" })]);
    dbConnectorsApi.list.mockResolvedValue([connector()]);
    renderManager({ workspaceId: null });

    expect(await screen.findByTestId("db-identity-no-workspace")).toBeInTheDocument();
    const row = screen.getByTestId("db-unlinked-connection");
    expect(within(row).getByTestId("db-unlinked-reason")).toHaveTextContent(/no workspace/i);
    // No link/unlink/re-resolve actions when the project has no workspace.
    expect(screen.queryByRole("button", { name: /re-resolve/i })).not.toBeInTheDocument();
  });
});

// ── component: linked resources ──────────────────────────────────────────────

describe("DatabaseResourceManager — linked resources", () => {
  it("renders a shared database with grouped connections and consumer projects", async () => {
    dbConnectorsApi.identities.mockResolvedValue([
      identity({
        connectionId: "conn-1",
        databaseResourceId: "res-1",
        sharingProjects: [{ projectId: "p2", name: "Beta" }],
      }),
    ]);
    dbConnectorsApi.list.mockResolvedValue([connector({ id: "conn-1", label: "Primary DB" })]);
    renderManager();

    const group = await screen.findByTestId("db-resource-group");
    expect(group).toHaveAttribute("data-resource", "res-1");
    // The endpoint appears both as the canonical resource label and on the row.
    expect(
      within(group).getAllByText("postgres · db.example.com:5432 / orders").length,
    ).toBeGreaterThan(0);
    expect(within(group).getByTestId("db-resource-consumers")).toHaveTextContent("Beta");
    expect(within(group).getByTestId("db-resource-connection")).toHaveAttribute(
      "data-connection-id",
      "conn-1",
    );
  });

  it("distinguishes a resolved-but-unshared database from one with consumers", async () => {
    dbConnectorsApi.identities.mockResolvedValue([
      identity({ connectionId: "conn-1", databaseResourceId: "res-1", sharingProjects: [] }),
    ]);
    dbConnectorsApi.list.mockResolvedValue([connector({ id: "conn-1" })]);
    renderManager();

    expect(await screen.findByTestId("db-resource-no-consumers")).toBeInTheDocument();
    expect(screen.queryByTestId("db-resource-consumers")).not.toBeInTheDocument();
  });

  it("falls back to the resource id and project id when connector detail is missing", async () => {
    // The identity endpoint knows the link + sibling projects, but the connector
    // list has not loaded that connection's detail (or a nameless sibling).
    dbConnectorsApi.identities.mockResolvedValue([
      identity({
        connectionId: "conn-x",
        databaseResourceId: "res-9",
        sharingProjects: [{ projectId: "p2", name: "" }],
      }),
    ]);
    dbConnectorsApi.list.mockResolvedValue([]);
    renderManager();

    const group = await screen.findByTestId("db-resource-group");
    expect(group).toHaveAttribute("data-resource", "res-9");
    // No connector detail → the resource id stands in for the endpoint label.
    expect(within(group).getAllByText("res-9").length).toBeGreaterThan(0);
    // Nameless sibling → its project id is shown rather than a blank.
    expect(within(group).getByTestId("db-resource-consumers")).toHaveTextContent("p2");
  });
});

// ── component: unlinked connections ──────────────────────────────────────────

describe("DatabaseResourceManager — unlinked connections", () => {
  it("shows the precise reason and no actions for an unlinkable connection", async () => {
    dbConnectorsApi.identities.mockResolvedValue([
      identity({ connectionId: "conn-1", insufficientIdentity: true }),
    ]);
    dbConnectorsApi.list.mockResolvedValue([connector({ id: "conn-1", host: null })]);
    renderManager();

    const row = await screen.findByTestId("db-unlinked-connection");
    expect(within(row).getByTestId("db-unlinked-reason")).toHaveTextContent(/host is not set/i);
    expect(within(row).queryByRole("button", { name: /re-resolve/i })).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /^link/i })).not.toBeInTheDocument();
  });

  it("re-resolves a linkable connection and reports success", async () => {
    const user = userEvent.setup();
    dbConnectorsApi.identities.mockResolvedValue([identity({ connectionId: "conn-1" })]);
    dbConnectorsApi.list.mockResolvedValue([connector({ id: "conn-1" })]);
    renderManager();

    await user.click(await screen.findByRole("button", { name: /re-resolve Primary DB/i }));

    await waitFor(() => expect(dbConnectorsApi.reresolve).toHaveBeenCalledWith("proj-1", "conn-1"));
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/resolved to a shared/i));
  });

  it("reports when a re-resolve cannot resolve a shared database", async () => {
    const user = userEvent.setup();
    dbConnectorsApi.reresolve.mockResolvedValue({
      connectionId: "conn-1",
      databaseResourceId: null,
      changed: false,
    });
    dbConnectorsApi.identities.mockResolvedValue([identity({ connectionId: "conn-1" })]);
    dbConnectorsApi.list.mockResolvedValue([connector({ id: "conn-1" })]);
    renderManager();

    await user.click(await screen.findByRole("button", { name: /re-resolve Primary DB/i }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringMatching(/no shared database could be resolved/i),
      ),
    );
  });

  it("surfaces a re-resolve failure as a clean toast", async () => {
    const user = userEvent.setup();
    dbConnectorsApi.reresolve.mockRejectedValue(new ApiError(409, "conflict resolving resource"));
    dbConnectorsApi.identities.mockResolvedValue([identity({ connectionId: "conn-1" })]);
    dbConnectorsApi.list.mockResolvedValue([connector({ id: "conn-1" })]);
    renderManager();

    await user.click(await screen.findByRole("button", { name: /re-resolve Primary DB/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("conflict resolving resource"));
  });

  it("uses a generic message for a non-ApiError failure (no internals leaked)", async () => {
    const user = userEvent.setup();
    dbConnectorsApi.reresolve.mockRejectedValue(new Error("ECONNREFUSED at 10.0.0.5:5432"));
    dbConnectorsApi.identities.mockResolvedValue([identity({ connectionId: "conn-1" })]);
    dbConnectorsApi.list.mockResolvedValue([connector({ id: "conn-1" })]);
    renderManager();

    await user.click(await screen.findByRole("button", { name: /re-resolve Primary DB/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Failed to resolve connection."));
    // The raw network detail is never surfaced.
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
  });
});

// ── component: unlink flow ───────────────────────────────────────────────────

describe("DatabaseResourceManager — unlink flow", () => {
  function seedLinked() {
    dbConnectorsApi.identities.mockResolvedValue([
      identity({
        connectionId: "conn-1",
        databaseResourceId: "res-1",
        sharingProjects: [{ projectId: "p2", name: "Beta" }],
      }),
    ]);
    dbConnectorsApi.list.mockResolvedValue([connector({ id: "conn-1", label: "Primary DB" })]);
  }

  it("confirms before unlinking and calls the endpoint", async () => {
    const user = userEvent.setup();
    seedLinked();
    renderManager();

    await user.click(await screen.findByRole("button", { name: /unlink Primary DB/i }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/unlink .*primary db/i);
    // The consequence copy names the sharing-project blast radius.
    expect(dialog).toHaveTextContent(/1 other project/i);

    await user.click(within(dialog).getByRole("button", { name: /confirm unlink/i }));

    await waitFor(() => expect(dbConnectorsApi.unlink).toHaveBeenCalledWith("proj-1", "conn-1"));
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/unlinked/i));
  });

  it("cancels without calling the endpoint", async () => {
    const user = userEvent.setup();
    seedLinked();
    renderManager();

    await user.click(await screen.findByRole("button", { name: /unlink Primary DB/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /cancel/i }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /unlink/i })).not.toBeInTheDocument(),
    );
    expect(dbConnectorsApi.unlink).not.toHaveBeenCalled();
  });

  it("surfaces an unlink API error as a clean toast", async () => {
    const user = userEvent.setup();
    dbConnectorsApi.unlink.mockRejectedValue(new ApiError(500, "unlink failed on server"));
    seedLinked();
    renderManager();

    await user.click(await screen.findByRole("button", { name: /unlink Primary DB/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /confirm unlink/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("unlink failed on server"));
  });
});

// ── component: link flow (same-workspace only) ───────────────────────────────

describe("DatabaseResourceManager — link flow", () => {
  // A linked connection (which creates a target resource) PLUS an unlinked,
  // linkable connection the operator can attach to that same resource.
  function seedLinkable() {
    dbConnectorsApi.identities.mockResolvedValue([
      identity({ connectionId: "conn-1", databaseResourceId: "res-1" }),
      identity({ connectionId: "conn-2", databaseResourceId: null }),
    ]);
    dbConnectorsApi.list.mockResolvedValue([
      connector({ id: "conn-1", label: "Primary DB", host: "db.example.com" }),
      connector({ id: "conn-2", label: "Alt host", host: "db-alt.example.com" }),
    ]);
  }

  it("only offers same-workspace resources as link targets", async () => {
    const user = userEvent.setup();
    seedLinkable();
    renderManager();

    await user.click(await screen.findByRole("button", { name: /link Alt host/i }));
    const select = await screen.findByLabelText(/target shared database/i);
    const options = within(select).getAllByRole("option");
    // Exactly the one existing resource in this project/workspace — never a
    // cross-workspace resource.
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("postgres · db.example.com:5432 / orders");
  });

  it("confirms, then links the connection to the chosen resource", async () => {
    const user = userEvent.setup();
    seedLinkable();
    renderManager();

    await user.click(await screen.findByRole("button", { name: /link Alt host/i }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/link .*alt host.*shared database/i);
    expect(dialog).toHaveTextContent(/same/i);
    await user.click(within(dialog).getByRole("button", { name: /confirm link/i }));

    await waitFor(() =>
      expect(dbConnectorsApi.link).toHaveBeenCalledWith("proj-1", "conn-2", "res-1"),
    );
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/linked to shared database/i));
  });

  it("rolls back and surfaces the server error when a forced link is rejected", async () => {
    const user = userEvent.setup();
    dbConnectorsApi.link.mockRejectedValue(new ApiError(404, "database resource not found"));
    seedLinkable();
    renderManager();

    await user.click(await screen.findByRole("button", { name: /link Alt host/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /confirm link/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("database resource not found"));
    // Rolled back: conn-2 stays in the unlinked list, never under the resource.
    await waitFor(() =>
      expect(screen.getByTestId("db-unlinked-connection")).toHaveAttribute(
        "data-connection-id",
        "conn-2",
      ),
    );
  });
});
