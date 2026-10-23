/**
 * #1318 — a live `comment:mention` says who mentioned you and where, quotes
 * the comment, links to the comment's thread, and merges with its saved copy.
 * It used to read "You were mentioned in comment <id>" and link to
 * `/comments/<id>`, which has no page.
 *
 * The real store and mappers run; only the socket and the API are stand-ins.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { CommentMentionEvent } from "@metis/shared";
import { makeWrapper } from "./test-utils";
import { createFakeSocket, type FakeSocket } from "./helpers/fake-socket";

let socket: FakeSocket;
vi.mock("@/lib/socket-client", () => ({
  closeSocket: vi.fn(),
  useSocket: () => socket,
}));

const mockApiFetch = vi.fn();
vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch: (...args: unknown[]) => mockApiFetch(...args) };
});

import { NotificationsDrawer } from "@/components/notifications/notifications-drawer";
import {
  _resetNotificationStoreForTests,
  getNotificationStore,
  mentionEventToNotification,
} from "@/lib/notifications";

const THREAD_HREF = "/projects/p-1/analysis?analysisId=a-1&requirementId=req-1&comments=1";

function commentMention(over: Partial<CommentMentionEvent> = {}): CommentMentionEvent {
  return {
    kind: "mention",
    commentId: "c-1",
    mentionedUserId: "u-1",
    ts: 1,
    notificationId: "n-comment",
    title: 'Alex mentioned you on "Login lockout"',
    message: "“@bob can you check the lockout threshold?”",
    href: THREAD_HREF,
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

describe("NotificationsDrawer — live comment mention (#1318)", () => {
  it("shows who mentioned you, where, an excerpt, and links to the thread", async () => {
    renderDrawer();
    act(() => socket.fire("comment:mention", commentMention()));

    expect(screen.getByTestId("notifications-badge")).toHaveTextContent("1");
    fireEvent.click(screen.getByTestId("notifications-bell"));
    await screen.findByTestId("notifications-drawer");

    expect(screen.getByText('Alex mentioned you on "Login lockout"')).toBeInTheDocument();
    expect(screen.getByText("“@bob can you check the lockout threshold?”")).toBeInTheDocument();
    expect(screen.queryByText(/mentioned in comment c-1/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open/i })).toHaveAttribute("href", THREAD_HREF);
  });

  it("lists the live item once when the history re-read returns the saved row", () => {
    renderDrawer();
    act(() => socket.fire("comment:mention", commentMention()));
    act(() =>
      getNotificationStore().hydrate([
        {
          id: "n-comment",
          type: "mention",
          title: 'Alex mentioned you on "Login lockout"',
          message: "“@bob can you check the lockout threshold?”",
          href: THREAD_HREF,
          read: false,
          createdAt: new Date().toISOString(),
        },
      ]),
    );

    expect(getNotificationStore().list()).toHaveLength(1);
  });
});

describe("mentionEventToNotification (#1318)", () => {
  it("keeps the saved row's id, text and link", () => {
    expect(mentionEventToNotification(commentMention())).toEqual({
      id: "n-comment",
      level: "info",
      source: "mention",
      title: 'Alex mentioned you on "Login lockout"',
      message: "“@bob can you check the lockout threshold?”",
      href: THREAD_HREF,
    });
  });

  it("links a Spec Kit artifact comment to the artifact", () => {
    const draft = mentionEventToNotification(
      commentMention({ href: "/projects/p-2/spec-kit?artifact=plan.md" }),
    );
    expect(draft.href).toBe("/projects/p-2/spec-kit?artifact=plan.md");
  });

  it("drops a link that does not pass safeInAppHref", () => {
    for (const href of ["//evil.example", "https://evil.example/x", "javascript:alert(1)"]) {
      expect(mentionEventToNotification(commentMention({ href })).href).toBeUndefined();
    }
  });

  it("leaves the id to the store when the server could not save the row", () => {
    const draft = mentionEventToNotification(commentMention({ notificationId: null }));
    expect(draft).not.toHaveProperty("id");
  });
});
