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
  guardRunTables,
  guardScoringOf,
  lazyAgentSeedGuard,
  parseGuardRecord,
  type AgentSeedGuard,
  type AgentSeedGuardDeps,
  type GuardRecord,
  type GuardRunRecord,
  type GuardStaleness,
  type GuardStore,
} from "./table-guard-agent.js";
import { TABLE_GUARD_CORPUS, TABLE_GUARD_REPO } from "./table-guard-source.js";
import type { StalenessOp } from "./staleness.js";

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

  const a7Line = (pieces: unknown) =>
    JSON.stringify({
      kind: "run",
      model: "m",
      fingerprint: { fixture: "f", repository: "r" },
      run: 1,
      reading: "A7",
      tablePrecision: 1,
      tables: {},
      label: "l",
      seeding: "s",
      changes: 1,
      untracked: 0,
      pieces,
    });

  it("#1848 — reads a run's per-requirement tables", () => {
    const pieces = { "REQ-01": [{ requirementId: "pr-1", title: "t", tables: ["product"] }] };
    expect(parseGuardRecord(a7Line(pieces))).toMatchObject({ pieces });
  });

  it.each([
    ["an array", []],
    ["null", null],
    ["a requirement with no changes", { "REQ-01": [] }],
    ["a requirement that is not a list", { "REQ-01": "x" }],
    ["a null change", { "REQ-01": [null] }],
    ["a change with no id", { "REQ-01": [{ title: "t", tables: [] }] }],
    ["a change with no title", { "REQ-01": [{ requirementId: "p", tables: [] }] }],
    ["a change with no tables", { "REQ-01": [{ requirementId: "p", title: "t" }] }],
    [
      "a change with a non-string table",
      { "REQ-01": [{ requirementId: "p", title: "t", tables: [1] }] },
    ],
  ])("#1848 — refuses per-requirement tables that are %s", (_, pieces) => {
    expect(() => parseGuardRecord(a7Line(pieces))).toThrow(/malformed pieces/);
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
    const order = fixture.requirements.find(
      (r) => r.text === "Store a shipping method on each order",
    )!;
    const alsoFor = { text: CITED.text, also: order.text };
    const first = fakes({ db, alsoFor });
    await createAgentSeedGuard({ ...first.deps, store, maxSteps: total }).A7();
    // The run-1 analysis of the product update persisted two requirements:
    // delete only the second, so one of its ids still resolves.
    const analysis = store.records.find(
      (r) => r.kind === "analysis" && r.requirement === CITED.id && r.run === 1,
    );
    if (analysis?.kind !== "analysis") throw new Error("the analysis should be recorded");
    expect(analysis.requirementIds).toHaveLength(2);
    const [kept, deleted] = analysis.requirementIds;
    expect(deleted).toMatch(/^pr-\d+-b$/);
    db.delete(deleted!);
    expect(db.has(kept!)).toBe(true);
    await expect(
      createAgentSeedGuard({ ...fakes({ db, alsoFor }).deps, store }).A7O(),
    ).rejects.toThrow(
      new RegExp(
        `analysis ${analysis.analysisId} \\(${CITED.id}, run 1\\) persisted 2 requirement\\(s\\); 1 no longer resolve`,
      ),
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
      A7S: async () => ({ measured: false, reason: "A7S" }),
      A7SD: async () => ({ measured: false, reason: "A7SD" }),
    };
    const lazy = lazyAgentSeedGuard(async () => {
      builds++;
      await new Promise((r) => setTimeout(r, 5));
      return guard;
    });
    expect(builds).toBe(0);
    const readings = await Promise.all([lazy.A7(), lazy.A7O(), lazy.A0(), lazy.A7S(), lazy.A7SD()]);
    expect(builds).toBe(1);
    expect(readings.map((r) => (r.measured ? "" : r.reason))).toEqual([
      "A7",
      "A7O",
      "A0",
      "A7S",
      "A7SD",
    ]);
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

  it("#1848 — pairs the analysis's first persisted requirement when asked, and nothing it cannot read", () => {
    const first = fixture.requirements[0]!.id;
    // A7 surfaces only the label as its headline; the union adds a wrong table.
    const withPieces = (reading: GuardRunRecord["reading"], n: number): GuardRunRecord => ({
      ...run(reading, n, (_, e) => [...e, "bogus"]),
      pieces: Object.fromEntries(
        fixture.requirements.map((r) => [
          r.id,
          [
            { requirementId: `${r.id}-h`, title: r.text, tables: r.expectedTables },
            { requirementId: `${r.id}-n`, title: "nfr", tables: ["bogus"] },
          ],
        ]),
      ),
    });
    const records: GuardRecord[] = [
      run("baseline", 1, (id, e) => (id === first ? [...e, "bogus"] : e)),
      withPieces("A7", 1),
      withPieces("A7O", 1),
    ];
    const headline = guardPairedDifferences(records, fixture, 1, "headline");
    expect(headline.map((d) => `${d.arm} − ${d.baseline} ${d.scoring}`)).toEqual([
      "A7 − baseline headline",
      "A7O − baseline headline",
      "A7 − A7O headline",
    ]);
    // Only the first requirement's baseline had a wrong table: the headline gains there.
    const labelled = fixture.requirements[0]!.expectedTables;
    const gain = 1 - precision(labelled, [...labelled, "bogus"]);
    expect(headline[0]!.interval.meanDifference).toBeCloseTo(
      gain / fixture.requirements.length,
      10,
    );
    expect(headline[2]!.interval.meanDifference).toBe(0);
    const union = guardPairedDifferences(records, fixture, 1);
    expect(union.every((d) => d.scoring === "union")).toBe(true);
    expect(union[0]!.interval.meanDifference).toBeLessThan(0);
    // Without per-requirement tables, no comparison of A7 or A7O is read on the headline.
    const old = records.map((r) => {
      if (r.kind !== "run") return r;
      const { pieces: _pieces, ...rest } = r;
      return rest;
    });
    expect(guardPairedDifferences(old, fixture, 1, "headline")).toEqual([]);
    expect(guardPairedDifferences(old, fixture, 1)).toHaveLength(3);
  });

  /** Paired intervals over committed records, as `[mean, low, high]` to 3 places. */
  async function committed(file: string, scoring: "headline" | "union") {
    const text = await readFile(path.join(import.meta.dirname, "__fixtures__", file), "utf8");
    const records = text
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map(parseGuardRecord);
    expect(records.every((r) => r.fingerprint.fixture === FINGERPRINT.fixture)).toBe(true);
    expect(records.every((r) => r.fingerprint.repository === FINGERPRINT.repository)).toBe(true);
    return {
      records,
      read: guardPairedDifferences(records, fixture, 3, scoring).map((d) => {
        const { meanDifference, ci } = d.interval;
        return [meanDifference, ...ci].map((x) => x.toFixed(3));
      }),
    };
  }

  it("#1848 — reads the 2026-11-06 Sonnet records: on its first persisted requirement the analysis path raises table precision", async () => {
    const file = "table-guard-sonnet-2026-11-06-pieces.runs.jsonl";
    const headline = await committed(file, "headline");
    expect(new Set(headline.records.map((r) => r.model))).toEqual(
      new Set(["anthropic/claude-sonnet-5-5"]),
    );
    // A7 − A0 (split), A7O − A0 (split), A7 − A7O.
    expect(headline.read).toEqual([
      ["0.175", "0.073", "0.276"],
      ["0.146", "0.042", "0.250"],
      ["0.029", "-0.052", "0.109"],
    ]);
    // The union of every persisted requirement: #1823's reading, reproduced.
    expect((await committed(file, "union")).read).toEqual([
      ["-0.190", "-0.266", "-0.113"],
      ["-0.184", "-0.275", "-0.093"],
      ["-0.006", "-0.040", "0.028"],
    ]);
  });

  it("#1848 — reads the 2026-11-06 DeepSeek records the same way", async () => {
    const file = "table-guard-deepseek-2026-11-06-pieces.runs.jsonl";
    const headline = await committed(file, "headline");
    expect(new Set(headline.records.map((r) => r.model))).toEqual(
      new Set(["anthropic/deepseek-flash"]),
    );
    expect(headline.read).toEqual([
      ["0.063", "-0.106", "0.231"],
      ["0.174", "0.010", "0.338"],
      ["-0.112", "-0.227", "0.004"],
    ]);
    expect((await committed(file, "union")).read).toEqual([
      ["-0.124", "-0.272", "0.023"],
      ["-0.119", "-0.291", "0.053"],
      ["-0.005", "-0.050", "0.040"],
    ]);
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
    // #1823 — A7's reading takes A7O's runs too (its control): every comparison is complete,
    // #1848 — under both scorings, the analysis's first persisted requirement first.
    await guard.A7();
    expect(lines.filter((l) => l.includes("paired over"))).toHaveLength(6);
    await guard.A7O();
    const paired = lines.filter((l) => l.includes("paired over"));
    expect(paired).toHaveLength(6);
    const interval = String.raw`[+−]\d\.\d{3} \[[+−]\d\.\d{3}, [+−]\d\.\d{3}\] \(95% t-interval\)$`;
    expect(paired[2]).toMatch(
      new RegExp(
        String.raw`^table guard: A7 − A7O, the analysis's first persisted requirement, paired over 11 requirements \(mean of 2 runs each\): ${interval}`,
      ),
    );
    expect(paired[5]).toMatch(
      new RegExp(
        String.raw`^table guard: A7 − A7O, every persisted requirement unioned, paired over 11 requirements \(mean of 2 runs each\): ${interval}`,
      ),
    );
    // A run's own line names both readings.
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^table guard: A7O run 1: table precision \d\.\d{3} \(every persisted requirement unioned\); \d\.\d{3} \(the analysis's first persisted requirement\)$/,
      ),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(/^table guard: baseline run 1: table precision \d\.\d{3}$/),
    );
  });
});

describe("#1848 — the analysis's first persisted requirement, not the union of all", () => {
  const order = fixture.requirements.find(
    (r) => r.text === "Store a shipping method on each order",
  )!;
  const precision = (expected: string[], found: string[]) =>
    scoreSet(found, expected, normalizeTable).precision;
  const runOf = (store: { records: GuardRecord[] }, reading: string, n = 1) => {
    const r = store.records.find((x) => x.kind === "run" && x.reading === reading && x.run === n);
    if (r?.kind !== "run") throw new Error(`no ${reading} run ${n}`);
    return r;
  };

  it("records each persisted requirement's own tables and scores the first one against the label", async () => {
    const store = memoryStore();
    // The product update's analysis also persists the order requirement: a
    // further requirement with tables of its own, as an elicited NFR does.
    const { deps } = fakes({ alsoFor: { text: CITED.text, also: order.text } });
    const guard = createAgentSeedGuard({ ...deps, store });
    const a7o = await guard.A7O();
    const a7 = await guard.A7();
    if (!a7o.measured || !a7.measured) throw new Error("both readings should be measured");

    const base = runOf(store, "baseline");
    const run = runOf(store, "A7O");
    const pieces = run.pieces![CITED.id]!;
    expect(pieces.map((p) => p.title)).toEqual([CITED.text, order.text]);
    expect(pieces[0]!.requirementId).toMatch(/^pr-\d+$/);
    expect(pieces[1]!.requirementId).toMatch(/^pr-\d+-b$/);
    expect([...pieces[0]!.tables].sort()).toEqual([...base.tables[CITED.id]!].sort());
    expect([...pieces[1]!.tables].sort()).toEqual([...base.tables[order.id]!].sort());
    // The union adds the order requirement's tables to the product label …
    expect(run.tables[CITED.id]).toEqual(
      [...new Set([...pieces[0]!.tables, ...pieces[1]!.tables])].sort(),
    );
    expect(precision(CITED.expectedTables, run.tables[CITED.id]!)).toBeLessThan(
      precision(CITED.expectedTables, pieces[0]!.tables),
    );
    // … the first persisted requirement is the fixture's text here: A0 on the split seeding.
    expect(a7o.tablePrecision).toBeCloseTo(a7o.baseline!.tablePrecision, 10);
    const unioned = (run1: GuardRunRecord, run2: GuardRunRecord) =>
      (run1.tablePrecision + run2.tablePrecision) / 2;
    const union = unioned(run, runOf(store, "A7O", 2));
    expect(union).toBeLessThan(a7o.tablePrecision);
    expect(a7o.configuration).toContain(
      `scored on the analysis's first persisted requirement (#1848); every persisted requirement unioned: ${union.toFixed(3)}`,
    );
    // A7's control is read the same way.
    expect(a7.baseline).toMatchObject({ arm: "A7O", tablePrecision: a7o.tablePrecision });
    expect(a7.tablePrecision).toBeLessThan(a7o.tablePrecision);
    // Each analysis still contributes one change per persisted requirement.
    expect(Object.values(run.pieces!).flat()).toHaveLength(fixture.requirements.length + 1);
  });

  it("reads A7 and A7O runs recorded before #1848 on the union, as recorded", async () => {
    const store = memoryStore();
    const { deps } = fakes({ alsoFor: { text: CITED.text, also: order.text } });
    const first = await createAgentSeedGuard({ ...deps, store }).A7();
    if (!first.measured) throw new Error("should be measured");
    // The same records without their per-requirement tables.
    const old = store.records.map((r) => {
      if (r.kind !== "run") return r;
      const { pieces: _pieces, ...rest } = r;
      return rest;
    });
    const again = await createAgentSeedGuard({ ...deps, store: memoryStore(old) }).A7();
    if (!again.measured) throw new Error("should be measured");
    const recorded = (reading: string) =>
      (runOf({ records: old }, reading, 1).tablePrecision +
        runOf({ records: old }, reading, 2).tablePrecision) /
      2;
    expect(again.tablePrecision).toBeCloseTo(recorded("A7"), 10);
    expect(again.baseline!.tablePrecision).toBeCloseTo(recorded("A7O"), 10);
    expect(again.configuration).toContain("scored on every persisted requirement unioned;");
    expect(again.configuration).not.toContain("(#1848)");
    // With them, the headline differs from the union.
    expect(first.baseline!.tablePrecision).toBeGreaterThan(recorded("A7O"));
  });

  it("refuses an A7 run whose stored-citation lookup failed, rather than recording A7O under A7's name", async () => {
    const store = memoryStore();
    const { deps } = fakes();
    const reading = createAgentSeedGuard({
      ...deps,
      store,
      loadCitations: async () => {
        throw new Error("The column `main.requirement_code_mappings.freshness` does not exist");
      },
    }).A7();
    await expect(reading).rejects.toThrow(
      "A7 run 1: a stored-citation lookup failed, so the run would read as A7O; nothing recorded. " +
        "If the eval database predates a migration, run pnpm eval:materialize impact-recall-01-jpetstore to migrate it. " +
        "The lookup's error: The column `main.requirement_code_mappings.freshness` does not exist",
    );
    expect(store.records.filter((r) => r.kind === "run" && r.reading === "A7")).toEqual([]);
    expect(store.records.filter((r) => r.kind === "run" && r.reading === "A7O")).toHaveLength(2);
  });

  it("refuses an A7 run whose symbol-name lookup failed", async () => {
    const { deps } = fakes();
    await expect(
      createAgentSeedGuard({
        ...deps,
        store: memoryStore(),
        qualifiedNames: async () => {
          throw "database is locked";
        },
      }).A7(),
    ).rejects.toThrow(/stored-citation lookup failed.*The lookup's error: database is locked$/);
  });

  describe("guardRunTables and guardScoringOf", () => {
    const record = (
      reading: GuardRunRecord["reading"],
      pieces?: GuardRunRecord["pieces"],
    ): GuardRunRecord => ({
      kind: "run",
      reading,
      run: 1,
      model: MODEL,
      fingerprint: FINGERPRINT,
      tablePrecision: 0,
      tables: { "REQ-01": ["item", "product"] },
      label: "l",
      seeding: "s",
      changes: 2,
      untracked: 0,
      ...(pieces ? { pieces } : {}),
    });
    const pieces = {
      "REQ-01": [
        { requirementId: "pr-1", title: "headline", tables: ["product"] },
        { requirementId: "pr-2", title: "nfr", tables: ["item"] },
      ],
    };

    it.each(["A7", "A7O"] as const)("reads %s's first persisted requirement, or its union", (r) => {
      expect(guardRunTables(record(r, pieces), "REQ-01", "headline")).toEqual(["product"]);
      expect(guardRunTables(record(r, pieces), "REQ-01", "union")).toEqual(["item", "product"]);
      expect(guardRunTables(record(r, pieces), "REQ-02", "union")).toEqual([]);
      // Recorded before #1848: no headline to read.
      expect(guardRunTables(record(r), "REQ-01", "headline")).toBeNull();
      expect(guardRunTables(record(r, pieces), "REQ-02", "headline")).toBeNull();
      expect(guardRunTables(record(r, { "REQ-01": [] }), "REQ-01", "headline")).toEqual([]);
    });

    it.each(["baseline", "mapper"] as const)("reads %s's own tables either way", (r) => {
      expect(guardRunTables(record(r), "REQ-01", "headline")).toEqual(["item", "product"]);
      expect(guardRunTables(record(r), "REQ-01", "union")).toEqual(["item", "product"]);
    });

    it("scores the headline only when every run recorded its per-requirement tables", () => {
      expect(guardScoringOf([record("A7", pieces), record("A7O", pieces)])).toBe("headline");
      expect(guardScoringOf([record("A7", pieces), record("A7O")])).toBe("union");
      expect(guardScoringOf([record("A7O")])).toBe("union");
    });
  });
});

describe("A7's staleness readings on the table guard (#1834)", () => {
  const ORDER_XML = "src/main/resources/org/mybatis/jpetstore/mapper/OrderMapper.xml";

  /**
   * The patch cycle: while a requirement's patch is applied, the product
   * update's citation of the order INSERT reads as re-validation left it.
   */
  function staleFakes(
    patched: Partial<StoredLinkRow> | null,
    ops: (requirementId: string) => StalenessOp[] = () => [
      {
        op: "edit",
        repo: "jpetstore",
        file: ORDER_XML,
        symbol: "insertOrder",
        afterLine: 30,
        text: "<!-- x -->",
      },
    ],
    digest = "patches-1",
    fakeOpts: Parameters<typeof fakes>[0] = {},
  ) {
    const f = fakes(fakeOpts);
    let applied = false;
    const cycles: string[] = [];
    const base = f.deps.loadCitations;
    const staleness: GuardStaleness = {
      patchSetDigest: digest,
      opsFor: ops,
      withPatch: async (o, read) => {
        cycles.push(o.map((x) => x.op).join(","));
        applied = true;
        try {
          return await read();
        } finally {
          applied = false;
        }
      },
    };
    const loadCitations = async (requirementId: string): Promise<StoredLinkRow[]> => {
      const links = await base(requirementId);
      return applied && patched ? links.map((l) => ({ ...l, ...patched })) : links;
    };
    return { deps: { ...f.deps, loadCitations, staleness }, cycles };
  }

  const tablesOf = (store: { records: GuardRecord[] }, reading: string, run = 1) => {
    const r = store.records.find((x) => x.kind === "run" && x.reading === reading && x.run === run);
    return r?.kind === "run" ? r.tables[CITED.id] : undefined;
  };

  it("A7S still leads with a stale citation; A7SD sets it aside; one cycle per requirement and run, after A7", async () => {
    const store = memoryStore();
    const { deps, cycles } = staleFakes({ freshness: "stale" });
    const guard = createAgentSeedGuard({ ...deps, store });
    const s = await guard.A7S();
    const sd = await guard.A7SD();
    if (!s.measured || !sd.measured) throw new Error("both readings should be measured");
    expect(cycles).toHaveLength(fixture.requirements.length * 2);
    expect(tablesOf(store, "A7S")).toContain("orders");
    expect(tablesOf(store, "A7SD")).not.toContain("orders");
    expect(sd.tablePrecision).toBeGreaterThan(s.tablePrecision);
    // A7S is gated against A7 (the same, unpatched: equal here), A7SD against A7S.
    expect(s.baseline).toMatchObject({ arm: "A7" });
    expect(s.tablePrecision).toBeCloseTo(s.baseline!.tablePrecision, 10);
    expect(sd.baseline).toMatchObject({ arm: "A7S", tablePrecision: s.tablePrecision });
    expect(sd.configuration).toContain(
      "staleness patches patches-1: after their re-ingest 2 stale, 0 moved",
    );
    expect(sd.configuration).toContain("2 set aside by the stage");
    expect(s.configuration).toContain("0 set aside by the stage");
    expect(s.seeding).toContain("the stage before #1832");
    expect(sd.seeding).toContain("stale citations demoted");
    // A7's runs were measured before any patch cycle; A7S and A7SD together, run by run.
    const order = store.records.flatMap((r) => (r.kind === "run" ? [`${r.reading} ${r.run}`] : []));
    expect(order.indexOf("A7 2")).toBeLessThan(order.indexOf("A7S 1"));
    expect(order.slice(-4)).toEqual(["A7S 1", "A7SD 1", "A7S 2", "A7SD 2"]);
    const rec = store.records.find((r) => r.kind === "run" && r.reading === "A7SD");
    expect(rec).toMatchObject({
      stalenessPatch: "patches-1",
      citationFreshness: { stale: 1, moved: 0, fresh: 0, unverified: 0, demoted: 1 },
    });
    expect(parseGuardRecord(JSON.stringify(rec))).toEqual(rec);
    // #1848 — read as A7 is: on the analysis's first persisted requirement.
    expect(sd.configuration).toContain("scored on the analysis's first persisted requirement");
    if (rec?.kind !== "run") throw new Error("a run record");
    expect(rec.pieces?.[CITED.id]?.length).toBeGreaterThan(0);
    expect(guardRunTables(rec, CITED.id, "headline")).toEqual(rec.pieces![CITED.id]![0]!.tables);
    expect(guardScoringOf([rec])).toBe("headline");
  });

  it("scores a staleness run on the analysis's first persisted requirement, as A7 is (#1848)", async () => {
    const store = memoryStore();
    // The product update's analysis persists a second requirement, about orders.
    const { deps } = staleFakes({ freshness: "fresh" }, undefined, "patches-1", {
      alsoFor: { text: CITED.text, also: "Store a shipping method on each order" },
    });
    await createAgentSeedGuard({ ...deps, store }).A7SD();
    const rec = store.records.find((r) => r.kind === "run" && r.reading === "A7SD");
    if (rec?.kind !== "run") throw new Error("a run record");
    const own = rec.pieces![CITED.id]!;
    expect(own).toHaveLength(2);
    expect(guardRunTables(rec, CITED.id, "headline")).toEqual(own[0]!.tables);
    expect(guardRunTables(rec, CITED.id, "union")).toEqual(rec.tables[CITED.id]);
    expect(own[0]!.tables).not.toEqual(rec.tables[CITED.id]);
  });

  it("reads a moved citation as the file it was, so it still leads with demotion", async () => {
    const store = memoryStore();
    const moved = ORDER_XML.replace(".xml", "_renamed.xml");
    // A file-level citation: it reaches the fixture by its path alone.
    const { deps } = staleFakes({ freshness: "moved", filePath: moved, codeSymbolId: null }, () => [
      { op: "rename", repo: "jpetstore", from: ORDER_XML, to: moved },
    ]);
    const guard = createAgentSeedGuard({ ...deps, store });
    await guard.A7SD();
    expect(tablesOf(store, "A7SD")).toContain("orders");
    expect(tablesOf(store, "A7S")).toContain("orders");
  });

  it("drops a citation of a deleted file with or without demotion: the graph no longer holds it", async () => {
    const store = memoryStore();
    const { deps } = staleFakes({ freshness: "stale" }, () => [
      { op: "delete", repo: "jpetstore", file: ORDER_XML },
    ]);
    const guard = createAgentSeedGuard({ ...deps, store });
    await guard.A7S();
    expect(tablesOf(store, "A7S")).not.toContain("orders");
    expect(tablesOf(store, "A7")).toContain("orders");
  });

  it("a deleted file leaves the search too: a requirement no citation names loses its tables", async () => {
    const PLACE = fixture.requirements.find((r) => r.text.startsWith("Place an order"))!;
    const store = memoryStore();
    const { deps } = staleFakes(null, (id) =>
      id === PLACE.id
        ? [
            { op: "delete", repo: "jpetstore", file: ORDER_XML },
            {
              op: "delete",
              repo: "jpetstore",
              file: "src/main/java/org/mybatis/jpetstore/mapper/OrderMapper.java",
            },
            {
              op: "delete",
              repo: "jpetstore",
              file: "src/main/java/org/mybatis/jpetstore/service/OrderService.java",
            },
          ]
        : [],
    );
    await createAgentSeedGuard({ ...deps, store }).A7S();
    const t = (reading: string) => {
      const r = store.records.find((x) => x.kind === "run" && x.reading === reading && x.run === 1);
      return r?.kind === "run" ? r.tables[PLACE.id] : undefined;
    };
    expect(t("A7")).toEqual(expect.arrayContaining(["orders", "lineitem"]));
    expect(t("A7S")).not.toContain("lineitem");
  });

  it("is not measured without the table corpus's patches", async () => {
    const guard = createAgentSeedGuard({ ...fakes().deps, store: memoryStore() });
    expect(await guard.A7S()).toEqual({
      measured: false,
      reason: expect.stringContaining("A7S needs the staleness patches"),
    });
    expect(await lazyAgentSeedGuard(async () => guard).A7SD()).toMatchObject({ measured: false });
  });

  it("refuses to resume staleness runs read under other patches, and resumes under the same", async () => {
    const store = memoryStore();
    const first = staleFakes({ freshness: "stale" });
    await createAgentSeedGuard({ ...first.deps, store }).A7SD();
    const other = staleFakes({ freshness: "stale" }, undefined, "patches-2");
    const refused = await createAgentSeedGuard({ ...other.deps, store })
      .A7SD()
      .catch((e: Error) => e);
    expect(String(refused)).toMatch(/read under staleness patches patches-1, not patches-2/);
    const same = staleFakes({ freshness: "stale" });
    const again = await createAgentSeedGuard({ ...same.deps, store }).A7SD();
    expect(again.measured).toBe(true);
    expect(same.cycles).toEqual([]);
  });

  it("pairs A7S with A7 and A7SD with A7S", async () => {
    const store = memoryStore();
    await createAgentSeedGuard({ ...staleFakes({ freshness: "stale" }).deps, store }).A7SD();
    const out = guardPairedDifferences(store.records, fixture, 2).map(
      (d) => `${d.arm} − ${d.baseline}`,
    );
    expect(out).toContain("A7S − A7");
    expect(out).toContain("A7SD − A7S");
  });
});
