/**
 * #1447 — the drawer shows a redacted notification as its neutral title alone:
 * no empty message line, no link. The real store runs; only the socket and the
 * API are stand-ins.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
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
import { _resetNotificationStoreForTests } from "@/lib/notifications";

beforeEach(() => {
  vi.clearAllMocks();
  _resetNotificationStoreForTests();
  socket = createFakeSocket();
  const now = Date.now();
  mockApiFetch.mockResolvedValue({
    notifications: [
      {
        id: "n-gone",
        type: "unavailable",
        title: "Notification unavailable",
        message: "",
        href: null,
        read: false,
        createdAt: new Date(now).toISOString(),
        redacted: true,
      },
      {
        id: "n-open",
        type: "mention",
        title: "Alex mentioned you",
        message: "“hello”",
        href: "/projects/p-1/analysis",
        read: false,
        createdAt: new Date(now - 1000).toISOString(),
        redacted: false,
      },
    ],
    unreadCount: 2,
  });
});

describe("NotificationsDrawer — redacted rows (#1447)", () => {
  it("renders a redacted row as its title alone, and a normal row in full", async () => {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <NotificationsDrawer />
      </Wrapper>,
    );
    fireEvent.click(screen.getByTestId("notifications-bell"));
    const gone = await screen.findByTestId("notification-n-gone");
    const open = screen.getByTestId("notification-n-open");

    expect(within(gone).getByText("Notification unavailable")).toBeInTheDocument();
    // Title only: no empty message paragraph, no link.
    expect(gone.querySelectorAll("p")).toHaveLength(1);
    expect(within(gone).queryByRole("link")).toBeNull();

    // Control: a normal row keeps its message line and its link.
    expect(open.querySelectorAll("p")).toHaveLength(2);
    expect(within(open).getByRole("link", { name: /open/i })).toHaveAttribute(
      "href",
      "/projects/p-1/analysis",
    );
  });
});
