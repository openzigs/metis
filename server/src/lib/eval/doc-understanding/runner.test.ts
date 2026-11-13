import { describe, expect, it } from "vitest";
import { resolveFinalAnswerMaxOutputTokens } from "../../analysis/agent-runner.js";
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

/**
 * Every call answers the judge's grades: E1 states R1, Q1 asks about A1. With
 * `judgeReplies: false` every call but the reader's answers in prose, so the
 * judge has no usable reply.
 */
function judgeProvider(
  model = "claude-sonnet-5-5",
  { judgeReplies = true } = {},
): { provider: AIProvider; calls: number } {
  const state = { provider: undefined as unknown as AIProvider, calls: 0 };
  state.provider = {
    key: "anthropic",
    model,
    offline: false,
    async chat(m: ChatMessage[], _o?: ChatOptions): Promise<ChatResponse> {
      state.calls++;
      const reader = m.length === 1 && m[0]!.content === "read";
      return {
        content:
          judgeReplies || reader
            ? JSON.stringify({
                requirements: [{ extracted: "E1", label: "R1" }],
                questions: [{ question: "Q1", ambiguity: "A1", worthAsking: true }],
              })
            : "I would rather not grade this.",
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

  it("records a judge failure against the reading, keeps its spend, and carries on (#2250)", async () => {
    const live = judgeProvider("claude-sonnet-5-5", { judgeReplies: false });
    const logs: string[] = [];
    const report = await runDocUnderstandingEval([item("d1"), item("d2")], {
      arms: [fakeArm("A")],
      runs: 1,
      budget: new EvalBudget(100),
      provider: live.provider,
      log: (l) => logs.push(l),
    });
    const recs = report.arms[0]!.records;
    // Both documents were read: one judge failing does not stop the run.
    expect(recs.map((r) => r.itemId)).toEqual(["d1", "d2"]);
    expect(report.stopped).toBeNull();
    const rec = recs[0]!;
    expect(rec.error).toMatch(/^judge: .*no usable reply/);
    expect(rec.score).toBeNull();
    expect(rec.judge).toBeNull();
    // The reading itself is kept, and the judge's spend is still metered.
    expect(rec.output?.requirements).toHaveLength(1);
    expect(rec.judgeCostUsd).toBeGreaterThan(0);
    expect(report.judgeSpentUsd).toBeCloseTo(2 * rec.judgeCostUsd!);
    expect(report.arms[0]!.summary.failures).toBe(2);
    expect(logs[0]).toMatch(/^\[A\] d1 run 1 failed: judge: .*no usable reply/);
  });

  it("stops an arm before a reading its costliest one so far would carry past the cap (#2250)", async () => {
    const one = await runDocUnderstandingEval([item("d1")], {
      arms: [fakeArm("A")],
      runs: 1,
      budget: new EvalBudget(100),
      provider: judgeProvider().provider,
    });
    const r = one.arms[0]!.records[0]!;
    const perReading = r.costUsd! + r.judgeCostUsd!;
    // After one reading there is half a reading left: under the cap, but not
    // enough for another reading of that arm.
    const live = judgeProvider();
    const report = await runDocUnderstandingEval([item("d1"), item("d2")], {
      arms: [fakeArm("A")],
      runs: 1,
      budget: new EvalBudget(perReading * 1.5),
      provider: live.provider,
    });
    expect(report.arms[0]!.records).toHaveLength(1);
    expect(live.calls).toBe(2);
    expect(report.stopped).toMatchObject({ armId: "A", itemId: "d2", run: 1 });
    expect(report.stopped!.reason).toMatch(/spent \+ up to \$[\d.]+ next/);
    expect(report.spentUsd).toBeLessThanOrEqual(perReading * 1.5);
  });

  it("records the output-token cap the readers ran at, and each reading's unpriced calls (#2250)", async () => {
    const report = await runDocUnderstandingEval([item("d1")], {
      arms: [fakeArm("A")],
      runs: 1,
      budget: new EvalBudget(100),
      provider: judgeProvider("a-model-metis-has-no-price-for").provider,
    });
    expect(report.outputTokenCap).toBe(
      resolveFinalAnswerMaxOutputTokens("a-model-metis-has-no-price-for", "anthropic"),
    );
    // The reader's call and the judge's.
    expect(report.arms[0]!.records[0]!.unpricedCalls).toBe(2);
    expect(toMarkdownReport(report)).toContain(`Output cap: **${report.outputTokenCap}**`);
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
    // B never read d2: its row says so rather than printing a cost of "unpriced".
    expect(c.arms[1]!.byItem[1]!.summary.readings).toBe(0);
    expect(toMarkdownReport(c)).toContain("| B | not run |");
    expect(c.spentUsd).toBeCloseTo(a.spentUsd + b.spentUsd);
    expect(c.judgeSpentUsd).toBeCloseTo(a.judgeSpentUsd + b.judgeSpentUsd);
    // An arm dropped from a report takes its spend with it.
    const onlyA = combineReports([{ ...a, arms: a.arms.filter((x) => x.id === "A") }, b]);
    expect(onlyA.spentUsd).toBeCloseTo(a.spentUsd / 2 + b.spentUsd);
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

  it("refuses to pool readings made at different output-token caps (#2250)", async () => {
    const a = await run(["d1"], [fakeArm("A")]);
    const b = await run(["d2"], [fakeArm("A")]);
    expect(combineReports([a, b]).outputTokenCap).toBe(a.outputTokenCap);
    expect(() => combineReports([a, { ...b, outputTokenCap: 21_333 }])).toThrow(
      `cannot combine readings at output caps ${a.outputTokenCap} and 21333`,
    );
    // A report written before the cap was recorded pools with nothing: its cap
    // cannot be checked, even against another unrecorded one.
    const { outputTokenCap: _cap, ...old }: DocUnderstandingReport = a;
    expect(() => combineReports([old, b])).toThrow(/records no output cap/);
    expect(() => combineReports([b, old])).toThrow(/records no output cap/);
    // Alone it is still one reading: there is nothing to compare its cap with.
    expect(combineReports([old]).outputTokenCap).toBeNull();
  });

  it("refuses two unrecorded caps, which may differ (#2250)", async () => {
    // The committed reader-sonnet-5-5-2374 (cap 16,384) and
    // reader-sonnet-5-5-2374-B-cap21333 share a model and commit and record no
    // cap: comparing null with null used to pool them silently.
    const a = await run(["d1"], [fakeArm("A")]);
    const b = await run(["d2"], [fakeArm("A")]);
    const { outputTokenCap: _a, ...oldA }: DocUnderstandingReport = a;
    const { outputTokenCap: _b, ...oldB }: DocUnderstandingReport = b;
    expect(() => combineReports([oldA, oldB])).toThrow(
      /report 1 records no output cap \(written before #2250\)/,
    );
    expect(() => combineReports([oldA, { ...oldB, outputTokenCap: null }])).toThrow(
      /records no output cap/,
    );
  });

  it("counts unpriced calls from the records it keeps, not whole reports (#2250)", async () => {
    const unpriced = await runDocUnderstandingEval([item("d1")], {
      arms: [fakeArm("B")],
      runs: 1,
      budget: new EvalBudget(100),
      provider: judgeProvider("a-model-metis-has-no-price-for").provider,
      provenance: { commit: "abc", dirty: false },
    });
    expect(unpriced.unpricedCalls).toBe(2);
    const priced = await run(["d2"], [fakeArm("A")]);
    const both = { ...priced, model: unpriced.model, outputTokenCap: unpriced.outputTokenCap };
    expect(combineReports([unpriced, both]).unpricedCalls).toBe(2);
    // Dropping arm B drops its unpriced calls with it.
    expect(combineReports([{ ...unpriced, arms: [] }, both]).unpricedCalls).toBe(0);
    // A record written before the count was kept: each unpriced cost is at least one call.
    const legacy = structuredClone(unpriced);
    delete (legacy.arms[0]!.records[0] as { unpricedCalls?: number }).unpricedCalls;
    expect(combineReports([legacy]).unpricedCalls).toBe(2);
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
