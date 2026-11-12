import { describe, expect, it } from "vitest";
import type { BaQaQuestion } from "./fixture.js";
import { scoreQuestion, summarizeArm } from "./metrics.js";
import { formatBaQaReport } from "./report.js";

const q: BaQaQuestion = {
  id: "M1",
  category: "multi-product",
  scope: ["a", "b"],
  text: "What changes?",
  expect: "answer",
  facts: [{ id: "M1.a", text: "f" }],
  sources: [{ product: "a", path: "x.go" }],
};

describe("formatBaQaReport", () => {
  it("puts each arm in a column, prints flags, spend and one row per session", () => {
    const off = scoreQuestion(q, [], new Map(), {
      behaviour: "abstain",
      facts: { "M1.a": "missing" },
      spans: {},
    });
    const on = scoreQuestion(q, [{ path: "x.go", products: ["a"], lines: null }], new Map(), {
      behaviour: "answer",
      facts: { "M1.a": "stated" },
      spans: {},
    });
    const md = formatBaQaReport({
      title: "T",
      provider: "anthropic",
      model: "m",
      judgeModel: "j",
      arms: [
        summarizeArm("off", [off], { answerUsd: 0.01, judgeUsd: 0.002 }),
        summarizeArm("on", [on], { answerUsd: null, judgeUsd: 0.002 }),
      ],
      armFlags: { off: { RAG_RERANK: "0" }, on: { RAG_RERANK: "1" } },
      sessions: [
        { arm: "off", score: off, costUsd: 0.01, projectId: null, ragChars: 0, toolCalls: 0 },
        { arm: "on", score: on, costUsd: null, projectId: "p", ragChars: 900, toolCalls: 3 },
      ],
      spentUsd: 0.014,
      stoppedEarly: "the $1 cap was reached",
    });
    expect(md).toContain("| Metric | off | on |");
    expect(md).toContain("- **on**: `RAG_RERANK=1`");
    expect(md).toContain("| Sessions chat left unscoped (no retrieval) | 1/1 | 0/1 |");
    expect(md).toContain("| Correctness: mean facts stated | 0% | 100% |");
    expect(md).toContain("| False abstention on answerable | 100% (1/1) | 0% (0/1) |");
    expect(md).not.toMatch(/\| Citation precision \|/);
    expect(md).toContain("| Citation precision: cited lines, judged on the span | n/a | n/a |");
    expect(md).toContain(
      "| Citation precision: file named without lines, judged by file | n/a | 100% (1/1) |",
    );
    expect(md).toContain("| Citations whose span the judge read | n/a | 0% (0/1) |");
    expect(md).toContain("| Answer spend | $0.0100 | unpriced |");
    expect(md).toContain("Run total, every model call: $0.014000.");
    expect(md).toContain("**Stopped early:** the $1 cap was reached.");
    expect(md).toContain(
      "| off | M1 | answer | abstain | 0/1 | 0 (0) | 0/1 | no | 0 | 0 | $0.0100 |",
    );
    expect(md).toContain(
      "| on | M1 | answer | answer | 1/1 | 1 (1) | 1/1 | yes | 900 | 3 | unpriced |",
    );
  });

  it("says defaults for an arm with no flags recorded and marks an unscored row", () => {
    const s = scoreQuestion(q, [], new Map(), null);
    const md = formatBaQaReport({
      title: "T",
      provider: "p",
      model: "m",
      judgeModel: "m",
      arms: [summarizeArm("off", [s], { answerUsd: 0, judgeUsd: 0 })],
      armFlags: {},
      sessions: [{ arm: "off", score: s, costUsd: 0, projectId: "p", ragChars: 1, toolCalls: 0 }],
      spentUsd: 0,
      stoppedEarly: null,
    });
    expect(md).toContain("- **off**: defaults");
    expect(md).toContain("| off | M1 | answer | unscored | - |");
    expect(md).not.toContain("Stopped early");
    // A run recorded before #2243 has no cap fields.
    expect(md).toContain("| Tool loop out of turns | n/a |");
    expect(md).toContain("| Tool results truncated | n/a |");
  });

  it("counts the tool loop's two caps per arm, over the sessions that recorded them", () => {
    const s = scoreQuestion(q, [], new Map(), null);
    const base = { score: s, costUsd: 0, projectId: "p", ragChars: 1, toolCalls: 4 };
    const md = formatBaQaReport({
      title: "T",
      provider: "p",
      model: "m",
      judgeModel: "m",
      arms: [
        summarizeArm("off", [s], { answerUsd: 0, judgeUsd: 0 }),
        summarizeArm("on", [s, s, s], { answerUsd: 0, judgeUsd: 0 }),
      ],
      armFlags: {},
      sessions: [
        { ...base, arm: "off" },
        { ...base, arm: "on", turnsExhausted: true, truncatedToolResults: 2 },
        { ...base, arm: "on", turnsExhausted: false, truncatedToolResults: 1 },
        { ...base, arm: "on", turnsExhausted: false, truncatedToolResults: 0 },
      ],
      spentUsd: 0,
      stoppedEarly: null,
    });
    expect(md).toContain("| Tool loop out of turns | n/a | 1 in 1/3 sessions |");
    expect(md).toContain("| Tool results truncated | n/a | 3 in 2/3 sessions |");
  });

  it("#2336: counts a multi-product session as scoped and averages tokens, seconds and retrieval", () => {
    const s = scoreQuestion(q, [], new Map(), null);
    const base = { score: s, costUsd: 0, projectId: null, ragChars: 1, toolCalls: 0 };
    const md = formatBaQaReport({
      title: "T",
      provider: "p",
      model: "m",
      judgeModel: "m",
      arms: [
        summarizeArm("old", [s], { answerUsd: 0, judgeUsd: 0 }),
        summarizeArm("all", [s, s], { answerUsd: 0, judgeUsd: 0 }),
      ],
      armFlags: {},
      sessions: [
        // A run recorded before #2336: unscoped, and no timings.
        { ...base, arm: "old" },
        {
          ...base,
          arm: "all",
          searchScope: "9 of 9 products (all)",
          seconds: 10,
          retrievalMs: 1000,
          usage: { promptTokens: 4000 },
        },
        {
          ...base,
          arm: "all",
          searchScope: "1 of 9 products (oracle)",
          seconds: 11,
          retrievalMs: 1500,
          usage: { promptTokens: 6000 },
        },
      ],
      spentUsd: 0,
      stoppedEarly: null,
    });
    expect(md).toContain("| Sessions chat left unscoped (no retrieval) | 1/1 | 0/2 |");
    expect(md).toContain("| Input tokens per question (cache reads included) | n/a | 5,000 |");
    expect(md).toContain("| Seconds per question | n/a | 10.5 |");
    expect(md).toContain("| Retrieval ms per question | n/a | 1,250 |");
    expect(md).toContain(
      "| all | M1 | answer | unscored | - | 0 (0) | 0/1 | 1 of 9 products (oracle) |",
    );
    expect(md).toContain("| old | M1 | answer | unscored | - | 0 (0) | 0/1 | no |");
  });
});
