/**
 * Issue #416 — in-memory notifications store fed by real Socket.IO events
 * (`comment:mention`, `sla:deadline_expired`) and hydrated from the persisted
 * notification history on drawer open/mount.
 *
 * This module is a tiny pub/sub so the bell badge + the drawer can share
 * the same source of truth without a heavyweight state library. Notifications
 * are persisted server-side (via `GET /api/notifications`) so they survive
 * reload/reconnect; the in-memory store is the presentation layer.
 */

export type NotificationLevel = "info" | "warn" | "error";

export interface Notification {
  id: string;
  level: NotificationLevel;
  title: string;
  message: string;
  createdAt: string;
  /** Optional click-through target (relative path). */
  href?: string;
  /** Optional source label, e.g. `mention`, `sla_deadline`. */
  source?: string;
  read: boolean;
}

type Listener = (snapshot: Notification[]) => void;

const MAX_NOTIFICATIONS = 50;

export class NotificationStore {
  private items: Notification[] = [];
  private listeners = new Set<Listener>();

  list(): Notification[] {
    return this.items.slice();
  }

  unreadCount(): number {
    return this.items.reduce((acc, n) => (n.read ? acc : acc + 1), 0);
  }

  push(input: Omit<Notification, "id" | "createdAt" | "read">): Notification {
    const n: Notification = {
      ...input,
      id: `n_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      createdAt: new Date().toISOString(),
      read: false,
    };
    this.items.unshift(n);
    if (this.items.length > MAX_NOTIFICATIONS) {
      this.items.length = MAX_NOTIFICATIONS;
    }
    this.emit();
    return n;
  }

  /**
   * Hydrate the store from persisted server notifications (called on drawer
   * open / component mount). Merges by id so duplicate pushes are idempotent.
   */
  hydrate(
    serverItems: Array<{
      id: string;
      type: string;
      title: string;
      message: string;
      href?: string | null;
      read: boolean;
      createdAt: string;
    }>,
  ): void {
    const existingIds = new Set(this.items.map((n) => n.id));
    const newItems: Notification[] = serverItems
      .filter((s) => !existingIds.has(s.id))
      .map((s) => ({
        id: s.id,
        level: (s.type === "sla_deadline" ? "warn" : "info") as NotificationLevel,
        title: s.title,
        message: s.message,
        createdAt: s.createdAt,
        href: s.href ?? undefined,
        source: s.type,
        read: s.read,
      }));

    if (newItems.length === 0) return;

    // Merge: existing items (real-time) at front, server items appended.
    this.items = [...this.items, ...newItems].slice(0, MAX_NOTIFICATIONS);
    // Re-sort by createdAt descending so newest is always first.
    this.items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    this.emit();
  }

  markRead(id: string): void {
    const target = this.items.find((n) => n.id === id);
    if (target && !target.read) {
      target.read = true;
      this.emit();
    }
  }

  markAllRead(): void {
    let changed = false;
    for (const n of this.items) {
      if (!n.read) {
        n.read = true;
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  clear(): void {
    if (this.items.length === 0) return;
    this.items = [];
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.list());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snap = this.list();
    for (const l of this.listeners) l(snap);
  }
}

let singleton: NotificationStore | null = null;

export function getNotificationStore(): NotificationStore {
  if (!singleton) singleton = new NotificationStore();
  return singleton;
}

/** Test seam — discard the singleton between specs. */
export function _resetNotificationStoreForTests(): void {
  singleton = null;
}

// ---------------------------------------------------------------------------
// Event → Notification mappers (replaces the old auditEventToNotification)
// ---------------------------------------------------------------------------

/** Payload shape emitted by the server for comment:mention events. */
export interface MentionEventPayload {
  commentId: string;
  mentionedUserId: string;
  ts: number;
}

/** Payload shape emitted by the server for sla:deadline_expired events. */
export interface SlaDeadlineEventPayload {
  assignmentId: string;
  requirementId: string;
  requirementTitle: string;
  slaDeadline?: string;
  ts: number;
}

/**
 * Map a `comment:mention` event payload into a Notification draft.
 */
export function mentionEventToNotification(
  event: MentionEventPayload,
): Omit<Notification, "id" | "createdAt" | "read"> {
  return {
    level: "info",
    title: "You were mentioned in a comment",
    message: `You were mentioned in comment ${event.commentId}`,
    source: "mention",
    href: `/comments/${encodeURIComponent(event.commentId)}`,
  };
}

/**
 * Map a `sla:deadline_expired` event payload into a Notification draft.
 */
export function slaEventToNotification(
  event: SlaDeadlineEventPayload,
): Omit<Notification, "id" | "createdAt" | "read"> {
  return {
    level: "warn",
    title: `SLA expired: ${event.requirementTitle}`,
    message: event.slaDeadline
      ? `SLA deadline passed at ${new Date(event.slaDeadline).toLocaleString()}`
      : "SLA deadline has passed",
    source: "sla_deadline",
    href: `/requirements/${encodeURIComponent(event.requirementId)}`,
  };
}

export const _MAX_NOTIFICATIONS_FOR_TESTS = MAX_NOTIFICATIONS;
