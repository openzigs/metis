/**
 * #642 — the Scheduler page, the ApprovalsPanel and PresenceAvatars re-join
 * their rooms after a disconnect + reconnect, and live updates resume on the
 * same socket.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createFakeSocket, type FakeSocket } from "./helpers/fake-socket";

let socket: FakeSocket;
vi.mock("@/lib/socket-client", () => ({ useSocket: () => socket }));

const list = vi.fn();
vi.mock("@/lib/scheduler-api", () => ({
  schedulerApi: {
    list: () => list(),
    handlers: vi.fn().mockResolvedValue([]),
    history: vi.fn().mockResolvedValue([]),
  },
}));

const listApprovals = vi.fn();
vi.mock("@/lib/analysis-api", () => ({
  analysisApi: {
    listApprovals: (...args: unknown[]) => listApprovals(...args),
    reviewApproval: vi.fn(),
  },
  readEnhancementMetadata: (metadata: Record<string, unknown> | null | undefined) =>
    metadata && typeof metadata === "object" ? metadata : {},
}));

import SchedulerPage from "@/app/(authed)/scheduler/page";
import { ApprovalsPanel } from "@/components/analysis/ApprovalsPanel";
import { PresenceAvatars } from "@/components/presence/PresenceAvatars";

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  socket = createFakeSocket();
  list.mockReset();
  list.mockResolvedValue([]);
  listApprovals.mockReset();
  listApprovals.mockResolvedValue({
    items: [{ id: "ap-1", type: "requirement", itemId: "r1", status: "pending" }],
    ticketStatus: { allowed: false, pendingCount: 1, rejectedCount: 0 },
  });
});

describe("SchedulerPage (#642)", () => {
  it("re-joins the scheduler room on reconnect and keeps refetching on scheduler events", async () => {
    const { unmount } = renderWithClient(<SchedulerPage />);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    expect(socket.emitted("subscribe:scheduler")).toBe(1);

    act(() => socket.reconnect());
    expect(socket.emitted("subscribe:scheduler")).toBe(2);

    act(() => socket.fire("scheduler:status", {}));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    unmount();
    act(() => socket.reconnect());
    expect(socket.emitted("subscribe:scheduler")).toBe(2);
  });
});

describe("ApprovalsPanel (#642)", () => {
  it("re-joins the analysis room on reconnect and keeps surfacing promotion blocks", async () => {
    const { unmount } = renderWithClient(<ApprovalsPanel projectId="proj-1" analysisId="ana-1" />);
    await waitFor(() => expect(screen.getByTestId("approvals-panel")).toBeInTheDocument());
    const room = { analysisId: "ana-1" };
    // The effect may re-run while the panel settles (its callback dep changes),
    // so count relative to the state just before the drop.
    const before = socket.emitted("subscribe:analysis", room);
    expect(before).toBeGreaterThan(0);

    act(() => socket.reconnect());
    expect(socket.emitted("subscribe:analysis", room)).toBe(before + 1);

    act(() =>
      socket.fire("analysis:promotion-blocked", {
        analysisId: "ana-1",
        pendingCount: 1,
        rejectedCount: 0,
        reason: "Blocked after reconnect",
        ts: 0,
      }),
    );
    expect(await screen.findByTestId("promotion-blocked-live")).toHaveTextContent(
      "Blocked after reconnect",
    );

    const subscribed = socket.emitted("subscribe:analysis", room);
    unmount();
    expect(socket.emitted("unsubscribe:analysis", room)).toBeGreaterThan(0);
    act(() => socket.reconnect());
    expect(socket.emitted("subscribe:analysis", room)).toBe(subscribed);
  });
});

describe("PresenceAvatars (#642)", () => {
  it("re-joins the presence room on reconnect and keeps rendering presence updates", () => {
    const { unmount } = render(<PresenceAvatars artifactType="discussion" artifactId="d1" />);
    const room = { artifactType: "discussion", artifactId: "d1" };
    expect(socket.emitted("presence:join", room)).toBe(1);

    // The server's disconnect handler dropped this socket from the room's
    // presence list, so without a re-join the user vanishes for everyone else.
    act(() => socket.reconnect());
    expect(socket.emitted("presence:join", room)).toBe(2);

    act(() =>
      socket.fire("presence:update", {
        room: "presence:discussion:d1",
        users: [{ userId: "u1", username: "alice" }],
        ts: 0,
      }),
    );
    expect(screen.getByLabelText("1 user(s) viewing")).toBeInTheDocument();

    unmount();
    expect(socket.emitted("presence:leave", room)).toBe(1);
    act(() => socket.reconnect());
    expect(socket.emitted("presence:join", room)).toBe(2);
  });
});
