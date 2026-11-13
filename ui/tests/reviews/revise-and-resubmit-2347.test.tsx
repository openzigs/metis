/**
 * Issue #2347 — after a rejection the author sees what was rejected and why,
 * and "Revise and resubmit" on the review; the draft it leaves is resubmitted
 * from the same page. Offered only to whom the server would accept it from.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "../test-utils";

const revise = vi.hoisted(() => vi.fn());
const submit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/reviews-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reviews-api")>()),
  reviewsApi: { revise, submit },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";
import { ApiError } from "@/lib/api-client";
import {
  RejectedReviewNotice,
  ResubmitReviewButton,
  ReviseReviewButton,
  canResubmitReview,
  canReviseReview,
  roundErrorMessage,
} from "@/components/reviews/revise-and-resubmit";

const assignment = (over: Record<string, unknown> = {}) => ({
  id: "a-1",
  reviewRequestId: "rev-1",
  reviewerId: "u-rev",
  decision: "rejected",
  note: "Missing the refund rules",
  decidedAt: null,
  reviewer: { id: "u-rev", username: "rev", displayName: "Rita Reviewer" },
  ...over,
});

const review = (over: Record<string, unknown> = {}) =>
  ({
    id: "rev-1",
    title: "Sign off checkout",
    status: "rejected",
    requestedById: "u-ana",
    items: [{ id: "i-1" }, { id: "i-2" }],
    assignments: [assignment()],
    ...over,
  }) as never;

function renderWith(ui: React.ReactElement) {
  const Wrapper = makeWrapper({ withAuth: false });
  return render(<Wrapper>{ui}</Wrapper>);
}

beforeEach(() => {
  vi.clearAllMocks();
  revise.mockResolvedValue({});
  submit.mockResolvedValue({});
});

describe("who may revise or resubmit (#2347)", () => {
  const ana = { id: "u-ana", role: "developer" as const };
  const admin = { id: "u-boss", role: "coordinator" as const };
  const reviewerAdmin = { id: "u-rev", role: "coordinator" as const };
  const other = { id: "u-x", role: "developer" as const };
  const reader = { id: "u-ana", role: "reader" as const };

  it("the requester or a review admin who is not its reviewer, on a rejected review", () => {
    expect(canReviseReview(review(), ana)).toBe(true);
    expect(canReviseReview(review(), admin)).toBe(true);
    expect(canReviseReview(review(), reviewerAdmin)).toBe(false);
    expect(canReviseReview(review(), other)).toBe(false);
    expect(canReviseReview(review(), reader)).toBe(false);
    expect(canReviseReview(review(), null)).toBe(false);
    expect(canReviseReview(review({ status: "approved" }), ana)).toBe(false);
  });

  it("resubmits only a draft", () => {
    expect(canResubmitReview(review({ status: "draft" }), ana)).toBe(true);
    expect(canResubmitReview(review({ status: "rejected" }), ana)).toBe(false);
    expect(canResubmitReview(review({ status: "draft" }), other)).toBe(false);
  });
});

describe("RejectedReviewNotice (#2347)", () => {
  it("says every item is rejected, approved ones included, and why", () => {
    renderWith(<RejectedReviewNotice review={review()} />);
    const notice = screen.getByTestId("review-rejected-notice");
    expect(notice).toHaveTextContent(
      "all 2 items in it are rejected, including any that were already approved",
    );
    expect(screen.getByTestId("review-rejected-reason-u-rev")).toHaveTextContent(
      "Rita Reviewer: Missing the refund rules",
    );
  });

  it("says when no reason was given, and shows nothing unless rejected", () => {
    const { unmount } = renderWith(
      <RejectedReviewNotice review={review({ assignments: [assignment({ note: " " })] })} />,
    );
    expect(screen.getByTestId("review-rejected-reason-u-rev")).toHaveTextContent(
      "No reason given.",
    );
    unmount();
    renderWith(<RejectedReviewNotice review={review({ status: "in_review" })} />);
    expect(screen.queryByTestId("review-rejected-notice")).not.toBeInTheDocument();
  });
});

describe("Revise and resubmit buttons (#2347)", () => {
  it("revises, then resubmits", async () => {
    renderWith(<ReviseReviewButton review={review()} />);
    fireEvent.click(screen.getByRole("button", { name: "Revise and resubmit" }));
    await waitFor(() => expect(revise).toHaveBeenCalledWith("rev-1"));
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/Back in draft/));

    renderWith(<ResubmitReviewButton review={review({ status: "draft" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Resubmit for review" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("rev-1"));
  });

  it("turns a refusal into a sentence", async () => {
    revise.mockRejectedValue(new ApiError(403, "no", "NOT_REQUESTER"));
    renderWith(<ReviseReviewButton review={review()} />);
    fireEvent.click(screen.getByRole("button", { name: "Revise and resubmit" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(/Only the person who requested/),
      ),
    );
    expect(roundErrorMessage(new ApiError(409, "x", "REVIEW_STATE_CHANGED"), "f")).toMatch(
      /changed meanwhile/,
    );
    expect(roundErrorMessage(new ApiError(409, "x", "REVIEW_SCOPE_STALE"), "f")).toMatch(
      /no longer exists/,
    );
    expect(roundErrorMessage(new ApiError(403, "x", "FORBIDDEN"), "f")).toMatch(/not allowed/);
    expect(roundErrorMessage(undefined, "fallback")).toBe("fallback");
  });

  // #2347 review — the server refuses an assigned reviewer's revise in any state.
  it("says why a reviewer may not revise it", () => {
    expect(roundErrorMessage(new ApiError(403, "x", "REVIEWER_CANNOT_REVISE"), "f")).toBe(
      "You are a reviewer of this review, so you cannot revise it. Its requester revises and resubmits it.",
    );
  });
});

// #2347 review — after revise and resubmit, a withdraw restores the rejection
// (the resubmit captured it), not the status from before the first round.
describe("what a withdraw after a resubmit restores (#2347)", () => {
  it("says the rejection stands, so the copy promises nothing the server does not do", () => {
    renderWith(<RejectedReviewNotice review={review()} />);
    expect(screen.getByTestId("review-rejected-withdraw-note")).toHaveTextContent(
      "withdrawing the resubmitted review leaves the requirements rejected, not as they were before this review.",
    );
  });
});
