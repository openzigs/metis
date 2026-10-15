/**
 * #1129 — Request review can be limited to chosen requirements, and the form
 * says how many it covers before it is sent. On a run from ticked imported
 * items one click keeps only the ticked ones.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch };
});
vi.mock("@/lib/reviews-api", async (orig) => {
  const actual = await orig<typeof import("@/lib/reviews-api")>();
  return { ...actual, reviewsApi: { ...actual.reviewsApi, create: vi.fn(), submit: vi.fn() } };
});

import { reviewsApi } from "@/lib/reviews-api";
import {
  RequestReviewCard,
  tickedRequirementIds,
  type ReviewableRequirement,
} from "@/components/reviews/request-review-card";

const createReview = vi.mocked(reviewsApi.create);
const submitReview = vi.mocked(reviewsApi.submit);

const imported = [{ candidateId: "NR-1" }];
const REQS: ReviewableRequirement[] = [
  { id: "r1", title: "Mark all read", reviewStatus: "approved", sourceItems: imported },
  { id: "r2", title: "Import OPML", reviewStatus: "draft", sourceItems: [] },
  { id: "r3", title: "Per-feed refresh", reviewStatus: "draft", sourceItems: imported },
  { id: "r4", title: "Toggle bookmark", reviewStatus: "approved", sourceItems: [] },
];

function renderCard(requirements: ReviewableRequirement[] | null = REQS) {
  const Wrapper = makeWrapper({ initialUser: null, withAuth: false });
  return render(
    <Wrapper>
      <RequestReviewCard
        projectId="p1"
        requirementIds={REQS.map((r) => r.id)}
        requirements={requirements ?? undefined}
        currentUserId="me"
      />
    </Wrapper>,
  );
}

async function addAnn() {
  fireEvent.change(screen.getByLabelText("Reviewers"), { target: { value: "an" } });
  fireEvent.click(await screen.findByRole("button", { name: "Add Ann" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetch.mockResolvedValue([{ id: "u2", username: "ann", displayName: "Ann" }]);
  createReview.mockResolvedValue({ id: "rev-1" } as never);
  submitReview.mockResolvedValue({ id: "rev-1" } as never);
});

describe("tickedRequirementIds", () => {
  it("keeps only requirements that restate an imported item", () => {
    expect(tickedRequirementIds(REQS)).toEqual(["r1", "r3"]);
    expect(tickedRequirementIds([{ id: "x", title: "x", sourceItems: null }])).toEqual([]);
  });
});

describe("#1129 — Request review limited to chosen requirements", () => {
  it("covers every requirement until some are unchosen, and says so", async () => {
    renderCard();
    fireEvent.click(screen.getByTestId("request-review"));
    expect(screen.getByTestId("request-review-scope")).toHaveTextContent(
      "This review covers 4 of 4 requirements.",
    );

    fireEvent.click(screen.getByLabelText("Import OPML"));
    expect(screen.getByTestId("request-review-scope")).toHaveTextContent(
      "This review covers 3 of 4 requirements.",
    );
    await addAnn();
    fireEvent.click(screen.getByRole("button", { name: "Request review of 3 requirements" }));

    await screen.findByTestId("request-review-done");
    expect(createReview).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({
        items: [{ requirementId: "r1" }, { requirementId: "r3" }, { requirementId: "r4" }],
      }),
    );
  });

  it("keeps only the ticked items in one click, and counts the approved among them", async () => {
    renderCard();
    fireEvent.click(screen.getByTestId("request-review"));
    fireEvent.click(screen.getByRole("button", { name: "Only the 2 from ticked items" }));

    expect(screen.getByTestId("request-review-scope")).toHaveTextContent(
      "This review covers 2 of 4 requirements.",
    );
    expect(screen.getByTestId("request-review-status-note")).toHaveTextContent(
      "1 of them is already approved",
    );
    await addAnn();
    fireEvent.click(screen.getByRole("button", { name: "Request review of 2 requirements" }));
    await screen.findByTestId("request-review-done");
    expect(createReview).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ items: [{ requirementId: "r1" }, { requirementId: "r3" }] }),
    );

    // Choose all restores the whole run.
    fireEvent.click(screen.getByTestId("request-review"));
    fireEvent.click(screen.getByRole("button", { name: "Choose all" }));
    expect(screen.getByTestId("request-review-scope")).toHaveTextContent("covers 4 of 4");
  });

  it("cannot be sent with nothing chosen", async () => {
    renderCard();
    fireEvent.click(screen.getByTestId("request-review"));
    for (const r of REQS) fireEvent.click(screen.getByLabelText(r.title));
    await addAnn();
    expect(screen.getByRole("button", { name: "Request review of 0 requirements" })).toBeDisabled();
  });

  it("offers no chooser without requirement details, and no ticked shortcut on an ordinary run", () => {
    const { unmount } = renderCard(null);
    fireEvent.click(screen.getByTestId("request-review"));
    expect(screen.queryByText("Requirements in this review")).toBeNull();
    unmount();

    renderCard(REQS.map((r) => ({ ...r, sourceItems: null })));
    fireEvent.click(screen.getByTestId("request-review"));
    expect(screen.getByText("Requirements in this review")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /from ticked items/ })).toBeNull();
  });
});
