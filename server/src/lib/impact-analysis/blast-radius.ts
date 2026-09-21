/**
 * Blast-radius traversal — Epic #159 (#162).
 *
 * Given a set of *directly* affected code symbols (the requirement→code seed
 * set from #161), walk the persisted code graph to find the transitive set of
 * impacted symbols. Each hit is labeled with its `relation`, BFS `depth`, and a
 * depth-decayed `confidence`.
 *
 * ## Callers-only by default (the actionable signal)
 *
 * For "who is impacted by this change?", the useful direction is UPSTREAM:
 * callers/importers of the changed code (`getEdgesTo`). Downstream dependencies
 * (`getEdgesFrom` — *what the changed code uses*) are mostly noise for impact
 * and, on a dense graph, explode the result set. So by default we walk ONLY
 * incoming edges; `includeDependencies` restores the bidirectional behavior.
 *
 * ## Confidence floor (default 0.4)
 *
 * confidence = clamp01(seedConfidence * EDGE_TYPE_WEIGHTS[kind] * 0.7^(depth-1)).
 * EDGE_TYPE_WEIGHTS: calls=1.0, imports=0.8, defines=0.6, references=0.4.
 * With a typical real seed (seedConfidence≈0.7):
 *   depth 1 → calls 0.49, imports 0.39, defines 0.29, references 0.20
 *   depth 2 → calls 0.34, imports 0.27, defines 0.21, references 0.14
 * With a best-case seed (seedConfidence=1.0):
 *   depth 1 → calls 1.0, imports 0.8, defines 0.6, references 0.4
 *   depth 2 → calls 0.70, imports 0.56, defines 0.42, references 0.28
 * A floor of 0.4 keeps depth-1 calls/imports (the high-value direct callers)
 * for strong AND typical seeds, and keeps depth-2 calls only when the seed was
 * strong (≥~0.57 → 0.4), trimming the depth-2 long tail (references/defines and
 * weak-seed depth-2) that produces the noise — without hiding genuine direct
 * callers. The filter is applied to the OUTPUT set, never mid-traversal, so a
 * low-confidence node can still be a stepping stone to a shallower path.
 *
 * ## Depth stays at 2
 *
 * We keep `maxDepth` at 2 rather than dropping to depth-1: depth-1-only would
 * silently discard legitimate transitive callers. The confidence floor — not a
 * shallower BFS — is the right lever to trim noise.
 *
 * Reuses the `CodeGraphDataSource` abstraction from the query service so this
 * is fully unit-testable with an in-memory mock graph.
 */
import type { ImpactAffectedRelation } from "@metis/shared";
import {
  EDGE_TYPE_WEIGHTS,
  type CodeGraphDataSource,
  type EdgeKind,
  type GraphEdge,
} from "../code-graph/query-service.js";

/** Group edges by a chosen endpoint id (the frontier node they attach to). */
function groupEdges(edges: GraphEdge[], keyOf: (e: GraphEdge) => string): Map<string, GraphEdge[]> {
  const map = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    const k = keyOf(e);
    if (!k) continue;
    const list = map.get(k);
    if (list) list.push(e);
    else map.set(k, [e]);
  }
  return map;
}

export interface RadiusSymbol {
  codeSymbolId: string;
  filePath: string;
  qualifiedName: string;
  startLine: number | null;
  endLine: number | null;
  relation: ImpactAffectedRelation;
  depth: number;
  confidence: number;
}

export interface BlastRadiusOptions {
  /** Maximum BFS depth from the seed set. Default 2. */
  maxDepth?: number;
  /** Confidence of the seed/direct matches (propagated with decay). Default 1. */
  seedConfidence?: number;
  /**
   * When true, also walk DOWNSTREAM dependencies (`getEdgesFrom` — what the
   * changed code uses), restoring the original bidirectional behavior. Default
   * FALSE: only upstream callers/importers are returned, because downstream
   * dependencies are noise for "who is impacted by this change" and explode the
   * result set on a dense graph. When false, `getEdgesFrom` is never consulted.
   */
  includeDependencies?: boolean;
  /**
   * Minimum confidence a symbol must reach to be EMITTED. Applied to the output
   * set (not the BFS frontier), so low-confidence nodes can still be traversed
   * to reach shallower paths. Default {@link DEFAULT_RADIUS_MIN_CONFIDENCE}.
   */
  minConfidence?: number;
}

/** Per-hop confidence decay applied to deeper blast-radius rings. */
export const RADIUS_DECAY = 0.7;

/**
 * Default confidence floor for emitting a blast-radius symbol. See the module
 * doc comment for the per-depth/per-edge-kind math behind 0.4.
 */
export const DEFAULT_RADIUS_MIN_CONFIDENCE = 0.4;

const DEFAULT_MAX_DEPTH = 2;

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Classify an incoming edge into the relation of the source symbol. */
export function relationForIncoming(kind: EdgeKind): ImpactAffectedRelation {
  return kind === "imports" ? "importer" : "caller";
}

interface FrontierNode {
  id: string;
  depth: number;
  relation: ImpactAffectedRelation;
}

/**
 * Walk the code graph outward from `seedSymbolIds`, returning the transitive
 * blast radius (excluding the seeds themselves). Symbols are deduped — the
 * first (shallowest) visit wins.
 */
export async function blastRadius(
  dataSource: CodeGraphDataSource,
  seedSymbolIds: string[],
  opts: BlastRadiusOptions = {},
): Promise<RadiusSymbol[]> {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const seedConfidence = opts.seedConfidence ?? 1;
  const includeDependencies = opts.includeDependencies ?? false;
  const minConfidence = opts.minConfidence ?? DEFAULT_RADIUS_MIN_CONFIDENCE;
  const seeds = seedSymbolIds.filter(Boolean);
  if (seeds.length === 0 || maxDepth <= 0) return [];

  const visited = new Set<string>(seeds);
  const out = new Map<string, RadiusSymbol>();

  let frontier: FrontierNode[] = seeds.map((id) => ({ id, depth: 0, relation: "direct" }));

  for (let depth = 0; depth < maxDepth; depth++) {
    const discovered: Array<FrontierNode & { kind: EdgeKind }> = [];
    const frontierIds = frontier.map((n) => n.id);

    // #849/#872 perf: fetch ALL incoming edges for the whole frontier in one
    // query (batched) instead of one query per node. Falls back to per-node when
    // the source has no batched variant. The subsequent grouped iteration below
    // preserves the ORIGINAL per-node, first-claim-wins traversal semantics
    // exactly — only the DB access pattern changes.
    const incoming = dataSource.getEdgesToMany
      ? await dataSource.getEdgesToMany(frontierIds)
      : (await Promise.all(frontier.map((n) => dataSource.getEdgesTo(n.id)))).flat();
    const incomingByTo = groupEdges(incoming, (e) => e.toSymbolId);

    let outgoingByFrom: Map<string, GraphEdge[]> | null = null;
    if (includeDependencies) {
      const outgoing = dataSource.getEdgesFromMany
        ? await dataSource.getEdgesFromMany(frontierIds)
        : (await Promise.all(frontier.map((n) => dataSource.getEdgesFrom(n.id)))).flat();
      outgoingByFrom = groupEdges(outgoing, (e) => e.fromSymbolId);
    }

    for (const node of frontier) {
      // Callers-only by default: only walk incoming edges. Downstream
      // dependencies (getEdgesFrom) are consulted only when opted in.
      for (const e of incomingByTo.get(node.id) ?? []) {
        if (!e.fromSymbolId || visited.has(e.fromSymbolId)) continue;
        visited.add(e.fromSymbolId);
        const relation = node.relation === "direct" ? relationForIncoming(e.kind) : node.relation;
        discovered.push({ id: e.fromSymbolId, depth: depth + 1, relation, kind: e.kind });
      }

      if (outgoingByFrom) {
        for (const e of outgoingByFrom.get(node.id) ?? []) {
          if (!e.toSymbolId || visited.has(e.toSymbolId)) continue;
          visited.add(e.toSymbolId);
          const relation = node.relation === "direct" ? "dependency" : node.relation;
          discovered.push({ id: e.toSymbolId, depth: depth + 1, relation, kind: e.kind });
        }
      }
    }

    if (discovered.length === 0) break;

    const symbols = await dataSource.getSymbolsByIds(discovered.map((d) => d.id));
    const symbolMap = new Map(symbols.map((s) => [s.id, s]));

    for (const d of discovered) {
      const sym = symbolMap.get(d.id);
      if (!sym || out.has(d.id)) continue;
      const weight = EDGE_TYPE_WEIGHTS[d.kind] ?? 0.4;
      const confidence = clamp01(seedConfidence * weight * Math.pow(RADIUS_DECAY, d.depth - 1));
      out.set(d.id, {
        codeSymbolId: sym.id,
        filePath: sym.filePath,
        qualifiedName: sym.qualifiedName,
        startLine: sym.startLine,
        endLine: sym.endLine,
        relation: d.relation,
        depth: d.depth,
        confidence,
      });
    }

    frontier = discovered.map((d) => ({ id: d.id, depth: d.depth, relation: d.relation }));
  }

  // Emit only symbols that clear the confidence floor. The filter runs on the
  // final output set (after traversal), so a low-confidence node still served
  // as a stepping stone to any shallower path during the BFS.
  return [...out.values()]
    .filter((s) => s.confidence >= minConfidence)
    .sort((a, b) => a.depth - b.depth || b.confidence - a.confidence);
}
