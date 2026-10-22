/**
 * Issue #1389 — "Re-synthesis suggested different acceptance criteria" on an
 * approved requirement's card, its two answers, and the History line that
 * names a system write as "System".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RequirementCriteriaProposal } from "@metis/shared";

const resolve = vi.fn();
vi.mock("@/lib/collaboration-api", () => ({
  requirementCriteriaProposalApi: { resolve: (...a: unknown[]) => resolve(...a) },
}));
const dismissAll = vi.fn();
vi.mock("@/lib/analysis-api", () => ({
  analysisApi: { dismissAllCriteriaProposals: (...a: unknown[]) => dismissAll(...a) },
}));
const list = vi.fn();
vi.mock("@/lib/history-api", () => ({
  historyApi: { list: (...a: unknown[]) => list(...a), restore: vi.fn(), export: vi.fn() },
}));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { role: "reader" } }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { CriteriaProposalNotice } from "@/components/requirements/CriteriaProposalNotice";
import { RequirementHistoryTab } from "@/components/requirements/RequirementHistoryTab";
import { CriteriaProposalsSummary } from "@/components/requirements/CriteriaProposalsSummary";

const APPROVED = ["Installs as a single binary.", "A page renders in under 200 ms."];
const proposal: RequirementCriteriaProposal = {
  proposed: ["Starts in one second."],
  at: "2026-10-22T01:23:39.000Z",
};
const KEY = ["analyses", "detail", "ana-1"];

function renderNotice(p: RequirementCriteriaProposal | null = proposal) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  render(
    <QueryClientProvider client={qc}>
      <CriteriaProposalNotice
        requirementId="req-1"
        title="Feed reader"
        version={1}
        proposal={p}
        current={APPROVED}
        invalidateKeys={[KEY]}
      />
    </QueryClientProvider>,
  );
  return { invalidate };
}

describe("CriteriaProposalNotice (#1389)", () => {
  beforeEach(() => {
    resolve.mockReset();
    toast.success.mockReset();
    toast.error.mockReset();
  });

  it("renders nothing without a proposal", () => {
    renderNotice(null);
    expect(screen.queryByRole("button", { name: /^Accept/ })).not.toBeInTheDocument();
  });

  it("shows the badge, and Review compares the approved and suggested criteria", () => {
    renderNotice();
    expect(
      screen.getByText("Re-synthesis suggested different acceptance criteria"),
    ).toBeInTheDocument();
    // A static badge is not a live region (#1389 review).
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Review suggested acceptance criteria for Feed reader" }),
    );

    expect(screen.getByRole("list", { name: "Approved acceptance criteria" })).toHaveTextContent(
      APPROVED[0]!,
    );
    expect(screen.getByRole("list", { name: "Suggested acceptance criteria" })).toHaveTextContent(
      "Starts in one second.",
    );
  });

  it("Accept sends the version shown, then refetches", async () => {
    resolve.mockResolvedValue({ id: "req-1", choice: "accept", version: 2, changed: true });
    const { invalidate } = renderNotice();

    fireEvent.click(
      screen.getByRole("button", { name: "Accept suggested acceptance criteria for Feed reader" }),
    );

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Accepted the suggested acceptance criteria"),
    );
    expect(resolve).toHaveBeenCalledWith("req-1", { choice: "accept", version: 1 });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
  });

  it("Dismiss sends no version, then refetches", async () => {
    resolve.mockResolvedValue({ id: "req-1", choice: "dismiss", version: 1, changed: false });
    const { invalidate } = renderNotice();

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss suggested acceptance criteria for Feed reader" }),
    );

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Kept the approved acceptance criteria"),
    );
    expect(resolve).toHaveBeenCalledWith("req-1", { choice: "dismiss" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
  });

  it("a refused answer refetches, so the card shows what is really there", async () => {
    resolve.mockRejectedValue(new Error("conflict"));
    const { invalidate } = renderNotice();

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss suggested acceptance criteria for Feed reader" }),
    );

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY }));
  });
});

describe("RequirementHistoryTab — a system write (#1389)", () => {
  it('names a null actor "System"', async () => {
    list.mockResolvedValue({
      versions: [
        {
          version: 1,
          changedFields: { acceptanceCriteria: { from: "[]", to: JSON.stringify(APPROVED) } },
          actorId: null,
          reason: "Approved acceptance criteria kept; re-synthesis suggested different ones",
          createdAt: "2026-10-22T01:23:39.000Z",
          snapshot: { title: "Feed reader", body: "Body", priority: "high" },
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
      currentVersion: 1,
    });
    render(<RequirementHistoryTab requirementId="req-1" />);
    await waitFor(() => expect(screen.getByText("Version 1")).toBeInTheDocument());
    expect(screen.getByText(/· System/)).toBeInTheDocument();
  });
});

describe("CriteriaProposalsSummary (#1389)", () => {
  function renderSummary(count: number, reviewing = false) {
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const onReviewChange = vi.fn();
    render(
      <QueryClientProvider client={qc}>
        <CriteriaProposalsSummary
          projectId="p-1"
          analysisId="ana-1"
          count={count}
          reviewing={reviewing}
          onReviewChange={onReviewChange}
          invalidateKeys={[KEY]}
        />
      </QueryClientProvider>,
    );
    return { invalidate, onReviewChange };
  }

  beforeEach(() => {
    dismissAll.mockReset();
    toast.success.mockReset();
  });

  it("renders nothing when no requirement has a suggestion", () => {
    renderSummary(0);
    expect(screen.queryByTestId("criteria-proposals-summary")).not.toBeInTheDocument();
  });

  it("is the one live region, naming how many approved requirements have a suggestion", () => {
    renderSummary(19);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Re-synthesis suggested different acceptance criteria for 19 approved requirements",
    );
  });

  it("Review toggles the filter", () => {
    const { onReviewChange } = renderSummary(2);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(onReviewChange).toHaveBeenCalledWith(true);
  });

  it("Keep approved criteria for all dismisses every suggestion in one request", async () => {
    dismissAll.mockResolvedValue({ dismissedCount: 2 });
    const { invalidate, onReviewChange } = renderSummary(2, true);

    fireEvent.click(screen.getByRole("button", { name: "Keep approved criteria for all" }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Kept the approved acceptance criteria for 2 requirements",
      ),
    );
    expect(dismissAll).toHaveBeenCalledTimes(1);
    expect(dismissAll).toHaveBeenCalledWith("p-1", "ana-1");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
    expect(onReviewChange).toHaveBeenCalledWith(false);
  });
});
