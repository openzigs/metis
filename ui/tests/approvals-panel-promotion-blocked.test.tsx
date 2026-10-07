/**
 * Issue #256 — ApprovalsPanel reacts to the distinct `analysis:promotion-blocked`
 * socket event directly (subscribing to the analysis room, refetching approvals,
 * and surfacing the live blocking reason) instead of inferring the blocked state
 * from polled metadata.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PromotionBlockedEvent } from "@metis/shared";

// ---- mock the socket singleton -------------------------------------------
type Handler = (event: PromotionBlockedEvent) => void;
const handlers = new Map<string, Handler>();
const emit = vi.fn();
const fakeSocket = {
  emit,
  on: vi.fn((name: string, h: Handler) => handlers.set(name, h)),
  off: vi.fn((name: string) => handlers.delete(name)),
};
vi.mock("@/lib/socket-client", () => ({
  useSocket: () => fakeSocket,
}));

// ---- mock the approvals API ----------------------------------------------
const listApprovals = vi.fn();
vi.mock("@/lib/analysis-api", () => ({
  analysisApi: {
    listApprovals: (...args: unknown[]) => listApprovals(...args),
    reviewApproval: vi.fn(),
  },
  // ApprovalsPanel now enriches requirement approvals from analysis metadata —
  // provide the real narrowing helper so the component renders.
  readEnhancementMetadata: (metadata: Record<string, unknown> | null | undefined) =>
    metadata && typeof metadata === "object" ? metadata : {},
}));

import { ApprovalsPanel, usePromotionBlockedEvent } from "@/components/analysis/ApprovalsPanel";

function renderPanel(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ApprovalsPanel projectId="proj-1" analysisId="ana-1" />
    </QueryClientProvider>,
  );
}

/** Push a promotion-blocked event through the captured socket handler. */
function pushBlocked(event: PromotionBlockedEvent): void {
  const h = handlers.get("analysis:promotion-blocked");
  if (h) h(event);
}

beforeEach(() => {
  handlers.clear();
  emit.mockClear();
  listApprovals.mockReset();
  listApprovals.mockResolvedValue({
    items: [{ id: "ap-1", type: "requirement", itemId: "r1", status: "pending" }],
    ticketStatus: { allowed: false, pendingCount: 1, rejectedCount: 0 },
  });
});

afterEach(() => {
  cleanup();
});

describe("ApprovalsPanel — promotion-blocked socket event (#256)", () => {
  it("subscribes to the analysis room on mount", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("approvals-panel")).toBeInTheDocument());
    expect(emit).toHaveBeenCalledWith("subscribe:analysis", { analysisId: "ana-1" });
    expect(handlers.has("analysis:promotion-blocked")).toBe(true);
  });

  it("surfaces the live blocking reason from the socket event", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("approvals-panel")).toBeInTheDocument());

    pushBlocked({
      analysisId: "ana-1",
      pendingCount: 2,
      rejectedCount: 1,
      reason: "Promotion blocked: 2 pending, 1 rejected approval(s)",
      ts: Date.now(),
    });

    await waitFor(() => {
      const live = screen.getByTestId("promotion-blocked-live");
      expect(live).toHaveTextContent("Promotion blocked: 2 pending, 1 rejected approval(s)");
    });
  });

  it("ignores events for a different analysis id", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("approvals-panel")).toBeInTheDocument());

    pushBlocked({
      analysisId: "some-other-analysis",
      pendingCount: 9,
      rejectedCount: 9,
      reason: "Not my analysis",
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("promotion-blocked-live")).not.toBeInTheDocument();
  });

  // #661 — the `event.analysisId !== analysisId` filter is the only guard that
  // stops another run's event from setting this panel's banner AND refetching
  // its approvals. Pin both effects in one test, after a settle window long
  // enough for a stray refetch to have reached the API.
  it("an event for another analysis sets no banner and triggers no refetch (#661)", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("approvals-panel")).toBeInTheDocument());
    expect(listApprovals).toHaveBeenCalledTimes(1);

    pushBlocked({
      analysisId: "ana-2",
      pendingCount: 3,
      rejectedCount: 0,
      reason: "Promotion blocked: another analysis",
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("promotion-blocked-live")).not.toBeInTheDocument();
    expect(screen.queryByText("Promotion blocked: another analysis")).not.toBeInTheDocument();
    expect(listApprovals).toHaveBeenCalledTimes(1);

    // Positive control: the same subscription does react to this panel's own
    // analysis, so the negative assertions above cannot pass vacuously.
    pushBlocked({
      analysisId: "ana-1",
      pendingCount: 1,
      rejectedCount: 0,
      reason: "Promotion blocked: this analysis",
      ts: Date.now(),
    });
    await waitFor(() => expect(screen.getByTestId("promotion-blocked-live")).toBeInTheDocument());
    await waitFor(() => expect(listApprovals).toHaveBeenCalledTimes(2));
  });
});

// #661 — pin the #648 latest-callback ref refresh. The panel itself passes a
// stable `query.refetch`, so only a probe that swaps `onBlocked` between renders
// can observe whether the newest callback is the one that runs.
describe("usePromotionBlockedEvent — latest onBlocked (#648 / #661)", () => {
  function Probe({ onBlocked }: { onBlocked: () => void }): React.ReactElement {
    const blocked = usePromotionBlockedEvent("ana-1", onBlocked);
    return <span data-testid="probe">{blocked?.reason ?? "none"}</span>;
  }

  it("runs the newest onBlocked after a re-render, not the first one", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Probe onBlocked={first} />);
    rerender(<Probe onBlocked={second} />);

    act(() => {
      pushBlocked({
        analysisId: "ana-1",
        pendingCount: 1,
        rejectedCount: 0,
        reason: "blocked now",
        ts: Date.now(),
      });
    });

    expect(screen.getByTestId("probe")).toHaveTextContent("blocked now");
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    // The swap must not cost a resubscribe (#648's original defect).
    expect(emit.mock.calls.filter(([name]) => name === "subscribe:analysis")).toHaveLength(1);
  });
});
