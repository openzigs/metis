/**
 * #2554 — a checkpoint the server marks `restricted` (it rests on a document
 * the viewer cannot read) offers no decision: no Approve, Reject, Edit or
 * Reopen on it, and no Approve all or "leave out the added" while one of the
 * set is restricted. The server refuses each of them.
 */
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequestPayload } from "@/lib/analysis-api";

const listApprovals = vi.fn();

vi.mock("@/lib/socket-client", () => ({ useSocket: () => null }));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/analysis-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analysis-api")>();
  return {
    ...actual,
    analysisApi: {
      ...actual.analysisApi,
      listApprovals: (...args: unknown[]) => listApprovals(...args),
      getClarification: vi.fn(async () => ({ state: null })),
    },
  };
});

const {
  ApprovalsPanel,
  RESTRICTED_CHECKPOINT_NOTICE,
  describeRestrictedPending,
  describeRestrictedAdded,
} = await import("@/components/analysis/ApprovalsPanel");

const ANALYSIS_ID = "an_2554";
const METADATA = {
  structuredRequirements: {
    requirements: ["s-open", "s-secret", "s-gone"].map((id) => ({
      id,
      type: "functional",
      priority: "medium",
      title: id === "s-open" ? "Brief export" : "Restricted",
      description: "",
      stakeholders: [],
      ambiguities: [],
      evidenceNeeds: [],
      rawSource: "",
    })),
  },
};

const approval = (
  id: string,
  itemId: string,
  extra: Partial<ApprovalRequestPayload> = {},
): ApprovalRequestPayload => ({
  id,
  analysisId: ANALYSIS_ID,
  type: "requirement",
  itemId,
  status: "pending",
  reviewerId: null,
  reviewNote: null,
  createdAt: "2026-11-15T00:00:00.000Z",
  reviewedAt: null,
  ...extra,
});

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ApprovalsPanel projectId="p1" analysisId={ANALYSIS_ID} metadata={METADATA} />
    </QueryClientProvider>,
  );
}

const respond = (items: ApprovalRequestPayload[]) =>
  listApprovals.mockResolvedValue({
    items,
    ticketStatus: { allowed: false, pendingCount: items.length, rejectedCount: 0 },
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("#2554 — a restricted checkpoint offers no decision", () => {
  it("shows why on the restricted card, with no Approve, Reject or Edit; the other card keeps them", async () => {
    respond([
      approval("ap_open", "s-open"),
      approval("ap_secret", "s-secret", { restricted: true }),
    ]);
    renderPanel();
    const secret = await screen.findByTestId("approval-ap_secret");
    expect(within(secret).getByTestId("approval-restricted")).toHaveTextContent(
      RESTRICTED_CHECKPOINT_NOTICE,
    );
    expect(within(secret).queryByRole("button")).not.toBeInTheDocument();
    expect(within(secret).queryByRole("textbox")).not.toBeInTheDocument();
    const open = screen.getByTestId("approval-ap_open");
    expect(within(open).getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(within(open).getByRole("button", { name: "Reject" })).toBeInTheDocument();
    expect(within(open).queryByTestId("approval-restricted")).not.toBeInTheDocument();
  });

  it("offers no Approve all while a pending checkpoint is restricted, and says why", async () => {
    respond([
      approval("ap_open", "s-open"),
      approval("ap_secret", "s-secret", { restricted: true }),
      approval("ap_gone", "s-gone", { restricted: true }),
    ]);
    renderPanel();
    expect(await screen.findByTestId("approve-all-restricted")).toHaveTextContent(
      describeRestrictedPending(2),
    );
    expect(screen.queryByRole("button", { name: /Approve all/ })).not.toBeInTheDocument();
  });

  it("offers Approve all when no pending checkpoint is restricted", async () => {
    respond([approval("ap_open", "s-open"), approval("ap_secret", "s-secret")]);
    renderPanel();
    expect(
      await screen.findByRole("button", { name: "Approve all 2 pending" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("approve-all-restricted")).not.toBeInTheDocument();
  });

  it("offers no Reopen on a rejected checkpoint that is restricted", async () => {
    respond([
      approval("ap_open", "s-open", { status: "rejected" }),
      approval("ap_secret", "s-secret", { status: "rejected", restricted: true }),
    ]);
    renderPanel();
    const secret = await screen.findByTestId("approval-ap_secret");
    expect(within(secret).queryByRole("button", { name: /Reopen/ })).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId("approval-ap_open")).getByRole("button", { name: /Reopen/ }),
    ).toBeInTheDocument();
  });

  it("offers no 'leave out the added' while one of the added is restricted", async () => {
    respond([
      approval("ap_open", "s-open", { origin: "ticked" }),
      approval("ap_secret", "s-secret", { origin: "added", restricted: true }),
      approval("ap_gone", "s-gone", { origin: "added" }),
    ]);
    renderPanel();
    await screen.findByTestId("approvals-added");
    expect(screen.queryByRole("button", { name: /Leave out the/ })).not.toBeInTheDocument();
    // ...and says why in that section, not only in the Approve all note.
    expect(screen.getByTestId("leave-out-added-restricted")).toHaveTextContent(
      describeRestrictedAdded(1),
    );
  });

  it("offers 'leave out the added' when none of the added is restricted", async () => {
    respond([
      approval("ap_open", "s-open", { origin: "ticked" }),
      approval("ap_gone", "s-gone", { origin: "added" }),
    ]);
    renderPanel();
    expect(
      await screen.findByRole("button", { name: "Leave out the 1 added by the analysis" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("leave-out-added-restricted")).not.toBeInTheDocument();
  });

  it("counts the restricted added requirements", () => {
    expect(describeRestrictedAdded(1)).toContain(
      "one of the requirements the analysis added rests",
    );
    expect(describeRestrictedAdded(3)).toContain("3 of the requirements the analysis added rest");
  });

  it("counts one restricted checkpoint in the singular", () => {
    expect(describeRestrictedPending(1)).toContain("one of these checkpoints rests");
  });
});
