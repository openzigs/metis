/**
 * #2219 — editing an approved requirement kept it approved, with no warning,
 * no re-review and nothing on the review saying the wording had changed.
 *
 * Covers the UI half: the Edit dialog's warning, the review card's "v2 differs
 * from the approved v1" with the diff, "Request re-review", and the
 * notification level of the edit's notification.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import type { RequirementApproval } from "@metis/shared";
import { makeWrapper } from "./test-utils";
import type { AuthUser } from "@/lib/auth-types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/reviews-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reviews-api")>("@/lib/reviews-api");
  return {
    ...actual,
    reviewsApi: { reopen: vi.fn(), requirementApproval: vi.fn() },
  };
});

vi.mock("@/lib/history-api", () => ({
  historyApi: { list: vi.fn(), restore: vi.fn(), export: vi.fn() },
}));

import { toast } from "sonner";
import { ApiError } from "@/lib/api-client";
import { historyApi } from "@/lib/history-api";
import { reviewEventToNotification } from "@/lib/notifications";
import { queryKeys } from "@/lib/query-keys";
import { reviewsApi, type ReviewItem, type ReviewRequest } from "@/lib/reviews-api";
import { RequirementApprovalWarning } from "@/components/requirements/RequirementApprovalWarning";
import {
  outOfDateVersion,
  ReviewItemCard,
  reviewOutOfDate,
  snapshotDiff,
} from "@/components/reviews/ReviewItemCard";
import {
  canRequestReReview,
  reReviewErrorMessage,
  RequestReReviewButton,
} from "@/components/reviews/RequestReReviewButton";

const approvalMock = reviewsApi.requirementApproval as unknown as ReturnType<typeof vi.fn>;
const reopenMock = reviewsApi.reopen as unknown as ReturnType<typeof vi.fn>;
const historyMock = historyApi.list as unknown as ReturnType<typeof vi.fn>;
const toastSuccess = toast.success as unknown as ReturnType<typeof vi.fn>;
const toastError = toast.error as unknown as ReturnType<typeof vi.fn>;

function user(id: string, role: AuthUser["role"]): AuthUser {
  return { id, username: id, displayName: id, email: `${id}@example.com`, role, permissions: [] };
}
const REQUESTER = user("u-req", "developer");
const OTHER_DEVELOPER = user("u-dev", "developer");
const ADMIN = user("u-admin", "admin");
const READER = user("u-read", "reader");

function item(over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "item-1",
    requirementId: "req-1",
    generatedDocumentId: null,
    pinnedVersion: 1,
    requirement: { id: "req-1", title: "Password length", version: 2 },
    generatedDocument: null,
    ...over,
  };
}

function makeReview(over: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    id: "rev-1",
    projectId: "p-1",
    title: "Security sign-off",
    description: "",
    status: "approved",
    policy: "all",
    quorum: null,
    requestedById: "u-req",
    dueAt: null,
    decidedAt: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
    requestedBy: { id: "u-req", username: "rita", displayName: "Rita Requester" },
    items: [item()],
    assignments: [],
    baseline: null,
    ...over,
  };
}

function wrapper(as: AuthUser | null = REQUESTER) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  return { Wrapper: makeWrapper({ initialUser: as, queryClient }), invalidate };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("<RequirementApprovalWarning /> — the Edit dialog warns before the save", () => {
  const approval = (over: Partial<RequirementApproval> = {}): RequirementApproval => ({
    requirementId: "req-1",
    version: 1,
    reviewStatus: "approved",
    reviews: [
      {
        id: "rev-1",
        title: "Security sign-off",
        status: "approved",
        pinnedVersion: 1,
        approvedBy: ["Test Coordinator"],
      },
    ],
    ...over,
  });

  const renderWarning = (reviewStatus: string | null = "approved") => {
    const { Wrapper } = wrapper();
    render(
      <Wrapper>
        <RequirementApprovalWarning requirementId="req-1" version={1} reviewStatus={reviewStatus} />
      </Wrapper>,
    );
  };

  it("names who approved which version, and that saving reopens review", async () => {
    approvalMock.mockResolvedValue(approval());
    renderWarning();

    expect(
      await screen.findByText(
        "Approved as v1 by Test Coordinator; saving creates v2 and reopens review.",
      ),
    ).toBeTruthy();
    expect(approvalMock).toHaveBeenCalledWith("req-1");
  });

  it("still warns from the requirement's own status when the read fails", async () => {
    approvalMock.mockRejectedValue(new ApiError(403, "no", "FORBIDDEN"));
    renderWarning();

    await waitFor(() => expect(approvalMock).toHaveBeenCalled());
    expect(screen.getByTestId("req-edit-approval-warning").textContent).toBe(
      "Approved as v1; saving creates v2 and returns it to awaiting review.",
    );
  });

  it("reads a body that is not the approval shape as no answer", async () => {
    approvalMock.mockResolvedValue({});
    renderWarning();

    await waitFor(() => expect(approvalMock).toHaveBeenCalled());
    expect(screen.getByTestId("req-edit-approval-warning").textContent).toBe(
      "Approved as v1; saving creates v2 and returns it to awaiting review.",
    );
  });

  it("says nothing for a requirement with no approval and no open review", async () => {
    approvalMock.mockResolvedValue(approval({ reviewStatus: "draft", reviews: [] }));
    renderWarning("draft");

    await waitFor(() => expect(approvalMock).toHaveBeenCalled());
    expect(screen.queryByTestId("req-edit-approval-warning")).toBeNull();
  });
});

describe("the review card — a requirement edited after its pin", () => {
  const PINNED = { title: "Password length", body: "At least 12 characters", priority: "high" };
  const CURRENT = { ...PINNED, body: "15 characters, or 8 with MFA" };

  beforeEach(() => {
    historyMock.mockResolvedValue({
      versions: [
        {
          version: 2,
          changedFields: { body: { from: PINNED.body, to: CURRENT.body } },
          actorId: "u-edit",
          reason: null,
          createdAt: "2026-11-10T00:00:00.000Z",
          snapshot: CURRENT,
        },
        {
          version: 1,
          changedFields: { title: { from: "Old", to: PINNED.title } },
          actorId: "u-edit",
          reason: null,
          createdAt: "2026-11-01T00:00:00.000Z",
          snapshot: PINNED,
        },
      ],
      total: 2,
      page: 1,
      pageSize: 100,
      currentVersion: 2,
    });
  });

  const renderCard = (status: ReviewRequest["status"], it = item()) => {
    const { Wrapper } = wrapper();
    render(
      <Wrapper>
        <ReviewItemCard item={it} reviewStatus={status} />
      </Wrapper>,
    );
  };

  it("an approved review says v2 differs from the approved v1, with the diff", async () => {
    renderCard("approved");

    const notice = await screen.findByTestId("review-item-out-of-date");
    expect(within(notice).getByText("v2 differs from the approved v1")).toBeTruthy();
    expect(notice.textContent).toContain("Request a re-review");
    await waitFor(() => expect(within(notice).getByTestId("diff-field-body")).toBeTruthy());
    expect(within(notice).getByTestId("diff-from").textContent).toContain(PINNED.body);
    expect(within(notice).getByTestId("diff-to").textContent).toContain(CURRENT.body);
    // Only what changed between the pin and now.
    expect(within(notice).queryByTestId("diff-field-title")).toBeNull();
  });

  it("an in-review review says the reviewers are deciding on the pinned version", async () => {
    renderCard("in_review");
    const notice = await screen.findByTestId("review-item-out-of-date");
    expect(within(notice).getByText("v2 differs from the pinned v1")).toBeTruthy();
    expect(notice.textContent).toContain("Reviewers are deciding on v1");
  });

  it("says nothing when the pin is current, or the review no longer stands on it", async () => {
    renderCard("approved", item({ requirement: { id: "req-1", title: "P", version: 1 } }));
    await screen.findByText("pinned v1");
    expect(screen.queryByTestId("review-item-out-of-date")).toBeNull();
  });

  it("outOfDateVersion / reviewOutOfDate only flag a standing review", () => {
    expect(outOfDateVersion(item(), "approved")).toBe(2);
    expect(outOfDateVersion(item(), "in_review")).toBe(2);
    for (const status of ["draft", "rejected", "closed"] as const) {
      expect(outOfDateVersion(item(), status)).toBeNull();
    }
    expect(outOfDateVersion(item({ requirement: null }), "approved")).toBeNull();
    expect(reviewOutOfDate(makeReview())).toBe(true);
    expect(
      reviewOutOfDate(
        makeReview({ items: [item({ requirement: { id: "r", title: "t", version: 1 } })] }),
      ),
    ).toBe(false);
  });

  it("snapshotDiff lists exactly the fields that differ", () => {
    expect(snapshotDiff(PINNED, CURRENT)).toEqual({
      body: { from: PINNED.body, to: CURRENT.body },
    });
    expect(snapshotDiff({ a: null }, { a: undefined, b: 1 })).toEqual({ b: { from: null, to: 1 } });
    expect(snapshotDiff(PINNED, PINNED)).toEqual({});
  });
});

describe("Request re-review", () => {
  it("is offered to the requester or a review admin of an approved, out-of-date review", () => {
    expect(canRequestReReview(makeReview(), REQUESTER)).toBe(true);
    expect(canRequestReReview(makeReview(), ADMIN)).toBe(true);
    expect(canRequestReReview(makeReview(), OTHER_DEVELOPER)).toBe(false);
    expect(canRequestReReview(makeReview({ requestedById: "u-read" }), READER)).toBe(false);
    expect(canRequestReReview(makeReview(), null)).toBe(false);
    // Nothing changed since the approval: nothing to re-review.
    const current = makeReview({
      items: [item({ requirement: { id: "req-1", title: "t", version: 1 } })],
    });
    expect(canRequestReReview(current, REQUESTER)).toBe(false);
    for (const status of ["draft", "in_review", "rejected", "closed"] as const) {
      expect(canRequestReReview(makeReview({ status }), REQUESTER)).toBe(false);
    }
  });

  it("turns every refusal into a sentence", () => {
    const cases: Array<[string, RegExp]> = [
      ["ILLEGAL_REVIEW_TRANSITION", /no longer approved/],
      ["REVIEW_STATE_CHANGED", /changed while the re-review was being requested/],
      ["REVIEW_SCOPE_STALE", /no longer exists/],
      ["NOT_REQUESTER", /Only the person who requested this review/],
      ["REVIEW_NOT_FOUND", /no longer exists, or you no longer have access/],
      ["FORBIDDEN", /not allowed to request reviews/],
    ];
    for (const [code, expected] of cases) {
      expect(reReviewErrorMessage(new ApiError(409, "server text", code))).toMatch(expected);
    }
    expect(reReviewErrorMessage("nope")).toBe("Requesting the re-review failed. Try again.");
  });

  it("asks for confirmation, then re-opens the review and refreshes it", async () => {
    reopenMock.mockResolvedValue(makeReview({ status: "in_review" }));
    const { Wrapper, invalidate } = wrapper();
    render(
      <Wrapper>
        <RequestReReviewButton review={makeReview()} user={REQUESTER} />
      </Wrapper>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Request re-review" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Every reviewer's decision is cleared");
    expect(reopenMock).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Request re-review" }));

    await waitFor(() => expect(reopenMock).toHaveBeenCalledWith("rev-1"));
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        'Re-review requested: "Security sign-off". The reviewers have been asked again.',
      ),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.reviews.all });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.analyses.all });
  });

  it("explains a refusal without claiming success", async () => {
    reopenMock.mockRejectedValue(new ApiError(409, "x", "ILLEGAL_REVIEW_TRANSITION"));
    const { Wrapper } = wrapper();
    render(
      <Wrapper>
        <RequestReReviewButton review={makeReview()} user={REQUESTER} />
      </Wrapper>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Request re-review" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Request re-review" }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls[0][0])).toMatch(/no longer approved/);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("renders nothing for someone the server would refuse", () => {
    const { Wrapper } = wrapper(OTHER_DEVELOPER);
    render(
      <Wrapper>
        <RequestReReviewButton review={makeReview()} user={OTHER_DEVELOPER} />
      </Wrapper>,
    );
    expect(screen.queryByRole("button", { name: "Request re-review" })).toBeNull();
  });
});

describe("the edit's notification", () => {
  it("is a warning: it asks for a re-review", () => {
    const draft = reviewEventToNotification({
      kind: "review_item_changed",
      reviewId: "rev-1",
      userId: "u-req",
      ts: 1,
      title: "Approved requirement changed",
      message: "m",
      href: "/reviews/rev-1",
      notificationId: "n-1",
    });
    expect(draft.level).toBe("warn");
    expect(
      reviewEventToNotification({
        kind: "review_requested",
        reviewId: "rev-1",
        userId: "u-req",
        ts: 1,
        title: "t",
        message: "m",
        href: "/reviews/rev-1",
        notificationId: "n-2",
      }).level,
    ).toBe("info");
  });
});
