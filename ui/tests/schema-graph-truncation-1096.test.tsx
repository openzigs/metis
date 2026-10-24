/**
 * #1096 — a schema graph built from a read the driver cut at its row ceiling
 * says so above the canvas, so a partial graph is not taken for the whole
 * schema. React Flow is stubbed: what is under test is the notice.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { SchemaGraph } from "@metis/shared";

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  return {
    ...actual,
    ReactFlow: (props: { children?: ReactNode }) => (
      <div data-testid="react-flow-stub">{props.children}</div>
    ),
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    useReactFlow: () => ({ fitView: vi.fn(), setCenter: vi.fn(), getNode: vi.fn() }),
  };
});

import {
  SchemaGraphExplorer,
  schemaGraphTruncationNotice,
} from "@/components/schema-graph-explorer";

const table = {
  schema: "APP",
  name: "T1",
  description: "",
  columns: [
    { name: "ID", dataType: "NUMBER", nullable: false, isPrimaryKey: true, isForeignKey: false },
  ],
};

const graph = (truncation?: SchemaGraph["truncation"]): SchemaGraph =>
  ({ tables: [table], edges: [], ...(truncation ? { truncation } : {}) }) as unknown as SchemaGraph;

describe("schema graph truncation notice (#1096)", () => {
  it("names N of M tables", () => {
    expect(
      schemaGraphTruncationNotice(
        graph({ rowsRead: 250_000, rowCeiling: 250_000, tablesRead: 1_200, tablesTotal: 4_000 }),
      ),
    ).toBe(
      "The schema was read partially: 1,200 of 4,000 tables. The tables that were not read are missing from this graph.",
    );
  });

  it("says when the total is not known", () => {
    expect(
      schemaGraphTruncationNotice(graph({ rowsRead: 9, rowCeiling: 9, tablesRead: 3 })),
    ).toContain("3 tables (the total could not be counted)");
  });

  it("is absent for a complete read", () => {
    expect(schemaGraphTruncationNotice(graph())).toBeNull();
  });

  it("is rendered above the canvas, and only for a cut read", () => {
    const { unmount } = render(
      <SchemaGraphExplorer
        graph={graph({ rowsRead: 9, rowCeiling: 9, tablesRead: 1, tablesTotal: 40 })}
      />,
    );
    expect(screen.getByTestId("schema-graph-truncated").textContent).toContain("1 of 40 tables");
    expect(screen.getByRole("status").textContent).toContain("read partially");
    unmount();

    render(<SchemaGraphExplorer graph={graph()} />);
    expect(screen.queryByTestId("schema-graph-truncated")).toBeNull();
  });

  it("is rendered even when the cut read returned no table", () => {
    const empty = {
      tables: [],
      edges: [],
      truncation: { rowsRead: 1, rowCeiling: 1, tablesRead: 0, tablesTotal: 2 },
    } as unknown as SchemaGraph;
    render(<SchemaGraphExplorer graph={empty} />);
    expect(screen.getByTestId("schema-graph-truncated").textContent).toContain("0 of 2 tables");
    expect(screen.getByTestId("schema-graph-empty")).toBeTruthy();
  });
});
