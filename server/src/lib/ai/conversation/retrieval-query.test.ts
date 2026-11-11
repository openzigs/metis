/**
 * #2240 — the searches a chat turn runs, read from the conversation, and the
 * excerpts an answer cited, carried to the next turn.
 */
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../types.js";
import type { StoredMessage } from "./transcript-store.js";
import {
  CITED_EXCERPTS_META_KEY,
  MAX_CARRIED_EXCERPTS,
  MAX_QUERY_CHARS,
  MAX_QUESTION_PARTS,
  assistantQuestion,
  citedExcerptIds,
  citedExcerptsMeta,
  isFollowUp,
  planQueries,
  planRetrievalQueries,
  retrievalConversation,
  splitQuestionParts,
  type CitableExcerpt,
} from "./retrieval-query.js";

const user = (content: string): ChatMessage => ({ role: "user", content });
const assistant = (content: string): ChatMessage => ({ role: "assistant", content });

describe("planRetrievalQueries", () => {
  it("searches a first question with the user's words alone", () => {
    const plan = planRetrievalQueries([user("How does the tag validator reject duplicate tags?")]);
    expect(plan).toEqual({
      primary: "How does the tag validator reject duplicate tags?",
      parts: [],
      contextual: null,
    });
    expect(planQueries(plan!)).toEqual(["How does the tag validator reject duplicate tags?"]);
  });

  it("reads the BA's answer to the model's question with that question and the one before", () => {
    const plan = planRetrievalQueries([
      user("How does the refund rule work?"),
      assistant("Refunds differ by product. Which product do you mean, Reader or Server?"),
      user("product B"),
    ])!;
    // The user's own words stay first, in both searches.
    expect(plan.primary).toBe("product B");
    expect(plan.contextual).toBe(
      "product B\nWhich product do you mean, Reader or Server?\nHow does the refund rule work?",
    );
    expect(planQueries(plan)).toEqual([plan.primary, plan.contextual]);
  });

  it("does not drag an earlier topic into a new, self-contained question", () => {
    const plan = planRetrievalQueries([
      user("How does the refund rule work?"),
      assistant("Refunds are issued within 30 days [1]."),
      user("Describe the password reset flow for administrators in the server product."),
    ])!;
    expect(plan.contextual).toBeNull();
  });

  it("splits a multi-part question into one search per part, plus the whole", () => {
    const plan = planRetrievalQueries([
      user("What does the FRD change in Reader? What does it change in Server?"),
    ])!;
    expect(plan.parts).toEqual([
      "What does the FRD change in Reader?",
      "What does it change in Server?",
    ]);
    expect(planQueries(plan)).toHaveLength(3);
  });

  it("returns null with no user message, or one with no text", () => {
    expect(planRetrievalQueries([])).toBeNull();
    expect(planRetrievalQueries([assistant("hello")])).toBeNull();
    expect(planRetrievalQueries([user("   ")])).toBeNull();
  });

  it("caps the user's query at the long-standing limit", () => {
    const plan = planRetrievalQueries([user("x".repeat(MAX_QUERY_CHARS + 50))])!;
    expect(plan.primary).toHaveLength(MAX_QUERY_CHARS);
  });

  it("keeps a follow-up's conversational search within the cap", () => {
    const plan = planRetrievalQueries([
      user("q".repeat(5000)),
      assistant("Which one?"),
      user(`and ${"y".repeat(MAX_QUERY_CHARS)}`),
    ])!;
    expect(plan.contextual!.length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
    expect(plan.contextual!.startsWith("and y")).toBe(true);
  });
});

describe("splitQuestionParts", () => {
  it("splits list items", () => {
    expect(
      splitQuestionParts(
        "Tell me:\n1. the refund rule\n2) the return window\n- the fees we charge",
      ),
    ).toEqual(["the refund rule", "the return window", "the fees we charge"]);
  });

  it(`keeps at most ${MAX_QUESTION_PARTS} parts`, () => {
    const q = "Is it A today? Is it B today? Is it C today? Is it D today?";
    expect(splitQuestionParts(q)).toHaveLength(MAX_QUESTION_PARTS);
  });

  it("treats one question, or parts too short to search, as a single question", () => {
    expect(splitQuestionParts("How does v2.3 change the refund rule?")).toEqual([]);
    expect(splitQuestionParts("A? B? C?")).toEqual([]);
    expect(splitQuestionParts("- a\n- b")).toEqual([]);
  });
});

describe("assistantQuestion / isFollowUp", () => {
  it("finds the question an answer ends on, and only that", () => {
    expect(assistantQuestion("I found two rules. Which one do you mean?")).toBe(
      "Which one do you mean?",
    );
    expect(assistantQuestion("Why? Because the rule says so.")).toBeNull();
  });

  it("treats a short, continuing or referring message as a follow-up", () => {
    expect(isFollowUp("product B", null)).toBe(true);
    expect(isFollowUp("And how are the fees calculated for enterprise customers then", null)).toBe(
      true,
    );
    expect(isFollowUp("Does that rule apply to enterprise customers in every region", null)).toBe(
      true,
    );
    expect(
      isFollowUp("Describe the password reset flow for administrators in the server", null),
    ).toBe(false);
  });

  it("treats any reply to a question the model asked as a follow-up", () => {
    expect(
      isFollowUp(
        "Describe the password reset flow for administrators in the server",
        "Which flow do you mean?",
      ),
    ).toBe(true);
  });
});

const excerpts: CitableExcerpt[] = [
  { n: 1, chunkId: "c1", name: "rules.md", locator: "rules.md#0" },
  { n: 2, chunkId: "c2", name: "rules.md", locator: "rules.md#1" },
  { n: 3, chunkId: "c3", name: "src/fees.ts", locator: "src/fees.ts#4" },
  { n: 4, chunkId: "c4", name: "faq.md", locator: "faq.md#2" },
];

describe("citedExcerptIds", () => {
  it("reads bracketed numbers, single and listed", () => {
    expect(citedExcerptIds("Refunds take 30 days [3].", excerpts)).toEqual(["c3"]);
    expect(citedExcerptIds("See [1, 4].", excerpts)).toEqual(["c1", "c4"]);
  });

  it("reads a locator, and a file name (every excerpt of that file)", () => {
    expect(citedExcerptIds("As `src/fees.ts:10-20` shows", excerpts)).toEqual(["c3"]);
    expect(citedExcerptIds("Per rules.md#1, …", excerpts)).toEqual(["c1", "c2"]);
    expect(citedExcerptIds("rules.md says…", excerpts)).toEqual(["c1", "c2"]);
  });

  it("cites nothing for an answer with no citations, a number out of range, or no excerpts", () => {
    expect(citedExcerptIds("I don't know.", excerpts)).toEqual([]);
    expect(citedExcerptIds("see [9]", excerpts)).toEqual([]);
    expect(citedExcerptIds("see [1]", [])).toEqual([]);
    expect(citedExcerptIds("", excerpts)).toEqual([]);
  });

  it(`carries at most ${MAX_CARRIED_EXCERPTS}`, () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      n: i + 1,
      chunkId: `k${i + 1}`,
      name: `f${i + 1}.md`,
      locator: `f${i + 1}.md#0`,
    }));
    expect(citedExcerptIds("[1][2][3][4][5][6]", many)).toEqual(["k1", "k2", "k3", "k4"]);
  });

  it("records the citation under the meta key, and nothing when none", () => {
    expect(citedExcerptsMeta("[2]", excerpts)).toEqual({ [CITED_EXCERPTS_META_KEY]: ["c2"] });
    expect(citedExcerptsMeta("no citation", excerpts)).toEqual({});
    expect(citedExcerptsMeta("[2]", undefined)).toEqual({});
  });
});

function row(over: Partial<StoredMessage>): StoredMessage {
  return {
    id: "r",
    sessionId: "s",
    ordinal: 0,
    role: "user",
    kind: "message",
    parts: [],
    estimatedTokens: 0,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    promptChars: null,
    provider: null,
    model: null,
    finishReason: null,
    compactedAt: null,
    compactedIntoId: null,
    meta: {},
    createdAt: new Date(0),
    ...over,
  };
}

describe("retrievalConversation", () => {
  it("reads the turns as text and what the last answer cited", () => {
    const conv = retrievalConversation([
      row({ kind: "summary", role: "system", parts: [{ type: "text", text: "summary" }] }),
      row({ role: "user", parts: [{ type: "text", text: "q1" }] }),
      row({
        role: "assistant",
        parts: [{ type: "text", text: "a1 [1]" }],
        meta: { [CITED_EXCERPTS_META_KEY]: ["old"] },
      }),
      row({ role: "user", parts: [{ type: "text", text: "q2" }] }),
      row({
        role: "assistant",
        parts: [{ type: "text", text: "a2 [2]" }],
        meta: { [CITED_EXCERPTS_META_KEY]: ["c2", 7, "", "x".repeat(201)] },
      }),
    ]);
    expect(conv.messages).toEqual([
      user("q1"),
      assistant("a1 [1]"),
      user("q2"),
      assistant("a2 [2]"),
    ]);
    // Only the most recent answer's citations, and only well-formed ids.
    expect(conv.carryForward).toEqual(["c2"]);
  });

  it("skips compacted rows and replies with no text; an answer citing nothing carries nothing", () => {
    const conv = retrievalConversation([
      row({ role: "user", parts: [{ type: "text", text: "old" }], compactedAt: new Date() }),
      row({ role: "user", parts: [{ type: "text", text: "q" }] }),
      row({ role: "assistant", parts: [], meta: { [CITED_EXCERPTS_META_KEY]: "c1" } }),
    ]);
    expect(conv).toEqual({ messages: [user("q")], carryForward: [] });
  });

  it("is empty for an empty transcript", () => {
    expect(retrievalConversation([])).toEqual({ messages: [], carryForward: [] });
  });
});
