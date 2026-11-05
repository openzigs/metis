import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_ARM_IDS,
  AGENT_VARIANTS,
  createA3AArm,
  createA3Arm,
  createA3NArm,
  resolveCitations,
  type AgentCitation,
  type AgentPass,
  type AgentPassRequest,
} from "./agent-arms.js";
import { AGENT_ARMS } from "./agent-env.js";
import { buildArms, createA0Arm, MODEL_ARMS } from "./arms.js";
import type { CostMeter } from "./cost.js";
import { PartialStore, runFingerprint } from "./partials.js";
import type { CorpusSearch } from "./search.js";

// Two files in each of two repositories; every query finds a.go strongly and
// b.go weakly, so A0's edit cut keeps a.go only.
const rows = ["r", "s"].flatMap((repo) =>
  ["a", "b"].map((n) => ({
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
const search: CorpusSearch = {
  searcher: {
    search: async (_q, repo) => [
      { symbolId: `${repo}#a`, filePath: "a.go", name: "a", kind: "function", score: 1 },
      { symbolId: `${repo}#b`, filePath: "b.go", name: "b", kind: "function", score: 0.3 },
    ],
  },
  loadSymbols: async (ids) =>
    rows.filter((r) => ids.includes(r.id)).map((r) => ({ ...r, signature: null })),
  loadWriterIds: async () => new Set<string>(),
  embeddingModel: "toy",
  symbolsDigest: "toy",
};
const corpusOf = (repos: string[]) =>
  ({
    name: "toy-corpus",
    manifest: { repos: repos.map((name) => ({ name })) },
    symbols: rows.filter((r) => repos.includes(r.repo)),
    graphFiles: new Set(
      rows.filter((r) => repos.includes(r.repo)).map((r) => `${r.repo}:${r.filePath}`),
    ),
  }) as unknown as Parameters<ReturnType<typeof createA3Arm>["localize"]>[1];
const item = { id: "I-1", title: "Change the order total", text: "Body." } as never;

const cite = (filePath: string, confidence = 0.5, line = 2): AgentCitation => ({
  filePath,
  startLine: line,
  endLine: line + 1,
  confidence,
});

/** The pass's model: the arm names it, so a resume on another model is refused (#1810). */
const provider = { key: "anthropic", model: "claude-sonnet-5-5" } as never;

/** A meter the stub pass charges: each pass costs `perPass` dollars. */
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

/** A stub pass that cites per repository and charges the meter. */
function stubPass(
  meter: ReturnType<typeof fakeMeter>,
  citesByRepo: Record<string, AgentCitation[]>,
  opts: { perPass?: number; unpriced?: boolean } = {},
) {
  return vi.fn(async (req: AgentPassRequest) => {
    meter.charge(opts.perPass ?? 0.01, opts.unpriced);
    return { citations: citesByRepo[req.repo] ?? [], turns: 3, toolCalls: 2, answered: true };
  });
}

describe("resolveCitations — the seed-code-links-from-findings rule", () => {
  it("keeps only cited files in the graph, in first-cited order, and counts the rest", () => {
    const graph = new Set(["r:a.go", "r:b.go"]);
    const out = resolveCitations(
      [cite("b.go", 0.4), cite("docs/x.md"), cite("a.go", 0.9), cite("b.go", 0.8), cite("gone.go")],
      "r",
      graph,
    );
    expect(out.files).toEqual(["b.go", "a.go"]);
    expect(out.unresolvedFiles).toBe(2);
  });

  it("writes one analysis-grounding link per file and span, keeping the highest confidence, clamped", () => {
    const out = resolveCitations(
      [
        cite("a.go", 0.4),
        cite("a.go", 1.7),
        cite("a.go", 0.2, 5),
        { filePath: "a.go", confidence: -1 },
      ],
      "r",
      new Set(["r:a.go"]),
    );
    expect(out.links).toEqual([
      {
        codeSymbolId: null,
        filePath: "a.go",
        startLine: 2,
        endLine: 3,
        confidence: 1,
        source: "analysis-grounding",
      },
      {
        codeSymbolId: null,
        filePath: "a.go",
        startLine: 5,
        endLine: 6,
        confidence: 0.2,
        source: "analysis-grounding",
      },
      {
        codeSymbolId: null,
        filePath: "a.go",
        startLine: null,
        endLine: null,
        confidence: 0,
        source: "analysis-grounding",
      },
    ]);
  });

  it("matches the file in the cited repository only", () => {
    expect(resolveCitations([cite("a.go")], "s", new Set(["r:a.go"])).files).toEqual([]);
  });
});

describe("A3 arms (#1755)", () => {
  it("refuse to run without a pass, a meter and a provider, and are model arms", () => {
    expect(() => createA3Arm({ search })).toThrow(/A3 runs the analysis agent/);
    expect(() => createA3Arm({ search, agentPass: vi.fn(), meter: fakeMeter() })).toThrow(
      /A3 runs the analysis agent/,
    );
    expect(() => createA3AArm({ search, agentPass: vi.fn() })).toThrow(/A3A runs/);
    expect(() => buildArms(["A0", "A3N"], { search })).toThrow(/A3N runs the analysis agent/);
    expect(() => createA3NArm({ search, meter: fakeMeter() })).toThrow(/A3N runs/);
    for (const id of ["A3", "A3A", "A3N"]) expect(MODEL_ARMS.has(id)).toBe(true);
    // The env binding's list (it may not import Prisma) is the same list.
    expect([...AGENT_ARM_IDS].sort()).toEqual([...AGENT_ARMS].sort());
    expect(Object.keys(AGENT_VARIANTS)).toEqual([...AGENT_ARMS]);
  });

  it("A3A: the cited graph files alone, in cited order, and only those named", async () => {
    const meter = fakeMeter();
    const agentPass = stubPass(meter, { r: [cite("b.go"), cite("nope.go"), cite("a.go")] });
    const out = await createA3AArm({ search, agentPass, meter, provider }).localize(
      item,
      corpusOf(["r"]),
      {
        run: 1,
      },
    );
    expect(out.editCandidateFiles).toEqual(["r:b.go", "r:a.go"]);
    expect(out.rankedFiles).toEqual(["r:b.go", "r:a.go"]);
    expect(out.llmNamedFiles).toEqual(["r:b.go", "r:a.go"]);
    expect(out.agentTurns).toBe(3);
    expect(out.reusedCostUsd).toBeUndefined();
    expect(agentPass).toHaveBeenCalledWith({
      corpus: "toy-corpus",
      repo: "r",
      text: "Change the order total\n\nBody.",
      toolset: "graph",
    });
  });

  it("A3: every A0 edit candidate first, then the cited files through the stored-link channel", async () => {
    const meter = fakeMeter();
    const corpus = corpusOf(["r"]);
    const a0 = await createA0Arm({ search }).localize(item, corpus);
    const agentPass = stubPass(meter, { r: [cite("b.go")] });
    const a3 = await createA3Arm({ search, agentPass, meter, provider }).localize(item, corpus, {
      run: 1,
    });
    expect(a0.editCandidateFiles).toEqual(["r:a.go"]);
    expect(a3.editCandidateFiles).toEqual(["r:a.go", "r:b.go"]);
    expect(a3.rankedFiles.slice(0, a0.editCandidateFiles.length)).toEqual(a0.editCandidateFiles);
  });

  it("A3 with no citation is A0", async () => {
    const meter = fakeMeter();
    const corpus = corpusOf(["r"]);
    const a0 = await createA0Arm({ search }).localize(item, corpus);
    const a3 = await createA3Arm({
      search,
      agentPass: stubPass(meter, {}),
      meter,
      provider,
    }).localize(item, corpus);
    expect(a3.rankedFiles).toEqual(a0.rankedFiles);
    expect(a3.editCandidateFiles).toEqual(a0.editCandidateFiles);
    expect(a3.llmNamedFiles).toEqual([]);
  });

  it("A3 and A3A read one pass per item, repository and run; the second reports its cost and time", async () => {
    const meter = fakeMeter();
    const agentPass = stubPass(meter, { r: [cite("b.go")] }, { perPass: 0.02 });
    let clock = 0;
    const deps = {
      search,
      agentPass,
      meter,
      provider,
      now: () => {
        clock += 1000;
        return clock;
      },
    };
    const [a3, a3a] = buildArms(["A3", "A3A"], deps);
    const corpus = corpusOf(["r"]);
    const first = await a3!.localize(item, corpus, { run: 1 });
    const second = await a3a!.localize(item, corpus, { run: 1 });
    expect(agentPass).toHaveBeenCalledTimes(1);
    expect(first.reusedCostUsd).toBeUndefined();
    expect(second.reusedCostUsd).toBeCloseTo(0.02);
    expect(second.reusedSeconds).toBe(1);
    expect(second.agentTurns).toBe(3);
    // Another run is another pass.
    await a3a!.localize(item, corpus, { run: 2 });
    expect(agentPass).toHaveBeenCalledTimes(2);
  });

  it("a reused pass that made an unpriced call is reported unpriced", async () => {
    const meter = fakeMeter();
    const agentPass = stubPass(meter, {}, { unpriced: true });
    const [a3, a3a] = buildArms(["A3", "A3A"], { search, agentPass, meter, provider });
    await a3!.localize(item, corpusOf(["r"]), { run: 1 });
    const second = await a3a!.localize(item, corpusOf(["r"]), { run: 1 });
    expect(second.reusedCostUsd).toBeNull();
  });

  it("A3N runs its own pass on the file tools, never A3's", async () => {
    const meter = fakeMeter();
    const agentPass = stubPass(meter, { r: [cite("a.go")] });
    const [a3a, a3n] = buildArms(["A3A", "A3N"], { search, agentPass, meter, provider });
    await a3a!.localize(item, corpusOf(["r"]), { run: 1 });
    const out = await a3n!.localize(item, corpusOf(["r"]), { run: 1 });
    expect(agentPass).toHaveBeenCalledTimes(2);
    expect(agentPass.mock.calls[1]![0].toolset).toBe("files");
    expect(out.reusedCostUsd).toBeUndefined();
    expect(out.editCandidateFiles).toEqual(["r:a.go"]);
    expect(a3n!.configuration.tools).toMatch(/grep_files .*no graph or symbol search/);
  });

  it("runs one pass per repository and interleaves their citations", async () => {
    const meter = fakeMeter();
    const agentPass = stubPass(meter, { r: [cite("b.go"), cite("a.go")], s: [cite("a.go")] });
    const out = await createA3AArm({ search, agentPass, meter, provider }).localize(
      item,
      corpusOf(["r", "s"]),
      { run: 1 },
    );
    expect(agentPass).toHaveBeenCalledTimes(2);
    expect(out.editCandidateFiles).toEqual(["r:b.go", "s:a.go", "r:a.go"]);
    expect(out.agentTurns).toBe(6);
  });

  it("does not keep a failed pass: the next reading runs it again", async () => {
    const meter = fakeMeter();
    const agentPass: AgentPass = vi
      .fn<AgentPass>()
      .mockRejectedValueOnce(new Error("provider down"))
      .mockResolvedValue({ citations: [cite("a.go")], turns: 1, toolCalls: 0, answered: true });
    const arm = createA3AArm({ search, agentPass, meter, provider });
    await expect(arm.localize(item, corpusOf(["r"]), { run: 1 })).rejects.toThrow(/provider down/);
    const out = await arm.localize(item, corpusOf(["r"]), { run: 1 });
    expect(out.editCandidateFiles).toEqual(["r:a.go"]);
  });

  it("reports the counts each pass computed: passes, unanswered, tool calls, cited and unresolved files (#1810)", async () => {
    const meter = fakeMeter();
    const agentPass = vi.fn(async (req: AgentPassRequest) =>
      req.repo === "r"
        ? {
            citations: [cite("a.go"), cite("docs/x.md"), cite("a.go", 0.9, 7), cite("gone.go")],
            turns: 5,
            toolCalls: 4,
            answered: false,
          }
        : { citations: [cite("b.go")], turns: 2, toolCalls: 1, answered: true },
    );
    const out = await createA3AArm({ search, agentPass, meter, provider }).localize(
      item,
      corpusOf(["r", "s"]),
      { run: 1 },
    );
    expect(out.agentTurns).toBe(7);
    expect(out.agent).toMatchObject({
      passes: 2,
      unanswered: 1,
      toolCalls: 5,
      // r: a.go resolves, docs/x.md and gone.go do not; s: b.go resolves.
      citedFiles: 4,
      unresolvedFiles: 2,
      passGroup: "graph",
    });
    expect(out.agent!.passIds).toHaveLength(2);
    expect(new Set(out.agent!.passIds).size).toBe(2);
  });

  it("A3 and A3A name the same pass ids for a shared pass; A3N its own group (#1810)", async () => {
    const meter = fakeMeter();
    const agentPass = stubPass(meter, { r: [cite("a.go")] });
    const [a3, a3a, a3n] = buildArms(["A3", "A3A", "A3N"], { search, agentPass, meter, provider });
    const corpus = corpusOf(["r"]);
    const one = await a3!.localize(item, corpus, { run: 1 });
    const two = await a3a!.localize(item, corpus, { run: 1 });
    const nograph = await a3n!.localize(item, corpus, { run: 1 });
    expect(two.agent!.passIds).toEqual(one.agent!.passIds);
    expect(nograph.agent!.passGroup).toBe("files");
    expect(nograph.agent!.passIds).not.toEqual(one.agent!.passIds);
    // Another run is another pass, with another id.
    const again = await a3a!.localize(item, corpus, { run: 2 });
    expect(again.agent!.passIds).not.toEqual(one.agent!.passIds);
  });

  it("agent-arms.ts and arm-core.ts do not import arms.ts: no import cycle (#1810)", async () => {
    const { readFile } = await import("node:fs/promises");
    const here = path.dirname(new URL(import.meta.url).pathname);
    for (const file of ["agent-arms.ts", "arm-core.ts"]) {
      const source = await readFile(path.join(here, file), "utf8");
      expect(source, file).not.toMatch(/from "\.\/arms\.js"/);
    }
    expect(await readFile(path.join(here, "arm-core.ts"), "utf8")).not.toMatch(
      /from "\.\/agent-arms\.js"/,
    );
  });

  it("names its configuration", () => {
    const meter = fakeMeter();
    const a3 = createA3Arm({ search, agentPass: vi.fn(), meter, provider });
    expect(a3.configuration).toMatchObject({ llm: true, embeddingModel: "toy" });
    expect(a3.configuration.stage).toMatch(/stored-link channel/);
    expect(
      createA3AArm({ search, agentPass: vi.fn(), meter, provider }).configuration.stage,
    ).toMatch(/citations alone/);
    expect(a3.label).toMatch(/unioned with A0's hybrid seeds/);
  });

  it("name the pass's provider and model, in the configuration and the label (#1810)", () => {
    for (const id of ["A3", "A3A", "A3N"]) {
      const [arm] = buildArms([id], { search, agentPass: vi.fn(), meter: fakeMeter(), provider });
      expect(arm!.configuration).toMatchObject({
        provider: "anthropic",
        model: "claude-sonnet-5-5",
      });
      expect(arm!.label).toContain("(anthropic/claude-sonnet-5-5)");
    }
  });

  it("refuse a resume on a different model (#1810)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "loc-a3-model-"));
    try {
      const store = new PartialStore(dir);
      const armsOn = (model: string) =>
        buildArms(["A3", "A3A", "A3N"], {
          search,
          agentPass: vi.fn(),
          meter: fakeMeter(),
          provider: { key: "anthropic", model } as never,
        });
      const corpus = corpusOf(["r"]);
      await store.openForRun(corpus, runFingerprint(corpus, armsOn("claude-sonnet-5-5"), 2));
      await expect(
        store.openForRun(corpus, runFingerprint(corpus, armsOn("deepseek-chat"), 2)),
      ).rejects.toThrow(
        /configuration changed since the first slice:[\s\S]*arm A3 model: recorded "claude-sonnet-5-5", now "deepseek-chat"/,
      );
      await expect(
        store.openForRun(corpus, runFingerprint(corpus, armsOn("claude-sonnet-5-5"), 2)),
      ).resolves.toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
