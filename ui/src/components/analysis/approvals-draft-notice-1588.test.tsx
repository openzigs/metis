/**
 * #1588 — approving the checkpoint promotes requirements as `approved` only for
 * a viewer holding `project.update`; anyone else's approval adds them as
 * drafts. The panel says so to that viewer, before they approve, both beside
 * the pending list and in the Approve-all confirmation.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ROLE_PERMISSIONS, type RoleKey } from "@metis/shared";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ApprovalRequestPayload } from "@/lib/analysis-api";

const listApprovals = vi.fn();

vi.mock("@/lib/socket-client", () => ({ useSocket: () => null }));
vi.mock("@/lib/analysis-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analysis-api")>();
  return {
    ...actual,
    analysisApi: {
      ...actual.analysisApi,
      listApprovals: (...args: unknown[]) => listApprovals(...args),
    },
  };
});

const { ApprovalsPanel, DRAFT_APPROVAL_NOTICE } =
  await import("@/components/analysis/ApprovalsPanel");

const ANALYSIS_ID = "an_1588";

const approval = (id: string, status = "pending"): ApprovalRequestPayload => ({
  id,
  analysisId: ANALYSIS_ID,
  type: "requirement",
  itemId: id,
  status: status as ApprovalRequestPayload["status"],
  reviewerId: null,
  reviewNote: null,
  createdAt: "2026-10-30T00:00:00.000Z",
  reviewedAt: null,
});

/** As the Analysis page derives it from the signed-in user's permissions. */
const approvesAsDraft = (role: RoleKey) => !ROLE_PERMISSIONS[role].includes("project.update");

function renderPanel(role: RoleKey) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ApprovalsPanel
        projectId="p1"
        analysisId={ANALYSIS_ID}
        approvesAsDraft={approvesAsDraft(role)}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listApprovals.mockResolvedValue({
    items: [approval("ap_1"), approval("ap_2")],
    ticketStatus: { allowed: false, pendingCount: 2, rejectedCount: 0 },
  });
});

describe("#1588 — the checkpoint tells a viewer without project.update their approval adds drafts", () => {
  it("shows a developer the draft notice and says so in the Approve-all confirmation", async () => {
    renderPanel("developer");

    expect(await screen.findByTestId("approvals-draft-notice")).toHaveTextContent(
      DRAFT_APPROVAL_NOTICE,
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve all 2 pending" }));
    expect(screen.getByTestId("approve-all-confirm")).toHaveTextContent(
      "added as drafts, for a coordinator to approve.",
    );
  });

  it("shows a coordinator no notice: their approval promotes as approved", async () => {
    renderPanel("coordinator");

    await screen.findByRole("button", { name: "Approve all 2 pending" });
    expect(screen.queryByTestId("approvals-draft-notice")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve all 2 pending" }));
    expect(screen.getByTestId("approve-all-confirm")).toHaveTextContent("promoted as approved.");
  });

  it("shows no notice once nothing is pending", async () => {
    listApprovals.mockResolvedValue({
      items: [approval("ap_1", "approved")],
      ticketStatus: { allowed: true, pendingCount: 0, rejectedCount: 0 },
    });
    renderPanel("developer");

    await screen.findByText(/Resolved \(1\)/);
    expect(screen.queryByTestId("approvals-draft-notice")).not.toBeInTheDocument();
  });
});
