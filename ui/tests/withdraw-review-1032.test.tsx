/**
 * #1032 — Withdraw review, on the review page and on /reviews.
 *
 * The server route existed (#989); nothing in the UI called it. These tests
 * hold the UI to the server's rule: offered only to the requester or a review
 * administrator, only while the review is in review, behind a confirmation,
 * with every refusal the server can send turned into a sentence.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient } from "@tanstack/react-query";
import { makeWrapper } from "./test-utils";
import type { AuthUser } from "@/lib/auth-types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/lib/reviews-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reviews-api")>("@/lib/reviews-api");
  return {
    ...actual,
    reviewsApi: { list: vi.fn(), get: vi.fn(), decide: vi.fn(), withdraw: vi.fn() },
  };
});

vi.mock("@/lib/history-api", () => ({
  historyApi: {
    list: vi.fn(async () => ({
      versions: [],
      total: 0,
      page: 1,
      pageSize: 100,
      currentVersion: 1,
    })),
    restore: vi.fn(),
    export: vi.fn(),
  },
}));

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useParams: vi.fn(() => ({ id: "rev-1" })),
    useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() })),
    usePathname: vi.fn(() => "/reviews/rev-1"),
    useSearchParams: vi.fn(() => new URLSearchParams()),
  };
});

import { toast } from "sonner";
import { ApiError } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { reviewsApi, type ReviewRequest, type ReviewStatus } from "@/lib/reviews-api";
import {
  canWithdrawReview,
  withdrawErrorMessage,
  WithdrawReviewButton,
} from "@/components/reviews/WithdrawReviewButton";
import ReviewDetailPage from "@/app/(authed)/reviews/[id]/page";
import ReviewsPage from "@/app/(authed)/reviews/page";

const withdrawMock = reviewsApi.withdraw as unknown as ReturnType<typeof vi.fn>;
const getMock = reviewsApi.get as unknown as ReturnType<typeof vi.fn>;
const listMock = reviewsApi.list as unknown as ReturnType<typeof vi.fn>;
const toastSuccess = toast.success as unknown as ReturnType<typeof vi.fn>;
const toastError = toast.error as unknown as ReturnType<typeof vi.fn>;

function user(id: string, role: AuthUser["role"]): AuthUser {
  return { id, username: id, displayName: id, email: `${id}@example.com`, role, permissions: [] };
}
const REQUESTER = user("u-req", "developer");
const OTHER_DEVELOPER = user("u-dev", "developer");
const COORDINATOR = user("u-coord", "coordinator");
const ADMIN = user("u-admin", "admin");
const READER = user("u-read", "reader");

function makeReview(over: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    id: "rev-1",
    projectId: "p-1",
    title: "Sprint 12 sign-off",
    description: "",
    status: "in_review",
    policy: "all",
    quorum: null,
    requestedById: "u-req",
    dueAt: null,
    decidedAt: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
    requestedBy: { id: "u-req", username: "rita", displayName: "Rita Requester" },
    items: [],
    assignments: [
      {
        id: "a-1",
        reviewerId: "u-dev",
        decision: "pending",
        note: null,
        decidedAt: null,
        reviewer: { id: "u-dev", username: "dev", displayName: "Dev Reviewer" },
      },
    ],
    baseline: null,
    ...over,
  };
}

function renderButton(review = makeReview(), as: AuthUser | null = REQUESTER) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const Wrapper = makeWrapper({ initialUser: as, queryClient });
  render(
    <Wrapper>
      <WithdrawReviewButton review={review} user={as} />
    </Wrapper>,
  );
  return { invalidate };
}

beforeEach(() => {
  withdrawMock.mockReset();
  getMock.mockReset();
  listMock.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

describe("canWithdrawReview — mirrors the server's rule", () => {
  it("allows the requester while the review is in review", () => {
    expect(canWithdrawReview(makeReview(), REQUESTER)).toBe(true);
  });

  it("allows a review administrator who did not request it", () => {
    expect(canWithdrawReview(makeReview(), COORDINATOR)).toBe(true);
    expect(canWithdrawReview(makeReview(), ADMIN)).toBe(true);
  });

  it("refuses anyone else, including an assigned reviewer", () => {
    expect(canWithdrawReview(makeReview(), OTHER_DEVELOPER)).toBe(false);
    expect(canWithdrawReview(makeReview(), null)).toBe(false);
    expect(canWithdrawReview(makeReview(), undefined)).toBe(false);
  });

  it("refuses a requester whose role no longer holds review.create", () => {
    // The route checks the permission before it checks who requested it.
    expect(canWithdrawReview(makeReview({ requestedById: "u-read" }), READER)).toBe(false);
  });

  it("refuses every status the state machine has no withdraw from", () => {
    const refused: ReviewStatus[] = ["draft", "approved", "rejected", "closed"];
    for (const status of refused) {
      expect(canWithdrawReview(makeReview({ status }), REQUESTER)).toBe(false);
      expect(canWithdrawReview(makeReview({ status }), ADMIN)).toBe(false);
    }
  });
});

describe("withdrawErrorMessage — every refusal the route can send", () => {
  const cases: Array<[number, string, RegExp]> = [
    [409, "ILLEGAL_REVIEW_TRANSITION", /no longer in review/],
    [409, "REVIEW_STATE_CHANGED", /changed while it was being withdrawn/],
    [403, "NOT_REQUESTER", /Only the person who requested this review/],
    [404, "REVIEW_NOT_FOUND", /no longer exists, or you no longer have access/],
    [403, "FORBIDDEN", /role is not allowed/],
  ];
  for (const [status, code, expected] of cases) {
    it(`${code} reads as a sentence, without the raw code`, () => {
      const message = withdrawErrorMessage(new ApiError(status, "server text", code));
      expect(message).toMatch(expected);
      expect(message).not.toContain(code);
      expect(message).not.toContain("server text");
    });
  }

  it("falls back to the server's message for a code it does not know", () => {
    expect(withdrawErrorMessage(new ApiError(500, "Database is unavailable", "DB_DOWN"))).toBe(
      "Database is unavailable (DB_DOWN)",
    );
    expect(withdrawErrorMessage("nope")).toBe("Withdrawing the review failed. Try again.");
  });
});

describe("<WithdrawReviewButton />", () => {
  it("renders nothing for someone the server would refuse", () => {
    renderButton(makeReview(), OTHER_DEVELOPER);
    expect(screen.queryByRole("button", { name: "Withdraw review" })).toBeNull();
  });

  it("asks for confirmation, saying what withdrawing does, before calling the server", async () => {
    renderButton();
    await userEvent.click(screen.getByRole("button", { name: "Withdraw review" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText('Withdraw "Sprint 12 sign-off"?')).toBeTruthy();
    expect(dialog.textContent).toContain("goes back to a draft");
    expect(dialog.textContent).toContain(
      "Each requirement gets back the review status it had before the review was requested",
    );
    expect(withdrawMock).not.toHaveBeenCalled();
  });

  it("does nothing when the confirmation is cancelled", async () => {
    renderButton();
    await userEvent.click(screen.getByRole("button", { name: "Withdraw review" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(withdrawMock).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("withdraws on confirm, toasts, and refreshes reviews and requirement statuses", async () => {
    withdrawMock.mockResolvedValue(makeReview({ status: "draft" }));
    const { invalidate } = renderButton();
    await userEvent.click(screen.getByRole("button", { name: "Withdraw review" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Withdraw review" }));

    await waitFor(() => expect(withdrawMock).toHaveBeenCalledWith("rev-1"));
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        'Review withdrawn: "Sprint 12 sign-off". Requirement statuses were put back.',
      ),
    );
    expect(withdrawMock).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.reviews.all });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.analyses.all });
    expect(toastError).not.toHaveBeenCalled();
  });

  it("explains a refusal and re-reads the review, without claiming success", async () => {
    withdrawMock.mockRejectedValue(
      new ApiError(
        409,
        'Cannot "withdraw" a review in status "approved"',
        "ILLEGAL_REVIEW_TRANSITION",
      ),
    );
    const { invalidate } = renderButton();
    await userEvent.click(screen.getByRole("button", { name: "Withdraw review" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Withdraw review" }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "This review is no longer in review, so there is nothing to withdraw. Its current status is shown now.",
      ),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.reviews.all });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: queryKeys.analyses.all });
  });
});

describe("review page (/reviews/[id])", () => {
  function renderDetail(review: ReviewRequest, as: AuthUser) {
    getMock.mockResolvedValue({ review, history: [] });
    const Wrapper = makeWrapper({ initialUser: as });
    render(
      <Wrapper>
        <ReviewDetailPage />
      </Wrapper>,
    );
  }

  it("offers Withdraw review to the requester of a review in review", async () => {
    renderDetail(makeReview(), REQUESTER);
    expect(await screen.findByTestId("withdraw-review-rev-1")).toBeTruthy();
  });

  it("offers it to a review administrator who did not request it", async () => {
    renderDetail(makeReview(), COORDINATOR);
    expect(await screen.findByTestId("withdraw-review-rev-1")).toBeTruthy();
  });

  it("does not offer it to the assigned reviewer", async () => {
    renderDetail(makeReview(), OTHER_DEVELOPER);
    await screen.findByTestId("review-header");
    expect(screen.queryByTestId("withdraw-review-rev-1")).toBeNull();
  });

  it("does not offer it on an approved review, even to its requester", async () => {
    renderDetail(makeReview({ status: "approved" }), REQUESTER);
    await screen.findByTestId("review-header");
    expect(screen.queryByTestId("withdraw-review-rev-1")).toBeNull();
  });

  it("stops offering it once the withdraw has gone through", async () => {
    getMock.mockResolvedValueOnce({ review: makeReview(), history: [] });
    getMock.mockResolvedValue({ review: makeReview({ status: "draft" }), history: [] });
    withdrawMock.mockResolvedValue(makeReview({ status: "draft" }));
    const Wrapper = makeWrapper({ initialUser: REQUESTER });
    render(
      <Wrapper>
        <ReviewDetailPage />
      </Wrapper>,
    );
    await userEvent.click(await screen.findByTestId("withdraw-review-rev-1"));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Withdraw review" }));

    await waitFor(() => expect(screen.queryByTestId("withdraw-review-rev-1")).toBeNull());
    expect(screen.getByText(/This review is a draft/)).toBeTruthy();
  });
});

describe("/reviews", () => {
  function renderList(reviews: ReviewRequest[], as: AuthUser) {
    listMock.mockResolvedValue({ reviews, total: reviews.length, page: 1, pageSize: 50 });
    const Wrapper = makeWrapper({ initialUser: as });
    render(
      <Wrapper>
        <ReviewsPage />
      </Wrapper>,
    );
  }

  it("offers Withdraw review only on the rows the server would accept", async () => {
    renderList(
      [
        makeReview({ id: "rev-open" }),
        makeReview({ id: "rev-approved", status: "approved" }),
        makeReview({ id: "rev-draft", status: "draft" }),
        makeReview({ id: "rev-theirs", requestedById: "u-someone" }),
      ],
      REQUESTER,
    );
    expect(await screen.findByTestId("withdraw-review-rev-open")).toBeTruthy();
    for (const id of ["rev-approved", "rev-draft", "rev-theirs"]) {
      expect(screen.queryByTestId(`withdraw-review-${id}`)).toBeNull();
    }
  });

  it("keeps the button outside the row's link, so clicking it does not open the review", async () => {
    renderList([makeReview()], REQUESTER);
    const button = await screen.findByTestId("withdraw-review-rev-1");
    expect(button.closest("a")).toBeNull();
    expect(screen.getByTestId("review-row-rev-1").contains(button)).toBe(false);
  });

  it("withdraws from the row after confirmation and reloads the queue", async () => {
    withdrawMock.mockResolvedValue(makeReview({ status: "draft" }));
    renderList([makeReview()], REQUESTER);
    await userEvent.click(await screen.findByTestId("withdraw-review-rev-1"));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Withdraw review" }));

    await waitFor(() => expect(withdrawMock).toHaveBeenCalledWith("rev-1"));
    await waitFor(() => expect(listMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(toastSuccess).toHaveBeenCalledTimes(1);
  });
});
