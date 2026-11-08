import { mkdtemp, readdir, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadRecordedVectors } from "../recorded-vectors.js";
import { createA0Arm, type LocalizationArm } from "./arms.js";
import { loadLocalizationCorpus, type LocalizationCorpus } from "./corpus.js";
import type { CostMeter } from "./cost.js";
import {
  PartialStore,
  corpusDigest,
  describeSlice,
  fingerprintDifferences,
  parseItemSlice,
  recordedArms,
  runFingerprint,
  seedBudget,
  sliceItemIds,
  withRecordedSpend,
  type ItemSlice,
} from "./partials.js";
import {
  EvalBudget,
  runLocalizationEval,
  toMarkdownReport,
  toPooledMarkdownReport,
  poolHeldOutReports,
  type LocalizationReport,
  type TableGuard,
} from "./runner.js";
import { EmbedCache, buildCorpusSearch, type CorpusSearch } from "./search.js";

class FakeMeter implements CostMeter {
  spent = 0;
  unpriced = 0;
  spentUsd() {
    return this.spent;
  }
  unpricedCalls() {
    return this.unpriced;
  }
}

let corpus: LocalizationCorpus;
let search: CorpusSearch;

beforeAll(async () => {
  corpus = await loadLocalizationCorpus("localization-02-fixture-portfolio");
  const recorded = await loadRecordedVectors(
    path.join(corpus.dir, "vectors.gte-modernbert-base.json"),
  );
  search = await buildCorpusSearch(corpus.symbols, new EmbedCache(recorded, null, "x"));
});

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), "loc-partials-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/**
 * One invocation's arms: the real A0 over the fixture corpus, and a paid arm
 * that wraps A0 and spends `usd` per requirement through `meter` (a fake
 * meter: dollars in binary-exact steps, so sums do not depend on their order).
 */
function armsFor(meter: FakeMeter, calls: string[] = [], usd = 0.25): LocalizationArm[] {
  const a0 = createA0Arm({ search });
  const paid: LocalizationArm = {
    id: "A4",
    label: "A4 paid test arm",
    configuration: { ...a0.configuration, llm: true, model: "fake" },
    async localize(item, c) {
      calls.push(`A4:${item.id}`);
      meter.spent += usd;
      const out = await a0.localize(item, c);
      return {
        ...out,
        rankedFiles: [...out.rankedFiles].reverse(),
        llmNamedFiles: out.rankedFiles.slice(0, 1),
      };
    },
  };
  const counted: LocalizationArm = {
    ...a0,
    localize: (item, c) => {
      calls.push(`A0:${item.id}`);
      return a0.localize(item, c);
    },
  };
  return [counted, paid];
}

/** A deterministic clock: every requirement takes 0.25 s. */
const clock = () => {
  let t = 0;
  return () => (t += 125);
};

/** One CLI invocation over the store: a slice, a resume, or (slice === "merge") a merge. */
async function invoke(
  dir: string,
  opts: {
    slice?: ItemSlice | null | "merge";
    budgetUsd?: number;
    runs?: number;
    calls?: string[];
    usd?: number;
    tableGuard?: TableGuard;
    meter?: FakeMeter;
    arms?: (meter: FakeMeter) => LocalizationArm[];
  } = {},
): Promise<LocalizationReport> {
  const store = new PartialStore(dir);
  const meter = opts.meter ?? new FakeMeter();
  const prior = await store.readRecordedSpend();
  const budget = new EvalBudget(opts.budgetUsd ?? 35);
  seedBudget(budget, prior);
  const capped = withRecordedSpend(meter, prior);
  if (opts.slice === "merge") {
    const { fingerprint, checkpoint } = await store.openForMerge(corpus);
    return runLocalizationEval(corpus, {
      arms: recordedArms(fingerprint),
      runs: fingerprint.runs,
      budget,
      meter: capped,
      checkpoint,
      runItem: () => false,
      ...(opts.tableGuard ? { tableGuard: opts.tableGuard } : {}),
    });
  }
  const arms = (opts.arms ?? ((m) => armsFor(m, opts.calls, opts.usd)))(meter);
  const runs = opts.runs ?? 2;
  const checkpoint = await store.openForRun(corpus, runFingerprint(corpus, arms, runs));
  const ids = sliceItemIds(corpus.manifest.items, opts.slice ?? null);
  const report = await runLocalizationEval(corpus, {
    arms,
    runs,
    budget,
    meter: capped,
    now: clock(),
    checkpoint,
    runItem: (i) => ids.has(i.id),
    ...(opts.tableGuard ? { tableGuard: opts.tableGuard } : {}),
  });
  await store.recordOtherSpend("inv", meter);
  return report;
}

describe("slices merged (#1800)", () => {
  it("three slices and a merge give the report one full run gives", async () => {
    const meter = new FakeMeter();
    const full = await runLocalizationEval(corpus, {
      arms: armsFor(meter),
      runs: 2,
      budgetUsd: 35,
      meter,
      now: clock(),
    });
    expect(full.stopped).toBeNull();
    expect(full.spentUsd).toBe(corpus.manifest.items.length * 2 * 0.25);

    const dir = await tempDir();
    for (let n = 1; n <= 3; n++) await invoke(dir, { slice: { kind: "shard", n, m: 3 } });
    const merged = await invoke(dir, { slice: "merge" });
    expect(merged).toEqual(full);
    expect(merged.missing).toEqual([]);
  });

  it("a merge before every slice ran names the missing items", async () => {
    const dir = await tempDir();
    await invoke(dir, { slice: { kind: "items", from: 0, to: 10 }, runs: 1 });
    const merged = await invoke(dir, { slice: "merge" });
    const rest = corpus.manifest.items.slice(10).map((i) => i.id);
    expect(merged.missing).toEqual([
      { arm: "A0", run: 1, items: rest },
      { arm: "A4", run: 1, items: rest },
    ]);
    expect(merged.arms[0]!.items).toHaveLength(10);
    expect(merged.arms[0]!.completedRuns).toBe(0);
    expect(merged.partialFirstRun).toBe(true);
    const md = toMarkdownReport(merged);
    expect(md).toContain(
      `> **Missing requirements** (no score yet): A0 run 1: ${rest.join(", ")}; A4 run 1:`,
    );
    const pooled = toPooledMarkdownReport(poolHeldOutReports([merged, merged]));
    expect(pooled).toContain(`${rest.length * 2} requirement score(s) missing`);
  });

  it("resume after a stop mid-slice re-runs only the missing items", async () => {
    const dir = await tempDir();
    const first: string[] = [];
    // $0.25 per A4 requirement under a $1 cap: four A4 requirements, then a stop.
    const stopped = await invoke(dir, {
      slice: { kind: "shard", n: 1, m: 2 },
      runs: 1,
      budgetUsd: 1,
      calls: first,
    });
    expect(stopped.stopped).toMatchObject({ phase: "requirement", arm: "A4", run: 1 });
    const firstHalf = [...sliceItemIds(corpus.manifest.items, { kind: "shard", n: 1, m: 2 })];
    expect(first.filter((c) => c.startsWith("A4:"))).toEqual(
      firstHalf.slice(0, 4).map((i) => `A4:${i}`),
    );

    const second: string[] = [];
    const resumed = await invoke(dir, {
      slice: { kind: "shard", n: 1, m: 2 },
      runs: 1,
      calls: second,
    });
    expect(resumed.stopped).toBeNull();
    // A0 had finished the slice; only A4's missing four run again.
    expect(second).toEqual(firstHalf.slice(4).map((i) => `A4:${i}`));
    expect(resumed.arms[1]!.items.map((s) => s.id)).toEqual(firstHalf);
    expect(resumed.spentUsd).toBe(firstHalf.length * 0.25);
  });

  it("holds the cap across slices: spend is read from the recorded files", async () => {
    const dir = await tempDir();
    await invoke(dir, { slice: { kind: "items", from: 0, to: 3 }, runs: 1, budgetUsd: 1 });
    const calls: string[] = [];
    // $0.75 already spent: one more $0.25 requirement reaches $1, and the next would pass it.
    const second = await invoke(dir, {
      slice: { kind: "items", from: 3, to: 16 },
      runs: 1,
      budgetUsd: 1,
      calls,
    });
    expect(calls.filter((c) => c.startsWith("A4:"))).toHaveLength(1);
    expect(second.spentUsd).toBe(1);
    expect(second.stopped).toMatchObject({ reason: "budget: $1.0000 spent of $1" });
  });

  it("carries the per-arm look-ahead across slices: the first paid requirement is not run blind", async () => {
    const dir = await tempDir();
    await invoke(dir, { slice: { kind: "items", from: 0, to: 2 }, runs: 1, usd: 0.5 });
    const calls: string[] = [];
    // $1 spent; A4's recorded $0.50 look-ahead would pass $1.40.
    const second = await invoke(dir, {
      slice: { kind: "items", from: 2, to: 4 },
      runs: 1,
      budgetUsd: 1.4,
      calls,
      usd: 0.5,
    });
    expect(calls.filter((c) => c.startsWith("A4:"))).toEqual([]);
    expect(second.stopped!.reason).toBe("budget: $1.0000 spent + up to $0.5000 next > $1.4");
  });

  it("stops every later slice once a recorded call was unpriced", async () => {
    const dir = await tempDir();
    const unpricedArms = (m: FakeMeter) =>
      armsFor(m).map((a) =>
        a.id === "A4"
          ? {
              ...a,
              localize: async (
                item: Parameters<LocalizationArm["localize"]>[0],
                c: LocalizationCorpus,
              ) => {
                m.unpriced += 1;
                return a.localize(item, c);
              },
            }
          : a,
      );
    const first = await invoke(dir, {
      slice: { kind: "items", from: 0, to: 2 },
      runs: 1,
      arms: unpricedArms,
    });
    expect(first.stopped).toMatchObject({ reason: "an unpriced model call" });
    const calls: string[] = [];
    const second = await invoke(dir, { slice: { kind: "items", from: 2, to: 4 }, runs: 1, calls });
    expect(calls).toEqual([]);
    expect(second.stopped).toMatchObject({ reason: "an unpriced model call", arm: "A0" });
  });

  it("records spend outside requirements (the table guard) and counts it in the next slice", async () => {
    const dir = await tempDir();
    const meter = new FakeMeter();
    const guard: TableGuard = async () => {
      meter.spent += 2;
      return {
        measured: true,
        tablePrecision: 0.8,
        runs: 3,
        configuration: "t",
        seeding: "mapper",
      };
    };
    await invoke(dir, { runs: 1, meter, tableGuard: guard, usd: 0 });
    expect(await readdir(path.join(dir, "spend"))).toEqual(["inv.json"]);
    const spend = await new PartialStore(dir).readRecordedSpend();
    // A0's guard and A4's: $4, and no requirement spent anything.
    expect(spend.spentUsd).toBe(4);
    expect(spend.maxItemCostByArm.get("A4")).toBe(0);
  });

  it("writes no spend file when nothing was spent outside requirements", async () => {
    const dir = await tempDir();
    await invoke(dir, { slice: { kind: "items", from: 0, to: 1 }, runs: 1 });
    expect(await readdir(dir)).toEqual([corpus.name]);
  });
});

describe("configuration checks (#1800)", () => {
  it("refuses to resume under a changed arm configuration, run count or arm set", async () => {
    const dir = await tempDir();
    await invoke(dir, { slice: { kind: "items", from: 0, to: 1 }, runs: 1 });
    const changedModel = (m: FakeMeter) =>
      armsFor(m).map((a) =>
        a.id === "A4" ? { ...a, configuration: { ...a.configuration, model: "other" } } : a,
      );
    await expect(invoke(dir, { runs: 1, arms: changedModel })).rejects.toThrow(
      /configuration changed since the first slice:\n {2}- arm A4 model: recorded "fake", now "other"/,
    );
    await expect(invoke(dir, { runs: 2 })).rejects.toThrow(/runs: recorded 1, now 2/);
    await expect(invoke(dir, { runs: 1, arms: (m) => armsFor(m).slice(0, 1) })).rejects.toThrow(
      /arms: recorded A0,A4, now A0/,
    );
    const relabelled = (m: FakeMeter) => armsFor(m).map((a) => ({ ...a, label: `${a.label}!` }));
    await expect(invoke(dir, { runs: 1, arms: relabelled })).rejects.toThrow(/arm A0 label/);
  });

  it("refuses to merge when the corpus changed since the slices ran", async () => {
    const dir = await tempDir();
    await invoke(dir, { slice: { kind: "items", from: 0, to: 1 }, runs: 1 });
    const original = corpus;
    corpus = {
      ...original,
      manifest: {
        ...original.manifest,
        items: original.manifest.items.map((i, n) =>
          n === 0 ? { ...i, text: `${i.text} More.` } : i,
        ),
      },
    };
    try {
      await expect(invoke(dir, { slice: "merge" })).rejects.toThrow(
        /the corpus .* changed since the slices ran/,
      );
      await expect(invoke(dir, { runs: 1 })).rejects.toThrow(
        /corpus digest: the manifest or the symbol rows changed/,
      );
    } finally {
      corpus = original;
    }
  });

  it("refuses a partial file recorded under another configuration, or one that does not match its path", async () => {
    const dir = await tempDir();
    await invoke(dir, { slice: { kind: "items", from: 0, to: 1 }, runs: 1 });
    const item = corpus.manifest.items[0]!.id;
    const file = path.join(dir, corpus.name, "A4", "run-1", `${encodeURIComponent(item)}.json`);
    const rec = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...rec, fingerprint: "0000" }));
    await expect(invoke(dir, { slice: "merge" })).rejects.toThrow(
      /recorded under another configuration/,
    );
    await writeFile(file, JSON.stringify({ ...rec, run: 2 }));
    await expect(invoke(dir, { slice: "merge" })).rejects.toThrow(/does not match its path/);
  });

  it("refuses to merge a directory with no partials for the corpus, or of another format", async () => {
    const dir = await tempDir();
    await expect(invoke(dir, { slice: "merge" })).rejects.toThrow(/holds no partial results/);
    await invoke(dir, { slice: { kind: "items", from: 0, to: 1 }, runs: 1 });
    const config = path.join(dir, corpus.name, "config.json");
    const fp = JSON.parse(await readFile(config, "utf8")) as Record<string, unknown>;
    await writeFile(config, JSON.stringify({ ...fp, version: 0 }));
    await expect(invoke(dir, { slice: "merge" })).rejects.toThrow(/partials format v0/);
    await expect(invoke(dir, { runs: 1 })).rejects.toThrow(/partials format: recorded v0, now v1/);
  });

  it("lists the corpora a directory holds, and a merge never runs a requirement", async () => {
    const dir = await tempDir();
    await invoke(dir, { slice: { kind: "items", from: 0, to: 1 }, runs: 1 });
    const store = new PartialStore(dir);
    expect(await store.corpora()).toEqual([corpus.name]);
    expect(await store.recordedArmIds([corpus.name, "localization-01-miniflux-heldout"])).toEqual([
      "A0",
      "A4",
    ]);
    // #1933 — per corpus, not their union: a corpus that recorded nothing lists no arm.
    expect(
      await store.recordedArmIdsByCorpus([corpus.name, "localization-01-miniflux-heldout"]),
    ).toEqual(
      new Map([
        [corpus.name, ["A0", "A4"]],
        ["localization-01-miniflux-heldout", []],
      ]),
    );
    const { fingerprint, checkpoint } = await store.openForMerge(corpus);
    await expect(
      recordedArms(fingerprint)[0]!.localize(corpus.manifest.items[0]!, corpus),
    ).rejects.toThrow(/a merge runs no requirement/);
    await expect(checkpoint.record(checkpoint.recorded[0]!)).rejects.toThrow(
      /a merge runs no requirement/,
    );
  });

  it("reads a corpus digest that ignores key order but not content", () => {
    const reordered = { manifest: { ...corpus.manifest }, symbols: corpus.symbols };
    const { id, ...rest } = reordered.manifest;
    expect(corpusDigest({ manifest: { ...rest, id }, symbols: corpus.symbols })).toBe(
      corpusDigest(corpus),
    );
    expect(corpusDigest({ manifest: corpus.manifest, symbols: corpus.symbols.slice(1) })).not.toBe(
      corpusDigest(corpus),
    );
  });

  it("describes no difference between equal fingerprints, and a changed corpus name", () => {
    const fp = runFingerprint(corpus, [{ id: "A0", label: "a", configuration: { x: 1 } }], 1);
    expect(fingerprintDifferences(fp, fp)).toEqual([]);
    expect(fingerprintDifferences(fp, { ...fp, corpus: "other" })).toEqual([
      "corpus: recorded localization-02-fixture-portfolio, now other",
    ]);
  });
});

describe("item slices (#1800)", () => {
  const items = Array.from({ length: 16 }, (_, i) => ({ id: `I-${i}` }));

  it("splits a corpus into contiguous shards that cover every item once", () => {
    const shards = [1, 2, 3].map((n) => [...sliceItemIds(items, { kind: "shard", n, m: 3 })]);
    expect(shards.map((s) => s.length)).toEqual([5, 5, 6]);
    expect(shards.flat()).toEqual(items.map((i) => i.id));
  });

  it("selects an item range, end exclusive, and every item with no slice", () => {
    expect([...sliceItemIds(items, { kind: "items", from: 2, to: 5 })]).toEqual([
      "I-2",
      "I-3",
      "I-4",
    ]);
    expect(sliceItemIds(items, null).size).toBe(16);
  });

  it("parses the slice flags strictly", () => {
    expect(parseItemSlice(undefined, undefined)).toBeNull();
    expect(parseItemSlice("0:10", undefined)).toEqual({ kind: "items", from: 0, to: 10 });
    expect(parseItemSlice(undefined, "2/3")).toEqual({ kind: "shard", n: 2, m: 3 });
    expect(() => parseItemSlice("0:10", "1/2")).toThrow(/not both/);
    expect(() => parseItemSlice("10", undefined)).toThrow(/<from>:<to>/);
    expect(() => parseItemSlice("a:3", undefined)).toThrow(/<from>:<to>/);
    expect(() => parseItemSlice("1:2:3", undefined)).toThrow(/<from>:<to>/);
    expect(() => parseItemSlice("5:5", undefined)).toThrow(/selects no item/);
    expect(() => parseItemSlice(undefined, "3")).toThrow(/<n>\/<m>/);
    expect(() => parseItemSlice(undefined, "0/3")).toThrow(/between 1 and <m>/);
    expect(() => parseItemSlice(undefined, "4/3")).toThrow(/between 1 and <m>/);
    expect(() => parseItemSlice(undefined, "1/-2")).toThrow(/<n>\/<m>/);
  });

  it("describes a slice for the console", () => {
    expect(describeSlice(null)).toBe("every item");
    expect(describeSlice({ kind: "items", from: 0, to: 4 })).toBe("items 0:4");
    expect(describeSlice({ kind: "shard", n: 1, m: 3 })).toBe("shard 1/3");
  });
});

describe("runLocalizationEval with a checkpoint (#1800)", () => {
  it("refuses a recorded score that is not part of the run", async () => {
    const checkpoint = {
      recorded: [
        {
          arm: "A9",
          run: 1,
          item: corpus.manifest.items[0]!.id,
          score: {} as never,
          spentUsd: 0,
          unpricedCalls: 0,
        },
      ],
      record: async () => {},
    };
    await expect(
      runLocalizationEval(corpus, {
        arms: armsFor(new FakeMeter()).slice(0, 1),
        runs: 1,
        meter: new FakeMeter(),
        checkpoint,
      }),
    ).rejects.toThrow(/is not part of this run's arms, runs or items/);
  });
});
