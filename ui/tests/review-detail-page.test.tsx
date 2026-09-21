/**
 * Epic #609 / Issue #618 — review detail page tests (/reviews/[id]).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
import type { AuthUser } from "@/lib/auth-types";

vi.mock("@/lib/reviews-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reviews-api")>("@/lib/reviews-api");
  return { ...actual, reviewsApi: { list: vi.fn(), get: vi.fn(), decide: vi.fn() } };
});

vi.mock("@/lib/history-api", () => ({
  historyApi: { list: vi.fn(), restore: vi.fn(), export: vi.fn() },
}));

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useParams: vi.fn(() => ({ id: "rev-1" })),
    useRouter: vi.fn(() => ({
      push: vi.fn(),
      replace: vi.fn(),
      refresh: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    })),
    usePathname: vi.fn(() => "/reviews/rev-1"),
    useSearchParams: vi.fn(() => new URLSearchParams()),
  };
});

import { ApiError } from "@/lib/api-client";
import { reviewsApi, type ReviewDetail, type ReviewRequest } from "@/lib/reviews-api";
import { historyApi } from "@/lib/history-api";
import ReviewDetailPage from "@/app/(authed)/reviews/[id]/page";

/** Minimal Response stub for the mocked global fetch — apiFetch reads `.text()`
 *  then JSON.parses it (see ui/src/lib/api-client.ts). */
function okResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    statusText: "OK",
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

const getMock = reviewsApi.get as unknown as ReturnType<typeof vi.fn>;
const decideMock = reviewsApi.decide as unknown as ReturnType<typeof vi.fn>;
const historyListMock = historyApi.list as unknown as ReturnType<typeof vi.fn>;

const REVIEWER: AuthUser = {
  id: "u-rev",
  username: "alice",
  displayName: "Alice Reviewer",
  email: "alice@example.com",
  role: "developer",
  permissions: [],
};

function makeReview(over: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    id: "rev-1",
    projectId: "p-1",
    title: "Sprint 12 sign-off",
    description: "Review before release.",
    status: "in_review",
    policy: "all",
    quorum: null,
    requestedById: "u-req",
    dueAt: null,
    decidedAt: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
    requestedBy: { id: "u-req", username: "rita", displayName: "Rita Requester" },
    items: [
      {
        id: "i-1",
        requirementId: "req-1",
        generatedDocumentId: null,
        pinnedVersion: 2,
        requirement: { id: "req-1", title: "Login requirement", version: 2 },
        generatedDocument: null,
      },
    ],
    assignments: [
      {
        id: "a-1",
        reviewerId: "u-rev",
        decision: "pending",
        note: null,
        decidedAt: null,
        reviewer: { id: "u-rev", username: "alice", displayName: "Alice Reviewer" },
      },
    ],
    baseline: null,
    ...over,
  };
}

function detail(review: ReviewRequest): ReviewDetail {
  return { review, history: [] };
}

beforeEach(() => {
  getMock.mockReset();
  decideMock.mockReset();
  historyListMock.mockReset();
  historyListMock.mockResolvedValue({
    versions: [
      {
        version: 2,
        changedFields: { body: { from: "old body", to: "new body" } },
        actorId: "u-req",
        reason: null,
        createdAt: "2026-06-01T00:00:00.000Z",
        snapshot: { title: "Login requirement", body: "new body" },
      },
    ],
    total: 1,
    page: 1,
    pageSize: 100,
    currentVersion: 2,
  });
});

function renderPage(user: AuthUser = REVIEWER) {
  const Wrapper = makeWrapper({ initialUser: user });
  return render(
    <Wrapper>
      <ReviewDetailPage />
    </Wrapper>,
  );
}

describe("<ReviewDetailPage />", () => {
  it("renders header, item diff, and reviewer panel", async () => {
    getMock.mockResolvedValue(detail(makeReview()));
    renderPage();
    expect(await screen.findByRole("heading", { name: "Sprint 12 sign-off" })).toBeInTheDocument();
    expect(screen.getByText(/Rita Requester/)).toBeInTheDocument();
    expect(await screen.findByTestId("diff-field-body")).toHaveTextContent("old body");
    expect(screen.getByText(/pinned v2/i)).toBeInTheDocument();
    expect(screen.getByText(/\(you\)/)).toBeInTheDocument();
    // Back link to the queue.
    expect(screen.getByRole("link", { name: /Back to reviews/i })).toHaveAttribute(
      "href",
      "/reviews",
    );
  });

  it("records an approval and reflects the state transition without reload", async () => {
    getMock.mockResolvedValue(detail(makeReview()));
    decideMock.mockImplementation(async () => {
      // Subsequent refetches observe the transitioned review.
      getMock.mockResolvedValue(
        detail(
          makeReview({
            status: "approved",
            assignments: [
              {
                id: "a-1",
                reviewerId: "u-rev",
                decision: "approved",
                note: "LGTM",
                decidedAt: "2026-06-03T00:00:00.000Z",
                reviewer: { id: "u-rev", username: "alice", displayName: "Alice Reviewer" },
              },
            ],
          }),
        ),
      );
      return {
        reviewId: "rev-1",
        decision: "approved" as const,
        aggregate: "approved" as const,
        status: "approved" as const,
        baselineId: "b-1",
      };
    });
    renderPage();
    await screen.findByRole("heading", { name: "Sprint 12 sign-off" });
    fireEvent.change(screen.getByLabelText(/Decision note/i), { target: { value: "LGTM" } });
    fireEvent.click(screen.getByRole("button", { name: /Approve/i }));
    await waitFor(() => expect(decideMock).toHaveBeenCalledWith("rev-1", "approved", "LGTM"));
    await waitFor(() => expect(screen.getByText("Approved")).toBeInTheDocument());
    // The decision bar disappears once the caller's decision is recorded.
    expect(screen.queryByRole("button", { name: /Approve/i })).not.toBeInTheDocument();
  });

  it("optimistically shows the caller's decision while the request is in flight", async () => {
    getMock.mockResolvedValue(detail(makeReview()));
    decideMock.mockReturnValue(new Promise(() => {}));
    renderPage();
    await screen.findByRole("heading", { name: "Sprint 12 sign-off" });
    fireEvent.click(screen.getByRole("button", { name: /Reject/i }));
    await waitFor(() =>
      expect(screen.getByTestId("assignment-decision-a-1")).toHaveTextContent(/rejected/i),
    );
  });

  it("rolls back and surfaces an error when the decision fails", async () => {
    getMock.mockResolvedValue(detail(makeReview()));
    decideMock.mockRejectedValue(
      new ApiError(
        409,
        "Your decision for this round was already recorded",
        "DECISION_ALREADY_RECORDED",
      ),
    );
    renderPage();
    await screen.findByRole("heading", { name: "Sprint 12 sign-off" });
    fireEvent.click(screen.getByRole("button", { name: /Approve/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/already recorded/i));
    // Rolled back: the caller's assignment is pending again and actions re-enabled.
    expect(screen.getByTestId("assignment-decision-a-1")).toHaveTextContent(/pending/i);
    expect(screen.getByRole("button", { name: /Approve/i })).toBeEnabled();
  });

  it("uses a generic error message for non-API failures", async () => {
    getMock.mockResolvedValue(detail(makeReview()));
    decideMock.mockRejectedValue(new Error("network down"));
    renderPage();
    await screen.findByRole("heading", { name: "Sprint 12 sign-off" });
    fireEvent.click(screen.getByRole("button", { name: /Approve/i }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/Recording your decision failed/i),
    );
  });

  it("pluralises the scope heading for multi-item reviews", async () => {
    const base = makeReview();
    getMock.mockResolvedValue(
      detail(
        makeReview({
          items: [
            ...base.items,
            {
              id: "i-2",
              requirementId: null,
              generatedDocumentId: "doc-1",
              pinnedVersion: 1,
              requirement: null,
              generatedDocument: { id: "doc-1", title: "System spec" },
            },
          ],
        }),
      ),
    );
    renderPage();
    expect(await screen.findByText(/Scope \(2 items\)/)).toBeInTheDocument();
  });

  it("renders the DecisionBar after a hard reload (identity re-hydrated from /auth/me) (#642)", async () => {
    // Regression for #642: a hard reload remounts AuthProvider with no injected
    // user, so it re-hydrates via GET /auth/me. That response must carry `id`
    // (mapped from the JWT `userId`) — if it returned `userId` instead, `user.id`
    // is undefined, `canDecide` gates false, and the DecisionBar never renders.
    getMock.mockResolvedValue(detail(makeReview()));
    const fetchMock = vi.fn(async () =>
      okResponse({
        success: true,
        data: {
          user: {
            id: "u-rev",
            username: "alice",
            displayName: "Alice Reviewer",
            email: "alice@example.com",
            role: "developer",
            permissions: [],
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      // initialUser: null -> AuthProvider performs the /auth/me probe, exactly
      // as it does on a fresh page load / hard reload.
      const Wrapper = makeWrapper({ initialUser: null });
      render(
        <Wrapper>
          <ReviewDetailPage />
        </Wrapper>,
      );
      // The assigned pending reviewer sees the decision affordance post-reload.
      expect(await screen.findByRole("button", { name: /Approve/i })).toBeInTheDocument();
      expect(screen.getByTestId("decision-bar")).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith("/api/auth/me", expect.any(Object));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("hides the decision bar for non-reviewers", async () => {
    getMock.mockResolvedValue(detail(makeReview()));
    renderPage({ ...REVIEWER, id: "u-other" });
    await screen.findByRole("heading", { name: "Sprint 12 sign-off" });
    expect(screen.queryByRole("button", { name: /Approve/i })).not.toBeInTheDocument();
  });

  it("hides the decision bar when the review is not in_review", async () => {
    getMock.mockResolvedValue(detail(makeReview({ status: "draft" })));
    renderPage();
    await screen.findByRole("heading", { name: "Sprint 12 sign-off" });
    expect(screen.queryByRole("button", { name: /Approve/i })).not.toBeInTheDocument();
    expect(screen.getByText(/has not been submitted for review yet/i)).toBeInTheDocument();
  });

  it("shows an error state when the review fails to load", async () => {
    getMock.mockRejectedValue(new Error("nope"));
    renderPage();
    await waitFor(() => expect(screen.getByText(/Failed to load review/i)).toBeInTheDocument());
  });

  it("shows a loading state while fetching", () => {
    getMock.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByText(/Loading review/i)).toBeInTheDocument();
  });
});
