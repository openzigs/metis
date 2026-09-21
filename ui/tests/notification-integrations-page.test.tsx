/**
 * Issue #69 — tests for the Slack + PagerDuty notification-integrations page.
 *
 * Covers: workspace selection, Slack connect (OAuth)/disconnect/manual install,
 * PagerDuty register/list/delete, event-routing (alert-channel) view/add/remove,
 * admin-gating (member sees read-only, no controls), loading/error/empty states,
 * and the security invariant that the bot token + routing key are never rendered.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AuthUser } from "@/lib/auth-types";
import NotificationIntegrationsPage from "@/app/(authed)/settings/integrations/notifications/page";

// ── mocks ────────────────────────────────────────────────────────────────────

const { slackApi, pdApi, wsList, finops, useAuthMock } = vi.hoisted(() => ({
  slackApi: {
    getInstallation: vi.fn(),
    authorize: vi.fn(),
    install: vi.fn(),
    uninstall: vi.fn(),
  },
  pdApi: {
    listServiceConfigs: vi.fn(),
    registerServiceConfig: vi.fn(),
    deleteServiceConfig: vi.fn(),
  },
  wsList: vi.fn(),
  finops: {
    getChannels: vi.fn(),
    createChannel: vi.fn(),
    deleteChannel: vi.fn(),
  },
  useAuthMock: vi.fn(),
}));

vi.mock("@/lib/notification-integrations-api", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    slackIntegrationApi: slackApi,
    pagerDutyIntegrationApi: pdApi,
    listIntegrationWorkspaces: wsList,
  };
});

vi.mock("@/lib/finops-api", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, finopsApi: { ...(actual.finopsApi as object), ...finops } };
});

vi.mock("@/lib/auth-context", () => ({ useAuth: useAuthMock }));

// ── helpers ──────────────────────────────────────────────────────────────────

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
      <NotificationIntegrationsPage />
    </QueryClientProvider>,
  );
}

const ADMIN_WS = { id: "w1", name: "Acme", slug: "acme", role: "admin" };
const MEMBER_WS = { id: "w2", name: "Beta", slug: "beta", role: "member" };

beforeEach(() => {
  vi.clearAllMocks();
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
  useAuthMock.mockReturnValue({ user: systemUser("reader") });
  wsList.mockResolvedValue([ADMIN_WS]);
  slackApi.getInstallation.mockResolvedValue(null);
  slackApi.authorize.mockResolvedValue({ url: "https://slack.example/oauth" });
  slackApi.install.mockResolvedValue({ id: "i1", slackTeamId: "T1" });
  slackApi.uninstall.mockResolvedValue({ deleted: true });
  pdApi.listServiceConfigs.mockResolvedValue([]);
  pdApi.registerServiceConfig.mockResolvedValue({ id: "c1", serviceKey: "prod" });
  pdApi.deleteServiceConfig.mockResolvedValue({ deleted: true });
  finops.getChannels.mockResolvedValue({ channels: [] });
  finops.createChannel.mockResolvedValue({ channel: { id: "ch1" } });
  finops.deleteChannel.mockResolvedValue({ deleted: true });
});

describe("NotificationIntegrationsPage", () => {
  it("renders the three integration cards for an admin workspace", async () => {
    renderPage();
    expect(await screen.findByTestId("slack-card")).toBeInTheDocument();
    expect(screen.getByTestId("pagerduty-card")).toBeInTheDocument();
    expect(screen.getByTestId("event-routing-card")).toBeInTheDocument();
  });

  it("shows loading + empty workspace states", async () => {
    let resolve!: (v: unknown) => void;
    wsList.mockReturnValue(new Promise((r) => (resolve = r)));
    renderPage();
    expect(screen.getByTestId("ni-workspaces-loading")).toBeInTheDocument();
    resolve([]);
    expect(await screen.findByTestId("ni-workspaces-empty")).toBeInTheDocument();
  });

  // ── Slack ──────────────────────────────────────────────────────────────────

  it("shows Slack as not connected + a Connect button when no install", async () => {
    renderPage();
    const card = await screen.findByTestId("slack-card");
    expect(within(card).getByTestId("slack-status")).toHaveTextContent("Not connected");
    expect(within(card).getByTestId("slack-connect")).toBeInTheDocument();
  });

  it("kicks off the Slack OAuth flow on Connect", async () => {
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      value: { assign },
      writable: true,
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("slack-connect"));
    await waitFor(() => expect(slackApi.authorize).toHaveBeenCalledWith("w1"));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://slack.example/oauth"));
  });

  it("shows the linked team + Disconnect when Slack is connected, never the token", async () => {
    slackApi.getInstallation.mockResolvedValue({
      id: "i1",
      workspaceId: "w1",
      slackTeamId: "T123",
      slackTeamName: "Acme HQ",
      botUserId: "B1",
      status: "active",
      label: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    renderPage();
    const card = await screen.findByTestId("slack-card");
    expect(await within(card).findByText("Acme HQ")).toBeInTheDocument();
    expect(within(card).getByTestId("slack-status")).toHaveTextContent("Connected");
    expect(within(card).getByTestId("slack-disconnect")).toBeInTheDocument();
    // No token field/value in the DOM.
    expect(card.textContent).not.toMatch(/xoxb/i);
  });

  it("disconnects Slack", async () => {
    slackApi.getInstallation.mockResolvedValue({
      id: "i1",
      workspaceId: "w1",
      slackTeamId: "T123",
      slackTeamName: "Acme HQ",
      botUserId: null,
      status: "active",
      label: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("slack-disconnect"));
    await waitFor(() => expect(slackApi.uninstall).toHaveBeenCalledWith("w1"));
  });

  it("installs Slack via the manual bot-token path and masks the token input", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId("slack-card");
    await user.click(screen.getByText(/install with a bot token/i));
    const tokenInput = screen.getByTestId("slack-bot-token");
    expect(tokenInput).toHaveAttribute("type", "password");
    await user.type(screen.getByTestId("slack-team-id"), "T123");
    await user.type(tokenInput, "xoxb-topsecret");
    await user.click(screen.getByTestId("slack-install-submit"));
    await waitFor(() =>
      expect(slackApi.install).toHaveBeenCalledWith("w1", {
        slackTeamId: "T123",
        botToken: "xoxb-topsecret",
      }),
    );
  });

  it("surfaces a Slack load error", async () => {
    slackApi.getInstallation.mockRejectedValue(new Error("nope"));
    renderPage();
    expect(await screen.findByTestId("slack-error")).toBeInTheDocument();
  });

  it("surfaces a Slack action error when authorize fails", async () => {
    slackApi.authorize.mockRejectedValue(new Error("oauth-down"));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("slack-connect"));
    expect(await screen.findByTestId("slack-action-error")).toHaveTextContent("oauth-down");
  });

  // ── PagerDuty ────────────────────────────────────────────────────────────────

  it("shows the PagerDuty empty state", async () => {
    renderPage();
    expect(await screen.findByTestId("pagerduty-empty")).toBeInTheDocument();
    expect(screen.getByTestId("pagerduty-status")).toHaveTextContent("Not connected");
  });

  it("lists PagerDuty configs without leaking the routing key", async () => {
    pdApi.listServiceConfigs.mockResolvedValue([
      {
        id: "c1",
        workspaceId: "w1",
        serviceKey: "prod",
        label: "Prod on-call",
        status: "active",
        createdById: "u1",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ]);
    renderPage();
    const card = await screen.findByTestId("pagerduty-card");
    expect(await within(card).findByTestId("pagerduty-config-prod")).toBeInTheDocument();
    expect(within(card).getByTestId("pagerduty-status")).toHaveTextContent("Connected");
    expect(card.textContent).not.toMatch(/R0/); // no routing key rendered
  });

  it("registers a PagerDuty service (routing key input is masked)", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId("pagerduty-card");
    const rk = screen.getByTestId("pagerduty-routing-key");
    expect(rk).toHaveAttribute("type", "password");
    await user.type(screen.getByTestId("pagerduty-service-key"), "prod");
    await user.type(rk, "R0SECRETKEY");
    await user.type(screen.getByTestId("pagerduty-label"), "Prod");
    await user.click(screen.getByTestId("pagerduty-register-submit"));
    await waitFor(() =>
      expect(pdApi.registerServiceConfig).toHaveBeenCalledWith("w1", {
        serviceKey: "prod",
        routingKey: "R0SECRETKEY",
        label: "Prod",
      }),
    );
  });

  it("deletes a PagerDuty service", async () => {
    pdApi.listServiceConfigs.mockResolvedValue([
      {
        id: "c1",
        workspaceId: "w1",
        serviceKey: "prod",
        label: null,
        status: "active",
        createdById: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ]);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("pagerduty-delete-prod"));
    await waitFor(() => expect(pdApi.deleteServiceConfig).toHaveBeenCalledWith("w1", "prod"));
  });

  it("surfaces a PagerDuty load error", async () => {
    pdApi.listServiceConfigs.mockRejectedValue(new Error("boom"));
    renderPage();
    expect(await screen.findByTestId("pagerduty-error")).toBeInTheDocument();
  });

  // ── Event routing ────────────────────────────────────────────────────────────

  it("shows the routing empty state", async () => {
    renderPage();
    expect(await screen.findByTestId("routing-empty")).toBeInTheDocument();
  });

  it("lists channels with their type + target", async () => {
    finops.getChannels.mockResolvedValue({
      channels: [
        { id: "ch1", type: "slack", target: "C01234567", config: "{}", enabled: true },
        { id: "ch2", type: "pagerduty", target: "", config: "{}", enabled: false },
      ],
    });
    renderPage();
    const card = await screen.findByTestId("event-routing-card");
    const list = await within(card).findByTestId("routing-list");
    expect(within(list).getByText("C01234567")).toBeInTheDocument();
    expect(within(list).getByText("(disabled)")).toBeInTheDocument();
  });

  it("adds a slack routing channel", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId("event-routing-card");
    await user.type(screen.getByTestId("routing-target"), "C99999");
    await user.click(screen.getByTestId("routing-add-submit"));
    await waitFor(() =>
      expect(finops.createChannel).toHaveBeenCalledWith("w1", {
        type: "slack",
        target: "C99999",
      }),
    );
  });

  // SC 3.3.3 (#663): an email domain typo shows an ADVISORY "did you mean…"
  // hint but must NOT block submission — the entered (well-formed) address is
  // still added as typed. Suggesting a fix must never override the user.
  it("shows an advisory hint for a domain typo but still submits the entered email (#663)", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId("event-routing-card");
    await user.selectOptions(screen.getByTestId("routing-type"), "email");
    await user.type(screen.getByTestId("routing-target"), "user@gmial.com");
    // Advisory hint appears, not a blocking error.
    expect(await screen.findByTestId("routing-target-hint")).toHaveTextContent(
      /did you mean “user@gmail\.com”/i,
    );
    expect(screen.queryByTestId("routing-target-error")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("routing-add-submit"));
    await waitFor(() =>
      expect(finops.createChannel).toHaveBeenCalledWith("w1", {
        type: "email",
        target: "user@gmial.com",
      }),
    );
  });

  // SC 3.3.3 (#663): valid-but-uncommon consumer domains that merely resemble a
  // common provider (Levenshtein 1–2) must be ACCEPTED, never "corrected" away.
  it.each(["user@mail.com", "user@ymail.com", "user@email.com"])(
    "accepts the valid-but-uncommon domain %s without blocking (#663)",
    async (address) => {
      const user = userEvent.setup();
      renderPage();
      await screen.findByTestId("event-routing-card");
      await user.selectOptions(screen.getByTestId("routing-type"), "email");
      await user.type(screen.getByTestId("routing-target"), address);
      await user.click(screen.getByTestId("routing-add-submit"));
      await waitFor(() =>
        expect(finops.createChannel).toHaveBeenCalledWith("w1", { type: "email", target: address }),
      );
      expect(screen.queryByTestId("routing-target-error")).not.toBeInTheDocument();
    },
  );

  // SC 3.3.3 (#663): a genuinely malformed address IS blocked (only malformed).
  it("blocks a malformed email address and does not call the API (#663)", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId("event-routing-card");
    await user.selectOptions(screen.getByTestId("routing-type"), "email");
    await user.type(screen.getByTestId("routing-target"), "not-an-email");
    await user.click(screen.getByTestId("routing-add-submit"));
    expect(await screen.findByTestId("routing-target-error")).toBeInTheDocument();
    expect(finops.createChannel).not.toHaveBeenCalled();
  });

  it("adds an email channel once the address is valid (#663)", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId("event-routing-card");
    await user.selectOptions(screen.getByTestId("routing-type"), "email");
    await user.type(screen.getByTestId("routing-target"), "ops@example.com");
    await user.click(screen.getByTestId("routing-add-submit"));
    await waitFor(() =>
      expect(finops.createChannel).toHaveBeenCalledWith("w1", {
        type: "email",
        target: "ops@example.com",
      }),
    );
  });

  // SC 3.3.3 (#663): a scheme-less webhook target suggests the https-prefixed URL.
  it("suggests an https webhook URL for a scheme-less value (#663)", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId("event-routing-card");
    await user.selectOptions(screen.getByTestId("routing-type"), "webhook");
    await user.type(screen.getByTestId("routing-target"), "hooks.example.com/abc");
    await user.click(screen.getByTestId("routing-add-submit"));
    expect(await screen.findByTestId("routing-target-error")).toHaveTextContent(
      /did you mean “https:\/\/hooks\.example\.com\/abc”/i,
    );
    expect(finops.createChannel).not.toHaveBeenCalled();
  });

  it("adds a webhook channel once the URL is valid https (#663)", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId("event-routing-card");
    await user.selectOptions(screen.getByTestId("routing-type"), "webhook");
    await user.type(screen.getByTestId("routing-target"), "https://hooks.example.com/abc");
    await user.click(screen.getByTestId("routing-add-submit"));
    await waitFor(() =>
      expect(finops.createChannel).toHaveBeenCalledWith("w1", {
        type: "webhook",
        target: "https://hooks.example.com/abc",
      }),
    );
  });

  it("allows adding a pagerduty channel with no target", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId("event-routing-card");
    await user.selectOptions(screen.getByTestId("routing-type"), "pagerduty");
    // Add button is enabled for pagerduty even with an empty target.
    await user.click(screen.getByTestId("routing-add-submit"));
    await waitFor(() =>
      expect(finops.createChannel).toHaveBeenCalledWith("w1", {
        type: "pagerduty",
        target: "",
      }),
    );
  });

  it("removes a channel", async () => {
    finops.getChannels.mockResolvedValue({
      channels: [{ id: "ch1", type: "email", target: "a@b.io", config: "{}", enabled: true }],
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("routing-delete-ch1"));
    await waitFor(() => expect(finops.deleteChannel).toHaveBeenCalledWith("w1", "ch1"));
  });

  it("surfaces a routing load error", async () => {
    finops.getChannels.mockRejectedValue(new Error("bad"));
    renderPage();
    expect(await screen.findByTestId("routing-error")).toBeInTheDocument();
  });

  // ── Admin gating ─────────────────────────────────────────────────────────────

  it("hides all controls + shows a read-only notice for a member", async () => {
    wsList.mockResolvedValue([MEMBER_WS]);
    renderPage();
    expect(await screen.findByTestId("ni-readonly-notice")).toBeInTheDocument();
    expect(screen.queryByTestId("slack-connect")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pagerduty-register")).not.toBeInTheDocument();
    expect(screen.queryByTestId("routing-add")).not.toBeInTheDocument();
  });

  it("a system admin can manage even a member-role workspace", async () => {
    useAuthMock.mockReturnValue({ user: systemUser("admin") });
    wsList.mockResolvedValue([MEMBER_WS]);
    renderPage();
    expect(await screen.findByTestId("slack-connect")).toBeInTheDocument();
    expect(screen.queryByTestId("ni-readonly-notice")).not.toBeInTheDocument();
  });

  it("lets the user switch workspaces and refetches for the new one", async () => {
    wsList.mockResolvedValue([ADMIN_WS, MEMBER_WS]);
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId("slack-card");
    await waitFor(() => expect(slackApi.getInstallation).toHaveBeenCalledWith("w1"));
    await user.selectOptions(screen.getByTestId("ni-workspace-select"), "w2");
    await waitFor(() => expect(slackApi.getInstallation).toHaveBeenCalledWith("w2"));
  });
});
