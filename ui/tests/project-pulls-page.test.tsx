/**
 * Epic #394 P2 (#404) — PR review history page tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

const useParamsMock = vi.fn(() => ({ id: "p1" }) as { id: string } | null);

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useParams: () => useParamsMock(),
    usePathname: () => "/projects/p1/pulls",
    useRouter: () => ({
      push: vi.fn(),
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
      refresh: vi.fn(),
    }),
    useSearchParams: () => new URLSearchParams(),
  };
});

vi.mock("@/lib/pr-reviews-api", () => ({
  prReviewsApi: {
    list: vi.fn(),
    detail: vi.fn(),
  },
}));

// #1169 — the page reads the project to say whether automatic review is off.
vi.mock("@/lib/projects-api", () => ({
  projectsApi: { get: vi.fn(), getPrReviewBudget: vi.fn() },
}));

import { prReviewsApi } from "@/lib/pr-reviews-api";
import { projectsApi } from "@/lib/projects-api";
import { ApiError } from "@/lib/api-client";
import ProjectPullsPage from "@/app/(authed)/projects/[id]/pulls/page";

const list = prReviewsApi.list as unknown as ReturnType<typeof vi.fn>;
const getProject = projectsApi.get as unknown as ReturnType<typeof vi.fn>;
const getBudget = projectsApi.getPrReviewBudget as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  list.mockReset();
  getProject.mockReset();
  getProject.mockResolvedValue({ id: "p1", autoReviewPrs: true });
  getBudget.mockReset();
  getBudget.mockResolvedValue({ allowed: true, capCents: null, spentCents: 0, resetAt: "" });
  useParamsMock.mockReset();
  useParamsMock.mockReturnValue({ id: "p1" });
});

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "prs_1",
    projectId: "p1",
    repoOwner: "acme",
    repoName: "proj",
    prNumber: 42,
    prUrl: "https://github.com/acme/proj/pull/42",
    lastReviewedSha: "abcdef1234567890",
    lastVerdict: "approve",
    lastRunId: "run_1",
    acVerdicts: [
      { acId: "AC-1", verdict: "satisfied", reasoning: "ok", evidenceFiles: ["a.ts"] },
      { acId: "AC-2", verdict: "uncertain", reasoning: "??", evidenceFiles: [] },
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
      <ProjectPullsPage />
    </Wrapper>,
  );
}

describe("Project pulls (PR-review history) page", () => {
  it("#1169 — says review is off, and where to turn it on, when the project has it off", async () => {
    getProject.mockResolvedValue({ id: "p1", autoReviewPrs: false });
    list.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("auto-review-off")).toHaveTextContent(
        /Automatic PR review is off/i,
      );
    });
    expect(screen.getByRole("link", { name: /project settings/i })).toHaveAttribute(
      "href",
      "/projects/p1/settings",
    );
    // The "once the webhook fires" promise is not made while review is off.
    expect(screen.queryByText(/once the GitHub webhook fires/i)).toBeNull();
  });

  it("#1169 — says reviews have stopped when this month's limit is reached", async () => {
    getBudget.mockResolvedValue({
      allowed: false,
      capCents: 100,
      spentCents: 150,
      resetAt: "2026-11-01T00:00:00.000Z",
    });
    list.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("auto-review-limit-reached")).toHaveTextContent(
        /limit for automatic PR reviews is reached/i,
      );
    });
  });

  it("#1471 — says reviews are skipped when a limit is set and the model has no price", async () => {
    getBudget.mockResolvedValue({
      allowed: true,
      capCents: 100,
      spentCents: 0,
      resetAt: "2026-11-01T00:00:00.000Z",
      modelPriced: false,
    });
    list.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("auto-review-unpriced")).toHaveTextContent(
        /no price.*MODEL_PRICES.*remove the limit/i,
      );
    });
  });

  it.each([
    ["the model is priced", { capCents: 100, modelPriced: true }],
    ["there is no limit", { capCents: null, modelPriced: false }],
  ])("#1471 — no unpriced notice when %s", async (_label, over) => {
    getBudget.mockResolvedValue({
      allowed: true,
      spentCents: 0,
      resetAt: "2026-11-01T00:00:00.000Z",
      ...over,
    });
    list.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/No PR reviews recorded yet/i)).toBeInTheDocument();
    });
    expect(screen.queryByTestId("auto-review-unpriced")).toBeNull();
  });

  it("#1169 — makes no 'review is off' claim while it is on", async () => {
    list.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/No PR reviews recorded yet/i)).toBeInTheDocument();
    });
    expect(screen.queryByTestId("auto-review-off")).toBeNull();
    expect(screen.queryByTestId("auto-review-limit-reached")).toBeNull();
  });

  it("shows the loading state while the query is in flight", () => {
    list.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getByText(/Loading reviews/i)).toBeInTheDocument();
  });

  it("renders an empty-state when there are no reviews", async () => {
    list.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/No PR reviews recorded yet/i)).toBeInTheDocument();
    });
  });

  it("renders a row per review with deep links", async () => {
    list.mockResolvedValue({ items: [row()], total: 1, limit: 50, offset: 0 });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("acme/proj#42")).toBeInTheDocument();
    });
    const githubLink = screen.getByRole("link", { name: /acme\/proj#42/ });
    expect(githubLink).toHaveAttribute("href", "https://github.com/acme/proj/pull/42");
    const runLink = screen.getByRole("link", { name: /View run/i });
    expect(runLink).toHaveAttribute("href", "/runs/run_1");
    expect(screen.getByText(/50% \(1\/2\)/)).toBeInTheDocument();
    expect(screen.getByText("abcdef1")).toBeInTheDocument();
    expect(screen.getByText("approve")).toBeInTheDocument();
  });

  it("#1470 — a reviewed PR shows its status, its review on GitHub and a link to its details", async () => {
    list.mockResolvedValue({
      items: [
        row({
          lastStatus: "reviewed",
          lastSkipReason: null,
          lastReviewUrl: "https://github.com/acme/proj/pull/42#pullrequestreview-9",
        }),
      ],
      total: 1,
      limit: 50,
      offset: 0,
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("pr-review-status")).toHaveTextContent("Reviewed");
    });
    expect(screen.getByRole("link", { name: "Review on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/acme/proj/pull/42#pullrequestreview-9",
    );
    expect(screen.getByRole("link", { name: /Details/ })).toHaveAttribute(
      "href",
      "/projects/p1/pulls/42?owner=acme&repo=proj",
    );
  });

  it.each([
    ["budget_exceeded", /spending limit for automatic reviews was reached/],
    ["budget_unpriced", /no price.*MODEL_PRICES.*remove the limit/],
    ["no_linked_issue", /does not link an issue/],
    ["no_published_issue", /not published from this project/],
    ["no_acceptance_criteria", /no acceptance criteria/],
    ["diff_too_large", /larger than this project’s review size limit/],
    ["diff_unavailable", /could not be read from GitHub/],
    ["auto_review_disabled", /switched off for this project/],
    ["review_not_configured", /no AI model or GitHub token the review can use/],
    ["something_new", /No reason was recorded/],
    // #1471 — an inherited object key is not a reason.
    ["constructor", /No reason was recorded/],
    ["toString", /No reason was recorded/],
    ["__proto__", /No reason was recorded/],
    [null, /No reason was recorded/],
  ])("#1470 — a PR skipped for %s says so in plain words", async (reason, text) => {
    list.mockResolvedValue({
      items: [
        row({
          lastStatus: "skipped",
          lastSkipReason: reason,
          lastVerdict: null,
          lastReviewUrl: null,
        }),
      ],
      total: 1,
      limit: 50,
      offset: 0,
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("pr-review-status")).toHaveTextContent(/Not reviewed\./);
    });
    expect(screen.getByTestId("pr-review-status")).toHaveTextContent(text);
    expect(screen.queryByRole("link", { name: "Review on GitHub" })).toBeNull();
    // No raw reason code is shown.
    if (reason) expect(screen.queryByText(reason)).toBeNull();
  });

  it("#1470 — a failed review says so; a legacy row with a verdict reads as reviewed", async () => {
    list.mockResolvedValue({
      items: [
        row({ id: "a", prNumber: 1, lastStatus: "failed", lastVerdict: null }),
        row({ id: "b", prNumber: 2, lastStatus: undefined, lastVerdict: "approve" }),
        row({ id: "c", prNumber: 3, lastStatus: undefined, lastVerdict: null }),
      ],
      total: 3,
      limit: 50,
      offset: 0,
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByTestId("pr-review-status")).toHaveLength(3);
    });
    const cells = screen.getAllByTestId("pr-review-status");
    expect(cells[0]).toHaveTextContent(/Review failed/);
    expect(cells[1]).toHaveTextContent("Reviewed");
    expect(cells[2]).toHaveTextContent("—");
  });

  it("#1470 — a review link that is not https is not rendered as a link", async () => {
    list.mockResolvedValue({
      items: [row({ lastStatus: "reviewed", lastReviewUrl: "javascript:alert(1)" })],
      total: 1,
      limit: 50,
      offset: 0,
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("pr-review-status")).toBeInTheDocument();
    });
    expect(screen.queryByRole("link", { name: "Review on GitHub" })).toBeNull();
  });

  it("#1470 — a 403 says the user lacks permission instead of 'try again later'", async () => {
    list.mockRejectedValue(new ApiError(403, "Requires permission pr.review.read", "FORBIDDEN"));
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("pr-reviews-forbidden")).toHaveTextContent(
        /don't have permission to see PR reviews/,
      );
    });
    expect(screen.queryByText(/Try again later/)).toBeNull();
  });

  it("renders an em-dash for AC pass-rate when no verdicts exist", async () => {
    list.mockResolvedValue({
      items: [row({ acVerdicts: [], acPassRate: 0, lastReviewedSha: null, lastRunId: null })],
      total: 1,
      limit: 50,
      offset: 0,
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("acme/proj#42")).toBeInTheDocument();
    });
    // Three em-dashes: AC pass-rate, SHA, run link.
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(3);
  });

  it("renders an error banner when the query fails", async () => {
    list.mockRejectedValue(new Error("boom"));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load reviews/i)).toBeInTheDocument();
    });
  });

  it("renders request_changes and comment verdict badges", async () => {
    list.mockResolvedValue({
      items: [
        row({ id: "prs_2", lastVerdict: "request_changes" }),
        row({ id: "prs_3", lastVerdict: "comment", prNumber: 43 }),
        row({ id: "prs_4", lastVerdict: null, prNumber: 44 }),
      ],
      total: 3,
      limit: 50,
      offset: 0,
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("request_changes")).toBeInTheDocument();
    });
    expect(screen.getByText("comment")).toBeInTheDocument();
  });

  it("renders the project loading state when params are missing", () => {
    useParamsMock.mockReturnValue(null);
    list.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
    renderPage();
    expect(screen.getByText(/Loading project/i)).toBeInTheDocument();
  });

  it("falls back to the raw timestamp when Date parsing throws", async () => {
    const originalDate = globalThis.Date;
    class ThrowingDate extends originalDate {
      constructor(value?: string | number | Date) {
        super(value as never);
        throw new Error("bad date");
      }
      static now() {
        return originalDate.now();
      }
    }
    globalThis.Date = ThrowingDate as unknown as DateConstructor;
    try {
      list.mockResolvedValue({
        items: [row({ updatedAt: "not-a-date" })],
        total: 1,
        limit: 50,
        offset: 0,
      });
      renderPage();
      await waitFor(() => {
        expect(screen.getByText("not-a-date")).toBeInTheDocument();
      });
    } finally {
      globalThis.Date = originalDate;
    }
  });
});
