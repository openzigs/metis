/**
 * #1823 — A7's table guard: analyses recorded one by one, impact runs on what
 * they persisted with and without the stored citations leading, against A0 on
 * the split seeding; resumable, bounded and capped.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { StoredLinkRow } from "../../impact-analysis/change-seeds.js";
import type { ChangedRequirement } from "../../impact-analysis/extract-changes.js";
import {
  loadImpactRecallFixture,
  recordedVectorsFile,
  resolveCorpusDir,
} from "../impact-recall/fixture.js";
import { runImpactRecallEval } from "../impact-recall/runner.js";
import { loadRecordedVectors } from "../recorded-vectors.js";
import { EmbedCache, buildCorpusSearch } from "./search.js";
import { fixtureSearchRows } from "./table-guard.js";
import {
  createAgentSeedGuard,
  fileGuardStore,
  guardRecordsFile,
  parseGuardRecord,
  type AgentSeedGuardDeps,
  type GuardRecord,
  type GuardStore,
} from "./table-guard-agent.js";
import { TABLE_GUARD_CORPUS } from "./table-guard-source.js";

const dir = resolveCorpusDir(TABLE_GUARD_CORPUS);
const fixture = await loadImpactRecallFixture(dir);
// The analyses' requirements here carry the fixture's own text, so the
// committed recording answers every query offline.
const search = await buildCorpusSearch(
  fixtureSearchRows(fixture),
  new EmbedCache(await loadRecordedVectors(recordedVectorsFile(dir)), null, "test"),
);
const MODEL = "anthropic/deepseek-flash";
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
 * table, which only the A7 lead can bring in.
 */
function fakes(opts: { emptyFor?: string; alsoFor?: { text: string; also: string } } = {}) {
  let spent = 0;
  let unpriced = 0;
  const analyzed: string[] = [];
  const persisted = new Map<string, string>(); // persisted id → fixture text
  const deps = {
    fixture,
    search,
    options: {},
    runs: 2,
    model: MODEL,
    analyze: async (text: string) => {
      analyzed.push(text);
      spent += 0.02;
      const n = analyzed.length;
      if (text === opts.emptyFor) return { analysisId: `an-${n}`, requirementIds: [] };
      persisted.set(`pr-${n}`, text);
      if (text === opts.alsoFor?.text) {
        persisted.set(`pr-${n}-b`, opts.alsoFor.also);
        return { analysisId: `an-${n}`, requirementIds: [`pr-${n}`, `pr-${n}-b`] };
      }
      return { analysisId: `an-${n}`, requirementIds: [`pr-${n}`] };
    },
    loadRequirementChanges: async (ids: readonly string[]): Promise<ChangedRequirement[]> =>
      ids.map((id) => ({
        requirementId: id,
        title: persisted.get(id)!,
        body: persisted.get(id)!,
        changeType: "added",
        bodyDelta: persisted.get(id)!.length,
      })),
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
  return { deps, analyzed, setUnpriced: () => (unpriced = 1) };
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
    // The product update's citation brings in the order table: precision drops.
    expect(a7.tablePrecision).toBeLessThan(a7o.tablePrecision);
    expect(a7).toMatchObject({ runs: 2, baseline: a7o.baseline });
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
      "A7 1",
      "A7 2",
      "A7O 1",
      "A7O 2",
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
    const first = fakes();
    const stopped = await createAgentSeedGuard({ ...first.deps, store, maxSteps: 5 }).A7();
    expect(stopped).toEqual({
      measured: false,
      reason: `5 of ${total} analyses and 0 reading run(s) recorded; stopped by the --guard-steps limit (5). Run the same --merge again to continue`,
    });
    expect(first.analyzed).toHaveLength(5);
    expect(store.records).toHaveLength(5);

    const second = fakes();
    const reading = await createAgentSeedGuard({ ...second.deps, store }).A7();
    expect(second.analyzed).toEqual(
      [...fixture.requirements, ...fixture.requirements].slice(5).map((r) => r.text),
    );
    expect(reading.measured).toBe(true);

    // A third call has every step: it runs nothing and reads the same.
    const third = fakes();
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
      analysisId: "an-1",
      requirementIds: [],
      costUsd: 0,
      seconds: 1,
    });
    await writeFile(file, `${await readFile(file, "utf8")}{"kind":"run","model":"m","run":1}\n`);
    await expect(fileGuardStore(file).read()).rejects.toThrow(/no reading/);
  });

  it.each([
    ['{"kind":"analysis","model":"m","run":0}', /no run/],
    ['{"kind":"analysis","run":1}', /no model/],
    [
      '{"kind":"analysis","model":"m","run":1,"analysisId":"a","requirementIds":[]}',
      /no requirement$/,
    ],
    [
      '{"kind":"analysis","model":"m","run":1,"requirement":"R","requirementIds":[]}',
      /no analysisId/,
    ],
    [
      '{"kind":"analysis","model":"m","run":1,"requirement":"R","analysisId":"a","requirementIds":[1]}',
      /no requirementIds/,
    ],
    [
      '{"kind":"analysis","model":"m","run":1,"requirement":"R","analysisId":"a","requirementIds":[],"costUsd":"1"}',
      /no costUsd/,
    ],
    [
      '{"kind":"analysis","model":"m","run":1,"requirement":"R","analysisId":"a","requirementIds":[],"costUsd":1}',
      /no seconds/,
    ],
    ['{"kind":"run","model":"m","run":1,"reading":"A9"}', /no reading/],
    ['{"kind":"run","model":"m","run":1,"reading":"A7"}', /no tablePrecision/],
    ['{"kind":"run","model":"m","run":1,"reading":"A7","tablePrecision":1}', /no tables/],
    [
      '{"kind":"run","model":"m","run":1,"reading":"A7","tablePrecision":1,"tables":{}}',
      /no configuration/,
    ],
    [
      '{"kind":"run","model":"m","run":1,"reading":"A7","tablePrecision":1,"tables":{},"label":"l","seeding":"s"}',
      /no change counts/,
    ],
    ['{"kind":"other","model":"m","run":1}', /unknown kind/],
    ["null", /not an object/],
  ])("parseGuardRecord refuses %s", (line, error) => {
    expect(() => parseGuardRecord(line)).toThrow(error);
  });
});
