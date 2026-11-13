/**
 * #2462 — the approval checkpoint says BEFORE Approve that a requirement the
 * viewer edited there will be held for a colleague's review (#2436), instead of
 * only in the toast after the click. The server does not refuse that approval:
 * it promotes the requirement awaiting review, so Approve stays enabled.
 *
 * The note shows only when all hold: the viewer edited the item in the
 * checkpoint of the run under review, the project does not allow
 * self-approval, and the viewer's approval would promote as approved (a viewer
 * without requirement.approve promotes drafts and is told so already).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { analysisApi, reviewGateApi } = vi.hoisted(() => ({
  analysisApi: {
    listApprovals: vi.fn(),
    getClarification: vi.fn(),
    reviewApproval: vi.fn(),
    reopenApproval: vi.fn(),
    approveAllApprovals: vi.fn(),
  },
  reviewGateApi: { get: vi.fn(), update: vi.fn() },
}));

vi.mock("@/lib/analysis-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/analysis-api")>("@/lib/analysis-api");
  return { ...actual, analysisApi };
});
vi.mock("@/lib/publishing-api", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/publishing-api")>("@/lib/publishing-api");
  return { ...actual, reviewGateApi };
});

import {
  ApprovalsPanel,
  checkpointItemsEditedBy,
  HELD_FOR_REVIEW_NOTICE,
} from "@/components/analysis/ApprovalsPanel";
import type { ApprovalRequestPayload } from "@/lib/analysis-api";

const RUN = "run-7";

function approval(id: string, itemId: string): ApprovalRequestPayload {
  return {
    id,
    analysisId: "ana-1",
    type: "requirement",
    itemId,
    status: "pending",
    reviewerId: null,
    reviewNote: null,
    createdAt: new Date().toISOString(),
    reviewedAt: null,
  };
}

const metadata = (editorsRun: string | null = RUN): Record<string, unknown> => ({
  structuredRunId: RUN,
  structuredRequirements: {
    requirements: [
      { id: "REQ-001", title: "Mine", description: "", ambiguities: [] },
      { id: "REQ-002", title: "Theirs", description: "", ambiguities: [] },
    ],
    totalAmbiguities: 0,
    totalEvidenceNeeds: 0,
  },
  checkpointRequirementEditors: {
    runId: editorsRun,
    editors: { "REQ-001": ["u-me"], "REQ-002": ["u-other"] },
  },
});

function renderPanel(opts: {
  allowSelfApproval?: boolean;
  approvesAsDraft?: boolean;
  viewerId?: string;
  meta?: Record<string, unknown>;
}) {
  analysisApi.listApprovals.mockResolvedValue({
    items: [approval("ap-1", "REQ-001"), approval("ap-2", "REQ-002")],
    ticketStatus: { allowed: false, pendingCount: 2, rejectedCount: 0 },
  });
  reviewGateApi.get.mockResolvedValue({
    projectId: "proj-1",
    allowSelfApproval: opts.allowSelfApproval ?? false,
  });
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ApprovalsPanel
        projectId="proj-1"
        analysisId="ana-1"
        metadata={opts.meta ?? metadata()}
        analysisStatus="completed"
        approvesAsDraft={opts.approvesAsDraft ?? false}
        viewerId={"viewerId" in opts ? opts.viewerId : "u-me"}
      />
    </QueryClientProvider>,
  );
}

const notes = () => screen.queryAllByTestId("approval-held-for-review");

beforeEach(() => {
  vi.clearAllMocks();
  analysisApi.getClarification.mockResolvedValue({ state: null });
});

describe("ApprovalsPanel — held for review, said before Approve (#2462)", () => {
  it("notes the viewer's own edited requirement only, and keeps its Approve enabled", async () => {
    renderPanel({});
    await waitFor(() => expect(notes()).toHaveLength(1));
    const mine = screen.getByTestId("approval-ap-1");
    expect(mine).toHaveTextContent(HELD_FOR_REVIEW_NOTICE);
    expect(screen.getByTestId("approval-ap-2")).not.toHaveTextContent(/colleague's review/);
    const approve = mine.querySelector("button");
    expect(approve).toHaveTextContent("Approve");
    expect(approve).toBeEnabled();
  });

  it("says so in Approve all's confirmation too", async () => {
    renderPanel({});
    await waitFor(() => expect(notes()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: /Approve all 2 pending/ }));
    expect(screen.getByTestId("approve-all-held-for-review")).toHaveTextContent(
      /One of them you edited here, so it is held for a colleague's review/,
    );
  });

  it("says nothing once the project allows self-approval", async () => {
    renderPanel({ allowSelfApproval: true });
    await waitFor(() => expect(reviewGateApi.get).toHaveBeenCalled());
    await screen.findByTestId("approval-ap-1");
    expect(notes()).toHaveLength(0);
  });

  it("says nothing, and reads no gate, for a viewer whose approval promotes drafts", async () => {
    renderPanel({ approvesAsDraft: true });
    await screen.findByTestId("approval-ap-1");
    expect(notes()).toHaveLength(0);
    expect(reviewGateApi.get).not.toHaveBeenCalled();
  });

  it("reads no gate when the viewer edited nothing in this run's checkpoint", async () => {
    renderPanel({ meta: metadata("an-older-run") });
    await screen.findByTestId("approval-ap-1");
    expect(notes()).toHaveLength(0);
    expect(reviewGateApi.get).not.toHaveBeenCalled();
  });
});

describe("checkpointItemsEditedBy (#2462)", () => {
  it("reads the viewer's ids from the editors record of the run under review", () => {
    expect([...checkpointItemsEditedBy(metadata(), "u-me")]).toEqual(["REQ-001"]);
    expect([...checkpointItemsEditedBy(metadata(), "u-other")]).toEqual(["REQ-002"]);
  });

  it("ignores another run's record, a missing viewer, and malformed records", () => {
    expect(checkpointItemsEditedBy(metadata("an-older-run"), "u-me").size).toBe(0);
    expect(checkpointItemsEditedBy(metadata(), undefined).size).toBe(0);
    expect(checkpointItemsEditedBy(null, "u-me").size).toBe(0);
    expect(checkpointItemsEditedBy({ checkpointRequirementEditors: [] }, "u-me").size).toBe(0);
    expect(
      checkpointItemsEditedBy({ checkpointRequirementEditors: { runId: null } }, "u-me").size,
    ).toBe(0);
    // A record and list both from before #909 (no run id) still match.
    expect([
      ...checkpointItemsEditedBy(
        { checkpointRequirementEditors: { runId: null, editors: { "REQ-9": ["u-me"] } } },
        "u-me",
      ),
    ]).toEqual(["REQ-9"]);
  });
});
