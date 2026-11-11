import { describe, expect, it } from "vitest";
import type { BaQaQuestion } from "./fixture.js";
import {
  buildJudgeMessages,
  clipSpan,
  MAX_SPAN_CHARS,
  MAX_SPAN_LINES,
  parseJudgeVerdict,
} from "./judge.js";

const q: BaQaQuestion = {
  id: "S1",
  category: "single-product",
  scope: ["miniflux"],
  text: "How often?",
  expect: "answer",
  facts: [
    { id: "S1.a", text: "60 minutes" },
    { id: "S1.b", text: "24 hours" },
  ],
  sources: [{ product: "miniflux", path: "a.go" }],
};
const spans = [{ n: 1, label: "miniflux:a.go:1-2", text: "x := 60" }];

describe("buildJudgeMessages", () => {
  it("shows the question, every fact id, the reply and each numbered span", () => {
    const [system, user] = buildJudgeMessages(q, "It is hourly.", spans);
    expect(system.role).toBe("system");
    const text = String(user.content);
    expect(text).toContain("Question: How often?");
    expect(text).toContain("- S1.a: 60 minutes");
    expect(text).toContain("- S1.b: 24 hours");
    expect(text).toContain("It is hourly.");
    expect(text).toContain("[1] miniflux:a.go:1-2");
    expect(text).toContain("x := 60");
  });

  it("shows a multi-turn question's earlier turns before the one graded (#2269)", () => {
    const one = String(buildJudgeMessages(q, "Hourly.", spans)[1].content);
    expect(one).not.toContain("Earlier in this conversation");
    const text = String(
      buildJudgeMessages(
        { ...q, before: ["When are old articles deleted?"], refersBack: true },
        "Daily.",
        spans,
      )[1].content,
    );
    expect(text).toContain(
      "Earlier in this conversation the analyst asked:\n- When are old articles deleted?\n\n" +
        "Question (the reply answers this one): How often?",
    );
  });

  it("says when there are no facts or spans", () => {
    const text = String(
      buildJudgeMessages({ ...q, facts: undefined, expect: "follow-up" }, "Which?", [])[1].content,
    );
    expect(text).toContain("(none — grade behaviour only)");
    expect(text).toContain("Cited spans:\n(none)");
  });
});

describe("clipSpan", () => {
  it("keeps a short span and cuts a long one by lines and by characters", () => {
    expect(clipSpan("a\nb")).toBe("a\nb");
    const many = Array.from({ length: MAX_SPAN_LINES + 5 }, (_, i) => `l${i}`).join("\n");
    const clipped = clipSpan(many);
    expect(clipped.split("\n")).toHaveLength(MAX_SPAN_LINES + 1);
    expect(clipped.endsWith("[… cut]")).toBe(true);
    expect(clipSpan("x".repeat(MAX_SPAN_CHARS + 10))).toHaveLength(MAX_SPAN_CHARS + 8);
  });
});

describe("parseJudgeVerdict", () => {
  const good = {
    behaviour: "answer",
    facts: { "S1.a": "stated", "S1.b": "contradicted" },
    spans: { "1": true },
  };

  it("reads a fenced JSON reply", () => {
    const v = parseJudgeVerdict(`\`\`\`json\n${JSON.stringify(good)}\n\`\`\``, q, spans);
    expect(v).toEqual({
      behaviour: "answer",
      facts: { "S1.a": "stated", "S1.b": "contradicted" },
      spans: { 1: true },
    });
  });

  it("is null for prose, broken JSON or an unknown behaviour", () => {
    expect(parseJudgeVerdict("no json here", q, spans)).toBeNull();
    expect(parseJudgeVerdict("{ behaviour: answer }", q, spans)).toBeNull();
    expect(parseJudgeVerdict(JSON.stringify({ ...good, behaviour: "maybe" }), q, spans)).toBeNull();
  });

  it("is null when a fact or a shown span has no verdict", () => {
    expect(
      parseJudgeVerdict(JSON.stringify({ ...good, facts: { "S1.a": "stated" } }), q, spans),
    ).toBeNull();
    expect(parseJudgeVerdict(JSON.stringify({ ...good, spans: {} }), q, spans)).toBeNull();
  });

  it("needs only a behaviour for a question with no facts and no spans", () => {
    const v = parseJudgeVerdict('{"behaviour": "abstain"}', { ...q, facts: undefined }, []);
    expect(v).toEqual({ behaviour: "abstain", facts: {}, spans: {} });
  });
});
