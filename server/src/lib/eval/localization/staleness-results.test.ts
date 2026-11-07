/**
 * #1834 — the staleness slice's measured results, read back from the committed
 * run records with the runner's own scoring and statistics:
 *
 *   - `__fixtures__/staleness-sonnet-2026-11-06.partials.jsonl`: every
 *     requirement score of A0, A7, A7K, A7S and A7SD on both held-out corpora,
 *     one run, claude-sonnet-5-5 (the partial files `--merge` reads, with each
 *     corpus's recorded configuration);
 *   - `__fixtures__/staleness-table-guard-deepseek-2026-11-06.runs.jsonl`: the
 *     table guard's run records, deepseek-flash, 3 runs;
 *   - `__fixtures__/staleness-noop-reingest-sonnet-2026-11-07.partials.jsonl`
 *     (#1915): every requirement score of A0, A7, A7R, A7RD, A7S and A7SD on
 *     both held-out corpora, one run, claude-sonnet-5-5, on fresh analyses.
 *
 * The figures asserted here are the ones eval-data/README.md, #1834 and #1915 report.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadImpactRecallFixture, resolveCorpusDir } from "../impact-recall/fixture.js";
import { loadLocalizationCorpus, type LocalizationCorpusName } from "./corpus.js";
import {
  corpusDigest,
  fingerprintDigest,
  recordedArms,
  type PartialRecord,
  type RunFingerprint,
} from "./partials.js";
import {
  poolHeldOutReports,
  runLocalizationEval,
  type LocalizationReport,
  type PooledComparison,
} from "./runner.js";
import {
  guardPairedDifferences,
  guardScoringOf,
  parseGuardRecord,
  type GuardRunRecord,
  type GuardScoring,
} from "./table-guard-agent.js";
import { TABLE_GUARD_CORPUS } from "./table-guard-source.js";

const fixtures = path.join(import.meta.dirname, "__fixtures__");

type Line = { kind: "config"; config: RunFingerprint } | ({ kind: "score" } & PartialRecord);

async function lines(file: string): Promise<string[]> {
  return (await readFile(path.join(fixtures, file), "utf8"))
    .split("\n")
    .filter((l) => l.trim() !== "");
}

/** Each corpus's report, from its recorded configuration and scores, as `--merge` builds it. */
async function reports(file: string, references: string[]): Promise<LocalizationReport[]> {
  const parsed = (await lines(file)).map((l) => JSON.parse(l) as Line);
  const configs = parsed.flatMap((l) => (l.kind === "config" ? [l.config] : []));
  const out: LocalizationReport[] = [];
  for (const config of configs) {
    const corpus = await loadLocalizationCorpus(config.corpus as LocalizationCorpusName);
    // The records still describe the committed corpus, under the recorded configuration.
    expect(config.corpusDigest).toBe(corpusDigest(corpus));
    const digest = fingerprintDigest(config);
    const recorded = parsed.flatMap((l) =>
      l.kind === "score" && l.corpus === config.corpus
        ? [
            (() => {
              expect(l.fingerprint).toBe(digest);
              const { arm, run, item, score, spentUsd, unpricedCalls } = l;
              return { arm, run, item, score, spentUsd, unpricedCalls };
            })(),
          ]
        : [],
    );
    out.push(
      await runLocalizationEval(corpus, {
        arms: recordedArms(config),
        runs: config.runs,
        meter: { spentUsd: () => 0, unpricedCalls: () => 0 },
        checkpoint: {
          recorded,
          record: () => Promise.reject(new Error("a merge runs no requirement")),
        },
        runItem: () => false,
        references,
      }),
    );
  }
  return out;
}

const metric = (cmp: PooledComparison | undefined, name: string) => {
  const m = cmp?.metrics.find((x) => x.metric === name);
  if (!m) throw new Error(`no ${name}`);
  return m;
};

describe("the staleness slice's held-out results (#1834, claude-sonnet-5-5)", async () => {
  const all = await reports("staleness-sonnet-2026-11-06.partials.jsonl", ["A7", "A7S"]);
  const pooled = poolHeldOutReports(all);
  const against = (arm: string, baseline: string) =>
    pooled.referenceComparisons.find((c) => c.arm === arm && c.baseline === baseline);

  it("covers every held-out item on every arm, on one model", () => {
    expect(pooled.items).toBe(39);
    expect(pooled.corpora.map((c) => [c.id, c.items, c.missingScores])).toEqual([
      ["localization-01-miniflux-heldout", 24, 0],
      ["localization-02-fixture-portfolio", 15, 0],
    ]);
    for (const r of all) {
      expect(r.arms.map((a) => a.id)).toEqual(["A0", "A7", "A7K", "A7S", "A7SD"]);
      for (const a of r.arms.filter((x) => x.id !== "A0")) {
        expect(a.configuration.model).toBe("claude-sonnet-5-5");
      }
    }
  });

  it("no staleness: demotion changes nothing (A7K equals A7 on every item)", () => {
    const k = against("A7K", "A7");
    for (const name of ["recallAt5", "recallAt10", "editPrecision", "reciprocalRank"]) {
      expect(metric(k, name).meanDifference).toBe(0);
    }
  });

  it("staleness, no demotion: A7S is within noise of A7", () => {
    const r5 = metric(against("A7S", "A7"), "recallAt5");
    expect(r5.meanDifference).toBeCloseTo(-0.017, 3);
    expect(r5.verdict).toBe("no measurable difference");
  });

  it("staleness, with demotion: A7SD reads lower Recall@5 and MRR than A7S", () => {
    const r5 = metric(against("A7SD", "A7S"), "recallAt5");
    expect(r5.meanDifference).toBeCloseTo(-0.061, 3);
    expect(r5.ci[1]).toBeLessThan(0);
    expect(r5.verdict).toBe("worse");
    const mrr = metric(against("A7SD", "A7S"), "reciprocalRank");
    expect(mrr.meanDifference).toBeCloseTo(-0.189, 3);
    expect(mrr.verdict).toBe("worse");
  });

  it("the patches left citations stale on both corpora, and demotion set every stale one aside", () => {
    const counts = all.map((r) => {
      const of = (id: string) =>
        r.arms.find((a) => a.id === id)!.aggregate.agent!.citationFreshness!;
      return { corpus: r.corpus.id, keep: of("A7S"), demote: of("A7SD") };
    });
    expect(counts.map((c) => [c.corpus, c.keep.stale, c.keep.moved, c.keep.fresh])).toEqual([
      ["localization-01-miniflux-heldout", 151, 97, 278],
      ["localization-02-fixture-portfolio", 195, 70, 525],
    ]);
    for (const c of counts) {
      expect(c.keep.demoted).toBe(0);
      expect(c.demote.demoted).toBe(c.demote.stale);
    }
  });
});

describe("demotion after a routine no-op re-ingest (#1915, claude-sonnet-5-5)", async () => {
  const all = await reports("staleness-noop-reingest-sonnet-2026-11-07.partials.jsonl", [
    "A7",
    "A7R",
    "A7S",
  ]);
  const pooled = poolHeldOutReports(all);
  const against = (arm: string, baseline: string) =>
    pooled.referenceComparisons.find((c) => c.arm === arm && c.baseline === baseline);
  const freshness = (id: string) =>
    all.map((r) => {
      const f = r.arms.find((a) => a.id === id)!.aggregate.agent!.citationFreshness!;
      return [r.corpus.id, f.fresh, f.moved, f.stale, f.unverified, f.demoted];
    });

  it("covers every held-out item on every arm, on one model", () => {
    expect(pooled.items).toBe(39);
    expect(pooled.corpora.map((c) => [c.id, c.items, c.missingScores])).toEqual([
      ["localization-01-miniflux-heldout", 24, 0],
      ["localization-02-fixture-portfolio", 15, 0],
    ]);
    for (const r of all) {
      expect(r.arms.map((a) => a.id)).toEqual(["A0", "A7", "A7R", "A7RD", "A7S", "A7SD"]);
      for (const a of r.arms.filter((x) => x.id !== "A0")) {
        expect(a.configuration.model).toBe("claude-sonnet-5-5");
      }
    }
  });

  it("the no-op re-ingest left every stored citation fresh: none moved, none stale, none set aside", () => {
    const expected = [
      ["localization-01-miniflux-heldout", 596, 0, 0, 0, 0],
      ["localization-02-fixture-portfolio", 758, 0, 0, 0, 0],
    ];
    expect(freshness("A7R")).toEqual(expected);
    expect(freshness("A7RD")).toEqual(expected);
  });

  it("A7RD − A7R: demotion after a routine re-ingest changes nothing, on every metric and item", () => {
    for (const name of ["recallAt5", "recallAt10", "editPrecision", "reciprocalRank"]) {
      const m = metric(against("A7RD", "A7R"), name);
      expect(m.meanDifference).toBe(0);
      expect(m.ci).toEqual([0, 0]);
      expect(m.verdict).toBe("no measurable difference");
    }
  });

  it("A7R − A7: a no-op re-ingest reads the same as no re-ingest", () => {
    for (const name of ["recallAt5", "recallAt10", "editPrecision", "reciprocalRank"]) {
      expect(metric(against("A7R", "A7"), name).meanDifference).toBe(0);
    }
  });

  it("beside them, on the same analyses: A7S within noise of A7, A7SD below A7S", () => {
    const s5 = metric(against("A7S", "A7"), "recallAt5");
    expect(s5.meanDifference).toBeCloseTo(-0.013, 3);
    expect(s5.verdict).toBe("no measurable difference");
    const r5 = metric(against("A7SD", "A7S"), "recallAt5");
    expect(r5.meanDifference).toBeCloseTo(-0.097, 3);
    expect(r5.ci[1]).toBeLessThan(0);
    expect(r5.p).toBeCloseTo(0.004, 3);
    expect(r5.verdict).toBe("worse");
    const mrr = metric(against("A7SD", "A7S"), "reciprocalRank");
    expect(mrr.meanDifference).toBeCloseTo(-0.255, 3);
    expect(mrr.verdict).toBe("worse");
    expect(freshness("A7S")).toEqual([
      ["localization-01-miniflux-heldout", 341, 101, 154, 0, 0],
      ["localization-02-fixture-portfolio", 499, 75, 184, 0, 0],
    ]);
    expect(freshness("A7SD").map((row) => row[5])).toEqual([154, 184]);
  });
});

describe("the staleness slice's table guard (#1834, deepseek-flash)", async () => {
  const records = (await lines("staleness-table-guard-deepseek-2026-11-06.runs.jsonl")).map(
    parseGuardRecord,
  );
  const fixture = await loadImpactRecallFixture(resolveCorpusDir(TABLE_GUARD_CORPUS));
  const read = (scoring: GuardScoring, arm: string, baseline: string) => {
    const d = guardPairedDifferences(records, fixture, 3, scoring).find(
      (x) => x.arm === arm && x.baseline === baseline,
    )!;
    return [d.interval.meanDifference, ...d.interval.ci].map((x) => x.toFixed(3));
  };

  it("recorded every analysis reading's per-requirement tables, on one model", () => {
    expect(new Set(records.map((r) => r.model))).toEqual(new Set(["anthropic/deepseek-flash"]));
    const analysisRuns = records.filter(
      (r): r is GuardRunRecord =>
        r.kind === "run" && ["A7", "A7O", "A7S", "A7SD"].includes(r.reading),
    );
    expect(analysisRuns).toHaveLength(12);
    expect(guardScoringOf(analysisRuns)).toBe("headline");
  });

  it("on the analysis's first persisted requirement (#1848): A7S against A7 and A7SD against A7S, within noise", () => {
    expect(read("headline", "A7S", "A7")).toEqual(["0.018", "-0.083", "0.118"]);
    expect(read("headline", "A7SD", "A7S")).toEqual(["-0.028", "-0.123", "0.067"]);
    expect(read("headline", "A7", "A7O")).toEqual(["-0.051", "-0.120", "0.018"]);
  });

  it("unioned over every persisted requirement (#1823's reading), the same", () => {
    expect(read("union", "A7S", "A7")).toEqual(["-0.007", "-0.087", "0.072"]);
    expect(read("union", "A7SD", "A7S")).toEqual(["0.033", "-0.008", "0.075"]);
  });
});
