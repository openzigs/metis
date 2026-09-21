/**
 * Issue #416 — NotificationsDrawer functional tests.
 *
 * Verifies:
 *   - comment:mention socket event pushes a notification.
 *   - sla:deadline_expired socket event pushes a notification.
 *   - audit:warn / audit:error events are NOT listened to (dead listeners removed).
 *   - Unread badge logic (0, N, 9+).
 *   - Drawer renders mention + SLA notifications with correct copy.
 *   - Hydrate-on-mount fetches persisted history from /api/notifications.
 *   - Clear all button works.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

// ---- Mock socket-client -----------------------------------------------------
const mockSocketHandlers: Map<string, (payload: unknown) => void> = new Map();
const mockSocket = {
  on: vi.fn((event: string, handler: (payload: unknown) => void) => {
    mockSocketHandlers.set(event, handler);
  }),
  off: vi.fn((event: string) => {
    mockSocketHandlers.delete(event);
  }),
};

vi.mock("@/lib/socket-client", () => ({
  useSocket: vi.fn(() => mockSocket),
}));

// ---- Mock api-client --------------------------------------------------------
const mockApiFetch = vi.fn().mockResolvedValue({ notifications: [] });
vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch: (...args: unknown[]) => mockApiFetch(...args) };
});

// ---- Mock notifications store -----------------------------------------------
const mockStore = {
  list: vi.fn().mockReturnValue([]),
  // subscribe calls the listener immediately with the current list() value so
  // that component state reflects whatever list() is configured to return.
  subscribe: vi.fn().mockImplementation((cb: (items: unknown[]) => void) => {
    cb(mockStore.list());
    return () => {};
  }),
  markAllRead: vi.fn(),
  clear: vi.fn(),
  push: vi.fn(),
  hydrate: vi.fn(),
};

vi.mock("@/lib/notifications", () => ({
  getNotificationStore: vi.fn(() => mockStore),
  mentionEventToNotification: vi.fn((e: { commentId: string }) => ({
    level: "info",
    title: "You were mentioned in a comment",
    message: `Comment ${e.commentId}`,
    source: "mention",
    href: `/comments/${e.commentId}`,
  })),
  slaEventToNotification: vi.fn((e: { requirementTitle: string }) => ({
    level: "warn",
    title: `SLA expired: ${e.requirementTitle}`,
    message: "SLA deadline has passed",
    source: "sla_deadline",
    href: `/requirements/req-1`,
  })),
}));

import { NotificationsDrawer } from "@/components/notifications/notifications-drawer";
import { useSocket } from "@/lib/socket-client";

const useSocketMock = useSocket as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockSocketHandlers.clear();
  mockStore.list.mockReturnValue([]);
  // subscribe calls cb with the current list() value — this must be re-wired
  // after clearAllMocks so individual tests can set list() before render.
  mockStore.subscribe.mockImplementation((cb: (items: unknown[]) => void) => {
    cb(mockStore.list());
    return () => {};
  });
  mockApiFetch.mockResolvedValue({ notifications: [] });
  useSocketMock.mockReturnValue(mockSocket);
});

function makeNotification(over: Record<string, unknown> = {}) {
  return {
    id: "n1",
    level: "info",
    title: "You were mentioned",
    message: "Comment c-1",
    source: "mention",
    read: false,
    createdAt: new Date().toISOString(),
    href: "/comments/c-1",
    ...over,
  };
}

// ---- Tests ------------------------------------------------------------------

describe("NotificationsDrawer — real socket event wiring", () => {
  it("subscribes to comment:mention (not audit:warn)", () => {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <NotificationsDrawer />
      </Wrapper>,
    );
    expect(mockSocket.on).toHaveBeenCalledWith("comment:mention", expect.any(Function));
    expect(mockSocket.on).not.toHaveBeenCalledWith("audit:warn", expect.any(Function));
  });

  it("subscribes to sla:deadline_expired (not audit:error)", () => {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <NotificationsDrawer />
      </Wrapper>,
    );
    expect(mockSocket.on).toHaveBeenCalledWith("sla:deadline_expired", expect.any(Function));
    expect(mockSocket.on).not.toHaveBeenCalledWith("audit:error", expect.any(Function));
  });

  it("pushing a comment:mention event calls store.push", () => {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <NotificationsDrawer />
      </Wrapper>,
    );

    const handler = mockSocketHandlers.get("comment:mention");
    expect(handler).toBeDefined();
    handler?.({ commentId: "c-xyz", mentionedUserId: "u-1", ts: Date.now() });
    expect(mockStore.push).toHaveBeenCalledWith(expect.objectContaining({ source: "mention" }));
  });

  it("pushing an sla:deadline_expired event calls store.push", () => {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <NotificationsDrawer />
      </Wrapper>,
    );

    const handler = mockSocketHandlers.get("sla:deadline_expired");
    expect(handler).toBeDefined();
    handler?.({
      assignmentId: "a-1",
      requirementId: "req-1",
      requirementTitle: "Pay invoice",
      slaDeadline: new Date().toISOString(),
      ts: Date.now(),
    });
    expect(mockStore.push).toHaveBeenCalledWith(
      expect.objectContaining({ source: "sla_deadline" }),
    );
  });

  it("cleans up socket listeners on unmount", () => {
    const Wrapper = makeWrapper({});
    const { unmount } = render(
      <Wrapper>
        <NotificationsDrawer />
      </Wrapper>,
    );
    unmount();
    expect(mockSocket.off).toHaveBeenCalledWith("comment:mention", expect.any(Function));
    expect(mockSocket.off).toHaveBeenCalledWith("sla:deadline_expired", expect.any(Function));
  });
});

describe("NotificationsDrawer — hydrate on mount", () => {
  it("calls apiFetch /notifications on mount to hydrate persisted history", async () => {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <NotificationsDrawer />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith("/notifications");
    });
  });

  it("calls store.hydrate with the fetched notifications", async () => {
    const serverItems = [
      {
        id: "p-1",
        type: "mention",
        title: "Persisted mention",
        message: "hi",
        href: "/comments/c-1",
        read: true,
        createdAt: new Date().toISOString(),
      },
    ];
    mockApiFetch.mockResolvedValue({ notifications: serverItems });

    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <NotificationsDrawer />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(mockStore.hydrate).toHaveBeenCalledWith(serverItems);
    });
  });

  it("gracefully ignores apiFetch errors (offline/unauth)", async () => {
    mockApiFetch.mockRejectedValue(new Error("Network error"));

    const Wrapper = makeWrapper({});
    // Should not throw.
    expect(() =>
      render(
        <Wrapper>
          <NotificationsDrawer />
        </Wrapper>,
      ),
    ).not.toThrow();
  });
});

describe("NotificationsDrawer — unread badge branches", () => {
  it("shows no badge when 0 unread", () => {
    mockStore.list.mockReturnValue([makeNotification({ read: true })]);
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <NotificationsDrawer />
      </Wrapper>,
    );
    expect(screen.queryByTestId("notifications-badge")).not.toBeInTheDocument();
  });

  it("shows badge count when items unread", () => {
    mockStore.list.mockReturnValue([
      makeNotification({ id: "n1", read: false }),
      makeNotification({ id: "n2", read: false }),
    ]);
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <NotificationsDrawer />
      </Wrapper>,
    );
    expect(screen.getByTestId("notifications-badge")).toBeInTheDocument();
    expect(screen.getByTestId("notifications-badge").textContent).toBe("2");
  });

  it("shows 9+ badge when more than 9 unread", () => {
    const items = Array.from({ length: 11 }, (_, i) =>
      makeNotification({ id: `n${i}`, read: false }),
    );
    mockStore.list.mockReturnValue(items);
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <NotificationsDrawer />
      </Wrapper>,
    );
    expect(screen.getByTestId("notifications-badge").textContent).toBe("9+");
  });
});

describe("NotificationsDrawer — drawer content", () => {
  it("opens drawer and shows 'All clear' when empty", async () => {
    mockStore.list.mockReturnValue([]);
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <NotificationsDrawer />
      </Wrapper>,
    );
    fireEvent.click(screen.getByTestId("notifications-bell"));
    await waitFor(() => expect(screen.getByTestId("notifications-drawer")).toBeInTheDocument());
    expect(screen.getByText("All clear.")).toBeInTheDocument();
  });

  it("renders mention notification with title and link", async () => {
    mockStore.list.mockReturnValue([
      makeNotification({
        id: "n-mention",
        level: "info",
        title: "You were mentioned in a comment",
        source: "mention",
        href: "/comments/c-1",
      }),
    ]);
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <NotificationsDrawer />
      </Wrapper>,
    );
    fireEvent.click(screen.getByTestId("notifications-bell"));
    await waitFor(() => expect(screen.getByTestId("notification-n-mention")).toBeInTheDocument());
    expect(screen.getByText("You were mentioned in a comment")).toBeInTheDocument();
    expect(screen.getByText("Open →")).toBeInTheDocument();
  });

  it("renders SLA notification with warn styling", async () => {
    mockStore.list.mockReturnValue([
      makeNotification({
        id: "n-sla",
        level: "warn",
        title: "SLA expired: My Req",
        source: "sla_deadline",
        href: "/requirements/req-1",
      }),
    ]);
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <NotificationsDrawer />
      </Wrapper>,
    );
    fireEvent.click(screen.getByTestId("notifications-bell"));
    await waitFor(() => expect(screen.getByTestId("notification-n-sla")).toBeInTheDocument());
    expect(screen.getByText("SLA expired: My Req")).toBeInTheDocument();
  });

  it("clears notifications on Clear all click", async () => {
    mockStore.list.mockReturnValue([makeNotification({ id: "n1" })]);
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <NotificationsDrawer />
      </Wrapper>,
    );
    fireEvent.click(screen.getByTestId("notifications-bell"));
    await waitFor(() => expect(screen.getByTestId("notifications-clear")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("notifications-clear"));
    expect(mockStore.clear).toHaveBeenCalled();
  });
});

describe("NotificationsDrawer — mark-all-read persistence (#416)", () => {
  it("persists read state via POST /notifications/read-all when opened with unread items", async () => {
    mockStore.list.mockReturnValue([makeNotification({ id: "n1", read: false })]);
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <NotificationsDrawer />
      </Wrapper>,
    );
    fireEvent.click(screen.getByTestId("notifications-bell"));
    expect(mockStore.markAllRead).toHaveBeenCalled();
    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith("/notifications/read-all", { method: "POST" });
    });
  });

  it("does NOT call read-all when opened with no unread items", () => {
    mockStore.list.mockReturnValue([makeNotification({ id: "n1", read: true })]);
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <NotificationsDrawer />
      </Wrapper>,
    );
    fireEvent.click(screen.getByTestId("notifications-bell"));
    expect(mockStore.markAllRead).not.toHaveBeenCalled();
    const readAllCalled = mockApiFetch.mock.calls.some(
      ([path]) => path === "/notifications/read-all",
    );
    expect(readAllCalled).toBe(false);
  });
});
