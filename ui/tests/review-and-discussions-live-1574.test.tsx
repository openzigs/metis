/**
 * #1574 — walkthrough run 10: the requester's open review page still read
 * "In review" 30 s after the reviewer rejected it, and an open discussions list
 * still read "No discussions yet" two minutes after a teammate started a
 * thread. Both now follow their project room and re-read on the push.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { DiscussionChangedEvent, ReviewChangedEvent } from "@metis/shared";
import type { AuthUser } from "@/lib/auth-types";
import { makeWrapper } from "./test-utils";
import { createFakeSocket, type FakeSocket } from "./helpers/fake-socket";

let socket: FakeSocket | null;
vi.mock("@/lib/socket-client", () => ({
  closeSocket: vi.fn(),
  useSocket: () => socket,
}));

let routeId = "rev-1";
vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useParams: vi.fn(() => ({ id: routeId })),
    useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() })),
    usePathname: vi.fn(() => "/"),
    useSearchParams: vi.fn(() => new URLSearchParams()),
  };
});

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
vi.mock("@/lib/discussions-api", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/discussions-api")>("@/lib/discussions-api");
  return { ...actual, listThreads: vi.fn(), createThread: vi.fn() };
});

import { reviewsApi, type ReviewRequest } from "@/lib/reviews-api";
import { listThreads } from "@/lib/discussions-api";
import ReviewDetailPage from "@/app/(authed)/reviews/[id]/page";
import DiscussionsListPage from "@/app/(authed)/projects/[id]/discussions/page";

const getMock = vi.mocked(reviewsApi.get);
const listThreadsMock = vi.mocked(listThreads);

const REQUESTER: AuthUser = {
  id: "u-req",
  username: "priya",
  displayName: "Priya Analyst",
  email: "priya@example.com",
  role: "developer",
  permissions: [],
};

function review(status: ReviewRequest["status"], decision: "pending" | "rejected"): ReviewRequest {
  return {
    id: "rev-1",
    projectId: "p-1",
    title: "Sign-off",
    description: "",
    status,
    policy: "all",
    quorum: null,
    requestedById: "u-req",
    dueAt: null,
    decidedAt: null,
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
    requestedBy: { id: "u-req", username: "priya", displayName: "Priya Analyst" },
    items: [],
    assignments: [
      {
        id: "a-1",
        reviewerId: "u-coord",
        decision,
        note: decision === "rejected" ? "Change the refresh requirement" : null,
        decidedAt: decision === "rejected" ? "2026-10-30T09:08:52.000Z" : null,
        reviewer: { id: "u-coord", username: "coordinator", displayName: "Test Coordinator" },
      },
    ],
    baseline: null,
  } as ReviewRequest;
}

const reviewChanged = (over: Partial<ReviewChangedEvent> = {}): ReviewChangedEvent => ({
  projectId: "p-1",
  reviewId: "rev-1",
  ts: 1,
  ...over,
});
const discussionChanged = (over: Partial<DiscussionChangedEvent> = {}): DiscussionChangedEvent => ({
  projectId: "p-1",
  threadId: "t-new",
  ts: 1,
  ...over,
});

function thread(id: string, title: string) {
  return {
    id,
    projectId: "p-1",
    title,
    aiResponseMode: "on_mention",
    createdById: "u-sam",
    createdAt: "",
    updatedAt: "",
  } as unknown as Awaited<ReturnType<typeof listThreads>>[number];
}

beforeEach(() => {
  vi.clearAllMocks();
  socket = createFakeSocket();
});

describe("the review page follows review:changed (#1574)", () => {
  function renderReview() {
    routeId = "rev-1";
    const Wrapper = makeWrapper({ initialUser: REQUESTER });
    return render(
      <Wrapper>
        <ReviewDetailPage />
      </Wrapper>,
    );
  }

  it("shows the reviewer's rejection on the open page, without a reload", async () => {
    getMock.mockResolvedValue({ review: review("in_review", "pending"), history: [] });
    renderReview();
    expect(await screen.findByText("In review")).toBeInTheDocument();
    await waitFor(() => expect(socket!.emitted("subscribe:project", { projectId: "p-1" })).toBe(1));

    getMock.mockResolvedValue({ review: review("rejected", "rejected"), history: [] });
    act(() => socket!.fire("review:changed", reviewChanged()));

    expect(await screen.findByText("Change the refresh requirement")).toBeInTheDocument();
    expect(screen.queryByText("In review")).not.toBeInTheDocument();
  });

  it("ignores a change to another review in the project", async () => {
    getMock.mockResolvedValue({ review: review("in_review", "pending"), history: [] });
    renderReview();
    await screen.findByText("In review");
    await waitFor(() => expect(socket!.listeners("review:changed")).toBe(1));

    act(() => socket!.fire("review:changed", reviewChanged({ reviewId: "rev-other" })));

    await new Promise((r) => setTimeout(r, 20));
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it("re-reads after a reconnect, for a change pushed during the gap", async () => {
    getMock.mockResolvedValue({ review: review("in_review", "pending"), history: [] });
    renderReview();
    await screen.findByText("In review");
    await waitFor(() => expect(socket!.listeners("review:changed")).toBe(1));

    act(() => socket!.reconnect());

    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
    expect(socket!.emitted("subscribe:project", { projectId: "p-1" })).toBe(2);
  });

  it("stops listening when the page is left", async () => {
    getMock.mockResolvedValue({ review: review("in_review", "pending"), history: [] });
    const { unmount } = renderReview();
    await waitFor(() => expect(socket!.listeners("review:changed")).toBe(1));
    unmount();
    expect(socket!.listeners("review:changed")).toBe(0);
  });
});

describe("the discussions list follows discussion:changed (#1574)", () => {
  function renderList() {
    routeId = "p-1";
    const Wrapper = makeWrapper({ initialUser: REQUESTER });
    return render(
      <Wrapper>
        <DiscussionsListPage />
      </Wrapper>,
    );
  }

  it("adds a teammate's new thread to the open list, without a reload", async () => {
    listThreadsMock.mockResolvedValue([]);
    renderList();
    expect(await screen.findByText(/No discussions yet/)).toBeInTheDocument();
    expect(socket!.emitted("subscribe:project", { projectId: "p-1" })).toBe(1);

    listThreadsMock.mockResolvedValue([thread("t-new", "Feed refresh timing")]);
    act(() => socket!.fire("discussion:changed", discussionChanged()));

    expect(await screen.findByText("Feed refresh timing")).toBeInTheDocument();
  });

  it("ignores another project's threads", async () => {
    listThreadsMock.mockResolvedValue([]);
    renderList();
    await screen.findByText(/No discussions yet/);

    act(() => socket!.fire("discussion:changed", discussionChanged({ projectId: "p-other" })));

    await new Promise((r) => setTimeout(r, 20));
    expect(listThreadsMock).toHaveBeenCalledTimes(1);
  });

  it("re-reads after a reconnect, and stops listening when the page is left", async () => {
    listThreadsMock.mockResolvedValue([]);
    const { unmount } = renderList();
    await screen.findByText(/No discussions yet/);

    act(() => socket!.reconnect());
    await waitFor(() => expect(listThreadsMock).toHaveBeenCalledTimes(2));

    unmount();
    expect(socket!.listeners("discussion:changed")).toBe(0);
  });

  it("does not subscribe without a socket", async () => {
    socket = null;
    listThreadsMock.mockResolvedValue([]);
    renderList();
    expect(await screen.findByText(/No discussions yet/)).toBeInTheDocument();
  });
});
