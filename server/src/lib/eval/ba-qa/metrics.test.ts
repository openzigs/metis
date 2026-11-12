import { describe, expect, it } from "vitest";
import type { Citation } from "./citations.js";
import type { BaQaQuestion } from "./fixture.js";
import type { JudgeVerdict } from "./judge.js";
import { scoreQuestion, summarizeArm, type QuestionScore } from "./metrics.js";

const answerQ: BaQaQuestion = {
  id: "S1",
  category: "single-product",
  scope: ["srv"],
  text: "How?",
  expect: "answer",
  facts: [
    { id: "S1.a", text: "a" },
    { id: "S1.b", text: "b" },
    { id: "S1.c", text: "c" },
  ],
  sources: [
    { product: "srv", path: "a.go", lines: [1, 5] },
    { product: "srv", path: "b.go" },
  ],
};
const ambiguousQ: BaQaQuestion = {
  id: "A1",
  category: "ambiguous",
  scope: ["srv"],
  text: "It?",
  expect: "follow-up",
  why: "w",
};
const unanswerableQ: BaQaQuestion = {
  id: "U1",
  category: "unanswerable",
  scope: ["srv"],
  text: "Price?",
  expect: "abstain",
  why: "w",
};

const cite = (path: string, lines: [number, number] | null = null): Citation => ({
  path,
  products: ["srv"],
  lines,
});
const verdict = (v: Partial<JudgeVerdict>): JudgeVerdict => ({
  behaviour: "answer",
  facts: {},
  spans: {},
  ...v,
});

describe("scoreQuestion", () => {
  it("scores facts, span-checked and file-checked citations, and recall", () => {
    const citations = [cite("a.go", [1, 5]), cite("c.go", [3, 4]), cite("b.go"), cite("z.go")];
    const s = scoreQuestion(
      answerQ,
      citations,
      new Map([
        [0, [1]],
        [1, [2]],
      ]),
      verdict({
        facts: { "S1.a": "stated", "S1.b": "stated", "S1.c": "contradicted" },
        spans: { 1: true, 2: false },
      }),
    );
    expect(s.behaviourOk).toBe(true);
    expect(s.facts).toEqual({ stated: 2, contradicted: 1, missing: 0, total: 3 });
    expect(s.factRecall).toBeCloseTo(2 / 3);
    expect(s.fullyCorrect).toBe(false);
    expect(s.citations.map((c) => [c.path, c.check, c.supports])).toEqual([
      ["a.go", "span", true],
      ["c.go", "span", false],
      ["b.go", "file", true],
      ["z.go", "file", false],
    ]);
    expect(s.citationPrecision).toBe(0.5);
    expect(s.expectedFiles).toEqual(["srv:a.go", "srv:b.go"]);
    expect(s.citedExpectedFiles).toEqual(["srv:a.go", "srv:b.go"]);
    expect(s.citationRecall).toBe(1);
  });

  it("counts lines that are not in the file as unsupported, even in an expected file", () => {
    const s = scoreQuestion(
      answerQ,
      [cite("a.go", [900, 950])],
      new Map([[0, []]]),
      verdict({ facts: { "S1.a": "stated", "S1.b": "stated", "S1.c": "stated" } }),
    );
    // Never shown to the judge, so not counted as a span check.
    expect(s.citations[0]).toMatchObject({ check: "no-such-lines", supports: false });
    expect(s.fullyCorrect).toBe(true);
    expect(s.citationRecall).toBe(0.5);
  });

  it("supports a citation of a shared path when any of its products' spans supports it", () => {
    const shared: Citation = { path: "README.md", products: ["cli", "srv"], lines: [1, 2] };
    const facts = { "S1.a": "stated", "S1.b": "stated", "S1.c": "stated" } as const;
    const one = scoreQuestion(
      answerQ,
      [shared],
      new Map([[0, [1, 2]]]),
      verdict({ facts, spans: { 1: false, 2: true } }),
    );
    expect(one.citations[0]).toMatchObject({ check: "span", supports: true });
    const none = scoreQuestion(
      answerQ,
      [shared],
      new Map([[0, [1, 2]]]),
      verdict({ facts, spans: { 1: false, 2: false } }),
    );
    expect(none.citations[0]).toMatchObject({ check: "span", supports: false });
  });

  it("leaves precision null with no citations and recall null for a non-answer question", () => {
    const s = scoreQuestion(ambiguousQ, [], new Map(), verdict({ behaviour: "follow-up" }));
    expect(s.citationPrecision).toBeNull();
    expect(s.citationRecall).toBeNull();
    expect(s.facts).toBeNull();
    expect(s.behaviourOk).toBe(true);
  });

  it("is unscored, not zero, when the judge could not be read", () => {
    const s = scoreQuestion(answerQ, [cite("a.go")], new Map(), null);
    expect(s.behaviour).toBeNull();
    expect(s.behaviourOk).toBeNull();
    expect(s.factRecall).toBeNull();
    expect(s.citationPrecision).toBeNull();
    // Recall reads only the answer's text, so it is still known.
    expect(s.citationRecall).toBe(0.5);
  });
});

describe("summarizeArm", () => {
  const all = (): QuestionScore[] => [
    scoreQuestion(
      answerQ,
      [cite("a.go", [1, 5]), cite("a.go", [900, 901]), cite("b.go"), cite("z.go")],
      new Map([
        [0, [1]],
        [1, []],
      ]),
      verdict({
        facts: { "S1.a": "stated", "S1.b": "stated", "S1.c": "stated" },
        spans: { 1: true },
      }),
    ),
    // An answer question the reply asked back about: an unneeded follow-up,
    // not a false abstention.
    scoreQuestion(
      { ...answerQ, id: "S3", facts: [{ id: "S3.a", text: "a" }] },
      [],
      new Map(),
      verdict({ behaviour: "follow-up", facts: { "S3.a": "missing" } }),
    ),
    scoreQuestion(
      { ...answerQ, id: "S2", facts: [{ id: "S2.a", text: "a" }] },
      [],
      new Map(),
      verdict({ behaviour: "abstain", facts: { "S2.a": "missing" } }),
    ),
    scoreQuestion(ambiguousQ, [], new Map(), verdict({ behaviour: "answer" })),
    scoreQuestion({ ...ambiguousQ, id: "A2" }, [], new Map(), verdict({ behaviour: "follow-up" })),
    scoreQuestion(unanswerableQ, [], new Map(), verdict({ behaviour: "answer" })),
    scoreQuestion({ ...unanswerableQ, id: "U2" }, [], new Map(), null),
  ];

  it("computes every rate from the verdicts and leaves the unscored out", () => {
    const s = summarizeArm("off", all(), { answerUsd: 0.7, judgeUsd: 0.12 });
    expect(s.questions).toBe(7);
    expect(s.unscored).toBe(1);
    expect(s.correctness).toBeCloseTo(1 / 3);
    expect(s.fullyCorrect).toEqual({ n: 1, of: 3, rate: 1 / 3 });
    // The two checks are reported apart: cited lines (read by the judge, or not
    // in the file) and a file named without lines.
    expect(s.citationPrecisionLines).toEqual({ n: 1, of: 2, rate: 0.5 });
    expect(s.citationPrecisionFile).toEqual({ n: 1, of: 2, rate: 0.5 });
    // Only a span the judge was shown counts as span-checked.
    expect(s.spanChecked).toEqual({ n: 1, of: 4, rate: 0.25 });
    expect(s.citationRecall).toEqual({ n: 2, of: 6, rate: 1 / 3 });
    expect(s.falseAbstention).toEqual({ n: 1, of: 3, rate: 1 / 3 });
    expect(s.unneededFollowUp).toEqual({ n: 1, of: 3, rate: 1 / 3 });
    expect(s.followUp).toEqual({ n: 1, of: 2, rate: 0.5 });
    expect(s.abstention).toEqual({ n: 0, of: 1, rate: 0 });
    expect(s.confidentGuess).toEqual({ n: 1, of: 1, rate: 1 });
    expect(s.byCategory.ambiguous).toEqual({
      questions: 2,
      behaviourOk: { n: 1, of: 2, rate: 0.5 },
    });
    expect(s.byCategory.unanswerable.behaviourOk).toEqual({ n: 0, of: 1, rate: 0 });
    expect(s.byCategory["multi-product"]).toEqual({
      questions: 0,
      behaviourOk: { n: 0, of: 0, rate: null },
    });
    expect(s.cost.totalUsd).toBeCloseTo(0.82);
    expect(s.cost.perQuestionUsd).toBeCloseTo(0.1);
  });

  it("reports unpriced spend as unknown, never as zero", () => {
    const s = summarizeArm("on", all(), { answerUsd: null, judgeUsd: 0.1 });
    expect(s.cost.totalUsd).toBeNull();
    expect(s.cost.perQuestionUsd).toBeNull();
    expect(summarizeArm("on", [], { answerUsd: 0, judgeUsd: 0 }).correctness).toBeNull();
  });
});
