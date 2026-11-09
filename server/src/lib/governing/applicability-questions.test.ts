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
  governingFinding: { findMany: vi.fn() },
}));
vi.mock("../prisma.js", () => ({ prisma: db, resolveDatabaseProvider: () => "sqlite" }));

const {
  GOVERNING_QUESTION_FIELD,
  answersForApplyingPairs,
  buildGoverningQuestions,
  carryAnswersOver,
  carryCandidates,
  governingQuestionRequirementId,
  governingQuestionSourceFor,
  hasApplyingPair,
  openFindingPairs,
  openGoverningPairs,
  questionLeaksRule,
  rejudgeAnswered,
  templateGoverningQuestion,
} = await import("./applicability-questions.js");
const { FALLBACK_FINDING_QUESTION } = await import("./findings.js");
const { ANSWER_NOTE, CARRIED_ANSWER_NOTE } = await import("./applicability.js");
const { applySettlements } = await import("./applicability-store.js");
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
  it("#2009 — a short control id matches verbatim only, not across prose words", () => {
    const a1 = { controlId: "A.1", clauseExcerpt: "x" };
    expect(questionLeaksRule("Is there a 1-to-1 mapping?", [a1])).toBeNull();
    expect(questionLeaksRule("Does A.1 apply?", [a1])).toMatch(/names control/);
    const r34 = { controlId: "3.4", clauseExcerpt: "x" };
    expect(questionLeaksRule("Are 3 4 users affected?", [r34])).toBeNull();
    expect(questionLeaksRule("Does 3.4 apply?", [r34])).toMatch(/names control/);
  });

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

  it("#2077 — catches a question that points at a rule or clause as such, which names no id", () => {
    const retention = {
      controlId: "DR-01",
      clauseExcerpt: "Customer records are kept for seven years after the account is closed.",
    };
    // DeepSeek's question in #2066's reading of governing-01.
    const deepseek = "Will the exported orders be kept under the seven-year retention rule?";
    expect(questionLeaksRule(deepseek, [retention])).toBe("refers to a rule");
    expect(questionLeaksRule("Which Clauses cover the export?", [retention])).toBe(
      "refers to a clause",
    );
    // A control id is still reported as such.
    expect(questionLeaksRule("Does rule DR-01 apply?", [retention])).toMatch(/names control/);
    // Business words that only contain one, and a business policy, are not the rulebook.
    expect(
      questionLeaksRule("Will the ruler tool overrule a returns policy?", [retention]),
    ).toBeNull();
    expect(questionLeaksRule(FALLBACK_FINDING_QUESTION, [retention])).toBeNull();
  });

  it("#2086 — refuses a rulebook reference by its phrase shape, not the bare word", () => {
    const retention = { controlId: "DR-01", clauseExcerpt: "Records are kept for seven years." };
    // Everyday analyst words: a rule or clause that modifies another noun, or
    // one with no determiner pointing at a particular rulebook entry.
    for (const plain of [
      "Does the pricing rules engine apply discounts?",
      "Will business rules decide the discount?",
      "Is the approval rule-based or manual?",
      "Is there a validation rule on the email field?",
      "Will pricing rules change each quarter?",
      "Does a contract clause cap the refund?",
      "Will customers agree to the returns policy?",
      "Will the business rules change next year?",
      // Punctuation ends a phrase: "the export" does not open "rules apply".
      "After the export, rules apply to discounts?",
      "After the export — rules apply to discounts?",
    ]) {
      expect(questionLeaksRule(plain, [retention]), plain).toBeNull();
    }
    // A particular rule, clause or policy of the rulebook.
    for (const [refused, why] of [
      ["Does this meet the seven-year retention rule?", "refers to a rule"],
      ["Does the retention rule apply here?", "refers to a rule"],
      ["Do the company's data retention rules cover backups?", "refers to a rule"],
      ["Which clause covers the export?", "refers to a clause"],
      ["Is this allowed under rule 12?", "refers to a rule"],
      ["Does clause 4b allow it?", "refers to a clause"],
      ["Is it kept under the data retention policy?", "refers to a policy"],
      ["Is this allowed by our privacy policies?", "refers to a policy"],
    ] as const) {
      expect(questionLeaksRule(refused, [retention]), refused).toBe(why);
    }
  });

  it("#2098 — a verb between the subject and the rulebook noun stops the look-back", () => {
    const retention = { controlId: "DR-01", clauseExcerpt: "Records are kept for seven years." };
    // The determiner belongs to the subject, not to the rules: everyday rules-engine questions.
    for (const plain of [
      "Does the app use pricing rules?",
      "Does the checkout run business rules?",
      "Does the system follow rules for refunds?",
      "Does the engine enforce rules that cap discounts?",
      "Does the order meet rules for refunds?",
      "Does the platform obey rules for discounts?",
      "Does the workflow include rules for approvals?",
    ]) {
      expect(questionLeaksRule(plain, [retention]), plain).toBeNull();
    }
    // A determiner after the verb still points at a particular rule, and a
    // policy reference reads past a verb-shaped modifier ("acceptable use").
    for (const [refused, why] of [
      ["Does the app use the pricing rules?", "refers to a rule"],
      ["Does the engine enforce the retention rule?", "refers to a rule"],
      ["Is the export allowed under the acceptable use policy?", "refers to a policy"],
    ] as const) {
      expect(questionLeaksRule(refused, [retention]), refused).toBe(why);
    }
  });

  it("#2098 — a possessive rulebook noun heads its phrase", () => {
    const retention = { controlId: "DR-01", clauseExcerpt: "Records are kept for seven years." };
    for (const [refused, why] of [
      ["Does the export meet the retention rule's limit?", "refers to a rule"],
      ["Does the export meet the retention rule’s limit?", "refers to a rule"],
      ["Does the export meet the retention rules' limits?", "refers to a rule"],
      ["Does the export meet the retention rules’ limits?", "refers to a rule"],
      ["Is it allowed by the retention policy's terms?", "refers to a policy"],
      ["What does the export clause's wording cover?", "refers to a clause"],
    ] as const) {
      expect(questionLeaksRule(refused, [retention]), refused).toBe(why);
    }
    // A possessive with no determiner pointing at it is still a business fact.
    for (const plain of [
      "Will business rules' outcomes change the discount?",
      "Do customers agree to a returns policy's terms?",
    ]) {
      expect(questionLeaksRule(plain, [retention]), plain).toBeNull();
    }
  });

  it("#2098 — a company's possessive alone opens a rulebook phrase, in either apostrophe", () => {
    const retention = { controlId: "DR-01", clauseExcerpt: "Records are kept for seven years." };
    // No other determiner in reach: only company's / company’s can refuse these.
    expect(questionLeaksRule("Are backups kept per company's retention rules?", [retention])).toBe(
      "refers to a rule",
    );
    expect(questionLeaksRule("Are backups kept per company’s retention rules?", [retention])).toBe(
      "refers to a rule",
    );
  });

  it("#2086 — words quoted from the requirement never trip the rulebook-phrase check in the template", () => {
    for (const text of [
      "Apply the pricing rules engine to every order.",
      "Make the checkout follow the seven-year retention rule.",
      "Store orders under the data retention policy.",
    ]) {
      const q = templateGoverningQuestion(text, [CARD]);
      expect(q, text).toContain(`"${text}"`);
    }
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
    // #2077 — the model is asked for the merged groups only: a fact left alone
    // keeps its own words (#2066), so writing it again is output thrown away.
    expect(sent[0]!.system).toContain("leave them out of your reply");
    expect(sent[0]!.system).toContain("listing only merged questions, each with two or more facts");
    expect(sent[0]!.system).not.toContain("every fact in exactly one question");
    expect(sent[0]!.user).toContain("F1: Will the saved card be kept with the whole number?");
    expect(sent[0]!.user).not.toContain("EN-03");
    expect(questions.map((q) => q.governing?.ruleIds)).toEqual([[CARD.id, ENCRYPT.id], [AUDIT.id]]);
  });

  it("#2077 — a reply listing only the merged group asks every other fact in its own words", async () => {
    const { provider } = stubModel({
      merge: () => ({
        questions: [
          { question: "Will this feature store customers' payment data?", facts: ["F1", "F2"] },
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
    expect(questions.map((q) => [q.question, q.governing?.ruleIds])).toEqual([
      ["Will this feature store customers' payment data?", [CARD.id, ENCRYPT.id]],
      ["Will anyone export the saved cards in bulk?", [AUDIT.id]],
    ]);
  });

  it("#2066 — a group the merge leaves alone keeps its own question, verbatim, whatever the model wrote", async () => {
    const { provider } = stubModel({
      merge: () => ({
        questions: [
          { question: "Will this feature store customers' payment data?", facts: ["F1", "F2"] },
          { question: "Do you already log each bulk export of saved cards?", facts: ["F3"] },
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
    expect(questions.map((q) => q.question)).toEqual([
      "Will this feature store customers' payment data?",
      "Will anyone export the saved cards in bulk?",
    ]);
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
    // #2066 — F1 came back alone, so its own wording stands.
    expect(got.map((q) => q.question)).toEqual(facts.map((f) => f.businessFact));
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

describe("#2059 — a Needs BA input finding on a rule that applies is asked", () => {
  const AUDIT_QUESTION = "Will every export of customer records be logged?";
  const finding = (over: Partial<Record<string, unknown>> = {}) => ({
    requirementId: REQ.id,
    ruleId: AUDIT.id,
    status: "needs-ba-input" as const,
    businessQuestion: AUDIT_QUESTION,
    ...over,
  });
  const question = (ruleIds: string[], answer?: string) => ({
    id: "q-audit",
    requirementId: REQ.id,
    ambiguityField: GOVERNING_QUESTION_FIELD,
    question: AUDIT_QUESTION,
    context: "",
    governing: { kind: "governing" as const, ruleIds, requirementId: REQ.id },
    ...(answer !== undefined ? { answer } : {}),
  });

  it("openFindingPairs: the finding's question, for an applies pair only", () => {
    expect(openFindingPairs(STORED, [finding()], undefined)).toEqual([
      {
        requirementId: REQ.id,
        requirementText: REQ.text,
        ruleId: AUDIT.id,
        businessFact: AUDIT_QUESTION,
      },
    ]);
    // A gap or compliant finding asks nothing; nor does one on an uncertain
    // pair (openGoverningPairs asks applicability's fact), nor on a pair or a
    // requirement the stored applicability does not hold; a repeat is asked once.
    expect(
      openFindingPairs(
        STORED,
        [
          finding({ status: "gap" }),
          finding({ status: "compliant" }),
          finding({ ruleId: CARD.id }),
          finding({ ruleId: "rule_gone" }),
          finding({ requirementId: "REQ-404" }),
        ],
        undefined,
      ),
    ).toEqual([]);
    expect(openFindingPairs(STORED, [finding(), finding()], undefined)).toHaveLength(1);
  });

  it("#2068 — a finding with no question of its own, a dropped citation or a BA decision is not asked", () => {
    expect(
      openFindingPairs(
        STORED,
        [
          finding({ businessQuestion: null }),
          finding({ businessQuestion: "  " }),
          finding({ businessQuestion: FALLBACK_FINDING_QUESTION }),
          finding({ businessQuestion: ` ${FALLBACK_FINDING_QUESTION} ` }),
          finding({ citationDropped: true }),
          finding({ decision: "accepted" }),
          finding({ decision: "rejected" }),
        ],
        undefined,
      ),
    ).toEqual([]);
    // Each filter alone: the same finding without it is asked.
    expect(
      openFindingPairs(STORED, [finding({ citationDropped: false, decision: null })], undefined),
    ).toHaveLength(1);
  });

  it("openFindingPairs: not again once answered in the dialog, or once an answer is recorded", () => {
    const state = (answer?: string) => ({
      rounds: [{ round: 1, questions: [question([AUDIT.id], answer)], answers: [] }],
    });
    expect(openFindingPairs(STORED, [finding()], state("Yes, we do."))).toEqual([]);
    expect(openFindingPairs(STORED, [finding()], state(" "))).toHaveLength(1);
    const recorded = structuredClone(STORED);
    recorded.requirements[0]!.decisions[2]!.settled = {
      questionId: "q-audit",
      answer: "Yes, we do.",
      previousVerdict: "applies",
      at: "2026-11-08T00:00:00.000Z",
    };
    expect(openFindingPairs(recorded, [finding()], undefined)).toEqual([]);
    expect(hasApplyingPair(STORED)).toBe(true);
    expect(hasApplyingPair(recorded)).toBe(true);
    const none = structuredClone(STORED);
    none.requirements[0]!.decisions = none.requirements[0]!.decisions.slice(0, 2);
    expect(hasApplyingPair(none)).toBe(false);
  });

  describe("#2068 — after an answer, a finding still Needs BA input asks its new question", () => {
    type Settlement = NonNullable<
      GoverningAnalysisApplicability["requirements"][number]["decisions"][number]["settled"]
    >;
    const NEW_QUESTION = "Who reviews the export log, and how often?";
    const ANSWERED_AT = "2026-11-08T00:00:00.000Z";
    const BEFORE = new Date("2026-11-07T23:59:59.000Z");
    const AFTER = new Date("2026-11-08T00:00:05.000Z");
    const answeredState = {
      rounds: [{ round: 1, questions: [question([AUDIT.id], "Yes, we do.")], answers: [] }],
    };
    const recordedWith = (settled: Partial<Settlement> = {}) => {
      const r = structuredClone(STORED);
      r.requirements[0]!.decisions[2]!.settled = {
        questionId: "q-audit",
        question: AUDIT_QUESTION,
        answer: "Yes, we do.",
        previousVerdict: "applies",
        at: ANSWERED_AT,
        ...settled,
      };
      return r;
    };

    it("asked once the findings were produced again after the answer, with a question the pair was not asked", () => {
      expect(
        openFindingPairs(
          recordedWith(),
          [finding({ businessQuestion: NEW_QUESTION, updatedAt: AFTER })],
          answeredState,
        ),
      ).toEqual([
        {
          requirementId: REQ.id,
          requirementText: REQ.text,
          ruleId: AUDIT.id,
          businessFact: NEW_QUESTION,
        },
      ]);
      // A timestamp read off the wire is a string; it counts the same.
      expect(
        openFindingPairs(
          recordedWith(),
          [finding({ businessQuestion: NEW_QUESTION, updatedAt: AFTER.toISOString() })],
          undefined,
        ),
      ).toHaveLength(1);
    });

    it("not before the refresh has read the answer, nor without a time to tell", () => {
      for (const updatedAt of [BEFORE, new Date(ANSWERED_AT), undefined]) {
        expect(
          openFindingPairs(
            recordedWith(),
            [finding({ businessQuestion: NEW_QUESTION, updatedAt })],
            answeredState,
          ),
        ).toEqual([]);
      }
    });

    it("not the question already answered, in any case or punctuation, nor an earlier one", () => {
      for (const businessQuestion of [
        AUDIT_QUESTION,
        "will every export of customer records be logged",
      ]) {
        expect(
          openFindingPairs(
            recordedWith({ question: undefined }),
            [finding({ businessQuestion, updatedAt: AFTER })],
            answeredState,
          ),
        ).toEqual([]);
        // The settlement's copy of the question is read where the dialog is gone.
        expect(
          openFindingPairs(
            recordedWith(),
            [finding({ businessQuestion, updatedAt: AFTER })],
            undefined,
          ),
        ).toEqual([]);
      }
      const twice = recordedWith({
        questionId: "q-2",
        question: NEW_QUESTION,
        earlier: [
          {
            questionId: "q-audit",
            question: AUDIT_QUESTION,
            answer: "Yes.",
            at: "2026-11-07T00:00:00.000Z",
          },
        ],
      });
      expect(openFindingPairs(twice, [finding({ updatedAt: AFTER })], undefined)).toEqual([]);
    });

    it("not while an answer in the dialog is not yet recorded on the pair", () => {
      const pending = {
        rounds: [
          ...answeredState.rounds,
          { round: 2, questions: [{ ...question([AUDIT.id], "Weekly."), id: "q-2" }], answers: [] },
        ],
      };
      expect(
        openFindingPairs(
          recordedWith(),
          [finding({ businessQuestion: "A third question?", updatedAt: AFTER })],
          pending,
        ),
      ).toEqual([]);
      // Answered in the dialog, nothing recorded yet (the settle failed): wait.
      expect(
        openFindingPairs(
          STORED,
          [finding({ businessQuestion: NEW_QUESTION, updatedAt: AFTER })],
          answeredState,
        ),
      ).toEqual([]);
    });
  });

  it("buildGoverningQuestions guards a finding's question and links it to its rule", async () => {
    const { provider, sent } = stubModel({
      rephrase: () => ({ question: "Will each bulk export of customer records be recorded?" }),
    });
    const [q] = await buildGoverningQuestions(
      openFindingPairs(
        STORED,
        [finding({ businessQuestion: "Does the export meet AL-02?" })],
        undefined,
      ),
      RULES,
      { provider },
    );
    expect(sent.map((x) => x.kind)).toEqual(["rephrase"]);
    expect(q).toMatchObject({
      question: "Will each bulk export of customer records be recorded?",
      governing: { kind: "governing", ruleIds: [AUDIT.id], requirementId: REQ.id },
    });
    expectNoRulebook(q!.question, [AUDIT]);
  });

  it("answersForApplyingPairs: the answer, kept with its question, on each linked applies pair", () => {
    const answered = question([AUDIT.id, CARD.id], "  Yes, we do. ");
    expect(answersForApplyingPairs([answered], STORED)).toEqual([
      {
        requirementId: REQ.id,
        ruleId: AUDIT.id,
        verdict: "applies",
        reason: "Reads records.",
        questionId: "q-audit",
        question: AUDIT_QUESTION,
        answer: "Yes, we do.",
      },
    ]);
    // Unanswered, unlinked, about another requirement, or already recorded: none.
    expect(answersForApplyingPairs([question([AUDIT.id], " ")], STORED)).toEqual([]);
    expect(answersForApplyingPairs([{ ...answered, governing: undefined }], STORED)).toEqual([]);
    expect(
      answersForApplyingPairs(
        [{ ...answered, governing: { ...answered.governing, requirementId: "REQ-404" } }],
        STORED,
      ),
    ).toEqual([]);
    const recorded = structuredClone(STORED);
    recorded.requirements[0]!.decisions[2]!.settled = {
      questionId: "q-audit",
      answer: "Yes, we do.",
      previousVerdict: "applies",
      at: "2026-11-08T00:00:00.000Z",
    };
    expect(answersForApplyingPairs([answered], recorded)).toEqual([]);
    // #2068 — a later question's answer on the same pair is recorded too.
    const earlier = structuredClone(recorded);
    earlier.requirements[0]!.decisions[2]!.settled!.questionId = "q0";
    expect(answersForApplyingPairs([answered], earlier)).toEqual([
      expect.objectContaining({ ruleId: AUDIT.id, questionId: "q-audit" }),
    ]);
    earlier.requirements[0]!.decisions[2]!.settled!.earlier = [
      { questionId: "q-audit", answer: "Yes.", at: "2026-11-07T00:00:00.000Z" },
    ];
    expect(answersForApplyingPairs([answered], earlier)).toEqual([]);
    // Two questions answering the same pair: the first answer is the one recorded.
    expect(
      answersForApplyingPairs([answered, { ...answered, id: "q-2", answer: "No." }], STORED),
    ).toEqual([expect.objectContaining({ questionId: "q-audit" })]);
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
    // #2067 — the settle judge is told that a safeguard in place still applies.
    expect(sent[0]!.system).toContain(ANSWER_NOTE);
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
    expect(unreadable.sent[1]!.system).toContain(ANSWER_NOTE);
  });

  it("#2067 — the settle sends ANSWER_NOTE, and the recorded reply is stored as applies with its answer", async () => {
    const SUPPLIER = {
      id: "rule_supplier",
      revisionId: "rev_1",
      controlId: "VM-01",
      summary: "A supplier passes the security review and signs the data agreement first.",
      clauseExcerpt:
        "Before any supplier receives personal information, it passes the supplier security review and signs the data protection agreement.",
      source: "Policy v1 §9",
    };
    const requirement = {
      requirementId: "GR-06",
      text: "Send the list of last quarter's buyers to SurveyCo so they can email each buyer a short satisfaction questionnaire.",
      decisions: [
        {
          ruleId: SUPPLIER.id,
          controlId: SUPPLIER.controlId,
          verdict: "uncertain" as const,
          reason: "Depends on the supplier review.",
          businessFact:
            "Has SurveyCo passed the supplier security review and signed the data protection agreement?",
          foundBy: ["screen" as const],
        },
      ],
    };
    const stored = { decidedAt: "2026-11-09T00:00:00.000Z", requirements: [requirement] };
    // deepseek-flash's reply to this settle on governing-01, with ANSWER_NOTE, recorded for #2067.
    const RECORDED =
      '{"decisions":[{"rule":"R1","verdict":"applies","reason":"The requirement sends buyers\' personal information to SurveyCo, an outside company, so the supplier security review and data protection agreement rule is engaged even though the review and agreement are already in place.","businessFact":""}]}';
    const { provider, sent } = stubModel({ judge: () => RECORDED });
    const question = {
      id: "q-supplier",
      requirementId: governingQuestionRequirementId("GR-06"),
      ambiguityField: GOVERNING_QUESTION_FIELD,
      question: requirement.decisions[0].businessFact,
      context: "",
      answer: "Yes, it has.",
      governing: { kind: "governing" as const, ruleIds: [SUPPLIER.id], requirementId: "GR-06" },
    };
    const settlements = await rejudgeAnswered(
      [question],
      stored,
      new Map([[SUPPLIER.id, SUPPLIER]]),
      { provider },
    );
    expect(sent[0]!.system).toContain(ANSWER_NOTE);
    expect(settlements).toEqual([
      expect.objectContaining({ ruleId: SUPPLIER.id, verdict: "applies", answer: "Yes, it has." }),
    ]);
    const { next } = applySettlements(stored, settlements);
    expect(next.requirements[0]!.decisions[0]).toMatchObject({
      verdict: "applies",
      settled: { questionId: "q-supplier", answer: "Yes, it has.", previousVerdict: "uncertain" },
    });
  });

  it("#2078 — an answer that contradicts the requirement's text leaves the rule applying, with the contradiction in the reason", async () => {
    const SUPPLIER = {
      id: "rule_vm01",
      revisionId: "rev_1",
      controlId: "VM-01",
      summary:
        "An outside company completes a security review and data protection agreement before it receives personal or payment information.",
      clauseExcerpt:
        "Before an outside company receives personal or payment information, it completes a security review and signs a data protection agreement.",
      source: "Sample policy v1 VM-01",
    };
    const QUESTION = "Will SurveyCo receive any of the buyers' personal details?";
    const ANSWER = "No, we send the questionnaire ourselves; nothing leaves our systems.";
    const stored = {
      decidedAt: "2026-11-09T00:00:00.000Z",
      requirements: [
        {
          requirementId: "GR-06",
          text: "Send the list of last quarter's buyers to SurveyCo so they can email each buyer a short satisfaction questionnaire.",
          decisions: [
            {
              ruleId: SUPPLIER.id,
              controlId: SUPPLIER.controlId,
              verdict: "uncertain" as const,
              reason: "Depends on what reaches the outside company.",
              businessFact: QUESTION,
              foundBy: ["screen" as const],
            },
          ],
        },
      ],
    };
    // claude-sonnet-5-5's verdict and reason for this settle on governing-01's
    // VM-01, probed 2026-11-09: 3 of 3 `does-not-apply` with the prompt before
    // #2078, 3 of 3 `applies` with it (deepseek-flash: 0 of 4, then 4 of 4).
    const BEFORE = {
      decisions: [
        {
          rule: "R1",
          verdict: "does-not-apply",
          reason:
            "The analyst confirmed SurveyCo receives no personal details and nothing leaves our systems, so no outside company receives personal or payment information and the review and agreement requirement is not engaged.",
        },
      ],
    };
    const AFTER = {
      decisions: [
        {
          rule: "R1",
          verdict: "applies",
          reason:
            "The requirement itself says the list of buyers is sent to SurveyCo so it can email them, which means an outside company receives personal information; the analyst's answer that nothing leaves our systems contradicts the requirement's text, so the text wins.",
        },
      ],
    };
    // Each prompt gets the reply the model gave to it. #2087 — the stub picks
    // its reply by a phrase in the prompt, so this test proves the phrase is
    // sent and the stored decision follows the reply. It does not prove the
    // model's behaviour: the live probes recorded above (and on #2087) do.
    const { provider, sent } = stubModel({
      judge: () => (sent.at(-1)!.system.includes("the requirement's text wins") ? AFTER : BEFORE),
    });
    const question = {
      id: "q-surveyco",
      requirementId: governingQuestionRequirementId("GR-06"),
      ambiguityField: GOVERNING_QUESTION_FIELD,
      question: QUESTION,
      context: "",
      answer: ANSWER,
      governing: { kind: "governing" as const, ruleIds: [SUPPLIER.id], requirementId: "GR-06" },
    };
    const settlements = await rejudgeAnswered(
      [question],
      stored,
      new Map([[SUPPLIER.id, SUPPLIER]]),
      { provider },
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.user).toContain(`Their answer: ${ANSWER}`);
    expect(settlements).toEqual([
      expect.objectContaining({ ruleId: SUPPLIER.id, verdict: "applies", answer: ANSWER }),
    ]);
    const { next } = applySettlements(stored, settlements);
    expect(next.requirements[0]!.decisions[0]).toMatchObject({
      verdict: "applies",
      reason: expect.stringContaining("contradicts the requirement"),
      settled: { questionId: "q-surveyco", answer: ANSWER, previousVerdict: "uncertain" },
    });
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

describe("#2122 — carryAnswersOver: an answer is judged onto the other requirements' open pairs", () => {
  const rules = new Map(
    [CARD, ENCRYPT, AUDIT].map((r) => [r.id, { ...r, revisionId: "rev_1", source: "Policy v1" }]),
  );
  const OTHER = { id: "REQ-002", text: "Customers can export their saved cards to a CSV file." };
  // REQ-001: CARD and ENCRYPT uncertain, AUDIT applies; REQ-002: CARD uncertain, ENCRYPT settled.
  const stored: GoverningAnalysisApplicability = {
    ...STORED,
    requirements: [
      STORED.requirements[0]!,
      {
        requirementId: OTHER.id,
        text: OTHER.text,
        decisions: [
          {
            ruleId: CARD.id,
            controlId: CARD.controlId,
            verdict: "uncertain",
            reason: "Depends on what is exported.",
            businessFact: "Will the export hold whole card numbers?",
            foundBy: ["screen"],
          },
          {
            ruleId: ENCRYPT.id,
            controlId: ENCRYPT.controlId,
            verdict: "uncertain",
            reason: "x",
            foundBy: ["screen"],
            settled: {
              questionId: "q0",
              answer: "Yes.",
              previousVerdict: "uncertain",
              at: "2026-11-08T00:00:00.000Z",
            },
          },
        ],
      },
    ],
  };
  const q = (id: string, ruleIds: string[], answer: string) => ({
    id,
    requirementId: REQ.id,
    ambiguityField: GOVERNING_QUESTION_FIELD,
    question: `Question ${id}?`,
    context: "",
    answer,
    governing: { kind: "governing" as const, ruleIds, requirementId: REQ.id },
  });

  it("candidates are every unsettled uncertain pair no answered question links", () => {
    expect(carryCandidates([q("q1", [CARD.id], "Yes.")], stored)).toEqual([
      { requirementId: REQ.id, text: REQ.text, ruleIds: [ENCRYPT.id] },
      { requirementId: OTHER.id, text: OTHER.text, ruleIds: [CARD.id] },
    ]);
    // An unanswered question links nothing.
    expect(carryCandidates([q("q1", [CARD.id, ENCRYPT.id], " ")], stored)[0]!.ruleIds).toEqual([
      CARD.id,
      ENCRYPT.id,
    ]);
  });

  it("one call per requirement, every answer numbered; a decision is recorded as the answer it names", async () => {
    const { provider, sent } = stubModel({
      judge: (user) =>
        user.includes(OTHER.text)
          ? { decisions: [{ rule: "R1", verdict: "does-not-apply", reason: "No.", answer: "A2" }] }
          : { decisions: [{ rule: "R1", verdict: "applies", reason: "Kept.", answer: "a1" }] },
    });
    const answered = [q("q1", [CARD.id], "Whole numbers are kept."), q("q2", [CARD.id], "No.")];
    const got = await carryAnswersOver(answered, stored, rules, { provider });
    expect(sent).toHaveLength(2);
    expect(sent[0]!.system).toContain(CARRIED_ANSWER_NOTE);
    expect(sent[0]!.system).not.toContain(ANSWER_NOTE);
    expect(sent[0]!.user).toContain("A1 (asked about this requirement)");
    expect(sent[0]!.user).toContain("R1 [EN-02]");
    expect(sent[1]!.user).toContain(`A2 (asked about another requirement: "${REQ.text}")`);
    expect(sent[1]!.user).toContain("Question: Question q2?\nAnswer: No.");
    expect(got).toEqual([
      {
        requirementId: REQ.id,
        ruleId: ENCRYPT.id,
        verdict: "applies",
        reason: "Kept.",
        questionId: "q1",
        question: "Question q1?",
        answer: "Whole numbers are kept.",
      },
      expect.objectContaining({
        requirementId: OTHER.id,
        ruleId: CARD.id,
        verdict: "does-not-apply",
        questionId: "q2",
        answer: "No.",
      }),
    ]);
  });

  it("uncertain, no answer named, a failed call or an unreadable reply settle nothing", async () => {
    const answered = [q("q1", [CARD.id, ENCRYPT.id], "Yes.")];
    const uncertain = stubModel({
      judge: () => ({
        decisions: [{ rule: "R1", verdict: "uncertain", reason: "?", businessFact: "Is it?" }],
      }),
    });
    expect(await carryAnswersOver(answered, stored, rules, uncertain)).toEqual([]);
    const uncertainNamed = stubModel({
      judge: () => ({
        decisions: [{ rule: "R1", verdict: "uncertain", reason: "?", answer: "A1" }],
      }),
    });
    expect(await carryAnswersOver(answered, stored, rules, uncertainNamed)).toEqual([]);
    const unnamed = stubModel({
      judge: () => ({ decisions: [{ rule: "R1", verdict: "applies", reason: "y" }] }),
    });
    expect(await carryAnswersOver(answered, stored, rules, unnamed)).toEqual([]);
    const failing = stubModel({});
    vi.mocked(failing.chat).mockRejectedValueOnce(new Error("rate limited"));
    expect(await carryAnswersOver(answered, stored, rules, failing)).toEqual([]);
    const unreadable = stubModel({ judge: () => "no" });
    expect(await carryAnswersOver(answered, stored, rules, unreadable)).toEqual([]);
    expect(unreadable.sent.map((s) => s.kind)).toEqual(["judge", "judge"]);
  });

  it("no answer, or no rule left to read, asks nothing", async () => {
    const { provider, chat } = stubModel({});
    expect(await carryAnswersOver([q("q1", [CARD.id], " ")], stored, rules, { provider })).toEqual(
      [],
    );
    expect(
      await carryAnswersOver([q("q1", [CARD.id], "Yes.")], stored, new Map(), { provider }),
    ).toEqual([]);
    expect(chat).not.toHaveBeenCalled();
  });

  it("an abort is not swallowed", async () => {
    const { provider, chat } = stubModel({});
    const controller = new AbortController();
    controller.abort();
    vi.mocked(chat).mockRejectedValueOnce(new Error("aborted"));
    await expect(
      carryAnswersOver([q("q1", [CARD.id], "Yes.")], stored, rules, {
        provider,
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");
  });
});

describe("governingQuestionSourceFor — the flag gate", () => {
  beforeEach(() => {
    db.project.findFirst.mockReset();
    db.analysis.findFirst.mockReset();
    db.governingRule.findMany.mockReset();
    db.governingFinding.findMany.mockReset();
    db.governingFinding.findMany.mockResolvedValue([]);
  });
  afterEach(() => {
    delete process.env.GOVERNING_DOCS_ENABLED;
  });

  it("flag off: no source, and nothing is read", () => {
    process.env.GOVERNING_DOCS_ENABLED = "0";
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

  it("#2059 — open reads the analysis's Needs BA input findings only while a rule applies (#2068: answered or not)", async () => {
    process.env.GOVERNING_DOCS_ENABLED = "1";
    const { provider } = stubModel({});
    const source = governingQuestionSourceFor({ analysisId: "an_1", projectId: "p", provider })!;
    const onlyApplies = structuredClone(STORED);
    onlyApplies.requirements[0]!.decisions = [onlyApplies.requirements[0]!.decisions[2]!];
    db.analysis.findFirst.mockResolvedValue({
      metadata: JSON.stringify({ governingApplicability: onlyApplies }),
    });
    db.project.findFirst.mockResolvedValue({ workspaceId: "ws" });
    db.governingFinding.findMany.mockResolvedValue([
      {
        requirementId: REQ.id,
        ruleId: AUDIT.id,
        businessQuestion: "Will every export of customer records be logged?",
      },
    ]);
    db.governingRule.findMany.mockResolvedValue([
      {
        ...AUDIT,
        revisionId: "rev_1",
        clauseRef: "§7",
        revision: { revisionLabel: "v1", document: { title: "Policy" } },
      },
    ]);
    const questions = await source.open(undefined);
    expect(db.governingFinding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { analysisId: "an_1", status: "needs-ba-input" } }),
    );
    expect(questions).toEqual([
      expect.objectContaining({
        question: "Will every export of customer records be logged?",
        governing: { kind: "governing", ruleIds: [AUDIT.id], requirementId: REQ.id },
      }),
    ]);

    // #2068 — what a re-ask reads of each row.
    expect(db.governingFinding.findMany.mock.calls[0]![0].select).toMatchObject({
      citationDropped: true,
      decision: true,
      updatedAt: true,
    });

    // Once an answer is recorded on the pair, its question is not asked again...
    onlyApplies.requirements[0]!.decisions[0]!.settled = {
      questionId: "q1",
      question: "Will every export of customer records be logged?",
      answer: "Yes.",
      previousVerdict: "applies",
      at: "2026-11-08T00:00:00.000Z",
    };
    db.analysis.findFirst.mockResolvedValue({
      metadata: JSON.stringify({ governingApplicability: onlyApplies }),
    });
    expect(await source.open(undefined)).toEqual([]);
    // ...but the new question of a refresh that read the answer is (#2068).
    db.governingFinding.findMany.mockResolvedValue([
      {
        requirementId: REQ.id,
        ruleId: AUDIT.id,
        businessQuestion: "Who reviews the export log?",
        citationDropped: false,
        decision: null,
        updatedAt: new Date("2026-11-08T00:01:00.000Z"),
      },
    ]);
    expect(await source.open(undefined)).toEqual([
      expect.objectContaining({ question: "Who reviews the export log?" }),
    ]);
    // With no rule that applies, no finding is read at all.
    const noneApply = structuredClone(STORED);
    noneApply.requirements[0]!.decisions = noneApply.requirements[0]!.decisions.slice(0, 2);
    db.analysis.findFirst.mockResolvedValue({
      metadata: JSON.stringify({ governingApplicability: noneApply }),
    });
    db.governingFinding.findMany.mockClear();
    db.governingRule.findMany.mockResolvedValue([]);
    await source.open(undefined);
    expect(db.governingFinding.findMany).not.toHaveBeenCalled();
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
