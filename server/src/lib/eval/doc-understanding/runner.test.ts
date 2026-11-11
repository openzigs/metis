import { describe, expect, it } from "vitest";
import type { AIProvider, ChatMessage, ChatOptions, ChatResponse } from "../../ai/types.js";
import { splitSections } from "../../governing/rule-extraction.js";
import { EvalBudget } from "../localization/runner.js";
import type { DocArm } from "./arms.js";
import type { DocUnderstandingItem } from "./corpus.js";
import {
  combineReports,
  runDocUnderstandingEval,
  summarise,
  toJsonReport,
  toMarkdownReport,
  type DocUnderstandingReport,
} from "./runner.js";

const TEXT = [
  "# Booking FRD",
  "",
  "## 1. Access",
  "",
  "The portal shall lock an account after five failed attempts.",
  "",
  "## 2. Booking",
  "",
  "A patient shall hold at most two future appointments.",
  "",
].join("\n");

const item = (name: string): DocUnderstandingItem => ({
  name,
  title: "Booking FRD",
  text: TEXT,
  docxBytes: 10,
  sections: splitSections(TEXT),
  labels: {
    sections: ["Booking FRD", "1. Access", "2. Booking"],
    requirements: [
      {
        id: "R1",
        section: "1. Access",
        span: "The portal shall lock an account after five failed attempts.",
      },
      {
        id: "R2",
        section: "2. Booking",
        span: "A patient shall hold at most two future appointments.",
      },
    ],
    ambiguities: [
      {
        id: "A1",
        kind: "missing",
        description: "unlock",
        question: "When?",
        requirements: ["R1"],
        spans: ["The portal shall lock an account after five failed attempts."],
        sections: ["1. Access"],
      },
    ],
  },
});

/** Every call answers the judge's grades: E1 states R1, Q1 asks about A1. */
function judgeProvider(model = "claude-sonnet-5-5"): { provider: AIProvider; calls: number } {
  const state = { provider: undefined as unknown as AIProvider, calls: 0 };
  state.provider = {
    key: "anthropic",
    model,
    offline: false,
    async chat(_m: ChatMessage[], _o?: ChatOptions): Promise<ChatResponse> {
      state.calls++;
      return {
        content: JSON.stringify({
          requirements: [{ extracted: "E1", label: "R1" }],
          questions: [{ question: "Q1", ambiguity: "A1", worthAsking: true }],
        }),
        model,
        provider: "anthropic",
        usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 },
      };
    },
  } as unknown as AIProvider;
  return state;
}

/** An arm that makes one model call and returns a fixed reading, or throws. */
function fakeArm(id: "A" | "B" | "C", fail = false): DocArm {
  return {
    id,
    label: `${id} — fake`,
    configuration: { model: "m" },
    async read(_item, { provider }) {
      await provider.chat([{ role: "user", content: "read" }], {});
      if (fail) throw new Error("the reader\nbroke");
      return {
        requirements: [{ text: "lock after five", quote: "The portal shall lock an account" }],
        questions: [{ text: "When does it unlock?" }],
        diagnostics: { calls: 1 },
      };
    },
  };
}

describe("runDocUnderstandingEval", () => {
  it("reads, judges and scores every item with every arm, metering reader and judge apart", async () => {
    const live = judgeProvider();
    const logs: string[] = [];
    const report = await runDocUnderstandingEval([item("d1"), item("d2")], {
      arms: [fakeArm("A"), fakeArm("B")],
      runs: 2,
      budget: new EvalBudget(100),
      provider: live.provider,
      provenance: { commit: "abc", dirty: false },
      log: (l) => logs.push(l),
    });
    // 2 runs × 2 items × 2 arms × (1 reader call + 1 judge call)
    expect(live.calls).toBe(16);
    expect(report.stopped).toBeNull();
    expect(report.model).toBe("anthropic/claude-sonnet-5-5");
    expect(report.arms.map((a) => a.records.length)).toEqual([4, 4]);
    const a = report.arms[0]!;
    expect(a.summary.metrics.requirementRecall.mean).toBe(0.5);
    expect(a.summary.metrics.requirementPrecision.mean).toBe(1);
    expect(a.summary.metrics.sectionCoverage.mean).toBe(0.5);
    expect(a.summary.metrics.questionPrecision.mean).toBe(1);
    expect(a.summary.metrics.ambiguityRecall.mean).toBe(1);
    expect(a.summary.metrics.quoteAccuracy.mean).toBe(1);
    expect(a.summary.failures).toBe(0);
    expect(a.byItem.map((b) => b.itemId)).toEqual(["d1", "d2"]);
    const rec = a.records[0]!;
    expect(rec.costUsd).toBeGreaterThan(0);
    expect(rec.judgeCostUsd).toBeCloseTo(rec.costUsd!);
    expect(report.spentUsd).toBeCloseTo(16 * rec.costUsd!);
    expect(report.judgeSpentUsd).toBeCloseTo(8 * rec.costUsd!);
    expect(a.summary.usdPerDocument).toBeCloseTo(rec.costUsd!);
    expect(report.corpus[0]).toMatchObject({
      id: "d1",
      requirements: 2,
      labelledSections: 2,
      ambiguities: 1,
    });
    expect(logs.some((l) => l.includes("[A] d1 run 1: recall=0.50"))).toBe(true);
  });

  it("records a reader failure in one line and scores nothing for it", async () => {
    const live = judgeProvider();
    const logs: string[] = [];
    const report = await runDocUnderstandingEval([item("d1")], {
      arms: [fakeArm("A", true)],
      runs: 1,
      budget: new EvalBudget(100),
      provider: live.provider,
      log: (l) => logs.push(l),
    });
    const rec = report.arms[0]!.records[0]!;
    expect(rec.error).toBe("reader: the reader broke");
    expect(rec.score).toBeNull();
    expect(live.calls).toBe(1);
    expect(report.arms[0]!.summary.failures).toBe(1);
    expect(report.arms[0]!.summary.metrics.requirementRecall.mean).toBeNull();
    expect(logs[0]).toContain("failed: reader: the reader broke");
  });

  it("stops before the first reading the cap refuses, and says why", async () => {
    const live = judgeProvider();
    const report = await runDocUnderstandingEval([item("d1"), item("d2")], {
      arms: [fakeArm("A")],
      runs: 1,
      budget: new EvalBudget(0),
      provider: live.provider,
    });
    expect(live.calls).toBe(0);
    expect(report.stopped).toMatchObject({ armId: "A", itemId: "d1", run: 1 });
    expect(report.stopped!.reason).toMatch(/budget/);
  });

  it("stops after an unpriced call: the cap cannot be enforced", async () => {
    const live = judgeProvider("a-model-metis-has-no-price-for");
    const report = await runDocUnderstandingEval([item("d1"), item("d2")], {
      arms: [fakeArm("A")],
      runs: 1,
      budget: new EvalBudget(100),
      provider: live.provider,
    });
    expect(report.arms[0]!.records).toHaveLength(1);
    expect(report.arms[0]!.records[0]!.costUsd).toBeNull();
    expect(report.arms[0]!.summary.usdPerDocument).toBeNull();
    expect(report.stopped).toMatchObject({ itemId: "d2", reason: "an unpriced model call" });
  });
});

describe("summarise", () => {
  it("ignores missing values and reports mean, min and max", () => {
    expect(summarise([0.5, null, 1, undefined, Number.NaN])).toEqual({
      mean: 0.75,
      min: 0.5,
      max: 1,
      n: 2,
    });
    expect(summarise([])).toEqual({ mean: null, min: null, max: null, n: 0 });
  });
});

describe("combineReports and rendering", () => {
  const run = async (
    names: string[],
    arms: DocArm[],
    commit = "abc",
  ): Promise<DocUnderstandingReport> =>
    runDocUnderstandingEval(names.map(item), {
      arms,
      runs: 1,
      budget: new EvalBudget(100),
      provider: judgeProvider().provider,
      provenance: { commit, dirty: false },
    });

  it("pools records per arm across invocations and recomputes every summary", async () => {
    const a = await run(["d1"], [fakeArm("A"), fakeArm("B")]);
    const b = await run(["d2"], [fakeArm("A")]);
    const c = combineReports([a, b]);
    expect(c.corpus.map((x) => x.id)).toEqual(["d1", "d2"]);
    expect(c.arms.map((x) => [x.id, x.records.length])).toEqual([
      ["A", 2],
      ["B", 1],
    ]);
    expect(c.arms[0]!.byItem.map((x) => x.itemId)).toEqual(["d1", "d2"]);
    expect(c.spentUsd).toBeCloseTo(a.spentUsd + b.spentUsd);
    expect(c.budgetUsd).toBe(200);
    expect(c.provenance).toEqual({ commit: "abc", dirty: false });
  });

  it("refuses to combine different commits, different models or nothing", async () => {
    const a = await run(["d1"], [fakeArm("A")]);
    const b = await run(["d2"], [fakeArm("A")], "def");
    expect(() => combineReports([a, b])).toThrow(/cannot combine readings at/);
    expect(() => combineReports([a, { ...a, model: "anthropic/other" }])).toThrow(
      /cannot combine readings of/,
    );
    expect(() => combineReports([])).toThrow(/nothing to combine/);
  });

  it("renders the results, the per-document detail and each arm's configuration", async () => {
    const report = await run(["d1"], [fakeArm("A"), fakeArm("B", true)]);
    const md = toMarkdownReport(report);
    expect(md).toContain("# Document understanding eval (#2229)");
    expect(md).toContain("| A | 0.50 | 1.00 | 0.50 | 1.00 | 1.00 | 1.00 |");
    expect(md).toContain("### d1 — Booking FRD");
    expect(md).toContain("- A run 1: missed requirements R2;");
    expect(md).toContain("- B run 1: **failed** — reader: the reader broke");
    expect(md).toContain("### A — fake");
    const json = JSON.parse(toJsonReport(report, { generatedAt: "now" })) as Record<
      string,
      unknown
    >;
    expect(json.generatedAt).toBe("now");
    expect(json.model).toBe("anthropic/claude-sonnet-5-5");
  });

  it("says when a run stopped early", async () => {
    const report = await runDocUnderstandingEval([item("d1")], {
      arms: [fakeArm("A")],
      runs: 1,
      budget: new EvalBudget(0),
      provider: judgeProvider().provider,
    });
    expect(toMarkdownReport(report)).toContain("**Stopped early** before A on d1, run 1");
  });
});
