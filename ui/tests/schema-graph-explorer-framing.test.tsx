/**
 * Issue #124 — the schema graph is framed once, by React Flow's `fitView` prop,
 * and re-framed only when fullscreen toggles.
 *
 * It used to run a second, ANIMATED fit 50 ms after mount with a different
 * padding. The nodes were already visible and stable by then, so a pointer
 * resting on a table header (Playwright's `hover()`, or a user) was left over
 * empty canvas as the zoom slid the node away, and the CSS `group-hover`
 * tooltip disappeared. React Flow itself is stubbed here: what is under test is
 * which framing requests this component makes, and when.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { SchemaGraph } from "@metis/shared";

const fitView = vi.fn();
const reactFlowProps: Array<Record<string, unknown>> = [];

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  return {
    ...actual,
    ReactFlow: (props: Record<string, unknown> & { children?: ReactNode }) => {
      reactFlowProps.push(props);
      return <div data-testid="react-flow-stub">{props.children}</div>;
    },
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    useReactFlow: () => ({ fitView, setCenter: vi.fn(), getNode: vi.fn() }),
  };
});

import { SchemaGraphExplorer } from "@/components/schema-graph-explorer";

const graph = {
  tables: [
    {
      schema: "public",
      name: "users",
      description: "Registered user accounts.",
      columns: [
        { name: "id", dataType: "uuid", nullable: false, isPrimaryKey: true, isForeignKey: false },
      ],
    },
  ],
  edges: [],
} as unknown as SchemaGraph;

describe("SchemaGraphExplorer framing (#124)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fitView.mockClear();
    reactFlowProps.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("frames the first layout through the fitView prop and never re-fits after mount", () => {
    render(<SchemaGraphExplorer graph={graph} />);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(fitView).not.toHaveBeenCalled();
    const props = reactFlowProps.at(-1);
    expect(props?.fitView).toBe(true);
    expect(props?.fitViewOptions).toEqual({ padding: 0.2 });
  });

  it("re-frames once per fullscreen toggle, with the same padding as the first layout", () => {
    render(<SchemaGraphExplorer graph={graph} />);
    const toggle = screen.getByTestId("schema-fullscreen-toggle");

    fireEvent.click(toggle);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(fitView).toHaveBeenCalledTimes(1);
    expect(fitView).toHaveBeenLastCalledWith({ padding: 0.2, duration: 200 });

    fireEvent.click(toggle);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(fitView).toHaveBeenCalledTimes(2);
  });
});
