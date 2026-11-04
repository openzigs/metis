/**
 * #1776 — edit candidates ranked once per request, across every change and
 * project, instead of once per change per project.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { RequirementCodeMatch } from "../traceability/requirement-code-mapping.js";
import {
  MAX_EDIT_FILES,
  RELATED_CONFIDENCE_FACTOR,
  impactRequestEditRankingEnabled,
  rankEditCandidatesPerRequest,
  rankEditFileScores,
  rankRequestEditFiles,
  resolveChangeSeeds,
  type ChangeSeeds,
  type RequestSeeding,
  type SeedSearcher,
  type SeedSymbolLoader,
} from "./change-seeds.js";

const match = (filePath: string, confidence = 1, id = `${filePath}#f`): RequirementCodeMatch => ({
  codeSymbolId: id,
  filePath,
  qualifiedName: `${filePath}::f`,
  startLine: 1,
  endLine: 9,
  confidence,
});

/** A seeding whose hybrid edit files score as given, one symbol each. */
function seeded(
  projectId: string,
  files: Record<string, number>,
  extra: Partial<ChangeSeeds> = {},
) {
  const editFileScores = Object.entries(files)
    .map(([filePath, score]) => ({ filePath, score }))
    .sort((a, b) => b.score - a.score);
  const seeds: ChangeSeeds = {
    editCandidates: editFileScores.map((f) => match(f.filePath, f.score)),
    related: [match("rel.go", 0.1, `${projectId}-rel`)],
    schemaSeeds: [],
    editFileScores,
    ...extra,
  };
  return { projectId, seeds } satisfies RequestSeeding;
}

const editFilesOf = (s: ChangeSeeds) => [...new Set(s.editCandidates.map((m) => m.filePath))];

describe("rankEditFileScores (#1776)", () => {
  it("is rankEditFiles with each file's score", () => {
    expect(
      rankEditFileScores([
        { filePath: "a.go", score: 1 },
        { filePath: "a.go", score: 1 },
        { filePath: "b.go", score: 0.4 },
      ]),
    ).toEqual([{ filePath: "a.go", score: 1.5 }]);
  });
});

describe("rankRequestEditFiles (#1776)", () => {
  it("cuts once against the request's single best file: a project far below it names none", () => {
    const kept = rankRequestEditFiles([
      seeded("orders", { "repo.ts": 1, "routes.ts": 0.8 }),
      seeded("billing", { "invoice.ts": 0.4 }),
    ]);
    expect(kept).toEqual([
      { projectId: "orders", filePath: "repo.ts", score: 1 },
      { projectId: "orders", filePath: "routes.ts", score: 0.8 },
    ]);
  });

  it("caps the REQUEST, not each change: several changes name the best files at most", () => {
    const changes = [0, 1, 2].map((c) =>
      seeded(
        "p",
        Object.fromEntries([0, 1, 2, 3].map((i) => [`c${c}-${i}.go`, 1 - c * 0.01 - i * 0.02])),
      ),
    );
    const kept = rankRequestEditFiles(changes);
    expect(kept).toHaveLength(MAX_EDIT_FILES);
    expect(kept.map((f) => f.filePath)).toEqual([
      "c0-0.go",
      "c1-0.go",
      "c0-1.go",
      "c2-0.go",
      "c1-1.go",
    ]);
  });

  it("counts a file several changes found once, at its best score", () => {
    const kept = rankRequestEditFiles([
      seeded("p", { "a.go": 0.6, "b.go": 0.9 }),
      seeded("p", { "a.go": 1 }),
    ]);
    expect(kept).toEqual([
      { projectId: "p", filePath: "a.go", score: 1 },
      { projectId: "p", filePath: "b.go", score: 0.9 },
    ]);
  });

  it("keeps two projects' files of the same path apart", () => {
    const kept = rankRequestEditFiles([seeded("p1", { "a.go": 1 }), seeded("p2", { "a.go": 1 })]);
    expect(kept.map((f) => f.projectId)).toEqual(["p1", "p2"]);
  });

  it("names nothing when no seeding carries scores, or the best scores zero", () => {
    const unscored = { ...seeded("p", { "a.go": 1 }).seeds, editFileScores: undefined };
    expect(rankRequestEditFiles([{ projectId: "p", seeds: unscored }])).toEqual([]);
    expect(rankRequestEditFiles([seeded("p", { "a.go": 0 })])).toEqual([]);
  });
});

describe("rankEditCandidatesPerRequest (#1776)", () => {
  it("moves a dropped file's symbols to the head of related, at the related scale, and keeps them as radius seeds", () => {
    const orders = seeded("orders", { "repo.ts": 1 });
    const billing = seeded("billing", { "invoice.ts": 0.4 });
    const [o, b] = rankEditCandidatesPerRequest([orders, billing]);
    expect(o).toBe(orders.seeds);
    expect(editFilesOf(b!)).toEqual([]);
    expect(b!.related.map((m) => [m.filePath, m.confidence])).toEqual([
      ["invoice.ts", 0.4 * RELATED_CONFIDENCE_FACTOR],
      ["rel.go", 0.1],
    ]);
    expect(b!.radiusSeeds).toEqual([match("invoice.ts", 0.4)]);
  });

  it("splits a multi-change request: only the request's best files stay edit candidates", () => {
    const one = seeded("p", { "a.go": 1, "b.go": 0.9, "c.go": 0.8 });
    const two = seeded("p", { "d.go": 0.95, "e.go": 0.85, "f.go": 0.7 });
    const [r1, r2] = rankEditCandidatesPerRequest([one, two]);
    expect([...editFilesOf(r1!), ...editFilesOf(r2!)].sort()).toEqual([
      "a.go",
      "b.go",
      "c.go",
      "d.go",
      "e.go",
    ]);
    expect(r2!.radiusSeeds!.map((m) => m.filePath)).toEqual(["f.go"]);
  });

  it("never drops a file a stored link names, nor a candidate with no hybrid score", () => {
    const linked = seeded(
      "p2",
      { "linked.go": 0.1 },
      {
        evidence: {
          storedLinks: { used: 1, stale: 0 },
          editCandidates: [{ filePath: "linked.go", channels: ["hybrid", "stored-link"] }],
        },
      },
    );
    const unscored = seeded("p3", {}, { editCandidates: [match("injected.go", 0.05)] });
    const [, l, u] = rankEditCandidatesPerRequest([seeded("p1", { "a.go": 1 }), linked, unscored]);
    expect(l).toBe(linked.seeds);
    expect(u).toBe(unscored.seeds);
  });

  it("drops the hybrid-only evidence entry and unmarks the dropped file in the verifier's pool", () => {
    const pool = (filePath: string, editCandidate: boolean) => ({
      filePath,
      score: 0.1,
      editCandidate,
      symbols: [],
    });
    const weak = seeded(
      "p2",
      { "weak.go": 0.1 },
      {
        evidence: {
          storedLinks: { used: 0, stale: 0 },
          editCandidates: [{ filePath: "weak.go", channels: ["hybrid"] }],
        },
        filePool: [pool("weak.go", true), pool("other.go", false)],
      },
    );
    const [, w] = rankEditCandidatesPerRequest([seeded("p1", { "a.go": 1 }), weak]);
    expect(w!.evidence!.editCandidates).toEqual([]);
    expect(w!.filePool!.map((f) => [f.filePath, f.editCandidate])).toEqual([
      ["weak.go", false],
      ["other.go", false],
    ]);
  });

  it("changes nothing for a request seeded once", () => {
    const only = seeded("p", { "a.go": 1, "b.go": 0.6 });
    expect(rankEditCandidatesPerRequest([only])[0]).toBe(only.seeds);
  });
});

describe("resolveChangeSeeds with editFileScores (#1776)", () => {
  const rows = ["a.go", "b.go"].map((filePath, i) => ({
    id: `s${i}`,
    qualifiedName: `${filePath}::f`,
    filePath,
    kind: "function",
    language: "go",
    startLine: 1,
    endLine: 5,
  }));
  const searcher: SeedSearcher = {
    search: async () =>
      rows.map((r, i) => ({
        symbolId: r.id,
        filePath: r.filePath,
        name: "f",
        kind: "function",
        score: i === 0 ? 1 : 0.6,
      })),
  };
  const loadSymbols: SeedSymbolLoader = async (ids) => rows.filter((r) => ids.includes(r.id));
  const change = { title: "Do a thing", body: "Do a thing well." };

  it("returns each edit file's score only when asked", async () => {
    const asked = await resolveChangeSeeds(change, "p", {
      searcher,
      loadSymbols,
      editFileScores: true,
    });
    expect(asked.editFileScores).toEqual([
      { filePath: "a.go", score: 2 },
      { filePath: "b.go", score: 1.2 },
    ]);
    const plain = await resolveChangeSeeds(change, "p", { searcher, loadSymbols });
    expect("editFileScores" in plain).toBe(false);
    expect(plain.editCandidates).toEqual(asked.editCandidates);
  });
});

describe("impactRequestEditRankingEnabled (#1776)", () => {
  const prior = process.env.IMPACT_REQUEST_EDIT_RANKING;
  afterEach(() => {
    if (prior === undefined) delete process.env.IMPACT_REQUEST_EDIT_RANKING;
    else process.env.IMPACT_REQUEST_EDIT_RANKING = prior;
  });

  it("is off by default and on only when the flag says so", () => {
    delete process.env.IMPACT_REQUEST_EDIT_RANKING;
    expect(impactRequestEditRankingEnabled()).toBe(false);
    process.env.IMPACT_REQUEST_EDIT_RANKING = "1";
    expect(impactRequestEditRankingEnabled()).toBe(true);
  });
});
