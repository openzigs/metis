/**
 * Issue #416 — NotificationStore + event mapper unit tests.
 *
 * Covers:
 *   - NotificationStore push/markRead/markAllRead/clear/subscribe/hydrate
 *   - mentionEventToNotification mapper
 *   - slaEventToNotification mapper
 *   - getNotificationStore singleton
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NotificationStore,
  mentionEventToNotification,
  slaEventToNotification,
  getNotificationStore,
  _resetNotificationStoreForTests,
  _MAX_NOTIFICATIONS_FOR_TESTS,
} from "@/lib/notifications";

describe("NotificationStore", () => {
  let store: NotificationStore;
  beforeEach(() => {
    store = new NotificationStore();
  });

  it("starts empty", () => {
    expect(store.list()).toEqual([]);
    expect(store.unreadCount()).toBe(0);
  });

  it("push prepends and notifies subscribers", () => {
    const listener = vi.fn();
    store.subscribe(listener);
    listener.mockClear();
    store.push({ level: "warn", title: "t", message: "m" });
    store.push({ level: "error", title: "t2", message: "m2" });
    const snap = store.list();
    expect(snap[0]?.title).toBe("t2");
    expect(snap[1]?.title).toBe("t");
    expect(store.unreadCount()).toBe(2);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("caps the in-memory list at the configured maximum", () => {
    for (let i = 0; i < _MAX_NOTIFICATIONS_FOR_TESTS + 10; i++) {
      store.push({ level: "info", title: `n${i}`, message: "" });
    }
    expect(store.list().length).toBe(_MAX_NOTIFICATIONS_FOR_TESTS);
  });

  it("markRead is a no-op for unknown ids and idempotent for known ids", () => {
    const n = store.push({ level: "warn", title: "t", message: "m" });
    store.markRead("missing");
    expect(store.unreadCount()).toBe(1);
    store.markRead(n.id);
    store.markRead(n.id);
    expect(store.unreadCount()).toBe(0);
  });

  it("markAllRead marks every unread item", () => {
    store.push({ level: "warn", title: "a", message: "" });
    store.push({ level: "error", title: "b", message: "" });
    store.markAllRead();
    expect(store.unreadCount()).toBe(0);
  });

  it("clear removes everything and emits once", () => {
    store.push({ level: "warn", title: "a", message: "" });
    const listener = vi.fn();
    store.subscribe(listener);
    listener.mockClear();
    store.clear();
    expect(store.list()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);
    // No-op when already empty.
    listener.mockClear();
    store.clear();
    expect(listener).not.toHaveBeenCalled();
  });

  it("unsubscribe stops further notifications", () => {
    const listener = vi.fn();
    const off = store.subscribe(listener);
    listener.mockClear();
    off();
    store.push({ level: "warn", title: "t", message: "" });
    expect(listener).not.toHaveBeenCalled();
  });

  describe("hydrate", () => {
    it("merges server items into the store (deduplicates by id)", () => {
      const existing = store.push({ level: "info", title: "live", message: "m" });

      store.hydrate([
        {
          id: "server-1",
          type: "mention",
          title: "Persisted mention",
          message: "You were mentioned",
          href: "/comments/c-1",
          read: false,
          createdAt: new Date(Date.now() - 60_000).toISOString(),
        },
        {
          // Same id as the live item — should not be duplicated.
          id: existing.id,
          type: "mention",
          title: "Duplicate",
          message: "Should be deduped",
          read: false,
          createdAt: existing.createdAt,
        },
      ]);

      const items = store.list();
      // Still 2 items (live + 1 new server item, not 3).
      expect(items).toHaveLength(2);
      expect(items.some((n) => n.id === "server-1")).toBe(true);
      expect(items.filter((n) => n.title === "Duplicate")).toHaveLength(0);
    });

    it("maps sla_deadline type to warn level", () => {
      store.hydrate([
        {
          id: "s-1",
          type: "sla_deadline",
          title: "SLA expired",
          message: "deadline passed",
          read: false,
          createdAt: new Date().toISOString(),
        },
      ]);
      const item = store.list().find((n) => n.id === "s-1");
      expect(item?.level).toBe("warn");
      expect(item?.source).toBe("sla_deadline");
    });

    it("maps other types (mention) to info level", () => {
      store.hydrate([
        {
          id: "m-1",
          type: "mention",
          title: "Mentioned",
          message: "hi",
          read: false,
          createdAt: new Date().toISOString(),
        },
      ]);
      const item = store.list().find((n) => n.id === "m-1");
      expect(item?.level).toBe("info");
    });

    it("is a no-op when all server items already exist in the store", () => {
      const existing = store.push({ level: "info", title: "live", message: "m" });
      const listener = vi.fn();
      store.subscribe(listener);
      listener.mockClear();

      store.hydrate([
        {
          id: existing.id,
          type: "mention",
          title: "Dup",
          message: "dup",
          read: false,
          createdAt: existing.createdAt,
        },
      ]);

      // No emit when nothing new was added.
      expect(listener).not.toHaveBeenCalled();
    });

    it("sorts merged items newest-first", () => {
      const older = new Date(Date.now() - 120_000).toISOString();
      const newer = new Date(Date.now() - 30_000).toISOString();

      store.hydrate([
        { id: "old-1", type: "mention", title: "Old", message: "", read: false, createdAt: older },
        { id: "new-1", type: "mention", title: "New", message: "", read: false, createdAt: newer },
      ]);

      const items = store.list();
      expect(items[0]?.id).toBe("new-1");
      expect(items[1]?.id).toBe("old-1");
    });
  });
});

describe("mentionEventToNotification", () => {
  it("returns info-level notification with comment href", () => {
    const draft = mentionEventToNotification({
      commentId: "c-abc",
      mentionedUserId: "u-1",
      ts: Date.now(),
    });
    expect(draft.level).toBe("info");
    expect(draft.source).toBe("mention");
    expect(draft.href).toContain("c-abc");
    expect(draft.title).toMatch(/mentioned/i);
  });

  it("URL-encodes the commentId in the href", () => {
    const draft = mentionEventToNotification({
      commentId: "c with space",
      mentionedUserId: "u-1",
      ts: Date.now(),
    });
    expect(draft.href).toBe("/comments/c%20with%20space");
  });
});

describe("slaEventToNotification", () => {
  it("returns warn-level notification with requirement href", () => {
    const draft = slaEventToNotification({
      assignmentId: "a-1",
      requirementId: "req-42",
      requirementTitle: "Pay invoice",
      slaDeadline: new Date().toISOString(),
      ts: Date.now(),
    });
    expect(draft.level).toBe("warn");
    expect(draft.source).toBe("sla_deadline");
    expect(draft.href).toContain("req-42");
    expect(draft.title).toContain("Pay invoice");
  });

  it("shows a fallback message when slaDeadline is undefined", () => {
    const draft = slaEventToNotification({
      assignmentId: "a-2",
      requirementId: "req-1",
      requirementTitle: "Req",
      ts: Date.now(),
    });
    expect(draft.message).toMatch(/passed/i);
  });

  it("URL-encodes requirementId in the href", () => {
    const draft = slaEventToNotification({
      assignmentId: "a-3",
      requirementId: "req with space",
      requirementTitle: "R",
      ts: Date.now(),
    });
    expect(draft.href).toBe("/requirements/req%20with%20space");
  });
});

describe("getNotificationStore singleton", () => {
  afterEach(() => _resetNotificationStoreForTests());
  it("returns the same instance until reset", () => {
    const a = getNotificationStore();
    const b = getNotificationStore();
    expect(a).toBe(b);
    _resetNotificationStoreForTests();
    expect(getNotificationStore()).not.toBe(a);
  });
});
