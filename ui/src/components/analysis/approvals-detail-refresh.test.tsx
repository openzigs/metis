/**
 * Issue #1135 (second staleness case) — resolving an approval promotes the
 * requirements, and the server applies the clarification answers to the rows it
 * has just created (routes/analysis.ts → `promoteApprovedRequirements` →
 * `applyClarificationsToRequirements`). That rewrites the analysis metadata that
 * `ClarificationImpactNote` reads, so the note's wording changes from "could not
 * be matched to a saved requirement" to "written into the saved requirements".
 *
 * The panel only invalidated the approvals list, so that new wording appeared
 * only after a page reload.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ApprovalRequestPayload } from "@/lib/analysis-api";

const listApprovals = vi.fn();
const reviewApproval = vi.fn();

/** Handlers the panel registers on the analysis socket, keyed by event name. */
const socketHandlers = new Map<string, (payload: unknown) => void>();
const socketMock = {
  emit: vi.fn(),
  on: vi.fn((event: string, handler: (payload: unknown) => void) => {
    socketHandlers.set(event, handler);
  }),
  off: vi.fn((event: string) => {
    socketHandlers.delete(event);
  }),
};
let socketAvailable = true;

vi.mock("@/lib/socket-client", () => ({ useSocket: () => (socketAvailable ? socketMock : null) }));
vi.mock("@/lib/analysis-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analysis-api")>();
  return {
    ...actual,
    analysisApi: {
      ...actual.analysisApi,
      listApprovals: (...args: unknown[]) => listApprovals(...args),
      reviewApproval: (...args: unknown[]) => reviewApproval(...args),
    },
  };
});

const { ApprovalsPanel, describeSetDifference, summarisePendingByType } =
  await import("@/components/analysis/ApprovalsPanel");

const ANALYSIS_ID = "an_1135";

const approval = (over: Partial<ApprovalRequestPayload> = {}): ApprovalRequestPayload => ({
  id: "ap_1",
  analysisId: ANALYSIS_ID,
  type: "requirement",
  itemId: "r1",
  status: "pending",
  reviewerId: null,
  reviewNote: null,
  createdAt: "2026-07-29T00:00:00.000Z",
  reviewedAt: null,
  ...over,
});

function renderPanel(metadata: Record<string, unknown> | null = null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
  return {
    qc,
    invalidateSpy,
    ...render(
      <QueryClientProvider client={qc}>
        <ApprovalsPanel projectId="p1" analysisId={ANALYSIS_ID} metadata={metadata} />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  socketHandlers.clear();
  socketAvailable = true;
  listApprovals.mockResolvedValue({
    items: [approval()],
    ticketStatus: { allowed: false, pendingCount: 1, rejectedCount: 0 },
  });
  reviewApproval.mockResolvedValue(approval({ status: "approved" }));
});

describe("#1135 — approving refreshes the analysis detail", () => {
  it("invalidates the analysis detail so the impact note updates without a reload", async () => {
    const { invalidateSpy } = renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    await waitFor(() => expect(reviewApproval).toHaveBeenCalled());
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["analyses", "detail", ANALYSIS_ID],
      }),
    );
    // The approvals list still refreshes too — this is additive.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["approvals", ANALYSIS_ID] });
  });

  it("does the same for a rejection, and carries the review note", async () => {
    const { invalidateSpy } = renderPanel();

    fireEvent.change(await screen.findByLabelText("Review note for requirement item 1"), {
      target: { value: "Out of scope for this release." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    await waitFor(() =>
      expect(reviewApproval).toHaveBeenCalledWith("p1", ANALYSIS_ID, "ap_1", {
        status: "rejected",
        reviewNote: "Out of scope for this release.",
      }),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["analyses", "detail", ANALYSIS_ID],
      }),
    );
  });
});

describe("ApprovalsPanel — surrounding states", () => {
  it("shows a loading placeholder while the approvals load", () => {
    listApprovals.mockReturnValue(new Promise(() => {}));
    renderPanel();
    expect(screen.getByText("Loading approvals…")).toBeInTheDocument();
  });

  it("surfaces a failed approvals fetch instead of rendering nothing (#1104 B)", async () => {
    listApprovals.mockRejectedValue(new Error("nope"));
    renderPanel();
    expect(await screen.findByTestId("approvals-error")).toBeInTheDocument();
  });

  it("enriches a requirement approval with its title and open questions", async () => {
    listApprovals.mockResolvedValue({
      items: [approval()],
      ticketStatus: { allowed: false, pendingCount: 1, rejectedCount: 0 },
    });
    renderPanel({
      structuredRequirements: {
        requirements: [
          {
            id: "r1",
            title: "Consent banner",
            description: "Shown on first visit.",
            ambiguities: [
              {
                field: "dsa",
                description: "scope unclear",
                suggestedQuestion: "Does the DSA apply?",
              },
            ],
            evidenceNeeds: [],
          },
        ],
        totalAmbiguities: 1,
        totalEvidenceNeeds: 0,
      },
    });

    expect(await screen.findByText("Consent banner")).toBeInTheDocument();
    expect(screen.getByText("Shown on first visit.")).toBeInTheDocument();
    expect(screen.getByText("Does the DSA apply?")).toBeInTheDocument();
  });

  it("lists resolved approvals with their review note and no decision buttons", async () => {
    listApprovals.mockResolvedValue({
      items: [approval({ status: "approved", reviewNote: "Looks right." })],
      ticketStatus: { allowed: true, pendingCount: 0, rejectedCount: 0 },
    });
    renderPanel();

    expect(await screen.findByText("Note: Looks right.")).toBeInTheDocument();
    expect(screen.getByTestId("promotion-banner")).toHaveTextContent(
      /All approvals resolved — artifact promotion is unblocked/,
    );
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("refetches when the server pushes a promotion-blocked event (#256)", async () => {
    renderPanel();
    await screen.findByRole("button", { name: "Approve" });
    expect(listApprovals).toHaveBeenCalledTimes(1);
    expect(socketMock.emit).toHaveBeenCalledWith("subscribe:analysis", {
      analysisId: ANALYSIS_ID,
    });

    const handler = socketHandlers.get("analysis:promotion-blocked");
    expect(handler).toBeTypeOf("function");
    // An event for a different run must be ignored.
    handler!({ analysisId: "other", pendingCount: 9, rejectedCount: 0 });
    expect(listApprovals).toHaveBeenCalledTimes(1);

    handler!({ analysisId: ANALYSIS_ID, pendingCount: 4, rejectedCount: 1 });
    await waitFor(() => expect(listApprovals).toHaveBeenCalledTimes(2));
  });

  it("renders without a socket connection", async () => {
    socketAvailable = false;
    renderPanel();
    expect(await screen.findByRole("button", { name: "Approve" })).toBeInTheDocument();
  });
});

describe("summarisePendingByType (#1117 E)", () => {
  it("returns null when nothing is pending", () => {
    expect(summarisePendingByType([])).toBeNull();
  });

  it("orders by count then name and lowercases the labels", () => {
    expect(
      summarisePendingByType([
        { type: "evidence" },
        { type: "requirement" },
        { type: "requirement" },
        { type: "unknown-kind" },
      ]),
    ).toBe("2 requirement, 1 evidence, 1 unknown-kind");
  });
});

describe("#909 — warns before approval when the reviewed list is not the synthesis set", () => {
  it("names both counts in the blocked banner", async () => {
    renderPanel({
      promotionBlocked: {
        blocked: true,
        pendingCount: 1,
        rejectedCount: 0,
        awaitingRequirementCount: 3,
        synthesisRequirementCount: 28,
      },
    });

    expect(await screen.findByTestId("approved-set-difference")).toHaveTextContent(
      "Approving promotes the 3 requirement(s) reviewed below, not the 28 the synthesis produced.",
    );
  });

  it("says nothing when the counts agree, or when the synthesis count is unknown", async () => {
    const { unmount } = renderPanel({
      promotionBlocked: {
        blocked: true,
        pendingCount: 1,
        rejectedCount: 0,
        awaitingRequirementCount: 3,
        synthesisRequirementCount: 3,
      },
    });
    expect(await screen.findByTestId("promotion-banner")).toBeInTheDocument();
    expect(screen.queryByTestId("approved-set-difference")).toBeNull();
    unmount();

    renderPanel({
      promotionBlocked: {
        blocked: true,
        pendingCount: 1,
        rejectedCount: 0,
        awaitingRequirementCount: 3,
      },
    });
    expect(await screen.findByTestId("promotion-banner")).toBeInTheDocument();
    expect(screen.queryByTestId("approved-set-difference")).toBeNull();
  });

  it("#930 — warns on equal counts when the two name different requirements", async () => {
    renderPanel({
      promotionBlocked: {
        blocked: true,
        pendingCount: 1,
        rejectedCount: 0,
        awaitingRequirementCount: 3,
        synthesisRequirementCount: 3,
        setDifference: { reviewedWithoutItem: 1, itemsWithoutReviewed: 2 },
      },
    });

    const warning = await screen.findByTestId("approved-set-difference");
    expect(warning).toHaveTextContent(
      "Approving promotes the 3 requirement(s) reviewed below. " +
        "1 of them did not match any requirement the analysis wrote up. These will be " +
        "promoted without acceptance criteria or supporting evidence; you can add acceptance " +
        "criteria by editing each one after approving. 2 requirement(s) the analysis wrote up match nothing in the " +
        "reviewed list, so their acceptance criteria and evidence will not be carried over " +
        "to any requirement.",
    );
    // Equal counts are not restated as if they differed.
    expect(warning).not.toHaveTextContent("not the 3");
  });

  it("#930 — names only the side that is affected", () => {
    expect(describeSetDifference(3, 3, { reviewedWithoutItem: 0, itemsWithoutReviewed: 1 })).toBe(
      "Approving promotes the 3 requirement(s) reviewed below. 1 requirement(s) the analysis " +
        "wrote up match nothing in the reviewed list, so their acceptance criteria and " +
        "evidence will not be carried over to any requirement.",
    );
    expect(describeSetDifference(4, 3, { reviewedWithoutItem: 2, itemsWithoutReviewed: 0 })).toBe(
      "Approving promotes the 4 requirement(s) reviewed below. 2 of them did not match any " +
        "requirement the analysis wrote up. These will be promoted without acceptance " +
        "criteria or supporting evidence; you can add acceptance criteria by editing each one " +
        "after approving.",
    );
  });

  it("#930 — says nothing when the same requirements are on both sides", async () => {
    renderPanel({
      promotionBlocked: {
        blocked: true,
        pendingCount: 1,
        rejectedCount: 0,
        awaitingRequirementCount: 3,
        synthesisRequirementCount: 3,
        setDifference: { reviewedWithoutItem: 0, itemsWithoutReviewed: 0 },
      },
    });
    expect(await screen.findByTestId("promotion-banner")).toBeInTheDocument();
    expect(screen.queryByTestId("approved-set-difference")).toBeNull();
  });
});

describe("#930 — describeSetDifference", () => {
  it("keeps the count message alone when the counts differ but every item is matched", () => {
    expect(describeSetDifference(2, 1, { reviewedWithoutItem: 0, itemsWithoutReviewed: 0 })).toBe(
      "Approving promotes the 2 requirement(s) reviewed below, not the 1 the synthesis produced. " +
        "Synthesized requirements only contribute acceptance criteria and evidence to a reviewed " +
        "requirement they match.",
    );
  });

  it("compares counts only for a run recorded before #930", () => {
    expect(describeSetDifference(3, 3)).toBeNull();
    expect(describeSetDifference(3, 4)).not.toBeNull();
  });
});

describe("#1569 — requirements offered from the synthesis", () => {
  const OFFERED_NOTE =
    "2 requirement(s) below were written up by the analysis and match none it extracted, so " +
    "they are listed for review with their own acceptance criteria and evidence.";

  it("says they are listed for review even when nothing else differs", () => {
    expect(
      describeSetDifference(4, 4, {
        reviewedWithoutItem: 0,
        itemsWithoutReviewed: 0,
        offeredFromSynthesis: 2,
      }),
    ).toBe(OFFERED_NOTE);
  });

  it("adds to the #930 sentences rather than replacing them", () => {
    expect(
      describeSetDifference(4, 5, {
        reviewedWithoutItem: 0,
        itemsWithoutReviewed: 1,
        offeredFromSynthesis: 2,
      }),
    ).toBe(
      "Approving promotes the 4 requirement(s) reviewed below. 1 requirement(s) the analysis " +
        "wrote up match nothing in the reviewed list, so their acceptance criteria and " +
        `evidence will not be carried over to any requirement. ${OFFERED_NOTE}`,
    );
    // A run recorded before #1569 reads as it did.
    expect(describeSetDifference(4, 4, { reviewedWithoutItem: 0, itemsWithoutReviewed: 0 })).toBe(
      null,
    );
  });

  it("marks an offered requirement's card and names the count in the banner", async () => {
    listApprovals.mockResolvedValue({
      items: [approval(), approval({ id: "ap_2", itemId: "SYN-abc" })],
      ticketStatus: { allowed: false, pendingCount: 2, rejectedCount: 0 },
    });
    const req = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
      id,
      title,
      description: `${title}.`,
      ambiguities: [],
      evidenceNeeds: [],
      ...extra,
    });
    renderPanel({
      structuredRequirements: {
        requirements: [
          req("r1", "Feed URL must be absolute"),
          req("SYN-abc", "Export subscriptions as OPML", { synthesisItemKey: "abc" }),
        ],
        totalAmbiguities: 0,
        totalEvidenceNeeds: 0,
      },
      promotionBlocked: {
        blocked: true,
        pendingCount: 2,
        rejectedCount: 0,
        awaitingRequirementCount: 2,
        synthesisRequirementCount: 2,
        setDifference: { reviewedWithoutItem: 0, itemsWithoutReviewed: 0, offeredFromSynthesis: 1 },
      },
    });

    const offeredCard = await screen.findByTestId("approval-ap_2");
    expect(offeredCard).toHaveTextContent("Written up by the analysis");
    expect(screen.getByTestId("approval-ap_1")).not.toHaveTextContent("Written up by the analysis");
    expect(await screen.findByTestId("approved-set-difference")).toHaveTextContent(
      "1 requirement(s) below were written up by the analysis",
    );
  });
});
