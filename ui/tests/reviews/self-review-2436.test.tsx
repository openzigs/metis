/**
 * Issue #2436 — a requester reviewing their own request, in the UI.
 *
 * The server lets a requester name themselves as a reviewer, and decide, only
 * where the project allows self-approval and they hold `requirement.approve`.
 * The reviewer picker and the review page's decision bar now follow the same
 * rule; anywhere else the requester is still never offered themselves.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { AuthUser } from "@/lib/auth-types";
import { makeWrapper } from "../test-utils";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch };
});
const gateGet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/publishing-api", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  reviewGateApi: { get: gateGet, update: vi.fn() },
}));
vi.mock("@/lib/reviews-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reviews-api")>("@/lib/reviews-api");
  return { ...actual, reviewsApi: { list: vi.fn(), get: vi.fn(), decide: vi.fn() } };
});
vi.mock("@/lib/history-api", () => ({
  historyApi: {
    list: vi.fn(async () => ({ versions: [], total: 0, page: 1, pageSize: 100 })),
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

import { QueryClient } from "@tanstack/react-query";
import { RequestReviewCard } from "@/components/reviews/request-review-card";
import { reviewGateKey } from "@/lib/publishing-api";
import { reviewsApi, type ReviewRequest } from "@/lib/reviews-api";
import ReviewDetailPage, { canDecide } from "@/app/(authed)/reviews/[id]/page";

const me = { id: "u-me", username: "me", displayName: "Me" };
const colleague = { id: "u-col", username: "col", displayName: "Colleague" };
const gate = (allowSelfApproval: boolean) => ({ requireApprovedReview: false, allowSelfApproval });

beforeEach(() => {
  vi.clearAllMocks();
  apiFetch.mockResolvedValue([me, colleague]);
});

describe("the reviewer picker (#2436)", () => {
  function openPicker(canApprove: boolean, queryClient?: QueryClient) {
    const Wrapper = makeWrapper({ withAuth: false, ...(queryClient ? { queryClient } : {}) });
    render(
      <Wrapper>
        <RequestReviewCard
          projectId="p1"
          requirementIds={["r-1"]}
          currentUserId="u-me"
          canApprove={canApprove}
        />
      </Wrapper>,
    );
    fireEvent.click(screen.getByTestId("request-review"));
    fireEvent.change(screen.getByLabelText("Reviewers"), { target: { value: "e" } });
  }

  it("offers the requester when the project allows self-approval and they may approve", async () => {
    gateGet.mockResolvedValue(gate(true));
    openPicker(true);

    expect(await screen.findByRole("button", { name: "Add Me" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Colleague" })).toBeInTheDocument();
    expect(screen.getByTestId("request-review-needs-reviewer")).toHaveTextContent(
      "This project allows self-approval, so you may name yourself.",
    );
    expect(gateGet).toHaveBeenCalledWith("p1");
  });

  it("does not offer them where the project does not allow it", async () => {
    gateGet.mockResolvedValue(gate(false));
    openPicker(true);

    expect(await screen.findByRole("button", { name: "Add Colleague" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Me" })).not.toBeInTheDocument();
    expect(screen.getByTestId("request-review-needs-reviewer")).toHaveTextContent(
      "You can't review your own request.",
    );
  });

  it("does not offer them without requirement.approve even with the setting cached", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(reviewGateKey("p1"), gate(true));
    openPicker(false, qc);

    expect(await screen.findByRole("button", { name: "Add Colleague" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Me" })).not.toBeInTheDocument();
  });

  it("does not offer them without requirement.approve, whatever the project allows", async () => {
    gateGet.mockResolvedValue(gate(true));
    openPicker(false);

    expect(await screen.findByRole("button", { name: "Add Colleague" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Me" })).not.toBeInTheDocument();
    expect(gateGet).not.toHaveBeenCalled();
  });
});

const ownReview = (): ReviewRequest => ({
  id: "rev-1",
  projectId: "p-1",
  title: "Solo sign-off",
  description: "",
  status: "in_review",
  policy: "all",
  quorum: null,
  requestedById: "u-me",
  dueAt: null,
  decidedAt: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  requestedBy: { id: "u-me", username: "me", displayName: "Me" },
  items: [],
  assignments: [
    {
      id: "a-1",
      reviewerId: "u-me",
      decision: "pending",
      note: null,
      decidedAt: null,
      reviewer: { id: "u-me", username: "me", displayName: "Me" },
    },
  ],
  baseline: null,
});

describe("canDecide — the requester's own review (#2436)", () => {
  it("is refused unless self-approval is allowed for them", () => {
    expect(canDecide(ownReview(), "u-me")).toBe(false);
    expect(canDecide(ownReview(), "u-me", true)).toBe(true);
  });
});

describe("the review page's decision bar for the requester (#2436)", () => {
  const ME: AuthUser = {
    id: "u-me",
    username: "me",
    displayName: "Me",
    email: "me@example.test",
    role: "coordinator",
    permissions: ["requirement.approve", "review.decide"],
  };
  function renderPage(user: AuthUser = ME, queryClient?: QueryClient) {
    vi.mocked(reviewsApi.get).mockResolvedValue({ review: ownReview(), history: [] } as never);
    const Wrapper = makeWrapper({ initialUser: user, ...(queryClient ? { queryClient } : {}) });
    render(
      <Wrapper>
        <ReviewDetailPage />
      </Wrapper>,
    );
  }

  it("shows it where the project allows self-approval", async () => {
    gateGet.mockResolvedValue(gate(true));
    renderPage();
    expect(await screen.findByTestId("decision-bar")).toBeInTheDocument();
    expect(gateGet).toHaveBeenCalledWith("p-1");
  });

  it("hides it where the project does not", async () => {
    gateGet.mockResolvedValue(gate(false));
    renderPage();
    await screen.findByRole("heading", { name: "Solo sign-off" });
    await vi.waitFor(() => expect(gateGet).toHaveBeenCalled());
    expect(screen.queryByTestId("decision-bar")).not.toBeInTheDocument();
  });

  // The setting may already be cached (the Publishing page's Approval gate
  // card reads the same key): it alone never lets the requester decide.
  it("hides it from a requester without requirement.approve even with the setting cached", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(reviewGateKey("p-1"), gate(true));
    renderPage({ ...ME, role: "developer", permissions: ["review.decide"] }, qc);
    await screen.findByRole("heading", { name: "Solo sign-off" });
    expect(screen.queryByTestId("decision-bar")).not.toBeInTheDocument();
  });

  it("hides it from a requester without requirement.approve", async () => {
    gateGet.mockResolvedValue(gate(true));
    renderPage({ ...ME, role: "developer", permissions: ["review.decide"] });
    await screen.findByRole("heading", { name: "Solo sign-off" });
    expect(screen.queryByTestId("decision-bar")).not.toBeInTheDocument();
    expect(gateGet).not.toHaveBeenCalled();
  });
});
