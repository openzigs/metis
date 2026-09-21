/**
 * Epic #196 / #221 — Settings sub-page: API Keys tests.
 *
 * Carries forward most of the original Phase 12 settings test coverage
 * (provider prefs + env-vars table + admin 403 path), now mounted under
 * `/settings/api-keys`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
import SettingsApiKeysPage from "@/app/(authed)/settings/api-keys/page";
import { settingsApi } from "@/lib/settings-api";
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

import { configApi } from "@/lib/settings-api";
const envVarsMock = vi.mocked(settingsApi.envVars);
const configListMock = vi.mocked(configApi.list);
const configAuditMock = vi.mocked(configApi.audit);

function renderPage() {
  const Wrapper = makeWrapper({ withAuth: false, withTheme: true });
  render(
    <Wrapper>
      <SettingsApiKeysPage />
    </Wrapper>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  envVarsMock.mockResolvedValue({
    items: [
      { key: "NODE_ENV", value: "test", classification: "public", set: true },
      { key: "JWT_SECRET", value: "[REDACTED]", classification: "secret", set: true },
      { key: "OPTIONAL_THING", value: "[unset]", classification: "public", set: false },
    ],
  });
  configListMock.mockResolvedValue({ items: [] });
  configAuditMock.mockResolvedValue({ items: [], nextCursor: null });
});

afterEach(() => {
  window.localStorage.clear();
});

describe("<SettingsApiKeysPage />", () => {
  it("renders the three sections", async () => {
    renderPage();
    expect(screen.getByTestId("settings-api-keys-root")).toBeInTheDocument();
    expect(screen.getByTestId("settings-provider")).toBeInTheDocument();
    expect(screen.getByTestId("settings-security-eval")).toBeInTheDocument();
    expect(screen.getByTestId("settings-env")).toBeInTheDocument();
  });

  it("shows a loading state for the env vars table", () => {
    envVarsMock.mockImplementation(() => new Promise(() => {}));
    renderPage();
    expect(screen.getAllByText("Loading…").length).toBeGreaterThan(0);
  });

  it("disables Save until the form is dirty, then enables", () => {
    renderPage();
    const save = screen.getByTestId("settings-provider-save");
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByTestId("settings-provider-key"), {
      target: { value: "openai" },
    });
    expect(save).toBeEnabled();
  });

  it("persists provider prefs on Save and shows the Saved toast", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderPage();
      fireEvent.change(screen.getByTestId("settings-provider-key"), {
        target: { value: "openai" },
      });
      fireEvent.change(screen.getByTestId("settings-provider-model"), {
        target: { value: "gpt-4o" },
      });
      fireEvent.click(screen.getByTestId("settings-provider-save"));
      expect(screen.getByTestId("settings-provider-saved")).toBeInTheDocument();
      expect(window.localStorage.getItem("metis.settings.providerPrefs")).toContain("openai");
      act(() => {
        vi.advanceTimersByTime(2_500);
      });
      await waitFor(() =>
        expect(screen.queryByTestId("settings-provider-saved")).not.toBeInTheDocument(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("Reset clears prefs back to defaults", () => {
    renderPage();
    fireEvent.change(screen.getByTestId("settings-provider-key"), {
      target: { value: "openai" },
    });
    fireEvent.click(screen.getByTestId("settings-provider-save"));
    fireEvent.click(screen.getByTestId("settings-provider-reset"));
    const provider = screen.getByTestId("settings-provider-key") as HTMLInputElement;
    expect(provider.value).not.toBe("openai");
  });

  it("renders the env-vars table when the call succeeds", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("settings-env-table")).toBeInTheDocument());
    expect(screen.getByTestId("settings-env-NODE_ENV")).toBeInTheDocument();
    expect(screen.getByTestId("settings-env-JWT_SECRET")).toBeInTheDocument();
  });

  it("shows the forbidden message when the env-vars call returns 403", async () => {
    envVarsMock.mockRejectedValueOnce(new ApiError(403, "forbidden"));
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/permission to view runtime configuration/i)).toBeInTheDocument(),
    );
  });

  it("surfaces non-403 env-var errors inline", async () => {
    envVarsMock.mockRejectedValueOnce(new Error("kaboom"));
    renderPage();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("kaboom"));
  });
});
