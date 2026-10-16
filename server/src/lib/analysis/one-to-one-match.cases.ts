/**
 * The tie-semantics table for {@link matchOneToOneRefusingTies}, shared by every
 * join that adopts it (#1033 promotion, #1031 clarification attribution) so a
 * change to the rule is measured against the same cases everywhere.
 *
 * Lefts are `R*` (the requirement side), rights are `S*` (the other side), and
 * each score is a tier tuple compared with `compareTiersDescending`. Every case
 * is meant to be run in EVERY order of its candidates: none of them may depend
 * on list order.
 */
import type { OneToOneCandidate } from "./one-to-one-match.js";

export interface OneToOneTieCase {
  name: string;
  candidates: Array<OneToOneCandidate<string, string, number[]>>;
  /** Exactly the pairs that must be matched. */
  matches: Record<string, string>;
  /** Exactly the lefts and rights refused for a tie. */
  tiedLefts: string[];
  tiedRights: string[];
}

const c = (left: string, right: string, ...score: number[]) => ({ left, right, score });

export const ONE_TO_ONE_TIE_CASES: readonly OneToOneTieCase[] = [
  {
    name: "probe A: S1 is level on R1 and R2, S2 reaches only R2 — R2 takes S2, so S1 is R1's",
    candidates: [c("R1", "S1", 1), c("R2", "S1", 1), c("R2", "S2", 1)],
    matches: { R1: "S1", R2: "S2" },
    tiedLefts: [],
    tiedRights: [],
  },
  {
    name: "probe B (mirror): R1 is level on S1 and S2, R3 reaches only S1 — R3 takes S1, so S2 is R1's",
    candidates: [c("R1", "S1", 1), c("R1", "S2", 1), c("R3", "S1", 1)],
    matches: { R1: "S2", R3: "S1" },
    tiedLefts: [],
    tiedRights: [],
  },
  {
    name: "a right that two lefts reach equally, and nothing else, goes to neither",
    candidates: [c("R1", "S1", 1), c("R2", "S1", 1)],
    matches: {},
    tiedLefts: ["R1", "R2"],
    tiedRights: ["S1"],
  },
  {
    name: "a left that reaches two rights equally, and nothing else, takes neither",
    candidates: [c("R1", "S1", 1), c("R1", "S2", 1)],
    matches: {},
    tiedLefts: ["R1"],
    tiedRights: ["S1", "S2"],
  },
  {
    name: "a better tier breaks what the containment score alone would tie",
    candidates: [c("R1", "S1", 1, 1), c("R2", "S1", 0, 1)],
    matches: { R1: "S1" },
    tiedLefts: [],
    tiedRights: [],
  },
  {
    name: "no fallback: a left refused for a tie does not take a weaker match later",
    candidates: [c("R1", "S1", 1), c("R2", "S1", 1), c("R1", "S2", 0.5), c("R2", "S3", 0.5)],
    matches: {},
    tiedLefts: ["R1", "R2"],
    tiedRights: ["S1"],
  },
  {
    name: "no fallback: a right refused for a tie is not taken at a weaker level",
    candidates: [c("R1", "S1", 1), c("R1", "S2", 1), c("R3", "S1", 0.5)],
    matches: {},
    tiedLefts: ["R1"],
    tiedRights: ["S1", "S2"],
  },
  {
    name: "a left that only lost its options to forced pairs was in no tie, and may fall back",
    candidates: [
      c("V1", "P1", 1),
      c("X", "P1", 1),
      c("X", "P2", 1),
      c("V2", "P2", 1),
      c("X", "P3", 0.5),
    ],
    matches: { V1: "P1", V2: "P2", X: "P3" },
    tiedLefts: [],
    tiedRights: [],
  },
  {
    name: "two lefts each level on the same two rights are ambiguous: all refused",
    candidates: [c("R1", "S1", 1), c("R1", "S2", 1), c("R2", "S1", 1), c("R2", "S2", 1)],
    matches: {},
    tiedLefts: ["R1", "R2"],
    tiedRights: ["S1", "S2"],
  },
  {
    name: "run 9 (#1187 review): /v1/feeds keeps its own item; categories takes its own, never /v1/feeds's",
    // R-feeds = "Expose GET /v1/feeds API", R-cat = "Expose GET /v1/categories/{id}/feeds API";
    // S27 = "Expose GET /v1/feeds API route", S28 = "Expose GET /v1/categories/{id}/feeds API route".
    candidates: [
      c("R-feeds", "S27", 0, 1, 1),
      c("R-feeds", "S28", 0, 1, 1),
      c("R-cat", "S28", 0, 1, 1),
      c("R-cat", "S27", 0, 0.8, 0.8),
    ],
    matches: { "R-feeds": "S27", "R-cat": "S28" },
    tiedLefts: [],
    tiedRights: [],
  },
];
