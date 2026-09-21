"use client";

/**
 * Epic #895 — Interactive Schema Graph Explorer.
 *
 * Renders a database {@link SchemaGraph} as an interactive React Flow canvas:
 *  - One node per table (PK/FK/nullable column affordances).
 *  - One directed edge per foreign key.
 *  - Auto-layout via dagre (left-to-right ranks).
 *  - Hover tooltip with the LLM-generated table description (#899).
 *  - Click a table to open a detail drawer with every column + description (#899).
 *  - Search box that centres + highlights a matching table (#899).
 *  - Fullscreen toggle for large schemas (#899).
 *
 * Performance: nodes are memoized, handlers are stable, and React Flow is told
 * to only render visible elements so large schemas stay responsive (#898/#900).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import "@xyflow/react/dist/style.css";
import type { SchemaGraph, SchemaGraphTable } from "@metis/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const NODE_WIDTH = 240;
const HEADER_HEIGHT = 40;
const ROW_HEIGHT = 22;
const MAX_VISIBLE_COLUMNS = 10;

/** Node payload carried through React Flow. */
interface TableNodeData extends Record<string, unknown> {
  table: SchemaGraphTable;
  /** Schema-qualified node id (also used as the React Flow node id). */
  nodeId: string;
  highlighted: boolean;
  onOpen: (nodeId: string) => void;
}

type TableFlowNode = Node<TableNodeData, "table">;

/**
 * Schema-qualified node identity (`"<schema>.<name>"`). Falls back to a derived
 * value for graphs persisted before the `id` field existed, then to the bare
 * name when no schema is available. Same-named tables in different schemas thus
 * stay distinct.
 */
function tableNodeId(table: { id?: string; schema?: string; name: string }): string {
  if (table.id) return table.id;
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

// ---------------------------------------------------------------------------
// Table node
// ---------------------------------------------------------------------------

function TableNodeComponent({ data }: NodeProps<TableFlowNode>): React.ReactElement {
  const { table, nodeId, highlighted, onOpen } = data;
  const visible = table.columns.slice(0, MAX_VISIBLE_COLUMNS);
  const hiddenCount = table.columns.length - visible.length;

  return (
    <div
      className={`group relative rounded-md border bg-card text-card-foreground shadow-sm ${
        highlighted ? "border-primary ring-2 ring-primary" : "border-border"
      }`}
      style={{ width: NODE_WIDTH }}
      data-testid={`schema-node-${table.name}`}
    >
      <Handle type="target" position={Position.Left} className="!bg-muted-foreground" />
      <Handle type="source" position={Position.Right} className="!bg-muted-foreground" />

      <button
        type="button"
        onClick={() => onOpen(nodeId)}
        className="flex w-full items-center justify-between gap-2 rounded-t-md bg-muted px-3 py-2 text-left text-sm font-semibold hover:bg-muted/80"
        title={table.description || undefined}
        data-testid={`schema-node-header-${table.name}`}
      >
        <span className="truncate">{table.name}</span>
        <span className="shrink-0 text-xs font-normal text-muted-foreground">
          {table.columns.length}
        </span>
      </button>

      <ul className="divide-y divide-border text-xs">
        {visible.map((col) => (
          <li
            key={col.name}
            className="flex items-center gap-1.5 px-3 py-1"
            style={{ height: ROW_HEIGHT }}
          >
            {col.isPrimaryKey && (
              <span
                className="rounded bg-amber-100 px-1 text-[10px] font-bold text-amber-800"
                title="Primary key"
              >
                PK
              </span>
            )}
            {col.isForeignKey && (
              <span
                className="rounded bg-sky-100 px-1 text-[10px] font-bold text-sky-800"
                title="Foreign key"
              >
                FK
              </span>
            )}
            <span className="truncate font-mono">{col.name}</span>
            <span className="ml-auto shrink-0 truncate text-muted-foreground">{col.dataType}</span>
            {!col.nullable && (
              <span className="shrink-0 text-[10px] text-muted-foreground" title="NOT NULL">
                •
              </span>
            )}
          </li>
        ))}
        {hiddenCount > 0 && (
          <li className="px-3 py-1 text-[10px] italic text-muted-foreground">
            +{hiddenCount} more…
          </li>
        )}
      </ul>

      {/* Hover tooltip with the LLM description (#899). */}
      {table.description && (
        <div
          role="tooltip"
          className="pointer-events-none absolute left-1/2 top-full z-10 mt-1 hidden w-64 -translate-x-1/2 rounded-md border bg-popover p-2 text-xs text-popover-foreground shadow-md group-hover:block"
          data-testid={`schema-node-tooltip-${table.name}`}
        >
          {table.description}
        </div>
      )}
    </div>
  );
}

const TableNode = TableNodeComponent;
// Stable nodeTypes reference (defined once, outside any component).
const nodeTypes = { table: TableNode };

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function nodeHeight(table: SchemaGraphTable): number {
  const rows =
    Math.min(table.columns.length, MAX_VISIBLE_COLUMNS) +
    (table.columns.length > MAX_VISIBLE_COLUMNS ? 1 : 0);
  return HEADER_HEIGHT + rows * ROW_HEIGHT;
}

interface LayoutResult {
  nodes: TableFlowNode[];
  edges: Edge[];
}

function layoutGraph(graph: SchemaGraph, onOpen: (nodeId: string) => void): LayoutResult {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 90, marginx: 20, marginy: 20 });

  const known = new Set(graph.tables.map((t) => tableNodeId(t)));

  // Map a bare table name → qualified id so edges persisted before schema
  // qualification (or with an unqualified endpoint) still resolve. Ambiguous
  // names (same name in multiple schemas) map to null and are left unresolved.
  const byName = new Map<string, string | null>();
  for (const t of graph.tables) {
    const id = tableNodeId(t);
    byName.set(t.name, byName.has(t.name) ? null : id);
  }
  const resolveEndpoint = (endpoint: string): string | null => {
    if (known.has(endpoint)) return endpoint;
    return byName.get(endpoint) ?? null;
  };

  for (const table of graph.tables) {
    g.setNode(tableNodeId(table), { width: NODE_WIDTH, height: nodeHeight(table) });
  }
  // Only lay out edges whose endpoints both resolve to existing nodes.
  const validEdges = graph.edges
    .map((e) => {
      const source = resolveEndpoint(e.source);
      const target = resolveEndpoint(e.target);
      return source && target ? { ...e, source, target } : null;
    })
    .filter((e): e is SchemaGraph["edges"][number] => e !== null);
  for (const edge of validEdges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  const nodes: TableFlowNode[] = graph.tables.map((table) => {
    const id = tableNodeId(table);
    const pos = g.node(id);
    const h = nodeHeight(table);
    return {
      id,
      type: "table",
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - h / 2 },
      data: { table, nodeId: id, highlighted: false, onOpen },
    };
  });

  const edges: Edge[] = validEdges.map((edge, i) => ({
    id: `e-${i}-${edge.source}-${edge.target}`,
    source: edge.source,
    target: edge.target,
    label: edge.columns.join(", "),
    markerEnd: { type: MarkerType.ArrowClosed },
    style: { stroke: "var(--color-muted-foreground, #94a3b8)" },
    labelStyle: { fontSize: 10 },
  }));

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Detail drawer (#899)
// ---------------------------------------------------------------------------

function TableDetailDrawer({
  table,
  onClose,
}: {
  table: SchemaGraphTable;
  onClose: () => void;
}): React.ReactElement {
  return (
    <aside
      className="absolute right-0 top-0 z-20 flex h-full w-80 flex-col overflow-y-auto border-l bg-card p-4 shadow-lg"
      data-testid="schema-detail-drawer"
      aria-label={`Details for ${table.name}`}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold" data-testid="schema-detail-title">
            {table.name}
          </h3>
          <p className="text-xs text-muted-foreground">{table.schema}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onClose} aria-label="Close details">
          ✕
        </Button>
      </div>

      {table.description && (
        <p className="mb-3 text-sm text-muted-foreground" data-testid="schema-detail-description">
          {table.description}
        </p>
      )}

      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Columns ({table.columns.length})
      </h4>
      <ul className="space-y-1 text-sm">
        {table.columns.map((col) => (
          <li
            key={col.name}
            className="flex items-center gap-1.5"
            data-testid={`schema-detail-col-${col.name}`}
          >
            {col.isPrimaryKey && (
              <span className="rounded bg-amber-100 px-1 text-[10px] font-bold text-amber-800">
                PK
              </span>
            )}
            {col.isForeignKey && (
              <span className="rounded bg-sky-100 px-1 text-[10px] font-bold text-sky-800">FK</span>
            )}
            <span className="font-mono">{col.name}</span>
            <span className="ml-auto text-xs text-muted-foreground">{col.dataType}</span>
            {!col.nullable && <span className="text-[10px] text-muted-foreground">NOT NULL</span>}
          </li>
        ))}
      </ul>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Inner canvas
// ---------------------------------------------------------------------------

function SchemaGraphInner({ graph }: { graph: SchemaGraph }): React.ReactElement {
  const [selected, setSelected] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const { setCenter, getNode, fitView } = useReactFlow();

  const openTable = useCallback((nodeId: string) => setSelected(nodeId), []);

  const base = useMemo(() => layoutGraph(graph, openTable), [graph, openTable]);

  // Controlled node/edge state so React Flow nodes are draggable. Layout is the
  // source of truth: when the graph (and thus `base`) changes we reset.
  const [nodes, setNodes, onNodesChange] = useNodesState<TableFlowNode>(base.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(base.edges);

  useEffect(() => {
    setNodes(base.nodes);
    setEdges(base.edges);
  }, [base, setNodes, setEdges]);

  // Apply the highlight flag without re-running layout or losing drag positions.
  useEffect(() => {
    setNodes((nds) =>
      nds.map((n) =>
        n.data.highlighted === (n.id === highlighted)
          ? n
          : { ...n, data: { ...n.data, highlighted: n.id === highlighted } },
      ),
    );
  }, [highlighted, setNodes]);

  const selectedTable = useMemo(
    () => graph.tables.find((t) => tableNodeId(t) === selected) ?? null,
    [graph.tables, selected],
  );

  const runSearch = useCallback(
    (term: string) => {
      const q = term.trim().toLowerCase();
      if (!q) {
        setHighlighted(null);
        return;
      }
      const match =
        graph.tables.find((t) => t.name.toLowerCase() === q) ??
        graph.tables.find((t) => t.name.toLowerCase().includes(q));
      if (!match) {
        setHighlighted(null);
        return;
      }
      const matchId = tableNodeId(match);
      setHighlighted(matchId);
      const node = getNode(matchId);
      if (node) {
        const h = nodeHeight(match);
        setCenter(node.position.x + NODE_WIDTH / 2, node.position.y + h / 2, {
          zoom: 1.2,
          duration: 400,
        });
      }
    },
    [graph.tables, getNode, setCenter],
  );

  const containerRef = useRef<HTMLDivElement>(null);

  // Keep React Flow framed when toggling fullscreen.
  useEffect(() => {
    const t = setTimeout(() => fitView({ duration: 200, padding: 0.2 }), 50);
    return () => clearTimeout(t);
  }, [isFullscreen, fitView]);

  return (
    <div
      ref={containerRef}
      className={
        isFullscreen
          ? "fixed inset-0 z-50 bg-background"
          : "relative h-[600px] w-full overflow-hidden rounded-md border"
      }
      data-testid="schema-graph-explorer"
    >
      {/* Toolbar */}
      <div className="absolute left-2 top-2 z-30 flex items-center gap-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            runSearch(search);
          }}
          className="flex items-center gap-1"
        >
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              runSearch(e.target.value);
            }}
            placeholder="Search tables…"
            className="h-8 w-44 bg-card"
            aria-label="Search tables"
            data-testid="schema-search-input"
          />
        </form>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setIsFullscreen((v) => !v)}
          data-testid="schema-fullscreen-toggle"
        >
          {isFullscreen ? "Exit fullscreen" : "Fullscreen"}
        </Button>
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        onlyRenderVisibleElements
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
        onPaneClick={() => setSelected(null)}
      >
        <Background />
        <Controls />
        <MiniMap pannable zoomable className="!bg-card" />
      </ReactFlow>

      {selectedTable && (
        <TableDetailDrawer table={selectedTable} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function SchemaGraphExplorer({ graph }: { graph: SchemaGraph }): React.ReactElement {
  if (graph.tables.length === 0) {
    return (
      <div
        className="flex h-[300px] items-center justify-center rounded-md border text-sm text-muted-foreground"
        data-testid="schema-graph-empty"
      >
        No tables to display.
      </div>
    );
  }
  return (
    <ReactFlowProvider>
      <SchemaGraphInner graph={graph} />
    </ReactFlowProvider>
  );
}

export default SchemaGraphExplorer;
