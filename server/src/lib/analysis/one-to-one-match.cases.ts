/**
 * The tie-semantics table for {@link matchOneToOneRefusingTies}, shared by every
 * join that adopts it (#1033 promotion, #1031 clarification attribution) so a
 * change to the rule is measured against the same cases everywhere.
 *
 * The rule: at each level, a pair is taken only if it is in EVERY maximum
 * matching of the live candidates; every other vertex with a candidate there is
 * refused and takes nothing weaker later.
 *
 * Lefts are `R*` (the requirement side), rights are `S*` (the other side), and
 * each score is a tier tuple compared with `compareTiersDescending`. Every case
 * is meant to be run in EVERY order of its candidates: none may depend on it.
 */
import type { OneToOneCandidate } from "./one-to-one-match.js";

export interface OneToOneTieCase {
  name: string;
  candidates: Array<OneToOneCandidate<string, string, number[]>>;
  /** Exactly the pairs that must be matched. */
  matches: Record<string, string>;
  /** Exactly the lefts and rights refused. */
  refusedLefts: string[];
  refusedRights: string[];
}

const c = (left: string, right: string, ...score: number[]) => ({ left, right, score });

export const ONE_TO_ONE_TIE_CASES: readonly OneToOneTieCase[] = [
  {
    name: "probe A: S1 level on R1 and R2, S2 reaching only R2 — one maximum matching, both pairs forced",
    candidates: [c("R1", "S1", 1), c("R2", "S1", 1), c("R2", "S2", 1)],
    matches: { R1: "S1", R2: "S2" },
    refusedLefts: [],
    refusedRights: [],
  },
  {
    name: "probe B (mirror): R1 level on S1 and S2, R3 reaching only S1 — one maximum matching, both forced",
    candidates: [c("R1", "S1", 1), c("R1", "S2", 1), c("R3", "S1", 1)],
    matches: { R1: "S2", R3: "S1" },
    refusedLefts: [],
    refusedRights: [],
  },
  {
    name: "the chain S1:{R1}, S2:{R1,R2}, S3:{R2} has three maximum matchings — nothing is forced",
    candidates: [c("R1", "S1", 1), c("R1", "S2", 1), c("R2", "S2", 1), c("R2", "S3", 1)],
    matches: {},
    refusedLefts: ["R1", "R2"],
    refusedRights: ["S1", "S2", "S3"],
  },
  {
    name: "a right that two lefts reach equally, and nothing else, goes to neither",
    candidates: [c("R1", "S1", 1), c("R2", "S1", 1)],
    matches: {},
    refusedLefts: ["R1", "R2"],
    refusedRights: ["S1"],
  },
  {
    name: "a left that reaches two rights equally, and nothing else, takes neither",
    candidates: [c("R1", "S1", 1), c("R1", "S2", 1)],
    matches: {},
    refusedLefts: ["R1"],
    refusedRights: ["S1", "S2"],
  },
  {
    name: "a better tier breaks what the containment score alone would tie",
    candidates: [c("R1", "S1", 1, 1), c("R2", "S1", 0, 1)],
    matches: { R1: "S1" },
    refusedLefts: [],
    refusedRights: [],
  },
  {
    name: "no fallback: a left refused for a tie does not take a weaker match later",
    candidates: [c("R1", "S1", 1), c("R2", "S1", 1), c("R1", "S2", 0.5), c("R2", "S3", 0.5)],
    matches: {},
    refusedLefts: ["R1", "R2"],
    refusedRights: ["S1"],
  },
  {
    name: "no fallback: a right refused for a tie is not taken at a weaker level",
    candidates: [c("R1", "S1", 1), c("R1", "S2", 1), c("R3", "S1", 0.5)],
    matches: {},
    refusedLefts: ["R1"],
    refusedRights: ["S1", "S2"],
  },
  {
    name: "no fallback: a left that only lost its options to others' ties does not fall back",
    // R3 is level with R1 and R2 on S1; it is in that tie's level graph, so it
    // is refused there and must not take S9 one level down.
    candidates: [c("R1", "S1", 1), c("R2", "S1", 1), c("R3", "S1", 1), c("R3", "S9", 0.5)],
    matches: {},
    refusedLefts: ["R1", "R2", "R3"],
    refusedRights: ["S1"],
  },
  {
    name: "several maximum matchings around a shared middle: nothing forced, nobody falls back",
    candidates: [
      c("V1", "P1", 1),
      c("X", "P1", 1),
      c("X", "P2", 1),
      c("V2", "P2", 1),
      c("X", "P3", 0.5),
    ],
    matches: {},
    refusedLefts: ["V1", "V2", "X"],
    refusedRights: ["P1", "P2"],
  },
  {
    name: "two lefts each level on the same two rights are ambiguous: all refused",
    candidates: [c("R1", "S1", 1), c("R1", "S2", 1), c("R2", "S1", 1), c("R2", "S2", 1)],
    matches: {},
    refusedLefts: ["R1", "R2"],
    refusedRights: ["S1", "S2"],
  },
  {
    name: "a long path with one perfect matching is forced end to end (needs more than one peel)",
    // R1–S1–R2–S2–R3–S3: only {R1S1, R2S2, R3S3} covers every vertex.
    candidates: [
      c("R1", "S1", 1),
      c("R2", "S1", 1),
      c("R2", "S2", 1),
      c("R3", "S2", 1),
      c("R3", "S3", 1),
    ],
    matches: { R1: "S1", R2: "S2", R3: "S3" },
    refusedLefts: [],
    refusedRights: [],
  },
  {
    name: "the mirrored long path is forced from the right-hand end",
    // S1–R1–S2–R2–S3–R3: only {R1S1, R2S2, R3S3} covers every vertex.
    candidates: [
      c("R1", "S1", 1),
      c("R1", "S2", 1),
      c("R2", "S2", 1),
      c("R2", "S3", 1),
      c("R3", "S3", 1),
    ],
    matches: { R1: "S1", R2: "S2", R3: "S3" },
    refusedLefts: [],
    refusedRights: [],
  },
  {
    name: "a forced pair one level down still stands after an earlier level refused others",
    candidates: [c("R1", "S1", 1), c("R2", "S1", 1), c("R3", "S3", 0.5)],
    matches: { R3: "S3" },
    refusedLefts: ["R1", "R2"],
    refusedRights: ["S1"],
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
    refusedLefts: [],
    refusedRights: [],
  },
];
