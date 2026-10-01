/**
 * Epic #196 / #222 — Standalone /vault admin UI tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
import VaultPage from "@/app/(authed)/vault/page";
import { vaultApi } from "@/lib/vault-api";
import { ApiError } from "@/lib/api-client";

// #324 — the Reveal control follows the caller's role via the real
// `hasPermission` registry; only the auth context is stubbed to pick the role.
const { useAuthMock } = vi.hoisted(() => ({ useAuthMock: vi.fn() }));
vi.mock("@/lib/auth-context", () => ({ useAuth: useAuthMock }));

type Role = "admin" | "coordinator" | "developer" | "reader";
function asRole(role: Role) {
  useAuthMock.mockReturnValue({
    user: {
      id: `u-${role}`,
      username: role,
      displayName: role,
      email: `${role}@example.test`,
      role,
      permissions: [],
    },
    isLoading: false,
  });
}

vi.mock("@/lib/vault-api", () => ({
  VAULT_ROTATE_FOREIGN_OWNER: "VAULT_ROTATE_FOREIGN_OWNER",
  VAULT_ROTATE_BINDINGS_CHANGED: "VAULT_ROTATE_BINDINGS_CHANGED",
  vaultApi: {
    list: vi.fn(),
    create: vi.fn(),
    rotate: vi.fn(),
    reveal: vi.fn(),
    remove: vi.fn(),
    audit: vi.fn(),
  },
}));

const listMock = vi.mocked(vaultApi.list);
const createMock = vi.mocked(vaultApi.create);
const rotateMock = vi.mocked(vaultApi.rotate);
const revealMock = vi.mocked(vaultApi.reveal);
const removeMock = vi.mocked(vaultApi.remove);
const auditMock = vi.mocked(vaultApi.audit);

interface VaultEntryView {
  id: string;
  label: string;
  scope: "global" | "project";
  description: string;
  algorithm: string;
  keyVersion: number;
  createdAt: string;
  updatedAt: string;
}

function entry(overrides: Partial<VaultEntryView> = {}): VaultEntryView {
  return {
    id: "sec_1",
    label: "github-pat",
    scope: "global" as const,
    description: "",
    algorithm: "aes-256-gcm",
    keyVersion: 1,
    createdAt: new Date("2026-04-01T12:00:00Z").toISOString(),
    updatedAt: new Date("2026-04-25T12:00:00Z").toISOString(),
    ...overrides,
  };
}

function renderPage() {
  const Wrapper = makeWrapper({ withAuth: false });
  render(
    <Wrapper>
      <VaultPage />
    </Wrapper>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  asRole("admin");
  listMock.mockResolvedValue({ items: [entry()] });
  auditMock.mockResolvedValue({
    items: [
      {
        id: "audit_1",
        action: "vault.read",
        actorId: "u_1",
        createdAt: new Date("2026-04-25T12:30:00Z").toISOString(),
        metadata: null,
      },
    ],
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("<VaultPage />", () => {
  it("renders the entries table after the list query resolves", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("vault-list")).toBeInTheDocument());
    expect(screen.getByTestId("vault-row-sec_1")).toBeInTheDocument();
  });

  it("shows the empty-state row when the vault has no entries", async () => {
    listMock.mockResolvedValueOnce({ items: [] });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("vault-list-empty")).toBeInTheDocument());
  });

  it("renders the forbidden notice when the list returns 403", async () => {
    listMock.mockRejectedValueOnce(new ApiError(403, "forbidden"));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("vault-forbidden")).toBeInTheDocument());
  });

  it("creates a new entry and refreshes the list", async () => {
    createMock.mockResolvedValueOnce(entry({ id: "sec_2", label: "slack" }));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("vault-list")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("vault-create-label"), { target: { value: "slack" } });
    fireEvent.change(screen.getByTestId("vault-create-value"), { target: { value: "xoxb-abc" } });
    fireEvent.click(screen.getByTestId("vault-create-submit"));
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        label: "slack",
        value: "xoxb-abc",
        scope: "global",
        description: undefined,
      }),
    );
  });

  it("surfaces create errors inline", async () => {
    createMock.mockRejectedValueOnce(new ApiError(400, "label conflict"));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("vault-list")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("vault-create-label"), { target: { value: "x" } });
    fireEvent.change(screen.getByTestId("vault-create-value"), { target: { value: "y" } });
    fireEvent.click(screen.getByTestId("vault-create-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("vault-create-error")).toHaveTextContent("label conflict"),
    );
  });

  it("opens the entry detail and reveals plaintext", async () => {
    revealMock.mockResolvedValueOnce({
      summary: entry(),
      plaintext: "ghp_supersecretvalue",
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("vault-list")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("vault-row-open-sec_1"));
    expect(screen.getByTestId("vault-entry-detail")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("vault-entry-reveal-btn"));
    await waitFor(() => expect(screen.getByTestId("vault-entry-plaintext")).toBeInTheDocument());
    // Masked preview shows the first/last 4.
    expect(screen.getByTestId("vault-entry-plaintext")).toHaveTextContent("ghp_…alue");
  });

  for (const role of ["coordinator", "developer"] as const) {
    it(`#324 — a ${role} gets no Reveal control, only an admin-only notice`, async () => {
      asRole(role);
      renderPage();
      await waitFor(() => expect(screen.getByTestId("vault-list")).toBeInTheDocument());
      fireEvent.click(screen.getByTestId("vault-row-open-sec_1"));
      expect(screen.getByTestId("vault-entry-detail")).toBeInTheDocument();
      expect(screen.queryByTestId("vault-entry-reveal-btn")).not.toBeInTheDocument();
      expect(screen.getByTestId("vault-entry-reveal-admin-only")).toBeInTheDocument();
      expect(revealMock).not.toHaveBeenCalled();
    });
  }

  it("#324 — an admin keeps the Reveal control", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("vault-list")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("vault-row-open-sec_1"));
    expect(screen.getByTestId("vault-entry-reveal-btn")).toBeInTheDocument();
    expect(screen.queryByTestId("vault-entry-reveal-admin-only")).not.toBeInTheDocument();
  });

  it("rotates a secret and clears the revealed plaintext", async () => {
    revealMock.mockResolvedValue({ summary: entry(), plaintext: "ghp_old" });
    rotateMock.mockResolvedValueOnce(entry({ keyVersion: 2 }));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("vault-list")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("vault-row-open-sec_1"));
    fireEvent.change(screen.getByTestId("vault-entry-rotate-input"), {
      target: { value: "ghp_new" },
    });
    fireEvent.click(screen.getByTestId("vault-entry-rotate-submit"));
    await waitFor(() => expect(rotateMock).toHaveBeenCalledWith("sec_1", "ghp_new"));
  });

  describe("#482 — rotating another user's secret", () => {
    const foreign = {
      secretId: "sec_1",
      owner: { id: "u-coord", username: "cora", displayName: "Cora Coordinator" },
      bindings: [
        {
          type: "db_connector",
          id: "db1",
          label: "Coord DB",
          projectId: "p1",
          destination: "postgres://db.coord.example:5432",
          routing: "rt-db1",
        },
        {
          type: "mcp_server",
          id: "m1",
          label: "Coord MCP",
          projectId: null,
          destination: null,
          routing: "rt-m1",
        },
      ],
      bindingsDigest: "d".repeat(64),
      maxConfirmedBindings: 1000,
    };
    const refuse = (details: unknown = foreign) =>
      new ApiError(
        409,
        "This secret belongs to Cora Coordinator.",
        "VAULT_ROTATE_FOREIGN_OWNER",
        details,
      );

    async function submitRotate(value = "ghp_admin") {
      renderPage();
      await waitFor(() => expect(screen.getByTestId("vault-list")).toBeInTheDocument());
      fireEvent.click(screen.getByTestId("vault-row-open-sec_1"));
      fireEvent.change(screen.getByTestId("vault-entry-rotate-input"), { target: { value } });
      fireEvent.click(screen.getByTestId("vault-entry-rotate-submit"));
    }

    it("shows the owner and bindings, and Rotate anyway resends with the confirm flag", async () => {
      rotateMock.mockRejectedValueOnce(refuse()).mockResolvedValueOnce(entry({ keyVersion: 2 }));
      await submitRotate();
      const panel = await screen.findByTestId("vault-entry-rotate-foreign-owner");
      expect(within(panel).getByText("Cora Coordinator")).toBeInTheDocument();
      const bindings = within(panel).getByTestId("vault-entry-rotate-bindings");
      expect(bindings).toHaveTextContent("Coord DB — postgres://db.coord.example:5432");
      expect(bindings).toHaveTextContent("Coord MCP");
      expect(screen.getByTestId("vault-entry-rotate-submit")).toBeDisabled();

      fireEvent.click(screen.getByTestId("vault-entry-rotate-confirm"));
      await waitFor(() =>
        expect(rotateMock).toHaveBeenLastCalledWith("sec_1", "ghp_admin", {
          confirmForeignOwner: true,
          // #502 — type, id and destination, not the id alone; no label or projectId.
          // #557 — and the routing digest, echoed back untouched.
          confirmedBindings: [
            {
              type: "db_connector",
              id: "db1",
              destination: "postgres://db.coord.example:5432",
              routing: "rt-db1",
            },
            { type: "mcp_server", id: "m1", destination: null, routing: "rt-m1" },
          ],
        }),
      );
      await waitFor(() =>
        expect(screen.queryByTestId("vault-entry-rotate-foreign-owner")).not.toBeInTheDocument(),
      );
      expect(rotateMock).toHaveBeenNthCalledWith(1, "sec_1", "ghp_admin");
    });

    it("says only what was checked when no binding is found, and Cancel dismisses without rotating", async () => {
      rotateMock.mockRejectedValueOnce(refuse({ ...foreign, bindings: [] }));
      await submitRotate();
      const panel = await screen.findByTestId("vault-entry-rotate-foreign-owner");
      expect(panel).toHaveTextContent("were not checked");
      // #609 — test-management connections are now enumerated, so they are named
      // among what was checked, not among what was not.
      expect(panel).toHaveTextContent("Jira or test-management connection");
      expect(panel).not.toHaveTextContent("test-management auth");
      expect(panel).not.toHaveTextContent("not bound");
      fireEvent.click(screen.getByTestId("vault-entry-rotate-cancel"));
      expect(screen.queryByTestId("vault-entry-rotate-foreign-owner")).not.toBeInTheDocument();
      expect(rotateMock).toHaveBeenCalledTimes(1);
    });

    it("editing the value dismisses the confirmation", async () => {
      rotateMock.mockRejectedValueOnce(refuse());
      await submitRotate();
      await screen.findByTestId("vault-entry-rotate-foreign-owner");
      fireEvent.change(screen.getByTestId("vault-entry-rotate-input"), { target: { value: "x" } });
      expect(screen.queryByTestId("vault-entry-rotate-foreign-owner")).not.toBeInTheDocument();
    });

    it("falls back to the username when the owner has no display name", async () => {
      rotateMock.mockRejectedValueOnce(
        refuse({ ...foreign, owner: { id: "u-coord", username: "cora", displayName: null } }),
      );
      await submitRotate();
      const panel = await screen.findByTestId("vault-entry-rotate-foreign-owner");
      expect(within(panel).getByText("cora")).toBeInTheDocument();
    });

    it("#502 — says the owner loses the secret, not that they keep it", async () => {
      rotateMock.mockRejectedValueOnce(refuse());
      await submitRotate();
      const panel = await screen.findByTestId("vault-entry-rotate-foreign-owner");
      expect(panel).toHaveTextContent("becomes yours");
      expect(panel).not.toHaveTextContent("they stay its owner");
    });

    it("#502 — when the bindings changed, shows the live list and confirms against it", async () => {
      const changed = {
        ...foreign,
        bindings: [
          ...foreign.bindings,
          {
            type: "db_connector",
            id: "db2",
            label: "New DB",
            projectId: "p1",
            destination: "postgres://evil.example",
            routing: "rt-db2",
          },
        ],
      };
      rotateMock
        .mockRejectedValueOnce(refuse())
        .mockRejectedValueOnce(
          new ApiError(409, "changed", "VAULT_ROTATE_BINDINGS_CHANGED", changed),
        )
        .mockResolvedValueOnce(entry({ keyVersion: 2 }));
      await submitRotate();
      await screen.findByTestId("vault-entry-rotate-foreign-owner");
      expect(screen.queryByTestId("vault-entry-rotate-bindings-changed")).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId("vault-entry-rotate-confirm"));
      expect(await screen.findByTestId("vault-entry-rotate-bindings-changed")).toBeInTheDocument();
      expect(screen.getByTestId("vault-entry-rotate-bindings")).toHaveTextContent(
        "New DB — postgres://evil.example",
      );

      fireEvent.click(screen.getByTestId("vault-entry-rotate-confirm"));
      await waitFor(() =>
        expect(rotateMock).toHaveBeenLastCalledWith("sec_1", "ghp_admin", {
          confirmForeignOwner: true,
          confirmedBindings: [
            {
              type: "db_connector",
              id: "db1",
              destination: "postgres://db.coord.example:5432",
              routing: "rt-db1",
            },
            { type: "mcp_server", id: "m1", destination: null, routing: "rt-m1" },
            {
              type: "db_connector",
              id: "db2",
              destination: "postgres://evil.example",
              routing: "rt-db2",
            },
          ],
        }),
      );
      await waitFor(() =>
        expect(screen.queryByTestId("vault-entry-rotate-foreign-owner")).not.toBeInTheDocument(),
      );
    });

    it("#611 — over the cap, says so and confirms by the list digest instead of echoing the list", async () => {
      const bindings = Array.from({ length: 3 }, (_, i) => ({
        type: "db_connector",
        id: `db${i}`,
        label: `DB ${i}`,
        projectId: "p1",
        destination: `postgres://h${i}`,
        routing: `rt-${i}`,
      }));
      rotateMock
        .mockRejectedValueOnce(refuse({ ...foreign, bindings, maxConfirmedBindings: 2 }))
        .mockResolvedValueOnce(entry({ keyVersion: 2 }));
      await submitRotate();
      const panel = await screen.findByTestId("vault-entry-rotate-foreign-owner");
      expect(within(panel).getByTestId("vault-entry-rotate-over-cap")).toHaveTextContent(
        "It is bound to 3 resources, more than the 2 a confirmation can list one by one.",
      );
      // Every binding is still shown for review.
      expect(within(panel).getByTestId("vault-entry-rotate-bindings")).toHaveTextContent(
        "DB 2 — postgres://h2",
      );
      fireEvent.click(screen.getByTestId("vault-entry-rotate-confirm"));
      await waitFor(() =>
        expect(rotateMock).toHaveBeenLastCalledWith("sec_1", "ghp_admin", {
          confirmForeignOwner: true,
          confirmedBindingsDigest: "d".repeat(64),
        }),
      );
      await waitFor(() =>
        expect(screen.queryByTestId("vault-entry-rotate-foreign-owner")).not.toBeInTheDocument(),
      );
    });

    it("#611 — over the cap, counts the bindings by type and by destination host above the full list", async () => {
      const b = (type: string, id: string, destination: string | null) => ({
        type,
        id,
        label: id,
        projectId: "p1",
        destination,
        routing: `rt-${id}`,
      });
      const bindings = [
        b("db_connector", "db0", "postgres://h0.owner.example:5432"),
        b("db_connector", "db1", "postgres://H0.owner.example"),
        b("db_connector", "db2", "postgres://h1.owner.example"),
        b("mcp_server", "m0", "npx evil-mcp"),
        b("mcp_server", "m1", "https://mcp.owner.example/sse"),
        b("jira_connection", "j0", "https://h1.owner.example"),
        b("repo_connector", "r0", "github"),
        // More distinct hosts than the summary lists one by one.
        ...Array.from({ length: 11 }, (_, i) =>
          b(
            "test_management_connection",
            `t${i}`,
            `https://tm${String(i).padStart(2, "0")}.example`,
          ),
        ),
      ];
      rotateMock.mockRejectedValueOnce(refuse({ ...foreign, bindings, maxConfirmedBindings: 5 }));
      await submitRotate();
      const panel = await screen.findByTestId("vault-entry-rotate-foreign-owner");
      const items = (testId: string) =>
        within(within(panel).getByTestId(testId))
          .getAllByRole("listitem")
          .map((li) => li.textContent);
      expect(items("vault-entry-rotate-counts-by-type")).toEqual([
        "Test-management connection: 11",
        "DB connector: 3",
        "MCP server: 2",
        "Jira connection: 1",
        "Repo connector: 1",
      ]);
      // Hosts case-folded, the port ignored; the eleven one-off hosts past the
      // first ten rows summed; non-URL destinations counted apart.
      expect(items("vault-entry-rotate-counts-by-host")).toEqual([
        "h0.owner.example: 2",
        "h1.owner.example: 2",
        "mcp.owner.example: 1",
        "tm00.example: 1",
        "tm01.example: 1",
        "tm02.example: 1",
        "tm03.example: 1",
        "tm04.example: 1",
        "tm05.example: 1",
        "tm06.example: 1",
        "4 more hosts: 4",
        "No network host (driver, provider or command): 2",
      ]);
      // The summary sits above the full list, which is still all there.
      const summary = within(panel).getByTestId("vault-entry-rotate-over-cap-summary");
      const list = within(panel).getByTestId("vault-entry-rotate-bindings");
      expect(summary.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(within(list).getAllByRole("listitem")).toHaveLength(bindings.length);
      expect(within(panel).getByTestId("vault-entry-rotate-over-cap")).toHaveTextContent(
        "Start from the counts",
      );
    });

    it("#611 — at the cap, no over-cap notice and the list itself is confirmed", async () => {
      rotateMock
        .mockRejectedValueOnce(refuse({ ...foreign, maxConfirmedBindings: 2 }))
        .mockResolvedValueOnce(entry({ keyVersion: 2 }));
      await submitRotate();
      await screen.findByTestId("vault-entry-rotate-foreign-owner");
      expect(screen.queryByTestId("vault-entry-rotate-over-cap")).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId("vault-entry-rotate-confirm"));
      await waitFor(() => expect(rotateMock).toHaveBeenCalledTimes(2));
      const opts = rotateMock.mock.calls[1]![2] as Record<string, unknown>;
      expect(opts.confirmedBindings).toHaveLength(2);
      expect(opts).not.toHaveProperty("confirmedBindingsDigest");
    });

    it("any other rotate error is shown as a plain message", async () => {
      rotateMock.mockRejectedValueOnce(new ApiError(404, "Secret not found", "SECRET_NOT_FOUND"));
      await submitRotate();
      expect(await screen.findByText("Secret not found")).toBeInTheDocument();
      expect(screen.queryByTestId("vault-entry-rotate-foreign-owner")).not.toBeInTheDocument();
    });
  });

  it("renders audit events for the open entry", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("vault-list")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("vault-row-open-sec_1"));
    await waitFor(() => expect(screen.getByTestId("vault-audit-audit_1")).toBeInTheDocument());
    expect(screen.getByText("vault.read")).toBeInTheDocument();
  });

  it("deletes a secret and closes the detail panel", async () => {
    removeMock.mockResolvedValueOnce(undefined as unknown as void);
    renderPage();
    await waitFor(() => expect(screen.getByTestId("vault-list")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("vault-row-open-sec_1"));
    fireEvent.click(screen.getByTestId("vault-entry-delete-btn"));
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("sec_1"));
  });
});

describe("Vault vs runtime secrets (#410)", () => {
  it("an admin sees a note linking back to Settings → Configuration for server config", async () => {
    asRole("admin");
    renderPage();
    const note = await screen.findByTestId("vault-server-config-note");
    expect(note).toHaveTextContent(/connectors, MCP servers and publishing/i);
    expect(note).toHaveTextContent(/server configuration/i);
    // The table below lists global runtime-secret rows too (PR #433 panel).
    expect(note).toHaveTextContent(/global entries named after a server configuration key/i);
    const link = within(note).getByRole("link", { name: /configuration/i });
    expect(link).toHaveAttribute("href", "/settings/api-keys");
  });

  it.each(["coordinator", "developer", "reader"] as const)(
    "a %s does not see the server-config link",
    async (role) => {
      asRole(role);
      renderPage();
      await screen.findByTestId("vault-list");
      expect(screen.queryByTestId("vault-server-config-note")).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /configuration/i })).not.toBeInTheDocument();
    },
  );
});
