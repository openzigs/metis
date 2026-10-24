/**
 * #1475 — a GitHub repository connection's own webhook secret: created and
 * shown once with its receiver URL, replaced or removed after a confirm, and
 * flagged when it no longer works on this server.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/connectors-api", () => ({
  repoConnectorsApi: {
    generateWebhookSecret: vi.fn(),
    removeWebhookSecret: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { repoConnectorsApi } from "@/lib/connectors-api";
import { toast } from "sonner";
import { RepoWebhookSecret } from "@/components/connectors/repo-webhook-secret";
import { ApiError } from "@/lib/api-client";

const api = vi.mocked(repoConnectorsApi);
const SECRET = "s3cr3t-value-shown-once-AAAAAAAAAAAAAAAAAAAAA";
const PATH = "/api/webhooks/github/pr/c/r1";

function renderIt(
  connector: {
    provider: string;
    webhookSecretConfigured: boolean;
    webhookSecretNeedsRenewal?: boolean;
    status?: string;
  },
  onChanged = vi.fn(),
) {
  const Wrapper = makeWrapper({ withAuth: false });
  render(
    <Wrapper>
      <RepoWebhookSecret
        projectId="p1"
        connector={
          {
            id: "r1",
            status: "connected",
            webhookSecretNeedsRenewal: false,
            webhookPath: connector.provider.startsWith("github") ? PATH : null,
            ...connector,
          } as never
        }
        onChanged={onChanged}
      />
    </Wrapper>,
  );
  return onChanged;
}

beforeEach(() => {
  vi.clearAllMocks();
});

/** The open confirmation dialog (an accessible AlertDialog, #268). */
const dialog = () => screen.getByRole("alertdialog");

function setClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

describe("RepoWebhookSecret (#1475)", () => {
  it("creates a secret, shows it once with the receiver path, and copies it", async () => {
    api.generateWebhookSecret.mockResolvedValue({ id: "r1", secret: SECRET } as never);
    const onChanged = renderIt({ provider: "github", webhookSecretConfigured: false });
    expect(screen.getByText(/uses the server's shared secret/)).toBeInTheDocument();
    expect(screen.getByText(/only if\s+no other project connected it earlier/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use shared secret" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Create webhook secret" }));
    // A first secret needs no confirm: nothing working is replaced.
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(api.generateWebhookSecret).toHaveBeenCalledWith("p1", "r1");
    expect(await screen.findByLabelText("Webhook secret (shown only now)")).toHaveValue(SECRET);
    expect(screen.getByLabelText("Payload URL path")).toHaveValue(PATH);
    expect(onChanged).toHaveBeenCalled();

    const writeText = vi.fn(async () => undefined);
    setClipboard(writeText);
    await userEvent.click(
      screen.getByRole("button", { name: "Copy Webhook secret (shown only now)" }),
    );
    expect(writeText).toHaveBeenCalledWith(SECRET);
    expect(toast.success).toHaveBeenCalledWith("Copied");
  });

  it("does not say Copied when the clipboard write fails", async () => {
    api.generateWebhookSecret.mockResolvedValue({ id: "r1", secret: SECRET } as never);
    renderIt({ provider: "github", webhookSecretConfigured: false });
    await userEvent.click(screen.getByRole("button", { name: "Create webhook secret" }));
    await screen.findByLabelText("Webhook secret (shown only now)");
    setClipboard(async () => {
      throw new Error("denied");
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Copy Webhook secret (shown only now)" }),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("asks before replacing a working secret, and does nothing when cancelled", async () => {
    api.generateWebhookSecret.mockResolvedValue({ id: "r1", secret: SECRET } as never);
    renderIt({ provider: "github_enterprise", webhookSecretConfigured: true });
    expect(screen.getByText(/has its own secret/)).toBeInTheDocument();
    expect(screen.getByText(PATH)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Replace webhook secret" }));
    expect(within(dialog()).getByText(/stops working at once/)).toBeInTheDocument();
    await userEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(api.generateWebhookSecret).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Replace webhook secret" }));
    await userEvent.click(within(dialog()).getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(api.generateWebhookSecret).toHaveBeenCalledWith("p1", "r1"));
  });

  it("asks before going back to the shared secret, then removes it", async () => {
    api.removeWebhookSecret.mockResolvedValue({ id: "r1" } as never);
    const onChanged = renderIt({ provider: "github", webhookSecretConfigured: true });
    await userEvent.click(screen.getByRole("button", { name: "Use shared secret" }));
    await userEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(api.removeWebhookSecret).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Use shared secret" }));
    await userEvent.click(within(dialog()).getByRole("button", { name: "Use shared secret" }));
    await waitFor(() => expect(api.removeWebhookSecret).toHaveBeenCalledWith("p1", "r1"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("says a secret that no longer works needs a new one", () => {
    renderIt({
      provider: "github",
      webhookSecretConfigured: false,
      webhookSecretNeedsRenewal: true,
    });
    expect(screen.getByText(/needs a new secret/)).toBeInTheDocument();
    expect(screen.getByText(/deliveries to this connection are refused/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create webhook secret" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use shared secret" })).toBeInTheDocument();
  });

  it("shows the server's reason when a secret cannot be created", async () => {
    api.generateWebhookSecret.mockRejectedValue(
      new ApiError(503, "This server has no VAULT_MASTER_KEY", "WEBHOOK_SECRET_UNAVAILABLE"),
    );
    renderIt({ provider: "github", webhookSecretConfigured: false });
    await userEvent.click(screen.getByRole("button", { name: "Create webhook secret" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("This server has no VAULT_MASTER_KEY"),
    );
    expect(screen.queryByLabelText("Webhook secret (shown only now)")).toBeNull();
  });

  it("shows a generic message when removing fails without a server reason", async () => {
    api.removeWebhookSecret.mockRejectedValue(new Error("network"));
    renderIt({ provider: "github", webhookSecretConfigured: true });
    await userEvent.click(screen.getByRole("button", { name: "Use shared secret" }));
    await userEvent.click(within(dialog()).getByRole("button", { name: "Use shared secret" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Could not remove the webhook secret"),
    );
  });

  it("tells a shared-secret connection that is not connected to run Test", () => {
    renderIt({ provider: "github", webhookSecretConfigured: false, status: "pending" });
    expect(screen.getByTestId("webhook-needs-test-r1")).toHaveTextContent(/successful Test/);
  });

  it("says nothing about Test for a connected one, or one with its own secret", () => {
    renderIt({ provider: "github", webhookSecretConfigured: false });
    expect(screen.queryByTestId("webhook-needs-test-r1")).toBeNull();
  });

  it("renders nothing for a connection GitHub does not deliver to", () => {
    renderIt({ provider: "local", webhookSecretConfigured: false });
    expect(screen.queryByText(/GitHub webhook/)).toBeNull();
  });
});
