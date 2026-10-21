/**
 * #104 — `discussion:mention` and `review:notification` reach the
 * notifications drawer live, with readable text and a link to the thing, and
 * merge with the persisted history instead of appearing twice.
 *
 * The real store and mappers run; only the socket and the API are stand-ins.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DiscussionMentionEvent, ReviewNotificationEvent } from "@metis/shared";
import { makeWrapper } from "./test-utils";
import { createFakeSocket, type FakeSocket } from "./helpers/fake-socket";

let socket: FakeSocket;
vi.mock("@/lib/socket-client", () => ({ useSocket: () => socket }));

const mockApiFetch = vi.fn();
vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch: (...args: unknown[]) => mockApiFetch(...args) };
});

import { NotificationsDrawer } from "@/components/notifications/notifications-drawer";
import {
  _resetNotificationStoreForTests,
  discussionMentionEventToNotification,
  getNotificationStore,
  reviewEventToNotification,
  safeInAppHref,
} from "@/lib/notifications";

function reviewEvent(over: Partial<ReviewNotificationEvent> = {}): ReviewNotificationEvent {
  return {
    kind: "review_requested",
    reviewId: "rev-1",
    userId: "u-1",
    ts: 1,
    projectId: "p-1",
    notificationId: "n-review",
    title: "Review requested",
    message: 'You are assigned as a reviewer on "Sprint 4 sign-off"',
    href: "/reviews/rev-1",
    ...over,
  };
}

function mentionEvent(over: Partial<DiscussionMentionEvent> = {}): DiscussionMentionEvent {
  return {
    kind: "discussion_mention",
    threadId: "t-1",
    messageId: "m-1",
    mentionedUserId: "u-1",
    ts: 1,
    notificationId: "n-mention",
    title: "Alice mentioned you in a discussion",
    message: "Alice mentioned you in a discussion thread",
    href: "/projects/p-1/discussions/t-1",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetNotificationStoreForTests();
  socket = createFakeSocket();
  mockApiFetch.mockResolvedValue({ notifications: [] });
});

function renderDrawer() {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <NotificationsDrawer />
    </Wrapper>,
  );
}

async function openDrawer() {
  fireEvent.click(screen.getByTestId("notifications-bell"));
  return screen.findByTestId("notifications-drawer");
}

describe("NotificationsDrawer — #104 live events", () => {
  it("shows a review request live, with its text and a link to the review", async () => {
    renderDrawer();
    act(() => socket.fire("review:notification", reviewEvent()));

    expect(screen.getByTestId("notifications-badge")).toHaveTextContent("1");
    await openDrawer();
    expect(screen.getByText("Review requested")).toBeInTheDocument();
    expect(screen.getByText(/assigned as a reviewer on "Sprint 4 sign-off"/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open/i })).toHaveAttribute("href", "/reviews/rev-1");
  });

  it("shows a discussion mention live, linking to the thread", async () => {
    renderDrawer();
    act(() => socket.fire("discussion:mention", mentionEvent()));

    await openDrawer();
    expect(screen.getByText("Alice mentioned you in a discussion")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open/i })).toHaveAttribute(
      "href",
      "/projects/p-1/discussions/t-1",
    );
  });

  it("lists a live item once when the history re-read returns the same row", async () => {
    renderDrawer();
    act(() => socket.fire("review:notification", reviewEvent()));
    act(() =>
      getNotificationStore().hydrate([
        {
          id: "n-review",
          type: "review_requested",
          title: "Review requested",
          message: "persisted copy",
          href: "/reviews/rev-1",
          read: false,
          createdAt: new Date().toISOString(),
        },
      ]),
    );

    expect(getNotificationStore().list()).toHaveLength(1);
  });

  it("stops listening on unmount", () => {
    const { unmount } = renderDrawer();
    expect(socket.listeners("discussion:mention")).toBe(1);
    expect(socket.listeners("review:notification")).toBe(1);
    unmount();
    expect(socket.listeners("discussion:mention")).toBe(0);
    expect(socket.listeners("review:notification")).toBe(0);
  });

  it("still hydrates the persisted history on mount", async () => {
    renderDrawer();
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith("/notifications"));
  });
});

describe("#104 mappers", () => {
  it("keeps the persisted id, so the hydrate merges rather than duplicates", () => {
    expect(reviewEventToNotification(reviewEvent())).toMatchObject({
      id: "n-review",
      level: "info",
      source: "review_requested",
      title: "Review requested",
      href: "/reviews/rev-1",
    });
  });

  it("marks a rejection as a warning", () => {
    expect(reviewEventToNotification(reviewEvent({ kind: "review_rejected" })).level).toBe("warn");
  });

  it("leaves the id to the store when the server could not persist the row", () => {
    const draft = discussionMentionEventToNotification(mentionEvent({ notificationId: null }));
    expect(draft).not.toHaveProperty("id");
    const pushed = getNotificationStore().push(draft);
    expect(pushed.id).toMatch(/^n_/);
  });

  it("drops a link that is not a same-origin relative path", () => {
    const draft = reviewEventToNotification(reviewEvent({ href: "https://evil.example/x" }));
    expect(draft.href).toBeUndefined();
  });
});

describe("safeInAppHref", () => {
  it.each([
    ["/reviews/1", "/reviews/1"],
    ["//evil.example", undefined],
    ["/\\evil.example", undefined],
    ["javascript:alert(1)", undefined],
    ["https://evil.example", undefined],
    ["", undefined],
    [null, undefined],
    [undefined, undefined],
  ])("%s -> %s", (input, expected) => {
    expect(safeInAppHref(input)).toBe(expected);
  });
});

describe("NotificationStore.push with a server id", () => {
  it("does not add an id that is already listed", () => {
    const store = getNotificationStore();
    store.push({ id: "same", level: "info", title: "a", message: "b" });
    store.push({ id: "same", level: "info", title: "a", message: "b" });
    expect(store.list()).toHaveLength(1);
  });

  it("hydrates a persisted review rejection as a warning", () => {
    const store = getNotificationStore();
    store.hydrate([
      {
        id: "r",
        type: "review_rejected",
        title: "Review rejected",
        message: "x",
        read: false,
        createdAt: new Date().toISOString(),
      },
    ]);
    expect(store.list()[0].level).toBe("warn");
  });
});
