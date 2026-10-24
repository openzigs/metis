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
 * Membership in every maximum matching is proved from ONE maximum matching M
 * (Hopcroft–Karp) read the Dulmage–Mendelsohn way (#1208): a pair of M is in
 * every maximum matching unless it lies on an even M-alternating cycle or on an
 * even M-alternating path from a vertex M leaves free — swapping M along either
 * gives another maximum matching without it, and with neither no such matching
 * exists (the symmetric difference of two maximum matchings is made only of
 * those). Both tests are graph searches, so a level costs O(E·√V) for the
 * matching and O(V + E) for the proof, whatever its shape. The per-edge
 * re-match this replaced took 7.3 s on K300,300 and 31 s on a 2,499-edge chain.
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
 */
export function matchOneToOneRefusingTies<L, R, S>(
  candidates: ReadonlyArray<OneToOneCandidate<L, R, S>>,
  options: { compare: (a: S, b: S) => number },
): OneToOneResult<L, R> {
  const { compare } = options;
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
    const forced = forcedPairs(edges);
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

/**
 * The pairs in EVERY maximum matching of a bipartite graph (left → rights).
 *
 * Take one maximum matching M and orient the graph: each unmatched edge points
 * left → right, each matched edge right → left. A directed path then alternates
 * unmatched/matched edges, and a pair (l, r) of M is NOT in every maximum
 * matching exactly when one of these holds (Dulmage–Mendelsohn):
 *
 *   1. l and r share a strongly connected component: the path l → … → r closes
 *      an even alternating cycle through r → l, and swapping M along it drops
 *      the pair at the same size;
 *   2. r is reachable from a left M leaves free: the even alternating path
 *      free-left → … → r → l, swapped, frees l instead;
 *   3. l reaches a right M leaves free: the even alternating path
 *      l → … → free-right, preceded by r → l, swapped, frees r instead.
 *
 * Conversely, if another maximum matching M' omits the pair, the symmetric
 * difference of M and M' is a union of even alternating cycles and even
 * alternating paths each with one end free in M, and the pair lies on one of
 * them — so one of the three tests sees it. Each is a linear graph search.
 */
function forcedPairs<L, R>(edges: ReadonlyMap<L, ReadonlySet<R>>): Map<L, R> {
  // Index the vertices: lefts 0 … nL-1, rights 0 … nR-1.
  const lefts = [...edges.keys()];
  const rightIndex = new Map<R, number>();
  const rights: R[] = [];
  const adj: number[][] = lefts.map((l) =>
    [...edges.get(l)!].map((r) => {
      let i = rightIndex.get(r);
      if (i === undefined) {
        i = rights.length;
        rightIndex.set(r, i);
        rights.push(r);
      }
      return i;
    }),
  );
  const nL = lefts.length;
  const nR = rights.length;
  const radj: number[][] = Array.from({ length: nR }, () => []);
  for (let l = 0; l < nL; l++) for (const r of adj[l]!) radj[r]!.push(l);

  const { matchL, matchR } = hopcroftKarp(adj, nR);

  // 2. Rights reachable from a free left: left → right over unmatched edges,
  //    right → left over its matched edge.
  //    A matched left is entered only through its own right, which is marked
  //    once, so no left is queued twice.
  const fromFreeLeft = new Uint8Array(nR);
  {
    const queue: number[] = [];
    for (let l = 0; l < nL; l++) if (matchL[l] === -1) queue.push(l);
    for (let head = 0; head < queue.length; head++) {
      const l = queue[head]!;
      for (const r of adj[l]!) {
        if (r === matchL[l] || fromFreeLeft[r]) continue;
        fromFreeLeft[r] = 1;
        if (matchR[r] !== -1) queue.push(matchR[r]!);
      }
    }
  }

  // 3. Lefts that reach a free right — searched backwards from the free
  //    rights: right ← left over unmatched edges, left ← right over matched.
  const toFreeRight = new Uint8Array(nL);
  {
    const queue: number[] = [];
    for (let r = 0; r < nR; r++) if (matchR[r] === -1) queue.push(r);
    for (let head = 0; head < queue.length; head++) {
      const r = queue[head]!;
      for (const l of radj[r]!) {
        if (matchL[l] === r || toFreeRight[l]) continue;
        toFreeRight[l] = 1;
        if (matchL[l] !== -1) queue.push(matchL[l]!);
      }
    }
  }

  // 1. Strongly connected components of the oriented graph. Node ids: left l
  //    is l, right r is nL + r.
  const component = stronglyConnectedComponents(nL + nR, (v, visit) => {
    if (v < nL) {
      for (const r of adj[v]!) if (r !== matchL[v]) visit(nL + r);
    } else if (matchR[v - nL] !== -1) visit(matchR[v - nL]!);
  });

  const forced = new Map<L, R>();
  for (let l = 0; l < nL; l++) {
    const r = matchL[l]!;
    if (r === -1) continue;
    if (component[l] === component[nL + r]) continue; // 1. even alternating cycle
    if (fromFreeLeft[r] || toFreeRight[l]) continue; // 2./3. even alternating path
    forced.set(lefts[l]!, rights[r]!);
  }
  return forced;
}

/**
 * A maximum matching by Hopcroft–Karp, O(E·√V) whatever the input order.
 * Iterative, so a long path cannot overflow the call stack.
 */
function hopcroftKarp(
  adj: readonly (readonly number[])[],
  nR: number,
): { matchL: Int32Array; matchR: Int32Array } {
  const nL = adj.length;
  const matchL = new Int32Array(nL).fill(-1);
  const matchR = new Int32Array(nR).fill(-1);
  const dist = new Int32Array(nL);
  const cursor = new Int32Array(nL);
  const stack = new Int32Array(nL);
  const INF = 0x7fffffff;

  for (;;) {
    // BFS: layer the free lefts and what alternating paths reach from them.
    const queue: number[] = [];
    for (let l = 0; l < nL; l++) {
      if (matchL[l] === -1) {
        dist[l] = 0;
        queue.push(l);
      } else dist[l] = INF;
    }
    let found = false;
    for (let head = 0; head < queue.length; head++) {
      const l = queue[head]!;
      for (const r of adj[l]!) {
        const next = matchR[r]!;
        if (next === -1) found = true;
        else if (dist[next] === INF) {
          dist[next] = dist[l]! + 1;
          queue.push(next);
        }
      }
    }
    if (!found) return { matchL, matchR };

    // DFS along the layers from each free left, augmenting vertex-disjoint
    // shortest paths.
    cursor.fill(0);
    for (let root = 0; root < nL; root++) {
      if (matchL[root] !== -1) continue;
      let depth = 0;
      stack[0] = root;
      while (depth >= 0) {
        const l = stack[depth]!;
        const rs = adj[l]!;
        if (cursor[l]! >= rs.length) {
          dist[l] = INF; // dead end for the rest of this phase
          depth--;
          if (depth >= 0) cursor[stack[depth]!]!++;
          continue;
        }
        const r = rs[cursor[l]!]!;
        const next = matchR[r]!;
        if (next === -1) {
          // Augment: every left on the stack takes the right its cursor names.
          for (let d = depth; d >= 0; d--) {
            const u = stack[d]!;
            const v = adj[u]![cursor[u]!]!;
            matchL[u] = v;
            matchR[v] = u;
          }
          break;
        }
        if (dist[next] === dist[l]! + 1) stack[++depth] = next;
        else cursor[l]!++;
      }
    }
  }
}

/**
 * Strongly connected component ids by iterative Tarjan, O(V + E). `forEachOut`
 * calls `visit` once per out-neighbour of a vertex.
 */
function stronglyConnectedComponents(
  n: number,
  forEachOut: (v: number, visit: (w: number) => void) => void,
): Int32Array {
  const out: number[][] = Array.from({ length: n }, () => []);
  for (let v = 0; v < n; v++) forEachOut(v, (w) => out[v]!.push(w));
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const component = new Int32Array(n).fill(-1);
  const onStack = new Uint8Array(n);
  const tarjan: number[] = [];
  const call: number[] = [];
  const cursor = new Int32Array(n);
  let nextIndex = 0;
  let nextComponent = 0;

  for (let start = 0; start < n; start++) {
    if (index[start] !== -1) continue;
    call.push(start);
    index[start] = low[start] = nextIndex++;
    tarjan.push(start);
    onStack[start] = 1;
    while (call.length > 0) {
      const v = call.at(-1)!;
      const ws = out[v]!;
      if (cursor[v]! < ws.length) {
        const w = ws[cursor[v]!++]!;
        if (index[w] === -1) {
          index[w] = low[w] = nextIndex++;
          tarjan.push(w);
          onStack[w] = 1;
          call.push(w);
        } else if (onStack[w]) low[v] = Math.min(low[v]!, index[w]!);
        continue;
      }
      call.pop();
      const parent = call.at(-1);
      if (parent !== undefined) low[parent] = Math.min(low[parent]!, low[v]!);
      if (low[v] === index[v]) {
        let w: number;
        do {
          w = tarjan.pop()!;
          onStack[w] = 0;
          component[w] = nextComponent;
        } while (w !== v);
        nextComponent++;
      }
    }
  }
  return component;
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
