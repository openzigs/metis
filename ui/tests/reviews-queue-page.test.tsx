/**
 * Epic #609 / Issue #618 — review queue page tests (/reviews).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/reviews-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reviews-api")>("@/lib/reviews-api");
  return { ...actual, reviewsApi: { list: vi.fn(), get: vi.fn(), decide: vi.fn() } };
});

import { reviewsApi, type ReviewRequest } from "@/lib/reviews-api";
import ReviewsPage from "@/app/(authed)/reviews/page";

const listMock = reviewsApi.list as unknown as ReturnType<typeof vi.fn>;

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
    dueAt: "2026-08-01T00:00:00.000Z",
    decidedAt: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
    requestedBy: { id: "u-req", username: "requester", displayName: "Rita Requester" },
    items: [
      {
        id: "i-1",
        requirementId: "req-1",
        generatedDocumentId: null,
        pinnedVersion: 1,
        requirement: { id: "req-1", title: "Login", version: 1 },
        generatedDocument: null,
      },
    ],
    assignments: [
      {
        id: "a-1",
        reviewerId: "u-1",
        decision: "pending",
        note: null,
        decidedAt: null,
        reviewer: { id: "u-1", username: "alice", displayName: "Alice" },
      },
    ],
    baseline: null,
    ...over,
  };
}

function page(reviews: ReviewRequest[] = []) {
  return { reviews, total: reviews.length, page: 1, pageSize: 20 };
}

beforeEach(() => {
  listMock.mockReset();
  listMock.mockResolvedValue(page());
});

describe("<ReviewsPage />", () => {
  it("loads the assigned-to-me queue by default", async () => {
    listMock.mockResolvedValueOnce(page([makeReview()]));
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <ReviewsPage />
      </Wrapper>,
    );
    expect(screen.getByRole("heading", { name: "Reviews" })).toBeInTheDocument();
    expect(await screen.findByText("Sprint 12 sign-off")).toBeInTheDocument();
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ assignee: "me" }));
    // Row links to the detail page.
    expect(screen.getByTestId("review-row-rev-1")).toHaveAttribute("href", "/reviews/rev-1");
    // Status + due-date badges.
    expect(screen.getByText("In review")).toBeInTheDocument();
    expect(screen.getByTestId("review-due-badge")).toBeInTheDocument();
  });

  it("switches to the requested-by-me tab", async () => {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <ReviewsPage />
      </Wrapper>,
    );
    await screen.findByText(/No reviews assigned to you/i);
    listMock.mockResolvedValueOnce(page([makeReview({ id: "rev-2", title: "My request" })]));
    fireEvent.click(screen.getByTestId("reviews-tab-requested"));
    expect(await screen.findByText("My request")).toBeInTheDocument();
    expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ requester: "me" }));
  });

  it("shows tab-specific empty states", async () => {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <ReviewsPage />
      </Wrapper>,
    );
    expect(await screen.findByText(/No reviews assigned to you/i)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("reviews-tab-requested"));
    expect(await screen.findByText(/You haven't requested any reviews/i)).toBeInTheDocument();
  });

  it("shows an error state when the queue fails to load", async () => {
    listMock.mockRejectedValue(new Error("boom"));
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <ReviewsPage />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByText(/Failed to load reviews/i)).toBeInTheDocument());
  });

  it("shows a loading state while fetching", () => {
    listMock.mockReturnValue(new Promise(() => {}));
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <ReviewsPage />
      </Wrapper>,
    );
    expect(screen.getByText(/Loading reviews/i)).toBeInTheDocument();
  });

  it("summarises decision progress per row", async () => {
    listMock.mockResolvedValueOnce(
      page([
        makeReview({
          assignments: [
            {
              id: "a-1",
              reviewerId: "u-1",
              decision: "approved",
              note: null,
              decidedAt: null,
              reviewer: { id: "u-1", username: "alice", displayName: "Alice" },
            },
            {
              id: "a-2",
              reviewerId: "u-2",
              decision: "pending",
              note: null,
              decidedAt: null,
              reviewer: { id: "u-2", username: "bob", displayName: "Bob" },
            },
          ],
        }),
      ]),
    );
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <ReviewsPage />
      </Wrapper>,
    );
    expect(await screen.findByText(/1\/2 decisions/i)).toBeInTheDocument();
  });
});
