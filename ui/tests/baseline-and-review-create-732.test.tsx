/**
 * #732 — the UI can start a requirements review and pin a manual baseline.
 *
 * Before this, `POST /api/projects/:projectId/reviews` and
 * `POST /api/projects/:projectId/baselines` had no caller, and the Baselines
 * page told users to approve a review that nothing could start.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { getPermissionsForRole, type RoleKey } from "@metis/shared";
import type { AuthUser } from "@/lib/auth-types";
import { makeWrapper } from "./test-utils";

vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useParams: () => ({ id: "p1" }),
  usePathname: () => "/projects/p1/baselines",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch };
});
vi.mock("@/lib/baselines-api", async (orig) => {
  const actual = await orig<typeof import("@/lib/baselines-api")>();
  return { ...actual, baselinesApi: { ...actual.baselinesApi, list: vi.fn(), create: vi.fn() } };
});
vi.mock("@/lib/reviews-api", async (orig) => {
  const actual = await orig<typeof import("@/lib/reviews-api")>();
  return { ...actual, reviewsApi: { ...actual.reviewsApi, create: vi.fn(), submit: vi.fn() } };
});
vi.mock("@/lib/analysis-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/analysis-api")>()),
  analysisApi: { listForProject: vi.fn(), get: vi.fn() },
}));

import { ApiError } from "@/lib/api-client";
import { baselinesApi } from "@/lib/baselines-api";
import { reviewsApi } from "@/lib/reviews-api";
import { analysisApi } from "@/lib/analysis-api";
import { NewBaselineForm } from "@/components/baselines/new-baseline-form";
import { RequestReviewCard } from "@/components/reviews/request-review-card";
import { RequirementsHub } from "@/components/requirements/requirements-hub";
import ProjectBaselinesPage from "@/app/(authed)/projects/[id]/baselines/page";

const listBaselines = vi.mocked(baselinesApi.list);
const createBaseline = vi.mocked(baselinesApi.create);
const createReview = vi.mocked(reviewsApi.create);
const submitReview = vi.mocked(reviewsApi.submit);

const userWith = (role: RoleKey, id = "me"): AuthUser => ({
  id,
  username: id,
  displayName: id,
  email: `${id}@example.test`,
  role,
  permissions: getPermissionsForRole(role),
});

function renderWith(
  node: React.ReactElement,
  opts: { user?: AuthUser | null; queryClient?: QueryClient } = {},
) {
  const Wrapper = makeWrapper({
    initialUser: opts.user ?? null,
    withAuth: opts.user !== undefined,
    queryClient: opts.queryClient,
  });
  return render(<Wrapper>{node}</Wrapper>);
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetch.mockReset();
});

describe("NewBaselineForm", () => {
  it("pins a named baseline and refreshes the list", async () => {
    createBaseline.mockResolvedValue({ id: "b1" } as never);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    renderWith(<NewBaselineForm projectId="p1" />, { queryClient });

    fireEvent.click(screen.getByTestId("new-baseline"));
    const submit = screen.getByRole("button", { name: "Create baseline" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  Sprint 4  " } });
    fireEvent.click(submit);

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["baselines", "list", "p1"] }),
    );
    expect(createBaseline).toHaveBeenCalledWith("p1", { name: "Sprint 4" });
    expect(screen.queryByTestId("new-baseline-form")).not.toBeInTheDocument();
  });

  it("sends a description when one is given", async () => {
    createBaseline.mockResolvedValue({ id: "b1" } as never);
    renderWith(<NewBaselineForm projectId="p1" />);
    fireEvent.click(screen.getByTestId("new-baseline"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "A" } });
    fireEvent.change(screen.getByLabelText("Description (optional)"), {
      target: { value: "before UAT" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create baseline" }));
    await waitFor(() =>
      expect(createBaseline).toHaveBeenCalledWith("p1", { name: "A", description: "before UAT" }),
    );
  });

  it("shows the server's refusal and keeps the form open", async () => {
    createBaseline.mockRejectedValue(
      new ApiError(400, "A baseline needs at least one requirement to pin", "EMPTY_BASELINE"),
    );
    renderWith(<NewBaselineForm projectId="p1" />);
    fireEvent.click(screen.getByTestId("new-baseline"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "A" } });
    fireEvent.click(screen.getByRole("button", { name: "Create baseline" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/at least one requirement/);
    expect(screen.getByTestId("new-baseline-form")).toBeInTheDocument();
  });
});

describe("Baselines page", () => {
  beforeEach(() => {
    listBaselines.mockResolvedValue({ baselines: [], total: 0, page: 1, pageSize: 100 });
  });

  it("offers New baseline to a review administrator and says how to get one", async () => {
    renderWith(<ProjectBaselinesPage />, { user: userWith("coordinator") });
    const empty = await screen.findByTestId("baselines-empty");
    expect(screen.getByTestId("new-baseline")).toBeInTheDocument();
    expect(empty).toHaveTextContent(/New baseline/);
    expect(screen.getByRole("link", { name: "Requirements" })).toHaveAttribute(
      "href",
      "/projects/p1/requirements",
    );
  });

  it("does not offer New baseline without review.admin", async () => {
    renderWith(<ProjectBaselinesPage />, { user: userWith("developer") });
    const empty = await screen.findByTestId("baselines-empty");
    expect(screen.queryByTestId("new-baseline")).not.toBeInTheDocument();
    expect(empty).not.toHaveTextContent(/New baseline/);
  });
});

describe("RequestReviewCard", () => {
  const PEOPLE = [
    { id: "me", username: "me", displayName: "Me" },
    { id: "u2", username: "ann", displayName: "Ann" },
    { id: "u3", username: "bo", displayName: "Bo" },
  ];

  async function pick(name: string) {
    fireEvent.change(screen.getByLabelText("Reviewers"), { target: { value: name.slice(0, 2) } });
    fireEvent.click(await screen.findByRole("button", { name: `Add ${name}` }));
  }

  it("opens and submits a review of the requirements with the chosen reviewers", async () => {
    apiFetch.mockResolvedValue(PEOPLE);
    createReview.mockResolvedValue({ id: "rev-1" } as never);
    submitReview.mockResolvedValue({ id: "rev-1" } as never);
    renderWith(
      <RequestReviewCard projectId="p1" requirementIds={["r1", "r2"]} currentUserId="me" />,
    );

    fireEvent.click(screen.getByTestId("request-review"));
    fireEvent.change(screen.getByLabelText("Reviewers"), { target: { value: "a" } });
    await screen.findByRole("button", { name: "Add Ann" });
    // The requester is never offered: the server refuses a self-review.
    expect(screen.queryByRole("button", { name: "Add Me" })).not.toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith("/users?search=a&limit=8&projectId=p1");
    fireEvent.click(screen.getByRole("button", { name: "Add Ann" }));
    // A chosen reviewer leaves the candidate list.
    expect(screen.queryByRole("button", { name: "Add Ann" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Request review of 2 requirements" }));
    const done = await screen.findByTestId("request-review-done");
    expect(createReview).toHaveBeenCalledWith("p1", {
      title: "Requirements review",
      reviewerIds: ["u2"],
      items: [{ requirementId: "r1" }, { requirementId: "r2" }],
    });
    expect(submitReview).toHaveBeenCalledWith("rev-1");
    expect(done.querySelector("a")).toHaveAttribute("href", "/reviews/rev-1");
  });

  it("cannot be sent without a reviewer, and a removed reviewer is not sent", async () => {
    apiFetch.mockResolvedValue(PEOPLE);
    renderWith(<RequestReviewCard projectId="p1" requirementIds={["r1"]} currentUserId="me" />);
    fireEvent.click(screen.getByTestId("request-review"));
    const send = screen.getByRole("button", { name: "Request review of 1 requirement" });
    expect(send).toBeDisabled();
    await pick("Ann");
    expect(send).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove Ann" }));
    expect(send).toBeDisabled();
  });

  it("retries a failed submit on the same draft instead of opening another", async () => {
    apiFetch.mockResolvedValue(PEOPLE);
    createReview.mockResolvedValue({ id: "rev-9" } as never);
    submitReview
      .mockRejectedValueOnce(new ApiError(409, "Review state changed", "REVIEW_STATE_CHANGED"))
      .mockResolvedValueOnce({ id: "rev-9" } as never);
    renderWith(<RequestReviewCard projectId="p1" requirementIds={["r1"]} currentUserId="me" />);
    fireEvent.click(screen.getByTestId("request-review"));
    await pick("Bo");
    const send = screen.getByRole("button", { name: "Request review of 1 requirement" });

    fireEvent.click(send);
    expect(await screen.findByRole("alert")).toHaveTextContent("Review state changed");
    fireEvent.click(send);
    await screen.findByTestId("request-review-done");
    expect(createReview).toHaveBeenCalledTimes(1);
    expect(submitReview).toHaveBeenNthCalledWith(2, "rev-9");
  });

  it("opens a new draft when the reviewers change after a failed submit", async () => {
    apiFetch.mockResolvedValue(PEOPLE);
    createReview
      .mockResolvedValueOnce({ id: "rev-a" } as never)
      .mockResolvedValueOnce({ id: "rev-b" } as never);
    submitReview
      .mockRejectedValueOnce(new ApiError(500, "boom"))
      .mockResolvedValueOnce({ id: "rev-b" } as never);
    renderWith(<RequestReviewCard projectId="p1" requirementIds={["r1"]} currentUserId="me" />);
    fireEvent.click(screen.getByTestId("request-review"));
    await pick("Bo");
    const send = screen.getByRole("button", { name: "Request review of 1 requirement" });
    fireEvent.click(send);
    await screen.findByRole("alert");
    await pick("Ann");
    fireEvent.click(send);
    await screen.findByTestId("request-review-done");
    expect(createReview).toHaveBeenCalledTimes(2);
    expect(createReview.mock.calls[1][1].reviewerIds).toEqual(["u3", "u2"]);
    expect(submitReview).toHaveBeenLastCalledWith("rev-b");
  });
});

describe("Requirements hub", () => {
  const RUN = {
    id: "a1",
    projectId: "p1",
    startedById: "u",
    status: "completed",
    startedAt: "2026-09-01T10:00:00Z",
    completedAt: "2026-09-01T10:05:00Z",
    totalTokens: 0,
    errorMessage: null,
  };

  beforeEach(() => {
    vi.mocked(analysisApi.listForProject).mockResolvedValue({ items: [RUN] } as never);
    vi.mocked(analysisApi.get).mockResolvedValue({
      ...RUN,
      requirements: [
        { id: "r1", reviewStatus: "draft" },
        { id: "r2", reviewStatus: "approved" },
      ],
    } as never);
  });

  it("offers Request review to a user with review.create", async () => {
    renderWith(<RequirementsHub projectId="p1" />, { user: userWith("developer") });
    expect(await screen.findByTestId("request-review")).toBeInTheDocument();
  });

  it("does not offer it to a reader", async () => {
    renderWith(<RequirementsHub projectId="p1" />, { user: userWith("reader") });
    await screen.findByTestId("requirements-count-draft");
    expect(screen.queryByTestId("request-review")).not.toBeInTheDocument();
  });
});
