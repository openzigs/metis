/**
 * Issue #2347 — the Requirements tab as the real list: rows across change
 * requests with their change request, status and review; filters, search and
 * paging sent to the server; approve, edit (with the #2219 warning) and
 * request review from a row; the approval ladder stated once.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { makeWrapper, userWith } from "./test-utils";

const list = vi.hoisted(() => vi.fn());
vi.mock("@/lib/requirements-list-api", () => ({ requirementsListApi: { list } }));
const listForProject = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analysis-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analysis-api")>()),
  analysisApi: { listForProject },
}));
const update = vi.hoisted(() => vi.fn());
vi.mock("@/lib/collaboration-api", () => ({ requirementUpdateApi: { update } }));
const requirementApproval = vi.hoisted(() => vi.fn());
const createReview = vi.hoisted(() => vi.fn());
const submitReview = vi.hoisted(() => vi.fn());
vi.mock("@/lib/reviews-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reviews-api")>()),
  reviewsApi: { requirementApproval, create: createReview, submit: submitReview },
}));
// The review card's reviewer search.
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";
import {
  APPROVE_CONFLICT_MESSAGE,
  EDIT_CONFLICT_MESSAGE,
  RequirementsList,
  REQUIREMENTS_PAGE_SIZE,
  changeRequestName,
} from "@/components/requirements/requirements-list";
import { APPROVAL_LADDER_NOTE } from "@/components/requirements/approval-ladder";

const row = (over: Record<string, unknown> = {}) => ({
  id: "r-1",
  title: "Pay with a saved <b>card</b>",
  body: "Body",
  version: 4,
  reviewStatus: "draft",
  updatedAt: "2026-11-10T00:00:00.000Z",
  changeRequest: { id: "cr-1", title: "Checkout redesign" },
  review: null,
  ...over,
});

function renderList(
  permissions: Parameters<typeof userWith> = ["project.update", "review.create"],
) {
  const Wrapper = makeWrapper({ initialUser: userWith(...permissions) });
  return render(
    <Wrapper>
      <RequirementsList projectId="p1" />
    </Wrapper>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listForProject.mockResolvedValue({
    items: [
      { id: "cr-1", title: "Checkout redesign", startedAt: "2026-11-01T00:00:00.000Z" },
      { id: "cr-2", title: "Refund policy", startedAt: "2026-11-02T00:00:00.000Z" },
    ],
  });
  list.mockResolvedValue({
    items: [
      row(),
      row({
        id: "r-2",
        title: "Refund within 30 days",
        reviewStatus: "approved",
        changeRequest: { id: "cr-2", title: "Refund policy" },
        review: { id: "rev-9", title: "Sign off", status: "rejected" },
      }),
    ],
    total: 2,
    page: 1,
    pageSize: REQUIREMENTS_PAGE_SIZE,
  });
  update.mockResolvedValue({ id: "r-1", version: 5, updatedAt: "x" });
  requirementApproval.mockResolvedValue({
    requirementId: "r-2",
    version: 4,
    reviewStatus: "approved",
    reviews: [],
  });
});

describe("RequirementsList (#2347)", () => {
  it("lists rows with their change request, status and review, titles as text", async () => {
    renderList();
    const first = await screen.findByTestId("requirements-row-r-1");
    expect(first).toHaveTextContent("Pay with a saved <b>card</b>");
    expect(within(first).getByRole("link", { name: "Checkout redesign" })).toHaveAttribute(
      "href",
      "/projects/p1/analysis?analysisId=cr-1",
    );
    expect(screen.getByTestId("requirements-status-r-1")).toHaveTextContent("Awaiting review");
    expect(screen.getByTestId("requirements-review-r-2")).toHaveTextContent("Review rejected");
    expect(screen.getByTestId("requirements-review-r-2")).toHaveAttribute("href", "/reviews/rev-9");
    expect(list).toHaveBeenCalledWith("p1", { page: 1, pageSize: REQUIREMENTS_PAGE_SIZE });
  });

  it("states the ladder once: three rungs, and what Approve does versus a review", async () => {
    renderList();
    const ladder = await screen.findByTestId("approval-ladder");
    expect(within(ladder).getAllByRole("listitem")).toHaveLength(3);
    expect(ladder).toHaveTextContent("Analysis checkpoint");
    expect(ladder).toHaveTextContent("Formal review and baseline");
    expect(screen.getByTestId("approval-ladder-note")).toHaveTextContent(APPROVAL_LADDER_NOTE);
    expect(APPROVAL_LADDER_NOTE).toMatch(/approved ones included/);
  });

  it("sends the change request and status filters, and the search, to the server", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderList();
      await screen.findByTestId("requirements-row-r-1");
      fireEvent.change(screen.getByTestId("requirements-filter-cr"), {
        target: { value: "cr-2" },
      });
      fireEvent.change(screen.getByTestId("requirements-filter-status"), {
        target: { value: "approved" },
      });
      fireEvent.change(screen.getByTestId("requirements-search"), {
        target: { value: " refund " },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      await waitFor(() =>
        expect(list).toHaveBeenLastCalledWith("p1", {
          analysisId: "cr-2",
          status: "approved",
          q: "refund",
          page: 1,
          pageSize: REQUIREMENTS_PAGE_SIZE,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("pages on the server", async () => {
    list.mockResolvedValue({ items: [row()], total: 60, page: 1, pageSize: 25 });
    renderList();
    await waitFor(() =>
      expect(screen.getByTestId("requirements-list-count")).toHaveTextContent(
        "60 requirements · page 1 of 3",
      ),
    );
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith("p1", { page: 2, pageSize: REQUIREMENTS_PAGE_SIZE }),
    );
  });

  it("approves from the row through the guarded PUT, with the version read", async () => {
    renderList();
    fireEvent.click(await screen.findByTestId("requirements-approve-r-1"));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("r-1", { reviewStatus: "approved", version: 4 }),
    );
    // An approved row is not offered Approve again.
    expect(screen.queryByTestId("requirements-approve-r-2")).not.toBeInTheDocument();
  });

  it("edits an approved requirement only after the #2219 warning, then saves", async () => {
    renderList();
    fireEvent.click(await screen.findByTestId("requirements-edit-r-2"));
    expect(await screen.findByTestId("req-edit-approval-warning")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Refund within 14 days" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("r-2", {
        title: "Refund within 14 days",
        body: "Body",
        version: 4,
      }),
    );
  });

  it("requests a review of the ticked rows", async () => {
    renderList();
    await screen.findByTestId("requirements-row-r-1");
    expect(screen.getByTestId("requirements-review-hint")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Choose Pay with a saved <b>card</b> for a review"));
    fireEvent.click(screen.getByTestId("requirements-list-request-review"));
    expect(await screen.findByTestId("request-review-scope")).toHaveTextContent(
      "This review covers 1 of 1 requirement.",
    );
  });

  // ---- #2347 review fixes ---------------------------------------------------

  it("names the list's card for the ticked rows, apart from the summary's card", async () => {
    renderList();
    await screen.findByTestId("requirements-row-r-1");
    fireEvent.click(screen.getByLabelText("Choose Pay with a saved <b>card</b> for a review"));
    const trigger = screen.getByTestId("requirements-list-request-review");
    expect(trigger).toHaveTextContent("Request review of 1 selected");
    // The summary's run-wide card owns no test id of this list's.
    expect(screen.queryByTestId("request-review")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    expect(
      screen.getByRole("heading", { name: "Review 1 selected requirement" }),
    ).toBeInTheDocument();
  });

  it("keeps the edit dialog, and what was typed, open on a 409, and re-reads the list", async () => {
    update.mockRejectedValue(Object.assign(new Error("conflict"), { status: 409 }));
    renderList();
    fireEvent.click(await screen.findByTestId("requirements-edit-r-1"));
    fireEvent.change(await screen.findByLabelText("Title"), {
      target: { value: "My careful rewrite" },
    });
    const callsBefore = list.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByTestId("req-list-edit-error")).toHaveTextContent(
      EDIT_CONFLICT_MESSAGE,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("My careful rewrite");
    expect(toast.error).toHaveBeenCalledWith(EDIT_CONFLICT_MESSAGE);
    // A second save with the stale version would only be refused again.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    // "The list has been read again" is true.
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it("keeps the edit dialog open on any other failure, ready to retry", async () => {
    update.mockRejectedValueOnce(new Error("network"));
    renderList();
    fireEvent.click(await screen.findByTestId("requirements-edit-r-1"));
    fireEvent.change(await screen.findByLabelText("Title"), {
      target: { value: "Kept on failure" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByTestId("req-list-edit-error")).toHaveTextContent(
      "Your text is kept; try again.",
    );
    expect(screen.getByLabelText("Title")).toHaveValue("Kept on failure");
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("says what a 409 on Approve means", async () => {
    update.mockRejectedValue(Object.assign(new Error("conflict"), { status: 409 }));
    renderList();
    fireEvent.click(await screen.findByTestId("requirements-approve-r-1"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(APPROVE_CONFLICT_MESSAGE));
  });

  it("disables only the row being approved, not every row", async () => {
    list.mockResolvedValue({
      items: [row(), row({ id: "r-3", title: "Third" })],
      total: 2,
      page: 1,
      pageSize: REQUIREMENTS_PAGE_SIZE,
    });
    update.mockReturnValue(new Promise(() => {}));
    renderList();
    fireEvent.click(await screen.findByTestId("requirements-approve-r-1"));
    await waitFor(() => expect(screen.getByTestId("requirements-approve-r-1")).toBeDisabled());
    expect(screen.getByTestId("requirements-approve-r-3")).toBeEnabled();
  });

  it("goes to the last page that exists when the total shrinks under the page", async () => {
    list.mockImplementation((_p: string, query: { page: number }) =>
      Promise.resolve({ items: [row({ id: `r-p${query.page}` })], total: 60, page: query.page }),
    );
    renderList();
    await screen.findByTestId("requirements-row-r-p1");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByTestId("requirements-row-r-p2");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByTestId("requirements-row-r-p3");
    // Page 3's only row is approved away: the total falls to two pages' worth.
    list.mockImplementation((_p: string, query: { page: number }) =>
      Promise.resolve({
        items: query.page <= 2 ? [row({ id: `r-p${query.page}` })] : [],
        total: 50,
        page: query.page,
      }),
    );
    fireEvent.click(screen.getByTestId("requirements-approve-r-p3"));
    await waitFor(() =>
      expect(screen.getByTestId("requirements-list-count")).toHaveTextContent(
        "50 requirements · page 2 of 2",
      ),
    );
    expect(await screen.findByTestId("requirements-row-r-p2")).toBeInTheDocument();
  });

  it("keeps the reviewers and title when one more row is ticked, then clears the ticks", async () => {
    list.mockResolvedValue({
      items: [row(), row({ id: "r-3", title: "Third" })],
      total: 2,
      page: 1,
      pageSize: REQUIREMENTS_PAGE_SIZE,
    });
    apiFetch.mockResolvedValue([{ id: "u-col", username: "col", displayName: "Colleague" }]);
    createReview.mockResolvedValue({ id: "rev-new" });
    submitReview.mockResolvedValue({});
    renderList();
    await screen.findByTestId("requirements-row-r-1");
    fireEvent.click(screen.getByLabelText("Choose Pay with a saved <b>card</b> for a review"));
    fireEvent.click(screen.getByTestId("requirements-list-request-review"));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Checkout sign-off" } });
    fireEvent.change(screen.getByLabelText("Reviewers"), { target: { value: "col" } });
    fireEvent.click(await screen.findByRole("button", { name: "Add Colleague" }));

    fireEvent.click(screen.getByLabelText("Choose Third for a review"));

    // Same form: the reviewer and the title survive, and the new row is in scope.
    expect(screen.getByTestId("request-review-scope")).toHaveTextContent(
      "This review covers 2 of 2 requirements.",
    );
    expect(screen.getByLabelText("Title")).toHaveValue("Checkout sign-off");
    expect(screen.getByRole("list", { name: "Selected reviewers" })).toHaveTextContent("Colleague");

    fireEvent.click(screen.getByRole("button", { name: "Request review of 2 requirements" }));
    await waitFor(() =>
      expect(createReview).toHaveBeenCalledWith("p1", {
        title: "Checkout sign-off",
        reviewerIds: ["u-col"],
        items: [{ requirementId: "r-1" }, { requirementId: "r-3" }],
      }),
    );
    // The ticks are cleared, so the same rows are not offered for a duplicate review.
    expect(await screen.findByTestId("requirements-list-review-done")).toHaveTextContent(
      "Review requested.",
    );
    expect(screen.getByLabelText("Choose Third for a review")).not.toBeChecked();
    expect(
      screen.getByLabelText("Choose Pay with a saved <b>card</b> for a review"),
    ).not.toBeChecked();
    expect(screen.queryByTestId("requirements-list-request-review")).not.toBeInTheDocument();
  });

  it("names an untitled change request in the filter as its rows do", async () => {
    listForProject.mockResolvedValue({
      items: [{ id: "cr-9", title: null, startedAt: "2026-11-01T10:00:00.000Z" }],
    });
    renderList();
    expect(
      await screen.findByRole("option", { name: "Analysis of 2026-11-01" }),
    ).toBeInTheDocument();
    expect(changeRequestName({ title: "  ", startedAt: "2026-02-03T00:00:00Z" })).toBe(
      "Analysis of 2026-02-03",
    );
    expect(changeRequestName({ title: " Refunds ", startedAt: "x" })).toBe("Refunds");
  });

  it("says when the search total is a floor, past the server's cap", async () => {
    list.mockResolvedValue({
      items: [row()],
      total: 5000,
      totalIsLowerBound: true,
      page: 1,
      pageSize: REQUIREMENTS_PAGE_SIZE,
    });
    renderList();
    await waitFor(() =>
      expect(screen.getByTestId("requirements-list-count")).toHaveTextContent(
        "5,000+ requirements (the search shows the 5,000 most recently updated matches)",
      ),
    );
  });

  it("offers no writes to a role without them", async () => {
    renderList([]);
    await screen.findByTestId("requirements-row-r-1");
    expect(screen.getByTestId("requirements-approve-r-1")).toBeDisabled();
    expect(screen.getByTestId("requirements-edit-r-1")).toBeDisabled();
    expect(screen.queryByLabelText(/for a review/)).not.toBeInTheDocument();
  });

  it("says when nothing matches, and when the read fails", async () => {
    list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });
    const { unmount } = renderList();
    expect(await screen.findByTestId("requirements-list-empty")).toHaveTextContent(
      "No requirements yet",
    );
    unmount();
    list.mockRejectedValue(new Error("boom"));
    renderList();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load");
  });
});
