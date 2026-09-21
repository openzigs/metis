/**
 * CrossProjectImpactSection + ProjectUsageList tests — Epic #295 Phase 4 (#310).
 *
 * Verifies the cross-project views render the projects/usage correctly, that
 * `uncertain` is clearly labelled and visually distinct, that there is NO drop
 * affordance anywhere (safety contract), and the empty states. a11y: each block
 * exposes a labelled region.
 */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type {
  CrossProjectImpactResult,
  CrossProjectObjectUsage,
  ProjectObjectUsage,
} from "@metis/shared";
import {
  CrossProjectImpactSection,
  ProjectUsageList,
} from "@/components/impact/cross-project-impact-section";

function project(over: Partial<ProjectObjectUsage> = {}): ProjectObjectUsage {
  return {
    projectId: "p-1",
    projectName: "Alpha",
    usageClass: "used",
    evidenceCount: 2,
    ...over,
  };
}

function usage(over: Partial<CrossProjectObjectUsage> = {}): CrossProjectObjectUsage {
  return {
    identity: {
      id: "id-1",
      databaseResourceId: "res-1",
      schemaName: "public",
      objectName: "orders",
      objectType: "table",
      usageClass: "used",
    },
    projects: [
      project(),
      project({ projectId: "p-2", projectName: "Beta", usageClass: "uncertain", evidenceCount: 0 }),
    ],
    rollupUsageClass: "used",
    ...over,
  };
}

describe("ProjectUsageList", () => {
  it("renders the canonical name, used-by count, and per-project rows", () => {
    render(<ProjectUsageList usage={usage()} />);
    expect(screen.getByTestId("used-by-count")).toHaveTextContent("used by 2 projects");
    const rows = screen.getAllByTestId("cross-project-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("data-project-id", "p-1");
    expect(within(rows[0]).getByTestId("cross-project-evidence-count")).toHaveTextContent("2 refs");
  });

  it("labels and visually distinguishes uncertain usage", () => {
    render(<ProjectUsageList usage={usage()} />);
    const badges = screen.getAllByTestId("cross-project-usage-badge");
    const uncertain = badges.find((b) => b.getAttribute("data-usage-class") === "uncertain");
    expect(uncertain).toBeDefined();
    expect(uncertain).toHaveAttribute("data-distinct", "true");
    expect(uncertain).toHaveTextContent("Uncertain");
  });

  it("singularizes the count and evidence for one project / one ref", () => {
    render(<ProjectUsageList usage={usage({ projects: [project({ evidenceCount: 1 })] })} />);
    expect(screen.getByTestId("used-by-count")).toHaveTextContent("used by 1 project");
    expect(screen.getByTestId("cross-project-evidence-count")).toHaveTextContent("1 ref");
  });

  it("shows an empty message when no other project uses the object", () => {
    render(<ProjectUsageList usage={usage({ projects: [], rollupUsageClass: "unreferenced" })} />);
    expect(screen.getByTestId("cross-project-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("cross-project-row")).not.toBeInTheDocument();
  });

  it("exposes a labelled region for accessibility and NO drop affordance", () => {
    render(<ProjectUsageList usage={usage()} />);
    expect(
      screen.getByRole("region", { name: /projects using public\.orders/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/drop/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /drop|remove|delete/i })).not.toBeInTheDocument();
  });

  it("renders a bare object name (no schema)", () => {
    render(
      <ProjectUsageList
        usage={usage({
          identity: {
            id: "id-2",
            databaseResourceId: "res-1",
            schemaName: null,
            objectName: "audit_log",
            objectType: "table",
            usageClass: null,
          },
        })}
      />,
    );
    expect(screen.getByRole("region", { name: /projects using audit_log/i })).toBeInTheDocument();
  });
});

function impactResult(over: Partial<CrossProjectImpactResult> = {}): CrossProjectImpactResult {
  return {
    sourceProjectId: "p-src",
    workspaceId: "ws-1",
    affectedObjects: [
      {
        objectName: "orders",
        schemaName: "public",
        objectType: "table",
        alsoUsedByProjects: [project({ projectId: "p-2", projectName: "Beta" })],
      },
    ],
    ...over,
  };
}

describe("CrossProjectImpactSection", () => {
  it("renders each affected object with its sibling projects", () => {
    render(<CrossProjectImpactSection result={impactResult()} />);
    const obj = screen.getByTestId("cross-project-affected-object");
    expect(obj).toHaveAttribute("data-object-name", "public.orders");
    expect(within(obj).getByTestId("cross-project-row")).toHaveAttribute("data-project-id", "p-2");
  });

  it("shows the empty state when no workspace context", () => {
    render(
      <CrossProjectImpactSection result={impactResult({ workspaceId: "", affectedObjects: [] })} />,
    );
    expect(screen.getByTestId("cross-project-impact-empty")).toBeInTheDocument();
  });

  it("shows the empty state when there are no affected objects", () => {
    render(<CrossProjectImpactSection result={impactResult({ affectedObjects: [] })} />);
    expect(screen.getByTestId("cross-project-impact-empty")).toBeInTheDocument();
  });

  it("exposes a labelled region and NO drop affordance", () => {
    render(<CrossProjectImpactSection result={impactResult()} />);
    expect(screen.getByRole("region", { name: /cross-project impact/i })).toBeInTheDocument();
    expect(screen.queryByText(/drop/i)).not.toBeInTheDocument();
  });
});
