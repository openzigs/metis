---
name: one-to-one-join-traps
description: Word-overlap joins between requirements (promotion, clarification attribution) must be one-to-one and never guess; reuse server/src/lib/analysis/one-to-one-match.ts and test it the ways below.
metadata:
  type: project
---

Collected from #1186, #1187 and their reviews (2026-10-16). Checked against `main` at b16dcc30.

**Reuse the shared rule.** `server/src/lib/analysis/one-to-one-match.ts`
(`matchOneToOneRefusingTies`, `compareTiersDescending`) is the one rule for promotion's title
fallback and clarification attribution (`clarification-enrichment.ts`). A pair is taken only if
it is in **every maximum matching** of its score level; everything else at that level is
refused and takes no weaker match later. Do not write a second matcher.

- **Titles tie between neighbours.** A requirement body explains itself with its neighbour's
  title words, so "title in title+body" scores tie. "First best" is a guess; refuse ties.
- **Join by ids before words.** Synthesis can fold several approved requirements into one
  item, so promotion joins by `structuredIds` (`synthesis.ts`), words only as a fallback. The
  synthesis prompt now asks for one requirement per listed id (`prompts.ts`).
- **Peeling single-candidate pairs still guesses** on chains such as S1:{R1}, S2:{R1,R2},
  S3:{R2} (three maximum matchings, no forced pair). Fixed-point "drop and recount" rules
  were tried first and let an eliminated candidate block an unambiguous one (walkthrough
  run 9: `/v1/feeds` lost its item to categories).
- **Property-test against brute force.** `one-to-one-match.test.ts` enumerates every maximum
  matching of small graphs and replays each level; keep that when changing the rule.
- **Mutate each ranking tier separately.** Both tiers of the score tuple could be deleted with
  every test green on #1187.
- **Benchmark a sparse chain, not only dense graphs.** The remove-and-rematch proof took 31 s
  on a 2,499-edge chain (Li:{R(i-1),Ri}) vs 63 ms on a 2,485-edge triangle; an edge cap
  (`maxComponentEdges`, `MAX_ATTRIBUTION_PROOF_EDGES`) does not bound it. Open: #1208.
  Size-guard tests need a graph the full proof would resolve (a staircase), not a complete
  graph, or the guard is never what decides the result.
- **A synthesis-prompt change moves the generative-e2e fixture key.** Update
  `server/scripts/e2e-build-clarify-fixtures.ts` and
  `server/tests/e2e-clarify-fixture-key-parity.test.ts` in the same PR.
