/**
 * Issue #252 — Settings/API Keys: inline secret edit & clear.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "../test-utils";
import SettingsApiKeysPage from "@/app/(authed)/settings/api-keys/page";
import { configApi, settingsApi } from "@/lib/settings-api";
import { ApiError } from "@/lib/api-client";

vi.mock("@/lib/settings-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/settings-api")>("@/lib/settings-api");
  return {
    ...actual,
    settingsApi: { envVars: vi.fn() },
    configApi: {
      list: vi.fn(),
      get: vi.fn(),
      set: vi.fn(),
      clear: vi.fn(),
      setSecret: vi.fn(),
      clearSecret: vi.fn(),
      audit: vi.fn(),
    },
  };
});

const envMock = vi.mocked(settingsApi.envVars);
const listMock = vi.mocked(configApi.list);
const setSecretMock = vi.mocked(configApi.setSecret);
const auditMock = vi.mocked(configApi.audit);

function renderPage() {
  const Wrapper = makeWrapper({ withAuth: false, withTheme: false });
  render(
    <Wrapper>
      <SettingsApiKeysPage />
    </Wrapper>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  envMock.mockResolvedValue({
    items: [
      { key: "OPENAI_API_KEY", value: "[REDACTED]", classification: "secret", set: true },
      { key: "ANTHROPIC_API_KEY", value: "[unset]", classification: "secret", set: false },
      { key: "DATABASE_URL", value: "postgres://x", classification: "public", set: true },
      { key: "JWT_SECRET", value: "[REDACTED]", classification: "secret", set: true },
    ],
  });
  listMock.mockResolvedValue({
    items: [
      {
        key: "OPENAI_API_KEY",
        tier: "secret",
        valueType: "string",
        description: "OpenAI key",
        sensitive: true,
        source: "env",
        value: "[REDACTED]",
      },
      {
        key: "ANTHROPIC_API_KEY",
        tier: "secret",
        valueType: "string",
        description: "Anthropic key",
        sensitive: true,
        source: "unset",
        value: null,
      },
      {
        key: "DATABASE_URL",
        tier: "bootstrap",
        valueType: "string",
        description: "DB URL",
        sensitive: true,
        source: "env",
        value: "postgres://x",
      },
      {
        key: "JWT_SECRET",
        tier: "bootstrap",
        valueType: "string",
        description: "JWT secret",
        sensitive: true,
        source: "env",
        value: "[REDACTED]",
      },
    ],
  });
  auditMock.mockResolvedValue({ items: [], nextCursor: null });
});

afterEach(() => {
  window.localStorage.clear();
});

describe("Runtime config — secret rows", () => {
  it("renders a row per Tier-2 secret with the source badge", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("config-secret-OPENAI_API_KEY-source").textContent).toBe(
        "from env",
      ),
    );
    expect(screen.getByTestId("config-secret-ANTHROPIC_API_KEY-source").textContent).toBe(
      "not set",
    );
  });

  it("renders bootstrap rows read-only with the tooltip", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("config-bootstrap-DATABASE_URL")).toBeInTheDocument(),
    );
    const valueCell = screen.getByTestId("config-bootstrap-DATABASE_URL-value");
    expect(valueCell.getAttribute("title")).toMatch(/Bootstrap config/i);
    expect(screen.queryByTestId("config-bootstrap-DATABASE_URL-edit")).not.toBeInTheDocument();
  });

  it("does NOT include the bootstrap JWT_SECRET in the editable secrets list", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("config-bootstrap-JWT_SECRET")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("config-secret-JWT_SECRET")).not.toBeInTheDocument();
  });

  it("posts a save and shows the Saved toast", async () => {
    setSecretMock.mockResolvedValue({
      key: "OPENAI_API_KEY",
      tier: "secret",
      valueType: "string",
      description: "OpenAI key",
      sensitive: true,
      source: "vault",
      value: "[REDACTED]",
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("config-secret-OPENAI_API_KEY-edit")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("config-secret-OPENAI_API_KEY-edit"));
    fireEvent.change(screen.getByTestId("config-secret-OPENAI_API_KEY-input"), {
      target: { value: "sk-new-value" },
    });
    fireEvent.click(screen.getByTestId("config-secret-OPENAI_API_KEY-save"));
    await waitFor(() =>
      expect(setSecretMock).toHaveBeenCalledWith("OPENAI_API_KEY", "sk-new-value"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("config-secret-OPENAI_API_KEY-toast")).toBeInTheDocument(),
    );
  });

  it("blocks save when value is empty and surfaces the error", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("config-secret-OPENAI_API_KEY-edit")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("config-secret-OPENAI_API_KEY-edit"));
    fireEvent.click(screen.getByTestId("config-secret-OPENAI_API_KEY-save"));
    expect(screen.getByTestId("config-secret-OPENAI_API_KEY-error")).toHaveTextContent(/required/i);
    expect(setSecretMock).not.toHaveBeenCalled();
  });

  it("surfaces server errors after a failed save", async () => {
    setSecretMock.mockRejectedValueOnce(new ApiError(400, "WRONG_TIER"));
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("config-secret-OPENAI_API_KEY-edit")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("config-secret-OPENAI_API_KEY-edit"));
    fireEvent.change(screen.getByTestId("config-secret-OPENAI_API_KEY-input"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByTestId("config-secret-OPENAI_API_KEY-save"));
    await waitFor(() =>
      expect(screen.getByTestId("config-secret-OPENAI_API_KEY-error")).toHaveTextContent(
        "WRONG_TIER",
      ),
    );
  });

  it("disables Clear when the source is not 'vault'", async () => {
    renderPage();
    // Wait for envVars data to populate so source badges reflect server data.
    await waitFor(() =>
      expect(screen.getByTestId("config-secret-OPENAI_API_KEY-source").textContent).toBe(
        "from env",
      ),
    );
    expect(screen.getByTestId("config-secret-OPENAI_API_KEY-clear")).toBeDisabled();
  });
});
