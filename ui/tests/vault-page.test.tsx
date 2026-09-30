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
        },
        { type: "mcp_server", id: "m1", label: "Coord MCP", projectId: null, destination: null },
      ],
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
          confirmedBindingIds: ["db1", "m1"],
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
          confirmedBindingIds: ["db1", "m1", "db2"],
        }),
      );
      await waitFor(() =>
        expect(screen.queryByTestId("vault-entry-rotate-foreign-owner")).not.toBeInTheDocument(),
      );
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
