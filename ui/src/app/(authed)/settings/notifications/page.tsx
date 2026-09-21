/**
 * Epic #608 (#613) — Settings sub-page: Notifications.
 *
 * Per-user channel × event preference matrix, backed by the preferences API
 * (GET/PUT /api/users/me/notification-preferences — #612). Replaces the old
 * localStorage persistence (Epic #196/#220) with a one-time import: if the
 * legacy key exists and the server has no overrides yet, the legacy toggles
 * are PUT to the server and the key is removed. API failures surface as an
 * error state — localStorage is never used as a fallback data source.
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENTS,
  type NotificationChannel,
  type NotificationEvent,
  type NotificationPreferenceEntry,
} from "@metis/shared";
import {
  notificationPreferencesApi,
  type ResolvedNotificationPreference,
} from "@/lib/notification-preferences-api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/** localStorage key used by the pre-#608 page. Read once for import, then removed. */
export const LEGACY_STORAGE_KEY = "metis.settings.notifications";

const QUERY_KEY = ["settings", "notification-preferences"] as const;

const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  email: "Email",
  inApp: "In-app",
  webhook: "Webhook",
  teams: "Microsoft Teams",
};

const EVENT_LABELS: Record<NotificationEvent, string> = {
  analysisCompleted: "Analysis completed",
  requirementsApproved: "Requirements approved",
  issuesPublished: "Issues published",
  systemAlerts: "System alerts",
  mention: "Mentions",
  slaDeadline: "SLA deadlines",
};

/** Draft/saved state: one boolean per (channel, event) cell. */
type PrefMap = Record<string, boolean>;

function cellKey(channel: string, event: string): string {
  return `${channel}:${event}`;
}

function toPrefMap(entries: readonly ResolvedNotificationPreference[]): PrefMap {
  const map: PrefMap = {};
  for (const e of entries) map[cellKey(e.channel, e.event)] = e.enabled;
  return map;
}

/** Cells changed between the saved and draft states, as PUT entries. */
function diffEntries(saved: PrefMap, draft: PrefMap): NotificationPreferenceEntry[] {
  const changed: NotificationPreferenceEntry[] = [];
  for (const channel of NOTIFICATION_CHANNELS) {
    for (const event of NOTIFICATION_EVENTS) {
      const key = cellKey(channel, event);
      if (draft[key] !== undefined && draft[key] !== saved[key]) {
        changed.push({ channel, event, enabled: draft[key] });
      }
    }
  }
  return changed;
}

// ── one-time legacy import ────────────────────────────────────────────────────

/** Vocabulary + defaults of the pre-#608 localStorage payload. */
const LEGACY_CHANNEL_DEFAULTS = { email: true, inApp: true, webhook: false } as const;
const LEGACY_EVENT_DEFAULTS = {
  analysisCompleted: true,
  requirementsApproved: true,
  issuesPublished: true,
  systemAlerts: true,
} as const;

type LegacyChannel = keyof typeof LEGACY_CHANNEL_DEFAULTS;
type LegacyEvent = keyof typeof LEGACY_EVENT_DEFAULTS;

/**
 * Convert a raw legacy localStorage payload into PUT entries over the legacy
 * 3-channel × 4-event vocabulary. Legacy semantics were "deliver iff the
 * channel is on AND the event is on", so each imported cell is the AND of the
 * two toggles (missing fields fall back to the legacy defaults, exactly as the
 * old page's loader did). Returns null when the payload is not a JSON object.
 */
export function buildLegacyImportEntries(raw: string): NotificationPreferenceEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const payload = parsed as {
    channels?: Partial<Record<LegacyChannel, boolean>>;
    events?: Partial<Record<LegacyEvent, boolean>>;
  };
  const channels = { ...LEGACY_CHANNEL_DEFAULTS, ...(payload.channels ?? {}) };
  const events = { ...LEGACY_EVENT_DEFAULTS, ...(payload.events ?? {}) };

  const entries: NotificationPreferenceEntry[] = [];
  for (const channel of Object.keys(LEGACY_CHANNEL_DEFAULTS) as LegacyChannel[]) {
    for (const event of Object.keys(LEGACY_EVENT_DEFAULTS) as LegacyEvent[]) {
      entries.push({
        channel,
        event,
        enabled: channels[channel] === true && events[event] === true,
      });
    }
  }
  return entries;
}

// ── page ─────────────────────────────────────────────────────────────────────

export default function SettingsNotificationsPage() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: notificationPreferencesApi.get,
  });

  const [saved, setSaved] = useState<PrefMap | null>(null);
  const [draft, setDraft] = useState<PrefMap | null>(null);
  const [savedToast, setSavedToast] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const initializedRef = useRef(false);

  const saveMutation = useMutation({
    mutationFn: (entries: NotificationPreferenceEntry[]) => notificationPreferencesApi.put(entries),
    onSuccess: (entries) => {
      const map = toPrefMap(entries);
      setSaved(map);
      setDraft(map);
      setErrorMessage(null);
      setSavedToast(true);
      queryClient.setQueryData(QUERY_KEY, entries);
    },
    onError: () => {
      setErrorMessage("Saving failed. Your changes were not stored — try again.");
    },
  });

  // Initialize from the GET result exactly once, running the one-time legacy
  // import first when applicable.
  useEffect(() => {
    const data = query.data;
    if (!data || initializedRef.current) return;
    initializedRef.current = true;

    void (async () => {
      let entries: readonly ResolvedNotificationPreference[] = data;
      const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
      if (raw !== null) {
        const hasOverrides = data.some((e) => !e.isDefault);
        const legacy = hasOverrides ? null : buildLegacyImportEntries(raw);
        if (legacy) {
          try {
            entries = await notificationPreferencesApi.put(legacy);
            queryClient.setQueryData(QUERY_KEY, entries);
            window.localStorage.removeItem(LEGACY_STORAGE_KEY);
          } catch {
            // Keep the key so the import retries on the next visit; the page
            // still initializes from the server state.
            setErrorMessage(
              "Importing your saved browser preferences failed — they will be retried next time.",
            );
          }
        } else if (!hasOverrides) {
          // Corrupt payload — nothing importable, drop it for good.
          window.localStorage.removeItem(LEGACY_STORAGE_KEY);
        }
      }
      const map = toPrefMap(entries);
      setSaved(map);
      setDraft(map);
    })();
  }, [query.data, queryClient]);

  useEffect(() => {
    if (!savedToast) return;
    const t = setTimeout(() => setSavedToast(false), 2_000);
    return () => clearTimeout(t);
  }, [savedToast]);

  const changed = useMemo(() => (saved && draft ? diffEntries(saved, draft) : []), [saved, draft]);
  const dirty = changed.length > 0;

  function toggleCell(channel: NotificationChannel, event: NotificationEvent, value: boolean) {
    setDraft((d) => (d ? { ...d, [cellKey(channel, event)]: value } : d));
  }

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="settings-notifications-root">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Notifications</h1>
          <p className="text-sm text-muted-foreground">
            Choose which channels deliver which events. Synced to your account across devices.
          </p>
        </div>
        {savedToast ? (
          <span
            role="status"
            aria-live="polite"
            className="rounded bg-emerald-100 px-2 py-1 text-xs text-emerald-900"
            data-testid="settings-notifications-saved"
          >
            Saved
          </span>
        ) : null}
      </header>

      {errorMessage || query.isError ? (
        <div
          role="alert"
          className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900"
          data-testid="settings-notifications-error"
        >
          {query.isError ? "Loading notification preferences failed." : errorMessage}
          {query.isError ? (
            <Button
              variant="outline"
              size="sm"
              className="ml-2"
              onClick={() => void query.refetch()}
              data-testid="settings-notifications-retry"
            >
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}

      {!query.isError && (!draft || !saved) ? (
        <p className="text-sm text-muted-foreground" data-testid="settings-notifications-loading">
          Loading…
        </p>
      ) : null}

      {draft && saved ? (
        <>
          <Card className="overflow-x-auto p-4" data-testid="settings-notifications-matrix">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th scope="col" className="py-2 pr-3 text-left font-semibold">
                    Event
                  </th>
                  {NOTIFICATION_CHANNELS.map((channel) => (
                    <th key={channel} scope="col" className="px-2 py-2 text-center font-semibold">
                      {CHANNEL_LABELS[channel]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {NOTIFICATION_EVENTS.map((event) => (
                  <tr key={event} className="border-t">
                    <th scope="row" className="py-2 pr-3 text-left font-normal">
                      {EVENT_LABELS[event]}
                    </th>
                    {NOTIFICATION_CHANNELS.map((channel) => (
                      <td key={channel} className="px-2 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={draft[cellKey(channel, event)] ?? false}
                          onChange={(e) => toggleCell(channel, event, e.target.checked)}
                          data-testid={`settings-notifications-cell-${channel}-${event}`}
                          aria-label={`${EVENT_LABELS[event]} via ${CHANNEL_LABELS[channel]}`}
                          className="h-4 w-4"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <div className="flex items-center gap-2">
            <Button
              onClick={() => saveMutation.mutate(changed)}
              disabled={!dirty || saveMutation.isPending}
              data-testid="settings-notifications-save"
            >
              Save
            </Button>
            <Button
              variant="outline"
              onClick={() => setDraft(saved)}
              disabled={!dirty || saveMutation.isPending}
              data-testid="settings-notifications-discard"
            >
              Discard changes
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
