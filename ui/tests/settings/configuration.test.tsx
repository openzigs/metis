/**
 * Issue #259 — Configuration page (renamed from API Keys) renders Secrets,
 * Tunables, Bootstrap, and Audit-log sections backed by the unified
 * `/api/admin/config` API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { makeWrapper } from "../test-utils";
import SettingsApiKeysPage from "@/app/(authed)/settings/api-keys/page";
import { ApiError } from "@/lib/api-client";
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

  it("#2295: an unset bool that defaults on reads on, with a 'default' source", async () => {
    listMock.mockResolvedValue({
      items: [
        {
          key: "CHAT_CODE_SEARCH_TOOLS",
          tier: "tunable",
          valueType: "bool",
          description: "Code-search tools in chat",
          sensitive: false,
          source: "unset",
          value: null,
          defaultValue: "true",
        },
        {
          key: "SCHEDULER_ENABLED",
          tier: "tunable",
          valueType: "bool",
          description: "Master enable for scheduler",
          sensitive: false,
          source: "unset",
          value: null,
          defaultValue: null,
        },
      ],
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("config-tunable-CHAT_CODE_SEARCH_TOOLS-input")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("config-tunable-CHAT_CODE_SEARCH_TOOLS-input")).toBeChecked();
    expect(screen.getByTestId("config-tunable-CHAT_CODE_SEARCH_TOOLS-source").textContent).toBe(
      "default",
    );
    // No registered default: still unset, still unchecked.
    expect(screen.getByTestId("config-tunable-SCHEDULER_ENABLED-input")).not.toBeChecked();
    expect(screen.getByTestId("config-tunable-SCHEDULER_ENABLED-source").textContent).toBe("unset");
  });

  describe("#2402: a flag whose default depends on the model", () => {
    const CODE_TOOLS = {
      key: "CHAT_CODE_SEARCH_TOOLS",
      tier: "tunable" as const,
      valueType: "bool" as const,
      description: "Code-search tools in chat",
      sensitive: false,
      source: "unset" as const,
      value: null,
      defaultValue: "true",
      defaultNote: "on (native tool models only)",
    };
    const id = (suffix: string) => `config-tunable-CHAT_CODE_SEARCH_TOOLS-${suffix}`;

    it("reads as neither on nor off, with the note saying where it is on", async () => {
      listMock.mockResolvedValue({ items: [CODE_TOOLS] });
      renderPage();
      await waitFor(() => expect(screen.getByTestId(id("input"))).toBeInTheDocument());
      expect(screen.getByTestId(id("input"))).toBePartiallyChecked();
      expect(screen.getByTestId(id("source")).textContent).toBe("default");
      expect(screen.getByTestId(id("default-note")).textContent).toContain(
        "on (native tool models only)",
      );
    });

    it("an explicit value shows as itself, without the note", async () => {
      listMock.mockResolvedValue({ items: [{ ...CODE_TOOLS, source: "db", value: "true" }] });
      renderPage();
      await waitFor(() => expect(screen.getByTestId(id("input"))).toBeInTheDocument());
      expect(screen.getByTestId(id("input"))).toBeChecked();
      expect(screen.getByTestId(id("input"))).not.toBePartiallyChecked();
      expect(screen.queryByTestId(id("default-note"))).not.toBeInTheDocument();
      expect(screen.getByTestId(id("save"))).not.toBeDisabled();
    });

    it("Save on the untouched row does nothing; once edited it saves", async () => {
      listMock.mockResolvedValue({ items: [CODE_TOOLS] });
      renderPage();
      await waitFor(() => expect(screen.getByTestId(id("save"))).toBeInTheDocument());
      expect(screen.getByTestId(id("save"))).toBeDisabled();
      fireEvent.click(screen.getByTestId(id("save")));
      expect(setMock).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId(id("input")));
      expect(screen.getByTestId(id("input"))).not.toBePartiallyChecked();
      expect(screen.getByTestId(id("save"))).not.toBeDisabled();
      fireEvent.click(screen.getByTestId(id("save")));
      await waitFor(() => expect(setMock).toHaveBeenCalledWith("CHAT_CODE_SEARCH_TOOLS", false));
    });
  });

  it("#2402: Save is disabled on an untouched unset row with no default", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("config-tunable-DB_ALLOWED_HOSTS-save")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("config-tunable-DB_ALLOWED_HOSTS-save")).toBeDisabled();
    // A set value is saveable as it stands.
    expect(screen.getByTestId("config-tunable-AI_DEFAULT_MODEL-save")).not.toBeDisabled();
  });

  it("Clear on a db override removes it via configApi.clear", async () => {
    const clearMock = vi.mocked(configApi.clear);
    clearMock.mockResolvedValue({
      key: "AI_DEFAULT_MODEL",
      tier: "tunable",
      valueType: "string",
      description: "Default model id",
      sensitive: false,
      source: "unset",
      value: null,
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("config-tunable-AI_DEFAULT_MODEL-clear")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("config-tunable-AI_DEFAULT_MODEL-clear"));
    await waitFor(() => expect(clearMock).toHaveBeenCalledWith("AI_DEFAULT_MODEL"));
  });

  it("a refused Clear shows the API's message on the row", async () => {
    vi.mocked(configApi.clear).mockRejectedValue(
      new ApiError(500, "The configuration store could not complete the request."),
    );
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("config-tunable-AI_DEFAULT_MODEL-clear")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("config-tunable-AI_DEFAULT_MODEL-clear"));
    await waitFor(() =>
      expect(screen.getByTestId("config-tunable-AI_DEFAULT_MODEL-error").textContent).toBe(
        "The configuration store could not complete the request.",
      ),
    );
  });

  it("a rejected Save shows the server's message on the row", async () => {
    setMock.mockRejectedValue(new Error("value out of range"));
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("config-tunable-DB_ALLOWED_HOSTS-input")).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByTestId("config-tunable-DB_ALLOWED_HOSTS-input"), {
      target: { value: "not a host" },
    });
    fireEvent.click(screen.getByTestId("config-tunable-DB_ALLOWED_HOSTS-save"));
    await waitFor(() =>
      expect(screen.getByTestId("config-tunable-DB_ALLOWED_HOSTS-error").textContent).toBe(
        "value out of range",
      ),
    );
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

describe("Runtime secrets vs the Vault (#410)", () => {
  it("explains that runtime secrets are server configuration and links to the Vault", async () => {
    renderPage();
    const note = await screen.findByTestId("settings-secrets-vs-vault");
    expect(note).toHaveTextContent(/server configuration values/i);
    expect(note).toHaveTextContent(
      /connector, MCP and publishing credentials belong in the Vault/i,
    );
    // Runtime secrets ARE vault rows (ConfigService writes them at global scope), so the
    // copy must say so rather than present two separate stores (PR #433 panel).
    expect(note).toHaveTextContent(/global-scope entry in the Vault/i);
    const link = within(note).getByRole("link", { name: /vault/i });
    expect(link).toHaveAttribute("href", "/vault");
  });
});
