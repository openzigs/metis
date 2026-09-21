/**
 * Epic #298 / Issue #310 — `get_call_graph` MCP tool.
 *
 * Given a `file` path, return:
 *   - every `CodeSymbol` defined in that file
 *   - every outbound call/reference edge from those symbols, expanded up to
 *     `depth` hops (default 1)
 *
 * Hard cap: 1000 nodes per response (`truncated: true` flag set when reached).
 * The cap exists because a request with `depth=10` against a hub file (e.g.
 * `prisma.ts`) could otherwise return tens of thousands of edges.
 */
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";

export const getCallGraphSchema = z.object({
  file: z.string().min(1).max(1024),
  depth: z.number().int().min(1).max(5).default(1),
  /** Required because CodeSymbol rows are scoped per project. */
  projectId: z.string().min(1),
  /** Hard cap on total symbols returned. Default 1000. */
  maxNodes: z.number().int().min(1).max(5000).default(1000),
});
export type GetCallGraphInput = z.infer<typeof getCallGraphSchema>;

export interface CallGraphNode {
  qualifiedName: string;
  kind: string;
  filePath: string;
  startLine: number;
}
export interface CallGraphEdge {
  from: string;
  to: string;
  kind: string;
  line: number;
}
export interface GetCallGraphResult {
  nodes: CallGraphNode[];
  edges: CallGraphEdge[];
  truncated: boolean;
}

type GraphPrisma = Pick<PrismaClient, "codeSymbol" | "codeEdge">;

export async function getCallGraph(
  prisma: GraphPrisma,
  rawInput: unknown,
): Promise<GetCallGraphResult> {
  const input = getCallGraphSchema.parse(rawInput);

  const seedSymbols = await prisma.codeSymbol.findMany({
    where: { projectId: input.projectId, filePath: input.file },
    select: { id: true, qualifiedName: true, kind: true, filePath: true, startLine: true },
    orderBy: { startLine: "asc" },
  });

  if (seedSymbols.length === 0) {
    return { nodes: [], edges: [], truncated: false };
  }

  const nodesById = new Map<string, CallGraphNode>();
  const edges: CallGraphEdge[] = [];
  const visited = new Set<string>();
  let truncated = false;

  const recordNode = (s: {
    id: string;
    qualifiedName: string;
    kind: string;
    filePath: string;
    startLine: number;
  }) => {
    if (nodesById.has(s.id)) return;
    if (nodesById.size >= input.maxNodes) {
      truncated = true;
      return;
    }
    nodesById.set(s.id, {
      qualifiedName: s.qualifiedName,
      kind: s.kind,
      filePath: s.filePath,
      startLine: s.startLine,
    });
  };

  for (const s of seedSymbols) recordNode(s);

  let frontier = seedSymbols.map((s) => s.id);
  for (let hop = 0; hop < input.depth && frontier.length > 0 && !truncated; hop += 1) {
    const outboundEdges = await prisma.codeEdge.findMany({
      where: {
        fromSymbolId: { in: frontier },
        kind: { in: ["calls", "references"] },
      },
      select: {
        fromSymbolId: true,
        toSymbolId: true,
        toQualifiedName: true,
        kind: true,
        line: true,
        fromSymbol: { select: { qualifiedName: true } },
        toSymbol: {
          select: {
            id: true,
            qualifiedName: true,
            kind: true,
            filePath: true,
            startLine: true,
          },
        },
      },
    });

    const nextFrontier: string[] = [];
    for (const e of outboundEdges) {
      const targetName = e.toSymbol?.qualifiedName ?? e.toQualifiedName ?? "<unresolved>";
      edges.push({
        from: e.fromSymbol.qualifiedName,
        to: targetName,
        kind: e.kind,
        line: e.line,
      });
      if (e.toSymbol && !visited.has(e.toSymbol.id)) {
        visited.add(e.toSymbol.id);
        recordNode(e.toSymbol);
        nextFrontier.push(e.toSymbol.id);
        if (nodesById.size >= input.maxNodes) {
          truncated = true;
          break;
        }
      }
    }
    frontier = nextFrontier;
  }

  return {
    nodes: Array.from(nodesById.values()),
    edges,
    truncated,
  };
}
