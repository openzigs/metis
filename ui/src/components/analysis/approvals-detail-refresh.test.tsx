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

const { ApprovalsPanel, summarisePendingByType } =
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

    fireEvent.change(await screen.findByLabelText("Review note for r1"), {
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
