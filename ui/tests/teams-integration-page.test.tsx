/**
 * Epic #547 — tests for the Microsoft Teams integration settings page.
 *
 * Covers: workspace selection + loading/empty states, install form submit
 * (correct payload, password never rendered), SingleTenant tenant-id
 * validation, connected view + disconnect, admin-gating (member sees read-only,
 * no form), and the manifest builder (build → endpoint shown).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AuthUser } from "@/lib/auth-types";
import TeamsIntegrationPage from "@/app/(authed)/settings/integrations/teams/page";

const { teamsApi, wsList, useAuthMock } = vi.hoisted(() => ({
  teamsApi: {
    getInstallation: vi.fn(),
    install: vi.fn(),
    uninstall: vi.fn(),
    getManifest: vi.fn(),
  },
  wsList: vi.fn(),
  useAuthMock: vi.fn(),
}));

vi.mock("@/lib/teams-integration-api", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, teamsIntegrationApi: teamsApi };
});

vi.mock("@/lib/notification-integrations-api", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, listIntegrationWorkspaces: wsList };
});

vi.mock("@/lib/auth-context", () => ({ useAuth: useAuthMock }));

function systemUser(role: AuthUser["role"] = "reader"): AuthUser {
  return {
    id: "u1",
    username: "u",
    displayName: "U",
    email: "u@x.io",
    role,
    permissions: [],
  } as AuthUser;
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TeamsIntegrationPage />
    </QueryClientProvider>,
  );
}

const ADMIN_WS = { id: "w1", name: "Acme", slug: "acme", role: "admin" };
const MEMBER_WS = { id: "w2", name: "Beta", slug: "beta", role: "member" };

const INSTALLED = {
  id: "i1",
  workspaceId: "w1",
  appId: "app-123",
  tenantId: null,
  appType: "MultiTenant",
  status: "active",
  label: "Prod",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
  useAuthMock.mockReturnValue({ user: systemUser("reader") });
  wsList.mockResolvedValue([ADMIN_WS]);
  teamsApi.getInstallation.mockResolvedValue(null);
  teamsApi.install.mockResolvedValue(INSTALLED);
  teamsApi.uninstall.mockResolvedValue({ uninstalled: true });
  teamsApi.getManifest.mockResolvedValue({
    manifest: { manifestVersion: "1.16" },
    messagingEndpoint: "https://metis.example.com/api/integrations/teams/messages?workspaceId=w1",
  });
});

describe("TeamsIntegrationPage", () => {
  it("shows the install form when Teams is not connected (admin)", async () => {
    renderPage();
    expect(await screen.findByTestId("teams-install-form")).toBeInTheDocument();
    expect(await screen.findByTestId("teams-status-disconnected")).toHaveTextContent(
      "Not connected",
    );
  });

  it("shows loading + empty workspace states", async () => {
    let resolve!: (v: unknown) => void;
    wsList.mockReturnValue(new Promise((r) => (resolve = r)));
    renderPage();
    expect(screen.getByTestId("teams-workspaces-loading")).toBeInTheDocument();
    resolve([]);
    expect(await screen.findByTestId("teams-workspaces-empty")).toBeInTheDocument();
  });

  it("submits install with the right payload and never renders the password", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByTestId("teams-app-id"), "app-xyz");
    await user.type(screen.getByTestId("teams-app-password"), "super-secret");
    await user.type(screen.getByTestId("teams-label"), "Prod bot");
    await user.click(screen.getByTestId("teams-install-submit"));

    await waitFor(() =>
      expect(teamsApi.install).toHaveBeenCalledWith("w1", {
        appId: "app-xyz",
        appPassword: "super-secret",
        appType: "MultiTenant",
        tenantId: null,
        label: "Prod bot",
      }),
    );
    // The secret is a password input and is cleared after submit — never in the DOM as text.
    expect(screen.queryByText("super-secret")).not.toBeInTheDocument();
  });

  it("blocks submit for a SingleTenant bot without a tenant id", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByTestId("teams-app-id"), "app-xyz");
    await user.type(screen.getByTestId("teams-app-password"), "secret");
    await user.selectOptions(screen.getByTestId("teams-app-type"), "SingleTenant");

    expect(screen.getByTestId("teams-tenant-required")).toBeInTheDocument();
    expect(screen.getByTestId("teams-install-submit")).toBeDisabled();
    await user.click(screen.getByTestId("teams-install-submit"));
    expect(teamsApi.install).not.toHaveBeenCalled();
  });

  it("shows the connected view + disconnects", async () => {
    teamsApi.getInstallation.mockResolvedValue(INSTALLED);
    const user = userEvent.setup();
    renderPage();
    const view = await screen.findByTestId("teams-installed-view");
    expect(within(view).getByText("app-123")).toBeInTheDocument();
    expect(screen.getByTestId("teams-status-connected")).toBeInTheDocument();

    await user.click(screen.getByTestId("teams-uninstall"));
    await waitFor(() => expect(teamsApi.uninstall).toHaveBeenCalledWith("w1"));
  });

  it("builds a manifest and surfaces the messaging endpoint", async () => {
    teamsApi.getInstallation.mockResolvedValue(INSTALLED);
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByTestId("teams-manifest-package"), "com.acme.metis");
    await user.type(screen.getByTestId("teams-manifest-host"), "https://metis.example.com");
    await user.click(screen.getByTestId("teams-manifest-build"));

    await waitFor(() =>
      expect(teamsApi.getManifest).toHaveBeenCalledWith("w1", {
        packageId: "com.acme.metis",
        publicHost: "https://metis.example.com",
        botName: "METIS",
      }),
    );
    const endpoint = await screen.findByTestId("teams-manifest-endpoint");
    expect(endpoint).toHaveValue(
      "https://metis.example.com/api/integrations/teams/messages?workspaceId=w1",
    );
  });

  it("shows a read-only notice and no install form for a member", async () => {
    wsList.mockResolvedValue([MEMBER_WS]);
    renderPage();
    expect(await screen.findByTestId("teams-readonly-notice")).toBeInTheDocument();
    expect(screen.queryByTestId("teams-install-form")).not.toBeInTheDocument();
    expect(screen.getByTestId("teams-not-connected-readonly")).toBeInTheDocument();
  });
});
