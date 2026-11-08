/**
 * #1873 — the plain business questions asked for `uncertain` governing rules:
 * the rulebook guard, one question per fact, the open pairs of a dialog, the
 * re-judging of an answer, and the flag gate. The model is a stub that answers
 * by prompt kind and records what it was sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoverningAnalysisApplicability } from "@metis/shared";
import type { AIProvider, ChatMessage, ChatOptions } from "../ai/types.js";

const db = vi.hoisted(() => ({
  project: { findFirst: vi.fn() },
  analysis: { findFirst: vi.fn() },
  governingRule: { findMany: vi.fn() },
}));
vi.mock("../prisma.js", () => ({ prisma: db, resolveDatabaseProvider: () => "sqlite" }));

const {
  GOVERNING_QUESTION_FIELD,
  buildGoverningQuestions,
  governingQuestionRequirementId,
  governingQuestionSourceFor,
  openGoverningPairs,
  questionLeaksRule,
  rejudgeAnswered,
  templateGoverningQuestion,
} = await import("./applicability-questions.js");
type QuestionRule = import("./applicability-questions.js").QuestionRule;
type OpenGoverningPair = import("./applicability-questions.js").OpenGoverningPair;

const CARD: QuestionRule = {
  id: "rule_card",
  controlId: "EN-03",
  summary: "Full card numbers are never stored; only the last four digits.",
  clauseExcerpt:
    "The company never stores a full payment card number in any system; only the last four digits may be kept.",
};
const ENCRYPT: QuestionRule = {
  id: "rule_encrypt",
  controlId: "EN-02",
  summary: "Payment information is encrypted at rest.",
  clauseExcerpt: "Payment information held by the company is encrypted at rest, backups included.",
};
const AUDIT: QuestionRule = {
  id: "rule_audit",
  controlId: "AL-02",
  summary: "Bulk exports of customer records are audit-logged.",
  clauseExcerpt: "Every bulk export of customer records is written to the audit log.",
};
const RULES = new Map([CARD, ENCRYPT, AUDIT].map((r) => [r.id, r]));
const REQ = { id: "REQ-001", text: "Let returning customers check out with a saved card." };

interface Sent {
  kind: "merge" | "rephrase" | "judge";
  system: string;
  user: string;
}

function stubModel(replies: Partial<Record<Sent["kind"], (user: string) => unknown>>) {
  const sent: Sent[] = [];
  const chat = vi.fn(async (messages: ChatMessage[], o: ChatOptions = {}) => {
    const system = String(o.systemMessage ?? "");
    const user = messages.map((m) => String(m.content)).join("\n");
    const kind: Sent["kind"] = system.startsWith("Each numbered question")
      ? "merge"
      : system.startsWith("Rewrite the question")
        ? "rephrase"
        : "judge";
    sent.push({ kind, system, user });
    const body = replies[kind]?.(user) ?? {};
    return {
      content: typeof body === "string" ? body : JSON.stringify(body),
      model: "m",
      provider: "anthropic" as const,
    };
  });
  const provider = {
    key: "anthropic",
    model: "claude-sonnet-4-5",
    offline: false,
    chat,
  } as unknown as AIProvider;
  return { provider, sent, chat };
}

function pair(ruleId: string, businessFact: string, over: Partial<OpenGoverningPair> = {}) {
  return {
    requirementId: REQ.id,
    requirementText: REQ.text,
    ruleId,
    businessFact,
    ...over,
  };
}

/** Every run of `n` consecutive words of `text`, lower-cased, punctuation dropped. */
function runsOf(text: string, n: number): string[] {
  const w = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  return Array.from({ length: Math.max(0, w.length - n + 1) }, (_, i) =>
    w.slice(i, i + n).join(" "),
  );
}

function expectNoRulebook(question: string, rules: readonly QuestionRule[]) {
  for (const r of rules) {
    expect(question.toLowerCase()).not.toContain(r.controlId.toLowerCase());
    const asked = runsOf(question, 8).join("\n");
    for (const run of runsOf(r.clauseExcerpt, 8)) expect(asked).not.toContain(run);
  }
}

describe("questionLeaksRule — the rulebook guard", () => {
  it("#2009 — catches a control id written with other spacing or punctuation", () => {
    const pci = { controlId: "PCI-DSS 3.4", clauseExcerpt: "x" };
    expect(questionLeaksRule("Does PCI DSS 3.4 cover this?", [pci])).toMatch(/names control/);
    expect(questionLeaksRule("Is pci_dss-3.4 met?", [pci])).toMatch(/names control/);
    const cc = { controlId: "CC6.1", clauseExcerpt: "x" };
    expect(questionLeaksRule("Does CC 6.1 apply?", [cc])).toMatch(/names control/);
    expect(questionLeaksRule("Does CC-6-1 apply?", [cc])).toMatch(/names control/);
    expect(questionLeaksRule("Does cc61 apply?", [cc])).toMatch(/names control/);
    // Still whole words: a longer word holding the id is not the id.
    expect(questionLeaksRule("Is ACC 6.1 involved?", [cc])).toBeNull();
    expect(questionLeaksRule("Is CC 6.12 involved?", [cc])).toBeNull();
    expect(
      questionLeaksRule("Is anything involved?", [{ controlId: "--", clauseExcerpt: "x" }]),
    ).toBeNull();
  });

  it("catches a control id as a whole token, in any case", () => {
    expect(questionLeaksRule("Does control EN-03 apply here?", [CARD])).toMatch(/names control/);
    expect(questionLeaksRule("does en-03 apply?", [CARD])).toMatch(/names control/);
    // Part of a longer token is not the id.
    expect(questionLeaksRule("Is OPEN-03X involved?", [CARD])).toBeNull();
    // An id with pattern characters is matched literally, never as a pattern.
    const dotted = { controlId: "4.3.1", clauseExcerpt: "x" };
    expect(questionLeaksRule("Is clause 4.3.1 met?", [dotted])).toMatch(/names control 4\.3\.1/);
    expect(questionLeaksRule("Is 4x3y1 met?", [dotted])).toBeNull();
    expect(questionLeaksRule("Is (A+) met?", [{ controlId: "(A+)", clauseExcerpt: "x" }])).toMatch(
      /names control/,
    );
  });

  it("catches 8 or more consecutive clause words, ignoring case and punctuation; 7 is allowed", () => {
    const eight = "Will it — never stores a full payment card number in any — system?";
    expect(questionLeaksRule(eight, [CARD])).toMatch(/quotes 8\+ words/);
    const seven = "Does the company never store a full payment card number at checkout?";
    expect(questionLeaksRule(seven, [CARD])).toBeNull();
    expect(questionLeaksRule("Will the page keep customers' card numbers?", [CARD])).toBeNull();
  });

  it("the template names no rule and quotes no clause, even when the requirement names a control", () => {
    expectNoRulebook(templateGoverningQuestion(REQ.text, [CARD]), [CARD]);
    const named = templateGoverningQuestion("Make checkout meet EN-03.", [CARD]);
    expect(named).not.toContain("EN-03");
    expect(named).toMatch(/^To check this requirement against company policy/);
  });
});

describe("buildGoverningQuestions", () => {
  it("one uncertain pair: exactly one question, tagged governing with that rule, in plain words, with no model call", async () => {
    const { provider, chat } = stubModel({});
    const questions = await buildGoverningQuestions(
      [pair(CARD.id, "Will the saved card keep the customer's full card number?")],
      RULES,
      { provider },
    );
    expect(questions).toHaveLength(1);
    const q = questions[0]!;
    expect(q).toMatchObject({
      // #2009 — namespaced: the bare id would name the reviewed list's REQ-001.
      requirementId: `governing:${REQ.id}`,
      ambiguityField: GOVERNING_QUESTION_FIELD,
      question: "Will the saved card keep the customer's full card number?",
      governing: { kind: "governing", ruleIds: [CARD.id], requirementId: REQ.id },
    });
    expectNoRulebook(q.question, [CARD]);
    expect(q.context).toContain(REQ.text);
    expect(chat).not.toHaveBeenCalled();
  });

  it("a fact that names the control is re-asked once in plain words", async () => {
    const { provider, sent } = stubModel({
      rephrase: () => ({ question: "Will customers' whole card numbers be kept after checkout?" }),
    });
    const [q] = await buildGoverningQuestions(
      [pair(CARD.id, "Does EN-03 apply to the saved card?")],
      RULES,
      { provider },
    );
    expect(sent.map((s) => s.kind)).toEqual(["rephrase"]);
    expect(sent[0]!.system).toContain("Never name a policy, rule, control or control id");
    expect(q!.question).toBe("Will customers' whole card numbers be kept after checkout?");
    expectNoRulebook(q!.question, [CARD]);
  });

  it("a re-ask that still quotes the clause falls back to the template", async () => {
    const quote = `Is it true that the company ${CARD.clauseExcerpt}`;
    const { provider, sent } = stubModel({ rephrase: () => ({ question: quote }) });
    const [q] = await buildGoverningQuestions([pair(CARD.id, quote)], RULES, { provider });
    expect(sent.map((s) => s.kind)).toEqual(["rephrase"]);
    expect(q!.question).toBe(templateGoverningQuestion(REQ.text, [CARD, ENCRYPT, AUDIT]));
    expectNoRulebook(q!.question, [CARD]);
  });

  it("an unreadable re-ask falls back to the template too", async () => {
    const { provider } = stubModel({ rephrase: () => "no json" });
    const [q] = await buildGoverningQuestions([pair(CARD.id, "Does EN-03 apply?")], RULES, {
      provider,
    });
    expect(q!.question).toMatch(/^To check /);
  });

  it("two rules hinging on the same fact give ONE question linked to both", async () => {
    const { provider, chat } = stubModel({});
    const questions = await buildGoverningQuestions(
      [
        pair(CARD.id, "Will this feature store customers' payment data?"),
        pair(ENCRYPT.id, "will this feature store customers' payment data"),
      ],
      RULES,
      { provider },
    );
    expect(questions).toHaveLength(1);
    expect(questions[0]!.governing?.ruleIds).toEqual([CARD.id, ENCRYPT.id]);
    expect(chat).not.toHaveBeenCalled();
  });

  it("the same fact in different words: the model merges them, and the question links both rules", async () => {
    const { provider, sent } = stubModel({
      merge: () => ({
        questions: [
          { question: "Will this feature store customers' payment data?", facts: ["F1", "F2"] },
          { question: "Will each saved-card export be logged?", facts: ["F3"] },
        ],
      }),
    });
    const questions = await buildGoverningQuestions(
      [
        pair(CARD.id, "Will the saved card be kept with the whole number?"),
        pair(ENCRYPT.id, "Is payment information stored by this feature?"),
        pair(AUDIT.id, "Will anyone export the saved cards in bulk?"),
      ],
      RULES,
      { provider },
    );
    expect(sent.map((s) => s.kind)).toEqual(["merge"]);
    expect(sent[0]!.user).toContain("F1: Will the saved card be kept with the whole number?");
    expect(sent[0]!.user).not.toContain("EN-03");
    expect(questions.map((q) => q.governing?.ruleIds)).toEqual([[CARD.id, ENCRYPT.id], [AUDIT.id]]);
  });

  it("a merge reply that drops a fact, repeats one or cannot be read never drops a question", async () => {
    const facts = [
      pair(CARD.id, "Will the saved card be kept with the whole number?"),
      pair(ENCRYPT.id, "Is payment information stored by this feature?"),
    ];
    const partial = stubModel({
      merge: () => ({
        questions: [
          { question: "Will card data be stored?", facts: ["F1", "F1", "F9"] },
          { question: "  ", facts: ["F2"] },
        ],
      }),
    });
    const got = await buildGoverningQuestions(facts, RULES, { provider: partial.provider });
    expect(got.map((q) => q.governing?.ruleIds)).toEqual([[CARD.id], [ENCRYPT.id]]);
    const broken = stubModel({ merge: () => "not json" });
    const again = await buildGoverningQuestions(facts, RULES, { provider: broken.provider });
    expect(again.map((q) => q.question)).toEqual(facts.map((f) => f.businessFact));
  });

  it("questions stay per requirement, and a pair whose rule is gone is not asked", async () => {
    const { provider } = stubModel({});
    const questions = await buildGoverningQuestions(
      [
        pair(CARD.id, "Will the card be kept?"),
        pair(AUDIT.id, "Will exports be bulk?", { requirementId: "REQ-002", requirementText: "B" }),
        pair("rule_deleted", "Anything else?"),
      ],
      RULES,
      { provider },
    );
    expect(questions.map((q) => [q.governing?.requirementId, q.governing?.ruleIds])).toEqual([
      ["REQ-001", [CARD.id]],
      ["REQ-002", [AUDIT.id]],
    ]);
    expect(questions.map((q) => q.requirementId)).toEqual([
      governingQuestionRequirementId("REQ-001"),
      governingQuestionRequirementId("REQ-002"),
    ]);
  });

  it("#2009 — a governing question's requirementId never matches a reviewed requirement's id", async () => {
    const { orderQuestionsAskFirst } = await import("../analysis/clarification-dialog.js");
    const { provider } = stubModel({});
    const [q] = await buildGoverningQuestions([pair(CARD.id, "Will the card be kept?")], RULES, {
      provider,
    });
    // The reviewed list has its own REQ-001: ticking it must not promote the
    // question about the analysis's REQ-001, a different requirement.
    const ambiguity = { ...q!, id: "a1", requirementId: "REQ-002", governing: undefined };
    expect(orderQuestionsAskFirst([ambiguity, q!], new Set(["REQ-001"])).map((x) => x.id)).toEqual([
      "a1",
      q!.id,
    ]);
    expect(q!.requirementId).not.toBe(REQ.id);
  });
});

const STORED: GoverningAnalysisApplicability = {
  decidedAt: "2026-11-08T00:00:00.000Z",
  requirements: [
    {
      requirementId: REQ.id,
      text: REQ.text,
      decisions: [
        {
          ruleId: CARD.id,
          controlId: CARD.controlId,
          verdict: "uncertain",
          reason: "Depends on what is kept.",
          businessFact: "Will the full card number be kept?",
          foundBy: ["screen"],
        },
        {
          ruleId: ENCRYPT.id,
          controlId: ENCRYPT.controlId,
          verdict: "uncertain",
          reason: "Depends on what is kept.",
          businessFact: "Will the full card number be kept?",
          foundBy: ["top-k"],
        },
        {
          ruleId: AUDIT.id,
          controlId: AUDIT.controlId,
          verdict: "applies",
          reason: "Reads records.",
          foundBy: ["screen"],
        },
      ],
    },
  ],
};

describe("openGoverningPairs", () => {
  it("every uncertain, unsettled pair; never an applies one", () => {
    expect(openGoverningPairs(STORED, undefined).map((p) => p.ruleId)).toEqual([
      CARD.id,
      ENCRYPT.id,
    ]);
  });

  it("a pair whose question was answered is not asked again; an unanswered one is", () => {
    const question = (answer?: string) => ({
      id: "q1",
      requirementId: REQ.id,
      ambiguityField: GOVERNING_QUESTION_FIELD,
      question: "Will the full card number be kept?",
      context: "",
      governing: { kind: "governing" as const, ruleIds: [CARD.id], requirementId: REQ.id },
      ...(answer !== undefined ? { answer } : {}),
    });
    const state = (answer?: string) => ({
      rounds: [{ round: 1, questions: [question(answer)], answers: [] }],
    });
    expect(
      openGoverningPairs(STORED, state("No, only the last four digits.")).map((p) => p.ruleId),
    ).toEqual([ENCRYPT.id]);
    expect(openGoverningPairs(STORED, state("   ")).map((p) => p.ruleId)).toEqual([
      CARD.id,
      ENCRYPT.id,
    ]);
  });

  it("a settled pair is not asked again", () => {
    const settled = structuredClone(STORED);
    settled.requirements[0]!.decisions[0]!.settled = {
      questionId: "q0",
      answer: "No",
      previousVerdict: "uncertain",
      at: "2026-11-08T00:00:00.000Z",
    };
    expect(openGoverningPairs(settled, undefined).map((p) => p.ruleId)).toEqual([ENCRYPT.id]);
  });
});

describe("rejudgeAnswered — the answer is judged back onto the rules it settles", () => {
  const rules = new Map(
    [CARD, ENCRYPT].map((r) => [r.id, { ...r, revisionId: "rev_1", source: "Policy v1 §4" }]),
  );
  const answered = {
    id: "q1",
    requirementId: REQ.id,
    ambiguityField: GOVERNING_QUESTION_FIELD,
    question: "Will the full card number be kept?",
    context: "",
    answer: "Yes, the whole number is stored so customers can reuse it.",
    governing: {
      kind: "governing" as const,
      ruleIds: [CARD.id, ENCRYPT.id],
      requirementId: REQ.id,
    },
  };

  it("one judging call with the question and answer in the requirement; each rule gets the new verdict", async () => {
    const { provider, sent } = stubModel({
      judge: () => ({
        decisions: [
          { rule: "R1", verdict: "applies", reason: "Full numbers are stored." },
          { rule: "R2", verdict: "does-not-apply", reason: "Encryption is the vault's." },
        ],
      }),
    });
    const settlements = await rejudgeAnswered([answered], STORED, rules, { provider });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.user).toContain("Their answer: Yes, the whole number is stored");
    expect(sent[0]!.user).toContain("R1 [EN-03]");
    expect(settlements).toEqual([
      expect.objectContaining({ ruleId: CARD.id, verdict: "applies", questionId: "q1" }),
      expect.objectContaining({ ruleId: ENCRYPT.id, verdict: "does-not-apply" }),
    ]);
  });

  it("a rule the reply leaves out stays uncertain; a failed call settles nothing; unanswered questions are skipped", async () => {
    const partial = stubModel({
      judge: () => ({ decisions: [{ rule: "R1", verdict: "applies", reason: "y" }] }),
    });
    const got = await rejudgeAnswered([answered], STORED, rules, { provider: partial.provider });
    expect(got.map((s) => [s.ruleId, s.verdict])).toEqual([
      [CARD.id, "applies"],
      [ENCRYPT.id, "uncertain"],
    ]);
    const failing = stubModel({});
    vi.mocked(failing.chat).mockRejectedValueOnce(new Error("rate limited"));
    expect(
      await rejudgeAnswered([answered], STORED, rules, { provider: failing.provider }),
    ).toEqual([]);
    const none = stubModel({});
    expect(
      await rejudgeAnswered([{ ...answered, answer: " " }], STORED, rules, {
        provider: none.provider,
      }),
    ).toEqual([]);
    expect(none.chat).not.toHaveBeenCalled();
  });

  it("#2009 — an unreadable reply is re-asked once; unreadable again, it settles nothing", async () => {
    const unreadable = stubModel({ judge: () => "I cannot answer that." });
    expect(
      await rejudgeAnswered([answered], STORED, rules, { provider: unreadable.provider }),
    ).toEqual([]);
    expect(unreadable.sent.map((x) => x.kind)).toEqual(["judge", "judge"]);
    expect(unreadable.sent[1]!.system).toContain("Your previous answer");
  });

  it("#2009 — an unreadable first reply is re-asked, and the readable second one settles", async () => {
    let call = 0;
    const second = stubModel({
      judge: () =>
        call++ === 0
          ? "not json"
          : { decisions: [{ rule: "R1", verdict: "applies", reason: "Kept whole." }] },
    });
    const got = await rejudgeAnswered([answered], STORED, rules, { provider: second.provider });
    expect(got.map((x) => [x.ruleId, x.verdict])).toEqual([
      [CARD.id, "applies"],
      [ENCRYPT.id, "uncertain"],
    ]);
    expect(second.sent).toHaveLength(2);
  });
});

describe("governingQuestionSourceFor — the flag gate", () => {
  beforeEach(() => {
    db.project.findFirst.mockReset();
    db.analysis.findFirst.mockReset();
    db.governingRule.findMany.mockReset();
  });
  afterEach(() => {
    delete process.env.GOVERNING_DOCS_ENABLED;
  });

  it("flag off: no source, and nothing is read", () => {
    const { provider } = stubModel({});
    expect(
      governingQuestionSourceFor({ analysisId: "a", projectId: "p", provider }),
    ).toBeUndefined();
    expect(db.project.findFirst).not.toHaveBeenCalled();
  });

  it("flag on: a source", () => {
    process.env.GOVERNING_DOCS_ENABLED = "true";
    const { provider } = stubModel({});
    expect(governingQuestionSourceFor({ analysisId: "a", projectId: "p", provider })).toBeDefined();
  });

  const answeredQ = {
    id: "q1",
    requirementId: REQ.id,
    ambiguityField: GOVERNING_QUESTION_FIELD,
    question: "Will the full card number be kept?",
    context: "",
    answer: "Yes.",
    governing: { kind: "governing" as const, ruleIds: [CARD.id], requirementId: REQ.id },
  };

  it("an offline provider asks and settles nothing, and reads nothing", async () => {
    process.env.GOVERNING_DOCS_ENABLED = "1";
    const { provider, chat } = stubModel({});
    (provider as { offline: boolean }).offline = true;
    const source = governingQuestionSourceFor({ analysisId: "a", projectId: "p", provider })!;
    expect(await source.open(undefined)).toEqual([]);
    await source.settle([answeredQ]);
    expect(db.analysis.findFirst).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });

  it("nothing stored, no open pair, or no answered question: nothing asked, judged or read further", async () => {
    process.env.GOVERNING_DOCS_ENABLED = "1";
    const { provider, chat } = stubModel({});
    const source = governingQuestionSourceFor({ analysisId: "a", projectId: "p", provider })!;
    db.analysis.findFirst.mockResolvedValue({ metadata: "{}" });
    expect(await source.open(undefined)).toEqual([]);
    await source.settle([answeredQ]);
    const allSettled = structuredClone(STORED);
    allSettled.requirements[0]!.decisions = [allSettled.requirements[0]!.decisions[2]!];
    db.analysis.findFirst.mockResolvedValue({
      metadata: JSON.stringify({ governingApplicability: allSettled }),
    });
    expect(await source.open(undefined)).toEqual([]);
    await source.settle([{ ...answeredQ, answer: "" }]);
    expect(db.project.findFirst).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });

  it("#2009 — settle skips a question whose linked pairs are all settled, with no rule read or model call", async () => {
    process.env.GOVERNING_DOCS_ENABLED = "1";
    const { provider, chat } = stubModel({});
    const source = governingQuestionSourceFor({ analysisId: "a", projectId: "p", provider })!;
    const settled = structuredClone(STORED);
    settled.requirements[0]!.decisions[0]!.settled = {
      questionId: "q1",
      answer: "Yes.",
      previousVerdict: "uncertain",
      at: "2026-11-08T00:00:00.000Z",
    };
    db.analysis.findFirst.mockResolvedValue({
      metadata: JSON.stringify({ governingApplicability: settled }),
    });
    await source.settle([answeredQ, { ...answeredQ, governing: undefined }]);
    expect(db.project.findFirst).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });

  it("a project with no workspace finds no rules, so asks nothing", async () => {
    process.env.GOVERNING_DOCS_ENABLED = "1";
    const { provider, chat } = stubModel({});
    const source = governingQuestionSourceFor({ analysisId: "a", projectId: "p", provider })!;
    db.analysis.findFirst.mockResolvedValue({
      metadata: JSON.stringify({ governingApplicability: STORED }),
    });
    db.project.findFirst.mockResolvedValue({ workspaceId: null });
    expect(await source.open(undefined)).toEqual([]);
    expect(db.governingRule.findMany).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });
});
