/**
 * Issue #2596 — one FRD, one requirement count. In the 2026-11-16 walkthrough
 * (FRD-12, Miniflux) the Checkpoints tab listed 18 requirements: the 8 the
 * analysis extracted (the summary's "Eight requirements") and 10 NFRs it
 * found, 6 of them restating one of the 8. These cover what the Checkpoints
 * and Requirements tabs say about that list.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { analysisApi } = vi.hoisted(() => ({
  analysisApi: {
    listApprovals: vi.fn(),
    reviewApproval: vi.fn(),
    approveAllApprovals: vi.fn(),
    getClarification: vi.fn(),
  },
}));

vi.mock("@/lib/analysis-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/analysis-api")>("@/lib/analysis-api");
  return { ...actual, analysisApi };
});

import {
  ApprovalsPanel,
  describeSetDifference,
  groupResembling,
} from "@/components/analysis/ApprovalsPanel";
import { RequirementsEmptyState } from "@/components/analysis/RequirementsEmptyState";
import type { ApprovalRequestPayload } from "@/lib/analysis-api";

function approval(id: string, itemId: string, over: Partial<ApprovalRequestPayload> = {}) {
  return {
    id,
    analysisId: "ana-1",
    type: "requirement",
    itemId,
    status: "pending",
    reviewerId: null,
    reviewNote: null,
    createdAt: "2026-11-16T16:03:49.096Z",
    reviewedAt: null,
    ...over,
  } satisfies ApprovalRequestPayload;
}

const requirement = (id: string, title: string, nfr = false) => ({
  id,
  title,
  description: "",
  type: nfr ? "non-functional" : "functional",
  stakeholders: [],
  priority: "must-have",
  ambiguities: [],
  evidenceNeeds: [],
  rawSource: "",
  ...(nfr ? { elicitedNfr: { nfrCategory: "security", evidenceFindingIds: [] } } : {}),
});

const METADATA = {
  promotionBlocked: {
    blocked: true,
    pendingCount: 3,
    rejectedCount: 0,
    awaitingRequirementCount: 3,
    reviewedRequirementCount: 3,
    synthesisRequirementCount: 2,
    setDifference: { reviewedWithoutItem: 0, itemsWithoutReviewed: 0, elicitedNfrs: 1 },
  },
  structuredRequirements: {
    requirements: [
      requirement("R-1", "Expired keys are refused like unknown keys"),
      requirement("R-2", "API key list shows expiry"),
      requirement("N-1", "Expired API keys refused identically to unknown keys", true),
    ],
    totalAmbiguities: 0,
    totalEvidenceNeeds: 0,
  },
};

function withClient(node: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  analysisApi.getClarification.mockResolvedValue({ state: null });
});

describe("#2596 — the checkpoint's count, reconciled with the summary's", () => {
  it("says the difference is the NFRs the analysis found, not a set the synthesis lost", () => {
    const text = describeSetDifference(18, 8, {
      reviewedWithoutItem: 0,
      itemsWithoutReviewed: 0,
      elicitedNfrs: 10,
    });
    expect(text).toBe(
      'The 18 requirement(s) below are the 8 the analysis wrote up (the number its summary gives) and 10 non-functional requirement(s) it found, marked "Found by the analysis". Approving promotes the ones you approve.',
    );
    expect(text).not.toMatch(/not the 8/);
  });

  it("adds the NFR count to the other notes when they do not account for it alone", () => {
    const text = describeSetDifference(18, 9, {
      reviewedWithoutItem: 1,
      itemsWithoutReviewed: 0,
      elicitedNfrs: 10,
    });
    expect(text).toMatch(/^Approving promotes the 18 requirement\(s\) reviewed below\./);
    expect(text).toMatch(
      /10 of the requirements below are non-functional requirements the analysis found/,
    );
  });

  it("keeps the earlier wording for a run recorded before #2596", () => {
    expect(describeSetDifference(18, 8, { reviewedWithoutItem: 0, itemsWithoutReviewed: 0 })).toBe(
      "Approving promotes the 18 requirement(s) reviewed below, not the 8 the synthesis produced. Synthesized requirements only contribute acceptance criteria and evidence to a reviewed requirement they match.",
    );
    expect(describeSetDifference(4, 4, { reviewedWithoutItem: 0, itemsWithoutReviewed: 0 })).toBe(
      null,
    );
  });
});

describe("#2596 — a requirement the analysis added sits beside the one it resembles", () => {
  it("moves it straight after its match, and marks it", () => {
    const list = [
      approval("a1", "R-1"),
      approval("a2", "R-2"),
      approval("a3", "N-1", { resembles: "R-1" }),
      approval("a4", "N-2", { resembles: "R-2" }),
    ];
    expect(groupResembling(list).map((g) => [g.approval.id, g.resembles])).toEqual([
      ["a1", undefined],
      ["a3", "R-1"],
      ["a2", undefined],
      ["a4", "R-2"],
    ]);
  });

  it("keeps one in place, unmarked, when its match is not in the list", () => {
    const list = [approval("a1", "R-1"), approval("a3", "N-1", { resembles: "R-9" })];
    expect(groupResembling(list).map((g) => [g.approval.id, g.resembles])).toEqual([
      ["a1", undefined],
      ["a3", undefined],
    ]);
  });

  it("groups by requirement only: an evidence approval on the same item is not a match", () => {
    const list = [
      approval("e1", "R-1", { type: "evidence" }),
      approval("a3", "N-1", { resembles: "R-1" }),
    ];
    expect(groupResembling(list).map((g) => [g.approval.id, g.resembles])).toEqual([
      ["e1", undefined],
      ["a3", undefined],
    ]);
  });

  it("lists a resembling requirement once when its match has two pending approvals", () => {
    const list = [
      approval("a1", "R-1"),
      approval("a1b", "R-1"),
      approval("a3", "N-1", { resembles: "R-1" }),
    ];
    expect(groupResembling(list).map((g) => g.approval.id)).toEqual(["a1", "a3", "a1b"]);
  });

  it("renders the pair together on the Checkpoints tab, saying how to decide them", async () => {
    analysisApi.listApprovals.mockResolvedValue({
      items: [
        approval("a1", "R-1"),
        approval("a2", "R-2"),
        approval("a3", "N-1", { resembles: "R-1" }),
      ],
      ticketStatus: { allowed: false, pendingCount: 3, rejectedCount: 0 },
    });

    withClient(<ApprovalsPanel projectId="proj-1" analysisId="ana-1" metadata={METADATA} />);

    await screen.findByTestId("approvals-panel");
    const cards = screen.getAllByTestId(/^approval-a\d$/).map((c) => c.dataset.testid);
    expect(cards).toEqual(["approval-a1", "approval-a3", "approval-a2"]);
    expect(
      within(screen.getByTestId("approval-a3")).getByTestId("approval-resembles"),
    ).toHaveTextContent(
      "Close to “Expired keys are refused like unknown keys”, listed just above. If the two say the same thing, approve one and reject the other.",
    );
    expect(
      within(screen.getByTestId("approval-a1")).queryByTestId("approval-resembles"),
    ).toBeNull();
    expect(screen.getByTestId("approved-set-difference")).toHaveTextContent(
      "The 3 requirement(s) below are the 2 the analysis wrote up",
    );
  });
});

describe("#2596 — the Requirements tab lists what awaits approval", () => {
  const checkpoint = (approvals: ApprovalRequestPayload[]) => ({
    projectId: "proj-1",
    analysisId: "ana-1",
    approvals,
    approvesAsDraft: false,
  });

  it("lists the pending requirements by title, the NFR marked, with Approve all", async () => {
    analysisApi.approveAllApprovals.mockResolvedValue({ approvedCount: 4 });
    withClient(
      <RequirementsEmptyState
        metadata={METADATA}
        ticketStatus={{ allowed: false, pendingCount: 4, rejectedCount: 0 }}
        checkpoint={checkpoint([
          approval("a1", "R-1"),
          approval("a2", "R-2", { status: "approved" }),
          approval("a3", "N-1"),
          approval("e1", "R-1", { type: "evidence" }),
          approval("a4", "R-gone"),
        ])}
      />,
    );

    const section = screen.getByTestId("requirements-pending");
    expect(within(section).getByRole("heading")).toHaveTextContent("Awaiting approval (3)");
    const items = within(section).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      "Expired keys are refused like unknown keys",
      "Expired API keys refused identically to unknown keys" +
        "Found by the analysis · Non-functional · Security",
      // Not in the reviewed list: named by position, as on the Checkpoints tab.
      "requirement item 3",
    ]);
    // Approve all is the Checkpoints tab's: every pending approval, evidence too.
    fireEvent.click(within(section).getByRole("button", { name: "Approve all 4 pending" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm approve all" }));
    await waitFor(() =>
      expect(analysisApi.approveAllApprovals).toHaveBeenCalledWith("proj-1", "ana-1"),
    );
  });

  it("offers no Approve all while a pending approval is restricted", () => {
    withClient(
      <RequirementsEmptyState
        metadata={METADATA}
        checkpoint={checkpoint([
          approval("a1", "R-1"),
          approval("a3", "N-1", { restricted: true }),
        ])}
      />,
    );
    expect(screen.queryByRole("button", { name: /Approve all/ })).toBeNull();
    expect(screen.getByTestId("requirements-approve-all-restricted")).toHaveTextContent(
      /Approve all isn't offered/,
    );
  });

  it("shows only the notice with no pending requirement, or no approvals passed", () => {
    const { unmount } = withClient(
      <RequirementsEmptyState
        metadata={METADATA}
        checkpoint={checkpoint([approval("e1", "R-1", { type: "evidence" })])}
      />,
    );
    expect(screen.getByTestId("requirements-gated")).toBeInTheDocument();
    expect(screen.queryByTestId("requirements-pending")).toBeNull();
    unmount();
    render(<RequirementsEmptyState metadata={METADATA} />);
    expect(screen.queryByTestId("requirements-pending")).toBeNull();
  });
});
