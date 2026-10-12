/**
 * #1036 — structural twins: functions built the same way as one the request
 * retrieved, added to the BLAST RADIUS for review.
 *
 * A fix to one handler usually belongs in its twin as well, and nothing in the
 * request names the twin. Miniflux #4386 ("after 'Mark this page as read' the
 * feed shows 0 entries") was fixed upstream in `showFeedEntriesPage` AND
 * `showCategoryEntriesPage`; the search finds the first (the issue says "feed")
 * and ranks the second 424th. They share 20 of their 24 distinct callees.
 *
 * Similarity is the Jaccard overlap of the two functions' callee NAMES. Names,
 * not resolved targets, on purpose: the Go parser leaves 76% of call edges
 * unresolved (`h.store.X()`), and a bare name is recorded for every one of them.
 * Bare names collide (`New`, `Close`), which is why this only ever widens the
 * list to review and never names an edit candidate, and why both functions need
 * {@link MIN_CALLEES} distinct callees before a similarity means anything.
 *
 * Pure apart from the symbol lookup; a graph without callee names yields none.
 */
import type { CodeGraphDataSource } from "../code-graph/query-service.js";
import type { RequirementCodeMatch } from "../traceability/requirement-code-mapping.js";

/** A graph that can say what each function calls, by name. */
export interface CalleeNameSource {
  calleeNameSets(): ReadonlyMap<string, ReadonlySet<string>>;
}

export function hasCalleeNames(graph: unknown): graph is CalleeNameSource {
  return typeof (graph as CalleeNameSource | null)?.calleeNameSets === "function";
}

// PROVISIONAL — {@link MIN_CALLEES} and {@link MIN_TWIN_SIMILARITY} were set on
// ONE pair (Miniflux #4386: `showFeedEntriesPage` / `showCategoryEntriesPage`,
// 20 of 24 callees shared, similarity 0.83) among six Miniflux issues, and sit
// just under it. The stage only ever widens the list to review, so the cost of a
// wrong setting is noise rather than a wrong claim. Revisit at run 8, with the
// twins added per issue and how many were in the reference set.

/** Fewest distinct callees for a function to be compared at all. */
export const MIN_CALLEES = 6;
/** Jaccard overlap of callee names at or above which two functions are twins. */
export const MIN_TWIN_SIMILARITY = 0.7;
/** Retrieved symbols whose twins are looked for, best first. */
export const MAX_TWIN_SEEDS = 60;
/** Twins kept per seed, and overall. */
export const MAX_TWINS_PER_SEED = 4;
export const MAX_TWINS = 24;
/** A twin is one step out from the symbol it resembles. */
export const TWIN_CONFIDENCE_FACTOR = 0.5;

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

export interface TwinHit {
  id: string;
  /** The retrieved symbol it resembles. */
  seedId: string;
  similarity: number;
}

/** The twins of `seedIds` (best first), never one of the seeds themselves. */
export function findStructuralTwins(
  seedIds: readonly string[],
  calleeNames: ReadonlyMap<string, ReadonlySet<string>>,
): TwinHit[] {
  const seeds = new Set(seedIds);
  const best = new Map<string, TwinHit>();
  for (const seedId of seedIds.slice(0, MAX_TWIN_SEEDS)) {
    const mine = calleeNames.get(seedId);
    if (!mine || mine.size < MIN_CALLEES) continue;
    const forSeed: TwinHit[] = [];
    for (const [id, theirs] of calleeNames) {
      if (seeds.has(id) || theirs.size < MIN_CALLEES) continue;
      // Sets this different in size cannot reach the threshold.
      if (Math.min(mine.size, theirs.size) < Math.max(mine.size, theirs.size) * MIN_TWIN_SIMILARITY)
        continue;
      const similarity = jaccard(mine, theirs);
      if (similarity >= MIN_TWIN_SIMILARITY) forSeed.push({ id, seedId, similarity });
    }
    forSeed.sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id));
    for (const hit of forSeed.slice(0, MAX_TWINS_PER_SEED)) {
      const prev = best.get(hit.id);
      if (!prev || hit.similarity > prev.similarity) best.set(hit.id, hit);
    }
  }
  return [...best.values()]
    .sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id))
    .slice(0, MAX_TWINS);
}

/**
 * The twins of the retrieved symbols, as `related` matches. `[]` when the graph
 * carries no callee names or nothing is similar enough.
 */
export async function resolveStructuralTwins(
  graph: CodeGraphDataSource,
  retrieved: readonly RequirementCodeMatch[],
): Promise<RequirementCodeMatch[]> {
  if (!hasCalleeNames(graph)) return [];
  const confidenceById = new Map<string, number>();
  for (const m of retrieved) {
    if (m.codeSymbolId && !confidenceById.has(m.codeSymbolId)) {
      confidenceById.set(m.codeSymbolId, m.confidence);
    }
  }
  const twins = findStructuralTwins([...confidenceById.keys()], graph.calleeNameSets());
  if (twins.length === 0) return [];
  const symbols = new Map(
    (await graph.getSymbolsByIds(twins.map((t) => t.id))).map((s) => [s.id, s]),
  );
  return twins.flatMap((t) => {
    const s = symbols.get(t.id);
    if (!s) return [];
    return [
      {
        codeSymbolId: s.id,
        filePath: s.filePath,
        qualifiedName: s.qualifiedName,
        startLine: s.startLine,
        endLine: s.endLine,
        confidence: (confidenceById.get(t.seedId) ?? 0) * t.similarity * TWIN_CONFIDENCE_FACTOR,
      },
    ];
  });
}
