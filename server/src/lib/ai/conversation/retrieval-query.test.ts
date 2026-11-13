/**
 * #2240 — the searches a chat turn runs, read from the conversation, and the
 * excerpts an answer cited, carried to the next turn.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadBaQaFixture } from "../../eval/ba-qa/fixture.js";
import type { ChatMessage } from "../types.js";
import type { StoredMessage } from "./transcript-store.js";
import {
  CITED_EXCERPTS_META_KEY,
  CONTEXTUAL_WEIGHT,
  MAX_CARRIED_EXCERPTS,
  MAX_QUERY_CHARS,
  MAX_QUESTION_PARTS,
  assistantQuestion,
  citedExcerptIds,
  citedExcerptsMeta,
  contentWords,
  fuseRetrievalHits,
  isFollowUp,
  planQueries,
  planRetrievalQueries,
  planSearches,
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

  // PR #2266 panel — an answer ending on a question, and a new question that
  // uses "there"/"its", made every second turn search the earlier topic too.
  it.each([
    "Describe the password reset flow for administrators",
    "Which teams own the payment reconciliation service and its alerts?",
    "Are there any GDPR requirements in the onboarding spec?",
  ])("searches a self-contained question on its own after a closing question: %s", (q) => {
    const plan = planRetrievalQueries([
      user("How does the refund rule work?"),
      assistant("Refunds are issued within 30 days [1]. Would you like more detail?"),
      user(q),
    ])!;
    expect(plan.contextual).toBeNull();
    expect(planQueries(plan)).toEqual([q]);
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

  it("treats a short, continuing, or referring-without-a-subject message as a follow-up", () => {
    expect(isFollowUp("product B")).toBe(true);
    expect(isFollowUp("And how are the fees calculated for enterprise customers then")).toBe(true);
    expect(isFollowUp("What about the customers who signed up last year?")).toBe(true);
    expect(isFollowUp("Does that also apply to customers in each region?")).toBe(true);
    expect(isFollowUp("Can you tell me more about how that is handled?")).toBe(true);
  });

  it("does not treat a question that names its own subject as a follow-up", () => {
    expect(isFollowUp("Describe the password reset flow for administrators in the server")).toBe(
      false,
    );
    // Referring words alone ("there", "its") do not make a follow-up.
    expect(isFollowUp("Which teams own the payment reconciliation service and its alerts?")).toBe(
      false,
    );
    expect(isFollowUp("Are there any GDPR requirements in the onboarding spec?")).toBe(false);
    // "Why" opens a new question as often as it continues one.
    expect(isFollowUp("Why does the payment service retry failed card charges twice?")).toBe(false);
  });

  it("counts only the words that name a subject", () => {
    expect(contentWords("Are there any GDPR requirements in the onboarding spec?")).toEqual([
      "gdpr",
      "requirements",
      "onboarding",
      "spec",
    ]);
    expect(contentWords("Does that also apply to them?")).toEqual([]);
  });
});

/**
 * #2269 — the follow-up heuristic against the labelled multi-turn BA questions
 * (`eval-data/corpus/baqa-01-acme-reader`), as `pnpm eval:ba-qa --multi-turn`
 * measured it: every self-contained question is searched on its own, and the
 * follow-ups that name no subject of their own are read with the turn before.
 */
describe("the follow-up heuristic on the BA question set (#2269)", () => {
  const corpus = loadBaQaFixture(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../..",
      "eval-data/corpus/baqa-01-acme-reader",
    ),
  );
  /**
   * Follow-ups that name a subject of their own (four content words), so they
   * are searched as written. Forcing them to follow-ups was measured to find no
   * expected file that their own words missed, and loosening the content-word
   * cap to four would re-admit "Are there any GDPR requirements in the
   * onboarding spec?".
   */
  const SEARCHED_AS_WRITTEN = ["F5", "F8"];
  const plan = (before: string[], text: string) =>
    planRetrievalQueries([
      ...before.flatMap((b) => [user(b), assistant("Here is what the sources show.")]),
      user(text),
    ]);

  it("reads no self-contained question as a follow-up, mid-conversation or not", async () => {
    const f = await corpus;
    const self = f.questions.filter(
      (q) => q.refersBack === false || (!q.before && q.category !== "ambiguous"),
    );
    expect(self.length).toBeGreaterThanOrEqual(16);
    for (const q of self) {
      expect(plan(q.before ?? ["What does the server do?"], q.text)?.contextual, q.id).toBeNull();
    }
  });

  it("reads each subject-less follow-up with the turn before it", async () => {
    const f = await corpus;
    const refers = f.questions.filter((q) => q.refersBack);
    for (const q of refers) {
      const contextual = plan(q.before!, q.text)?.contextual ?? null;
      if (SEARCHED_AS_WRITTEN.includes(q.id)) expect(contextual, q.id).toBeNull();
      else expect(contextual, q.id).toContain(q.before!.at(-1)!);
    }
    expect(refers.filter((q) => !SEARCHED_AS_WRITTEN.includes(q.id)).length).toBe(4);
  });
});

describe("planSearches", () => {
  it("separates the user's own searches from the conversational one", () => {
    const plan = { primary: "q", parts: ["a part?", "b part?"], contextual: "q\nbefore" };
    expect(planSearches(plan)).toEqual({
      user: ["q", "a part?", "b part?"],
      contextual: "q\nbefore",
    });
  });

  it("drops a conversational search that repeats the user's own", () => {
    expect(planSearches({ primary: "q", parts: [], contextual: " q " })).toEqual({
      user: ["q"],
      contextual: null,
    });
    expect(planSearches({ primary: "q", parts: [], contextual: null }).contextual).toBeNull();
  });
});

describe("fuseRetrievalHits", () => {
  const ids = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ chunkId: `${prefix}${i + 1}` }));

  it("returns a single search as it ranked, cut to k", () => {
    expect(fuseRetrievalHits([ids("u", 10)], null, 8).map((h) => h.chunkId)).toEqual(
      ids("u", 8).map((h) => h.chunkId),
    );
  });

  it("never lets the conversational search's own finds fill a majority of the list", () => {
    const fused = fuseRetrievalHits([ids("u", 8)], ids("c", 8), 8);
    const earlier = fused.filter((h) => h.chunkId.startsWith("c"));
    expect(earlier).toHaveLength(3);
    expect(fused).toHaveLength(11);
  });

  it("keeps every one of the user's own k best hits: the earlier topic is added, never swapped in (#2316, F2)", () => {
    // F2: "How often does that run?" — the file asked about was the user's own
    // 8th hit, and two hits only the conversational search found outranked it.
    const user = ids("u", 8);
    user[7] = { chunkId: "internal/cli/scheduler.go" };
    const fused = fuseRetrievalHits([user], [{ chunkId: "FRD-12.md" }, { chunkId: "fr.json" }], 8);
    expect(fused.map((h) => h.chunkId)).toEqual([
      "u1",
      "u2",
      "u3",
      "u4",
      "FRD-12.md",
      "u5",
      "fr.json",
      "u6",
      "u7",
      "internal/cli/scheduler.go",
    ]);
  });

  it("still cuts the user's own searches to k", () => {
    const fused = fuseRetrievalHits([ids("u", 10), ids("p", 10)], null, 8);
    expect(fused).toHaveLength(8);
  });

  it("holds the earlier topic to a minority even when the user's searches found little", () => {
    const fused = fuseRetrievalHits([ids("u", 1)], ids("c", 8), 8);
    expect(fused.map((h) => h.chunkId)).toEqual(["u1", "c1", "c2", "c3"]);
  });

  it("ranks the user's own hit above the conversational one at the same rank", () => {
    expect(CONTEXTUAL_WEIGHT).toBeLessThan(1);
    const fused = fuseRetrievalHits([[{ chunkId: "u" }]], [{ chunkId: "c" }], 8);
    expect(fused.map((h) => h.chunkId)).toEqual(["u", "c"]);
    // Reversed insertion cannot win on order alone: the weight decides.
    const parts = fuseRetrievalHits(
      [[{ chunkId: "x" }], [{ chunkId: "u" }]],
      [{ chunkId: "c" }, { chunkId: "u" }],
      8,
    );
    expect(parts.map((h) => h.chunkId)).toEqual(["u", "x", "c"]);
  });

  it("lifts a hit both searches found, and keeps it whatever the cap", () => {
    const fused = fuseRetrievalHits(
      [[{ chunkId: "noise" }, { chunkId: "both" }]],
      [{ chunkId: "refund" }, { chunkId: "both" }],
      8,
    );
    expect(fused.map((h) => h.chunkId)).toEqual(["both", "noise", "refund"]);
  });

  it("returns nothing from no searches", () => {
    expect(fuseRetrievalHits([], null, 8)).toEqual([]);
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
    // The locator names #1 exactly; the file name adds the rest of rules.md after it.
    expect(citedExcerptIds("Per rules.md#1, …", excerpts)).toEqual(["c2", "c1"]);
    expect(citedExcerptIds("rules.md says…", excerpts)).toEqual(["c1", "c2"]);
  });

  // #2269 — measured: with the flags off, 13 of the 16 first answers that cited an
  // excerpt named it as "`file` (chunk #N)", and none used [n].
  const py: CitableExcerpt[] = [1, 5, 17, 18, 19, 20].map((pos, i) => ({
    n: i + 1,
    chunkId: `p${pos}`,
    name: "miniflux.py",
    locator: `miniflux.py#${pos}`,
  }));

  it("reads a file's chunk numbers as written after its name (#2269)", () => {
    expect(citedExcerptIds("They subclass `ClientError` (`miniflux.py`, chunk #17).", py)).toEqual([
      "p17",
      "p1",
      "p5",
      "p18",
    ]);
    expect(citedExcerptIds("In `miniflux.py` (chunk #19): raises", py).slice(0, 1)).toEqual([
      "p19",
    ]);
    // Lists and ranges of chunk numbers.
    expect(citedExcerptIds("`miniflux.py` (chunks #5, #1 and #20)", py).slice(0, 3)).toEqual([
      "p1",
      "p5",
      "p20",
    ]);
    expect(citedExcerptIds("(`miniflux.py`, chunks #17-#19).", py).slice(0, 3)).toEqual([
      "p17",
      "p18",
      "p19",
    ]);
    // A chunk number with no file before it names nothing.
    expect(citedExcerptIds("See chunk #17.", py)).toEqual([]);
  });

  it("does not read a locator inside a longer chunk number (#2269)", () => {
    // `miniflux.py#18` is not `miniflux.py#1`.
    expect(citedExcerptIds("Per `miniflux.py#18`.", py).slice(0, 1)).toEqual(["p18"]);
    expect(citedExcerptIds("Per `miniflux.py#18`.", py)).toEqual(["p18", "p1", "p5", "p17"]);
  });

  it("reads a range only as wide as MAX_CHUNK_RANGE (#2316)", () => {
    const wide: CitableExcerpt[] = [0, 5, 15, 25].map((pos, i) => ({
      n: i + 1,
      chunkId: `w${pos}`,
      name: "notes.md",
      locator: `notes.md#${pos}`,
    }));
    // #5 to #15 spans 10: every chunk in it is cited.
    expect(citedExcerptIds("`notes.md` (chunks #5-#15)", wide).slice(0, 2)).toEqual(["w5", "w15"]);
    // #0 to #25 is wider: only its two ends are read, so #5 and #15 count as the file only.
    expect(citedExcerptIds("`notes.md` (chunks #0-#25)", wide)).toEqual(["w0", "w25", "w5", "w15"]);
    // A model-written range a prompt can shape is not walked: this returns at once.
    const t0 = performance.now();
    expect(citedExcerptIds("`notes.md` (chunks #0-#999999999)", wide)).toEqual([
      "w0",
      "w5",
      "w15",
      "w25",
    ]);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('does not read " - N" after a chunk number as a range (#2316)', () => {
    const doc: CitableExcerpt[] = [2, 3, 5].map((pos, i) => ({
      n: i + 1,
      chunkId: `r${pos}`,
      name: "rules.md",
      locator: `rules.md#${pos}`,
    }));
    // The 2 counts places, not chunks: only #5 is named exactly.
    expect(citedExcerptIds("`rules.md` (chunk #5 - 2 places) says so", doc)).toEqual([
      "r5",
      "r2",
      "r3",
    ]);
    // A spaced dash before a `#`, or a tight one, is still a range.
    expect(citedExcerptIds("`rules.md` (chunks #2 - #3)", doc).slice(0, 2)).toEqual(["r2", "r3"]);
    expect(citedExcerptIds("`rules.md` (chunks #2–3)", doc).slice(0, 2)).toEqual(["r2", "r3"]);
  });

  it("reads chunk numbers only after the whole name or a path ending in it (#2316)", () => {
    const two: CitableExcerpt[] = [
      {
        n: 1,
        chunkId: "oauth",
        name: "internal/ui/oauth.go",
        locator: "internal/ui/oauth.go#0",
        source: "repo",
      },
      { n: 2, chunkId: "upload", name: "auth.go", locator: "auth.go#3", source: "upload" },
    ];
    // "auth.go" inside "oauth.go" is not the upload: its chunk is not named exactly,
    // so it does not jump ahead of the file the answer did name.
    expect(citedExcerptIds("See `internal/ui/oauth.go` (chunk #3).", two)).toEqual([
      "oauth",
      "upload",
    ]);
    expect(citedExcerptIds("See internal/ui/oauth.go#3.", two)).toEqual(["oauth", "upload"]);
    // The whole name, or a path ending in it, still is.
    expect(citedExcerptIds("See `auth.go` (chunk #3).", two)).toEqual(["upload"]);
    expect(citedExcerptIds("See `cmd/auth.go` (chunk #3).", two)).toEqual(["upload"]);
    expect(citedExcerptIds("Per auth.go#3.", two)).toEqual(["upload"]);
  });

  it("cites nothing for an answer with no citations, a number out of range, or no excerpts", () => {
    expect(citedExcerptIds("I don't know.", excerpts)).toEqual([]);
    expect(citedExcerptIds("see [9]", excerpts)).toEqual([]);
    // #2242 — an index into code is not a citation.
    expect(citedExcerptIds("use arr[1] or f()[3]", excerpts)).toEqual([]);
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

  it("fills the cap with numbered and locator citations before whole-file ones (#2269)", () => {
    // Four excerpts of one long file, then two the answer cites exactly: a file
    // name pulls in every excerpt of the file, and must not crowd out the
    // excerpts the answer named by number or locator.
    const doc = Array.from({ length: 4 }, (_, i) => ({
      n: i + 1,
      chunkId: `d${i + 1}`,
      name: "miniflux.1.txt",
      locator: `miniflux.1.txt#${i}`,
    }));
    const cited = [
      ...doc,
      // #2316 — a locator is always `name#position`, as `formatHitLocator` prints it.
      {
        n: 5,
        chunkId: "o",
        name: "internal/config/options.go",
        locator: "internal/config/options.go#7",
      },
      {
        n: 6,
        chunkId: "s",
        name: "internal/cli/scheduler.go",
        locator: "internal/cli/scheduler.go#1",
      },
    ];
    expect(
      citedExcerptIds(
        "miniflux.1.txt lists it; the default is in [5] and internal/cli/scheduler.go#1.",
        cited,
      ),
    ).toEqual(["o", "s", "d1", "d2"]);
    // With room to spare every match is kept, the exact ones first.
    expect(citedExcerptIds("See miniflux.1.txt and [6].", [doc[0]!, cited[5]!])).toEqual([
      "s",
      "d1",
    ]);
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
