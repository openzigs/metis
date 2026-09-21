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

import { prReviewsApi } from "@/lib/pr-reviews-api";
import ProjectPullsPage from "@/app/(authed)/projects/[id]/pulls/page";

const list = prReviewsApi.list as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  list.mockReset();
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
