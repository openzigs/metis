/**
 * Issue #416 — functional notifications drawer.
 *
 * Replaces the old non-functional `audit:warn`/`audit:error` listeners with
 * the real events the server actually emits (`comment:mention`,
 * `sla:deadline_expired`). Hydrates from persisted server history on mount so
 * unread count and items survive reload/reconnect.
 */
"use client";

import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useSocket } from "@/lib/socket-client";
import {
  getNotificationStore,
  mentionEventToNotification,
  slaEventToNotification,
  type MentionEventPayload,
  type Notification,
  type SlaDeadlineEventPayload,
} from "@/lib/notifications";
import { apiFetch } from "@/lib/api-client";

export function NotificationsDrawer() {
  const socket = useSocket();
  const store = getNotificationStore();
  const [items, setItems] = useState<Notification[]>(() => store.list());
  const [open, setOpen] = useState(false);

  // Subscribe to store changes.
  useEffect(() => store.subscribe(setItems), [store]);

  // Wire the real socket events: comment:mention and sla:deadline_expired.
  // The dead audit:warn / audit:error listeners are removed — those events
  // are never emitted by the server.
  useEffect(() => {
    if (!socket) return;

    const onMention = (event: MentionEventPayload) => {
      const draft = mentionEventToNotification(event);
      store.push(draft);
    };

    const onSlaExpired = (event: SlaDeadlineEventPayload) => {
      const draft = slaEventToNotification(event);
      store.push(draft);
    };

    socket.on("comment:mention", onMention);
    socket.on("sla:deadline_expired", onSlaExpired);

    return () => {
      socket.off("comment:mention", onMention);
      socket.off("sla:deadline_expired", onSlaExpired);
    };
  }, [socket, store]);

  // Hydrate from persisted history on mount so items survive reload/reconnect.
  useEffect(() => {
    type NotificationsResponse = {
      notifications: Array<{
        id: string;
        type: string;
        title: string;
        message: string;
        href?: string | null;
        read: boolean;
        createdAt: string;
      }>;
    };
    apiFetch<NotificationsResponse>("/notifications")
      .then((data) => {
        store.hydrate(data.notifications ?? []);
      })
      .catch(() => {
        // Best-effort: ignore fetch errors (offline / unauthenticated).
      });
  }, [store]);

  const unread = items.reduce((acc, n) => (n.read ? acc : acc + 1), 0);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => {
          setOpen(true);
          if (unread > 0) {
            store.markAllRead();
            // #416 — persist read state server-side so the unread count survives
            // a reload (the store update alone is client-memory only). Best-effort.
            void apiFetch("/notifications/read-all", { method: "POST" }).catch(() => {
              /* local store already reflects read; ignore transient failures */
            });
          }
        }}
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ""}`}
        data-testid="notifications-bell"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 ? (
          <span
            data-testid="notifications-badge"
            className="absolute -mr-4 -mt-4 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="flex w-96 flex-col gap-3 p-4"
          data-testid="notifications-drawer"
        >
          <SheetTitle>Notifications</SheetTitle>
          <SheetDescription>Mentions and SLA deadline alerts.</SheetDescription>
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{items.length} item(s)</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => store.clear()}
              data-testid="notifications-clear"
              disabled={items.length === 0}
            >
              Clear all
            </Button>
          </div>
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">All clear.</p>
          ) : (
            <ul className="flex-1 space-y-2 overflow-y-auto" data-testid="notifications-list">
              {items.map((n) => (
                <li
                  key={n.id}
                  className={
                    "rounded border p-2 text-sm " +
                    (n.level === "error"
                      ? "border-destructive/50 bg-destructive/5"
                      : n.level === "warn"
                        ? "border-amber-300 bg-amber-50/40 dark:bg-amber-950/30"
                        : "border-border bg-muted/30")
                  }
                  data-testid={`notification-${n.id}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <strong className="text-xs uppercase">{n.source ?? n.level}</strong>
                    <time className="text-[10px] text-muted-foreground">
                      {new Date(n.createdAt).toLocaleTimeString()}
                    </time>
                  </div>
                  <p className="mt-1 font-medium">{n.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{n.message}</p>
                  {n.href ? (
                    <a
                      href={n.href}
                      className="mt-1 inline-block text-xs text-primary underline-offset-2 hover:underline"
                    >
                      Open →
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
