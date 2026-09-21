/**
 * Workspace traceability rollup component tests — Epic #610 (#626).
 *
 * Covers the pure Mermaid/coverage helpers plus the rendered states: loading,
 * error, empty, the per-project coverage table, the cross-project link map
 * (Mermaid mocked, as elsewhere in the UI suite), and the no-links path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkspaceTraceabilitySummary } from "@metis/shared";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: "<svg><text>link-map</text></svg>" })),
  },
}));

const workspaceSummary = vi.fn();
vi.mock("@/lib/traceability-api", () => ({
  traceabilityApi: {
    workspaceSummary: (...args: unknown[]) => workspaceSummary(...args),
  },
}));

import mermaid from "mermaid";
import {
  WorkspaceTraceabilityRollup,
  buildCrossProjectLinkMermaid,
  formatCoveragePct,
} from "./workspace-traceability-rollup";

const mermaidRender = mermaid.render as unknown as ReturnType<typeof vi.fn>;

const SUMMARY: WorkspaceTraceabilitySummary = {
  projects: [
    {
      projectId: "projA",
      name: "Alpha",
      requirements: 4,
      linkedCrossProject: 1,
      specCoverage: 0.5,
      codeCoverage: 0.25,
    },
    {
      projectId: "projB",
      name: "Beta",
      requirements: 2,
      linkedCrossProject: 1,
      specCoverage: 1,
      codeCoverage: 0,
    },
  ],
  crossProjectLinks: [
    {
      linkId: "L1",
      type: "relates_to",
      source: { requirementId: "r1", projectId: "projA" },
      target: { requirementId: "r2", projectId: "projB" },
    },
  ],
};

function renderRollup(workspaceId = "ws-1") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <WorkspaceTraceabilityRollup workspaceId={workspaceId} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mermaidRender.mockResolvedValue({ svg: "<svg><text>link-map</text></svg>" });
});
afterEach(() => cleanup());

describe("formatCoveragePct", () => {
  it("renders a whole-percent string and clamps to [0,1]", () => {
    expect(formatCoveragePct(0.5)).toBe("50%");
    expect(formatCoveragePct(0)).toBe("0%");
    expect(formatCoveragePct(1)).toBe("100%");
    expect(formatCoveragePct(1.5)).toBe("100%");
    expect(formatCoveragePct(-1)).toBe("0%");
    expect(formatCoveragePct(Number.NaN)).toBe("0%");
  });
});

describe("buildCrossProjectLinkMermaid", () => {
  it("returns null when there are no cross-project links", () => {
    expect(
      buildCrossProjectLinkMermaid({ projects: SUMMARY.projects, crossProjectLinks: [] }),
    ).toBeNull();
  });

  it("emits a graph with project subgraphs, requirement nodes and typed edges", () => {
    const src = buildCrossProjectLinkMermaid(SUMMARY);
    expect(src).toContain("graph LR");
    expect(src).toContain('["Alpha"]');
    expect(src).toContain('["Beta"]');
    expect(src).toContain("R_r1");
    expect(src).toContain("R_r2");
    expect(src).toContain("-->|relates_to|");
  });

  it("sanitizes ids and escapes quotes in labels", () => {
    const src = buildCrossProjectLinkMermaid({
      projects: [
        {
          projectId: "p-1",
          name: 'A"B',
          requirements: 1,
          linkedCrossProject: 1,
          specCoverage: 0,
          codeCoverage: 0,
        },
      ],
      crossProjectLinks: [
        {
          linkId: "L",
          type: "relates_to",
          source: { requirementId: "r-1", projectId: "p-1" },
          target: { requirementId: "r-2", projectId: "p-2" },
        },
      ],
    });
    expect(src).toContain("R_r_1"); // hyphen sanitized to underscore
    expect(src).toContain("A'B"); // quote escaped
  });
});

describe("WorkspaceTraceabilityRollup", () => {
  it("shows a loading state", () => {
    workspaceSummary.mockReturnValue(new Promise(() => {}));
    renderRollup();
    expect(screen.getByTestId("rollup-loading")).toBeInTheDocument();
  });

  it("renders the coverage table and the mermaid link map", async () => {
    workspaceSummary.mockResolvedValue(SUMMARY);
    renderRollup();

    await waitFor(() => expect(screen.getByTestId("rollup-summary-table")).toBeInTheDocument());
    expect(screen.getAllByTestId("rollup-project-row")).toHaveLength(2);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    // Coverage badges: Alpha spec 50%, Beta spec 100%.
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId("rollup-link-map")).toBeInTheDocument());
    expect(mermaid.render).toHaveBeenCalled();
  });

  it("shows a no-links message when there are no cross-project links", async () => {
    workspaceSummary.mockResolvedValue({ projects: SUMMARY.projects, crossProjectLinks: [] });
    renderRollup();
    await waitFor(() => expect(screen.getByTestId("rollup-no-links")).toBeInTheDocument());
    expect(mermaid.render).not.toHaveBeenCalled();
  });

  it("falls back to the mermaid source when rendering fails", async () => {
    mermaidRender.mockRejectedValue(new Error("boom"));
    workspaceSummary.mockResolvedValue(SUMMARY);
    renderRollup();
    await waitFor(() => expect(screen.getByTestId("rollup-mermaid-source")).toBeInTheDocument());
  });

  it("renders an empty state when no accessible projects", async () => {
    workspaceSummary.mockResolvedValue({ projects: [], crossProjectLinks: [] });
    renderRollup();
    await waitFor(() => expect(screen.getByTestId("rollup-empty")).toBeInTheDocument());
  });

  it("renders an error state when the query rejects", async () => {
    workspaceSummary.mockRejectedValue(new Error("nope"));
    renderRollup();
    await waitFor(() => expect(screen.getByTestId("rollup-error")).toBeInTheDocument());
  });
});
