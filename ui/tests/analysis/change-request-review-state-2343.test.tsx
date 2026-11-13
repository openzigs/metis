/**
 * Issue #2343 — the change request's formal review as a state on the change
 * request: "Review assigned to you" for the reviewer it waits on, "Your review
 * request was rejected" for the analyst who asked, and otherwise where the
 * review stands; each linking to the review. A failed read shows nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "../test-utils";
import { createFakeSocket, type FakeSocket } from "../helpers/fake-socket";

let socket: FakeSocket;
vi.mock("@/lib/socket-client", () => ({
  closeSocket: vi.fn(),
  useSocket: () => socket,
}));

const reviewState = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analysis-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analysis-api")>()),
  analysisApi: { reviewState },
}));

import {
  ChangeRequestReviewState,
  REVIEW_STATUS_LABELS,
  reviewSignals,
} from "@/components/analysis/change-request-review-state";

function renderState() {
  const Wrapper = makeWrapper({ withAuth: false });
  return render(
    <Wrapper>
      <ChangeRequestReviewState projectId="p1" analysisId="an-1" />
    </Wrapper>,
  );
}

const review = (status: "draft" | "in_review" | "rejected" | "approved", requestedByMe = true) => ({
  id: "rev-1",
  title: "Sign off <b>checkout</b>",
  status,
  requestedByMe,
});

beforeEach(() => {
  vi.clearAllMocks();
  socket = createFakeSocket();
});

describe("reviewSignals", () => {
  it("says nothing without a review", () => {
    expect(reviewSignals({ review: null, assignedToMe: null })).toEqual([]);
  });

  it("puts a review waiting on the caller first, and does not repeat it", () => {
    const signals = reviewSignals({
      review: review("in_review", false),
      assignedToMe: { id: "rev-1", title: "Sign off" },
    });
    expect(signals.map((s) => s.label)).toEqual(["Review assigned to you"]);
    expect(signals[0].needsYou).toBe(true);
  });

  it("names a rejection of the caller's own request, and only theirs", () => {
    expect(reviewSignals({ review: review("rejected"), assignedToMe: null })[0]).toMatchObject({
      key: "rejected",
      label: "Your review request was rejected",
      needsYou: true,
    });
    expect(
      reviewSignals({ review: review("rejected", false), assignedToMe: null })[0],
    ).toMatchObject({ label: REVIEW_STATUS_LABELS.rejected, needsYou: false });
  });

  it("shows the caller's own rejection when someone else's review is newer", () => {
    const signals = reviewSignals({
      review: { ...review("draft", false), id: "rev-2", title: "Second look" },
      mine: { id: "rev-1", title: "Sign off", status: "rejected" },
      assignedToMe: null,
    });
    expect(signals.map((s) => [s.key, s.reviewId])).toEqual([
      ["rejected", "rev-1"],
      ["draft", "rev-2"],
    ]);
    expect(signals[0]).toMatchObject({
      label: "Your review request was rejected",
      needsYou: true,
    });
    // The same rejected review as the latest: said once.
    expect(
      reviewSignals({
        review: review("rejected"),
        mine: { id: "rev-1", title: "Sign off", status: "rejected" },
        assignedToMe: null,
      }).map((s) => s.key),
    ).toEqual(["rejected"]);
  });

  it("drops my old rejection once a newer review of the change request is approved", () => {
    expect(
      reviewSignals({
        review: { ...review("approved", false), id: "rev-2", title: "Second look" },
        mine: { id: "rev-1", title: "Sign off", status: "rejected" },
        assignedToMe: null,
      }).map((s) => [s.key, s.reviewId]),
    ).toEqual([["approved", "rev-2"]]);
  });

  it("gives my rejection and someone else's newer rejection distinct keys", () => {
    const keys = reviewSignals({
      review: { ...review("rejected", false), id: "rev-2", title: "Second look" },
      mine: { id: "rev-1", title: "Sign off", status: "rejected" },
      assignedToMe: null,
    }).map((s) => s.key);
    expect(keys).toEqual(["rejected", "rejected-latest"]);
  });

  it("names every other status in words", () => {
    for (const status of ["draft", "in_review", "approved"] as const) {
      expect(reviewSignals({ review: review(status), assignedToMe: null })[0].label).toBe(
        REVIEW_STATUS_LABELS[status],
      );
    }
  });
});

describe("ChangeRequestReviewState", () => {
  it("shows the reviewer their assignment with a link to the review, title as text", async () => {
    reviewState.mockResolvedValue({
      review: review("in_review", false),
      assignedToMe: { id: "rev-1", title: "Sign off <b>checkout</b>" },
    });
    renderState();
    const item = await screen.findByTestId("change-request-review-assigned");
    expect(item).toHaveTextContent("Review assigned to you");
    expect(item).toHaveTextContent("Sign off <b>checkout</b>");
    expect(screen.getByRole("link", { name: "Open review" })).toHaveAttribute(
      "href",
      "/reviews/rev-1",
    );
    expect(reviewState).toHaveBeenCalledWith("p1", "an-1");
  });

  it("shows the requester a rejection", async () => {
    reviewState.mockResolvedValue({ review: review("rejected"), assignedToMe: null });
    renderState();
    expect(await screen.findByTestId("change-request-review-rejected")).toHaveTextContent(
      "Your review request was rejected",
    );
  });

  it("re-reads when a review is decided, so a rejection shows without a reload", async () => {
    reviewState.mockResolvedValue({ review: review("in_review"), assignedToMe: null });
    renderState();
    expect(await screen.findByTestId("change-request-review-in_review")).toBeInTheDocument();
    reviewState.mockResolvedValue({ review: review("rejected"), assignedToMe: null });
    act(() => socket.fire("review:notification", { reviewRequestId: "rev-1" }));
    expect(await screen.findByTestId("change-request-review-rejected")).toBeInTheDocument();
    reviewState.mockResolvedValue({ review: review("approved"), assignedToMe: null });
    act(() => socket.fire("review:changed", { reviewRequestId: "rev-1" }));
    expect(await screen.findByTestId("change-request-review-approved")).toBeInTheDocument();
  });

  it("renders nothing with no review, or when the read fails", async () => {
    reviewState.mockResolvedValue({ review: null, assignedToMe: null });
    const { container, unmount } = renderState();
    await waitFor(() => expect(reviewState).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="change-request-review-state"]')).toBeNull();
    unmount();

    reviewState.mockRejectedValue(new Error("403"));
    const second = renderState();
    await waitFor(() => expect(reviewState).toHaveBeenCalledTimes(2));
    expect(
      second.container.querySelector('[data-testid="change-request-review-state"]'),
    ).toBeNull();
  });
});
