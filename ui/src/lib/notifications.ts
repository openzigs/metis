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

import type {
  CommentMentionEvent,
  DiscussionMentionEvent,
  InAppNotificationFields,
  ReviewNotificationEvent,
} from "@metis/shared";

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
  /** #1447 — the server withheld it: the reader can no longer open its project. */
  redacted?: boolean;
}

/** A notification before the store stamps it; `id` only when the server persisted it. */
export type NotificationDraft = Omit<Notification, "id" | "createdAt" | "read"> & {
  id?: string;
};

type Listener = (snapshot: Notification[]) => void;

const MAX_NOTIFICATIONS = 50;

/** Persisted `Notification.type`s shown as a warning, live or hydrated alike. */
const WARN_TYPES: ReadonlySet<string> = new Set(["sla_deadline", "review_rejected"]);

export class NotificationStore {
  private items: Notification[] = [];
  private listeners = new Set<Listener>();

  list(): Notification[] {
    return this.items.slice();
  }

  unreadCount(): number {
    return this.items.reduce((acc, n) => (n.read ? acc : acc + 1), 0);
  }

  /**
   * Add a live notification. #104 — a draft carrying the persisted row's `id`
   * keeps it, so the history hydrate merges it rather than listing it twice;
   * a draft whose id is already listed is not added again.
   */
  push(input: NotificationDraft): Notification {
    const existing = input.id ? this.items.find((n) => n.id === input.id) : undefined;
    if (existing) return existing;
    const n: Notification = {
      ...input,
      id: input.id ?? `n_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
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
      /** #1447 — the reader can no longer open this row's project. */
      redacted?: boolean;
    }>,
  ): void {
    // #1447 — the server's access check wins over an item already held, in both
    // directions: a held item the server now redacts (the reader lost access
    // since it arrived) takes the redacted text, and a held REDACTED item the
    // server now returns in full (access restored) takes the full text back.
    // Otherwise a held item still wins over its saved copy (#104).
    let changedHeld = false;
    for (const s of serverItems) {
      const held = this.items.find((n) => n.id === s.id);
      if (!held || (!s.redacted && !held.redacted)) continue;
      held.title = s.title;
      held.message = s.message;
      held.href = s.redacted ? undefined : safeInAppHref(s.href);
      held.source = s.type;
      held.level = !s.redacted && WARN_TYPES.has(s.type) ? "warn" : "info";
      if (s.redacted) held.redacted = true;
      else delete held.redacted;
      changedHeld = true;
    }

    const existingIds = new Set(this.items.map((n) => n.id));
    const newItems: Notification[] = serverItems
      .filter((s) => !existingIds.has(s.id))
      .map((s) => ({
        id: s.id,
        level: (WARN_TYPES.has(s.type) ? "warn" : "info") as NotificationLevel,
        title: s.title,
        message: s.message,
        createdAt: s.createdAt,
        // #104 review — the same filter as a live item, so a saved row with a
        // link the drawer would refuse live is refused here too.
        href: safeInAppHref(s.href),
        source: s.type,
        read: s.read,
        ...(s.redacted ? { redacted: true } : {}),
      }));

    if (newItems.length === 0) {
      if (changedHeld) this.emit();
      return;
    }

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

/**
 * Payload of a `comment:mention` event (#1318). During a rolling deploy a
 * server from before #1318 still sends only `{ commentId, mentionedUserId, ts }`,
 * so the text, link and id may be absent.
 */
export type MentionEventPayload = Pick<
  CommentMentionEvent,
  "commentId" | "mentionedUserId" | "ts"
> &
  Partial<Omit<CommentMentionEvent, "commentId" | "mentionedUserId" | "ts">>;

/** Title of a comment mention whose event carried no text (an older server). */
export const FALLBACK_MENTION_TITLE = "You were mentioned in a comment";

/** Payload shape emitted by the server for sla:deadline_expired events. */
export interface SlaDeadlineEventPayload {
  assignmentId: string;
  requirementId: string;
  requirementTitle: string;
  slaDeadline?: string;
  ts: number;
}

/**
 * Map a `comment:mention` event into a Notification draft. #1318 — the event
 * carries the saved row's id, text (who and where, plus an excerpt) and the
 * link to the comment's thread; it used to show the raw comment id and link to
 * `/comments/<id>`, which has no page.
 *
 * An old-shape event (rolling deploy) gets a generic title and no link — never
 * the raw comment id or the dead `/comments/<id>` route; the saved row, with
 * its real text and link, arrives on the next history read.
 */
export function mentionEventToNotification(event: MentionEventPayload): NotificationDraft {
  return inAppDraft(
    {
      notificationId: event.notificationId ?? null,
      title: event.title || FALLBACK_MENTION_TITLE,
      message: event.message ?? "",
      href: event.href ?? "",
    },
    "mention",
    "info",
  );
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

/**
 * #104 — the href of a live notification, only if it is a same-origin relative
 * path. The server builds it, but the drawer renders it as a link, so anything
 * else (`//host`, `/\host`, `javascript:`, an absolute URL) is dropped rather
 * than followed.
 */
export function safeInAppHref(href: string | null | undefined): string | undefined {
  if (typeof href !== "string" || !href.startsWith("/")) return undefined;
  // Judge the link the way the browser will resolve it. A prefix check is not
  // enough: the URL parser drops tab and newline and reads `\` as `/`, so
  // "/\t/evil.example" and "/\\evil.example" both open https://evil.example/.
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return undefined;
  }
  if (url.origin !== origin) return undefined;
  // Hand back the parsed form, so the anchor gets exactly what was judged.
  const result = `${url.pathname}${url.search}${url.hash}`;
  // Normalising dot segments can itself produce a protocol-relative path:
  // "/.//evil.example" resolves on this origin to the pathname "//evil.example",
  // which an anchor then opens as http://evil.example. Judge the result again.
  if (!result.startsWith("/") || result.startsWith("//") || result.startsWith("/\\")) {
    return undefined;
  }
  if (new URL(result, origin).origin !== origin) return undefined;
  return result;
}

/** The server-built text and link of a `user:{id}` notification event (#104). */
function inAppDraft(
  event: InAppNotificationFields,
  source: string,
  level: NotificationLevel,
): NotificationDraft {
  return {
    ...(event.notificationId ? { id: event.notificationId } : {}),
    level,
    title: event.title,
    message: event.message,
    source,
    href: safeInAppHref(event.href),
  };
}

/** #104 — map a `discussion:mention` event into a Notification draft. */
export function discussionMentionEventToNotification(
  event: DiscussionMentionEvent,
): NotificationDraft {
  return inAppDraft(event, event.kind, "info");
}

/**
 * #104 — map a `review:notification` event into a Notification draft. A
 * rejection is a `warn`: it asks the requester to act.
 */
export function reviewEventToNotification(event: ReviewNotificationEvent): NotificationDraft {
  return inAppDraft(event, event.kind, event.kind === "review_rejected" ? "warn" : "info");
}

export const _MAX_NOTIFICATIONS_FOR_TESTS = MAX_NOTIFICATIONS;
