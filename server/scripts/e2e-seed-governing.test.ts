/**
 * #2060 — what `e2e-seed-governing.ts` stores must read back through the paths
 * the server reads a real run's with. A seeded applicability that did not
 * parse would be read as none (`readGoverningApplicability`), and the panel
 * would then say the check never ran: the e2e spec would fail on a fixture
 * bug, or pass against a state no real run reaches.
 */
import { describe, expect, it } from "vitest";
import {
  GOVERNING_FINDING_STATUSES,
  governingAnalysisApplicabilitySchema,
  governingQuestionLinkSchema,
} from "@metis/shared";
import {
  GOVERNING_FIXTURE,
  GOVERNING_RULES,
  POLICY_TEXT,
  rulesWithFindings,
} from "../../e2e/fixtures/governing-fixture.js";
import { GOVERNING_QUESTION_FIELD as SERVER_GOVERNING_QUESTION_FIELD } from "../src/lib/governing/applicability-questions.js";
import { governingQuestionRequirementId } from "../src/lib/governing/applicability-questions.js";
import {
  GOVERNING_QUESTION_FIELD,
  buildGoverningApplicability,
  buildGoverningClarificationState,
  clauseOffsets,
  type SeededRuleIds,
} from "./e2e-seed-governing.js";

const ruleIds: SeededRuleIds = new Map(GOVERNING_RULES.map((r, i) => [r.key, `rule-${i}`]));

describe("e2e-seed-governing (#2060)", () => {
  it("cites every rule's clause by offsets that slice back to its excerpt", () => {
    for (const rule of GOVERNING_RULES) {
      const { clauseStart, clauseEnd } = clauseOffsets(rule.clauseExcerpt);
      expect(POLICY_TEXT.slice(clauseStart, clauseEnd)).toBe(rule.clauseExcerpt);
    }
    expect(() => clauseOffsets("a clause the policy does not hold")).toThrow(/not in the policy/);
  });

  it("seeds one finding of every status, and a rule with no finding", () => {
    const statuses = rulesWithFindings().map((r) => r.finding?.status);
    expect(new Set(statuses)).toEqual(new Set(GOVERNING_FINDING_STATUSES));
    expect(GOVERNING_RULES.some((r) => r.finding === null)).toBe(true);
    // The Needs BA input finding is the uncertain rule's.
    const uncertain = GOVERNING_RULES.filter((r) => r.verdict === "uncertain");
    expect(uncertain.map((r) => r.finding?.status)).toEqual(["needs-ba-input"]);
  });

  it("stores an applicability the shared schema parses, one decision per rule", () => {
    const stored = buildGoverningApplicability(ruleIds, new Date("2026-11-09T00:00:00Z"));
    const parsed = governingAnalysisApplicabilitySchema.parse(stored);
    const [requirement] = parsed.requirements;
    expect(requirement?.requirementId).toBe(GOVERNING_FIXTURE.requirementId);
    expect(requirement?.error).toBeUndefined();
    expect(requirement?.decisions.map((d) => [d.ruleId, d.verdict])).toEqual(
      GOVERNING_RULES.map((r) => [ruleIds.get(r.key), r.verdict]),
    );
    const uncertain = requirement?.decisions.find((d) => d.verdict === "uncertain");
    expect(uncertain?.businessFact).toBe(GOVERNING_FIXTURE.businessFact);
  });

  it("links the open round's question to the uncertain rule, as a governing question", () => {
    const state = buildGoverningClarificationState("analysis-1", ruleIds);
    expect(state.completed).toBe(false);
    // The current round is already generated, so the Questions tab starts nothing.
    expect(state.rounds.at(-1)?.round).toBe(state.currentRound);
    const [question] = state.rounds[0]!.questions;
    expect(question?.id).toBe(GOVERNING_FIXTURE.questionId);
    expect(question?.ambiguityField).toBe(SERVER_GOVERNING_QUESTION_FIELD);
    expect(GOVERNING_QUESTION_FIELD).toBe(SERVER_GOVERNING_QUESTION_FIELD);
    expect(question?.requirementId).toBe(
      governingQuestionRequirementId(GOVERNING_FIXTURE.requirementId),
    );
    const link = governingQuestionLinkSchema.parse(question?.governing);
    const transfer = GOVERNING_RULES.find((r) => r.verdict === "uncertain")!;
    expect(link).toEqual({
      kind: "governing",
      ruleIds: [ruleIds.get(transfer.key)],
      requirementId: GOVERNING_FIXTURE.requirementId,
    });
  });

  it("refuses a rule that was not seeded", () => {
    expect(() => buildGoverningApplicability(new Map(), new Date())).toThrow(/was not seeded/);
  });
});
