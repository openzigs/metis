/**
 * #1800 — `pnpm eval:localization` in SLICES: a run records every requirement
 * score as its own partial file, so a slow arm can be measured in steps of
 * under ten minutes, a stopped run can be resumed, and the runner merges the
 * partial files into one report with its own scoring and statistics.
 *
 *   <dir>/<corpus>/config.json                    the run's configuration (fingerprint)
 *   <dir>/<corpus>/<arm>/run-<n>/<item>.json      one score: corpus × arm × run × item
 *   <dir>/spend/<invocation>.json                 spend outside requirements (the table guard)
 *
 * The configuration is written by the first slice and checked by every later
 * one: a changed arm configuration, model, run count or corpus refuses to
 * resume or merge, so one report never mixes two configurations. The dollar cap
 * and the unpriced-call stop hold ACROSS slices: what earlier slices spent is
 * read back from these files ({@link readRecordedSpend}).
 *
 * File system only: no network, no environment reads.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { LocalizationArm } from "./arms.js";
import type { LocalizationCorpus, LocalizationItem } from "./corpus.js";
import type { CostMeter } from "./cost.js";
import type { EvalBudget, RecordedScore, RunCheckpoint } from "./runner.js";

/** Bumped when the layout or a record's shape changes: an older directory is refused. */
export const PARTIALS_VERSION = 1;

/** Everything a run's scores depend on. Two slices merge only when theirs are equal. */
export interface RunFingerprint {
  kind: "localization-partials";
  version: number;
  corpus: string;
  /** sha256 of the manifest and the symbol rows (see {@link corpusDigest}). */
  corpusDigest: string;
  runs: number;
  arms: Array<{
    id: string;
    label: string;
    configuration: Record<string, string | number | boolean>;
  }>;
}

/** One partial file. */
interface PartialRecord extends RecordedScore {
  corpus: string;
  /** {@link fingerprintDigest} of the configuration the score was measured under. */
  fingerprint: string;
}

/** What every earlier slice spent, read from the partial files. */
export interface RecordedSpend {
  spentUsd: number;
  unpricedCalls: number;
  /** Per arm, the most one requirement has cost: the cap's look-ahead. */
  maxItemCostByArm: Map<string, number>;
}

/** JSON with object keys sorted, so a digest does not depend on insertion order. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** The corpus as the arms see it: its manifest (items, ground truth, repos) and its symbol rows. */
export function corpusDigest(corpus: Pick<LocalizationCorpus, "manifest" | "symbols">): string {
  return sha256(stableJson({ manifest: corpus.manifest, symbols: corpus.symbols }));
}

export function runFingerprint(
  corpus: Pick<LocalizationCorpus, "manifest" | "symbols">,
  arms: ReadonlyArray<Pick<LocalizationArm, "id" | "label" | "configuration">>,
  runs: number,
): RunFingerprint {
  return {
    kind: "localization-partials",
    version: PARTIALS_VERSION,
    corpus: corpus.manifest.id,
    corpusDigest: corpusDigest(corpus),
    runs,
    arms: arms.map((a) => ({ id: a.id, label: a.label, configuration: a.configuration })),
  };
}

export function fingerprintDigest(fp: RunFingerprint): string {
  return sha256(stableJson(fp)).slice(0, 16);
}

/** What differs between a recorded and a current configuration, in words; empty when equal. */
export function fingerprintDifferences(
  recorded: RunFingerprint,
  current: RunFingerprint,
): string[] {
  const out: string[] = [];
  if (recorded.version !== current.version) {
    out.push(`partials format: recorded v${recorded.version}, now v${current.version}`);
  }
  if (recorded.corpus !== current.corpus)
    out.push(`corpus: recorded ${recorded.corpus}, now ${current.corpus}`);
  if (recorded.corpusDigest !== current.corpusDigest) {
    out.push("corpus digest: the manifest or the symbol rows changed since the first slice");
  }
  if (recorded.runs !== current.runs)
    out.push(`runs: recorded ${recorded.runs}, now ${current.runs}`);
  const ids = (fp: RunFingerprint) => fp.arms.map((a) => a.id).join(",");
  if (ids(recorded) !== ids(current)) {
    out.push(`arms: recorded ${ids(recorded)}, now ${ids(current)}`);
    return out;
  }
  recorded.arms.forEach((r, i) => {
    const c = current.arms[i]!;
    if (r.label !== c.label) out.push(`arm ${r.id} label: recorded "${r.label}", now "${c.label}"`);
    const keys = [
      ...new Set([...Object.keys(r.configuration), ...Object.keys(c.configuration)]),
    ].sort();
    for (const k of keys) {
      if (r.configuration[k] !== c.configuration[k]) {
        out.push(
          `arm ${r.id} ${k}: recorded ${JSON.stringify(r.configuration[k])}, now ${JSON.stringify(c.configuration[k])}`,
        );
      }
    }
  });
  return out;
}

/** A path segment from an arm or item id: the id itself when safe, never a traversal. */
function segment(id: string): string {
  const s = encodeURIComponent(id);
  if (s === "" || s === "." || s === "..")
    throw new Error(`cannot name a partial file after ${JSON.stringify(id)}`);
  return s;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`cannot read partial file ${file}: ${(err as Error).message}`);
  }
}

/** Write through a temporary file, so a run killed mid-write leaves no torn record. */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).sort();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }
}

/** The partial files of one run directory. */
export class PartialStore {
  /** Spend and unpriced calls this process recorded into requirement files. */
  private writtenUsd = 0;
  private writtenUnpriced = 0;

  constructor(readonly dir: string) {}

  private configFile(corpus: string): string {
    return path.join(this.dir, segment(corpus), "config.json");
  }

  private recordFile(corpus: string, arm: string, run: number, item: string): string {
    return path.join(
      this.dir,
      segment(corpus),
      segment(arm),
      `run-${run}`,
      `${segment(item)}.json`,
    );
  }

  /** The corpora this directory holds a configuration for. */
  async corpora(): Promise<string[]> {
    const out: string[] = [];
    for (const name of await listDir(this.dir)) {
      if (name === "spend") continue;
      if (await readJson(path.join(this.dir, name, "config.json")))
        out.push(decodeURIComponent(name));
    }
    return out;
  }

  /** Every arm id the given corpora recorded, first-seen order. */
  async recordedArmIds(corpora: readonly string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const c of corpora) {
      for (const a of (await this.readFingerprint(c))?.arms ?? []) {
        if (!ids.includes(a.id)) ids.push(a.id);
      }
    }
    return ids;
  }

  async readFingerprint(corpus: string): Promise<RunFingerprint | null> {
    return readJson<RunFingerprint>(this.configFile(corpus));
  }

  /**
   * Open a corpus to RUN (a first slice, a later slice or a resume): the first
   * call writes `fingerprint`; every later one must match it exactly.
   */
  async openForRun(
    corpus: LocalizationCorpus,
    fingerprint: RunFingerprint,
  ): Promise<RunCheckpoint> {
    const recorded = await this.readFingerprint(corpus.name);
    if (recorded) {
      const diff = fingerprintDifferences(recorded, fingerprint);
      if (diff.length > 0) {
        throw new Error(
          `refusing to resume ${corpus.name} in ${this.dir}: the configuration changed since the first slice:\n  - ${diff.join("\n  - ")}`,
        );
      }
    } else {
      await writeJsonAtomic(this.configFile(corpus.name), fingerprint);
    }
    return this.checkpoint(corpus, fingerprint);
  }

  /**
   * Open a corpus to MERGE: no new score is run, so the arms are the recorded
   * ones. The corpus must still be the one the slices ran on.
   */
  async openForMerge(
    corpus: LocalizationCorpus,
  ): Promise<{ fingerprint: RunFingerprint; checkpoint: RunCheckpoint }> {
    const fingerprint = await this.readFingerprint(corpus.name);
    if (!fingerprint) throw new Error(`${this.dir} holds no partial results for ${corpus.name}`);
    if (fingerprint.version !== PARTIALS_VERSION) {
      throw new Error(
        `refusing to merge ${corpus.name}: partials format v${fingerprint.version}, this runner reads v${PARTIALS_VERSION}`,
      );
    }
    if (fingerprint.corpusDigest !== corpusDigest(corpus)) {
      throw new Error(
        `refusing to merge ${corpus.name}: the corpus (manifest or symbol rows) changed since the slices ran`,
      );
    }
    const checkpoint = await this.checkpoint(corpus, fingerprint);
    return {
      fingerprint,
      checkpoint: {
        recorded: checkpoint.recorded,
        record: () => Promise.reject(new Error("a merge runs no requirement")),
      },
    };
  }

  private async checkpoint(
    corpus: LocalizationCorpus,
    fingerprint: RunFingerprint,
  ): Promise<RunCheckpoint> {
    const digest = fingerprintDigest(fingerprint);
    const recorded = (await this.readRecords(corpus.name)).map((r) => {
      if (r.fingerprint !== digest) {
        throw new Error(
          `refusing ${corpus.name}: a partial file (arm ${r.arm}, run ${r.run}, item ${r.item}) was recorded under another configuration`,
        );
      }
      const score: RecordedScore = {
        arm: r.arm,
        run: r.run,
        item: r.item,
        score: r.score,
        spentUsd: r.spentUsd,
        unpricedCalls: r.unpricedCalls,
      };
      return score;
    });
    return {
      recorded,
      record: async (score) => {
        const rec: PartialRecord = { corpus: corpus.name, fingerprint: digest, ...score };
        await writeJsonAtomic(this.recordFile(corpus.name, score.arm, score.run, score.item), rec);
        this.writtenUsd += score.spentUsd;
        this.writtenUnpriced += score.unpricedCalls;
      },
    };
  }

  /** Every requirement file recorded for a corpus, checked against its path. */
  private async readRecords(corpus: string): Promise<PartialRecord[]> {
    const out: PartialRecord[] = [];
    const corpusDir = path.join(this.dir, segment(corpus));
    for (const armDir of await listDir(corpusDir)) {
      if (armDir === "config.json") continue;
      for (const runDir of await listDir(path.join(corpusDir, armDir))) {
        const run = /^run-(\d+)$/.exec(runDir);
        if (!run) continue;
        for (const file of await listDir(path.join(corpusDir, armDir, runDir))) {
          if (!file.endsWith(".json")) continue;
          const rec = await readJson<PartialRecord>(path.join(corpusDir, armDir, runDir, file));
          if (
            !rec ||
            rec.corpus !== corpus ||
            segment(rec.arm) !== armDir ||
            rec.run !== Number(run[1]) ||
            `${segment(rec.item)}.json` !== file
          ) {
            throw new Error(
              `partial file ${path.join(corpusDir, armDir, runDir, file)} does not match its path`,
            );
          }
          out.push(rec);
        }
      }
    }
    return out;
  }

  /**
   * #1800 — what every slice recorded in this directory has spent, over every
   * corpus: requirement files plus each invocation's other spend.
   */
  async readRecordedSpend(): Promise<RecordedSpend> {
    const spend: RecordedSpend = { spentUsd: 0, unpricedCalls: 0, maxItemCostByArm: new Map() };
    for (const corpus of await this.corpora()) {
      for (const r of await this.readRecords(corpus)) {
        spend.spentUsd += r.spentUsd;
        spend.unpricedCalls += r.unpricedCalls;
        spend.maxItemCostByArm.set(
          r.arm,
          Math.max(spend.maxItemCostByArm.get(r.arm) ?? 0, r.spentUsd),
        );
      }
    }
    for (const file of await listDir(path.join(this.dir, "spend"))) {
      if (!file.endsWith(".json")) continue;
      const other = await readJson<{ spentUsd: number; unpricedCalls: number }>(
        path.join(this.dir, "spend", file),
      );
      spend.spentUsd += other?.spentUsd ?? 0;
      spend.unpricedCalls += other?.unpricedCalls ?? 0;
    }
    return spend;
  }

  /**
   * Record what this invocation spent OUTSIDE requirement files (the table
   * guard): the meter's total less what the requirement files already hold.
   * Overwritten on each call, so it is safe to call after every corpus.
   */
  async recordOtherSpend(invocation: string, meter: CostMeter): Promise<void> {
    const spentUsd = Math.max(0, meter.spentUsd() - this.writtenUsd);
    const unpricedCalls = Math.max(0, meter.unpricedCalls() - this.writtenUnpriced);
    if (spentUsd < 1e-9 && unpricedCalls === 0) return;
    await writeJsonAtomic(path.join(this.dir, "spend", `${segment(invocation)}.json`), {
      spentUsd,
      unpricedCalls,
    });
  }
}

/** The meter the cap reads: this invocation's spend on top of every earlier slice's. */
export function withRecordedSpend(meter: CostMeter, prior: RecordedSpend): CostMeter {
  return {
    spentUsd: () => prior.spentUsd + meter.spentUsd(),
    unpricedCalls: () => prior.unpricedCalls + meter.unpricedCalls(),
  };
}

/** Seed the cap's per-arm look-ahead with what earlier slices' requirements cost. */
export function seedBudget(budget: EvalBudget, prior: RecordedSpend): void {
  for (const [arm, usd] of prior.maxItemCostByArm) budget.observeItem(arm, usd);
}

// ── Slices ───────────────────────────────────────────────────────────────────

/** `--items <from>:<to>` (0-based, `to` exclusive) or `--shard <n>/<m>` (1-based, contiguous). */
export type ItemSlice =
  { kind: "items"; from: number; to: number } | { kind: "shard"; n: number; m: number };

const wholeNumber = (raw: string) => /^\d+$/.test(raw.trim());

/** Parse the slice flags' values (absent → null). Both at once is refused. */
export function parseItemSlice(
  items: string | undefined,
  shard: string | undefined,
): ItemSlice | null {
  if (items !== undefined && shard !== undefined)
    throw new Error("pass --items or --shard, not both");
  if (items !== undefined) {
    const [from, to, extra] = items.split(":");
    if (
      extra !== undefined ||
      from === undefined ||
      to === undefined ||
      !wholeNumber(from) ||
      !wholeNumber(to)
    ) {
      throw new Error(
        `--items must be <from>:<to> (0-based, end exclusive), not ${JSON.stringify(items)}`,
      );
    }
    const slice = { kind: "items" as const, from: Number(from), to: Number(to) };
    if (slice.to <= slice.from)
      throw new Error(`--items ${items} selects no item: <to> must be above <from>`);
    return slice;
  }
  if (shard !== undefined) {
    const [n, m, extra] = shard.split("/");
    if (
      extra !== undefined ||
      n === undefined ||
      m === undefined ||
      !wholeNumber(n) ||
      !wholeNumber(m)
    ) {
      throw new Error(`--shard must be <n>/<m>, not ${JSON.stringify(shard)}`);
    }
    const slice = { kind: "shard" as const, n: Number(n), m: Number(m) };
    if (slice.m < 1 || slice.n < 1 || slice.n > slice.m) {
      throw new Error(`--shard ${shard}: <n> must be between 1 and <m>`);
    }
    return slice;
  }
  return null;
}

/** The item ids of a corpus that a slice selects, in corpus order. */
export function sliceItemIds(
  items: ReadonlyArray<Pick<LocalizationItem, "id">>,
  slice: ItemSlice | null,
): Set<string> {
  if (!slice) return new Set(items.map((i) => i.id));
  const [from, to] =
    slice.kind === "items"
      ? [slice.from, slice.to]
      : [
          Math.floor(((slice.n - 1) * items.length) / slice.m),
          Math.floor((slice.n * items.length) / slice.m),
        ];
  return new Set(items.slice(from, to).map((i) => i.id));
}

/** A slice in words, for the console. */
export function describeSlice(slice: ItemSlice | null): string {
  if (!slice) return "every item";
  return slice.kind === "items" ? `items ${slice.from}:${slice.to}` : `shard ${slice.n}/${slice.m}`;
}

/**
 * The arms a merge reports: the recorded configuration, with nothing to run.
 * A merge never calls `localize`; one that did would be a bug, so it throws.
 */
export function recordedArms(fingerprint: RunFingerprint): LocalizationArm[] {
  return fingerprint.arms.map((a) => ({
    ...a,
    localize: () => Promise.reject(new Error(`a merge runs no requirement (arm ${a.id})`)),
  }));
}
