/**
 * Issue #613 (epic #608) — typed client for the self-service notification
 * preference endpoints (#612):
 *
 *   GET /api/users/me/notification-preferences — full resolved channel × event
 *       matrix (stored rows overlaid on the server defaults).
 *   PUT /api/users/me/notification-preferences — upsert toggles, returns the
 *       resolved matrix after the write.
 *
 * Always scoped to the authenticated user — no id parameter exists.
 */
import { apiFetch } from "@/lib/api-client";
import type { NotificationPreferenceEntry } from "@metis/shared";

/**
 * One resolved channel × event cell as served by the API: the effective toggle
 * plus whether it came from a stored row (`isDefault: false`) or the server
 * default matrix (`isDefault: true`).
 */
export interface ResolvedNotificationPreference extends NotificationPreferenceEntry {
  isDefault: boolean;
}

const PATH = "/users/me/notification-preferences";

export const notificationPreferencesApi = {
  /** Fetch the current user's fully-resolved preference matrix. */
  get: async (): Promise<ResolvedNotificationPreference[]> => {
    const data = await apiFetch<{ preferences: ResolvedNotificationPreference[] }>(PATH);
    return data.preferences;
  },

  /** Upsert the given toggles; returns the resolved matrix after the write. */
  put: async (
    preferences: NotificationPreferenceEntry[],
  ): Promise<ResolvedNotificationPreference[]> => {
    const data = await apiFetch<{ preferences: ResolvedNotificationPreference[] }>(PATH, {
      method: "PUT",
      body: { preferences },
    });
    return data.preferences;
  },
};
