/**
 * #642 — the Scheduler page, the ApprovalsPanel and PresenceAvatars re-join
 * their rooms after a disconnect + reconnect, and live updates resume on the
 * same socket.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { followedRooms } from "@/lib/socket-subscription";
import { analysisRoom, presenceRoom } from "@metis/shared";
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
    // #646 — the reconnect itself refetches once.
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    act(() => socket.fire("scheduler:status", {}));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));

    unmount();
    act(() => socket.reconnect());
    expect(socket.emitted("subscribe:scheduler")).toBe(2);
  });
});

describe("ApprovalsPanel (#642, #648)", () => {
  it("re-joins the analysis room on reconnect and keeps surfacing promotion blocks", async () => {
    const { unmount } = renderWithClient(<ApprovalsPanel projectId="proj-1" analysisId="ana-1" />);
    await waitFor(() => expect(screen.getByTestId("approvals-panel")).toBeInTheDocument());
    const room = { analysisId: "ana-1" };
    // #648 — the panel re-renders as its query settles; with `onBlocked` held in
    // a ref those re-renders must not re-run the subscription effect.
    expect(socket.emitted("subscribe:analysis", room)).toBe(1);
    expect(socket.emitted("unsubscribe:analysis", room)).toBe(0);
    // #672 — counted under the server's room name, not a hand-typed key.
    expect(followedRooms(socket as never)).toEqual(new Map([[analysisRoom("ana-1"), 1]]));

    act(() => socket.reconnect());
    expect(socket.emitted("subscribe:analysis", room)).toBe(2);
    expect(socket.emitted("unsubscribe:analysis", room)).toBe(0);
    // #646 — the reconnect itself re-reads the approvals once.
    await waitFor(() => expect(listApprovals).toHaveBeenCalledTimes(2));

    const fetchesBefore = listApprovals.mock.calls.length;
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
    // The ref-held callback still runs: the event refetches the approvals.
    await waitFor(() => expect(listApprovals.mock.calls.length).toBe(fetchesBefore + 1));
    // ...and the refetch-driven re-renders did not churn the room either.
    expect(socket.emitted("subscribe:analysis", room)).toBe(2);
    expect(socket.emitted("unsubscribe:analysis", room)).toBe(0);

    unmount();
    expect(socket.emitted("unsubscribe:analysis", room)).toBe(1);
    act(() => socket.reconnect());
    expect(socket.emitted("subscribe:analysis", room)).toBe(2);
  });

  it("does not re-subscribe when the parent re-renders the panel", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (metadata: Record<string, unknown>) => (
      <QueryClientProvider client={qc}>
        <ApprovalsPanel projectId="proj-1" analysisId="ana-1" metadata={metadata} />
      </QueryClientProvider>
    );
    const { rerender } = render(tree({ a: 1 }));
    await waitFor(() => expect(screen.getByTestId("approvals-panel")).toBeInTheDocument());
    rerender(tree({ a: 2 }));
    rerender(tree({ a: 3 }));
    const room = { analysisId: "ana-1" };
    expect(socket.emitted("subscribe:analysis", room)).toBe(1);
    expect(socket.emitted("unsubscribe:analysis", room)).toBe(0);
    expect(socket.listeners("analysis:promotion-blocked")).toBe(1);
  });
});

describe("PresenceAvatars (#642)", () => {
  it("re-joins the presence room on reconnect and keeps rendering presence updates", () => {
    const { unmount } = render(<PresenceAvatars artifactType="discussion" artifactId="d1" />);
    const room = { artifactType: "discussion", artifactId: "d1" };
    expect(socket.emitted("presence:join", room)).toBe(1);
    // #672 — counted under the server's room name, not a hand-typed key.
    expect(followedRooms(socket as never)).toEqual(
      new Map([[presenceRoom("discussion", "d1"), 1]]),
    );

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

describe("missed events are reconciled after a reconnect (#646)", () => {
  it("SchedulerPage shows a job change made while the socket was down", async () => {
    list.mockResolvedValue([]);
    renderWithClient(<SchedulerPage />);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    act(() => socket.disconnect());
    // The `scheduler:status` for this change is emitted now — and lost.
    list.mockResolvedValue([{ id: "j1", name: "Nightly gap job" }]);
    act(() => socket.connect());

    expect(await screen.findByText("Nightly gap job")).toBeInTheDocument();
  });

  it("ApprovalsPanel shows a promotion block made while the socket was down", async () => {
    listApprovals.mockResolvedValue({
      items: [],
      ticketStatus: { allowed: true, pendingCount: 0, rejectedCount: 0 },
    });
    renderWithClient(<ApprovalsPanel projectId="proj-1" analysisId="ana-1" />);
    await waitFor(() => expect(listApprovals).toHaveBeenCalledTimes(1));

    act(() => socket.disconnect());
    // The `analysis:promotion-blocked` is emitted now — and lost.
    listApprovals.mockResolvedValue({
      items: [{ id: "ap-1", type: "requirement", itemId: "r1", status: "pending" }],
      ticketStatus: { allowed: false, pendingCount: 1, rejectedCount: 0 },
    });

    expect(screen.queryByTestId("approvals-panel")).not.toBeInTheDocument();
    act(() => socket.connect());

    expect(await screen.findByTestId("approvals-panel")).toBeInTheDocument();
  });
});
