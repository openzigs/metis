/**
 * Issue #1129 — on a run started from ticked imported items, the Approvals
 * checkpoint separates the ticked items from those the analysis added, and the
 * added ones can be left out in one action.
 */
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ApprovalRequestPayload } from "@/lib/analysis-api";
import { queryKeys } from "@/lib/query-keys";

const listApprovals = vi.fn();
const rejectAddedApprovals = vi.fn();

vi.mock("@/lib/socket-client", () => ({ useSocket: () => null }));
vi.mock("@/lib/analysis-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analysis-api")>();
  return {
    ...actual,
    analysisApi: {
      ...actual.analysisApi,
      listApprovals: (...args: unknown[]) => listApprovals(...args),
      rejectAddedApprovals: (...args: unknown[]) => rejectAddedApprovals(...args),
      getClarification: vi.fn(async () => ({ state: null })),
    },
  };
});

const { ApprovalsPanel, splitPendingByOrigin } =
  await import("@/components/analysis/ApprovalsPanel");

const ANALYSIS_ID = "an_1129";

const approval = (
  id: string,
  origin?: "ticked" | "added",
  type = "requirement",
): ApprovalRequestPayload => ({
  id,
  analysisId: ANALYSIS_ID,
  type,
  itemId: id,
  status: "pending",
  reviewerId: null,
  reviewNote: null,
  createdAt: "2026-10-13T00:00:00.000Z",
  reviewedAt: null,
  ...(origin ? { origin } : {}),
});

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
  render(
    <QueryClientProvider client={qc}>
      <ApprovalsPanel projectId="p1" analysisId={ANALYSIS_ID} />
    </QueryClientProvider>,
  );
  return { invalidateSpy };
}

beforeEach(() => {
  vi.clearAllMocks();
  listApprovals.mockResolvedValue({
    items: [
      approval("added-1", "added"),
      approval("ticked-1", "ticked"),
      approval("added-2", "added"),
      approval("ev-1", undefined, "evidence"),
    ],
    ticketStatus: { allowed: false, pendingCount: 4, rejectedCount: 0 },
  });
  rejectAddedApprovals.mockResolvedValue({
    rejectedCount: 2,
    promotion: { status: "blocked", pendingCount: 2 },
  });
});

describe("splitPendingByOrigin", () => {
  it("is null when no approval carries an origin", () => {
    expect(splitPendingByOrigin([approval("a"), approval("b")])).toBeNull();
  });

  it("splits ticked, added and the rest", () => {
    const split = splitPendingByOrigin([
      approval("a", "added"),
      approval("t", "ticked"),
      approval("e", undefined, "evidence"),
    ]);
    expect(split?.ticked.map((a) => a.id)).toEqual(["t"]);
    expect(split?.added.map((a) => a.id)).toEqual(["a"]);
    expect(split?.other.map((a) => a.id)).toEqual(["e"]);
  });
});

describe("#1129 — ticked items apart from those added by the analysis", () => {
  it("lists the ticked items in their own group, ahead of the added ones", async () => {
    renderPanel();

    const ticked = await screen.findByTestId("approvals-ticked");
    const added = screen.getByTestId("approvals-added");
    expect(within(ticked).getByText("From your ticked items (1)")).toBeInTheDocument();
    expect(within(ticked).getByTestId("approval-ticked-1")).toBeInTheDocument();
    expect(within(added).getByText("Added by the analysis (2)")).toBeInTheDocument();
    expect(within(added).getByTestId("approval-added-1")).toBeInTheDocument();
    expect(within(added).queryByTestId("approval-ticked-1")).toBeNull();
    // The ticked group renders before the added group.
    expect(ticked.compareDocumentPosition(added) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("Other checkpoints (1)")).toBeInTheDocument();
  });

  it("leaves out every added requirement in one confirmed action", async () => {
    const { invalidateSpy } = renderPanel();

    fireEvent.click(
      await screen.findByRole("button", { name: "Leave out the 2 added by the analysis" }),
    );
    expect(rejectAddedApprovals).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm leave out added" }));

    await waitFor(() => expect(rejectAddedApprovals).toHaveBeenCalledWith("p1", ANALYSIS_ID));
    expect(rejectAddedApprovals).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: queryKeys.analyses.detail(ANALYSIS_ID),
      }),
    );
  });

  it("backs out on cancel and reports a failure", async () => {
    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: "Leave out the 2 added by the analysis" }),
    );
    fireEvent.click(within(screen.getByTestId("leave-out-added-confirm")).getByText("Cancel"));
    expect(rejectAddedApprovals).not.toHaveBeenCalled();

    rejectAddedApprovals.mockRejectedValueOnce(new Error("boom"));
    fireEvent.click(screen.getByRole("button", { name: "Leave out the 2 added by the analysis" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm leave out added" }));
    expect(
      await screen.findByText(/Could not leave out the added requirements/),
    ).toBeInTheDocument();
  });

  it("renders one list, as before, on a run with no ticked items", async () => {
    listApprovals.mockResolvedValue({
      items: [approval("a"), approval("b")],
      ticketStatus: { allowed: false, pendingCount: 2, rejectedCount: 0 },
    });
    renderPanel();

    await screen.findByText("Pending (2)");
    expect(screen.queryByTestId("approvals-ticked")).toBeNull();
    expect(screen.queryByRole("button", { name: /Leave out/ })).toBeNull();
  });
});
