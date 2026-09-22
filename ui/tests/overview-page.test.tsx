/**
 * Tests for the project overview page (Issue #423 — async regenerate with a
 * success toast that was previously missing + a generic, user-safe error toast).
 * The page itself is coverage-excluded (thin Next client wrapper), but the
 * terminal-feedback behavior is an explicit AC, so it is asserted here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
import { ApiError } from "@/lib/api-client";
import type { ProjectOverviewWithStats } from "@/lib/projects-api";

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useParams: () => ({ id: "p1" }),
    usePathname: () => "/projects/p1/overview",
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

vi.mock("@/lib/projects-api", () => ({
  projectsApi: {
    get: vi.fn(),
    getOverview: vi.fn(),
    regenerateOverview: vi.fn(),
  },
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (msg: string) => toastSuccess(msg),
    error: (msg: string) => toastError(msg),
  },
}));

import { projectsApi } from "@/lib/projects-api";
import ProjectOverviewPage from "@/app/(authed)/projects/[id]/overview/page";

const getMock = vi.mocked(projectsApi.get);
const getOverviewMock = vi.mocked(projectsApi.getOverview);
const regenMock = vi.mocked(projectsApi.regenerateOverview);

const withStats = (markdown: string, symbolCount: number): ProjectOverviewWithStats => ({
  markdown,
  generatedAt: new Date(0).toISOString(),
  stats: {
    symbolCount,
    edgeCount: 0,
    godNodeCount: 0,
    entryPointCount: 0,
    languages: [],
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockResolvedValue({ id: "p1", name: "WMS" } as Awaited<
    ReturnType<typeof projectsApi.get>
  >);
});

describe("ProjectOverviewPage", () => {
  it("renders existing overview markdown", async () => {
    getOverviewMock.mockResolvedValue({ markdown: "# Overview\nhello", generatedAt: null });
    render(<ProjectOverviewPage />, { wrapper: makeWrapper() });
    // #1371 — markdown is PARSED now, so the `#` is a heading rather than text.
    await waitFor(() =>
      expect(screen.getByTestId("overview-markdown")).toHaveTextContent("Overview"),
    );
    expect(screen.getByTestId("overview-markdown").textContent).not.toContain("# Overview");
  });

  // #29 — exactly one page in a project is named "Overview". The generated
  // markdown opens with its own `# Project Overview — name`, which rendered a
  // second <h1> under the page's "Code Overview" title.
  it("has one <h1>, the page's own, with the generated headings nested beneath it", async () => {
    getOverviewMock.mockResolvedValue({
      markdown: "# Project Overview — WMS\n\n## Summary\n\nbody\n\n```sh\n# not a heading\n```",
      generatedAt: null,
    });
    render(<ProjectOverviewPage />, { wrapper: makeWrapper() });
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 2, name: "Project Overview — WMS" }),
      ).toBeVisible(),
    );
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s.map((h) => h.textContent)).toEqual(["Code Overview — WMS"]);
    expect(screen.getByRole("heading", { level: 3, name: "Summary" })).toBeInTheDocument();
    // Fenced code is content, not structure — it is left exactly as written.
    const body = screen.getByTestId("overview-markdown").textContent ?? "";
    expect(body).toContain("# not a heading");
    expect(body).not.toContain("## not a heading");
  });

  it("regenerates, fires a success toast with the symbol count, and updates the markdown", async () => {
    getOverviewMock.mockRejectedValue(new ApiError(404, "NOT_FOUND", "never generated"));
    regenMock.mockResolvedValue(withStats("# Fresh overview", 42));

    render(<ProjectOverviewPage />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("overview-empty-state")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("overview-regenerate"));
    await waitFor(() => expect(regenMock).toHaveBeenCalledWith("p1"));
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Overview regenerated from 42 symbols."),
    );
    // Markdown is swapped in from the regenerate result.
    await waitFor(() =>
      expect(screen.getByTestId("overview-markdown")).toHaveTextContent("Fresh overview"),
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it("fires a generic, user-safe error toast on regenerate failure", async () => {
    getOverviewMock.mockRejectedValue(new ApiError(404, "NOT_FOUND", "never generated"));
    regenMock.mockRejectedValue(new ApiError(409, "NO_GRAPH", "project not ingested"));

    render(<ProjectOverviewPage />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("overview-empty-state")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("overview-regenerate"));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "The overview regeneration failed. Please try again.",
      ),
    );
    // The toast stays generic — no raw error code/message leaked into it.
    expect(toastError).not.toHaveBeenCalledWith(expect.stringContaining("NO_GRAPH"));
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  // Issue #58 — screen-reader audit. The inline regenerate-failure card is an
  // assertive live region so SR users hear the failure without the toast (which
  // is deliberately kept generic). The page also exposes a single h1.
  it("announces the regenerate-failure card as an alert (#58)", async () => {
    getOverviewMock.mockRejectedValue(new ApiError(404, "NOT_FOUND", "never generated"));
    regenMock.mockRejectedValue(new ApiError(409, "NO_GRAPH", "project not ingested"));

    render(<ProjectOverviewPage />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("overview-empty-state")).toBeInTheDocument());
    // #29 — exactly one project page is named "Overview"; this one is Code Overview.
    expect(
      screen.getByRole("heading", { level: 1, name: /^Code Overview — / }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("overview-regenerate"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Failed to regenerate/);
  });
});
