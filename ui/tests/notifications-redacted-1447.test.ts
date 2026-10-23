/**
 * #1447 — the server redacts a notification whose project the reader can no
 * longer open. A live copy of that notification, pushed over the socket while
 * they still could, takes the redacted text on the next history read rather
 * than outliving it in the drawer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationStore } from "../src/lib/notifications";

const REDACTED = {
  type: "unavailable",
  title: "Notification unavailable",
  message: "",
  href: null,
  read: false,
  redacted: true,
};

describe("NotificationStore.hydrate — redacted rows (#1447)", () => {
  let store: NotificationStore;
  beforeEach(() => {
    store = new NotificationStore();
  });

  it("replaces a live item's text and link with the server's redacted copy", () => {
    store.push({
      id: "n-1",
      level: "warn",
      title: "Review rejected",
      message: '"Secret plan" was rejected',
      href: "/reviews/r-1",
      source: "review_rejected",
    });
    const listener = vi.fn();
    store.subscribe(listener);
    listener.mockClear();

    store.hydrate([{ id: "n-1", createdAt: new Date().toISOString(), ...REDACTED }]);

    const [item] = store.list();
    expect(store.list()).toHaveLength(1);
    expect(item).toMatchObject({
      id: "n-1",
      title: "Notification unavailable",
      message: "",
      href: undefined,
      source: "unavailable",
      level: "info",
    });
    expect(JSON.stringify(store.list())).not.toContain("Secret");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps the live item's read state", () => {
    store.push({ id: "n-2", level: "info", title: "t", message: "m", href: "/x" });
    store.markRead("n-2");

    store.hydrate([{ id: "n-2", createdAt: new Date().toISOString(), ...REDACTED }]);

    expect(store.list()[0]?.read).toBe(true);
  });

  it("adds a redacted row it does not hold yet like any other row", () => {
    store.hydrate([{ id: "n-3", createdAt: new Date().toISOString(), ...REDACTED }]);

    expect(store.list()[0]).toMatchObject({
      id: "n-3",
      title: "Notification unavailable",
      href: undefined,
    });
  });

  it("still lets a live item win over an un-redacted server copy (#104)", () => {
    store.push({ id: "n-4", level: "info", title: "live text", message: "m" });

    store.hydrate([
      {
        id: "n-4",
        type: "mention",
        title: "server text",
        message: "m",
        read: false,
        createdAt: new Date().toISOString(),
        redacted: false,
      },
    ]);

    expect(store.list()[0]?.title).toBe("live text");
  });
});
