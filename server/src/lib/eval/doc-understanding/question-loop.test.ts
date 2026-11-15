import { describe, expect, it } from "vitest";
import type { AIProvider, ChatMessage, ChatOptions, ChatResponse } from "../../ai/types.js";
import { HAIKU_MODEL_ID, SONNET_MODEL_ID } from "../../ai/model-router.js";
import {
  MAX_QUESTIONS_PER_ROUND,
  QUESTION_CANDIDATES_PER_ROUND,
} from "../../analysis/question-selection.js";
import type { ReadStatement } from "../../document-reader/reader.js";
import { askFirstRound, sourceStatementsOf } from "./question-loop.js";

const DOC = { documentId: "doc-1:source.docx", filename: "source.docx" };

function statement(
  i: number,
  kind: ReadStatement["kind"],
  quote: string,
  heading = "2. Booking",
): ReadStatement {
  return {
    id: `T${i}`,
    kind,
    statement: `Statement ${i}.`,
    quote,
    start: 0,
    end: quote.length,
    sectionId: `S${i}`,
    headingPath: ["Booking FRD", heading],
    refersTo: [],
  };
}

interface Call {
  system: string;
  user: string;
  opts?: ChatOptions;
}

/** The open ambiguities the question prompt lists: `[requirementId, key]` pairs. */
function listedAmbiguities(user: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let id = "";
  for (const line of user.split("\n")) {
    const req = /\(id: ([^)]+)\):$/.exec(line);
    if (req) id = req[1]!;
    const amb = /^ {2}- ([^:]+(?::[^:\s]+)?): /.exec(line);
    if (amb && id) out.push([id, amb[1]!]);
  }
  return out;
}

/**
 * A provider that answers the extraction with `extraction` and the question
 * call by grading each listed ambiguity with `grade`.
 */
function loopProvider(
  extraction: unknown,
  grade: (field: string, i: number) => Record<string, unknown> = () => ({}),
  opts: { servesHaiku?: boolean } = {},
): { provider: AIProvider; calls: Call[] } {
  const calls: Call[] = [];
  const provider = {
    key: "anthropic",
    model: "claude-sonnet-5-5",
    offline: false,
    servesRouterModel: opts.servesHaiku ? () => true : undefined,
    async chat(messages: ChatMessage[], o?: ChatOptions): Promise<ChatResponse> {
      const system = messages
        .filter((m) => m.role === "system")
        .map((m) => m.content as string)
        .join("\n");
      const user = messages
        .filter((m) => m.role === "user")
        .map((m) => m.content as string)
        .join("\n");
      calls.push({ system, user, opts: o });
      let content: string;
      if (system.includes("clarification session")) {
        content = JSON.stringify({
          questions: listedAmbiguities(user).map(([requirementId, field], i) => ({
            requirementId,
            ambiguityField: field,
            uncertainty: "ambiguity",
            divergent: true,
            impact: "medium",
            question: `What does ${field} mean?`,
            context: "c",
            ...grade(field, i),
          })),
        });
      } else if (system.includes("Extract structured requirements")) {
        content = JSON.stringify(extraction);
      } else {
        throw new Error(`no route for: ${system.slice(0, 80)}`);
      }
      return {
        content,
        model: o?.model ?? "claude-sonnet-5-5",
        provider: "anthropic",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    },
  } as unknown as AIProvider;
  return { provider, calls };
}

const req = (title: string, sourceIds: string[], fields: string[] = [], extra = {}) => ({
  title,
  description: `${title} description`,
  type: "functional",
  priority: "should-have",
  sourceIds,
  ambiguities: fields.map((field) => ({
    field,
    description: `${field} is unclear`,
    suggestedQuestion: `Which ${field}?`,
  })),
  ...extra,
});

describe("#2271 — sourceStatementsOf", () => {
  it("numbers the requirement-like statements in order and carries their paragraphs", () => {
    const out = sourceStatementsOf(
      {
        statements: [
          statement(1, "requirement", "The portal shall lock an account."),
          statement(2, "background", "Some background."),
          statement(3, "business-rule", "A patient holds two appointments.", "3. Rules"),
          statement(4, "constraint", "x".repeat(3000)),
        ],
      },
      DOC,
    );
    expect(out.map((s) => [s.ref, s.statement])).toEqual([
      ["REQ-001", "Statement 1."],
      ["REQ-002", "Statement 3."],
      ["REQ-003", "Statement 4."],
    ]);
    expect(out[1]).toMatchObject({
      documentId: DOC.documentId,
      filename: "source.docx",
      headingPath: ["Booking FRD", "3. Rules"],
      quote: "A patient holds two appointments.",
    });
    // Clipped as the document reader agent clips a stored requirement's quote.
    expect(out[2]!.quote).toHaveLength(2048);
    expect(out[2]!.quote.endsWith("…")).toBe(true);
  });
});

describe("#2271 — askFirstRound", () => {
  const READING = {
    statements: [
      statement(1, "requirement", "The portal shall lock an account after five failed attempts."),
      statement(2, "requirement", "The page shall load fast."),
    ],
  };

  it("extracts in source mode, applies the GtWR rules to the paragraph, and asks about it", async () => {
    const { provider, calls } = loopProvider({
      requirements: [req("Lockout", ["REQ-001"], ["unlock"]), req("Speed", ["REQ-002"])],
    });
    const round = await askFirstRound(provider, READING, DOC);
    expect(calls).toHaveLength(2);
    // Source mode: the statements are listed by label inside the fence.
    expect(calls[0]!.user).toContain("[REQ-001]\n<<<SOURCE");
    expect(calls[0]!.system).toContain('add "sourceIds"');
    // The question prompt quotes each requirement's verified paragraph.
    expect(calls[1]!.user).toContain("The page shall load fast.");
    expect(calls[1]!.system).toContain("divergent");
    // "fast" (GtWR R7) was raised by the rules, not the model.
    expect(round.asked.map((q) => q.ambiguityField).sort()).toEqual(["R7:fast", "unlock"]);
    const fast = round.asked.find((q) => q.ambiguityField === "R7:fast")!;
    expect(fast.citation).toMatchObject({
      headingPath: ["Booking FRD", "2. Booking"],
      quote: "The page shall load fast.",
    });
    expect(round.diagnostics).toEqual({
      sourceStatements: 2,
      structuredRequirements: 2,
      ambiguities: 2,
      questionCandidates: 2,
      questionsGenerated: 2,
      setAsideUnanswerable: 0,
      setAsideSameOutcome: 0,
      overCap: 0,
      fallback: 0,
      questionsAsked: 2,
      // Both asked and answered: nothing is left for a second round, so no call.
      secondRoundOpen: 0,
      secondRoundGenerated: 0,
      secondRoundAsked: 0,
      secondRoundRepeats: 0,
      secondRoundFailed: 0,
    });
  });

  it("sets aside the unanswerable and the same-outcome, and counts each reason", async () => {
    const { provider } = loopProvider(
      { requirements: [req("Lockout", ["REQ-001"], ["a", "b", "c", "d"])] },
      (field) =>
        field === "a"
          ? { uncertainty: "unanswerable" }
          : field === "b" || field === "c"
            ? { divergent: false }
            : {},
    );
    const round = await askFirstRound(provider, READING, DOC);
    expect(round.asked.map((q) => q.ambiguityField)).toEqual(["d"]);
    expect(round.diagnostics).toMatchObject({
      questionsGenerated: 4,
      setAsideUnanswerable: 1,
      setAsideSameOutcome: 2,
      overCap: 0,
      questionsAsked: 1,
      fallback: 0,
    });
  });

  it("asks at most the round's cap, highest impact first, and counts the rest as over the cap", async () => {
    const fields = Array.from({ length: MAX_QUESTIONS_PER_ROUND + 3 }, (_, i) => `f${i}`);
    const { provider } = loopProvider(
      { requirements: [req("Lockout", ["REQ-001"], fields)] },
      (field) => ({ impact: field === "f10" ? "high" : "low" }),
    );
    const round = await askFirstRound(provider, READING, DOC);
    expect(round.asked).toHaveLength(MAX_QUESTIONS_PER_ROUND);
    expect(round.asked[0]!.ambiguityField).toBe("f10");
    expect(round.diagnostics).toMatchObject({
      questionsGenerated: MAX_QUESTIONS_PER_ROUND + 3,
      overCap: 3,
      questionsAsked: MAX_QUESTIONS_PER_ROUND,
    });
  });

  it("asks the open ambiguities as written when every question is set aside but one is still open", async () => {
    // The model asks only about "unlock" and calls it unanswerable; the GtWR
    // hit on "fast" is never raised, so it is still open (#2451).
    const { provider } = loopProvider(
      {
        requirements: [req("Lockout", ["REQ-001"], ["unlock"]), req("Speed", ["REQ-002"])],
      },
      (field) => (field === "unlock" ? { uncertainty: "unanswerable" } : { requirementId: "" }),
    );
    const round = await askFirstRound(provider, READING, DOC);
    expect(round.asked).toHaveLength(1);
    expect(round.asked[0]).toMatchObject({ ambiguityField: "R7:fast" });
    expect(round.asked[0]!.question).toMatch(/^Can you clarify: /);
    expect(round.asked[0]!.citation?.quote).toBe("The page shall load fast.");
    expect(round.diagnostics).toMatchObject({
      setAsideUnanswerable: 1,
      fallback: 1,
      questionsAsked: 1,
    });
  });

  it("asks nothing when everything raised was set aside and nothing is left open", async () => {
    const { provider } = loopProvider(
      { requirements: [req("Lockout", ["REQ-001"], ["unlock"])] },
      () => ({ divergent: false }),
    );
    const round = await askFirstRound(provider, READING, DOC);
    expect(round.asked).toEqual([]);
    expect(round.diagnostics).toMatchObject({ setAsideSameOutcome: 1, fallback: 0 });
  });

  it("asks the questions at the dialog's model: the Haiku tier where the provider serves it", async () => {
    const served = loopProvider({ requirements: [req("L", ["REQ-001"], ["u"])] }, undefined, {
      servesHaiku: true,
    });
    await askFirstRound(served.provider, READING, DOC);
    expect(served.calls[1]!.opts?.model).toBe(HAIKU_MODEL_ID);
    const unserved = loopProvider({ requirements: [req("L", ["REQ-001"], ["u"])] });
    await askFirstRound(unserved.provider, READING, DOC);
    expect(unserved.calls[1]!.opts?.model).toBe("claude-sonnet-5-5");
  });

  it("makes no question call when the extraction finds no ambiguity", async () => {
    const { provider, calls } = loopProvider({ requirements: [req("Lockout", ["REQ-001"])] });
    const round = await askFirstRound(provider, { statements: [READING.statements[0]!] }, DOC);
    expect(calls).toHaveLength(1);
    expect(round).toEqual({
      asked: [],
      diagnostics: expect.objectContaining({
        sourceStatements: 1,
        structuredRequirements: 1,
        ambiguities: 0,
        questionsAsked: 0,
      }),
    });
  });

  describe("#2534 — a document with hundreds of open ambiguities", () => {
    const FIELDS = ["a", "b", "c", "d"];
    // 61 statements, as the clinic-booking FRD gives the extraction.
    const BIG = {
      statements: Array.from({ length: 61 }, (_, i) =>
        statement(i + 1, "requirement", `The portal shall do thing ${i + 1}.`),
      ),
    };
    const bigExtraction = {
      requirements: BIG.statements.map((_, i) =>
        req(`Thing ${i + 1}`, [`REQ-${String(i + 1).padStart(3, "0")}`], FIELDS),
      ),
    };
    const questionCalls = (calls: Call[]) =>
      calls.filter((c) => c.system.includes("clarification session"));

    it("writes questions for at most QUESTION_CANDIDATES_PER_ROUND, asks the cap, then runs round 2", async () => {
      const { provider, calls } = loopProvider(bigExtraction, (_field, i) =>
        i % 4 === 0 ? { uncertainty: "unanswerable" } : {},
      );
      const round = await askFirstRound(provider, BIG, DOC);
      const [first, second] = questionCalls(calls);
      expect(questionCalls(calls)).toHaveLength(2);
      const firstListed = listedAmbiguities(first!.user).map(([id, key]) => `${id}:${key}`);
      expect(firstListed).toHaveLength(QUESTION_CANDIDATES_PER_ROUND);
      expect(round.asked).toHaveLength(MAX_QUESTIONS_PER_ROUND);
      // Round 2 lists nothing round 1 asked or set aside.
      const asked = round.asked.map((q) => `${q.requirementId}:${q.ambiguityField}`);
      const secondListed = listedAmbiguities(second!.user).map(([id, key]) => `${id}:${key}`);
      expect(secondListed.length).toBeLessThanOrEqual(QUESTION_CANDIDATES_PER_ROUND);
      for (const key of asked) expect(secondListed).not.toContain(key);
      const setAside = round.diagnostics.setAsideUnanswerable;
      expect(round.diagnostics).toEqual({
        sourceStatements: 61,
        structuredRequirements: 61,
        ambiguities: 61 * FIELDS.length,
        questionCandidates: QUESTION_CANDIDATES_PER_ROUND,
        questionsGenerated: QUESTION_CANDIDATES_PER_ROUND,
        setAsideUnanswerable: QUESTION_CANDIDATES_PER_ROUND / 4,
        setAsideSameOutcome: 0,
        overCap: QUESTION_CANDIDATES_PER_ROUND - setAside - MAX_QUESTIONS_PER_ROUND,
        fallback: 0,
        questionsAsked: MAX_QUESTIONS_PER_ROUND,
        secondRoundOpen: 61 * FIELDS.length - MAX_QUESTIONS_PER_ROUND - setAside,
        secondRoundGenerated: QUESTION_CANDIDATES_PER_ROUND,
        secondRoundAsked: MAX_QUESTIONS_PER_ROUND,
        secondRoundRepeats: 0,
        secondRoundFailed: 0,
      });
    });

    it("asks round 2 at the Sonnet tier, as the dialog escalates with most ambiguities unresolved", async () => {
      const { provider, calls } = loopProvider(bigExtraction, undefined, { servesHaiku: true });
      await askFirstRound(provider, BIG, DOC);
      const [first, second] = questionCalls(calls);
      expect(first!.opts?.model).toBe(HAIKU_MODEL_ID);
      expect(second!.opts?.model).toBe(SONNET_MODEL_ID);
    });

    it("asks round 2 at the Haiku tier when most ambiguities were answered in round 1", async () => {
      // 1 requirement, 4 ambiguities: all asked and answered but one set aside.
      const { provider, calls } = loopProvider(
        { requirements: [req("Lockout", ["REQ-001"], FIELDS)] },
        (field) => (field === "a" ? { uncertainty: "unanswerable" } : {}),
        { servesHaiku: true },
      );
      const round = await askFirstRound(provider, READING, DOC);
      // Nothing open after round 1: no second call.
      expect(round.diagnostics.secondRoundOpen).toBe(0);
      expect(questionCalls(calls)).toHaveLength(1);
      // With one of 4 ambiguities left open, 3 of 4 answered: no escalation.
      const left = loopProvider(
        { requirements: [req("Lockout", ["REQ-001"], FIELDS)] },
        (field) => (field === "a" ? { requirementId: "" } : {}),
        { servesHaiku: true },
      );
      const leftRound = await askFirstRound(left.provider, READING, DOC);
      expect(leftRound.diagnostics.secondRoundOpen).toBe(1);
      expect(questionCalls(left.calls)[1]!.opts?.model).toBe(HAIKU_MODEL_ID);
    });

    it("counts a failed round 2 and keeps round 1", async () => {
      const { provider, calls } = loopProvider(bigExtraction);
      const chat = provider.chat.bind(provider);
      let questionCall = 0;
      provider.chat = async (messages, o) => {
        if (String(messages[0]!.content).includes("clarification session") && ++questionCall > 1) {
          return { content: "not json", model: "m", provider: "anthropic" } as ChatResponse;
        }
        return chat(messages, o);
      };
      const round = await askFirstRound(provider, BIG, DOC);
      expect(round.asked).toHaveLength(MAX_QUESTIONS_PER_ROUND);
      expect(round.diagnostics).toMatchObject({
        questionsAsked: MAX_QUESTIONS_PER_ROUND,
        secondRoundFailed: 1,
        secondRoundAsked: 0,
      });
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  it("makes no call at all when the reading holds no requirement-like statement", async () => {
    const { provider, calls } = loopProvider({ requirements: [] });
    const round = await askFirstRound(
      provider,
      { statements: [statement(1, "background", "Only background.")] },
      DOC,
    );
    expect(calls).toHaveLength(0);
    expect(round.asked).toEqual([]);
    expect(round.diagnostics.sourceStatements).toBe(0);
  });
});
