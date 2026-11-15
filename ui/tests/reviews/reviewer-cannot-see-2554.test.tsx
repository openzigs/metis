/**
 * #2554 — a reviewer who cannot read a document the chosen requirements rest on
 * is refused by the server (403 `REVIEWER_CANNOT_SEE_ITEMS`, the reviewers in
 * `details.reviewerIds`). The picker marks them with why, blocks the request
 * until they are removed, and offers them no more for those requirements.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "../test-utils";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch };
});
vi.mock("@/lib/reviews-api", async (orig) => {
  const actual = await orig<typeof import("@/lib/reviews-api")>();
  return { ...actual, reviewsApi: { ...actual.reviewsApi, create: vi.fn(), submit: vi.fn() } };
});

import { ApiError } from "@/lib/api-client";
import { reviewsApi } from "@/lib/reviews-api";
import { RequestReviewCard, refusedReviewerIds } from "@/components/reviews/request-review-card";

const createReview = vi.mocked(reviewsApi.create);
const BOB = { id: "u-bob", username: "bob", displayName: "Bob" };
const ROOT = { id: "u-root", username: "root", displayName: "Root" };

const refusal = (reviewerIds: unknown) =>
  new ApiError(403, "One of the reviewers cannot read…", "REVIEWER_CANNOT_SEE_ITEMS", {
    reviewerIds,
  });

beforeEach(() => {
  vi.clearAllMocks();
  apiFetch.mockResolvedValue([BOB, ROOT]);
});

function renderCard() {
  const Wrapper = makeWrapper({ initialUser: null, withAuth: false });
  render(
    <Wrapper>
      <RequestReviewCard projectId="p1" requirementIds={["r-secret"]} currentUserId="u-alice" />
    </Wrapper>,
  );
  fireEvent.click(screen.getByTestId("request-review"));
}

async function add(name: string, term: string) {
  fireEvent.change(screen.getByLabelText("Reviewers"), { target: { value: term } });
  fireEvent.click(await screen.findByRole("button", { name: `Add ${name}` }));
}

describe("refusedReviewerIds", () => {
  it("reads the refused reviewers from that refusal only", () => {
    expect(refusedReviewerIds(refusal(["u-bob", 3]))).toEqual(["u-bob"]);
    expect(refusedReviewerIds(refusal("u-bob"))).toEqual([]);
    expect(refusedReviewerIds(new ApiError(403, "x", "REVIEW_ITEM_RESTRICTED"))).toEqual([]);
    expect(refusedReviewerIds(new Error("x"))).toEqual([]);
  });
});

describe("the reviewer picker when the server refuses a reviewer (#2554)", () => {
  it("marks the refused reviewer with why, blocks the request, and stops offering them", async () => {
    createReview.mockRejectedValueOnce(refusal([BOB.id]));
    renderCard();
    await add("Bob", "bo");
    await add("Root", "ro");
    fireEvent.click(screen.getByRole("button", { name: /Request review of 1 requirement/ }));

    expect(await screen.findByTestId("request-review-blocked")).toHaveTextContent(
      "Bob cannot read a document some of these requirements rest on",
    );
    expect(screen.getByTestId("request-review-reviewer-blocked")).toHaveTextContent("Bob");
    expect(screen.getByRole("button", { name: /Request review of 1 requirement/ })).toBeDisabled();

    // Removing Bob lets the request go, and the picker offers him no more.
    fireEvent.click(screen.getByRole("button", { name: "Remove Bob" }));
    expect(screen.queryByTestId("request-review-blocked")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Request review of 1 requirement/ })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Reviewers"), { target: { value: "b" } });
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining("search=b&")),
    );
    expect(screen.queryByRole("button", { name: "Add Bob" })).not.toBeInTheDocument();
  });

  it("shows any other refusal as the error it is", async () => {
    createReview.mockRejectedValueOnce(new ApiError(403, "Not allowed here", "FORBIDDEN"));
    renderCard();
    await add("Bob", "bo");
    fireEvent.click(screen.getByRole("button", { name: /Request review of 1 requirement/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Not allowed here");
    expect(screen.queryByTestId("request-review-blocked")).not.toBeInTheDocument();
  });
});
