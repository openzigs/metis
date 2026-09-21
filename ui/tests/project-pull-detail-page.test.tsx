/**
 * Epic #394 P2 review #404 — PR-review detail page tests.
 *
 * Covers: detail rendering, re-run button success, 403 read surface,
 * 403 re-run surface, 404 surface, missing URL params, invalidation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { JobLifecycleEvent } from "@metis/shared";
import { makeWrapper } from "./test-utils";
import { ApiError } from "@/lib/api-client";

const useParamsMock = vi.fn(
  () => ({ id: "p1", prNumber: "42" }) as { id: string; prNumber: string } | null,
);
const useSearchParamsMock = vi.fn(() => new URLSearchParams("owner=acme&repo=proj"));

// Drive the live job-lifecycle hook from the test so we can simulate
// started → progress → completed / failed transitions for the re-review job.
const jobLifecycleMock = vi.fn<(jobId: string | null | undefined) => JobLifecycleEvent | null>(
  () => null,
);
vi.mock("@/hooks/use-job-events", () => ({
  useJobLifecycle: (jobId: string | null | undefined) => jobLifecycleMock(jobId),
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: vi.fn(),
  },
}));

function lifecycle(over: Partial<JobLifecycleEvent>): JobLifecycleEvent {
  return {
    kind: "pr-review",
    jobId: "job-7",
    projectId: "p1",
    status: "progress",
    ts: Date.now(),
    ...over,
  };
}

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useParams: () => useParamsMock(),
    usePathname: () => "/projects/p1/pulls/42",
    useRouter: () => ({
      push: vi.fn(),
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
      refresh: vi.fn(),
    }),
    useSearchParams: () => useSearchParamsMock(),
  };
});

vi.mock("@/lib/pr-reviews-api", () => ({
  prReviewsApi: {
    list: vi.fn(),
    detail: vi.fn(),
    reReview: vi.fn(),
  },
}));

import { prReviewsApi } from "@/lib/pr-reviews-api";
import ProjectPullDetailPage from "@/app/(authed)/projects/[id]/pulls/[prNumber]/page";

const detail = prReviewsApi.detail as unknown as ReturnType<typeof vi.fn>;
const reReview = prReviewsApi.reReview as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  detail.mockReset();
  reReview.mockReset();
  useParamsMock.mockReset();
  useParamsMock.mockReturnValue({ id: "p1", prNumber: "42" });
  useSearchParamsMock.mockReset();
  useSearchParamsMock.mockReturnValue(new URLSearchParams("owner=acme&repo=proj"));
  jobLifecycleMock.mockReset();
  jobLifecycleMock.mockReturnValue(null);
  toastError.mockReset();
});

function review(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "prs_1",
    projectId: "p1",
    repoOwner: "acme",
    repoName: "proj",
    prNumber: 42,
    prUrl: "https://github.com/acme/proj/pull/42",
    lastReviewedSha: "abcdef1234567890",
    lastVerdict: "request_changes",
    lastRunId: "run_1",
    acVerdicts: [
      { acId: "AC-1", verdict: "satisfied", reasoning: "looks good", evidenceFiles: ["src/a.ts"] },
      { acId: "AC-2", verdict: "not_satisfied", reasoning: "missing test", evidenceFiles: [] },
    ],
    acPassRate: 0.5,
    updatedAt: "2026-04-30T18:00:00.000Z",
    createdAt: "2026-04-30T17:00:00.000Z",
    ...overrides,
  };
}

function renderPage() {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <ProjectPullDetailPage />
    </Wrapper>,
  );
}

describe("Project pull detail page", () => {
  it("shows the loading state while the detail query is in flight", () => {
    detail.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getByText(/Loading review/i)).toBeInTheDocument();
  });

  it("renders per-AC verdicts, evidence, reasoning, and the AgentRun deep-link", async () => {
    detail.mockResolvedValue(review());
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("acme/proj#42")).toBeInTheDocument();
    });
    expect(screen.getByText("AC-1")).toBeInTheDocument();
    expect(screen.getByText("AC-2")).toBeInTheDocument();
    expect(screen.getByText("looks good")).toBeInTheDocument();
    expect(screen.getByText("missing test")).toBeInTheDocument();
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("abcdef1")).toBeInTheDocument();
    const runLink = screen.getByRole("link", { name: /AgentRun replay/i });
    expect(runLink).toHaveAttribute("href", "/runs/run_1");
    const ghLink = screen.getByRole("link", { name: /View on GitHub/i });
    expect(ghLink).toHaveAttribute("href", "https://github.com/acme/proj/pull/42");
  });

  it("re-run button calls the API and subscribes to the returned jobId (no 'refresh in a moment' copy)", async () => {
    detail.mockResolvedValue(review());
    reReview.mockResolvedValue({ jobId: "job-7", queueDepth: 1, prNumber: 42 });
    // A progress event is already flowing for this job.
    jobLifecycleMock.mockReturnValue(lifecycle({ status: "progress", progress: 40 }));
    renderPage();
    const btn = await screen.findByTestId("re-run-button");
    await userEvent.click(btn);
    await waitFor(() => {
      expect(screen.getByTestId("re-review-progress")).toBeInTheDocument();
    });
    expect(reReview).toHaveBeenCalledWith("p1", 42, { owner: "acme", name: "proj" });
    // The hook is subscribed to the jobId the POST returned.
    expect(jobLifecycleMock).toHaveBeenCalledWith("job-7");
    // The old "Refresh in a moment…" copy is gone.
    expect(screen.queryByText(/Refresh in a moment/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Re-review enqueued/i)).not.toBeInTheDocument();
  });

  it("shows LIVE progress (spinner + progress bar) from a job:lifecycle event (AC: page-shows-progress)", async () => {
    detail.mockResolvedValue(review());
    reReview.mockResolvedValue({ jobId: "job-7", queueDepth: 1, prNumber: 42 });
    jobLifecycleMock.mockReturnValue(
      lifecycle({ status: "progress", progress: 35, message: "Reviewing PR #42" }),
    );
    renderPage();
    const btn = await screen.findByTestId("re-run-button");
    await userEvent.click(btn);
    await waitFor(() => {
      expect(screen.getByTestId("re-review-spinner")).toBeInTheDocument();
    });
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "35");
    expect(screen.getByText("Reviewing PR #42")).toBeInTheDocument();
    // The button is disabled while the job runs.
    expect(btn).toBeDisabled();
  });

  it("auto-refreshes the verdict on completion WITHOUT a manual refresh (AC: verdict-updates-without-refresh)", async () => {
    // First detail resolve shows the old verdict; after completion the query is
    // invalidated and the next resolve returns the NEW verdict — the user never
    // reloads. The lifecycle hook reports `completed` for the active job, so the
    // page's effect fires invalidateQueries → refetch as soon as the re-review
    // POST sets the active jobId.
    detail
      .mockResolvedValueOnce(review({ lastVerdict: "request_changes" }))
      .mockResolvedValue(review({ lastVerdict: "approve" }));
    reReview.mockResolvedValue({ jobId: "job-7", queueDepth: 1, prNumber: 42 });
    jobLifecycleMock.mockReturnValue(lifecycle({ status: "completed", progress: 100 }));
    renderPage();
    await waitFor(() => expect(screen.getByText("request_changes")).toBeInTheDocument());

    const btn = screen.getByTestId("re-run-button");
    await userEvent.click(btn);

    // The completion effect invalidates the detail query → refetch → new verdict
    // appears with NO manual reload.
    await waitFor(() => {
      expect(screen.getAllByText("approve").length).toBeGreaterThan(0);
    });
    expect(detail.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("surfaces a terminal error toast with the generic message on failure (AC: failure-surfaced)", async () => {
    detail.mockResolvedValue(review());
    reReview.mockResolvedValue({ jobId: "job-7", queueDepth: 1, prNumber: 42 });
    jobLifecycleMock.mockReturnValue(
      lifecycle({
        status: "failed",
        error: "The pull request review failed. Please try again.",
      }),
    );
    renderPage();
    const btn = await screen.findByTestId("re-run-button");
    await userEvent.click(btn);
    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("The pull request review failed. Please try again.");
    });
  });

  it("renders a friendly 403 surface when the detail endpoint returns 403", async () => {
    detail.mockRejectedValue(new ApiError(403, "forbidden", "FORBIDDEN"));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Permission required/i)).toBeInTheDocument();
      expect(screen.getAllByText(/pr.review.read/).length).toBeGreaterThan(0);
    });
  });

  it("renders the no-review-yet surface when the detail endpoint returns 404", async () => {
    detail.mockRejectedValue(new ApiError(404, "not found", "REVIEW_NOT_FOUND"));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/No automated review has been recorded/i)).toBeInTheDocument();
    });
  });

  it("re-run 403 shows a clear missing-permission message instead of a generic error", async () => {
    detail.mockResolvedValue(review());
    reReview.mockRejectedValue(new ApiError(403, "forbidden", "FORBIDDEN"));
    renderPage();
    const btn = await screen.findByTestId("re-run-button");
    await userEvent.click(btn);
    await waitFor(() => {
      expect(screen.getByText(/don't have permission to re-run PR reviews/i)).toBeInTheDocument();
      expect(screen.getByText(/pr.review.manage/)).toBeInTheDocument();
    });
  });

  it("re-run non-403 errors render the underlying error message", async () => {
    detail.mockResolvedValue(review());
    reReview.mockRejectedValue(new ApiError(500, "boom", "INTERNAL"));
    renderPage();
    const btn = await screen.findByTestId("re-run-button");
    await userEvent.click(btn);
    await waitFor(() => {
      expect(screen.getByText(/Re-review failed: boom/i)).toBeInTheDocument();
    });
  });

  it("renders the missing-params message when URL params are incomplete", () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams());
    renderPage();
    expect(screen.getByText(/Missing required URL parameters/i)).toBeInTheDocument();
  });

  it("renders the no-AC empty state when acVerdicts is empty", async () => {
    detail.mockResolvedValue(review({ acVerdicts: [], acPassRate: 0 }));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/No acceptance criteria were captured/i)).toBeInTheDocument();
    });
  });

  it("surfaces unknown errors with a red error line", async () => {
    detail.mockRejectedValue(new Error("network broke"));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load review/i)).toBeInTheDocument();
      expect(screen.getByText(/network broke/)).toBeInTheDocument();
    });
  });
});
