/**
 * Issue #1104 finding B — a gated run must SAY it is gated, and the approval UI
 * must stay reachable while approvals are pending.
 *
 * Live symptom: a run reported "completed", the REQUIREMENTS section read "No
 * requirements yet.", and there was no visible route to the 13 pending approval
 * requests that were withholding them — the walkthrough had to call
 * `PUT .../approvals/:id` by hand.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { analysisApi } = vi.hoisted(() => ({
  analysisApi: { listApprovals: vi.fn(), reviewApproval: vi.fn() },
}));

vi.mock("@/lib/analysis-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/analysis-api")>("@/lib/analysis-api");
  return { ...actual, analysisApi };
});

import { ApprovalsPanel } from "@/components/analysis/ApprovalsPanel";
import { RequirementsEmptyState } from "@/components/analysis/RequirementsEmptyState";
import type { ApprovalRequestPayload } from "@/lib/analysis-api";

const GATED_METADATA = {
  promotionStatus: "blocked",
  promotionBlocked: {
    blocked: true,
    pendingCount: 13,
    rejectedCount: 0,
    awaitingRequirementCount: 14,
    reason: "Promotion blocked: 14 requirement(s) awaiting approval.",
  },
};

function pendingApproval(over: Partial<ApprovalRequestPayload> = {}): ApprovalRequestPayload {
  return {
    id: "ap-1",
    analysisId: "ana-1",
    type: "requirement",
    itemId: "req-1",
    status: "pending",
    reviewerId: null,
    reviewNote: null,
    createdAt: new Date().toISOString(),
    reviewedAt: null,
    ...over,
  };
}

function withClient(node: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("#1104 B — the empty requirements list explains the gate", () => {
  it("says how many requirements are awaiting approval instead of 'No requirements yet'", () => {
    render(<RequirementsEmptyState metadata={GATED_METADATA} />);

    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent(/14 requirement\(s\) awaiting approval/i);
    expect(screen.queryByText("No requirements yet.")).not.toBeInTheDocument();
  });

  it("links to the approvals section so the gate is one click away", () => {
    render(<RequirementsEmptyState metadata={GATED_METADATA} />);

    const link = screen.getByRole("link", { name: /approval/i });
    expect(link).toHaveAttribute("href", "#approvals");
  });

  it("names only the pending approvals as outstanding — never the rejected ones (#723)", () => {
    render(
      <RequirementsEmptyState
        metadata={{
          promotionBlocked: { blocked: true, pendingCount: 3, rejectedCount: 2 },
        }}
      />,
    );

    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent(/awaiting approval/i);
    expect(notice).toHaveTextContent("3 pending approval(s) must be resolved.");
    expect(notice).not.toHaveTextContent(/rejected/i);
  });

  // #723 — a record written before rejections counted as resolved: no pending
  // approval is left, so there is nothing to resolve; point at Promote.
  it("points a legacy record with no pending approval at the Promote action", () => {
    render(
      <RequirementsEmptyState
        metadata={{
          promotionBlocked: {
            blocked: true,
            pendingCount: 0,
            rejectedCount: 1,
            awaitingRequirementCount: 32,
          },
        }}
      />,
    );

    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent(
      "All approvals are resolved, but the 32 requirement(s) have not been promoted yet.",
    );
    expect(notice).toHaveTextContent(/Promote the approved requirements/);
    expect(notice).not.toHaveTextContent(/rejected|must be resolved/i);
    expect(screen.getByRole("link", { name: "Go to approvals" })).toHaveAttribute(
      "href",
      "#approvals",
    );
  });

  it("follows the live gate over stale recorded counts", () => {
    const { rerender } = render(
      <RequirementsEmptyState
        metadata={GATED_METADATA}
        ticketStatus={{ allowed: true, pendingCount: 0, rejectedCount: 1 }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/Promote the approved requirements/);
    expect(screen.getByRole("alert")).not.toHaveTextContent(/must be resolved/);

    rerender(
      <RequirementsEmptyState
        metadata={GATED_METADATA}
        ticketStatus={{ allowed: false, pendingCount: 4, rejectedCount: 0 }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("4 pending approval(s) must be resolved.");
  });

  it("names the generic remedy when the pending count is unknown", () => {
    render(
      <RequirementsEmptyState
        metadata={GATED_METADATA}
        ticketStatus={{ allowed: false, pendingCount: 0, rejectedCount: 0 }}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/Resolve the pending approvals/i);
  });

  it("falls back to the plain empty state when nothing is gated", () => {
    render(<RequirementsEmptyState metadata={{ promotionStatus: "allowed" }} />);
    expect(screen.getByText("No requirements yet.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("falls back to the plain empty state when there is no metadata at all", () => {
    render(<RequirementsEmptyState metadata={null} />);
    expect(screen.getByText("No requirements yet.")).toBeInTheDocument();
  });
});

describe("#1104 B — the approval UI stays reachable", () => {
  it("surfaces a load failure instead of silently rendering nothing", async () => {
    analysisApi.listApprovals.mockRejectedValue(new Error("boom"));

    withClient(<ApprovalsPanel projectId="proj-1" analysisId="ana-1" metadata={GATED_METADATA} />);

    // Rendering nothing on error is what left the reviewer with no way through.
    const alert = await screen.findByTestId("approvals-error");
    expect(alert).toHaveTextContent(/approvals/i);
  });

  it("names the withheld requirement count on the blocked banner", async () => {
    analysisApi.listApprovals.mockResolvedValue({
      items: [pendingApproval()],
      ticketStatus: { allowed: false, pendingCount: 13, rejectedCount: 0 },
    });

    withClient(<ApprovalsPanel projectId="proj-1" analysisId="ana-1" metadata={GATED_METADATA} />);

    await waitFor(() => expect(screen.getByTestId("approvals-panel")).toBeInTheDocument());
    const banner = screen.getByTestId("promotion-banner");
    expect(banner).toHaveTextContent(/14 requirement\(s\)/i);
    expect(banner).toHaveTextContent(/13 pending/i);
  });

  it("anchors the panel so the requirements notice can link to it", async () => {
    analysisApi.listApprovals.mockResolvedValue({
      items: [pendingApproval()],
      ticketStatus: { allowed: false, pendingCount: 1, rejectedCount: 0 },
    });

    withClient(<ApprovalsPanel projectId="proj-1" analysisId="ana-1" metadata={GATED_METADATA} />);

    const panel = await screen.findByTestId("approvals-panel");
    expect(panel).toHaveAttribute("id", "approvals");
  });
});
