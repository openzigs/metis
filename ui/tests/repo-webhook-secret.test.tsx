/**
 * #1475 — a GitHub repository connection's own webhook secret: created and
 * shown once, replaced, or removed (back to the server's shared secret).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

function renderIt(
  connector: { provider: string; webhookSecretConfigured: boolean },
  onChanged = vi.fn(),
) {
  const Wrapper = makeWrapper({ withAuth: false });
  render(
    <Wrapper>
      <RepoWebhookSecret
        projectId="p1"
        connector={{ id: "r1", ...connector } as never}
        onChanged={onChanged}
      />
    </Wrapper>,
  );
  return onChanged;
}

beforeEach(() => vi.clearAllMocks());

describe("RepoWebhookSecret (#1475)", () => {
  it("says a connection without its own secret uses the shared one, and creates one shown once", async () => {
    api.generateWebhookSecret.mockResolvedValue({ id: "r1", secret: SECRET } as never);
    const onChanged = renderIt({ provider: "github", webhookSecretConfigured: false });
    expect(screen.getByText(/uses the server's shared secret/)).toBeInTheDocument();
    expect(screen.getByText(/automatic reviews stop if any other project/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use shared secret" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Create webhook secret" }));
    expect(api.generateWebhookSecret).toHaveBeenCalledWith("p1", "r1");
    expect(await screen.findByLabelText("Webhook secret (shown only now)")).toHaveValue(SECRET);
    expect(onChanged).toHaveBeenCalled();

    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(SECRET);
  });

  it("shows a generic message when removing fails without a server reason", async () => {
    api.removeWebhookSecret.mockRejectedValue(new Error("network"));
    renderIt({ provider: "github", webhookSecretConfigured: true });
    await userEvent.click(screen.getByRole("button", { name: "Use shared secret" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Could not remove the webhook secret"),
    );
  });

  it("offers to replace or remove an existing secret", async () => {
    api.removeWebhookSecret.mockResolvedValue({ id: "r1" } as never);
    const onChanged = renderIt({ provider: "github_enterprise", webhookSecretConfigured: true });
    expect(screen.getByText(/has its own secret/)).toBeInTheDocument();
    expect(screen.queryByText(/automatic reviews stop if any other project/)).toBeNull();
    expect(screen.getByRole("button", { name: "Replace webhook secret" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Use shared secret" }));
    await waitFor(() => expect(api.removeWebhookSecret).toHaveBeenCalledWith("p1", "r1"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
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

  it("renders nothing for a connection GitHub does not deliver to", () => {
    renderIt({ provider: "local", webhookSecretConfigured: false });
    expect(screen.queryByText(/GitHub webhook/)).toBeNull();
  });
});
