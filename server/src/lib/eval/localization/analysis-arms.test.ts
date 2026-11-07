import { describe, expect, it, vi } from "vitest";
import type { StoredLinkRow } from "../../impact-analysis/change-seeds.js";
import type { ChangedRequirement } from "../../impact-analysis/extract-changes.js";
import { ANALYSIS_ARMS } from "./agent-env.js";
import {
  ANALYSIS_ARM_IDS,
  ANALYSIS_PASS_GROUP,
  ANALYSIS_VARIANTS,
  createA7Arm,
  createA7KArm,
  createA7OArm,
  createA7RArm,
  createA7RDArm,
  createA7SArm,
  createA7SDArm,
  NOOP_REINGEST_ARM_IDS,
  PATCH_ARM_IDS,
  STALENESS_ARM_IDS,
  UNPATCHED_CITATION_ARM_IDS,
} from "./analysis-arms.js";
import type { AnalysisArmIO, AnalysisPassRequest, StalenessArmIO } from "./arm-core.js";
import type { StalenessOp } from "./staleness.js";
import { buildArms, MODEL_ARMS } from "./arms.js";
import type { CostMeter } from "./cost.js";
import type { CorpusSearch } from "./search.js";

// Three files in each of two repositories. Every query finds a.go strongly and
// b.go weakly, so the hybrid edit cut keeps a.go only; c.go is in the graph and
// no query finds it, so only a stored citation can put it among the files.
const rows = ["r", "s"].flatMap((repo) =>
  ["a", "b", "c"].map((n) => ({
    id: `${repo}#${n}`,
    repo,
    name: n,
    qualifiedName: `${n}.go::${n}`,
    kind: "function",
    language: "go",
    filePath: `${n}.go`,
    startLine: 1,
    endLine: 9,
  })),
);
function searchSpy() {
  const queries: string[] = [];
  const search: CorpusSearch = {
    searcher: {
      search: async (q, repo) => {
        queries.push(q);
        return [
          { symbolId: `${repo}#a`, filePath: "a.go", name: "a", kind: "function", score: 1 },
          { symbolId: `${repo}#b`, filePath: "b.go", name: "b", kind: "function", score: 0.3 },
        ];
      },
    },
    loadSymbols: async (ids) =>
      rows.filter((r) => ids.includes(r.id)).map((r) => ({ ...r, signature: null })),
    loadWriterIds: async () => new Set<string>(),
    embeddingModel: "toy",
    symbolsDigest: "toy",
  };
  return { search, queries };
}
const corpusOf = (repos: string[]) =>
  ({
    name: "toy-corpus",
    manifest: { repos: repos.map((name) => ({ name })) },
    symbols: rows.filter((r) => repos.includes(r.repo)),
    graphFiles: new Set(
      rows.filter((r) => repos.includes(r.repo)).map((r) => `${r.repo}:${r.filePath}`),
    ),
  }) as unknown as Parameters<ReturnType<typeof createA7Arm>["localize"]>[1];
const item = { id: "I-1", title: "Change the order total", text: "Body." } as never;

/** The analysis model: the arm names it, so a resume on another model is refused. */
const provider = { key: "anthropic", model: "claude-sonnet-5-5" } as never;

function fakeMeter(): CostMeter & { charge(usd: number, unpriced?: boolean): void } {
  let spent = 0;
  let unpriced = 0;
  return {
    spentUsd: () => spent,
    unpricedCalls: () => unpriced,
    charge(usd, isUnpriced = false) {
      spent += usd;
      if (isUnpriced) unpriced++;
    },
  };
}

const link = (filePath: string, confidence = 0.6, freshness?: string): StoredLinkRow => ({
  codeSymbolId: null,
  filePath,
  startLine: null,
  endLine: null,
  confidence,
  source: "analysis-grounding",
  ...(freshness ? { freshness } : {}),
});

/**
 * A stub "Evaluate new requirements": each repository's analysis persists the
 * given requirements, each with its stored citations in that repository.
 */
function stubIO(
  meter: ReturnType<typeof fakeMeter>,
  persisted: Record<string, Array<{ id: string; title: string; links: StoredLinkRow[] }>>,
  opts: { perPass?: number; fail?: boolean } = {},
) {
  let analyses = 0;
  const pass = vi.fn(async (req: AnalysisPassRequest) => {
    meter.charge(opts.perPass ?? 0.05);
    if (opts.fail) throw new Error("analysis an-x ended failed: provider down");
    analyses++;
    return {
      analysisId: `an-${req.repo}-${analyses}`,
      status: "completed",
      requirementIds: (persisted[req.repo] ?? []).map((r) => r.id),
    };
  });
  const all = Object.entries(persisted).flatMap(([repo, reqs]) =>
    reqs.map((r) => ({ ...r, repo })),
  );
  const io: AnalysisArmIO = {
    pass,
    loadRequirementChanges: vi.fn(async (ids: readonly string[]) =>
      ids.flatMap((id): ChangedRequirement[] => {
        const r = all.find((x) => x.id === id);
        return r
          ? [
              {
                requirementId: r.id,
                title: r.title,
                body: `${r.title}.`,
                changeType: "modified",
                bodyDelta: 10,
              },
            ]
          : [];
      }),
    ),
    // Project-scoped, as production's read: a requirement's links live in its repository.
    loadCitations: vi.fn(async (requirementId: string, _corpus: string, repo: string) =>
      all.filter((r) => r.id === requirementId && r.repo === repo).flatMap((r) => r.links),
    ),
  };
  return { io, pass };
}

describe("A7 arms (#1818)", () => {
  it("refuse to run without the analysis IO, a meter and a provider, and are model arms", () => {
    const { search } = searchSpy();
    expect(() => createA7Arm({ search })).toThrow(/A7 runs "Evaluate new requirements"/);
    expect(() => createA7OArm({ search, meter: fakeMeter(), provider })).toThrow(/A7O runs/);
    expect(() => buildArms(["A0", "A7"], { search })).toThrow(/A7 runs/);
    expect(MODEL_ARMS.has("A7")).toBe(true);
    expect(MODEL_ARMS.has("A7O")).toBe(true);
  });

  it("are the analysis arms the CLI binds the materialized database for", () => {
    expect([...ANALYSIS_ARM_IDS].sort()).toEqual([...ANALYSIS_ARMS].sort());
    expect(Object.keys(ANALYSIS_VARIANTS)).toEqual([...ANALYSIS_ARMS]);
  });

  it("A7 leads with the stored citation; A7O, the same analysis with the flag off, does not", async () => {
    const { search } = searchSpy();
    const meter = fakeMeter();
    const { io, pass } = stubIO(meter, {
      r: [{ id: "req-1", title: "Order total", links: [link("c.go")] }],
    });
    const deps = { search, analysis: io, meter, provider };
    const [a7, a7o] = [createA7Arm(deps), createA7OArm(deps)];
    const corpus = corpusOf(["r"]);
    const on = await a7.localize(item, corpus, { run: 1 });
    const off = await a7o.localize(item, corpus, { run: 1 });
    expect(on.editCandidateFiles).toEqual(["r:c.go", "r:a.go"]);
    expect(on.llmNamedFiles).toEqual(["r:c.go"]);
    expect(off.editCandidateFiles).toEqual(["r:a.go"]);
    expect(off.llmNamedFiles).toBeUndefined();
    // One analysis, read twice: the second reading reports its cost as its own.
    expect(pass).toHaveBeenCalledTimes(1);
    expect(pass).toHaveBeenCalledWith({
      corpus: "toy-corpus",
      repo: "r",
      text: "Change the order total\n\nBody.",
    });
    expect(on.reusedCostUsd).toBeUndefined();
    expect(off.reusedCostUsd).toBeCloseTo(0.05);
    expect(off.agent!.passIds).toEqual(on.agent!.passIds);
    expect(on.agent).toMatchObject({
      passes: 1,
      unanswered: 0,
      citedFiles: 1,
      unresolvedFiles: 0,
      passGroup: ANALYSIS_PASS_GROUP,
    });
  });

  it("seeds each persisted requirement's own text, one change per requirement", async () => {
    const { search, queries } = searchSpy();
    const meter = fakeMeter();
    const { io } = stubIO(meter, {
      r: [
        { id: "req-1", title: "Recompute the order total", links: [] },
        { id: "req-2", title: "Show the total on the receipt", links: [] },
      ],
    });
    await createA7Arm({ search, analysis: io, meter, provider }).localize(item, corpusOf(["r"]));
    expect(io.loadRequirementChanges).toHaveBeenCalledWith(["req-1", "req-2"]);
    expect(queries.some((q) => q.includes("Recompute the order total"))).toBe(true);
    expect(queries.some((q) => q.includes("Show the total on the receipt"))).toBe(true);
    expect(queries.some((q) => q.includes("Change the order total"))).toBe(false);
  });

  it("reads the pasted text when the analysis persisted no requirement, and counts it", async () => {
    const { search, queries } = searchSpy();
    const meter = fakeMeter();
    const { io } = stubIO(meter, { r: [] });
    const out = await createA7Arm({ search, analysis: io, meter, provider }).localize(
      item,
      corpusOf(["r"]),
    );
    expect(queries.some((q) => q.includes("Change the order total"))).toBe(true);
    expect(out.editCandidateFiles).toEqual(["r:a.go"]);
    expect(out.agent).toMatchObject({ passes: 1, unanswered: 1, citedFiles: 0 });
  });

  it("leads only in the requirement's own repository, and counts a cited file the graph lacks", async () => {
    const { search } = searchSpy();
    const meter = fakeMeter();
    const { io, pass } = stubIO(meter, {
      r: [{ id: "req-r", title: "Order total", links: [link("c.go"), link("gone.go")] }],
      s: [],
    });
    const out = await createA7Arm({ search, analysis: io, meter, provider }).localize(
      item,
      corpusOf(["r", "s"]),
    );
    // One analysis per repository; the change is seeded in both, and leads in r only.
    expect(pass).toHaveBeenCalledTimes(2);
    expect(out.editCandidateFiles).toEqual(["r:c.go", "s:a.go", "r:a.go"]);
    expect(out.agent).toMatchObject({
      passes: 2,
      unanswered: 1,
      citedFiles: 2,
      unresolvedFiles: 1,
    });
  });

  it("runs a new analysis for each run, and runs a failed one again", async () => {
    const { search } = searchSpy();
    const meter = fakeMeter();
    const { io, pass } = stubIO(meter, { r: [{ id: "req-1", title: "T", links: [] }] });
    const arm = createA7Arm({ search, analysis: io, meter, provider });
    await arm.localize(item, corpusOf(["r"]), { run: 1 });
    await arm.localize(item, corpusOf(["r"]), { run: 2 });
    expect(pass).toHaveBeenCalledTimes(2);

    const failing = stubIO(meter, {}, { fail: true });
    const deps = { search, analysis: failing.io, meter, provider };
    await expect(createA7Arm(deps).localize(item, corpusOf(["r"]))).rejects.toThrow(/ended failed/);
    await expect(createA7OArm(deps).localize(item, corpusOf(["r"]))).rejects.toThrow(
      /ended failed/,
    );
    expect(failing.pass).toHaveBeenCalledTimes(2);
  });

  it("names the analysis model in the configuration, so a resume on another model is refused", () => {
    const { search } = searchSpy();
    const meter = fakeMeter();
    const { io } = stubIO(meter, {});
    const arm = createA7Arm({ search, analysis: io, meter, provider });
    expect(arm.configuration).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      llm: true,
    });
    expect(arm.label).toContain("IMPACT_AGENT_SEEDS on");
    expect(createA7OArm({ search, analysis: io, meter, provider }).label).toContain(
      "IMPACT_AGENT_SEEDS off",
    );
  });
});

/**
 * A search over the given rows: every query finds the `strong` names' symbols
 * strongly (in that order) and the others weakly, each at the file its row says.
 */
function searchOver(over: typeof rows, strong: readonly string[]): CorpusSearch {
  return {
    searcher: {
      search: async (_q, repo) =>
        over
          .filter((r) => r.repo === repo)
          .map((r) => ({
            symbolId: r.id,
            filePath: r.filePath,
            name: r.name,
            kind: "function",
            score: strong.includes(r.name) ? 1 - strong.indexOf(r.name) * 0.01 : 0.3,
          }))
          .sort((x, y) => y.score - x.score),
    },
    loadSymbols: async (ids) =>
      over.filter((r) => ids.includes(r.id)).map((r) => ({ ...r, signature: null })),
    loadWriterIds: async () => new Set<string>(),
    embeddingModel: "toy",
    symbolsDigest: "toy",
  };
}

describe("A7 staleness arms (#1834)", () => {
  // The item's patch: c.go's function edited (its citation goes stale), b.go
  // renamed (its citation moves with it), a.go deleted.
  const ops: StalenessOp[] = [
    { op: "edit", repo: "r", file: "c.go", symbol: "c.go::c", afterLine: 1, text: "// x" },
    { op: "rename", repo: "r", from: "b.go", to: "b_renamed.go" },
  ];

  /** One analysis in r whose citations re-validation rewrites while the patch is applied. */
  function staleFixture(opts: { failRead?: boolean; strong?: string[] } = {}) {
    const meter = fakeMeter();
    let patched = false;
    // #1899 — after a no-op re-ingest, re-validation finds c.go's symbol in another file
    // (`moved`; line drift within a file would be `fresh`, #1925) and b.go fresh.
    let reingested = false;
    const pass = vi.fn(async () => {
      meter.charge(0.05);
      return { analysisId: "an-1", status: "completed", requirementIds: ["req-1"] };
    });
    const loadCitations = vi.fn(async (): Promise<StoredLinkRow[]> =>
      patched
        ? [link("c.go", 0.9, "stale"), link("b_renamed.go", 0.5, "moved")]
        : reingested
          ? [link("c.go", 0.9, "moved"), link("b.go", 0.5, "fresh")]
          : [link("c.go", 0.9, "unverified"), link("b.go", 0.5, "unverified")],
    );
    const io: AnalysisArmIO = {
      pass,
      loadRequirementChanges: vi.fn(async () => [
        {
          requirementId: "req-1",
          title: "Order total",
          body: "Order total.",
          changeType: "modified" as const,
          bodyDelta: 10,
        },
      ]),
      loadCitations,
    };
    const withPatch = vi.fn(
      async <T>(_corpus: string, _ops: readonly StalenessOp[], read: () => Promise<T>) => {
        patched = true;
        try {
          if (opts.failRead) throw new Error("re-ingest failed");
          return await read();
        } finally {
          patched = false;
        }
      },
    );
    const searchFor = vi.fn(async (patchedRows: readonly unknown[]) =>
      searchOver(patchedRows as typeof rows, opts.strong ?? ["a"]),
    );
    const withReingest = vi.fn(async <T>(_corpus: string, read: () => Promise<T>) => {
      reingested = true;
      return read();
    });
    const staleness: StalenessArmIO = {
      patchSetDigest: "patches-1",
      opsFor: vi.fn(() => ops),
      withPatch: withPatch as unknown as StalenessArmIO["withPatch"],
      withReingest: withReingest as unknown as StalenessArmIO["withReingest"],
      searchFor,
    };
    const search = searchOver(rows, opts.strong ?? ["a"]);
    return {
      deps: { search, analysis: io, meter, provider, staleness },
      pass,
      withPatch,
      withReingest,
      staleness,
      searchFor,
    };
  }

  it("are model and analysis arms; a staleness arm refuses to run without the cycle", () => {
    for (const id of ["A7K", "A7S", "A7SD", "A7R", "A7RD"]) {
      expect(MODEL_ARMS.has(id)).toBe(true);
      expect(ANALYSIS_ARM_IDS.has(id)).toBe(true);
    }
    expect([...STALENESS_ARM_IDS]).toEqual(["A7S", "A7SD", "A7R", "A7RD"]);
    expect([...NOOP_REINGEST_ARM_IDS]).toEqual(["A7R", "A7RD"]);
    // #1925 — only these need a patch set (and, under --table-guard, the table corpus).
    expect([...PATCH_ARM_IDS]).toEqual(["A7S", "A7SD"]);
    expect([...UNPATCHED_CITATION_ARM_IDS]).toEqual(["A7", "A7K"]);
    const { search } = searchSpy();
    const meter = fakeMeter();
    const { io } = stubIO(meter, {});
    expect(() => createA7SArm({ search, analysis: io, meter, provider })).toThrow(
      /A7S reads after a committed staleness patch/,
    );
    expect(() => createA7SDArm({ search, analysis: io, meter, provider })).toThrow(/A7SD/);
    expect(() => createA7RArm({ search, analysis: io, meter, provider })).toThrow(/A7R reads/);
    expect(() => createA7KArm({ search, analysis: io, meter, provider })).not.toThrow();
  });

  it("buildArms refuses an unpatched citation arm after a staleness arm", () => {
    const { deps } = staleFixture();
    expect(() => buildArms(["A0", "A7S", "A7"], deps)).toThrow(
      /A7 reads the stored citations unpatched/,
    );
    expect(() => buildArms(["A0", "A7SD", "A7K"], deps)).toThrow(/A7K .* before A7SD/);
    expect(buildArms(["A0", "A7", "A7K", "A7O", "A7S", "A7SD"], deps).map((a) => a.id)).toEqual([
      "A0",
      "A7",
      "A7K",
      "A7O",
      "A7S",
      "A7SD",
    ]);
    // A7O reads no citation: it may come after.
    expect(() => buildArms(["A0", "A7S", "A7O"], deps)).not.toThrow();
  });

  it("buildArms (#1899): A7 before the no-op re-ingest arms, and those before the patch arms", () => {
    const { deps } = staleFixture();
    expect(() => buildArms(["A0", "A7R", "A7"], deps)).toThrow(
      /A7 reads the stored citations unpatched, so it must come before A7R/,
    );
    expect(() => buildArms(["A0", "A7S", "A7RD"], deps)).toThrow(
      "--arms: A7RD reads after a no-op re-ingest, so it must come before A7S: a patch cycle's restore leaves a citation moved back",
    );
    expect(buildArms(["A0", "A7", "A7R", "A7RD", "A7S", "A7SD"], deps).map((a) => a.id)).toEqual([
      "A0",
      "A7",
      "A7R",
      "A7RD",
      "A7S",
      "A7SD",
    ]);
  });

  it("A7S leads with the stale citation; A7SD sets it aside; both read ONE patch cycle and the shared analysis", async () => {
    const f = staleFixture();
    const corpus = corpusOf(["r"]);
    const keep = await createA7SArm(f.deps).localize(item, corpus, { run: 1 });
    const demote = await createA7SDArm(f.deps).localize(item, corpus, { run: 1 });
    expect(f.pass).toHaveBeenCalledTimes(1);
    expect(f.withPatch).toHaveBeenCalledTimes(1);
    expect(f.withPatch.mock.calls[0]![0]).toBe("toy-corpus");
    expect(f.withPatch.mock.calls[0]![1]).toBe(ops);
    expect(f.staleness.opsFor).toHaveBeenCalledWith("toy-corpus", "I-1");
    // The moved citation leads at its new path and is scored as the file it was.
    expect(keep.editCandidateFiles).toEqual(["r:c.go", "r:b.go", "r:a.go"]);
    expect(keep.llmNamedFiles).toEqual(["r:c.go", "r:b.go"]);
    // #1899 — Recall@k and MRR read rankedFiles: the renamed file is scored as the file it was.
    expect(keep.rankedFiles.slice(0, 3)).toEqual(["r:c.go", "r:b.go", "r:a.go"]);
    expect(demote.rankedFiles[0]).toBe("r:b.go");
    for (const out of [keep, demote]) {
      expect(out.rankedFiles.some((f) => f.includes("b_renamed"))).toBe(false);
    }
    expect(demote.editCandidateFiles).toEqual(["r:b.go", "r:a.go"]);
    expect(demote.llmNamedFiles).toEqual(["r:b.go"]);
    expect(keep.agent!.citationFreshness).toEqual({
      fresh: 0,
      moved: 1,
      stale: 1,
      unverified: 0,
      demoted: 0,
    });
    expect(demote.agent!.citationFreshness).toMatchObject({ stale: 1, moved: 1, demoted: 1 });
    // Both cited files are in the patched graph (b_renamed.go is b.go moved).
    expect(keep.agent).toMatchObject({ citedFiles: 2, unresolvedFiles: 0, passIds: ["an-1"] });
    // The first reading paid for the analysis; the second reports it, and the cycle, as its own.
    expect(keep.reusedCostUsd).toBeUndefined();
    expect(demote.reusedCostUsd).toBeCloseTo(0.05);
    expect(demote.reusedSeconds).toBeGreaterThanOrEqual(0);
  });

  it("A7R and A7RD (#1899) read ONE no-op re-ingest: no patch, and demotion's tier sort can reorder", async () => {
    const f = staleFixture();
    const corpus = corpusOf(["r"]);
    const keep = await createA7RArm(f.deps).localize(item, corpus, { run: 1 });
    const demote = await createA7RDArm(f.deps).localize(item, corpus, { run: 1 });
    expect(f.withReingest).toHaveBeenCalledTimes(1);
    expect(f.withReingest.mock.calls[0]![0]).toBe("toy-corpus");
    expect(f.withPatch).not.toHaveBeenCalled();
    expect(f.staleness.opsFor).not.toHaveBeenCalled();
    expect(f.searchFor).not.toHaveBeenCalled();
    // Freshness hidden: confidence order, c.go (0.9) then b.go. With it, fresh b.go before moved c.go.
    expect(keep.editCandidateFiles).toEqual(["r:c.go", "r:b.go", "r:a.go"]);
    expect(demote.editCandidateFiles).toEqual(["r:b.go", "r:c.go", "r:a.go"]);
    expect(demote.rankedFiles.slice(0, 3)).toEqual(["r:b.go", "r:c.go", "r:a.go"]);
    for (const out of [keep, demote]) {
      expect(out.agent!.citationFreshness).toEqual({
        fresh: 1,
        moved: 1,
        stale: 0,
        unverified: 0,
        demoted: 0,
      });
    }
    expect(demote.reusedCostUsd).toBeCloseTo(0.05);
    // A patch arm of the same item and run reads a cycle of its own.
    await createA7SArm(f.deps).localize(item, corpus, { run: 1 });
    expect(f.withPatch).toHaveBeenCalledTimes(1);
    expect(f.withReingest).toHaveBeenCalledTimes(1);
  });

  it("A7R and A7RD (#1899) name the no-op re-ingest, and no patch set, in their configuration", () => {
    const { deps } = staleFixture();
    const a7r = createA7RArm(deps);
    const a7rd = createA7RDArm(deps);
    expect(a7r.label).toContain("after a no-op re-ingest, not demoting stale citations");
    expect(a7rd.label).toContain("after a no-op re-ingest, demoting stale citations");
    expect(a7r.configuration.stage).toMatch(
      /after a no-op re-ingest at the pinned commit \(#1899\)/,
    );
    expect(a7r.configuration.staleness).toMatch(/^no patch: every repository/);
    expect(a7r.configuration.stalenessPatchSets).toBeUndefined();
    expect(createA7SArm(deps).configuration.stalenessPatchSets).toBe("patches-1");
    expect(createA7SArm(deps).label).toContain("after a staleness patch");
  });

  it("searches the patched corpus, so a moved citation of a file the search also finds still leads (MF-4500)", async () => {
    // a.go and b.go are both hybrid edit candidates; b's citation moved with b.go.
    const f = staleFixture({ strong: ["a", "b"] });
    const corpus = corpusOf(["r"]);
    const keep = await createA7SArm(f.deps).localize(item, corpus, { run: 1 });
    // The search the arm was given is the one over the patched rows: b.go at its new path.
    const searched = f.searchFor.mock.calls[0]![0] as typeof rows;
    expect(searched.find((r) => r.id === "r#b")!.filePath).toBe("b_renamed.go");
    // c.go (stale, not demoted) leads, then b.go (moved), then a.go: as A7 reads unpatched.
    expect(keep.editCandidateFiles).toEqual(["r:c.go", "r:b.go", "r:a.go"]);
    const a7 = await createA7Arm(f.deps).localize(item, corpus, { run: 1 });
    expect(a7.editCandidateFiles).toEqual(keep.editCandidateFiles);
  });

  it("A7 and A7K read the citations unpatched, without demotion (#1939), so a stale one still leads", async () => {
    const f = staleFixture();
    const corpus = corpusOf(["r"]);
    const a7 = await createA7Arm(f.deps).localize(item, corpus, { run: 1 });
    const a7k = await createA7KArm(f.deps).localize(item, corpus, { run: 1 });
    expect(f.withPatch).not.toHaveBeenCalled();
    // Nothing is stale unpatched: A7K equals A7.
    expect(a7k.editCandidateFiles).toEqual(a7.editCandidateFiles);
    expect(a7.editCandidateFiles).toEqual(["r:c.go", "r:b.go", "r:a.go"]);
    expect(a7.agent!.citationFreshness).toBeUndefined();

    // A stored stale citation (from an earlier re-ingest): the shipped default
    // (#1939) keeps it, in A7 as in A7K; only a demoting arm sets it aside.
    const meter = fakeMeter();
    const { io } = stubIO(meter, {
      r: [{ id: "req-1", title: "Order total", links: [link("c.go", 0.6, "stale")] }],
    });
    const deps = { search: searchSpy().search, analysis: io, meter, provider };
    expect((await createA7Arm(deps).localize(item, corpus)).editCandidateFiles).toEqual([
      "r:c.go",
      "r:a.go",
    ]);
    expect((await createA7KArm(deps).localize(item, corpus)).editCandidateFiles).toEqual([
      "r:c.go",
      "r:a.go",
    ]);
  });

  it("runs a new cycle per run, and runs a failed cycle again", async () => {
    const f = staleFixture();
    const corpus = corpusOf(["r"]);
    const arm = createA7SDArm(f.deps);
    await arm.localize(item, corpus, { run: 1 });
    await arm.localize(item, corpus, { run: 2 });
    expect(f.withPatch).toHaveBeenCalledTimes(2);

    const failing = staleFixture({ failRead: true });
    await expect(createA7SArm(failing.deps).localize(item, corpus)).rejects.toThrow(
      /re-ingest failed/,
    );
    await expect(createA7SDArm(failing.deps).localize(item, corpus)).rejects.toThrow(
      /re-ingest failed/,
    );
    expect(failing.withPatch).toHaveBeenCalledTimes(2);
  });

  it("names the patch sets and the demotion in the configuration", () => {
    const { deps } = staleFixture();
    const s = createA7SArm(deps);
    const sd = createA7SDArm(deps);
    expect(s.configuration).toMatchObject({
      stalenessPatchSets: "patches-1",
      model: "claude-sonnet-5-5",
    });
    expect(String(s.configuration.stage)).toContain(
      "IMPACT_DEMOTE_STALE_CITATIONS off, as shipped",
    );
    expect(String(sd.configuration.stage)).toContain(
      "IMPACT_DEMOTE_STALE_CITATIONS forced on: stale citations demoted (#1832",
    );
    expect(s.label).toContain("not demoting");
    expect(sd.label).toContain(", demoting");
    // #1939 — the shipped arm runs without demotion, and A7K reads as it does.
    expect(String(createA7Arm(deps).configuration.order)).toContain(
      "IMPACT_DEMOTE_STALE_CITATIONS off",
    );
    expect(createA7KArm(deps).configuration.order).toBe(createA7Arm(deps).configuration.order);
    expect(createA7Arm(deps).configuration.staleness).toBeUndefined();
  });
});
