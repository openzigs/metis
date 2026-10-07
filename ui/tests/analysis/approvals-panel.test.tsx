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
  analysisApi: { listApprovals: vi.fn(), reviewApproval: vi.fn(), reopenApproval: vi.fn() },
}));

vi.mock("@/lib/analysis-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/analysis-api")>("@/lib/analysis-api");
  return { ...actual, analysisApi };
});

import { ApprovalsPanel, approvalItemName } from "@/components/analysis/ApprovalsPanel";
import { ApiError } from "@/lib/api-client";
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

    const note = await screen.findByLabelText("Review note for requirement item 1");
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

  // Issue #403 — a structured requirement stored without an `ambiguities` array
  // (#382) must still render its title, with no open-questions list.
  it.each([
    ["missing", undefined],
    ["null", null],
  ])("renders a requirement whose ambiguities are %s", async (_label, ambiguities) => {
    const itemId = "req-legacy";
    renderPanel(
      [approval({ type: "requirement", itemId })],
      { allowed: false, pendingCount: 1, rejectedCount: 0 },
      {
        structuredRequirements: {
          requirements: [
            {
              id: itemId,
              title: "Legacy requirement",
              description: "Stored before ambiguities were extracted.",
              ambiguities,
              evidenceNeeds: [],
            },
          ],
          totalAmbiguities: 0,
          totalEvidenceNeeds: 0,
        },
      },
    );

    expect(await screen.findByText("Legacy requirement")).toBeInTheDocument();
    expect(screen.getByText("Stored before ambiguities were extracted.")).toBeInTheDocument();
    expect(screen.queryByText(/Open questions/)).not.toBeInTheDocument();
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

  // Issue #364 — accessible names announced the raw item UUID.
  it("names review-note boxes by requirement title or type + position, never the item id", async () => {
    renderPanel(
      [
        approval({ id: "ap-1", type: "requirement", itemId: "fee9ca97-uuid" }),
        approval({ id: "ap-2", type: "evidence", itemId: "ev-uuid-a" }),
        approval({ id: "ap-3", type: "evidence", itemId: "ev-uuid-b" }),
      ],
      { allowed: false, pendingCount: 3, rejectedCount: 0 },
      {
        structuredRequirements: {
          requirements: [
            {
              id: "fee9ca97-uuid",
              title: "Audit log retention",
              description: "",
              ambiguities: [],
              evidenceNeeds: [],
            },
          ],
          totalAmbiguities: 0,
          totalEvidenceNeeds: 0,
        },
      },
    );
    expect(await screen.findByLabelText("Review note for Audit log retention")).toBeInTheDocument();
    expect(screen.getByLabelText("Review note for evidence item 2")).toBeInTheDocument();
    expect(screen.getByLabelText("Review note for evidence item 3")).toBeInTheDocument();
    expect(screen.queryByLabelText(/uuid/)).not.toBeInTheDocument();
  });

  it("approvalItemName falls back to the raw type when it has no label", () => {
    expect(approvalItemName({ type: "custom" }, 4)).toBe("custom item 4");
    expect(approvalItemName({ type: "requirement" }, 1, { title: "" })).toBe("requirement item 1");
  });

  // Issue #364 — the Approve button stayed clickable after the decision was
  // recorded, and a second click returned 409 APPROVAL_ALREADY_REVIEWED.
  it("disables Approve and Reject once the decision has been recorded", async () => {
    analysisApi.reviewApproval.mockResolvedValue(approval({ status: "approved" }));
    // The refetch still returns the stale pending row, as a slow refetch would.
    renderPanel([approval()], { allowed: false, pendingCount: 1, rejectedCount: 0 });

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(analysisApi.reviewApproval).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(analysisApi.reviewApproval).toHaveBeenCalledTimes(1);
  });

  it("treats a 409 APPROVAL_ALREADY_REVIEWED as resolved: says so and refetches", async () => {
    analysisApi.reviewApproval.mockRejectedValue(
      new ApiError(409, "Approval already reviewed", "APPROVAL_ALREADY_REVIEWED"),
    );
    renderPanel([approval()], { allowed: false, pendingCount: 1, rejectedCount: 0 });

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/already reviewed — refreshing/)).toBeInTheDocument();
    await waitFor(() => expect(analysisApi.listApprovals).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  });

  it("shows any other review failure and leaves the buttons usable", async () => {
    analysisApi.reviewApproval.mockRejectedValue(new ApiError(500, "Database unavailable"));
    renderPanel([approval()], { allowed: false, pendingCount: 1, rejectedCount: 0 });

    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    expect(await screen.findByText("Database unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(analysisApi.listApprovals).toHaveBeenCalledTimes(1);
  });

  it("falls back to a generic message for a non-API failure", async () => {
    analysisApi.reviewApproval.mockRejectedValue(new Error("network"));
    renderPanel([approval()], { allowed: false, pendingCount: 1, rejectedCount: 0 });

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/Could not record the review/)).toBeInTheDocument();
  });

  // Issue #723 — a rejection used to be final and dead-ended the run.
  describe("rejected approvals (#723)", () => {
    it("treats a rejection as resolved: unblocked banner names what was left out", async () => {
      renderPanel(
        [
          approval({ id: "ap-1", status: "rejected" }),
          approval({ id: "ap-2", status: "approved", itemId: "req-2" }),
        ],
        { allowed: true, pendingCount: 0, rejectedCount: 1 },
      );
      const banner = await screen.findByTestId("promotion-banner");
      expect(banner).toHaveTextContent(/unblocked/i);
      expect(banner).toHaveTextContent("1 rejected requirement(s) were left out");
      expect(banner).not.toHaveTextContent("evidence");
    });

    it("never says a rejected evidence or clarification item was left out", async () => {
      renderPanel(
        [
          approval({ id: "ap-1", type: "evidence", itemId: "ev-1", status: "rejected" }),
          approval({ id: "ap-2", type: "clarification", itemId: "cl-1", status: "rejected" }),
          approval({ id: "ap-3", status: "approved", itemId: "req-2" }),
        ],
        { allowed: true, pendingCount: 0, rejectedCount: 2 },
      );
      const banner = await screen.findByTestId("promotion-banner");
      expect(banner).toHaveTextContent(/unblocked/i);
      expect(banner).not.toHaveTextContent("left out");
      expect(banner).toHaveTextContent(
        "2 rejected evidence or clarification item(s) were recorded; they do not change which requirements are promoted.",
      );
    });

    it("names each kind of rejection separately when both occur", async () => {
      renderPanel(
        [
          approval({ id: "ap-1", status: "rejected" }),
          approval({ id: "ap-2", type: "evidence", itemId: "ev-1", status: "rejected" }),
        ],
        { allowed: true, pendingCount: 0, rejectedCount: 2 },
      );
      const banner = await screen.findByTestId("promotion-banner");
      expect(banner).toHaveTextContent("1 rejected requirement(s) were left out");
      expect(banner).toHaveTextContent(
        "1 rejected evidence or clarification item(s) were recorded",
      );
    });

    it("never lists rejections as outstanding in the blocked banner", async () => {
      renderPanel(
        [approval({ id: "ap-1", status: "rejected" }), approval({ id: "ap-2", itemId: "req-2" })],
        { allowed: false, pendingCount: 1, rejectedCount: 1 },
      );
      const banner = await screen.findByTestId("promotion-banner");
      expect(banner).toHaveTextContent("1 pending approval(s) must be resolved");
      expect(banner).not.toHaveTextContent("rejected");
    });

    it("offers Reopen on a rejected approval and calls the reopen endpoint", async () => {
      analysisApi.reopenApproval.mockResolvedValue(approval({ status: "pending" }));
      renderPanel([approval({ id: "ap-1", status: "rejected" })], {
        allowed: true,
        pendingCount: 0,
        rejectedCount: 1,
      });

      const reopen = await screen.findByRole("button", { name: "Reopen requirement item 1" });
      fireEvent.click(reopen);

      await waitFor(() =>
        expect(analysisApi.reopenApproval).toHaveBeenCalledWith("proj-1", "ana-1", "ap-1"),
      );
      // The card moves back to Pending only once the list is re-read.
      await waitFor(() => expect(analysisApi.listApprovals.mock.calls.length).toBeGreaterThan(1));
    });

    it("does not offer Reopen on an approved approval", async () => {
      renderPanel([approval({ id: "ap-1", status: "approved" })], {
        allowed: true,
        pendingCount: 0,
        rejectedCount: 0,
      });
      await screen.findByTestId("promotion-banner");
      expect(screen.queryByRole("button", { name: /Reopen/ })).not.toBeInTheDocument();
    });

    it("shows a reopen failure", async () => {
      analysisApi.reopenApproval.mockRejectedValue(new ApiError(409, "only a rejected approval"));
      renderPanel([approval({ id: "ap-1", status: "rejected" })], {
        allowed: true,
        pendingCount: 0,
        rejectedCount: 1,
      });
      fireEvent.click(await screen.findByRole("button", { name: /Reopen/ }));
      expect(await screen.findByText("only a rejected approval")).toBeInTheDocument();
    });
  });
});
