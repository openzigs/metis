/**
 * #1784 — per-request edit ranking on a score that compares across searches:
 * the vector cosine the hybrid search already returns, carried through the
 * seeding, instead of the fused RRF score (rank 1 scores the same in every
 * search, so separate seedings' fused scores are near-ties).
 */
import { describe, expect, it } from "vitest";
import type { RequirementCodeMatch } from "../traceability/requirement-code-mapping.js";
import {
  MAX_EDIT_FILES,
  REQUEST_COSINE_MARGIN,
  crossSearchScore,
  rankEditCandidatesPerRequest,
  rankEditFileScores,
  rankRequestEditFiles,
  resolveChangeSeeds,
  type ChangeSeeds,
  type EditFileScore,
  type RequestSeeding,
  type SeedSearchHit,
  type SeedSearcher,
  type SeedSymbolLoader,
} from "./change-seeds.js";

const match = (filePath: string): RequirementCodeMatch => ({
  codeSymbolId: `${filePath}#f`,
  filePath,
  qualifiedName: `${filePath}::f`,
  startLine: 1,
  endLine: 9,
  confidence: 1,
});

/** A seeding whose hybrid edit files carry the given fused score and cosine. */
function seeded(projectId: string, files: Record<string, [number, number?]>): RequestSeeding {
  const editFileScores: EditFileScore[] = Object.entries(files)
    .map(([filePath, [score, cosine]]) => ({
      filePath,
      score,
      ...(cosine !== undefined ? { cosine } : {}),
    }))
    .sort((a, b) => b.score - a.score);
  const seeds: ChangeSeeds = {
    editCandidates: editFileScores.map((f) => match(f.filePath)),
    related: [],
    schemaSeeds: [],
    editFileScores,
  };
  return { projectId, seeds };
}

const kept = (files: ReturnType<typeof rankRequestEditFiles>) =>
  files.map((f) => `${f.projectId}/${f.filePath}`);

describe("resolveChangeSeeds carries the vector cosine (#1784)", () => {
  const rows = ["a.go", "a.go", "b.go"].map((filePath, i) => ({
    id: `s${i}`,
    qualifiedName: `${filePath}::f${i}`,
    filePath,
    kind: "function",
    language: "go",
    startLine: 1 + i * 10,
    endLine: 5 + i * 10,
  }));
  const loadSymbols: SeedSymbolLoader = async (ids) => rows.filter((r) => ids.includes(r.id));
  const change = { title: "Do a thing", body: "Do a thing well." };
  const hit = (i: number, score: number, vectorScore?: number): SeedSearchHit => ({
    symbolId: rows[i]!.id,
    filePath: rows[i]!.filePath,
    name: "f",
    kind: "function",
    score,
    ...(vectorScore !== undefined ? { vectorScore } : {}),
  });

  it("gives each edit file its best hit's cosine, across both queries", async () => {
    // The title query and the whole-text query see s0 at different cosines.
    const answers = [
      [hit(0, 1, 0.61), hit(1, 0.9, 0.58), hit(2, 0.7)],
      [hit(0, 1, 0.66), hit(2, 0.8)],
    ];
    let call = 0;
    const searcher: SeedSearcher = { search: async () => answers[call++] ?? [] };
    const seeds = await resolveChangeSeeds(change, "p", {
      searcher,
      loadSymbols,
      editFileScores: true,
    });
    expect(call).toBe(2);
    expect(seeds.editFileScores).toEqual([
      // a.go: s0 fused 2 (both queries) + s1 0.9 × ½; best cosine 0.66, not 0.61.
      { filePath: "a.go", score: 2.45, cosine: 0.66 },
      // b.go: found only by keywords, so no cosine at all.
      { filePath: "b.go", score: 1.5 },
    ]);
  });
});

describe("rankEditFileScores with cosines (#1784)", () => {
  it("keeps the best cosine of a file's hits, and none for a keyword-only file", () => {
    expect(
      rankEditFileScores([
        { filePath: "a.go", score: 1, vectorScore: 0.5 },
        { filePath: "a.go", score: 0.8, vectorScore: 0.7 },
        { filePath: "b.go", score: 0.9 },
      ]),
    ).toEqual([
      { filePath: "a.go", score: 1.4, cosine: 0.7 },
      { filePath: "b.go", score: 0.9 },
    ]);
  });
});

describe("crossSearchScore (#1784)", () => {
  const seeding: EditFileScore[] = [
    { filePath: "a.go", score: 0.06, cosine: 0.7 },
    { filePath: "b.go", score: 0.03, cosine: 0.75 },
    { filePath: "c.go", score: 0.015 },
  ];

  it("is the file's share of its seeding's best fused score, times the seeding's best cosine", () => {
    expect(crossSearchScore(seeding[0]!, seeding)).toBeCloseTo(0.75);
    expect(crossSearchScore(seeding[1]!, seeding)).toBeCloseTo(0.375);
    // A keyword-only file of a seeding that has a cosine is still scored.
    expect(crossSearchScore(seeding[2]!, seeding)).toBeCloseTo(0.1875);
  });

  it("is undefined when the seeding has no cosine, or no positive score", () => {
    const keywords = [{ filePath: "a.go", score: 1 }];
    expect(crossSearchScore(keywords[0]!, keywords)).toBeUndefined();
    const zero = [{ filePath: "a.go", score: 0, cosine: 0.7 }];
    expect(crossSearchScore(zero[0]!, zero)).toBeUndefined();
  });
});

describe("rankRequestEditFiles on the cosine basis (#1784)", () => {
  it("separates projects whose fused scores tie: the far project names nothing", () => {
    // The #1776 failure: every project's best file scores about 0.06.
    const seedings = [
      seeded("orders", { "repo.ts": [0.061, 0.74], "routes.ts": [0.06, 0.7] }),
      seeded("billing", { "invoice.ts": [0.062, 0.55] }),
    ];
    expect(kept(rankRequestEditFiles(seedings))).toEqual([
      "billing/invoice.ts",
      "orders/repo.ts",
      "orders/routes.ts",
    ]);
    expect(kept(rankRequestEditFiles(seedings, "cosine"))).toEqual([
      "orders/repo.ts",
      "orders/routes.ts",
    ]);
  });

  it(`keeps a file exactly ${REQUEST_COSINE_MARGIN} below the best and drops one further down`, () => {
    const best = 0.75;
    const ranked = rankRequestEditFiles(
      [
        seeded("p", { "best.go": [1, best] }),
        seeded("q", { "edge.go": [1, best - REQUEST_COSINE_MARGIN] }),
        seeded("r", { "out.go": [1, best - REQUEST_COSINE_MARGIN - 0.001] }),
      ],
      "cosine",
    );
    expect(kept(ranked)).toEqual(["p/best.go", "q/edge.go"]);
    expect(ranked[0]!.score).toBeCloseTo(best);
  });

  it(`caps the request at ${MAX_EDIT_FILES} files, best cross score first`, () => {
    const files = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`f${i}.go`, [1 - i * 0.001, 0.7] as [number, number]]),
    );
    expect(kept(rankRequestEditFiles([seeded("p", files)], "cosine"))).toEqual(
      ["f0.go", "f1.go", "f2.go", "f3.go", "f4.go"].map((f) => `p/${f}`),
    );
  });

  it("counts a file several changes found once, at its best cross score", () => {
    const ranked = rankRequestEditFiles(
      [seeded("p", { "a.go": [1, 0.6] }), seeded("p", { "a.go": [1, 0.7] })],
      "cosine",
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.score).toBeCloseTo(0.7);
  });

  it("never ranks away a keyword-only seeding's files: they cannot be compared", () => {
    const ranked = rankRequestEditFiles(
      [seeded("p", { "a.go": [1, 0.76] }), seeded("bm25", { "k.go": [5] })],
      "cosine",
    );
    expect(kept(ranked)).toEqual(["p/a.go", "bm25/k.go"]);
  });
});

describe("rankEditCandidatesPerRequest on the cosine basis (#1784)", () => {
  it("demotes the far project's files to related and keeps them as radius seeds", () => {
    const seedings = [
      seeded("orders", { "repo.ts": [0.06, 0.74] }),
      seeded("billing", { "invoice.ts": [0.06, 0.6] }),
    ];
    const [orders, billing] = rankEditCandidatesPerRequest(seedings, "cosine");
    expect(orders).toBe(seedings[0]!.seeds);
    expect(billing!.editCandidates).toEqual([]);
    expect(billing!.related.map((m) => m.filePath)).toEqual(["invoice.ts"]);
    expect(billing!.radiusSeeds?.map((m) => m.filePath)).toEqual(["invoice.ts"]);
    // The fused basis (#1776) cannot tell the two apart and keeps both.
    const fused = rankEditCandidatesPerRequest(seedings);
    expect(fused[1]).toBe(seedings[1]!.seeds);
  });
});
