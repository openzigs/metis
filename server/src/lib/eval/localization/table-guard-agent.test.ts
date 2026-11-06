/**
 * #1823 — A7's table guard: analyses recorded one by one, impact runs on what
 * they persisted with and without the stored citations leading, against A0 on
 * the split seeding; resumable, bounded and capped.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { StoredLinkRow } from "../../impact-analysis/change-seeds.js";
import type { ChangedRequirement } from "../../impact-analysis/extract-changes.js";
import {
  loadImpactRecallFixture,
  recordedVectorsFile,
  resolveCorpusDir,
} from "../impact-recall/fixture.js";
import { runImpactRecallEval, runImpactRecallEvalRepeated } from "../impact-recall/runner.js";
import { normalizeTable, scoreSet } from "../impact-recall/scorer.js";
import { loadRecordedVectors } from "../recorded-vectors.js";
import { EmbedCache, buildCorpusSearch } from "./search.js";
import { pairedTInterval } from "./stats.js";
import { TABLE_PRECISION_TOLERANCE } from "./runner.js";
import { MAPPER_SEEDING, fixtureSearchRows } from "./table-guard.js";
import {
  createAgentSeedGuard,
  fileGuardStore,
  guardFingerprint,
  guardPairedDifferences,
  guardRecordsFile,
  lazyAgentSeedGuard,
  parseGuardRecord,
  type AgentSeedGuard,
  type AgentSeedGuardDeps,
  type GuardRecord,
  type GuardRunRecord,
  type GuardStore,
} from "./table-guard-agent.js";
import { TABLE_GUARD_CORPUS, TABLE_GUARD_REPO } from "./table-guard-source.js";

const dir = resolveCorpusDir(TABLE_GUARD_CORPUS);
const fixture = await loadImpactRecallFixture(dir);
// The analyses' requirements here carry the fixture's own text, so the
// committed recording answers every query offline.
const search = await buildCorpusSearch(
  fixtureSearchRows(fixture),
  new EmbedCache(await loadRecordedVectors(recordedVectorsFile(dir)), null, "test"),
);
const MODEL = "anthropic/deepseek-flash";
const FINGERPRINT = guardFingerprint(fixture, TABLE_GUARD_REPO);
const CITED = fixture.requirements.find((r) => r.text === "Update product details in the catalog")!;

function memoryStore(initial: GuardRecord[] = []): GuardStore & { records: GuardRecord[] } {
  const records = [...initial];
  return {
    records,
    read: async () => [...records],
    record: async (r) => {
      records.push(r);
    },
  };
}

/**
 * The analysis fakes: each analysis persists one requirement with the fixture
 * requirement's own text, except `emptyFor`, which persists none. The product
 * update's persisted requirements cite the order INSERT statement: a wrong
 * table, which only the A7 lead can bring in. `db` is the eval database the
 * analyses persist into: share one across calls to resume against it.
 */
function fakes(
  opts: {
    emptyFor?: string;
    alsoFor?: { text: string; also: string };
    db?: Map<string, string>;
  } = {},
) {
  let spent = 0;
  let unpriced = 0;
  const analyzed: string[] = [];
  const persisted = opts.db ?? new Map<string, string>(); // persisted id → fixture text
  const deps = {
    fixture,
    search,
    options: {},
    runs: 2,
    model: MODEL,
    repo: TABLE_GUARD_REPO,
    analyze: async (text: string) => {
      analyzed.push(text);
      spent += 0.02;
      const n = persisted.size + 1;
      if (text === opts.emptyFor) return { analysisId: `an-${n}`, requirementIds: [] };
      persisted.set(`pr-${n}`, text);
      if (text === opts.alsoFor?.text) {
        persisted.set(`pr-${n}-b`, opts.alsoFor.also);
        return { analysisId: `an-${n}`, requirementIds: [`pr-${n}`, `pr-${n}-b`] };
      }
      return { analysisId: `an-${n}`, requirementIds: [`pr-${n}`] };
    },
    // Production's read: an id the database no longer holds is skipped.
    loadRequirementChanges: async (ids: readonly string[]): Promise<ChangedRequirement[]> =>
      ids.flatMap((id) => {
        const text = persisted.get(id);
        return text === undefined
          ? []
          : [
              {
                requirementId: id,
                title: text,
                body: text,
                changeType: "added",
                bodyDelta: text.length,
              },
            ];
      }),
    loadCitations: async (requirementId: string): Promise<StoredLinkRow[]> =>
      persisted.get(requirementId) === CITED.text
        ? [
            {
              codeSymbolId: "real-insert-order",
              filePath: "src/main/resources/org/mybatis/jpetstore/mapper/OrderMapper.xml",
              startLine: 30,
              endLine: 60,
              confidence: 0.95,
              source: "analysis-grounding",
            },
          ]
        : [],
    qualifiedNames: async (ids: readonly string[]) =>
      new Map(
        ids
          .filter((id) => id === "real-insert-order")
          .map((id) => [id, "org.mybatis.jpetstore.mapper.OrderMapper.insertOrder"]),
      ),
    meter: { spentUsd: () => spent, unpricedCalls: () => unpriced },
    blocked: () => null,
    runOnce: (o: Parameters<AgentSeedGuardDeps["runOnce"]>[0]) => runImpactRecallEval(fixture, o),
    describe: (label: string) => `${TABLE_GUARD_CORPUS}, ${label}`,
  };
  return { deps, analyzed, persisted, setUnpriced: () => (unpriced = 1) };
}

describe("createAgentSeedGuard (#1823)", () => {
  const total = fixture.requirements.length * 2;

  it("runs one analysis per requirement and run, then reads A7 and A7O against A0 on the split seeding", async () => {
    const store = memoryStore();
    const { deps, analyzed } = fakes();
    const guard = createAgentSeedGuard({ ...deps, store });
    const a7 = await guard.A7();
    const a7o = await guard.A7O();
    expect(analyzed).toHaveLength(total);
    expect(analyzed.slice(0, fixture.requirements.length)).toEqual(
      fixture.requirements.map((r) => r.text),
    );
    if (!a7.measured || !a7o.measured) throw new Error("both readings should be measured");
    // A7O reads the fixture's own text without citations: A0 on the split seeding.
    expect(a7o.tablePrecision).toBeCloseTo(a7o.baseline!.tablePrecision, 10);
    expect(a7o.baseline!.seeding).toBe("split");
    expect(a7o.baseline!.arm).toBeUndefined();
    // The product update's citation brings in the order table: precision drops.
    expect(a7.tablePrecision).toBeLessThan(a7o.tablePrecision);
    // #1823 (owner, option A) — A7 is gated against A7O, the same analyses with the flag off.
    expect(a7).toMatchObject({ runs: 2 });
    expect(a7.baseline).toEqual({
      tablePrecision: a7o.tablePrecision,
      runs: a7o.runs,
      configuration: expect.stringContaining(TABLE_GUARD_CORPUS),
      seeding: a7o.seeding,
      arm: "A7O",
    });
    // A0 on the split seeding is still reported beside it.
    expect(a7.configuration).toContain(
      `A0 on the split seeding: ${a7o.baseline!.tablePrecision.toFixed(3)} (2 runs)`,
    );
    expect(a7.seeding).toContain("IMPACT_AGENT_SEEDS on");
    expect(a7o.seeding).toContain("IMPACT_AGENT_SEEDS off");
    expect(a7.configuration).toContain("IMPACT_AGENT_SEEDS=1");
    expect(a7.configuration).toContain(`${total} persisted requirement(s) read`);
    expect(a7.configuration).toContain("citations: 2 by symbol, 0 by name, 0 as their file");
    expect(a7o.configuration).not.toContain("citations:");

    const runs = store.records.filter((r) => r.kind === "run");
    expect(runs.map((r) => (r.kind === "run" ? `${r.reading} ${r.run}` : ""))).toEqual([
      "baseline 1",
      "baseline 2",
      "A7O 1",
      "A7O 2",
      "A7 1",
      "A7 2",
    ]);
    const tablesOf = (reading: string) => {
      const r = runs.find((x) => x.kind === "run" && x.reading === reading);
      return r?.kind === "run" ? r.tables[CITED.id] : undefined;
    };
    expect(tablesOf("A7")).toContain("orders");
    expect(tablesOf("A7O")).not.toContain("orders");
    const analyses = store.records.filter((r) => r.kind === "analysis");
    expect(analyses).toHaveLength(total);
    expect(analyses[0]).toMatchObject({ model: MODEL, run: 1, costUsd: expect.closeTo(0.02, 10) });
  });

  it("stops at the step limit, records what it took, and a later call takes only the rest", async () => {
    const store = memoryStore();
    const db = new Map<string, string>();
    const first = fakes({ db });
    const stopped = await createAgentSeedGuard({ ...first.deps, store, maxSteps: 5 }).A7();
    expect(stopped).toEqual({
      measured: false,
      reason: `5 of ${total} analyses and 0 reading run(s) recorded; stopped by the --guard-steps limit (5). Run the same --merge again to continue`,
    });
    expect(first.analyzed).toHaveLength(5);
    expect(store.records).toHaveLength(5);

    const second = fakes({ db });
    const reading = await createAgentSeedGuard({ ...second.deps, store }).A7();
    expect(second.analyzed).toEqual(
      [...fixture.requirements, ...fixture.requirements].slice(5).map((r) => r.text),
    );
    expect(reading.measured).toBe(true);

    // A third call has every step: it runs nothing and reads the same.
    const third = fakes({ db });
    const again = await createAgentSeedGuard({ ...third.deps, store, maxSteps: 1 }).A7();
    expect(third.analyzed).toEqual([]);
    expect(again).toEqual(reading);
  });

  it("stops before a step when the cap says so, and spends nothing", async () => {
    const { deps, analyzed } = fakes();
    const reading = await createAgentSeedGuard({
      ...deps,
      store: memoryStore(),
      blocked: () => "budget: $5.0000 spent of $5",
    }).A7();
    expect(analyzed).toEqual([]);
    expect(reading).toMatchObject({
      measured: false,
      reason: expect.stringContaining("stopped by budget: $5.0000 spent of $5"),
    });
  });

  it("records an analysis that made an unpriced call as unpriced", async () => {
    const store = memoryStore();
    const f = fakes();
    const analyze = f.deps.analyze;
    await createAgentSeedGuard({
      ...f.deps,
      store,
      maxSteps: 1,
      analyze: async (text) => {
        f.setUnpriced();
        return analyze(text);
      },
    }).A7();
    expect(store.records[0]).toMatchObject({ kind: "analysis", costUsd: null });
  });

  it("reads an analysis that persisted nothing as the requirement's own text, and counts it", async () => {
    const { deps } = fakes({ emptyFor: CITED.text });
    const reading = await createAgentSeedGuard({ ...deps, store: memoryStore() }).A7();
    if (!reading.measured) throw new Error("should be measured");
    expect(reading.configuration).toContain(
      `${total - 2} persisted requirement(s) read, 2 analysis(es) read as the text`,
    );
    // No requirement id, so no citation is read for it.
    expect(reading.configuration).toContain("citations: 0 by symbol");
  });

  it("unions the tables of every requirement an analysis persisted", async () => {
    const store = memoryStore();
    const order = fixture.requirements.find(
      (r) => r.text === "Store a shipping method on each order",
    )!;
    const { deps } = fakes({ alsoFor: { text: CITED.text, also: order.text } });
    const reading = await createAgentSeedGuard({ ...deps, store }).A7O();
    if (!reading.measured) throw new Error("should be measured");
    const tables = (id: string, reading: string) => {
      const r = store.records.find((x) => x.kind === "run" && x.reading === reading);
      return r?.kind === "run" ? r.tables[id]! : [];
    };
    // The product update's tables, and the order requirement's, on the same item.
    expect(tables(CITED.id, "A7O")).toEqual(
      [...new Set([...tables(CITED.id, "baseline"), ...tables(order.id, "baseline")])].sort(),
    );
    expect(reading.configuration).toContain(`${total + 2} persisted requirement(s) read`);
  });

  it("refuses steps recorded on another model", async () => {
    const { deps } = fakes();
    const store = memoryStore([
      {
        kind: "analysis",
        requirement: CITED.id,
        run: 1,
        model: "anthropic/claude-sonnet-5-5",
        fingerprint: FINGERPRINT,
        analysisId: "x",
        requirementIds: [],
        costUsd: 0.1,
        seconds: 1,
      },
    ]);
    await expect(createAgentSeedGuard({ ...deps, store }).A7()).rejects.toThrow(
      /recorded on anthropic\/claude-sonnet-5-5, not anthropic\/deepseek-flash/,
    );
  });

  it("lets a failed analysis fail the reading, keeping the ones before it", async () => {
    const store = memoryStore();
    const f = fakes();
    let n = 0;
    await expect(
      createAgentSeedGuard({
        ...f.deps,
        store,
        analyze: async (text) => {
          if (++n === 3) throw new Error("analysis an-3 ended failed");
          return f.deps.analyze(text);
        },
      }).A7(),
    ).rejects.toThrow(/ended failed/);
    expect(store.records).toHaveLength(2);
  });
});

describe("the guard's record file (#1823)", () => {
  const tmp: string[] = [];
  afterAll(async () => {
    for (const d of tmp) await rm(d, { recursive: true, force: true });
  });

  it("appends one record per line in a directory the partial store does not read as a corpus", async () => {
    const partials = await mkdtemp(path.join(os.tmpdir(), "guard-"));
    tmp.push(partials);
    const file = guardRecordsFile(partials);
    expect(path.relative(partials, file)).toBe(path.join("table-guard", "records.jsonl"));
    const store = fileGuardStore(file);
    expect(await store.read()).toEqual([]);
    const a: GuardRecord = {
      kind: "analysis",
      requirement: "REQ-01",
      run: 1,
      model: MODEL,
      fingerprint: FINGERPRINT,
      analysisId: "an-1",
      requirementIds: ["pr-1"],
      costUsd: null,
      seconds: 3,
    };
    const r: GuardRecord = {
      kind: "run",
      reading: "A7",
      run: 1,
      model: MODEL,
      fingerprint: FINGERPRINT,
      tablePrecision: 0.5,
      tables: { "REQ-01": ["product"] },
      label: "x",
      seeding: "y",
      changes: 1,
      untracked: 0,
      citations: { symbol: 1, member: 0, file: 0, dropped: 0 },
    };
    await store.record(a);
    await store.record(r);
    expect(await store.read()).toEqual([a, r]);
    expect((await readFile(file, "utf8")).split("\n")).toHaveLength(3);
  });

  it("refuses a malformed record rather than half-trusting it", async () => {
    const partials = await mkdtemp(path.join(os.tmpdir(), "guard-"));
    tmp.push(partials);
    const file = guardRecordsFile(partials);
    await fileGuardStore(file).record({
      kind: "analysis",
      requirement: "REQ-01",
      run: 1,
      model: MODEL,
      fingerprint: FINGERPRINT,
      analysisId: "an-1",
      requirementIds: [],
      costUsd: 0,
      seconds: 1,
    });
    await writeFile(
      file,
      `${await readFile(file, "utf8")}{"kind":"run","model":"m","fingerprint":{"fixture":"f","repository":"r"},"run":1}\n`,
    );
    await expect(fileGuardStore(file).read()).rejects.toThrow(/no reading/);
  });

  it.each([
    [
      '{"kind":"analysis","model":"m","fingerprint":{"fixture":"f","repository":"r"},"run":0}',
      /no run/,
    ],
    ['{"kind":"analysis","run":1}', /no model/],
    ['{"kind":"analysis","model":"m","run":1}', /no fingerprint \(recorded before #1847\)/],
    ['{"kind":"analysis","model":"m","run":1,"fingerprint":{"fixture":"f"}}', /no fingerprint/],
    [
      '{"kind":"analysis","model":"m","fingerprint":{"fixture":"f","repository":"r"},"run":1,"analysisId":"a","requirementIds":[]}',
      /no requirement$/,
    ],
    [
      '{"kind":"analysis","model":"m","fingerprint":{"fixture":"f","repository":"r"},"run":1,"requirement":"R","requirementIds":[]}',
      /no analysisId/,
    ],
    [
      '{"kind":"analysis","model":"m","fingerprint":{"fixture":"f","repository":"r"},"run":1,"requirement":"R","analysisId":"a","requirementIds":[1]}',
      /no requirementIds/,
    ],
    [
      '{"kind":"analysis","model":"m","fingerprint":{"fixture":"f","repository":"r"},"run":1,"requirement":"R","analysisId":"a","requirementIds":[],"costUsd":"1"}',
      /no costUsd/,
    ],
    [
      '{"kind":"analysis","model":"m","fingerprint":{"fixture":"f","repository":"r"},"run":1,"requirement":"R","analysisId":"a","requirementIds":[],"costUsd":1}',
      /no seconds/,
    ],
    [
      '{"kind":"run","model":"m","fingerprint":{"fixture":"f","repository":"r"},"run":1,"reading":"A9"}',
      /no reading/,
    ],
    [
      '{"kind":"run","model":"m","fingerprint":{"fixture":"f","repository":"r"},"run":1,"reading":"mapper","tablePrecision":1,"tables":{},"label":"l","seeding":"s","changes":0,"untracked":0}',
      null,
    ],
    [
      '{"kind":"run","model":"m","fingerprint":{"fixture":"f","repository":"r"},"run":1,"reading":"A7"}',
      /no tablePrecision/,
    ],
    [
      '{"kind":"run","model":"m","fingerprint":{"fixture":"f","repository":"r"},"run":1,"reading":"A7","tablePrecision":1}',
      /no tables/,
    ],
    [
      '{"kind":"run","model":"m","fingerprint":{"fixture":"f","repository":"r"},"run":1,"reading":"A7","tablePrecision":1,"tables":{}}',
      /no configuration/,
    ],
    [
      '{"kind":"run","model":"m","fingerprint":{"fixture":"f","repository":"r"},"run":1,"reading":"A7","tablePrecision":1,"tables":{},"label":"l","seeding":"s"}',
      /no change counts/,
    ],
    [
      '{"kind":"other","model":"m","fingerprint":{"fixture":"f","repository":"r"},"run":1}',
      /unknown kind/,
    ],
    ["null", /not an object/],
  ])("parseGuardRecord reads %s", (line, error) => {
    if (error === null) expect(parseGuardRecord(line)).toMatchObject({ reading: "mapper" });
    else expect(() => parseGuardRecord(line)).toThrow(error);
  });
});

describe("a resumed table guard checks what it resumes against (#1847)", () => {
  const total = fixture.requirements.length * 2;

  it("refuses to read runs when a recorded analysis's requirements no longer resolve", async () => {
    const store = memoryStore();
    const first = fakes();
    // Only the analyses are recorded.
    await createAgentSeedGuard({ ...first.deps, store, maxSteps: total }).A7();
    expect(store.records).toHaveLength(total);

    // The eval database was reset: none of the recorded ids resolves.
    const second = fakes();
    const runOnce = vi.fn(second.deps.runOnce);
    await expect(createAgentSeedGuard({ ...second.deps, store, runOnce }).A7()).rejects.toThrow(
      /refusing to resume the table guard: analysis an-1 \(REQ-01, run 1\) persisted 1 requirement\(s\); 1 no longer resolve/,
    );
    expect(second.analyzed).toEqual([]);
    // The baseline does not read the analyses; no A7 run was taken or recorded.
    expect(store.records.filter((r) => r.kind === "run" && r.reading === "A7")).toEqual([]);
  });

  it("refuses when one of an analysis's requirements was deleted, the rest still there", async () => {
    const store = memoryStore();
    const db = new Map<string, string>();
    const first = fakes({ db });
    await createAgentSeedGuard({ ...first.deps, store, maxSteps: total }).A7();
    db.delete("pr-3");
    await expect(createAgentSeedGuard({ ...fakes({ db }).deps, store }).A7O()).rejects.toThrow(
      /analysis an-3 \(REQ-03, run 1\).*1 no longer resolve/,
    );
  });

  it("resumes against the same database", async () => {
    const store = memoryStore();
    const db = new Map<string, string>();
    await createAgentSeedGuard({ ...fakes({ db }).deps, store, maxSteps: total }).A7();
    const reading = await createAgentSeedGuard({ ...fakes({ db }).deps, store }).A7();
    expect(reading.measured).toBe(true);
  });

  it("refuses steps recorded on another fixture", async () => {
    const store = memoryStore();
    await createAgentSeedGuard({ ...fakes().deps, store, maxSteps: 1 }).A7();
    const relabelled = {
      ...fixture,
      manifest: {
        ...fixture.manifest,
        requirements: fixture.manifest.requirements.map((r, i) =>
          i === 0 ? { ...r, text: `${r.text}, and its price` } : r,
        ),
      },
    };
    await expect(
      createAgentSeedGuard({ ...fakes().deps, fixture: relabelled, store }).A7(),
    ).rejects.toThrow(
      /recorded under another configuration:\n {2}- the fixture \(its requirement texts, labels or graph\) changed/,
    );
  });

  it("refuses steps recorded against another repository pin", async () => {
    const store = memoryStore();
    await createAgentSeedGuard({ ...fakes().deps, store, maxSteps: 1 }).A7();
    const repo = { ...TABLE_GUARD_REPO, ref: "jpetstore-6.4.0", sha: "0".repeat(40) };
    await expect(createAgentSeedGuard({ ...fakes().deps, repo, store }).A7()).rejects.toThrow(
      `repository: recorded ${TABLE_GUARD_REPO.url}@jpetstore-6.3.0 (${TABLE_GUARD_REPO.sha}), now ${TABLE_GUARD_REPO.url}@jpetstore-6.4.0 (${"0".repeat(40)})`,
    );
  });

  it("fingerprints the fixture and the pin, not the order of the manifest's keys", () => {
    const reordered = {
      manifest: Object.fromEntries(Object.entries(fixture.manifest).reverse()),
    } as unknown as typeof fixture;
    expect(guardFingerprint(reordered, TABLE_GUARD_REPO)).toEqual(FINGERPRINT);
    expect(FINGERPRINT.repository).toBe(
      `${TABLE_GUARD_REPO.url}@${TABLE_GUARD_REPO.ref} (${TABLE_GUARD_REPO.sha})`,
    );
    expect(FINGERPRINT.fixture).toMatch(/^[0-9a-f]{16}$/);
  });

  it("stamps every record it writes with the fingerprint", async () => {
    const store = memoryStore();
    await createAgentSeedGuard({ ...fakes().deps, store }).A7();
    expect(store.records.length).toBeGreaterThan(total);
    expect(store.records.every((r) => r.fingerprint.fixture === FINGERPRINT.fixture)).toBe(true);
    expect(store.records.every((r) => r.fingerprint.repository === FINGERPRINT.repository)).toBe(
      true,
    );
  });
});

describe("A0's mapper reading, recorded (#1847)", () => {
  it("records each mapper run, so a resumed call pays for none of them again", async () => {
    const store = memoryStore();
    const f = fakes();
    const runOnce = vi.fn(f.deps.runOnce);
    const a0 = await createAgentSeedGuard({ ...f.deps, store, runOnce }).A0();
    if (!a0.measured) throw new Error("should be measured");
    // The mapper path: no split seeding.
    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(runOnce.mock.calls.every(([o]) => o.splitSeeding === undefined)).toBe(true);
    const expected = await runImpactRecallEvalRepeated(fixture, {}, 2);
    expect(a0).toEqual({
      measured: true,
      tablePrecision: expected.meanAggregate.tables.macroPrecision,
      runs: 2,
      configuration: `${TABLE_GUARD_CORPUS}, ${expected.configuration.label}`,
      seeding: MAPPER_SEEDING,
    });
    // It takes no analysis: A0 reads the fixture's own text.
    expect(f.analyzed).toEqual([]);
    expect(store.records.map((r) => (r.kind === "run" ? `${r.reading} ${r.run}` : r.kind))).toEqual(
      ["mapper 1", "mapper 2"],
    );

    const again = vi.fn(f.deps.runOnce);
    const resumed = await createAgentSeedGuard({ ...f.deps, store, runOnce: again }).A0();
    expect(again).not.toHaveBeenCalled();
    expect(resumed).toEqual(a0);
  });

  it("is a step: the step limit and the cap stop it", async () => {
    const store = memoryStore();
    const f = fakes();
    expect(await createAgentSeedGuard({ ...f.deps, store, maxSteps: 1 }).A0()).toEqual({
      measured: false,
      reason: `0 of ${fixture.requirements.length * 2} analyses and 1 reading run(s) recorded; stopped by the --guard-steps limit (1). Run the same --merge again to continue`,
    });
    const capped = await createAgentSeedGuard({
      ...f.deps,
      store,
      blocked: () => "an unpriced model call",
    }).A0();
    expect(capped).toMatchObject({ measured: false, reason: expect.stringContaining("unpriced") });
  });
});

describe("lazyAgentSeedGuard (#1847)", () => {
  it("builds the guard once, even when two readings start together", async () => {
    let builds = 0;
    const guard: AgentSeedGuard = {
      A0: async () => ({ measured: false, reason: "A0" }),
      A7: async () => ({ measured: false, reason: "A7" }),
      A7O: async () => ({ measured: false, reason: "A7O" }),
    };
    const lazy = lazyAgentSeedGuard(async () => {
      builds++;
      await new Promise((r) => setTimeout(r, 5));
      return guard;
    });
    expect(builds).toBe(0);
    const readings = await Promise.all([lazy.A7(), lazy.A7O(), lazy.A0()]);
    expect(builds).toBe(1);
    expect(readings.map((r) => (r.measured ? "" : r.reason))).toEqual(["A7", "A7O", "A0"]);
  });
});

describe("guardPairedDifferences (#1847)", () => {
  /** A run record whose tables per requirement are given. */
  const run = (
    reading: GuardRunRecord["reading"],
    n: number,
    tables: (id: string, expected: string[]) => string[],
  ): GuardRunRecord => ({
    kind: "run",
    reading,
    run: n,
    model: MODEL,
    fingerprint: FINGERPRINT,
    tablePrecision: 0,
    tables: Object.fromEntries(
      fixture.requirements.map((r) => [r.id, tables(r.id, r.expectedTables)]),
    ),
    label: "l",
    seeding: "s",
    changes: 0,
    untracked: 0,
  });
  const precision = (expected: string[], found: string[]) =>
    scoreSet(found, expected, normalizeTable).precision;

  it("pairs each requirement's mean table precision over the runs, reading against reading", () => {
    const first = fixture.requirements[0]!.id;
    const second = fixture.requirements[1]!.id;
    const records: GuardRecord[] = [
      run("baseline", 1, (_, e) => e),
      run("baseline", 2, (_, e) => e),
      // A7 adds a wrong table to the first requirement on run 1 only.
      run("A7", 1, (id, e) => (id === first ? [...e, "bogus"] : e)),
      run("A7", 2, (_, e) => e),
      // A7O adds one to the second requirement on both runs.
      run("A7O", 1, (id, e) => (id === second ? [...e, "bogus"] : e)),
      run("A7O", 2, (id, e) => (id === second ? [...e, "bogus"] : e)),
      run("mapper", 1, () => ["bogus"]),
    ];
    const mean = (reading: GuardRunRecord["reading"]) =>
      fixture.requirements.map((r) => {
        const rs = records.filter(
          (x): x is GuardRunRecord => x.kind === "run" && x.reading === reading,
        );
        return rs.reduce((a, x) => a + precision(r.expectedTables, x.tables[r.id]!), 0) / rs.length;
      });
    const out = guardPairedDifferences(records, fixture, 2);
    expect(out.map((d) => `${d.arm} − ${d.baseline}`)).toEqual([
      "A7 − baseline",
      "A7O − baseline",
      "A7 − A7O",
    ]);
    expect(out[0]!.interval).toEqual(pairedTInterval(mean("baseline"), mean("A7")));
    expect(out[1]!.interval).toEqual(pairedTInterval(mean("baseline"), mean("A7O")));
    expect(out[2]!.interval).toEqual(pairedTInterval(mean("A7O"), mean("A7")));
    expect(out[0]!.interval.meanDifference).toBeLessThan(0);
    expect(out[2]!.interval.n).toBe(fixture.requirements.length);
  });

  it("reads only the runs it was asked for, and no comparison missing a run", () => {
    const records: GuardRecord[] = [
      run("baseline", 1, (_, e) => e),
      run("A7", 1, (_, e) => [...e, "bogus"]),
      run("A7", 2, () => []),
    ];
    const out = guardPairedDifferences(records, fixture, 1);
    expect(out.map((d) => `${d.arm} − ${d.baseline}`)).toEqual(["A7 − baseline"]);
    expect(out[0]!.interval.meanDifference).toBeLessThan(0);
    expect(guardPairedDifferences(records, fixture, 2)).toEqual([]);
  });

  it("reproduces the intervals docs/IMPACT_ANALYSIS_LLM_STAGES.md reports from the 2026-11-05 DeepSeek records", async () => {
    const text = await readFile(
      path.join(import.meta.dirname, "__fixtures__", "table-guard-deepseek-2026-11-05.runs.jsonl"),
      "utf8",
    );
    // Recorded before #1847: no fingerprint, so read without parseGuardRecord.
    const records = text
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => ({ ...JSON.parse(l), fingerprint: FINGERPRINT }) as GuardRecord);
    const out = guardPairedDifferences(records, fixture, 3);
    const read = (i: number) => {
      const { meanDifference, ci } = out[i]!.interval;
      return [meanDifference, ...ci].map((x) => x.toFixed(3));
    };
    expect(read(0)).toEqual(["-0.232", "-0.410", "-0.054"]);
    expect(read(1)).toEqual(["-0.252", "-0.417", "-0.087"]);
    expect(read(2)).toEqual(["0.020", "-0.018", "0.059"]);
  });

  it("reads the 2026-11-06 Sonnet guard from its committed records: A7 within 0.03 of A7O (#1823)", async () => {
    const text = await readFile(
      path.join(import.meta.dirname, "__fixtures__", "table-guard-sonnet-2026-11-06.runs.jsonl"),
      "utf8",
    );
    const records = text
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map(parseGuardRecord);
    expect(new Set(records.map((r) => r.model))).toEqual(new Set(["anthropic/claude-sonnet-5-5"]));
    expect(records.every((r) => r.fingerprint.fixture === FINGERPRINT.fixture)).toBe(true);
    expect(records.every((r) => r.fingerprint.repository === FINGERPRINT.repository)).toBe(true);
    const out = guardPairedDifferences(records, fixture, 3);
    const read = (i: number) => {
      const { meanDifference, ci } = out[i]!.interval;
      return [meanDifference, ...ci].map((x) => x.toFixed(3));
    };
    expect(read(0)).toEqual(["-0.189", "-0.266", "-0.113"]);
    expect(read(1)).toEqual(["-0.182", "-0.277", "-0.087"]);
    expect(read(2)).toEqual(["-0.007", "-0.043", "0.028"]);
    // The owner's rule (option A): A7's average within 0.03 of A7O, or better.
    // The rule reads the mean only: the interval's lower bound (-0.043) is past it.
    expect(out[2]!.interval.meanDifference).toBeGreaterThanOrEqual(-TABLE_PRECISION_TOLERANCE);
  });

  it("logs each comparison once, as soon as both its readings are complete", async () => {
    const lines: string[] = [];
    const guard = createAgentSeedGuard({
      ...fakes().deps,
      store: memoryStore(),
      log: (l) => lines.push(l),
    });
    await guard.A0();
    expect(lines.filter((l) => l.includes("paired over"))).toEqual([]);
    // #1823 — A7's reading takes A7O's runs too (its control): every comparison is complete.
    await guard.A7();
    expect(lines.filter((l) => l.includes("paired over"))).toHaveLength(3);
    await guard.A7O();
    const paired = lines.filter((l) => l.includes("paired over"));
    expect(paired).toHaveLength(3);
    expect(paired[2]).toMatch(
      /^table guard: A7 − A7O, paired over 11 requirements \(mean of 2 runs each\): [+−]\d\.\d{3} \[[+−]\d\.\d{3}, [+−]\d\.\d{3}\] \(95% t-interval\)$/,
    );
  });
});
