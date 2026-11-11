import { describe, expect, it } from "vitest";
import type { AIProvider, ChatMessage, ChatOptions, ChatResponse } from "../../ai/types.js";
import { splitSections } from "../../governing/rule-extraction.js";
import type { FrdLabels } from "./corpus-source.js";
import type { DocUnderstandingItem } from "./corpus.js";
import { judgeReading, readJudgement, scoreReading, type Judgement } from "./scorer.js";

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
  "A booking shall not start less than two hours from now.",
  "",
].join("\n");

const LABELS: FrdLabels = {
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
    {
      id: "R3",
      section: "2. Booking",
      span: "A booking shall not start less than two hours from now.",
    },
  ],
  ambiguities: [
    {
      id: "A1",
      kind: "missing",
      description: "unlock is unstated",
      question: "When does a locked account unlock?",
      requirements: ["R1"],
      spans: ["The portal shall lock an account after five failed attempts."],
      sections: ["1. Access"],
    },
    {
      id: "A2",
      kind: "missing",
      description: "telephone bookings",
      question: "Do telephone bookings count?",
      requirements: ["R2"],
      spans: ["A patient shall hold at most two future appointments."],
      sections: ["2. Booking"],
    },
  ],
};

const ITEM: DocUnderstandingItem = {
  name: "fixture",
  title: "Booking FRD",
  text: TEXT,
  docxBytes: 1,
  sections: splitSections(TEXT),
  labels: LABELS,
};

describe("readJudgement", () => {
  const counts = { extracted: 3, questions: 2 };

  it("reads grades by position and keeps only ids the labels hold", () => {
    const j = readJudgement(
      {
        requirements: [
          { extracted: "E2", label: "R3" },
          { extracted: "E1", label: "R1" },
          { extracted: "E3", label: "R99" },
        ],
        questions: [
          { question: "Q1", ambiguity: "A1", worthAsking: true },
          { question: "Q2", ambiguity: "null", worthAsking: false },
        ],
      },
      LABELS,
      counts,
    );
    expect(j.requirements).toEqual(["R1", "R3", null]);
    expect(j.questions).toEqual([
      { ambiguity: "A1", worthAsking: true },
      { ambiguity: null, worthAsking: false },
    ]);
    expect(j.invalid).toBe(1);
    expect(j.ungraded).toBe(0);
  });

  it("counts a repeated or out-of-range grade as invalid and a missing one as ungraded", () => {
    const j = readJudgement(
      {
        requirements: [
          { extracted: "E1", label: "R1" },
          { extracted: "E1", label: "R2" },
          { extracted: "E9", label: "R2" },
          { extracted: "nonsense", label: null },
        ],
        questions: [{ question: "Q1", ambiguity: "A7", worthAsking: true }],
      },
      LABELS,
      counts,
    );
    expect(j.requirements).toEqual(["R1", null, null]);
    expect(j.questions).toEqual([
      { ambiguity: null, worthAsking: true },
      { ambiguity: null, worthAsking: false },
    ]);
    expect(j.invalid).toBe(4);
    expect(j.ungraded).toBe(3);
  });
});

describe("scoreReading", () => {
  const output = {
    requirements: [
      {
        text: "lock after five failures",
        quote: "The portal shall lock an account after five failed attempts.",
      },
      { text: "lock accounts", quote: "words the document never says" },
      { text: "background mistaken for a requirement" },
    ],
    questions: [{ text: "When does it unlock?" }, { text: "Is the portal blue?" }],
  };
  const judgement: Judgement = {
    requirements: ["R1", "R1", null],
    questions: [
      { ambiguity: "A1", worthAsking: true },
      { ambiguity: null, worthAsking: false },
    ],
    invalid: 0,
    ungraded: 0,
  };

  it("computes recall, precision with repeats against it, coverage and question metrics", () => {
    const s = scoreReading(ITEM, output, judgement);
    expect(s).toMatchObject({
      labelled: 3,
      extracted: 3,
      matched: 1,
      repeats: 1,
      labelledSections: 2,
      coveredSections: 1,
      missedSections: ["2. Booking"],
      missedRequirements: ["R2", "R3"],
      questions: 2,
      worthAsking: 1,
      ambiguities: 2,
      ambiguitiesRaised: 1,
      missedAmbiguities: ["A2"],
      unmatchedExtracted: ["background mistaken for a requirement"],
      quoted: 2,
      quotesVerified: 1,
    });
    expect(s.requirementRecall).toBeCloseTo(1 / 3);
    expect(s.requirementPrecision).toBeCloseTo(1 / 3);
    expect(s.sectionCoverage).toBe(0.5);
    expect(s.questionPrecision).toBe(0.5);
    expect(s.ambiguityRecall).toBe(0.5);
    expect(s.quoteAccuracy).toBe(0.5);
  });

  it("has no precision, question precision or quote accuracy over nothing", () => {
    const s = scoreReading(
      ITEM,
      { requirements: [], questions: [] },
      { requirements: [], questions: [], invalid: 0, ungraded: 0 },
    );
    expect(s.requirementRecall).toBe(0);
    expect(s.sectionCoverage).toBe(0);
    expect(s.requirementPrecision).toBeNull();
    expect(s.questionPrecision).toBeNull();
    expect(s.quoteAccuracy).toBeNull();
    expect(s.ambiguityRecall).toBe(0);
  });
});

interface Call {
  messages: ChatMessage[];
  opts?: ChatOptions;
}

function stubProvider(replies: string[]): { provider: AIProvider; calls: Call[] } {
  const calls: Call[] = [];
  const provider = {
    key: "anthropic",
    model: "claude-sonnet-5-5",
    offline: false,
    async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> {
      calls.push({ messages, opts });
      return {
        content: replies[Math.min(calls.length - 1, replies.length - 1)]!,
        model: "claude-sonnet-5-5",
        provider: "anthropic",
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      };
    },
  } as unknown as AIProvider;
  return { provider, calls };
}

describe("judgeReading", () => {
  const output = {
    requirements: [{ text: "lock after five failures" }],
    questions: [{ text: "When does it unlock?" }],
  };

  it("asks nothing when the reading found nothing", async () => {
    const { provider, calls } = stubProvider(["{}"]);
    const j = await judgeReading(provider, ITEM, { requirements: [], questions: [] });
    expect(calls).toHaveLength(0);
    expect(j).toEqual({ requirements: [], questions: [], invalid: 0, ungraded: 0 });
  });

  it("shows the judge the document, the labels and the numbered reading, fenced", async () => {
    const { provider, calls } = stubProvider([
      JSON.stringify({
        requirements: [{ extracted: "E1", label: "R1" }],
        questions: [{ question: "Q1", ambiguity: "A1", worthAsking: true }],
      }),
    ]);
    const j = await judgeReading(provider, ITEM, output);
    expect(j.requirements).toEqual(["R1"]);
    expect(j.questions).toEqual([{ ambiguity: "A1", worthAsking: true }]);
    const user = calls[0]!.messages[0]!.content as string;
    expect(user).toContain("The portal shall lock an account after five failed attempts.");
    expect(user).toContain("R2: A patient shall hold at most two future appointments.");
    expect(user).toContain("A1: unlock is unstated (question: When does a locked account unlock?)");
    expect(user).toContain("E1: lock after five failures");
    expect(user).toContain("Q1: When does it unlock?");
    expect(calls[0]!.opts?.disableTools).toBe(true);
  });

  it("throws when the judge gives no usable reply", async () => {
    const { provider } = stubProvider(["not json at all"]);
    await expect(judgeReading(provider, ITEM, output)).rejects.toThrow(/judge: no usable reply/);
  });
});
