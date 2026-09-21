/**
 * Issue #613 (epic #608) — Settings → Notifications page tests.
 *
 * The page is API-backed (GET/PUT /api/users/me/notification-preferences) with
 * a one-time localStorage import. Covers: load, edit + save (diff-only PUT),
 * migration (import + key removal, skip when server has overrides, corrupt
 * key), error states (no silent localStorage fallback), and discard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NOTIFICATION_CHANNELS, NOTIFICATION_EVENTS } from "@metis/shared";
import type { NotificationChannel, NotificationEvent } from "@metis/shared";
import { makeWrapper } from "./test-utils";
import SettingsNotificationsPage, {
  LEGACY_STORAGE_KEY,
  buildLegacyImportEntries,
} from "@/app/(authed)/settings/notifications/page";

const { prefsApi } = vi.hoisted(() => ({
  prefsApi: { get: vi.fn(), put: vi.fn() },
}));

vi.mock("@/lib/notification-preferences-api", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, notificationPreferencesApi: prefsApi };
});

// ── helpers ──────────────────────────────────────────────────────────────────

/** Server defaults (#611): email/inApp/teams on, webhook off — per channel. */
const CHANNEL_DEFAULTS: Record<NotificationChannel, boolean> = {
  email: true,
  inApp: true,
  webhook: false,
  teams: true,
};

interface ResolvedRow {
  channel: NotificationChannel;
  event: NotificationEvent;
  enabled: boolean;
  isDefault: boolean;
}

function defaultRows(
  overrides: Array<{
    channel: NotificationChannel;
    event: NotificationEvent;
    enabled: boolean;
  }> = [],
): ResolvedRow[] {
  const rows: ResolvedRow[] = [];
  for (const channel of NOTIFICATION_CHANNELS) {
    for (const event of NOTIFICATION_EVENTS) {
      const o = overrides.find((x) => x.channel === channel && x.event === event);
      rows.push({
        channel,
        event,
        enabled: o ? o.enabled : CHANNEL_DEFAULTS[channel],
        isDefault: !o,
      });
    }
  }
  return rows;
}

function cell(channel: NotificationChannel, event: NotificationEvent): HTMLInputElement {
  return screen.getByTestId(`settings-notifications-cell-${channel}-${event}`) as HTMLInputElement;
}

function renderPage() {
  const Wrapper = makeWrapper({ withAuth: false });
  return render(
    <Wrapper>
      <SettingsNotificationsPage />
    </Wrapper>,
  );
}

async function renderLoaded(rows: ResolvedRow[] = defaultRows()) {
  prefsApi.get.mockResolvedValue(rows);
  renderPage();
  await screen.findByTestId("settings-notifications-matrix");
}

beforeEach(() => {
  window.localStorage.clear();
  prefsApi.get.mockReset();
  prefsApi.put.mockReset();
});

afterEach(() => {
  window.localStorage.clear();
});

// ── load ─────────────────────────────────────────────────────────────────────

describe("<SettingsNotificationsPage /> load", () => {
  it("shows a loading state, then renders the full channel × event matrix from GET", async () => {
    let resolve!: (rows: ResolvedRow[]) => void;
    prefsApi.get.mockReturnValue(new Promise<ResolvedRow[]>((r) => (resolve = r)));
    renderPage();
    expect(screen.getByTestId("settings-notifications-loading")).toBeInTheDocument();

    resolve(defaultRows());
    await screen.findByTestId("settings-notifications-matrix");

    // One checkbox per (channel, event) cell, reflecting server values.
    expect(cell("email", "analysisCompleted").checked).toBe(true);
    expect(cell("webhook", "analysisCompleted").checked).toBe(false);
    expect(cell("teams", "slaDeadline").checked).toBe(true);
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(NOTIFICATION_CHANNELS.length * NOTIFICATION_EVENTS.length);
    expect(prefsApi.put).not.toHaveBeenCalled();
  });

  it("renders stored overrides from the server (not defaults)", async () => {
    await renderLoaded(defaultRows([{ channel: "email", event: "mention", enabled: false }]));
    expect(cell("email", "mention").checked).toBe(false);
    expect(cell("email", "systemAlerts").checked).toBe(true);
  });

  it("shows an error state when GET fails and does NOT fall back to localStorage", async () => {
    window.localStorage.setItem(
      LEGACY_STORAGE_KEY,
      JSON.stringify({ channels: { webhook: true }, events: {} }),
    );
    prefsApi.get.mockRejectedValue(new Error("network down"));
    renderPage();
    await screen.findByTestId("settings-notifications-error");
    expect(screen.queryByTestId("settings-notifications-matrix")).not.toBeInTheDocument();
    // No import attempted, key untouched — never treated as a data source.
    expect(prefsApi.put).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(LEGACY_STORAGE_KEY)).not.toBeNull();
  });
});

// ── edit + save ──────────────────────────────────────────────────────────────

describe("<SettingsNotificationsPage /> edit + save", () => {
  it("disables Save until dirty, then PUTs only the changed cells and toasts", async () => {
    await renderLoaded();
    const save = screen.getByTestId("settings-notifications-save") as HTMLButtonElement;
    expect(save).toBeDisabled();

    fireEvent.click(cell("webhook", "issuesPublished"));
    expect(save).toBeEnabled();

    prefsApi.put.mockResolvedValue(
      defaultRows([{ channel: "webhook", event: "issuesPublished", enabled: true }]),
    );
    fireEvent.click(save);

    await screen.findByTestId("settings-notifications-saved");
    expect(prefsApi.put).toHaveBeenCalledTimes(1);
    expect(prefsApi.put).toHaveBeenCalledWith([
      { channel: "webhook", event: "issuesPublished", enabled: true },
    ]);
    // Saved state re-synced — no longer dirty, no localStorage writes.
    expect(save).toBeDisabled();
    expect(window.localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });

  it("toggling a cell back to its saved value keeps Save disabled", async () => {
    await renderLoaded();
    fireEvent.click(cell("email", "mention"));
    fireEvent.click(cell("email", "mention"));
    expect(screen.getByTestId("settings-notifications-save")).toBeDisabled();
  });

  it("shows an error and keeps the draft when PUT fails (no localStorage fallback)", async () => {
    await renderLoaded();
    fireEvent.click(cell("email", "systemAlerts"));
    prefsApi.put.mockRejectedValue(new Error("save exploded"));
    fireEvent.click(screen.getByTestId("settings-notifications-save"));

    await screen.findByTestId("settings-notifications-error");
    expect(screen.queryByTestId("settings-notifications-saved")).not.toBeInTheDocument();
    // Draft preserved so the user can retry; nothing written to localStorage.
    expect(cell("email", "systemAlerts").checked).toBe(false);
    expect(screen.getByTestId("settings-notifications-save")).toBeEnabled();
    expect(window.localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });

  it("Discard changes reverts the draft to the last saved state", async () => {
    await renderLoaded();
    fireEvent.click(cell("inApp", "mention"));
    expect(cell("inApp", "mention").checked).toBe(false);

    fireEvent.click(screen.getByTestId("settings-notifications-discard"));
    expect(cell("inApp", "mention").checked).toBe(true);
    expect(screen.getByTestId("settings-notifications-save")).toBeDisabled();
    expect(prefsApi.put).not.toHaveBeenCalled();
  });
});

// ── one-time migration ───────────────────────────────────────────────────────

describe("<SettingsNotificationsPage /> localStorage migration", () => {
  it("imports legacy prefs via PUT when the server has no overrides, then removes the key", async () => {
    window.localStorage.setItem(
      LEGACY_STORAGE_KEY,
      JSON.stringify({
        channels: { email: false, webhook: true },
        events: { analysisCompleted: false },
      }),
    );
    prefsApi.get.mockResolvedValue(defaultRows());
    const imported = defaultRows([
      { channel: "webhook", event: "issuesPublished", enabled: true },
      { channel: "email", event: "issuesPublished", enabled: false },
    ]);
    prefsApi.put.mockResolvedValue(imported);

    renderPage();
    await screen.findByTestId("settings-notifications-matrix");

    // Legacy semantics: delivered iff channel on AND event on, over the legacy
    // 3-channel × 4-event vocabulary (12 cells). teams/mention/slaDeadline
    // cells are untouched.
    expect(prefsApi.put).toHaveBeenCalledTimes(1);
    const entries = prefsApi.put.mock.calls[0][0] as Array<{
      channel: string;
      event: string;
      enabled: boolean;
    }>;
    expect(entries).toHaveLength(12);
    expect(entries).toEqual(
      expect.arrayContaining([
        { channel: "email", event: "requirementsApproved", enabled: false },
        { channel: "inApp", event: "analysisCompleted", enabled: false },
        { channel: "inApp", event: "requirementsApproved", enabled: true },
        { channel: "webhook", event: "issuesPublished", enabled: true },
        { channel: "webhook", event: "analysisCompleted", enabled: false },
      ]),
    );
    expect(entries.every((e) => e.channel !== "teams")).toBe(true);
    expect(entries.every((e) => e.event !== "mention" && e.event !== "slaDeadline")).toBe(true);

    // Key removed; UI reflects the PUT response.
    expect(window.localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    expect(cell("webhook", "issuesPublished").checked).toBe(true);
    expect(cell("email", "issuesPublished").checked).toBe(false);
  });

  it("does not import when the server already has overrides", async () => {
    window.localStorage.setItem(
      LEGACY_STORAGE_KEY,
      JSON.stringify({ channels: { webhook: true }, events: {} }),
    );
    await renderLoaded(defaultRows([{ channel: "email", event: "mention", enabled: false }]));
    expect(prefsApi.put).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(LEGACY_STORAGE_KEY)).not.toBeNull();
  });

  it("discards a corrupt legacy key without importing", async () => {
    window.localStorage.setItem(LEGACY_STORAGE_KEY, "{not-json");
    await renderLoaded();
    expect(prefsApi.put).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });

  it("keeps the key and shows an error when the import PUT fails", async () => {
    window.localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ channels: {}, events: {} }));
    prefsApi.get.mockResolvedValue(defaultRows());
    prefsApi.put.mockRejectedValue(new Error("import failed"));

    renderPage();
    await screen.findByTestId("settings-notifications-error");
    await waitFor(() => expect(window.localStorage.getItem(LEGACY_STORAGE_KEY)).not.toBeNull());
    // Page still initializes from the GET data so the user is not stuck.
    expect(screen.getByTestId("settings-notifications-matrix")).toBeInTheDocument();
  });
});

// ── buildLegacyImportEntries ─────────────────────────────────────────────────

describe("buildLegacyImportEntries", () => {
  it("crosses merged channel × event toggles over the legacy vocabulary", () => {
    const entries = buildLegacyImportEntries(
      JSON.stringify({
        channels: { email: true, inApp: false, webhook: true },
        events: {
          analysisCompleted: true,
          requirementsApproved: false,
          issuesPublished: true,
          systemAlerts: true,
        },
      }),
    );
    expect(entries).not.toBeNull();
    expect(entries).toHaveLength(12);
    expect(entries).toEqual(
      expect.arrayContaining([
        { channel: "email", event: "analysisCompleted", enabled: true },
        { channel: "email", event: "requirementsApproved", enabled: false },
        { channel: "inApp", event: "issuesPublished", enabled: false },
        { channel: "webhook", event: "systemAlerts", enabled: true },
      ]),
    );
  });

  it("fills missing fields with the legacy defaults (email/inApp on, webhook off, events on)", () => {
    const entries = buildLegacyImportEntries(JSON.stringify({}));
    expect(entries).toEqual(
      expect.arrayContaining([
        { channel: "email", event: "analysisCompleted", enabled: true },
        { channel: "webhook", event: "analysisCompleted", enabled: false },
      ]),
    );
  });

  it("returns null for corrupt or non-object payloads", () => {
    expect(buildLegacyImportEntries("{not-json")).toBeNull();
    expect(buildLegacyImportEntries('"just a string"')).toBeNull();
    expect(buildLegacyImportEntries("null")).toBeNull();
  });
});
