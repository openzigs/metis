import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as changeSeeds from "../../impact-analysis/change-seeds.js";
import { loadRecordedVectors } from "../recorded-vectors.js";
import {
  ARM_FACTORIES,
  buildArms,
  createA0Arm,
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
    expect(() => buildArms(["A0", "A4"], deps)).toThrow(
      /A4 \(#1756 rerank-and-verify\) is not built yet/,
    );
    expect(() => buildArms(["ZZ"], deps)).toThrow(/unknown arm "ZZ"/);
    expect(buildArms(["A0"], deps).map((a) => a.id)).toEqual(["A0"]);
    expect(Object.keys(ARM_FACTORIES)).toEqual(["A0"]);
  });

  it("gives the arms the requirement as an analyst would paste it", () => {
    expect(requirementText({ title: "T", text: "Body." })).toBe("T\n\nBody.");
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
