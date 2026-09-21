/**
 * Issue #1116 — unit coverage for the clarification→requirement enrichment.
 *
 * The end-to-end proof lives in `clarify-answer-reaches-published-draft.test.ts`;
 * this file pins the decisions that end-to-end test cannot see individually:
 * which answers count, how an answer is matched to a requirement, what the
 * rendered block looks like, and what happens when any of that goes wrong.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClarificationState, StructuredRequirement } from "./types/requirements.js";

const ANALYSIS_ID = "an_x";

interface ReqRow {
  id: string;
  analysisId: string;
  title: string;
  body: string;
  deletedAt: Date | null;
}

const store = {
  requirements: [] as ReqRow[],
  metadata: null as string | null,
  dialogState: null as string | null,
  dialogThrows: false,
};

vi.mock("../prisma.js", () => ({
  prisma: {
    requirement: {
      findMany: vi.fn(async () => store.requirements.filter((r) => r.deletedAt === null)),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { body: string } }) => {
        const row = store.requirements.find((r) => r.id === where.id)!;
        row.body = data.body;
        return row;
      }),
    },
    analysis: {
      findFirst: vi.fn(async () => ({ id: ANALYSIS_ID, metadata: store.metadata })),
      update: vi.fn(async ({ data }: { data: { metadata: string } }) => {
        store.metadata = data.metadata;
        return { id: ANALYSIS_ID };
      }),
    },
    clarificationDialogState: {
      findUnique: vi.fn(async () => {
        if (store.dialogThrows) throw new Error("db down");
        return store.dialogState ? { state: store.dialogState } : null;
      }),
    },
  },
}));

const {
  ATTRIBUTION_THRESHOLD,
  CLARIFICATIONS_END,
  CLARIFICATIONS_START,
  MAX_PUBLISHED_ANSWER,
  applyClarificationBlock,
  applyClarificationsToRequirements,
  attributeAnswers,
  collectAnsweredQuestions,
  containmentScore,
  renderClarificationBlock,
  sanitizeClarificationText,
  significantTokens,
  stripClarificationBlock,
} = await import("./clarification-enrichment.js");

const structured = (id: string, title: string): StructuredRequirement => ({
  id,
  title,
  description: "",
  type: "functional",
  stakeholders: [],
  priority: "must-have",
  ambiguities: [],
  evidenceNeeds: [],
  rawSource: "",
});

const answer = (
  over: Partial<{
    questionId: string;
    requirementId: string;
    question: string;
    answer: string;
  }> = {},
) => ({
  questionId: "q1",
  requirementId: "REQ-1",
  question: "Which rate source?",
  answer: "The ECB daily rate.",
  ...over,
});

describe("collectAnsweredQuestions", () => {
  const state = (rounds: ClarificationState["rounds"]): ClarificationState => ({
    analysisId: ANALYSIS_ID,
    currentRound: 1,
    maxRounds: 3,
    rounds,
    resolvedAmbiguities: [],
    escalatedToSonnet: false,
    completed: false,
  });

  it("returns nothing for a missing dialog", () => {
    expect(collectAnsweredQuestions(undefined)).toEqual([]);
    expect(collectAnsweredQuestions(null)).toEqual([]);
  });

  it("ignores blank and whitespace-only answers — a blank is not an answer", () => {
    const out = collectAnsweredQuestions(
      state([
        {
          round: 1,
          questions: [
            { id: "a", requirementId: "R1", ambiguityField: "f", question: "?", context: "" },
            {
              id: "b",
              requirementId: "R1",
              ambiguityField: "g",
              question: "?",
              context: "",
              answer: "  \n ",
            },
          ],
          answers: [],
        },
      ]),
    );
    expect(out).toEqual([]);
  });

  it("falls back to the round's answers[] for rounds persisted before #1104 stamped them", () => {
    const out = collectAnsweredQuestions(
      state([
        {
          round: 1,
          questions: [
            { id: "a", requirementId: "R1", ambiguityField: "f", question: "Q?", context: "" },
          ],
          answers: [{ questionId: "a", answer: "legacy answer" }],
        },
      ]),
    );
    expect(out).toEqual([
      { questionId: "a", requirementId: "R1", question: "Q?", answer: "legacy answer" },
    ]);
  });

  it("keeps the latest write when a question is answered again in a later round", () => {
    const q = (ans: string) => ({
      id: "a",
      requirementId: "R1",
      ambiguityField: "f",
      question: "Q?",
      context: "",
      answer: ans,
    });
    const out = collectAnsweredQuestions(
      state([
        { round: 1, questions: [q("first")], answers: [] },
        { round: 2, questions: [q("second")], answers: [] },
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].answer).toBe("second");
  });
});

describe("token matching", () => {
  it("drops short words and stopwords, and folds a trailing plural", () => {
    const tokens = significantTokens("The system must display Prices for all users");
    expect(tokens.has("display")).toBe(true);
    expect(tokens.has("price")).toBe(true); // "Prices" folded
    expect(tokens.has("the")).toBe(false);
    expect(tokens.has("system")).toBe(false);
    expect(tokens.has("for")).toBe(false);
  });

  it("scores containment of the needle, and 0 for an empty needle", () => {
    expect(containmentScore(new Set(["a", "b"]), new Set(["a", "z"]))).toBe(0.5);
    expect(containmentScore(new Set(), new Set(["a"]))).toBe(0);
  });
});

describe("attributeAnswers", () => {
  const rows = [
    {
      id: "row-currency",
      title: "Display product prices in the shopper's currency",
      body: "Convert before display.",
    },
    { id: "row-export", title: "Retire the legacy XML export", body: "Nightly job removed." },
  ];

  it("attaches an answer to the requirement its structured title matches", () => {
    const out = attributeAnswers({
      answered: [answer()],
      structured: [structured("REQ-1", "Multi-currency price display")],
      requirements: rows,
    });
    expect([...out.byRequirementId.keys()]).toEqual(["row-currency"]);
    expect(out.unattributed).toEqual([]);
  });

  it("groups every answer about one requirement onto the SAME row", () => {
    const out = attributeAnswers({
      answered: [answer(), answer({ questionId: "q2", answer: "Round half up." })],
      structured: [structured("REQ-1", "Multi-currency price display")],
      requirements: rows,
    });
    expect(out.byRequirementId.get("row-currency")).toHaveLength(2);
  });

  it("reports an answer as unattributed rather than guessing when nothing matches", () => {
    const out = attributeAnswers({
      answered: [answer({ requirementId: "REQ-9" })],
      structured: [structured("REQ-9", "Loyalty tier accrual thresholds")],
      requirements: rows,
    });
    expect(out.byRequirementId.size).toBe(0);
    expect(out.unattributed).toHaveLength(1);
  });

  it("reports an answer whose structured requirement is gone as unattributed", () => {
    const out = attributeAnswers({
      answered: [answer({ requirementId: "" }), answer({ questionId: "q2" })],
      structured: undefined,
      requirements: rows,
    });
    expect(out.unattributed).toHaveLength(2);
  });

  it("requires more than an incidental word overlap", () => {
    // "Legacy" alone is 1 of 3 title tokens ⇒ below the threshold.
    const out = attributeAnswers({
      answered: [answer({ requirementId: "REQ-5" })],
      structured: [structured("REQ-5", "Legacy pricing calculator rewrite")],
      requirements: [{ id: "row-legacy", title: "Retire legacy exports", body: "" }],
    });
    expect(ATTRIBUTION_THRESHOLD).toBe(0.5);
    expect(out.unattributed).toHaveLength(1);
  });
});

describe("block rendering", () => {
  it("renders nothing for no usable answers", () => {
    expect(renderClarificationBlock([])).toBe("");
    expect(renderClarificationBlock([answer({ answer: "" })])).toBe("");
  });

  it("renders the question and the answer verbatim inside the markers", () => {
    const block = renderClarificationBlock([answer()]);
    expect(block.startsWith(CLARIFICATIONS_START)).toBe(true);
    expect(block.endsWith(CLARIFICATIONS_END)).toBe(true);
    expect(block).toContain("**Q:** Which rate source?");
    expect(block).toContain("**A:** The ECB daily rate.");
  });

  it("says so when a question text is missing rather than rendering an orphan answer", () => {
    expect(renderClarificationBlock([answer({ question: "" })])).toContain(
      "(question text unavailable)",
    );
  });

  it("neutralises markdown/HTML so an answer cannot break out of the issue body", () => {
    const block = renderClarificationBlock([
      answer({ answer: "```\n## Fake heading\n<img src=x> done" }),
    ]);
    expect(block).not.toContain("```");
    expect(block).not.toContain("<img");
    expect(block).toContain("Fake heading");
  });

  it("announces truncation instead of silently shortening a pathological answer", () => {
    const long = "x".repeat(MAX_PUBLISHED_ANSWER + 50);
    expect(sanitizeClarificationText(long)).toContain("[answer truncated in the published body]");
    expect(sanitizeClarificationText(null)).toBe("");
    expect(sanitizeClarificationText("short")).toBe("short");
  });
});

describe("applying the block to a body", () => {
  it("appends to the existing body without disturbing it", () => {
    const out = applyClarificationBlock("Original requirement text.", [answer()]);
    expect(out.startsWith("Original requirement text.")).toBe(true);
    expect(out).toContain("## Clarifications");
  });

  it("replaces a prior block instead of stacking a second one", () => {
    const once = applyClarificationBlock("Body.", [answer()]);
    const twice = applyClarificationBlock(once, [answer({ answer: "A newer answer." })]);
    expect(twice.match(/## Clarifications/g)).toHaveLength(1);
    expect(twice).toContain("A newer answer.");
    expect(twice).not.toContain("The ECB daily rate.");
  });

  it("removes the block when there are no longer any answers for the requirement", () => {
    const once = applyClarificationBlock("Body.", [answer()]);
    expect(applyClarificationBlock(once, [])).toBe("Body.");
  });

  it("survives a truncated block whose end marker was lost", () => {
    expect(stripClarificationBlock(`Body.\n\n${CLARIFICATIONS_START}\n## Clarifications`)).toBe(
      "Body.",
    );
    expect(stripClarificationBlock("Body.")).toBe("Body.");
  });

  it("produces a bare block when the requirement had no body at all", () => {
    expect(applyClarificationBlock("", [answer()]).startsWith(CLARIFICATIONS_START)).toBe(true);
  });
});

describe("applyClarificationsToRequirements", () => {
  const dialog: ClarificationState = {
    analysisId: ANALYSIS_ID,
    currentRound: 2,
    maxRounds: 3,
    rounds: [
      {
        round: 1,
        questions: [
          {
            id: "q1",
            requirementId: "REQ-1",
            ambiguityField: "rateSource",
            question: "Which rate source?",
            context: "",
            answer: "The ECB daily rate.",
          },
        ],
        answers: [],
      },
    ],
    resolvedAmbiguities: [],
    escalatedToSonnet: false,
    completed: true,
  };

  beforeEach(() => {
    store.dialogThrows = false;
    store.dialogState = JSON.stringify(dialog);
    store.metadata = JSON.stringify({
      structuredRequirements: {
        requirements: [structured("REQ-1", "Multi-currency price display")],
        totalAmbiguities: 0,
        totalEvidenceNeeds: 0,
      },
    });
    store.requirements = [
      {
        id: "row-1",
        analysisId: ANALYSIS_ID,
        title: "Display product prices in the shopper's currency",
        body: "Convert before display.",
        deletedAt: null,
      },
    ];
  });

  it("writes the answer into the row and records the accounting", async () => {
    const out = await applyClarificationsToRequirements(ANALYSIS_ID);
    expect(store.requirements[0].body).toContain("The ECB daily rate.");
    expect(out).toMatchObject({ answeredCount: 1, appliedCount: 1, requirementsUpdated: 1 });
    expect(JSON.parse(store.metadata!).clarificationApplication.appliedCount).toBe(1);
  });

  it("preserves the rest of the metadata blob it merges into", async () => {
    await applyClarificationsToRequirements(ANALYSIS_ID);
    expect(JSON.parse(store.metadata!).structuredRequirements).toBeTruthy();
  });

  it("does nothing at all when no question has been answered", async () => {
    store.dialogState = null;
    expect(await applyClarificationsToRequirements(ANALYSIS_ID)).toBeNull();
    expect(store.requirements[0].body).toBe("Convert before display.");
  });

  it("clears a stale block when the answers behind it are gone", async () => {
    await applyClarificationsToRequirements(ANALYSIS_ID);
    store.dialogState = JSON.stringify({
      ...dialog,
      rounds: [
        {
          round: 1,
          questions: [
            {
              id: "q1",
              requirementId: "REQ-404",
              ambiguityField: "f",
              question: "Q?",
              context: "",
              answer: "Now about something else entirely.",
            },
          ],
          answers: [],
        },
      ],
    });
    await applyClarificationsToRequirements(ANALYSIS_ID);
    expect(store.requirements[0].body).toBe("Convert before display.");
  });

  it("never throws — a failure here must not break clarify submission or promotion", async () => {
    store.dialogThrows = true;
    expect(await applyClarificationsToRequirements(ANALYSIS_ID)).toBeNull();
  });

  it("still records the accounting when the answers cannot be attributed", async () => {
    store.metadata = JSON.stringify({});
    const out = await applyClarificationsToRequirements(ANALYSIS_ID);
    expect(out).toMatchObject({ appliedCount: 0, unattributedCount: 1, requirementsUpdated: 0 });
  });
});
