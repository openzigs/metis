/**
 * One-to-one matching that refuses ties instead of breaking them by list order.
 *
 * Two joins pair things by words and must never let the position of an item in
 * a list decide where it lands: promotion's title fallback (#1033, synthesis
 * output → approved structured requirement) and clarification attribution
 * (#1031, structured requirement → persisted row). Both rank candidate pairs on
 * a tuple of tiers and both refuse a tie. This module is that rule, once, so the
 * two cannot drift apart.
 *
 * The candidates are grouped into LEVELS by `compare` (equal ⇒ same level) and
 * resolved best level first. Within a level the live pairs form a bipartite
 * graph, resolved to a fixed point. Each round reads a snapshot of the graph,
 * so neither list order nor the order of rounds' own work decides anything:
 *
 *   - **Genuine tie.** A vertex that is the ONLY candidate of two or more
 *     vertices on the other side cannot go to all of them. It and those
 *     dependants are refused.
 *   - **Forced pair.** A vertex with exactly one live candidate, whose partner
 *     is not in a genuine tie, takes it, and both leave the graph.
 *
 * The rounds repeat until neither applies. Whatever is still live then has two
 * or more equally good candidates on both sides, so it is ambiguous and is
 * refused too.
 *
 * Counting rivals once per level, before anything is removed, cascades: a
 * vertex whose only rival is itself about to be refused still counts that rival
 * (#1187 review, run 9). The fixed point is what stops that. With S1 level on R1
 * and R2, and S2 reaching only R2, R2 takes S2 and S1 takes R1. That is the
 * only one-to-one assignment the level allows.
 *
 * **No fallback after a tie.** A vertex refused for a tie never takes a weaker
 * match at a later level: a wrong attribution is worse than none (owner's
 * decision on #1187, and #1186's rule). A vertex that simply lost its options
 * to forced pairs was in no tie, and may still match at a weaker level.
 */

export interface OneToOneCandidate<L, R, S> {
  left: L;
  right: R;
  score: S;
}

export interface OneToOneResult<L, R> {
  /** Each matched left and the right it took. */
  matches: Map<L, R>;
  /** Lefts refused because they were in a tie; they match nothing. */
  tiedLefts: Set<L>;
  /** Rights refused because they were in a tie; nothing matches them. */
  tiedRights: Set<R>;
}

/**
 * Match lefts to rights one-to-one, best level first, refusing ties.
 *
 * `compare(a, b)` orders scores like a sort comparator, BEST FIRST: negative
 * when `a` is the better score, 0 when the two are level. It must be a total
 * preorder. A repeated `(left, right)` pair is read once, at its best score.
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
  const tiedLefts = new Set<L>();
  const tiedRights = new Set<R>();
  const available = (l: L, r: R): boolean =>
    !matches.has(l) && !takenRights.has(r) && !tiedLefts.has(l) && !tiedRights.has(r);

  for (const level of levels) {
    let live = level.filter((c) => available(c.left, c.right));
    for (;;) {
      const leftAdj = new Map<L, Set<R>>();
      const rightAdj = new Map<R, Set<L>>();
      for (const c of live) {
        leftAdj.set(c.left, (leftAdj.get(c.left) ?? new Set<R>()).add(c.right));
        rightAdj.set(c.right, (rightAdj.get(c.right) ?? new Set<L>()).add(c.left));
      }
      const newTiedLefts = new Set<L>();
      const newTiedRights = new Set<R>();
      for (const [r, ls] of rightAdj) {
        const dependants = [...ls].filter((l) => leftAdj.get(l)!.size === 1);
        if (dependants.length >= 2) {
          newTiedRights.add(r);
          for (const l of dependants) newTiedLefts.add(l);
        }
      }
      for (const [l, rs] of leftAdj) {
        const dependants = [...rs].filter((r) => rightAdj.get(r)!.size === 1);
        if (dependants.length >= 2) {
          newTiedLefts.add(l);
          for (const r of dependants) newTiedRights.add(r);
        }
      }
      const forced = new Map<L, R>();
      for (const [l, rs] of leftAdj) {
        if (newTiedLefts.has(l)) continue;
        for (const r of rs) {
          if (newTiedRights.has(r)) continue;
          if (rs.size === 1 || rightAdj.get(r)!.size === 1) forced.set(l, r);
        }
      }
      if (newTiedLefts.size === 0 && newTiedRights.size === 0 && forced.size === 0) break;
      for (const l of newTiedLefts) tiedLefts.add(l);
      for (const r of newTiedRights) tiedRights.add(r);
      for (const [l, r] of forced) {
        matches.set(l, r);
        takenRights.add(r);
      }
      live = live.filter((c) => available(c.left, c.right));
    }
    // Everything still live has two or more level candidates on both sides.
    for (const c of live) {
      tiedLefts.add(c.left);
      tiedRights.add(c.right);
    }
  }
  return { matches, tiedLefts, tiedRights };
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
