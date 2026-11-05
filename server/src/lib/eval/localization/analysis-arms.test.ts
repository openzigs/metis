import { describe, expect, it, vi } from "vitest";
import type { StoredLinkRow } from "../../impact-analysis/change-seeds.js";
import type { ChangedRequirement } from "../../impact-analysis/extract-changes.js";
import { ANALYSIS_ARMS } from "./agent-env.js";
import {
  ANALYSIS_ARM_IDS,
  ANALYSIS_PASS_GROUP,
  ANALYSIS_VARIANTS,
  createA7Arm,
  createA7OArm,
} from "./analysis-arms.js";
import type { AnalysisArmIO, AnalysisPassRequest } from "./arm-core.js";
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

const link = (filePath: string, confidence = 0.6): StoredLinkRow => ({
  codeSymbolId: null,
  filePath,
  startLine: null,
  endLine: null,
  confidence,
  source: "analysis-grounding",
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
