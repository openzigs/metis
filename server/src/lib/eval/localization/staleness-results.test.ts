/**
 * #1834 — the staleness slice's measured results, read back from the committed
 * run records with the runner's own scoring and statistics:
 *
 *   - `__fixtures__/staleness-sonnet-2026-11-06.partials.jsonl`: every
 *     requirement score of A0, A7, A7K, A7S and A7SD on both held-out corpora,
 *     one run, claude-sonnet-5-5 (the partial files `--merge` reads, with each
 *     corpus's recorded configuration);
 *   - `__fixtures__/staleness-table-guard-deepseek-2026-11-06.runs.jsonl`: the
 *     table guard's run records, deepseek-flash, 3 runs.
 *
 * The figures asserted here are the ones eval-data/README.md and #1834 report.
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
import { guardPairedDifferences, parseGuardRecord } from "./table-guard-agent.js";
import { TABLE_GUARD_CORPUS } from "./table-guard-source.js";

const fixtures = path.join(import.meta.dirname, "__fixtures__");

type Line = { kind: "config"; config: RunFingerprint } | ({ kind: "score" } & PartialRecord);

async function lines(file: string): Promise<string[]> {
  return (await readFile(path.join(fixtures, file), "utf8"))
    .split("\n")
    .filter((l) => l.trim() !== "");
}

/** Each corpus's report, from its recorded configuration and scores, as `--merge` builds it. */
async function reports(): Promise<LocalizationReport[]> {
  const parsed = (await lines("staleness-sonnet-2026-11-06.partials.jsonl")).map(
    (l) => JSON.parse(l) as Line,
  );
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
        references: ["A7", "A7S"],
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
  const all = await reports();
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

describe("the staleness slice's table guard (#1834, deepseek-flash)", async () => {
  const records = (await lines("staleness-table-guard-deepseek-2026-11-06.runs.jsonl")).map(
    parseGuardRecord,
  );
  const fixture = await loadImpactRecallFixture(resolveCorpusDir(TABLE_GUARD_CORPUS));

  it("reads A7S against A7 and A7SD against A7S, 3 runs each, within noise", () => {
    expect(new Set(records.map((r) => r.model))).toEqual(new Set(["anthropic/deepseek-flash"]));
    const out = guardPairedDifferences(records, fixture, 3);
    const read = (arm: string, baseline: string) => {
      const d = out.find((x) => x.arm === arm && x.baseline === baseline)!;
      return [d.interval.meanDifference, ...d.interval.ci].map((x) => x.toFixed(3));
    };
    expect(read("A7S", "A7")).toEqual(["0.012", "-0.099", "0.123"]);
    expect(read("A7SD", "A7S")).toEqual(["-0.013", "-0.095", "0.069"]);
    expect(read("A7", "A7O")).toEqual(["-0.043", "-0.094", "0.008"]);
  });
});
