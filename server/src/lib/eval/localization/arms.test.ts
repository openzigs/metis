import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AIProvider } from "../../ai/types.js";
import * as changeSeeds from "../../impact-analysis/change-seeds.js";
import { loadRecordedVectors } from "../recorded-vectors.js";
import {
  ARM_FACTORIES,
  buildArms,
  createA0Arm,
  createA2Arm,
  createA4Arm,
  createA11Arm,
  createA12Arm,
  mergeSeedings,
  parseArmIds,
  requirementText,
} from "./arms.js";
import { loadLocalizationCorpus } from "./corpus.js";
import { LedgerCostMeter } from "./cost.js";
import { runLocalizationEval, type LocalizationReport } from "./runner.js";
import {
  EmbedCache,
  assertNoMissingVectors,
  buildCorpusSearch,
  type CorpusSearch,
} from "./search.js";

// Pass-through by default; one test replaces a single seeding to pin what A0 ranks.
vi.mock("../../impact-analysis/change-seeds.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../impact-analysis/change-seeds.js")>();
  return { ...actual, resolveChangeSeeds: vi.fn(actual.resolveChangeSeeds) };
});

describe("mergeSeedings", () => {
  it("keeps a single seeding's order exactly", () => {
    expect(mergeSeedings([{ edit: ["r:b", "r:a"], other: ["r:c", "r:a", "r:d"] }])).toEqual({
      editCandidateFiles: ["r:b", "r:a"],
      rankedFiles: ["r:b", "r:a", "r:c", "r:d"],
    });
  });

  it("interleaves seedings by position, edits first, deduplicated", () => {
    const merged = mergeSeedings([
      { edit: ["x:1", "x:2"], other: ["x:9", "y:1"] },
      { edit: ["y:1"], other: ["y:8"] },
    ]);
    expect(merged.editCandidateFiles).toEqual(["x:1", "y:1", "x:2"]);
    expect(merged.rankedFiles).toEqual(["x:1", "y:1", "x:2", "x:9", "y:8"]);
  });

  it("is empty for no seeding", () => {
    expect(mergeSeedings([])).toEqual({ rankedFiles: [], editCandidateFiles: [] });
  });
});

describe("arm selection", () => {
  it("always runs A0, first, once", () => {
    expect(parseArmIds([])).toEqual(["A0"]);
    expect(parseArmIds(["--arms", "a4, A0 ,a4"])).toEqual(["A0", "A4"]);
  });

  it("fails loudly for an arm that is not built yet, naming its issue", () => {
    const deps = { search: {} as CorpusSearch };
    expect(() => buildArms(["A0", "A5"], deps)).toThrow(
      /A5 \(#1757 adaptive cap\) is not built yet/,
    );
    // #1756 — a model-backed arm refuses to run without a provider.
    expect(() => buildArms(["A0", "A4"], deps)).toThrow(/A4 calls a model: it needs a live/);
    expect(() => buildArms(["ZZ"], deps)).toThrow(/unknown arm "ZZ"/);
    expect(buildArms(["A0"], deps).map((a) => a.id)).toEqual(["A0"]);
    expect(Object.keys(ARM_FACTORIES)).toEqual(["A0", "A2", "A4", "A11", "A12"]);
  });

  it("gives the arms the requirement as an analyst would paste it", () => {
    expect(requirementText({ title: "T", text: "Body." })).toBe("T\n\nBody.");
  });
});

describe("A2 — A0 plus stored requirement links (#1754)", () => {
  // Every query finds a.go strongly and b.go weakly: b.go is under half the best
  // file, so the hybrid seeding lists it for review only. The mapper keeps it as
  // a stored link (relative confidence 0.3), so A2 makes it an edit candidate.
  const symbols = [
    {
      id: "r#a",
      repo: "r",
      name: "a",
      qualifiedName: "a.go::a",
      kind: "function",
      language: "go",
      filePath: "a.go",
      startLine: 1,
      endLine: 9,
    },
    {
      id: "r#b",
      repo: "r",
      name: "b",
      qualifiedName: "b.go::b",
      kind: "function",
      language: "go",
      filePath: "b.go",
      startLine: 1,
      endLine: 9,
    },
  ];
  const search: CorpusSearch = {
    searcher: {
      search: async () => [
        { symbolId: "r#a", filePath: "a.go", name: "a", kind: "function", score: 1 },
        { symbolId: "r#b", filePath: "b.go", name: "b", kind: "function", score: 0.3 },
      ],
    },
    loadSymbols: async (ids) =>
      symbols.filter((r) => ids.includes(r.id)).map((r) => ({ ...r, signature: null })),
    loadWriterIds: async () => new Set<string>(),
    embeddingModel: "toy",
    symbolsDigest: "toy",
  };
  const corpus = {
    manifest: { repos: [{ name: "r" }] },
    symbols,
  } as unknown as Parameters<ReturnType<typeof createA2Arm>["localize"]>[1];
  const item = { id: "I-1", title: "Change the order total", text: "Body." } as never;

  it("adds the stored links after A0's edit candidates, and keeps A0's ranking otherwise", async () => {
    const a0 = await createA0Arm({ search }).localize(item, corpus);
    const a2 = await createA2Arm({ search }).localize(item, corpus);
    expect(a0.editCandidateFiles).toEqual(["r:a.go"]);
    expect(a2.editCandidateFiles).toEqual(["r:a.go", "r:b.go"]);
    expect(a2.rankedFiles).toEqual(a0.rankedFiles);
  });

  it("names its link source in its configuration", () => {
    const arm = createA2Arm({ search });
    expect(arm.id).toBe("A2");
    expect(arm.configuration.links).toMatch(/mapRequirementToCode semantic links: top 10/);
    expect(arm.configuration.llm).toBe(false);
  });
});

describe("A4 — A0 plus the LLM edit-candidate check (#1756)", () => {
  // a.go is the only edit file; b.go is in the pool under the edit cut.
  const rows = ["a", "b"].map((n) => ({
    id: `r#${n}`,
    repo: "r",
    name: n,
    qualifiedName: `${n}.go::${n}`,
    kind: "function",
    language: "go",
    filePath: `${n}.go`,
    startLine: 1,
    endLine: 9,
  }));
  const search: CorpusSearch = {
    searcher: {
      search: async () => [
        { symbolId: "r#a", filePath: "a.go", name: "a", kind: "function", score: 1 },
        { symbolId: "r#b", filePath: "b.go", name: "b", kind: "function", score: 0.3 },
      ],
    },
    loadSymbols: async (ids) =>
      rows.filter((r) => ids.includes(r.id)).map((r) => ({ ...r, signature: null })),
    loadWriterIds: async () => new Set<string>(),
    embeddingModel: "toy",
    symbolsDigest: "toy",
  };
  const corpus = {
    manifest: { repos: [{ name: "r" }] },
    symbols: rows,
  } as unknown as Parameters<ReturnType<typeof createA4Arm>["localize"]>[1];
  const item = { id: "I-1", title: "Change the order total", text: "Body." } as never;
  const saying = (content: string) =>
    ({
      key: "anthropic",
      model: "claude-sonnet-5-5",
      offline: false,
      chat: vi.fn(async () => ({ content, model: "claude-sonnet-5-5" })),
    }) as unknown as AIProvider;

  it("appends a verified promotion after A0's edit candidates, and reports what the model named", async () => {
    const a0 = await createA0Arm({ search }).localize(item, corpus);
    const a4 = await createA4Arm({
      search,
      provider: saying('{"promote":[{"index":1,"line":4,"reason":"It sums the total."}]}'),
    }).localize(item, corpus);
    expect(a0.editCandidateFiles).toEqual(["r:a.go"]);
    expect(a4.editCandidateFiles).toEqual(["r:a.go", "r:b.go"]);
    expect(a4.llmNamedFiles).toEqual(["r:b.go"]);
  });

  it("is A0 when the model's answer cannot be read, and names its provider and model", async () => {
    const a0 = await createA0Arm({ search }).localize(item, corpus);
    const arm = createA4Arm({ search, provider: saying("no json") });
    const a4 = await arm.localize(item, corpus);
    expect({ ...a4, llmNamedFiles: undefined }).toEqual({ ...a0, llmNamedFiles: undefined });
    expect(a4.llmNamedFiles).toEqual([]);
    expect(arm.configuration).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      llm: true,
      poolFiles: 30,
      // #1781 — the report must not read A4's graph resolution as a finding.
      graphResolution: "1.00 by construction (pool indices only)",
    });
  });
});

describe("A0's ranking", () => {
  it("ranks the edit candidates, then the related hits, then the schema seeds (#1770)", async () => {
    const match = (filePath: string) =>
      ({ filePath }) as changeSeeds.ChangeSeeds["related"][number];
    vi.mocked(changeSeeds.resolveChangeSeeds).mockResolvedValueOnce({
      editCandidates: [match("edit.go"), match("edit.go")],
      related: [match("related.go")],
      schemaSeeds: [match("schema.sql")],
    });
    const corpus = {
      manifest: { repos: [{ name: "r" }] },
    } as unknown as Parameters<ReturnType<typeof createA0Arm>["localize"]>[1];
    const out = await createA0Arm({ search: {} as CorpusSearch }).localize(
      { id: "I-1", title: "One change", text: "Body." } as never,
      corpus,
    );
    expect(out).toEqual({
      editCandidateFiles: ["r:edit.go"],
      rankedFiles: ["r:edit.go", "r:related.go", "r:schema.sql"],
    });
  });
});

/**
 * A0 end to end on the committed fixture corpus, from its committed symbol rows
 * and recorded vectors: no model, no database. It must reproduce the committed
 * baseline report, so a change to seeding cannot move A0 without the baseline
 * being re-measured in the same PR.
 */
describe("A0 on the committed fixture-portfolio corpus", () => {
  it("reproduces the committed baseline", async () => {
    const corpus = await loadLocalizationCorpus("localization-02-fixture-portfolio");
    const recorded = await loadRecordedVectors(
      path.join(corpus.dir, "vectors.gte-modernbert-base.json"),
    );
    const cache = new EmbedCache(recorded, null, "pnpm eval:localization --embed");
    const search = await buildCorpusSearch(corpus.symbols, cache);
    const report = await runLocalizationEval(corpus, {
      arms: [createA0Arm({ search })],
      runs: 1,
      meter: new LedgerCostMeter(),
    });
    assertNoMissingVectors(cache);

    const baseline = JSON.parse(
      await readFile(path.join(corpus.dir, "baseline-A0.json"), "utf8"),
    ) as LocalizationReport;
    const [a0] = report.arms;
    const [b0] = baseline.arms;
    expect(a0!.configuration).toEqual(b0!.configuration);
    // The baseline averages three identical runs, so compare to 1e-9, not bit for bit.
    const rounded = (s: object) =>
      Object.fromEntries(
        Object.entries(s)
          .filter(([k]) => k !== "seconds" && k !== "runs")
          .map(([k, v]) => [k, typeof v === "number" ? Math.round(v * 1e9) / 1e9 : v]),
      );
    expect(a0!.items.map(rounded)).toEqual(b0!.items.map(rounded));
    expect(a0!.aggregate.recallAt10).toBe(1);
    expect(report.spentUsd).toBe(0);
  });
});

describe("A2 on the committed fixture-portfolio corpus (#1754)", () => {
  it("runs offline from the committed vectors, and cannot move: A0 already names every file", async () => {
    const corpus = await loadLocalizationCorpus("localization-02-fixture-portfolio");
    const recorded = await loadRecordedVectors(
      path.join(corpus.dir, "vectors.gte-modernbert-base.json"),
    );
    const cache = new EmbedCache(recorded, null, "pnpm eval:localization --embed");
    const search = await buildCorpusSearch(corpus.symbols, cache);
    const report = await runLocalizationEval(corpus, {
      arms: [createA0Arm({ search }), createA2Arm({ search })],
      runs: 1,
      meter: new LedgerCostMeter(),
    });
    assertNoMissingVectors(cache);
    const [a0, a2] = report.arms;
    expect(a2!.aggregate.recallAt5).toBe(a0!.aggregate.recallAt5);
    expect(a2!.aggregate.editPrecision).toBe(a0!.aggregate.editPrecision);
    expect(a0!.aggregate.meanEditCandidates).toBe(10);
  });
});

describe("A11 on the committed fixture-portfolio corpus (#1776)", () => {
  it("names at most five edit files per requirement where A0 names ten, and moves the rest down", async () => {
    const corpus = await loadLocalizationCorpus("localization-02-fixture-portfolio");
    const recorded = await loadRecordedVectors(
      path.join(corpus.dir, "vectors.gte-modernbert-base.json"),
    );
    const cache = new EmbedCache(recorded, null, "pnpm eval:localization --embed");
    const search = await buildCorpusSearch(corpus.symbols, cache);
    const report = await runLocalizationEval(corpus, {
      arms: [createA0Arm({ search }), createA11Arm({ search })],
      runs: 1,
      meter: new LedgerCostMeter(),
    });
    assertNoMissingVectors(cache);
    const [a0, a11] = report.arms;
    expect(a0!.aggregate.meanEditCandidates).toBe(10);
    expect(a11!.aggregate.meanEditCandidates).toBe(changeSeeds.MAX_EDIT_FILES);
    // The demoted files stay in the ranking: every file is still ranked.
    expect(a11!.aggregate.recallAt10).toBe(1);
    expect(a11!.configuration.stage).toMatch(/rankEditCandidatesPerRequest/);
    expect(report.spentUsd).toBe(0);
  });
});

/**
 * #1784 — A12 end to end on the committed fixture corpus: the per-request
 * ranking on the cross-search (cosine) score. Deterministic, so the reading
 * recorded in docs/ARCHITECTURE.md is pinned here: a change to the score or
 * the margin must re-measure it.
 */
describe("A12 on the committed fixture-portfolio corpus (#1784)", () => {
  it("separates the repositories the fused score cannot, and reproduces the recorded reading", async () => {
    const corpus = await loadLocalizationCorpus("localization-02-fixture-portfolio");
    const recorded = await loadRecordedVectors(
      path.join(corpus.dir, "vectors.gte-modernbert-base.json"),
    );
    const cache = new EmbedCache(recorded, null, "pnpm eval:localization --embed");
    const search = await buildCorpusSearch(corpus.symbols, cache);
    const report = await runLocalizationEval(corpus, {
      arms: [createA0Arm({ search }), createA11Arm({ search }), createA12Arm({ search })],
      runs: 1,
      meter: new LedgerCostMeter(),
    });
    assertNoMissingVectors(cache);
    const [a0, a11, a12] = report.arms;
    // A11 keeps five files and still names another repository on every item.
    expect(a11!.aggregate.repoConfinement).toEqual({ confined: 0, of: 14 });
    expect(a12!.aggregate.meanEditCandidates).toBeCloseTo(53 / 15, 9);
    expect(a12!.aggregate.repoConfinement).toEqual({ confined: 3, of: 14 });
    expect(a12!.aggregate.editPrecision).toBeGreaterThan(a11!.aggregate.editPrecision);
    expect(a12!.aggregate.recallAt5).toBeGreaterThan(a0!.aggregate.recallAt5);
    expect(a12!.aggregate.recallAt10).toBe(1);
    expect(a12!.configuration.stage).toMatch(/rankEditCandidatesPerRequest\(cosine\)/);
    expect(a12!.configuration.editCut).toContain(String(changeSeeds.REQUEST_COSINE_MARGIN));
    expect(report.spentUsd).toBe(0);
  });
});
