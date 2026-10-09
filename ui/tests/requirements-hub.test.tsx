/**
 * #28 (epic #26) — the Requirements tab's landing page and the project-scoped
 * Impact Analysis entry under Analyze.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getPermissionsForRole } from "@metis/shared";
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

import { RequirementsHub, defaultHubRunId } from "@/components/requirements/requirements-hub";
import RequirementsPage from "@/app/(authed)/projects/[id]/requirements/page";
import ImpactPage from "@/app/(authed)/projects/[id]/impact/page";
import { analysisApi } from "@/lib/analysis-api";

const list = vi.mocked(analysisApi.listForProject);
const get = vi.mocked(analysisApi.get);

const NONE = { draft: 0, approved: 0, rejected: 0, deferred: 0 };
const run = (id: string, status: string, counts: Partial<typeof NONE> = {}) => ({
  id,
  projectId: "p1",
  startedById: "u",
  status,
  startedAt: "2026-09-01T10:00:00Z",
  completedAt: null,
  totalTokens: 0,
  errorMessage: null,
  requirementCounts: { ...NONE, ...counts },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("defaultHubRunId", () => {
  it("is the newest completed run with requirements, else the newest completed run", () => {
    expect(defaultHubRunId([])).toBeNull();
    expect(defaultHubRunId([run("a2", "running", { draft: 4 })] as never)).toBeNull();
    expect(
      defaultHubRunId([
        run("a3", "completed"),
        run("a2", "cancelled"),
        run("a1", "completed"),
      ] as never),
    ).toBe("a3");
    expect(
      defaultHubRunId([
        run("a4", "running", { draft: 9 }),
        run("a3", "completed"),
        run("a2", "completed", { approved: 16 }),
        run("a1", "completed", { draft: 2 }),
      ] as never),
    ).toBe("a2");
    // A run holding only rejected or deferred requirements still has requirements.
    expect(
      defaultHubRunId([run("a2", "completed"), run("a1", "completed", { deferred: 1 })] as never),
    ).toBe("a1");
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
    list.mockResolvedValue({
      items: [run("a2", "running"), run("a1", "completed", { draft: 3, rejected: 1 })],
    } as never);
    get.mockResolvedValue({ requirements: [] } as never);
    render(<RequirementsHub projectId="p1" />, { wrapper: makeWrapper() });
    await waitFor(() =>
      expect(screen.getByTestId("requirements-count-draft")).toHaveTextContent("3"),
    );
    expect(screen.getByRole("heading", { name: "Latest analysis" })).toBeInTheDocument();
    expect(screen.getByTestId("requirements-count-rejected")).toHaveTextContent("1");
    const review = screen.getByTestId("requirements-review-latest");
    expect(review).toHaveTextContent("Review 3 requirements");
    expect(review).toHaveAttribute("href", "/projects/p1/analysis?analysisId=a1");
    // One completed run: nothing to choose between, nothing skipped.
    expect(screen.queryByTestId("requirements-run-select")).not.toBeInTheDocument();
    expect(screen.queryByTestId("requirements-skipped-empty")).not.toBeInTheDocument();
    // Every run is listed with its tally and deep-linked.
    const runs = screen.getByTestId("requirements-runs");
    expect(runs.querySelectorAll("a")).toHaveLength(2);
    expect(runs.querySelector("a")).toHaveAttribute("href", "/projects/p1/analysis?analysisId=a2");
    expect(runs).toHaveTextContent("completed · 4 requirements");
    await waitFor(() => expect(get).toHaveBeenCalledWith("a1"));
  });

  it("uses the singular and falls back to 'Open' when nothing is waiting", async () => {
    list.mockResolvedValueOnce({ items: [run("a1", "completed", { draft: 1 })] } as never);
    get.mockResolvedValue({ requirements: [] } as never);
    const { unmount } = render(<RequirementsHub projectId="p1" />, { wrapper: makeWrapper() });
    expect(await screen.findByTestId("requirements-review-latest")).toHaveTextContent(
      "Review 1 requirement",
    );
    unmount();
    list.mockResolvedValueOnce({ items: [run("a1", "completed", { approved: 1 })] } as never);
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

  it("#999 — skips a newer empty run, keeps Request review, and lets the user choose the run", async () => {
    list.mockResolvedValue({
      items: [run("new", "completed"), run("old", "completed", { draft: 2, approved: 16 })],
    } as never);
    get.mockImplementation(
      async (id: string) =>
        ({
          requirements: id === "old" ? [{ id: "r1", reviewStatus: "approved" }] : [],
        }) as never,
    );
    const user = {
      id: "me",
      username: "me",
      displayName: "me",
      email: "me@example.test",
      role: "developer" as const,
      permissions: getPermissionsForRole("developer"),
    };
    render(<RequirementsHub projectId="p1" />, {
      wrapper: makeWrapper({ initialUser: user, withAuth: true }),
    });
    await waitFor(() =>
      expect(screen.getByTestId("requirements-count-approved")).toHaveTextContent("16"),
    );
    expect(screen.getByTestId("requirements-count-draft")).toHaveTextContent("2");
    expect(screen.getByRole("heading", { name: "Analysis with requirements" })).toBeInTheDocument();
    expect(screen.getByTestId("requirements-skipped-empty")).toHaveTextContent(
      "The newest completed analysis has no requirements yet",
    );
    expect(screen.getByTestId("requirements-review-latest")).toHaveAttribute(
      "href",
      "/projects/p1/analysis?analysisId=old",
    );
    // The reviewed set is still reviewable from the hub.
    expect(await screen.findByTestId("request-review")).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("old");

    // Choosing the newer run shows its (empty) tally, and Request review goes.
    const select = screen.getByTestId("requirements-run-select") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      expect.stringContaining("0 requirements (0 approved)"),
      expect.stringContaining("18 requirements (16 approved)"),
    ]);
    fireEvent.change(select, { target: { value: "new" } });
    await waitFor(() =>
      expect(screen.getByTestId("requirements-count-approved")).toHaveTextContent("0"),
    );
    expect(screen.getByRole("heading", { name: "Latest analysis" })).toBeInTheDocument();
    expect(screen.queryByTestId("requirements-skipped-empty")).not.toBeInTheDocument();
    expect(screen.getByTestId("requirements-review-latest")).toHaveTextContent(
      "Open latest analysis",
    );
    await waitFor(() => expect(screen.queryByTestId("request-review")).not.toBeInTheDocument());

    // And back to the earlier run, now chosen rather than defaulted to.
    fireEvent.change(select, { target: { value: "old" } });
    expect(await screen.findByTestId("request-review")).toBeInTheDocument();
    expect(screen.queryByTestId("requirements-skipped-empty")).not.toBeInTheDocument();
  });

  it("names an earlier run with nothing waiting 'Open this analysis'", async () => {
    list.mockResolvedValue({
      items: [run("new", "completed"), run("old", "completed", { approved: 2 })],
    } as never);
    get.mockResolvedValue({ requirements: [] } as never);
    render(<RequirementsHub projectId="p1" />, { wrapper: makeWrapper() });
    expect(await screen.findByTestId("requirements-review-latest")).toHaveTextContent(
      "Open this analysis",
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
