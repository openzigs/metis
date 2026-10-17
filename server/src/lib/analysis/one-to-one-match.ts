/**
 * One-to-one matching that never guesses: a pair is taken only when the
 * candidates FORCE it.
 *
 * Two joins pair things by words, and neither may let list order, or any other
 * arbitrary choice, decide where an item lands. They are promotion's title
 * fallback (#1033, synthesis output → approved structured requirement) and
 * clarification attribution (#1031, structured requirement → persisted row).
 * Both rank candidate pairs on a tuple of tiers. This module is their shared
 * rule, so the two cannot drift apart. A wrong attribution is worse than none
 * (owner's decision on #1187).
 *
 * The candidates are grouped into LEVELS by `compare` (equal ⇒ same level) and
 * resolved best level first. At each level the live candidates form a
 * bipartite graph, and a pair is taken **only if it is in every maximum
 * matching of that graph**. Any other choice would be one of several equally
 * good assignments, and so a guess. Examples:
 *
 *   - S1 level on R1 and R2, S2 reaching only R2: the only maximum matching is
 *     {S1–R1, S2–R2}, so both pairs are taken.
 *   - S1:{R1}, S2:{R1,R2}, S3:{R2}: three maximum matchings, and no pair is in
 *     all of them, so nothing is taken.
 *   - R1 and R2 both reaching only S1: either pair is a maximum matching, so
 *     neither is taken.
 *
 * Every vertex that had a live candidate at the level and did not get a forced
 * pair is REFUSED. It takes no weaker match at a later level, whether it was in
 * a tie itself or only lost its options to others' ties (the #1186 rule: no
 * fallback).
 *
 * The result depends only on the candidate graph, never on candidate order.
 * Membership in every maximum matching is checked per connected component by
 * removing the edge and re-measuring the maximum (augmenting paths). The levels
 * these joins produce are small.
 */

export interface OneToOneCandidate<L, R, S> {
  left: L;
  right: R;
  score: S;
}

export interface OneToOneResult<L, R> {
  /** Each matched left and the right it took. */
  matches: Map<L, R>;
  /** Lefts that had a candidate but no forced pair; they match nothing. */
  refusedLefts: Set<L>;
  /** Rights that had a candidate but no forced pair; nothing matches them. */
  refusedRights: Set<R>;
  /**
   * #1204 — for each refused left, the rights it was refused among: its live
   * candidates at the level where it was refused, less any right a forced pair
   * took at that same level (that right went to another left). Its keys are
   * exactly `refusedLefts`, and no set is empty. Read-only reporting, so a caller can tell the user which
   * options were too close to call; it never feeds back into the matching.
   */
  refusedLeftOptions: Map<L, Set<R>>;
}

/**
 * Match lefts to rights one-to-one, best level first, taking only the pairs in
 * every maximum matching of their level.
 *
 * `compare(a, b)` orders scores like a sort comparator, BEST FIRST: negative
 * when `a` is the better score, 0 when the two are level. It must be a total
 * preorder. A repeated `(left, right)` pair is read at its best level.
 *
 * `maxComponentEdges` (#1031) bounds the proof's cost, about (matched edges ×
 * V·E) per connected component of a level. A component with more live edges
 * than this is not proved: none of its pairs is taken, and all of its vertices
 * are refused, as for any unresolved tie. That is always safe under this rule (a
 * refusal, never a guess). Unset, every component is proved.
 */
export function matchOneToOneRefusingTies<L, R, S>(
  candidates: ReadonlyArray<OneToOneCandidate<L, R, S>>,
  options: { compare: (a: S, b: S) => number; maxComponentEdges?: number },
): OneToOneResult<L, R> {
  const { compare } = options;
  const maxComponentEdges = options.maxComponentEdges ?? Number.POSITIVE_INFINITY;
  const sorted = [...candidates].sort((a, b) => compare(a.score, b.score));
  const levels: Array<Array<OneToOneCandidate<L, R, S>>> = [];
  for (const c of sorted) {
    const level = levels.at(-1);
    if (level && compare(level[0]!.score, c.score) === 0) level.push(c);
    else levels.push([c]);
  }

  const matches = new Map<L, R>();
  const takenRights = new Set<R>();
  const refusedLefts = new Set<L>();
  const refusedRights = new Set<R>();
  const refusedLeftOptions = new Map<L, Set<R>>();

  for (const level of levels) {
    const edges = new Map<L, Set<R>>();
    for (const c of level) {
      if (matches.has(c.left) || refusedLefts.has(c.left)) continue;
      if (takenRights.has(c.right) || refusedRights.has(c.right)) continue;
      edges.set(c.left, (edges.get(c.left) ?? new Set<R>()).add(c.right));
    }
    const forced = forcedPairs(edges, maxComponentEdges);
    for (const [l, r] of forced) {
      matches.set(l, r);
      takenRights.add(r);
    }
    for (const [l, rs] of edges) {
      if (!forced.has(l)) {
        refusedLefts.add(l);
        // Not `rs` itself: a right a forced pair took at this same level went
        // to another left and is no option of this one (#1204 review). Never
        // empty: a neighbour of a non-forced left cannot be forced elsewhere,
        // or swapping it over would give another maximum matching.
        refusedLeftOptions.set(l, new Set([...rs].filter((r) => !takenRights.has(r))));
      }
      for (const r of rs) if (!takenRights.has(r)) refusedRights.add(r);
    }
  }
  return { matches, refusedLefts, refusedRights, refusedLeftOptions };
}

/** The pairs in EVERY maximum matching of a bipartite graph (left → rights). */
function forcedPairs<L, R>(
  edges: ReadonlyMap<L, ReadonlySet<R>>,
  maxComponentEdges: number,
): Map<L, R> {
  const forced = new Map<L, R>();
  for (const component of components(edges)) {
    let size = 0;
    for (const rs of component.values()) size += rs.size;
    if (size > maxComponentEdges) continue; // too large to prove: refused whole
    // A pair in EVERY maximum matching is in this one; one that is not is
    // exposed by removing it and finding a maximum just as large.
    const matching = maximumMatching(component);
    for (const [l, r] of matching) {
      const without = new Map(component);
      const rest = new Set(component.get(l));
      rest.delete(r);
      without.set(l, rest);
      if (maximumMatching(without).size < matching.size) forced.set(l, r);
    }
  }
  return forced;
}

/** A maximum matching (left → right) by augmenting paths. */
function maximumMatching<L, R>(edges: ReadonlyMap<L, ReadonlySet<R>>): Map<L, R> {
  const leftOf = new Map<R, L>();
  const augment = (l: L, seen: Set<R>): boolean => {
    for (const r of edges.get(l) ?? []) {
      if (seen.has(r)) continue;
      seen.add(r);
      const holder = leftOf.get(r);
      if (holder === undefined || augment(holder, seen)) {
        leftOf.set(r, l);
        return true;
      }
    }
    return false;
  };
  for (const l of edges.keys()) augment(l, new Set<R>());
  const matching = new Map<L, R>();
  for (const [r, l] of leftOf) matching.set(l, r);
  return matching;
}

/** The connected components of a bipartite graph, each as its own edge map. */
function components<L, R>(edges: ReadonlyMap<L, ReadonlySet<R>>): Array<Map<L, Set<R>>> {
  const leftsOf = new Map<R, L[]>();
  for (const [l, rs] of edges) for (const r of rs) leftsOf.set(r, [...(leftsOf.get(r) ?? []), l]);
  const seen = new Set<L>();
  const out: Array<Map<L, Set<R>>> = [];
  for (const start of edges.keys()) {
    if (seen.has(start)) continue;
    const component = new Map<L, Set<R>>();
    const queue = [start];
    seen.add(start);
    while (queue.length > 0) {
      const l = queue.pop()!;
      component.set(l, new Set(edges.get(l)));
      for (const r of edges.get(l) ?? []) {
        for (const other of leftsOf.get(r) ?? []) {
          if (!seen.has(other)) {
            seen.add(other);
            queue.push(other);
          }
        }
      }
    }
    out.push(component);
  }
  return out;
}

/**
 * `compare` for scores that are tuples of tiers, best first: the higher first
 * tier wins, then the higher second, and so on. Tuples of different lengths
 * compare as if the shorter one were padded with zeros.
 */
export function compareTiersDescending(a: readonly number[], b: readonly number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
