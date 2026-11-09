/**
 * #2115 — cross-project impact through product API edges, in the UI: the
 * provider's section names the consumer with its citing method, and a
 * consumer item a provider's change left untouched carries a low-confidence
 * banner. Fixture shaped like the #2105 walkthrough's Miniflux pair.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type {
  ApiConsumerImpact,
  ApiEdgeImpactResult,
  CrossProjectImpactResult,
  ImpactItemView,
} from "@metis/shared";
import { CrossProjectImpactSection } from "@/components/impact/cross-project-impact-section";
import { ProjectImpactSection } from "@/components/impact/project-impact-section";
import { ChangedRequirementGroup } from "@/components/impact/changed-requirement-group";

vi.mock("@/lib/impact-analysis-hooks", () => ({
  useProjectUsageClassification: vi.fn(() => ({ data: undefined })),
  useCrossProjectImpact: vi.fn(() => ({ data: null, isLoading: false, isError: false })),
}));

const V2 = "p-v2";
const CLIENT = "p-client";

function consumer(over: Partial<ApiConsumerImpact> = {}): ApiConsumerImpact {
  return {
    edgeId: "e1",
    edgeOrigin: "declared",
    edgeStrength: "contract",
    providerProjectId: V2,
    providerProjectName: "miniflux/v2",
    providerItemId: "i-v2",
    changeTitle: "Update Entry API takes more fields",
    consumerProjectId: CLIENT,
    consumerProjectName: "miniflux/python-client",
    apiSurfaceFiles: ["internal/api/entry.go", "internal/api/payload.go"],
    citingMethods: [
      {
        qualifiedName: "Client::update_entry",
        filePath: "miniflux.py",
        startLine: 658,
        endLine: 685,
        confidence: 0.97,
        source: "run",
      },
    ],
    ...over,
  };
}

function item(id: string, projectId: string): ImpactItemView {
  return {
    id,
    projectId,
    requirementId: null,
    requirementTitle: "Pagination breaks on the unread page",
    changeType: "modified",
    severity: "medium",
    impactScore: 0.4,
    confidence: 1,
    matchQuality: "strong",
    matchQualityReason: null,
    affectedFileCount: 1,
    affectedSymbolCount: 1,
    affectedSymbols: [
      {
        id: `s-${id}`,
        codeSymbolId: null,
        filePath: "miniflux.py",
        qualifiedName: "Client::flush_history",
        startLine: 1,
        endLine: 2,
        relation: "direct",
        depth: 0,
        confidence: 1,
      },
    ],
    affectedTables: [],
    affectedTablesSecondary: [],
    affectedTests: [],
    writePathGaps: [],
    editCandidateFiles: [],
    blastRadiusFiles: [],
    droppedColumnProposals: [],
    optionalColumnProposals: [],
    uncheckedColumnProposals: [],
    feedback: [],
    summary: null,
  } as unknown as ImpactItemView;
}

const noShared: CrossProjectImpactResult = {
  sourceProjectId: V2,
  workspaceId: "ws-1",
  affectedObjects: [],
};

describe("CrossProjectImpactSection — API consumers", () => {
  it("names the consumer, the edge, the API files touched and the citing method", () => {
    render(<CrossProjectImpactSection result={noShared} apiConsumers={[consumer()]} />);
    expect(screen.queryByTestId("cross-project-impact-empty")).toBeNull();
    const row = screen.getByTestId("api-consumer-row");
    expect(row).toHaveAttribute("data-project-id", CLIENT);
    expect(row).toHaveTextContent("miniflux/python-client calls this project's API");
    expect(row).toHaveTextContent("(declared, contract API edge)");
    expect(row).toHaveTextContent("Update Entry API takes more fields");
    expect(within(row).getByTestId("api-surface-files")).toHaveTextContent(
      "internal/api/entry.go, internal/api/payload.go",
    );
    expect(within(row).getByTestId("api-citing-method")).toHaveTextContent(
      "Client::update_entry miniflux.py:658-685 · 97%",
    );
  });

  it("says when the citing method is not known", () => {
    render(
      <CrossProjectImpactSection
        result={null}
        apiConsumers={[consumer({ citingMethods: [], edgeStrength: null, changeTitle: null })]}
      />,
    );
    expect(screen.getByTestId("api-citing-none")).toHaveTextContent(
      "Add miniflux/python-client to the run to find it.",
    );
    expect(screen.getByTestId("api-consumer-row")).toHaveTextContent("(declared API edge)");
  });

  it("renders evidence citations by file and line", () => {
    const evidence = consumer({
      citingMethods: [
        {
          qualifiedName: null,
          filePath: "miniflux.py",
          startLine: 660,
          endLine: 660,
          confidence: null,
          source: "edge-evidence",
        },
        {
          qualifiedName: null,
          filePath: "client.py",
          startLine: null,
          endLine: null,
          confidence: null,
          source: "edge-evidence",
        },
        {
          qualifiedName: "Client::x",
          filePath: "x.py",
          startLine: 3,
          endLine: null,
          confidence: 0.5,
          source: "run",
        },
      ],
    });
    render(<CrossProjectImpactSection result={null} apiConsumers={[evidence]} />);
    const rows = screen.getAllByTestId("api-citing-method");
    expect(rows[0]).toHaveTextContent("miniflux.py:660 · from the edge's evidence");
    expect(rows[1]).toHaveTextContent("client.py · from the edge's evidence");
    expect(rows[2]).toHaveTextContent("Client::x x.py:3 · 50%");
  });

  it("lists API consumers alongside shared objects", () => {
    const shared: CrossProjectImpactResult = {
      ...noShared,
      affectedObjects: [
        {
          objectName: "entries",
          schemaName: "public",
          objectType: "table",
          alsoUsedByProjects: [
            { projectId: "p-x", projectName: "Other", usageClass: "used", evidenceCount: 1 },
          ],
        },
      ],
    };
    render(<CrossProjectImpactSection result={shared} apiConsumers={[consumer()]} />);
    expect(screen.getByTestId("api-consumer-row")).toBeInTheDocument();
    expect(screen.getByTestId("cross-project-affected-object")).toBeInTheDocument();
  });

  it("keeps the empty state with neither", () => {
    render(<CrossProjectImpactSection result={null} />);
    expect(screen.getByTestId("cross-project-impact-empty")).toBeInTheDocument();
  });

  it("still shows no shared objects for a result with no workspace", () => {
    const noWorkspace: CrossProjectImpactResult = {
      sourceProjectId: V2,
      workspaceId: "",
      affectedObjects: [
        { objectName: "entries", schemaName: null, objectType: "table", alsoUsedByProjects: [] },
      ],
    };
    render(<CrossProjectImpactSection result={noWorkspace} />);
    expect(screen.getByTestId("cross-project-impact-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("cross-project-affected-object")).toBeNull();
  });
});

describe("ChangedRequirementGroup — API surface untouched", () => {
  it("flags the item as a low-confidence match, naming the provider", () => {
    render(
      <ChangedRequirementGroup
        item={item("i-client", CLIENT)}
        apiSurfaceUntouched={{
          consumerItemId: "i-client",
          consumerProjectId: CLIENT,
          providerProjectId: V2,
          providerProjectName: "miniflux/v2",
          edgeId: "e1",
        }}
      />,
    );
    const banner = screen.getByTestId("api-surface-untouched-banner");
    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toHaveTextContent(
      "Low-confidence match — this project uses miniflux/v2 through its API, and this change touches none of that API.",
    );
  });

  it("shows no banner otherwise", () => {
    render(<ChangedRequirementGroup item={item("i-client", CLIENT)} />);
    expect(screen.queryByTestId("api-surface-untouched-banner")).toBeNull();
  });
});

describe("ProjectImpactSection — the run's API-edge impact", () => {
  const apiEdgeImpact: ApiEdgeImpactResult = {
    impactAnalysisId: "ia-1",
    consumers: [consumer(), consumer({ providerProjectId: "p-other", consumerProjectId: "p-y" })],
    untouched: [
      {
        consumerItemId: "i-client",
        consumerProjectId: CLIENT,
        providerProjectId: V2,
        providerProjectName: "miniflux/v2",
        edgeId: "e1",
      },
    ],
  };

  it("lists the consumers of this project's change only", () => {
    render(
      <ProjectImpactSection
        projectId={V2}
        items={[item("i-v2", V2)]}
        crossProjectImpact={noShared}
        apiEdgeImpact={apiEdgeImpact}
      />,
    );
    expect(screen.getAllByTestId("api-consumer-row")).toHaveLength(1);
    expect(screen.queryByTestId("api-surface-untouched-banner")).toBeNull();
  });

  it("flags this project's untouched items only", () => {
    render(
      <ProjectImpactSection
        projectId={CLIENT}
        items={[item("i-client", CLIENT), item("i-client-2", CLIENT)]}
        crossProjectImpact={noShared}
        apiEdgeImpact={apiEdgeImpact}
      />,
    );
    expect(screen.getAllByTestId("api-surface-untouched-banner")).toHaveLength(1);
    expect(screen.queryByTestId("api-consumer-row")).toBeNull();
    expect(screen.getByTestId("cross-project-impact-empty")).toBeInTheDocument();
  });

  it("shows API consumers even when the shared-object read is absent or failed", () => {
    const { unmount } = render(
      <ProjectImpactSection projectId={V2} items={[]} apiEdgeImpact={apiEdgeImpact} />,
    );
    expect(screen.getByTestId("api-consumer-row")).toBeInTheDocument();
    unmount();
    render(
      <ProjectImpactSection
        projectId={V2}
        items={[]}
        crossProjectError
        apiEdgeImpact={apiEdgeImpact}
      />,
    );
    expect(screen.getByTestId("api-consumer-row")).toBeInTheDocument();
    expect(screen.getByTestId("cross-project-impact-error")).toBeInTheDocument();
  });

  it("says the API-edge part is unavailable instead of claiming no project is affected (#2120)", () => {
    render(
      <ProjectImpactSection
        projectId={V2}
        items={[item("i-v2", V2)]}
        crossProjectImpact={noShared}
        apiEdgeImpactError
      />,
    );
    expect(screen.queryByTestId("cross-project-impact-empty")).toBeNull();
    expect(screen.getByTestId("api-edge-impact-error")).toHaveTextContent(
      "Impact on projects that call this project's API is unavailable right now.",
    );
    expect(screen.queryByTestId("cross-project-impact-section")).toBeNull();
  });

  it("keeps the shared objects it has when only the API-edge read failed (#2120)", () => {
    const shared: CrossProjectImpactResult = {
      ...noShared,
      affectedObjects: [
        {
          objectType: "table",
          schemaName: null,
          objectName: "entries",
          alsoUsedByProjects: [
            {
              projectId: CLIENT,
              projectName: "miniflux/python-client",
              usageClass: "used",
              evidenceCount: 2,
            },
          ],
        },
      ],
    };
    render(
      <ProjectImpactSection
        projectId={V2}
        items={[]}
        crossProjectImpact={shared}
        apiEdgeImpactError
      />,
    );
    expect(screen.getByTestId("cross-project-affected-object")).toBeInTheDocument();
    expect(screen.getByTestId("api-edge-impact-error")).toBeInTheDocument();
    expect(screen.queryByTestId("cross-project-impact-empty")).toBeNull();
  });

  it("keeps the API consumers it has when the API-edge read failed (#2127)", () => {
    // Stale data after a failed refetch: consumers present, no shared objects.
    render(
      <ProjectImpactSection
        projectId={V2}
        items={[]}
        crossProjectImpact={noShared}
        apiEdgeImpact={apiEdgeImpact}
        apiEdgeImpactError
      />,
    );
    expect(screen.getByTestId("api-consumer-row")).toBeInTheDocument();
    expect(screen.getByTestId("api-edge-impact-error")).toBeInTheDocument();
    expect(screen.queryByTestId("cross-project-impact-empty")).toBeNull();
  });

  it("says once that cross-project impact is unavailable when both reads failed (#2127)", () => {
    render(<ProjectImpactSection projectId={V2} items={[]} crossProjectError apiEdgeImpactError />);
    expect(screen.getByTestId("cross-project-impact-error")).toHaveTextContent(
      "Cross-project impact is unavailable right now.",
    );
    expect(screen.queryByTestId("api-edge-impact-error")).toBeNull();
    expect(screen.queryByTestId("cross-project-impact-empty")).toBeNull();
  });

  it("says it is still checking, not that no project is affected, while the API-edge read is pending (#2127)", () => {
    render(
      <ProjectImpactSection
        projectId={V2}
        items={[item("i-v2", V2)]}
        crossProjectImpact={noShared}
        apiEdgeImpactLoading
      />,
    );
    expect(screen.queryByTestId("cross-project-impact-empty")).toBeNull();
    expect(screen.getByTestId("api-edge-impact-loading")).toHaveTextContent(
      "Checking projects that call this project's API…",
    );
    expect(screen.queryByTestId("cross-project-impact-section")).toBeNull();
  });

  it("shows the shared objects it has while the API-edge read is pending (#2127)", () => {
    const shared: CrossProjectImpactResult = {
      ...noShared,
      affectedObjects: [
        {
          objectType: "table",
          schemaName: null,
          objectName: "entries",
          alsoUsedByProjects: [
            { projectId: "p-x", projectName: "Other", usageClass: "used", evidenceCount: 1 },
          ],
        },
      ],
    };
    render(
      <ProjectImpactSection
        projectId={V2}
        items={[]}
        crossProjectImpact={shared}
        apiEdgeImpactLoading
      />,
    );
    expect(screen.getByTestId("cross-project-affected-object")).toBeInTheDocument();
    expect(screen.getByTestId("api-edge-impact-loading")).toBeInTheDocument();
  });

  it("renders nothing for the block with no result and no consumer", () => {
    render(<ProjectImpactSection projectId={CLIENT} items={[]} apiEdgeImpact={null} />);
    expect(screen.queryByTestId("cross-project-impact-section")).toBeNull();
  });
});
