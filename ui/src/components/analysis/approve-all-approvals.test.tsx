/**
 * Issue #939 — approving 37 items needed 37 clicks (the walkthrough scripted a
 * loop). The Approvals panel now offers one "Approve all pending" action, behind
 * a confirmation because an approval cannot be reopened.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ApprovalRequestPayload } from "@/lib/analysis-api";
import { queryKeys } from "@/lib/query-keys";

const listApprovals = vi.fn();
const approveAllApprovals = vi.fn();

vi.mock("@/lib/socket-client", () => ({ useSocket: () => null }));
vi.mock("@/lib/analysis-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analysis-api")>();
  return {
    ...actual,
    analysisApi: {
      ...actual.analysisApi,
      listApprovals: (...args: unknown[]) => listApprovals(...args),
      approveAllApprovals: (...args: unknown[]) => approveAllApprovals(...args),
    },
  };
});

const { ApprovalsPanel } = await import("@/components/analysis/ApprovalsPanel");

const ANALYSIS_ID = "an_939";

const approval = (id: string, status = "pending"): ApprovalRequestPayload => ({
  id,
  analysisId: ANALYSIS_ID,
  type: "requirement",
  itemId: id,
  status: status as ApprovalRequestPayload["status"],
  reviewerId: null,
  reviewNote: null,
  createdAt: "2026-10-08T00:00:00.000Z",
  reviewedAt: null,
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
    items: [approval("ap_1"), approval("ap_2"), approval("ap_3", "rejected")],
    ticketStatus: { allowed: false, pendingCount: 2, rejectedCount: 1 },
  });
  approveAllApprovals.mockResolvedValue({
    approvedCount: 2,
    promotion: { status: "promoted", requirementCount: 2 },
  });
});

describe("#939 — Approve all pending", () => {
  it("approves nothing until the reviewer confirms", async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Approve all 2 pending" }));

    expect(approveAllApprovals).not.toHaveBeenCalled();
    expect(screen.getByText(/Approve all 2 pending approvals\?/)).toBeInTheDocument();
  });

  it("calls the bulk endpoint once on confirm and refreshes the approvals and the analysis", async () => {
    const { invalidateSpy } = renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Approve all 2 pending" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm approve all" }));

    await waitFor(() => expect(approveAllApprovals).toHaveBeenCalledTimes(1));
    expect(approveAllApprovals).toHaveBeenCalledWith("p1", ANALYSIS_ID);
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: queryKeys.analyses.detail(ANALYSIS_ID),
      }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["approvals", ANALYSIS_ID] });
  });

  it("backs out on cancel", async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Approve all 2 pending" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(approveAllApprovals).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Approve all 2 pending" })).toBeInTheDocument();
  });

  it("says so when the bulk approval fails", async () => {
    approveAllApprovals.mockRejectedValueOnce(new Error("boom"));
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Approve all 2 pending" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm approve all" }));

    expect(await screen.findByText(/Could not approve all pending approvals/)).toBeInTheDocument();
  });

  it("is not offered when nothing is pending", async () => {
    listApprovals.mockResolvedValue({
      items: [approval("ap_1", "approved")],
      ticketStatus: { allowed: true, pendingCount: 0, rejectedCount: 0 },
    });
    renderPanel();

    await screen.findByText(/Resolved \(1\)/);
    expect(screen.queryByRole("button", { name: /Approve all/ })).not.toBeInTheDocument();
  });
});
