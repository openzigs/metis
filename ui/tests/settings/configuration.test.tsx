/**
 * Issue #259 — Configuration page (renamed from API Keys) renders Secrets,
 * Tunables, Bootstrap, and Audit-log sections backed by the unified
 * `/api/admin/config` API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "../test-utils";
import SettingsApiKeysPage from "@/app/(authed)/settings/api-keys/page";
import { configApi, settingsApi } from "@/lib/settings-api";

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
const setMock = vi.mocked(configApi.set);
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
  envMock.mockResolvedValue({ items: [] });
  auditMock.mockResolvedValue({ items: [], nextCursor: null });
  listMock.mockResolvedValue({
    items: [
      {
        key: "OPENAI_API_KEY",
        tier: "secret",
        valueType: "string",
        description: "OpenAI key",
        sensitive: true,
        source: "vault",
        value: "[REDACTED]",
      },
      {
        key: "AI_DEFAULT_MODEL",
        tier: "tunable",
        valueType: "string",
        description: "Default model id",
        sensitive: false,
        source: "db",
        value: "claude-sonnet-4.5",
      },
      {
        key: "SCHEDULER_ENABLED",
        tier: "tunable",
        valueType: "bool",
        description: "Master enable for scheduler",
        sensitive: false,
        source: "env",
        value: "true",
      },
      {
        key: "DB_ALLOWED_HOSTS",
        tier: "tunable",
        valueType: "csv",
        description: "DB hostname allowlist",
        sensitive: false,
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
    ],
  });
});

afterEach(() => {
  window.localStorage.clear();
});

describe("Configuration page (#259)", () => {
  it("renames the page heading to Configuration", async () => {
    renderPage();
    expect(screen.getByRole("heading", { name: /configuration/i, level: 1 })).toBeInTheDocument();
  });

  it("renders the four configuration sections", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("settings-secrets")).toBeInTheDocument());
    expect(screen.getByTestId("settings-tunables")).toBeInTheDocument();
    expect(screen.getByTestId("settings-bootstrap")).toBeInTheDocument();
  });

  it("renders one TunableRow per tunable key with the source badge", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("config-tunable-AI_DEFAULT_MODEL")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("config-tunable-AI_DEFAULT_MODEL-source").textContent).toBe("db");
    expect(screen.getByTestId("config-tunable-SCHEDULER_ENABLED-source").textContent).toBe("env");
    expect(screen.getByTestId("config-tunable-DB_ALLOWED_HOSTS-source").textContent).toBe("unset");
  });

  it("Save on a string tunable POSTs the new value via configApi.set", async () => {
    setMock.mockResolvedValue({
      key: "AI_DEFAULT_MODEL",
      tier: "tunable",
      valueType: "string",
      description: "Default model id",
      sensitive: false,
      source: "db",
      value: "gpt-4o",
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("config-tunable-AI_DEFAULT_MODEL-input")).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByTestId("config-tunable-AI_DEFAULT_MODEL-input"), {
      target: { value: "gpt-4o" },
    });
    fireEvent.click(screen.getByTestId("config-tunable-AI_DEFAULT_MODEL-save"));
    await waitFor(() => expect(setMock).toHaveBeenCalledWith("AI_DEFAULT_MODEL", "gpt-4o"));
  });

  it("Save on a bool tunable sends a boolean payload", async () => {
    setMock.mockResolvedValue({
      key: "SCHEDULER_ENABLED",
      tier: "tunable",
      valueType: "bool",
      description: "Master enable for scheduler",
      sensitive: false,
      source: "db",
      value: "false",
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("config-tunable-SCHEDULER_ENABLED-input")).toBeInTheDocument(),
    );
    // Toggle the checkbox.
    fireEvent.click(screen.getByTestId("config-tunable-SCHEDULER_ENABLED-input"));
    fireEvent.click(screen.getByTestId("config-tunable-SCHEDULER_ENABLED-save"));
    await waitFor(() => expect(setMock).toHaveBeenCalledWith("SCHEDULER_ENABLED", false));
  });

  it("Clear is disabled when the source is not 'db'", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("config-tunable-SCHEDULER_ENABLED-clear")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("config-tunable-SCHEDULER_ENABLED-clear")).toBeDisabled();
    expect(screen.getByTestId("config-tunable-AI_DEFAULT_MODEL-clear")).not.toBeDisabled();
  });
});
