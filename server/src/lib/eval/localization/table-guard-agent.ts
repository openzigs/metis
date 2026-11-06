/**
 * #1823 — the table-precision guard for arm A7: `IMPACT_AGENT_SEEDS` (#1759)
 * on the table corpus, with citations stored by a real analysis.
 *
 * A7's cited files become depth-0 seeds of the blast radius, which reaches the
 * schema crossing, so the lead can add or change affected tables. On the table
 * corpus (`impact-recall-01-jpetstore`) no requirement has stored citations,
 * so A7 read there directly would be the split seeding, which proves nothing.
 * This reading gives each requirement citations the way A7 gets them:
 *
 *   1. "Evaluate new requirements" (the real orchestrator, code agent, the
 *      requirement's text as `extraInstructions`) runs on the MATERIALIZED
 *      repository the fixture models (`table-guard-source.ts`), once per
 *      requirement and run.
 *   2. An impact run on the fixture about the requirements it persisted (one
 *      change each, production's `loadRequirementChanges`), on the split
 *      seeding, with the live #936 table filter. With the flag on (A7), the
 *      stored citations, translated onto the fixture, lead the files to edit;
 *      off (A7O), the same changes are seeded by the hybrid search alone.
 *   3. A requirement's tables are the union over its changes, scored against
 *      the fixture's labels; a run's reading is the macro table precision, and
 *      the guard's is the mean over the runs.
 *
 * The baseline is A0 on the split seeding, the fixture's own text: the
 * reading the A4 and A13 guards are gated against (#1786). A7O against it
 * isolates the change of wording; A7 against A7O, the citations' own effect.
 *
 * Every step (one analysis, or one run of one reading, A0's mapper reading
 * included) is recorded as it ends, so a stopped guard resumes without paying
 * for a step again, and a caller can bound the steps one call takes
 * ({@link AgentSeedGuardDeps.maxSteps}). #1847 — a resume is refused when it
 * would read something else than what was recorded: every record carries the
 * fixture's and the repository pin's fingerprint, and a run is not read from
 * an analysis whose persisted requirements no longer resolve.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { StoredLinkRow } from "../../impact-analysis/change-seeds.js";
import type { ChangedRequirement } from "../../impact-analysis/extract-changes.js";
import type { ImpactRecallFixture } from "../impact-recall/fixture.js";
import {
  describeConfiguration,
  observeChange,
  requirementToChange,
  type ImpactRecallResult,
  type RunImpactRecallOptions,
  type SplitSeedingOptions,
} from "../impact-recall/runner.js";
import {
  aggregateScores,
  normalizeTable,
  scoreRequirement,
  scoreSet,
  type RequirementScore,
} from "../impact-recall/scorer.js";
import type { LocalizationRepo } from "./corpus.js";
import type { CostMeter } from "./cost.js";
import { stableDigest } from "./partials.js";
import type { TableGuardMeasurement, TableGuardReading } from "./runner.js";
import type { CorpusSearch } from "./search.js";
import { pairedTInterval, type PairedTInterval } from "./stats.js";
import { MAPPER_SEEDING, fixtureFileSymbols } from "./table-guard.js";
import {
  emptyTranslation,
  translateCitations,
  type CitationTranslation,
} from "./table-guard-source.js";

/**
 * #1847 — what a record depends on besides the model: a resume under another
 * fixture or repository pin is refused, as `PartialStore` refuses a changed
 * configuration.
 */
export interface GuardFingerprint {
  /** {@link stableDigest} of the fixture's manifest: its requirement texts, labels and graph. */
  fixture: string;
  /** The repository the analyses ran on, pinned: `<url>@<ref> (<sha>)`. */
  repository: string;
}

export function guardFingerprint(
  fixture: Pick<ImpactRecallFixture, "manifest">,
  repo: Pick<LocalizationRepo, "url" | "ref" | "sha">,
): GuardFingerprint {
  return {
    fixture: stableDigest(fixture.manifest),
    repository: `${repo.url}@${repo.ref} (${repo.sha})`,
  };
}

/** What differs between a recorded and a current fingerprint, in words; empty when equal. */
function fingerprintDifferences(recorded: GuardFingerprint, current: GuardFingerprint): string[] {
  const out: string[] = [];
  if (recorded.fixture !== current.fixture) {
    out.push("the fixture (its requirement texts, labels or graph) changed");
  }
  if (recorded.repository !== current.repository) {
    out.push(`repository: recorded ${recorded.repository}, now ${current.repository}`);
  }
  return out;
}

/** One analysis the guard reads: a fixture requirement's text, on one run. */
export interface GuardAnalysisRecord {
  kind: "analysis";
  /** The fixture requirement's id. */
  requirement: string;
  run: number;
  /** `<provider>/<model>` it ran on: a resume on another model is refused. */
  model: string;
  fingerprint: GuardFingerprint;
  analysisId: string;
  /** The requirements it persisted, in creation order. */
  requirementIds: string[];
  /** Null when the analysis made an unpriced call. */
  costUsd: number | null;
  seconds: number;
}

/**
 * Which reading a run belongs to: A0 on the split seeding (`baseline`), A7,
 * A7O, or A0 on the mapper path (`mapper`, #1847: recorded so a resumed call
 * does not pay for it again).
 */
export type GuardReadingId = "baseline" | "A7" | "A7O" | "mapper";

/** One run of one reading. */
export interface GuardRunRecord {
  kind: "run";
  reading: GuardReadingId;
  run: number;
  /** `<provider>/<model>` of the #936 filter (and of the analyses). */
  model: string;
  fingerprint: GuardFingerprint;
  /** The run's macro table precision. */
  tablePrecision: number;
  /** The tables each requirement surfaced. */
  tables: Record<string, string[]>;
  /** The configuration's label and seeding. */
  label: string;
  seeding: string;
  /** Persisted requirements read as changes (A7, A7O). */
  changes: number;
  /** Analyses that persisted none, read as the fixture text (A7, A7O). */
  untracked: number;
  /** How A7's citations reached the fixture. */
  citations?: CitationTranslation;
}

export type GuardRecord = GuardAnalysisRecord | GuardRunRecord;

/** Where the guard's steps are recorded, so a stopped guard resumes. */
export interface GuardStore {
  read(): Promise<GuardRecord[]>;
  record(record: GuardRecord): Promise<void>;
}

const READINGS: ReadonlySet<string> = new Set(["baseline", "A7", "A7O", "mapper"]);

/** Parse one recorded line; a malformed one throws rather than being half-trusted. */
export function parseGuardRecord(line: string): GuardRecord {
  const r = JSON.parse(line) as Record<string, unknown>;
  const bad = (why: string): never => {
    throw new Error(`malformed table-guard record: ${why}`);
  };
  if (!r || typeof r !== "object") bad("not an object");
  if (typeof r.model !== "string") bad("no model");
  const fp = r.fingerprint as Partial<GuardFingerprint> | undefined;
  if (!fp || typeof fp.fixture !== "string" || typeof fp.repository !== "string") {
    bad("no fingerprint (recorded before #1847): use a new partials directory");
  }
  if (!Number.isInteger(r.run) || (r.run as number) < 1) bad("no run");
  if (r.kind === "analysis") {
    if (typeof r.requirement !== "string") bad("no requirement");
    if (typeof r.analysisId !== "string") bad("no analysisId");
    if (!Array.isArray(r.requirementIds) || !r.requirementIds.every((x) => typeof x === "string")) {
      bad("no requirementIds");
    }
    if (r.costUsd !== null && typeof r.costUsd !== "number") bad("no costUsd");
    if (typeof r.seconds !== "number") bad("no seconds");
  } else if (r.kind === "run") {
    if (typeof r.reading !== "string" || !READINGS.has(r.reading)) bad("no reading");
    if (typeof r.tablePrecision !== "number") bad("no tablePrecision");
    if (!r.tables || typeof r.tables !== "object") bad("no tables");
    if (typeof r.label !== "string" || typeof r.seeding !== "string") bad("no configuration");
    if (typeof r.changes !== "number" || typeof r.untracked !== "number") bad("no change counts");
  } else {
    bad(`unknown kind ${JSON.stringify(r.kind)}`);
  }
  return r as unknown as GuardRecord;
}

/**
 * The file the guard's steps are recorded in, inside a partials directory: in
 * a directory of its own, which the partial store does not read as a corpus.
 */
export function guardRecordsFile(partialsDir: string): string {
  return path.join(partialsDir, "table-guard", "records.jsonl");
}

/** A JSON-lines store: one record per line, appended as each step ends. */
export function fileGuardStore(file: string): GuardStore {
  return {
    async read() {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      return text
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map(parseGuardRecord);
    },
    async record(record) {
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
    },
  };
}

export interface AgentSeedGuardDeps {
  fixture: ImpactRecallFixture;
  /** The corpus search over the fixture's symbols: the split seeding's. */
  search: Pick<CorpusSearch, "searcher" | "loadSymbols">;
  /** The production-configuration options (consumer resolver, live #936 table filter). */
  options: RunImpactRecallOptions;
  /** Runs per reading: one analysis per requirement and run. */
  runs: number;
  /** `<provider>/<model>` the analyses and the #936 filter run on. */
  model: string;
  /** The repository the analyses run on, pinned (`TABLE_GUARD_REPO`): part of the fingerprint. */
  repo: Pick<LocalizationRepo, "url" | "ref" | "sha">;
  store: GuardStore;
  /** "Evaluate new requirements" on the materialized repository, awaited to its end. */
  analyze: (text: string) => Promise<{ analysisId: string; requirementIds: string[] }>;
  /** Production's `loadRequirementChanges`: one change per persisted requirement. */
  loadRequirementChanges: (requirementIds: readonly string[]) => Promise<ChangedRequirement[]>;
  /** A requirement's stored citations on the materialized project (production's read). */
  loadCitations: (requirementId: string) => Promise<StoredLinkRow[]>;
  /** The materialized graph's qualified name of each of these symbol ids. */
  qualifiedNames: (symbolIds: readonly string[]) => Promise<Map<string, string>>;
  /** Prices each analysis. */
  meter: CostMeter;
  /** Why no further step may run (the dollar cap, an unpriced call), or null. */
  blocked: () => string | null;
  /** At most this many new steps in this call (`--guard-steps`). Default: all. */
  maxSteps?: number;
  /** `runImpactRecallEval` over the fixture: one run of the baseline or of A0's mapper reading. */
  runOnce: (options: RunImpactRecallOptions) => Promise<ImpactRecallResult>;
  /** Appended to each reading's configuration label: the corpus and the provider. */
  describe: (label: string) => string;
  log?: (line: string) => void;
  /** Milliseconds; a seam for tests. */
  now?: () => number;
}

/**
 * The guard's readings for the two A7 variants, which share the analyses and
 * the baseline, and A0's mapper reading.
 */
export interface AgentSeedGuard {
  A0: () => Promise<TableGuardReading>;
  A7: () => Promise<TableGuardReading>;
  A7O: () => Promise<TableGuardReading>;
}

/**
 * #1847 — a guard built on its first reading, once: the build is memoised as
 * a promise, so two readings that start together share one build.
 */
export function lazyAgentSeedGuard(build: () => Promise<AgentSeedGuard>): AgentSeedGuard {
  let guard: Promise<AgentSeedGuard> | null = null;
  const get = () => (guard ??= build());
  return {
    A0: async () => (await get()).A0(),
    A7: async () => (await get()).A7(),
    A7O: async () => (await get()).A7O(),
  };
}

/** One paired comparison of two readings over the fixture's requirements. */
export interface GuardDifference {
  arm: GuardReadingId;
  baseline: GuardReadingId;
  runs: number;
  /** `mean(arm − baseline)` of each requirement's table precision, averaged over the runs. */
  interval: PairedTInterval;
}

/** The comparisons the guard reports, in order. */
const PAIRS: ReadonlyArray<readonly [GuardReadingId, GuardReadingId]> = [
  ["A7", "baseline"],
  ["A7O", "baseline"],
  ["A7", "A7O"],
];

/**
 * #1847 — the paired intervals over a guard's records (`records.jsonl`): each
 * requirement's table precision, averaged over runs 1 to `runs`, paired
 * reading against reading over the fixture's requirements, with a 95%
 * t-interval. A comparison missing a run of either reading is left out.
 */
export function guardPairedDifferences(
  records: readonly GuardRecord[],
  fixture: Pick<ImpactRecallFixture, "requirements">,
  runs: number,
): GuardDifference[] {
  const perRequirement = (reading: GuardReadingId): number[] | null => {
    const own: GuardRunRecord[] = [];
    for (let run = 1; run <= runs; run++) {
      const r = records.find((x) => x.kind === "run" && x.reading === reading && x.run === run);
      if (!r || r.kind !== "run") return null;
      own.push(r);
    }
    return fixture.requirements.map((q) =>
      mean(
        own.map((r) => scoreSet(r.tables[q.id] ?? [], q.expectedTables, normalizeTable).precision),
      ),
    );
  };
  const out: GuardDifference[] = [];
  for (const [arm, baseline] of PAIRS) {
    const a = perRequirement(arm);
    const b = perRequirement(baseline);
    if (a && b) out.push({ arm, baseline, runs, interval: pairedTInterval(b, a) });
  }
  return out;
}

/** A difference in words: `+0.020 [−0.018, +0.059]`. */
function signed(x: number): string {
  const v = x.toFixed(3);
  return v.startsWith("-") ? `−${v.slice(1)}` : `+${v}`;
}

const keyOf = (...parts: Array<string | number>): string => parts.join("\u0000");

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Thrown inside a step loop when the call may take no further step. */
class Stop extends Error {}

export function createAgentSeedGuard(deps: AgentSeedGuardDeps): AgentSeedGuard {
  const { fixture } = deps;
  const fingerprint = guardFingerprint(fixture, deps.repo);
  const now = deps.now ?? Date.now;
  const split: SplitSeedingOptions = {
    searcher: deps.search.searcher,
    loadSymbols: deps.search.loadSymbols,
  };
  const analyses = new Map<string, GuardAnalysisRecord>();
  const runs = new Map<string, GuardRunRecord>();
  let loaded: Promise<void> | null = null;
  let steps = 0;
  let stopped: string | null = null;
  const logged = new Set<string>();

  async function load(): Promise<void> {
    for (const r of await deps.store.read()) {
      if (r.model !== deps.model) {
        throw new Error(
          `the table guard's steps were recorded on ${r.model}, not ${deps.model}: use a new partials directory`,
        );
      }
      const diff = fingerprintDifferences(r.fingerprint, fingerprint);
      if (diff.length > 0) {
        throw new Error(
          `refusing to resume the table guard: its steps were recorded under another configuration:\n  - ${diff.join("\n  - ")}\nUse a new partials directory`,
        );
      }
      if (r.kind === "analysis") analyses.set(keyOf(r.requirement, r.run), r);
      else runs.set(keyOf(r.reading, r.run), r);
    }
  }

  /** Take one more step, or throw {@link Stop} when the call may not. */
  function step(): void {
    if (!stopped && deps.maxSteps !== undefined && steps >= deps.maxSteps) {
      stopped = `the --guard-steps limit (${deps.maxSteps})`;
    }
    stopped ??= deps.blocked();
    if (stopped) throw new Stop(stopped);
    steps++;
  }

  async function ensureAnalyses(): Promise<void> {
    for (let run = 1; run <= deps.runs; run++) {
      for (const requirement of fixture.requirements) {
        if (analyses.has(keyOf(requirement.id, run))) continue;
        step();
        const t0 = now();
        const spent = deps.meter.spentUsd();
        const unpriced = deps.meter.unpricedCalls();
        const result = await deps.analyze(requirement.text);
        const record: GuardAnalysisRecord = {
          kind: "analysis",
          requirement: requirement.id,
          run,
          model: deps.model,
          fingerprint,
          analysisId: result.analysisId,
          requirementIds: result.requirementIds,
          costUsd: deps.meter.unpricedCalls() > unpriced ? null : deps.meter.spentUsd() - spent,
          seconds: (now() - t0) / 1000,
        };
        await deps.store.record(record);
        analyses.set(keyOf(requirement.id, run), record);
        deps.log?.(
          `table guard: analysis ${requirement.id} run ${run}: ${record.requirementIds.length} requirement(s), ` +
            `${record.costUsd === null ? "unpriced" : `$${record.costUsd.toFixed(4)}`}, ${record.seconds.toFixed(0)} s`,
        );
      }
    }
  }

  /**
   * One run on the fixture's own text, no citations: A0 on the split seeding
   * (`baseline`), or A0 on the mapper path (`mapper`).
   */
  async function textRun(reading: "baseline" | "mapper", run: number): Promise<GuardRunRecord> {
    const result = await deps.runOnce(
      reading === "baseline" ? { ...deps.options, splitSeeding: split } : deps.options,
    );
    return {
      kind: "run",
      reading,
      run,
      model: deps.model,
      fingerprint,
      tablePrecision: result.aggregate.tables.macroPrecision,
      tables: Object.fromEntries(result.scores.map((s) => [s.id, s.tables.found])),
      label: result.configuration.label,
      seeding: reading === "mapper" ? MAPPER_SEEDING : result.configuration.seeding,
      changes: 0,
      untracked: 0,
    };
  }

  /**
   * #1847 — the changes each analysis of a run persisted, read through
   * production's `loadRequirementChanges`, which skips an id it cannot find.
   * After a re-materialize, a reset or on another database every analysis
   * would then be read as the fixture's text and A7 and A7O would converge on
   * the baseline, so a run is refused when any recorded id no longer resolves.
   */
  async function trackedChanges(run: number): Promise<Map<string, ChangedRequirement[]>> {
    const out = new Map<string, ChangedRequirement[]>();
    for (const requirement of fixture.requirements) {
      const analysis = analyses.get(keyOf(requirement.id, run))!;
      const ids = analysis.requirementIds;
      const tracked = ids.length > 0 ? await deps.loadRequirementChanges(ids) : [];
      const resolved = new Set(tracked.map((c) => c.requirementId));
      const missing = ids.filter((id) => !resolved.has(id));
      if (missing.length > 0) {
        throw new Error(
          `refusing to resume the table guard: analysis ${analysis.analysisId} (${requirement.id}, run ${run}) ` +
            `persisted ${ids.length} requirement(s); ${missing.length} no longer resolve in this database ` +
            `(re-materialized, reset, or another database), so it would be read as the fixture's text. ` +
            `Use a new partials directory`,
        );
      }
      out.set(requirement.id, tracked);
    }
    return out;
  }

  /** One run of A7 or A7O: impact on each analysis's requirements, tables unioned per requirement. */
  async function agentRun(
    reading: "A7" | "A7O",
    run: number,
    trackedBy: ReadonlyMap<string, ChangedRequirement[]>,
  ): Promise<GuardRunRecord> {
    const counts = emptyTranslation();
    const seeding: SplitSeedingOptions =
      reading === "A7"
        ? {
            ...split,
            agentSeeds: {
              // computeProjectImpact runs on the fixture's project only.
              loadCitations: async (requirementId) => {
                const links = await deps.loadCitations(requirementId);
                const ids = links.flatMap((l) => (l.codeSymbolId ? [l.codeSymbolId] : []));
                return translateCitations(links, await deps.qualifiedNames(ids), fixture, counts);
              },
              loadFileSymbols: fixtureFileSymbols(fixture),
            },
          }
        : split;
    const options: RunImpactRecallOptions = { ...deps.options, splitSeeding: seeding };
    const scores: RequirementScore[] = [];
    let changes = 0;
    let untracked = 0;
    for (const requirement of fixture.requirements) {
      const tracked = trackedBy.get(requirement.id)!;
      // An analysis that persisted nothing leaves nothing tracked: its text is read, as A7 does.
      if (tracked.length === 0) untracked++;
      changes += tracked.length;
      const tables = new Set<string>();
      const symbols = new Set<string>();
      for (const change of tracked.length > 0 ? tracked : [requirementToChange(requirement)]) {
        const found = await observeChange(fixture, change, fixture.searcher, options);
        for (const t of found.foundTables) tables.add(t);
        for (const s of found.foundCodeSymbols) symbols.add(s);
      }
      const foundTables = [...tables];
      const foundCodeSymbols = [...symbols];
      scores.push(
        scoreRequirement({
          id: requirement.id,
          text: requirement.text,
          expectedTables: requirement.expectedTables,
          expectedCodeSymbols: requirement.expectedCodeSymbols,
          expectedConsumers: requirement.expectedConsumers,
          foundTables,
          foundCodeSymbols,
          foundConsumers:
            requirement.expectedConsumers !== undefined && deps.options.consumerResolver
              ? await deps.options.consumerResolver({
                  requirement,
                  foundTables,
                  foundCodeSymbols,
                  fixture,
                })
              : [],
        }),
      );
    }
    const configuration = describeConfiguration(options);
    return {
      kind: "run",
      reading,
      run,
      model: deps.model,
      fingerprint,
      tablePrecision: aggregateScores(scores).tables.macroPrecision,
      tables: Object.fromEntries(scores.map((s) => [s.id, s.tables.found])),
      label: configuration.label,
      seeding:
        reading === "A7"
          ? "split + agent citations (an analysis's requirements, IMPACT_AGENT_SEEDS on)"
          : "split (an analysis's requirements, IMPACT_AGENT_SEEDS off)",
      changes,
      untracked,
      ...(reading === "A7" ? { citations: counts } : {}),
    };
  }

  /** Every run of a reading, measuring (and recording) the missing ones. */
  async function ensureRuns(reading: GuardReadingId): Promise<GuardRunRecord[]> {
    const out: GuardRunRecord[] = [];
    for (let run = 1; run <= deps.runs; run++) {
      let record = runs.get(keyOf(reading, run));
      if (!record) {
        // Checked before the step: a refused run spends nothing.
        const tracked = reading === "A7" || reading === "A7O" ? await trackedChanges(run) : null;
        step();
        record = tracked
          ? await agentRun(reading as "A7" | "A7O", run, tracked)
          : await textRun(reading as "baseline" | "mapper", run);
        await deps.store.record(record);
        runs.set(keyOf(reading, run), record);
        deps.log?.(
          `table guard: ${reading} run ${run}: table precision ${record.tablePrecision.toFixed(3)}`,
        );
      }
      out.push(record);
    }
    return out;
  }

  function measurement(records: readonly GuardRunRecord[]): TableGuardMeasurement {
    return {
      tablePrecision: mean(records.map((r) => r.tablePrecision)),
      runs: records.length,
      configuration: deps.describe(records[0]!.label),
      seeding: records[0]!.seeding,
    };
  }

  /** Log each paired comparison once, the first time both its readings are complete. */
  function logDifferences(): void {
    if (!deps.log) return;
    for (const d of guardPairedDifferences([...runs.values()], fixture, deps.runs)) {
      const key = `${d.arm} − ${d.baseline}`;
      if (logged.has(key)) continue;
      logged.add(key);
      const { meanDifference, ci, n } = d.interval;
      deps.log(
        `table guard: ${key}, paired over ${n} requirements (mean of ${d.runs} runs each): ` +
          `${signed(meanDifference)} [${signed(ci[0])}, ${signed(ci[1])}] (95% t-interval)`,
      );
    }
  }

  const recorded = (): string =>
    `${analyses.size} of ${fixture.requirements.length * deps.runs} analyses and ` +
    `${runs.size} reading run(s) recorded`;

  function stoppedReading(err: unknown): TableGuardReading {
    if (!(err instanceof Stop)) throw err;
    return {
      measured: false,
      reason: `${recorded()}; stopped by ${err.message}. Run the same --merge again to continue`,
    };
  }

  /** #1847 — A0 on the mapper path, recorded run by run as the other readings are. */
  async function mapperReading(): Promise<TableGuardReading> {
    try {
      await (loaded ??= load());
      return { measured: true, ...measurement(await ensureRuns("mapper")) };
    } catch (err) {
      return stoppedReading(err);
    }
  }

  async function reading(id: "A7" | "A7O"): Promise<TableGuardReading> {
    try {
      await (loaded ??= load());
      await ensureAnalyses();
      const base = await ensureRuns("baseline");
      // #1823 (owner, option A) — A7 is gated against A7O, the same analyses
      // with the flag off, which isolates the flag; read A7O first.
      const control = id === "A7" ? await ensureRuns("A7O") : null;
      const own = await ensureRuns(id);
      const sum = (pick: (r: GuardRunRecord) => number) => own.reduce((n, r) => n + pick(r), 0);
      const cited = own[0]!.citations
        ? (() => {
            const c = (k: keyof CitationTranslation) => sum((r) => r.citations?.[k] ?? 0);
            return `; citations: ${c("symbol")} by symbol, ${c("member")} by name, ${c("file")} as their file, ${c("dropped")} dropped (not in the fixture)`;
          })()
        : "";
      const m = measurement(own);
      logDifferences();
      return {
        measured: true,
        ...m,
        configuration:
          m.configuration +
          `; "Evaluate new requirements" on ${deps.model}, one per requirement and run; ` +
          `${sum((r) => r.changes)} persisted requirement(s) read, ${sum((r) => r.untracked)} analysis(es) read as the text` +
          cited +
          (control
            ? `; A0 on the split seeding: ${measurement(base).tablePrecision.toFixed(3)} (${base.length} runs)`
            : ""),
        baseline: control ? { ...measurement(control), arm: "A7O" } : measurement(base),
      };
    } catch (err) {
      return stoppedReading(err);
    }
  }

  return { A0: mapperReading, A7: () => reading("A7"), A7O: () => reading("A7O") };
}
