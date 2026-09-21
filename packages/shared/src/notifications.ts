/**
 * Epic #608 (#611) — server-side notification preferences.
 *
 * Single channel/event vocabulary shared by server + UI. It is a superset of
 * the Settings → Notifications page vocabulary (email/inApp/webhook ×
 * analysisCompleted/requirementsApproved/issuesPublished/systemAlerts) plus
 * the already-dispatched in-app events (mention, slaDeadline — issue #416)
 * and the Teams notification-card channel (issue #67).
 *
 * The Prisma `NotificationPreference` model stores these as plain strings;
 * this module is the single source of truth for which values are valid.
 */

/** Delivery channels a notification can be sent over. */
export const NOTIFICATION_CHANNELS = ["email", "inApp", "webhook", "teams"] as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Notification-worthy events users can toggle per channel. */
export const NOTIFICATION_EVENTS = [
  "analysisCompleted",
  "requirementsApproved",
  "issuesPublished",
  "systemAlerts",
  "mention",
  "slaDeadline",
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export function isNotificationChannel(value: unknown): value is NotificationChannel {
  return typeof value === "string" && (NOTIFICATION_CHANNELS as readonly string[]).includes(value);
}

export function isNotificationEvent(value: unknown): value is NotificationEvent {
  return typeof value === "string" && (NOTIFICATION_EVENTS as readonly string[]).includes(value);
}

/** One stored preference cell (mirrors a `NotificationPreference` row). */
export interface NotificationPreferenceEntry {
  channel: NotificationChannel;
  event: NotificationEvent;
  enabled: boolean;
}

/** Fully-resolved channel × event preference matrix. */
export type NotificationPreferenceMatrix = Record<
  NotificationChannel,
  Record<NotificationEvent, boolean>
>;
