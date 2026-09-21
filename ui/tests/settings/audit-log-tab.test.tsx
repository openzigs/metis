/**
 * Issue #253 — Audit log tab on Settings/API Keys.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "../test-utils";
import SettingsApiKeysPage from "@/app/(authed)/settings/api-keys/page";
import SettingsAuditPage from "@/app/(authed)/settings/audit/page";
import { configApi, settingsApi } from "@/lib/settings-api";
import { ApiError } from "@/lib/api-client";

vi.mock("@/lib/settings-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/settings-api")>("@/lib/settings-api");
  return {
    ...actual,
    settingsApi: { envVars: vi.fn() },
    configApi: {
      setSecret: vi.fn(),
      clearSecret: vi.fn(),
      audit: vi.fn(),
    },
  };
});

const envMock = vi.mocked(settingsApi.envVars);
const auditMock = vi.mocked(configApi.audit);

function renderPage() {
  const Wrapper = makeWrapper({ withAuth: false, withTheme: false });
  render(
    <Wrapper>
      <SettingsApiKeysPage />
    </Wrapper>,
  );
}

function renderAuditPage() {
  const Wrapper = makeWrapper({ withAuth: false, withTheme: false });
  render(
    <Wrapper>
      <SettingsAuditPage />
    </Wrapper>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  envMock.mockResolvedValue({ items: [] });
});

afterEach(() => {
  window.localStorage.clear();
});

describe("Audit log tab", () => {
  it("renders audit tab content by default on the direct audit route", async () => {
    auditMock.mockResolvedValue({ items: [], nextCursor: null });
    renderAuditPage();
    await waitFor(() => expect(screen.getByTestId("settings-tab-audit")).toBeInTheDocument());
    expect(screen.getByTestId("settings-tab-audit").getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(screen.getByTestId("config-audit-empty")).toBeInTheDocument());
  });

  it("renders the tab toggle and switches panels", async () => {
    auditMock.mockResolvedValue({ items: [], nextCursor: null });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("settings-tab-audit")).toBeInTheDocument());
    expect(screen.getByTestId("settings-tab-secrets").getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByTestId("settings-tab-audit"));
    expect(screen.getByTestId("settings-tab-audit").getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(screen.getByTestId("config-audit-empty")).toBeInTheDocument());
  });

  it("renders the audit table with redaction icons for sensitive rows", async () => {
    auditMock.mockResolvedValue({
      items: [
        {
          id: "aud_1",
          key: "OPENAI_API_KEY",
          oldValueRedacted: "[REDACTED]",
          newValueRedacted: "[REDACTED]",
          actorId: "user_admin",
          scope: "global",
          ts: new Date("2026-04-27T12:00:00Z").toISOString(),
        },
        {
          id: "aud_2",
          key: "AI_DEFAULT_MODEL",
          oldValueRedacted: "gpt-4o-mini",
          newValueRedacted: "gpt-4o",
          actorId: "user_admin",
          scope: "global",
          ts: new Date("2026-04-27T12:01:00Z").toISOString(),
        },
      ],
      nextCursor: null,
    });
    renderPage();
    fireEvent.click(screen.getByTestId("settings-tab-audit"));
    await waitFor(() => expect(screen.getByTestId("config-audit-table")).toBeInTheDocument());
    expect(screen.getByTestId("config-audit-row-aud_1").textContent).toContain("[REDACTED]");
    expect(screen.getByTestId("config-audit-row-aud_2").textContent).toContain("gpt-4o");
  });

  it("surfaces a 403 error", async () => {
    auditMock.mockRejectedValueOnce(new ApiError(403, "forbidden"));
    renderPage();
    fireEvent.click(screen.getByTestId("settings-tab-audit"));
    await waitFor(() => expect(screen.getByTestId("config-audit-error")).toBeInTheDocument());
  });
});
