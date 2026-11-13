/**
 * Issue #2347 — the solo analyst: with self-review refused, the reviewer
 * search used to return nothing and the submit stayed disabled with no reason
 * (#2330). The picker now says so, and gives a defined outcome: approval is
 * the end state, and a baseline is taken from it by a review admin (role-aware).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { makeWrapper } from "../test-utils";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch };
});

import { RequestReviewCard, soloOutcome } from "@/components/reviews/request-review-card";

describe("soloOutcome — a defined outcome for each role (#2347)", () => {
  it("a coordinator or admin approves and takes the baseline", () => {
    expect(soloOutcome(true, true)).toMatch(/Approve the requirements directly.*New baseline/);
  });
  it("one who may approve but not baseline is told who can", () => {
    expect(soloOutcome(true, false)).toMatch(/A coordinator or admin can take a baseline/);
  });
  it("a developer, who may do neither, is told to add a colleague or ask a coordinator", () => {
    const text = soloOutcome(false, false);
    expect(text).toMatch(/cannot approve requirements or take a baseline/);
    expect(text).not.toMatch(/Approve the requirements directly/);
  });
});

function renderCard(canBaseline = false, canApprove = canBaseline) {
  const Wrapper = makeWrapper({ withAuth: false });
  render(
    <Wrapper>
      <RequestReviewCard
        projectId="p1"
        requirementIds={["r-1"]}
        currentUserId="u-me"
        canBaseline={canBaseline}
        canApprove={canApprove}
      />
    </Wrapper>,
  );
  fireEvent.click(screen.getByTestId("request-review"));
}

const me = { id: "u-me", username: "me", displayName: "Me" };
const colleague = { id: "u-col", username: "col", displayName: "Colleague" };

beforeEach(() => vi.clearAllMocks());

describe("request review — the solo analyst (#2347)", () => {
  it("says a self-review is refused, and that approval is where it ends", async () => {
    apiFetch.mockResolvedValue([me]);
    renderCard();
    expect(screen.getByTestId("request-review-needs-reviewer")).toHaveTextContent(
      "You can't review your own request.",
    );
    fireEvent.change(screen.getByLabelText("Reviewers"), { target: { value: "me" } });
    expect(await screen.findByTestId("request-review-no-one")).toHaveTextContent(
      "You can't review your own request; add a colleague who can open this project.",
    );
    expect(screen.getByTestId("request-review-solo")).toHaveTextContent(
      "Your role cannot approve requirements or take a baseline. Add a colleague",
    );
  });

  it("tells a review admin they can take the baseline themselves", async () => {
    apiFetch.mockResolvedValue([]);
    renderCard(true);
    fireEvent.change(screen.getByLabelText("Reviewers"), { target: { value: "zed" } });
    expect(await screen.findByTestId("request-review-no-one")).toHaveTextContent(
      'No one else who can open this project matches "zed".',
    );
    expect(screen.getByTestId("request-review-solo")).toHaveTextContent(
      "take a baseline from Baselines → New baseline",
    );
  });

  it("says nothing of the kind when a colleague is offered", async () => {
    apiFetch.mockResolvedValue([me, colleague]);
    renderCard();
    fireEvent.change(screen.getByLabelText("Reviewers"), { target: { value: "co" } });
    expect(await screen.findByRole("button", { name: "Add Colleague" })).toBeInTheDocument();
    expect(screen.queryByTestId("request-review-no-one")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add Colleague" }));
    expect(screen.queryByTestId("request-review-needs-reviewer")).not.toBeInTheDocument();
  });
});
