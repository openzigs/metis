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
  acceptanceCriteria?: string;
}

const store = {
  requirements: [] as ReqRow[],
  metadata: null as string | null,
  dialogState: null as string | null,
  dialogThrows: false,
  // #1031 — whether the analysis has requirement approvals (promoted rows).
  hasApprovals: false,
};

vi.mock("../prisma.js", () => ({
  resolveDatabaseProvider: () => "sqlite",
  prisma: {
    // #909 — metadata merge-writers run in a transaction; this fake runs it on itself.
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn((await import("../prisma.js")).prisma),
    ),
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
    approvalRequest: {
      findFirst: vi.fn(async () => (store.hasApprovals ? { id: "ap_1" } : null)),
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
  MAX_OUTCOME_QUESTION,
  MAX_PUBLISHED_ANSWER,
  applyClarificationBlock,
  PROVENANCE_TAGS,
  answerProvenance,
  applyClarificationsToRequirements,
  attributeAnswers,
  hasAnsweredClarification,
  collectAnsweredQuestions,
  containmentScore,
  renderClarificationBlock,
  sanitizeClarificationText,
  significantTokens,
  stripClarificationBlock,
} = await import("./clarification-enrichment.js");

const { CRITERIA_FLAG_LINE, CRITERIA_FLAG_MARKER, clearCriteriaFlag, hasCriteriaFlag } =
  await import("./clarification-criteria-flag.js");

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
    provenance: "typed" | "edited" | "suggested";
  }> = {},
) => ({
  questionId: "q1",
  requirementId: "REQ-1",
  question: "Which rate source?",
  answer: "The ECB daily rate.",
  provenance: "typed" as const,
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
      {
        questionId: "a",
        requirementId: "R1",
        question: "Q?",
        answer: "legacy answer",
        provenance: "typed",
      },
    ]);
  });

  // Issue #1000 — an unedited METIS suggestion is not the requester's answer.
  it("records whether each answer is METIS's suggestion, an edit of it, or typed", () => {
    const q = (id: string, answer: string, groundedAnswer?: string) => ({
      id,
      requirementId: "R1",
      ambiguityField: id,
      question: `${id}?`,
      context: "",
      answer,
      ...(groundedAnswer !== undefined
        ? { groundingStatus: "grounded" as const, groundedAnswer }
        : {}),
    });
    const out = collectAnsweredQuestions(
      state([
        {
          round: 1,
          questions: [
            q("a", "Retain for 24 hours.", "Retain for 24 hours."),
            q("b", "Retain for 7 days.", "Retain for 24 hours."),
            q("c", "Mine."),
          ],
          answers: [],
        },
      ]),
    );
    expect(out.map((a) => [a.questionId, a.provenance])).toEqual([
      ["a", "suggested"],
      ["b", "edited"],
      ["c", "typed"],
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

describe("answerProvenance", () => {
  it("compares the answer with the suggestion, ignoring whitespace only", () => {
    expect(answerProvenance("x", undefined)).toBe("typed");
    expect(answerProvenance("x", "  ")).toBe("typed");
    expect(answerProvenance("  The  ECB\nrate. ", "The ECB rate.")).toBe("suggested");
    expect(answerProvenance("The ECB rate!", "The ECB rate.")).toBe("edited");
    expect(answerProvenance("the ecb rate.", "The ECB rate.")).toBe("edited");
  });
});

describe("hasAnsweredClarification", () => {
  it("is true only once a question has a non-blank answer, and false when the read fails", async () => {
    store.dialogThrows = false;
    store.dialogState = null;
    expect(await hasAnsweredClarification(ANALYSIS_ID)).toBe(false);
    const round = (answer: string) => ({
      analysisId: ANALYSIS_ID,
      currentRound: 1,
      maxRounds: 3,
      rounds: [
        {
          round: 1,
          questions: [
            {
              id: "a",
              requirementId: "R",
              ambiguityField: "f",
              question: "?",
              context: "",
              answer,
            },
          ],
          answers: [],
        },
      ],
      resolvedAmbiguities: [],
      escalatedToSonnet: false,
      completed: false,
    });
    store.dialogState = JSON.stringify(round(" "));
    expect(await hasAnsweredClarification(ANALYSIS_ID)).toBe(false);
    store.dialogState = JSON.stringify(round("yes"));
    expect(await hasAnsweredClarification(ANALYSIS_ID)).toBe(true);
    store.dialogThrows = true;
    expect(await hasAnsweredClarification(ANALYSIS_ID)).toBe(false);
    store.dialogThrows = false;
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

  it("#1000 — tags each answer with who wrote it, and no longer credits every answer to the requester", () => {
    const block = renderClarificationBlock([
      answer({ questionId: "a", provenance: "typed", answer: "Typed." }),
      answer({ questionId: "b", provenance: "edited", answer: "Edited." }),
      answer({ questionId: "c", provenance: "suggested", answer: "Suggested." }),
    ]);
    expect(block).not.toContain("Answered by the requester");
    expect(block).toContain(`**A:** Typed. ${PROVENANCE_TAGS.typed}`);
    expect(block).toContain(`**A:** Edited. ${PROVENANCE_TAGS.edited}`);
    expect(block).toContain(`**A:** Suggested. ${PROVENANCE_TAGS.suggested}`);
    expect(PROVENANCE_TAGS.suggested).toContain("METIS suggestion, accepted unchanged");
    expect(block).not.toContain(CRITERIA_FLAG_MARKER);
    expect(renderClarificationBlock([answer()], true)).toContain(CRITERIA_FLAG_LINE);
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

describe("#1000 — flagging acceptance criteria the answers may have changed", () => {
  const withCriteria = { hasAcceptanceCriteria: true };

  it("flags the criteria when answers arrive for a requirement that has criteria", () => {
    expect(applyClarificationBlock("Body.", [answer()], withCriteria)).toContain(
      CRITERIA_FLAG_LINE,
    );
    // No criteria, nothing to check.
    expect(applyClarificationBlock("Body.", [answer()])).not.toContain(CRITERIA_FLAG_MARKER);
  });

  it("keeps the flag on a re-run with the same answers", () => {
    const once = applyClarificationBlock("Body.", [answer()], withCriteria);
    expect(applyClarificationBlock(once, [answer()], withCriteria)).toBe(once);
  });

  it("does not bring the flag back once the criteria were edited, until the answers change", () => {
    const flagged = applyClarificationBlock("Body.", [answer()], withCriteria);
    const edited = clearCriteriaFlag(flagged);
    expect(edited).not.toContain(CRITERIA_FLAG_MARKER);
    expect(edited).toBe(applyClarificationBlock("Body.", [answer()]));
    expect(applyClarificationBlock(edited, [answer()], withCriteria)).toBe(edited);
    expect(
      applyClarificationBlock(edited, [answer({ answer: "A newer answer." })], withCriteria),
    ).toContain(CRITERIA_FLAG_LINE);
  });

  it("clearCriteriaFlag leaves a body without the flag untouched", () => {
    expect(clearCriteriaFlag("Body.\n\n\n\nMore.")).toBe("Body.\n\n\n\nMore.");
    expect(hasCriteriaFlag("Body.")).toBe(false);
  });
});

/**
 * Issue #1031 — run 6, J1.3: three answers about "older than X" landed on R5
 * "Mark all items up to here as read" instead of R6 "Mark all as read older
 * than X". R5's body says what "up to here" means — every entry OLDER than this
 * one — so it contains every token of R6's title, both rows scored 1.0, and
 * the first row in the list won the tie. The answer went to a position.
 */
describe("#1031 — an answer goes to its own requirement, never the neighbour", () => {
  const withBody = (r: StructuredRequirement, description: string): StructuredRequirement => ({
    ...r,
    description,
  });
  const R5 = withBody(
    structured("REQ-5", "Mark all items up to here as read"),
    "Mark every entry older than the selected one as read in a single action.",
  );
  const R6 = withBody(
    structured("REQ-6", "Mark all as read older than X"),
    "Mark as read all entries older than a chosen age.",
  );
  // Promotion (#730) writes each approved structured requirement's title and
  // description onto its row, in the reviewed order.
  const rowOf = (r: StructuredRequirement) => ({
    id: `row-${r.id}`,
    title: r.title,
    body: r.description,
  });
  const olderThan = [
    answer({ questionId: "q1", requirementId: "REQ-6", answer: "7 days by default." }),
    answer({ questionId: "q2", requirementId: "REQ-6", answer: "Measured from publish date." }),
    answer({ questionId: "q3", requirementId: "REQ-6", answer: "Starred entries are kept." }),
  ];

  it("files R6's answers under R6 when R5's body mentions every word of R6's title", () => {
    const out = attributeAnswers({
      answered: olderThan,
      structured: [R5, R6],
      requirements: [rowOf(R5), rowOf(R6)],
    });
    expect(out.byRequirementId.get("row-REQ-6")).toHaveLength(3);
    expect(out.byRequirementId.has("row-REQ-5")).toBe(false);
    expect(out.unattributed).toEqual([]);
  });

  it("does not depend on the order of the rows", () => {
    const out = attributeAnswers({
      answered: olderThan,
      structured: [R6, R5],
      requirements: [rowOf(R6), rowOf(R5)],
    });
    expect([...out.byRequirementId.keys()]).toEqual(["row-REQ-6"]);
  });

  it("keeps each requirement's answers apart when both have answers", () => {
    const upToHere = answer({
      questionId: "q4",
      requirementId: "REQ-5",
      answer: "Only the visible list.",
    });
    const out = attributeAnswers({
      answered: [upToHere, ...olderThan],
      structured: [R5, R6],
      requirements: [rowOf(R5), rowOf(R6)],
    });
    expect(out.byRequirementId.get("row-REQ-5")?.map((a) => a.questionId)).toEqual(["q4"]);
    expect(out.byRequirementId.get("row-REQ-6")?.map((a) => a.questionId)).toEqual([
      "q1",
      "q2",
      "q3",
    ]);
  });

  it("does not depend on the order the questions were asked in (#1129 asks ticked ones first)", () => {
    // Ticked R6 asked first, R5 later; and a filtered round holding only R6's.
    for (const answered of [[...olderThan].reverse(), olderThan.slice(1)]) {
      const out = attributeAnswers({
        answered,
        structured: [R5, R6],
        requirements: [rowOf(R5), rowOf(R6)],
      });
      expect([...out.byRequirementId.keys()]).toEqual(["row-REQ-6"]);
    }
  });

  it("reports R6's answers as unattributed when R6 was rejected and has no row", () => {
    const out = attributeAnswers({
      answered: olderThan,
      structured: [R5, R6],
      requirements: [rowOf(R5)],
    });
    expect(out.byRequirementId.size).toBe(0);
    expect(out.unattributed).toHaveLength(3);
  });

  it("reports R6's answers as unattributed when R6 was left out of the run's structured list", () => {
    const out = attributeAnswers({
      answered: olderThan,
      structured: [R5],
      requirements: [rowOf(R5)],
    });
    expect(out.byRequirementId.size).toBe(0);
    expect(out.unattributed).toHaveLength(3);
  });

  it("refuses to guess between two rows the title fits equally, rather than taking the first", () => {
    // Synthesis-written rows (no approval checkpoint): neither title is R6's.
    const out = attributeAnswers({
      answered: olderThan,
      structured: [R6],
      requirements: [
        { id: "row-a", title: "Bulk read actions", body: "Mark entries older than one as read." },
        { id: "row-b", title: "Bulk read actions", body: "Mark entries older than a date read." },
      ],
    });
    expect(out.byRequirementId.size).toBe(0);
    expect(out.unattributed).toHaveLength(3);
  });

  it("gives a row to neither of two requirements it fits equally", () => {
    const twin = { ...R6, id: "REQ-7" };
    const out = attributeAnswers({
      answered: [...olderThan, answer({ questionId: "q9", requirementId: "REQ-7" })],
      structured: [R6, twin],
      requirements: [rowOf(R6)],
    });
    expect(out.byRequirementId.size).toBe(0);
    expect(out.unattributed).toHaveLength(4);
  });

  it("leaves the edited row to R6 once R5 has taken its own row by exact title", () => {
    // R5's exact title claims R5's row first, so R6 is left with one open
    // candidate. This pins the one-row-per-requirement claim, not the title tier
    // (that is the next test).
    const out = attributeAnswers({
      answered: olderThan,
      structured: [R5, R6],
      requirements: [rowOf(R5), { ...rowOf(R6), title: "Mark all as read older than N days" }],
    });
    expect([...out.byRequirementId.keys()]).toEqual(["row-REQ-6"]);
  });

  it("tier 3 — prefers the row whose TITLE holds the words over one whose body does", () => {
    // R5 is not in the list to claim its row, and R6's row title was edited, so
    // neither row is an exact title: both hold every R6 token in title + body,
    // and only the title-alone score separates them.
    const out = attributeAnswers({
      answered: olderThan,
      structured: [R6],
      requirements: [rowOf(R5), { ...rowOf(R6), title: "Mark all as read older than N days" }],
    });
    expect([...out.byRequirementId.keys()]).toEqual(["row-REQ-6"]);
    expect(out.unattributed).toEqual([]);
  });

  it("tier 1 — prefers the row whose title IS the requirement's title", () => {
    const S = structured("REQ-1", "Export orders to CSV");
    const out = attributeAnswers({
      answered: [answer({ requirementId: "REQ-1" })],
      structured: [S],
      requirements: [
        { id: "row-reworded", title: "CSV: export orders", body: "" },
        { id: "row-exact", title: "Export orders to CSV", body: "" },
      ],
    });
    expect([...out.byRequirementId.keys()]).toEqual(["row-exact"]);
  });

  it("an exact title matches even when the title has no word long enough to score", () => {
    const S = structured("REQ-1", "Go to it");
    const out = attributeAnswers({
      answered: [answer({ requirementId: "REQ-1" })],
      structured: [S],
      requirements: [{ id: "row-go", title: "Go to it", body: "" }],
    });
    expect([...out.byRequirementId.keys()]).toEqual(["row-go"]);
  });

  it("tells two identically titled requirements apart by the description promotion copied", () => {
    const orders = withBody(structured("REQ-1", "Export data"), "Export orders as CSV.");
    const customers = withBody(structured("REQ-2", "Export data"), "Export customers as JSON.");
    const out = attributeAnswers({
      answered: [
        answer({ questionId: "q1", requirementId: "REQ-1" }),
        answer({ questionId: "q2", requirementId: "REQ-2" }),
      ],
      structured: [orders, customers],
      requirements: [
        { id: "row-customers", title: "Export data", body: "Export customers as JSON." },
        {
          id: "row-orders",
          title: "Export data",
          // An earlier pass already appended our block; it is ignored here.
          body: applyClarificationBlock("Export orders as CSV.", [answer()]),
        },
      ],
    });
    expect(out.byRequirementId.get("row-orders")?.map((a) => a.questionId)).toEqual(["q1"]);
    expect(out.byRequirementId.get("row-customers")?.map((a) => a.questionId)).toEqual(["q2"]);
  });

  it("a requirement level on two rows blocks only itself — its neighbour still gets its row", () => {
    const S1 = structured("REQ-1", "Bulk read");
    const S2 = structured("REQ-2", "Bulk read archive purge");
    const out = attributeAnswers({
      answered: [
        answer({ questionId: "q1", requirementId: "REQ-1" }),
        answer({ questionId: "q2", requirementId: "REQ-2" }),
      ],
      structured: [S1, S2],
      requirements: [
        { id: "row-1", title: "Bulk read toggle", body: "" },
        { id: "row-2", title: "Bulk read archive", body: "Purge." },
      ],
    });
    expect([...out.byRequirementId.entries()].map(([k, v]) => [k, v[0]!.questionId])).toEqual([
      ["row-2", "q2"],
    ]);
    expect(out.unattributed.map((a) => a.questionId)).toEqual(["q1"]);
  });

  it("a row two requirements are level on goes to neither, nor to a weaker third", () => {
    const S1 = structured("REQ-1", "Export orders");
    const S2 = structured("REQ-2", "Export of orders");
    const S3 = structured("REQ-3", "Export orders invoices refunds");
    const out = attributeAnswers({
      answered: [answer({ questionId: "q3", requirementId: "REQ-3" })],
      structured: [S1, S2, S3],
      requirements: [{ id: "row-r", title: "Orders export", body: "Invoices and refunds." }],
    });
    expect(out.byRequirementId.size).toBe(0);
    expect(out.unattributed).toHaveLength(1);
  });

  describe("synthesized rows (no approval checkpoint)", () => {
    const S5 = structured("REQ-5", "Export orders to CSV");
    const S6 = structured("REQ-6", "Export invoices to CSV");
    const consolidated = {
      id: "row-csv",
      title: "CSV export",
      body: "Export orders and invoices to CSV files.",
    };
    const both = [
      answer({ questionId: "q5", requirementId: "REQ-5" }),
      answer({ questionId: "q6", requirementId: "REQ-6" }),
    ];

    it("puts both requirements' answers on the one row synthesis wrote for them", () => {
      const out = attributeAnswers({
        answered: both,
        structured: [S5, S6],
        requirements: [consolidated],
        rowOrigin: "synthesized",
      });
      expect(out.byRequirementId.get("row-csv")?.map((a) => a.questionId)).toEqual(["q5", "q6"]);
      expect(out.unattributed).toEqual([]);
    });

    it("keeps promoted rows one-to-one: the same shape is refused there", () => {
      const out = attributeAnswers({
        answered: both,
        structured: [S5, S6],
        requirements: [consolidated],
        rowOrigin: "promoted",
      });
      expect(out.byRequirementId.size).toBe(0);
      expect(out.unattributed).toHaveLength(2);
    });

    it("still files R6's answers under R6, not the neighbour that comes first", () => {
      const out = attributeAnswers({
        answered: olderThan,
        structured: [R5, R6],
        requirements: [rowOf(R5), rowOf(R6)],
        rowOrigin: "synthesized",
      });
      expect([...out.byRequirementId.keys()]).toEqual(["row-REQ-6"]);
    });

    it("still refuses to guess between two rows the title fits equally", () => {
      const out = attributeAnswers({
        answered: olderThan,
        structured: [R6],
        requirements: [
          { id: "row-a", title: "Bulk read actions", body: "Mark entries older than one as read." },
          { id: "row-b", title: "Bulk read actions", body: "Mark entries older than a date read." },
        ],
        rowOrigin: "synthesized",
      });
      expect(out.byRequirementId.size).toBe(0);
    });
  });

  const dialogFor = (answers: ReturnType<typeof answer>[]): string =>
    JSON.stringify({
      analysisId: ANALYSIS_ID,
      currentRound: 1,
      maxRounds: 3,
      rounds: [
        {
          round: 1,
          questions: answers.map((a) => ({
            id: a.questionId,
            requirementId: a.requirementId,
            ambiguityField: "age",
            question: a.question,
            context: "",
            answer: a.answer,
          })),
          answers: [],
        },
      ],
      resolvedAmbiguities: [],
      escalatedToSonnet: false,
      completed: false,
    } satisfies ClarificationState);

  it("writes the block onto R6's row and not R5's, end to end (promoted rows)", async () => {
    store.dialogThrows = false;
    store.hasApprovals = true;
    store.dialogState = dialogFor(olderThan);
    store.metadata = JSON.stringify({
      structuredRequirements: { requirements: [R5, R6], totalAmbiguities: 0 },
    });
    store.requirements = [R5, R6].map((r) => ({
      ...rowOf(r),
      analysisId: ANALYSIS_ID,
      deletedAt: null,
    }));
    const out = await applyClarificationsToRequirements(ANALYSIS_ID);
    expect(store.requirements[0]!.body).not.toContain(CLARIFICATIONS_START);
    expect(store.requirements[1]!.body).toContain("7 days by default.");
    expect(out?.answers?.map((a) => a.requirementTitle)).toEqual([R6.title, R6.title, R6.title]);
  });

  it("an analysis with approvals leaves a rejected R6's answers off R5's row, end to end", async () => {
    // Without the approval read this is the synthesized path, where R5's row is
    // R6's unique best and the answers would be misfiled onto it.
    store.dialogThrows = false;
    store.hasApprovals = true;
    store.dialogState = dialogFor(olderThan);
    store.metadata = JSON.stringify({
      structuredRequirements: { requirements: [R5, R6], totalAmbiguities: 0 },
    });
    store.requirements = [{ ...rowOf(R5), analysisId: ANALYSIS_ID, deletedAt: null }];
    const out = await applyClarificationsToRequirements(ANALYSIS_ID);
    expect(store.requirements[0]!.body).not.toContain(CLARIFICATIONS_START);
    expect(out).toMatchObject({ appliedCount: 0, unattributedCount: 3 });
  });

  it("an analysis without approvals writes two requirements' answers onto their shared row", async () => {
    store.dialogThrows = false;
    store.hasApprovals = false;
    const S5 = structured("REQ-5", "Export orders to CSV");
    const S6 = structured("REQ-6", "Export invoices to CSV");
    store.dialogState = dialogFor([
      answer({ questionId: "q5", requirementId: "REQ-5", answer: "Daily." }),
      answer({ questionId: "q6", requirementId: "REQ-6", answer: "Monthly." }),
    ]);
    store.metadata = JSON.stringify({
      structuredRequirements: { requirements: [S5, S6], totalAmbiguities: 0 },
    });
    store.requirements = [
      {
        id: "row-csv",
        analysisId: ANALYSIS_ID,
        title: "CSV export",
        body: "Export orders and invoices to CSV files.",
        deletedAt: null,
      },
    ];
    const out = await applyClarificationsToRequirements(ANALYSIS_ID);
    expect(store.requirements[0]!.body).toContain("Daily.");
    expect(store.requirements[0]!.body).toContain("Monthly.");
    expect(out).toMatchObject({ appliedCount: 2, unattributedCount: 0 });
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
    store.hasApprovals = false;
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

  // Issue #979 — the panel must show WHICH answers were applied, not only a count.
  it("records which requirement each answer was written into", async () => {
    await applyClarificationsToRequirements(ANALYSIS_ID);
    expect(JSON.parse(store.metadata!).clarificationApplication.answers).toEqual([
      {
        questionId: "q1",
        question: "Which rate source?",
        requirementTitle: "Display product prices in the shopper's currency",
        provenance: "typed",
      },
    ]);
  });

  it("records a null requirement for an answer that was not applied", async () => {
    store.metadata = JSON.stringify({});
    const out = await applyClarificationsToRequirements(ANALYSIS_ID);
    expect(out?.answers).toEqual([
      {
        questionId: "q1",
        question: "Which rate source?",
        requirementTitle: null,
        provenance: "typed",
      },
    ]);
  });

  it("#1000 — records an accepted suggestion as METIS's and flags the row's criteria", async () => {
    const q = dialog.rounds[0].questions[0];
    store.dialogState = JSON.stringify({
      ...dialog,
      rounds: [
        {
          ...dialog.rounds[0],
          questions: [{ ...q, groundingStatus: "grounded", groundedAnswer: q.answer }],
        },
      ],
    });
    store.requirements[0].acceptanceCriteria = JSON.stringify(["Rates refresh every 24 h."]);
    const out = await applyClarificationsToRequirements(ANALYSIS_ID);
    expect(out?.answers?.[0].provenance).toBe("suggested");
    const body = store.requirements[0].body;
    expect(body).toContain(`The ECB daily rate. ${PROVENANCE_TAGS.suggested}`);
    expect(body).toContain(CRITERIA_FLAG_LINE);
  });

  it("#1000 — does not flag a row whose criteria were cleared", async () => {
    store.requirements[0].acceptanceCriteria = "null";
    await applyClarificationsToRequirements(ANALYSIS_ID);
    expect(store.requirements[0].body).toContain("The ECB daily rate.");
    expect(store.requirements[0].body).not.toContain(CRITERIA_FLAG_MARKER);
  });

  it("shortens a long question in the per-answer record", async () => {
    const long = "word ".repeat(100);
    store.dialogState = JSON.stringify({
      ...dialog,
      rounds: [
        { ...dialog.rounds[0], questions: [{ ...dialog.rounds[0].questions[0], question: long }] },
      ],
    });
    const out = await applyClarificationsToRequirements(ANALYSIS_ID);
    const q = out!.answers![0].question;
    expect(q.length).toBe(MAX_OUTCOME_QUESTION);
    expect(q.endsWith("…")).toBe(true);
  });
});
