/**
 * #28 (epic #26) — the Requirements tab's landing page and the project-scoped
 * Impact Analysis entry under Analyze.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useParams: () => ({ id: "p1" }),
  usePathname: () => "/projects/p1/requirements",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/analysis-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/analysis-api")>()),
  analysisApi: { listForProject: vi.fn(), get: vi.fn() },
}));

import { RequirementsHub, countByReviewStatus } from "@/components/requirements/requirements-hub";
import RequirementsPage from "@/app/(authed)/projects/[id]/requirements/page";
import ImpactPage from "@/app/(authed)/projects/[id]/impact/page";
import { analysisApi } from "@/lib/analysis-api";

const list = vi.mocked(analysisApi.listForProject);
const get = vi.mocked(analysisApi.get);

const run = (id: string, status: string) => ({
  id,
  projectId: "p1",
  startedById: "u",
  status,
  startedAt: "2026-09-01T10:00:00Z",
  completedAt: null,
  totalTokens: 0,
  errorMessage: null,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("countByReviewStatus", () => {
  it("counts each review status", () => {
    expect(
      countByReviewStatus([
        { reviewStatus: "draft" },
        { reviewStatus: "draft" },
        { reviewStatus: "approved" },
        { reviewStatus: "deferred" },
      ]),
    ).toEqual({ draft: 2, approved: 1, rejected: 0, deferred: 1 });
  });
});

describe("<RequirementsHub />", () => {
  it("points an empty project at Requirements Analysis", async () => {
    list.mockResolvedValue({ items: [] } as never);
    render(<RequirementsHub projectId="p1" />, { wrapper: makeWrapper() });
    const empty = await screen.findByTestId("requirements-empty");
    expect(empty).toHaveTextContent("No requirements yet");
    expect(screen.getByRole("link", { name: "Run analysis" })).toHaveAttribute(
      "href",
      "/projects/p1/analysis",
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("counts the latest completed run's requirements and links to it", async () => {
    list.mockResolvedValue({ items: [run("a2", "running"), run("a1", "completed")] } as never);
    get.mockResolvedValue({
      requirements: [
        { reviewStatus: "draft" },
        { reviewStatus: "draft" },
        { reviewStatus: "draft" },
        { reviewStatus: "rejected" },
      ],
    } as never);
    render(<RequirementsHub projectId="p1" />, { wrapper: makeWrapper() });
    await waitFor(() =>
      expect(screen.getByTestId("requirements-count-draft")).toHaveTextContent("3"),
    );
    expect(get).toHaveBeenCalledWith("a1");
    expect(screen.getByTestId("requirements-count-rejected")).toHaveTextContent("1");
    const review = screen.getByTestId("requirements-review-latest");
    expect(review).toHaveTextContent("Review 3 requirements");
    expect(review).toHaveAttribute("href", "/projects/p1/analysis?analysisId=a1");
    // Every run is listed and deep-linked.
    const runs = screen.getByTestId("requirements-runs");
    expect(runs.querySelectorAll("a")).toHaveLength(2);
    expect(runs.querySelector("a")).toHaveAttribute("href", "/projects/p1/analysis?analysisId=a2");
  });

  it("uses the singular and falls back to 'Open' when nothing is waiting", async () => {
    list.mockResolvedValue({ items: [run("a1", "completed")] } as never);
    get.mockResolvedValueOnce({ requirements: [{ reviewStatus: "draft" }] } as never);
    const { unmount } = render(<RequirementsHub projectId="p1" />, { wrapper: makeWrapper() });
    await waitFor(() =>
      expect(screen.getByTestId("requirements-review-latest")).toHaveTextContent(
        "Review 1 requirement",
      ),
    );
    unmount();
    get.mockResolvedValueOnce({ requirements: [{ reviewStatus: "approved" }] } as never);
    render(<RequirementsHub projectId="p1" />, { wrapper: makeWrapper() });
    await waitFor(() =>
      expect(screen.getByTestId("requirements-count-approved")).toHaveTextContent("1"),
    );
    expect(screen.getByTestId("requirements-review-latest")).toHaveTextContent(
      "Open latest analysis",
    );
  });

  it("shows loading, then an error when the list fails", async () => {
    list.mockRejectedValue(new Error("nope"));
    render(<RequirementsHub projectId="p1" />, { wrapper: makeWrapper() });
    expect(screen.getByRole("status")).toHaveTextContent("Loading requirements");
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not load/i);
  });

  it("says it is counting while the latest run loads", async () => {
    list.mockResolvedValue({ items: [run("a1", "completed")] } as never);
    get.mockReturnValue(new Promise(() => {}));
    render(<RequirementsHub projectId="p1" />, { wrapper: makeWrapper() });
    expect(await screen.findByText("Counting requirements…")).toBeInTheDocument();
    expect(screen.getByTestId("requirements-review-latest")).toHaveTextContent(
      "Open latest analysis",
    );
  });
});

describe("project pages", () => {
  it("renders the Requirements page heading around the hub", async () => {
    list.mockResolvedValue({ items: [] } as never);
    render(<RequirementsPage />, { wrapper: makeWrapper() });
    expect(screen.getByRole("heading", { level: 1, name: "Requirements" })).toBeInTheDocument();
    expect(await screen.findByTestId("requirements-empty")).toBeInTheDocument();
  });

  it("starts a project-scoped impact analysis with the project pre-selected", () => {
    render(<ImpactPage />, { wrapper: makeWrapper() });
    expect(screen.getByRole("heading", { level: 1, name: "Impact Analysis" })).toBeInTheDocument();
    expect(screen.getByTestId("project-impact-new")).toHaveAttribute(
      "href",
      "/impact-analyses/new?projectId=p1",
    );
    expect(screen.getByTestId("project-impact-all")).toHaveAttribute("href", "/impact-analyses");
  });
});
