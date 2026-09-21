/**
 * ApprovalsPanel tests (Epic #202 / Issue #217).
 *
 * Covers: pending approvals listed with type + item, approve/reject with an
 * optional review note, the promotion-blocked banner, the unblocked banner,
 * and the empty (render-nothing) state.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { analysisApi } = vi.hoisted(() => ({
  analysisApi: { listApprovals: vi.fn(), reviewApproval: vi.fn() },
}));

vi.mock("@/lib/analysis-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/analysis-api")>("@/lib/analysis-api");
  return { ...actual, analysisApi };
});

import { ApprovalsPanel } from "@/components/analysis/ApprovalsPanel";
import type { ApprovalRequestPayload, TicketStatus } from "@/lib/analysis-api";

function approval(over: Partial<ApprovalRequestPayload> = {}): ApprovalRequestPayload {
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

function renderPanel(
  items: ApprovalRequestPayload[],
  ticketStatus: TicketStatus,
  metadata: Record<string, unknown> | null = null,
) {
  analysisApi.listApprovals.mockResolvedValue({ items, ticketStatus });
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ApprovalsPanel projectId="proj-1" analysisId="ana-1" metadata={metadata} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ApprovalsPanel", () => {
  it("renders nothing when there are no approvals", async () => {
    const { container } = renderPanel([], {
      allowed: true,
      pendingCount: 0,
      rejectedCount: 0,
    });
    await waitFor(() => expect(analysisApi.listApprovals).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="approvals-panel"]')).toBeNull();
  });

  it("lists pending approvals with type and item", async () => {
    renderPanel([approval({ type: "evidence", itemId: "ev-9" })], {
      allowed: false,
      pendingCount: 1,
      rejectedCount: 0,
    });
    expect(await screen.findByText("Evidence")).toBeInTheDocument();
    expect(screen.getByText("ev-9")).toBeInTheDocument();
    expect(screen.getByText(/Pending \(1\)/)).toBeInTheDocument();
  });

  it("shows the promotion-blocked banner when ticketStatus is not allowed", async () => {
    renderPanel([approval()], { allowed: false, pendingCount: 1, rejectedCount: 0 });
    expect(await screen.findByRole("alert")).toHaveTextContent(/Promotion blocked/i);
    expect(screen.getByRole("alert")).toHaveTextContent(/1 pending/);
  });

  it("shows the unblocked banner once approvals are resolved", async () => {
    renderPanel([approval({ status: "approved" })], {
      allowed: true,
      pendingCount: 0,
      rejectedCount: 0,
    });
    expect(await screen.findByRole("status")).toHaveTextContent(/unblocked/i);
  });

  it("approves a pending request, sending the typed review note", async () => {
    analysisApi.reviewApproval.mockResolvedValue(approval({ status: "approved" }));
    renderPanel([approval()], { allowed: false, pendingCount: 1, rejectedCount: 0 });

    const note = await screen.findByLabelText("Review note for req-1");
    fireEvent.change(note, { target: { value: "looks good" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(analysisApi.reviewApproval).toHaveBeenCalledWith("proj-1", "ana-1", "ap-1", {
        status: "approved",
        reviewNote: "looks good",
      }),
    );
  });

  it("rejects a pending request without a note (undefined reviewNote)", async () => {
    analysisApi.reviewApproval.mockResolvedValue(approval({ status: "rejected" }));
    renderPanel([approval()], { allowed: false, pendingCount: 1, rejectedCount: 0 });

    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));

    await waitFor(() =>
      expect(analysisApi.reviewApproval).toHaveBeenCalledWith("proj-1", "ana-1", "ap-1", {
        status: "rejected",
        reviewNote: undefined,
      }),
    );
  });

  it("enriches a requirement approval with its title + ambiguity instead of a bare UUID", async () => {
    const itemId = "req-uuid-1";
    renderPanel(
      [approval({ type: "requirement", itemId })],
      {
        allowed: false,
        pendingCount: 1,
        rejectedCount: 0,
      },
      {
        structuredRequirements: {
          requirements: [
            {
              id: itemId,
              title: "Audit log retention period",
              description: "The system must retain audit logs.",
              ambiguities: [
                {
                  field: "duration",
                  description: "No retention duration is given.",
                  suggestedQuestion: "How long must audit logs be retained?",
                },
              ],
              evidenceNeeds: [],
            },
          ],
          totalAmbiguities: 1,
          totalEvidenceNeeds: 0,
        },
      },
    );

    expect(await screen.findByText("Audit log retention period")).toBeInTheDocument();
    expect(screen.getByText("How long must audit logs be retained?")).toBeInTheDocument();
  });

  it("falls back to the itemId when no structured requirement matches", async () => {
    renderPanel(
      [approval({ type: "requirement", itemId: "unmatched-uuid" })],
      {
        allowed: false,
        pendingCount: 1,
        rejectedCount: 0,
      },
      {
        structuredRequirements: {
          requirements: [],
          totalAmbiguities: 0,
          totalEvidenceNeeds: 0,
        },
      },
    );
    expect(await screen.findByText("unmatched-uuid")).toBeInTheDocument();
  });

  it("separates resolved approvals into their own section and shows the note", async () => {
    renderPanel(
      [
        approval({ id: "ap-1", status: "pending", itemId: "p-1" }),
        approval({ id: "ap-2", status: "approved", itemId: "r-2", reviewNote: "ok" }),
      ],
      { allowed: false, pendingCount: 1, rejectedCount: 0 },
    );
    expect(await screen.findByText(/Resolved \(1\)/)).toBeInTheDocument();
    expect(screen.getByText("Note: ok")).toBeInTheDocument();
  });
});
