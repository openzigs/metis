import { describe, expect, it } from "vitest";
import type { AIProvider, ChatMessage, ChatOptions, ChatResponse } from "../../ai/types.js";
import { splitSections } from "../../governing/rule-extraction.js";
import {
  buildDocArms,
  charsCovered,
  createArmA,
  createArmB,
  createArmC,
  createArmR,
  documentIdOf,
  documentKnowledge,
  mapLimited,
  parseDocArmIds,
} from "./arms.js";
import type { DocUnderstandingItem } from "./corpus.js";
import { EVAL_READING_PROJECT, createEvalReadingStore } from "./reading-store.js";

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
].join("\n");

const ITEM: DocUnderstandingItem = {
  name: "fixture",
  title: "Booking FRD",
  text: TEXT,
  docxBytes: 1,
  sections: splitSections(TEXT),
  labels: { sections: [], requirements: [], ambiguities: [] },
};

interface Call {
  system: string;
  user: string;
  opts?: ChatOptions;
}

/** A provider that answers by the first system-message phrase it recognises. */
function routedProvider(routes: Array<[string, string | ((call: Call) => string)]>): {
  provider: AIProvider;
  calls: Call[];
} {
  const calls: Call[] = [];
  const provider = {
    key: "anthropic",
    model: "claude-sonnet-5-5",
    offline: false,
    async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> {
      const system =
        opts?.systemMessage ??
        messages
          .filter((m) => m.role === "system")
          .map((m) => m.content as string)
          .join("\n");
      const user = messages
        .filter((m) => m.role === "user")
        .map((m) => m.content as string)
        .join("\n");
      const call = { system, user, opts };
      calls.push(call);
      const route = routes.find(([needle]) => system.includes(needle) || user.includes(needle));
      if (!route) throw new Error(`no route for: ${system.slice(0, 80)}`);
      const content = typeof route[1] === "function" ? route[1](call) : route[1];
      return {
        content,
        model: "claude-sonnet-5-5",
        provider: "anthropic",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    },
  } as unknown as AIProvider;
  return { provider, calls };
}

const EXTRACTION = JSON.stringify({
  requirements: [
    {
      title: "Account lockout",
      description: "Lock after five failures",
      ambiguities: [
        {
          field: "unlock",
          description: "no unlock rule",
          suggestedQuestion: "When does it unlock?",
        },
        { field: "blank", description: "x", suggestedQuestion: "   " },
      ],
    },
  ],
});

/**
 * #2271 — arm R's question loop: the source-mode extraction makes one
 * requirement of REQ-001 with an "unlock" ambiguity, and the question call
 * asks about it.
 */
const LOOP_ROUTES: Array<[string, string | ((call: Call) => string)]> = [
  [
    "clarification session",
    (call) =>
      JSON.stringify({
        questions: [
          {
            requirementId: /\(id: ([^)]+)\)/.exec(call.user)![1],
            ambiguityField: "unlock",
            uncertainty: "silence",
            divergent: true,
            impact: "high",
            question: "When does a locked account unlock?",
            context: "c",
          },
        ],
      }),
  ],
  [
    "Extract structured requirements",
    JSON.stringify({
      requirements: [
        {
          title: "Account lockout",
          description: "Lock after five failures",
          sourceIds: ["REQ-001"],
          ambiguities: [{ field: "unlock", description: "no unlock rule", suggestedQuestion: "" }],
        },
      ],
    }),
  ],
];

/** The document reader's own calls, as against the extraction's and the questions'. */
const readerCalls = (calls: Call[]) =>
  calls.filter(
    (c) =>
      c.system.includes("from beginning to end") || c.system.includes("combining the statements"),
  );

describe("arm A — today's document agent", () => {
  it("retrieves chunks, runs the document agent and extracts from its requirement texts", async () => {
    const { provider, calls } = routedProvider([
      [
        "requirements analyst",
        (call) => {
          expect(call.user).toContain("lock accounts after five failures");
          return EXTRACTION;
        },
      ],
      [
        "Booking FRD",
        JSON.stringify({
          agentKey: "document",
          summary: "s",
          findings: [],
          notes: [],
          requirements: [{ id: "r1", text: "lock accounts after five failures" }],
        }),
      ],
    ]);
    const out = await createArmA("m").read(ITEM, { provider, concurrency: 1 });
    expect(calls).toHaveLength(2);
    // The agent's prompt carries the retrieved document text.
    expect(calls[0]!.user).toContain(
      "The portal shall lock an account after five failed attempts.",
    );
    expect(out.requirements).toEqual([{ text: "Account lockout: Lock after five failures" }]);
    expect(out.questions).toEqual([{ text: "When does it unlock?" }]);
    expect(out.diagnostics).toMatchObject({
      documentChunks: 3,
      retrievedChunks: 3,
      documentChars: TEXT.length,
      agentRequirements: 1,
      agentFindings: 0,
    });
    expect(out.diagnostics.retrievedChars).toBeGreaterThan(0);
  });

  it("seeds the extractor with the agent's findings when it extracted no requirements", async () => {
    const { provider } = routedProvider([
      [
        "requirements analyst",
        (call) => {
          expect(call.user).toContain("Lockout. Accounts lock after five failures");
          return EXTRACTION;
        },
      ],
      [
        "Booking FRD",
        JSON.stringify({
          agentKey: "document",
          summary: "s",
          findings: [
            {
              category: "requirement",
              severity: "medium",
              title: "Lockout",
              body: "Accounts lock after five failures",
              tags: [],
              citations: [],
            },
          ],
          notes: [],
        }),
      ],
    ]);
    const out = await createArmA("m").read(ITEM, { provider, concurrency: 1 });
    expect(out.diagnostics.agentRequirements).toBe(0);
    expect(out.diagnostics.agentFindings).toBe(1);
    expect(out.requirements).toHaveLength(1);
  });
});

const READER_REPLY = (statement: string, question: string) =>
  JSON.stringify({
    requirements: [{ statement, section: "1. Access", quote: "The portal shall lock an account" }],
    questions: [{ question, section: "1. Access", quote: "five failed attempts" }],
  });

describe("arm B — the whole document", () => {
  it("sends the whole document once and reads requirements and questions with their quotes", async () => {
    const { provider, calls } = routedProvider([
      ["from beginning to end", READER_REPLY("Lock after five failures", "When does it unlock?")],
    ]);
    const out = await createArmB("m").read(ITEM, { provider, concurrency: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.user).toContain("A patient shall hold at most two future appointments.");
    expect(out.requirements).toEqual([
      {
        text: "Lock after five failures",
        section: "1. Access",
        quote: "The portal shall lock an account",
      },
    ]);
    expect(out.questions).toEqual([
      { text: "When does it unlock?", section: "1. Access", quote: "five failed attempts" },
    ]);
  });

  it("fails loudly on an unreadable reply", async () => {
    const { provider } = routedProvider([["from beginning to end", "not json"]]);
    await expect(createArmB("m").read(ITEM, { provider, concurrency: 1 })).rejects.toThrow(
      /no usable reply/,
    );
  });
});

describe("arm C — section by section", () => {
  it("builds context, reads each section with it, then drops repeats and settles questions", async () => {
    const { provider, calls } = routedProvider([
      [
        "preparing to read",
        JSON.stringify({
          summary: "A booking portal.",
          glossary: [{ term: "Slot", meaning: "a time" }],
          actors: ["Patient"],
        }),
      ],
      [
        "combining the notes",
        (call) => {
          expect(call.user).toContain("F1 [1. Access] Lock after five failures");
          expect(call.user).toContain("F3 [2. Booking] At most two appointments");
          return JSON.stringify({
            duplicateRequirements: ["F2"],
            questions: [
              { question: "Merged question?", section: "2. Booking", quote: "two future" },
            ],
          });
        },
      ],
      [
        "one section",
        (call) => {
          expect(call.user).toContain("Summary: A booking portal.");
          expect(call.user).toContain("- Slot: a time");
          if (call.user.includes("Section: 1. Access")) {
            return JSON.stringify({
              requirements: [
                { statement: "Lock after five failures", section: "1. Access", quote: "q" },
                { statement: "Lock after five failures again", section: "", quote: "q" },
              ],
              questions: [{ question: "Unlock?", section: "", quote: "q" }],
            });
          }
          if (call.user.includes("Section: 2. Booking")) {
            return JSON.stringify({
              requirements: [{ statement: "At most two appointments", section: "", quote: "q" }],
              questions: [],
            });
          }
          return JSON.stringify({ requirements: [], questions: [] });
        },
      ],
    ]);
    const out = await createArmC("m").read(ITEM, { provider, concurrency: 2 });
    // context + one call per section (title, 1, 2) + reduce
    expect(calls).toHaveLength(ITEM.sections.length + 2);
    expect(out.requirements.map((r) => [r.text, r.section])).toEqual([
      ["Lock after five failures", "1. Access"],
      ["At most two appointments", "2. Booking"],
    ]);
    expect(out.questions).toEqual([
      { text: "Merged question?", section: "2. Booking", quote: "two future" },
    ]);
    expect(out.diagnostics).toMatchObject({
      sections: ITEM.sections.length,
      sectionRequirements: 3,
      sectionQuestions: 1,
      droppedAsRepeated: 1,
      calls: ITEM.sections.length + 2,
    });
  });
});

describe("helpers", () => {
  it("serves the document's chunks through the search seam", async () => {
    const { source, chunks } = documentKnowledge(ITEM);
    expect(chunks).toBe(3);
    const res = await source.search("p", "lock account", { k: 5 });
    // The lexical hit first, then the unmatched chunks in document order: k is never short.
    expect(res.hits.map((h) => [h.position, h.score > 0])).toEqual([
      [1, true],
      [0, false],
      [2, false],
    ]);
    expect(res.hits[0]!.documentId).toBe(documentIdOf(ITEM));
    expect((await source.search("p", "lock account", { k: 2 })).hits).toHaveLength(2);
  });

  it("counts covered characters once, ignoring chunks not found in the text", () => {
    const chunk = (text: string) => ({ documentId: "d", chunkIndex: 0, filename: "f", text });
    expect(charsCovered("abcdefgh", [chunk("abcd"), chunk("cdef"), chunk("zzz")])).toBe(6);
  });

  it("maps with a limit, keeping input order", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimited([3, 1, 2], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, n));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([30, 10, 20]);
    expect(peak).toBe(2);
    expect(await mapLimited([], 4, async () => 1)).toEqual([]);
  });

  it("starts nothing after a call rejects, and rejects only once the calls in flight settle (#2250)", async () => {
    const started: number[] = [];
    let inFlight = 0;
    const run = mapLimited([0, 1, 2, 3, 4, 5], 2, async (n) => {
      started.push(n);
      inFlight++;
      try {
        await new Promise((r) => setTimeout(r, n === 0 ? 1 : 15));
        if (n === 0) throw new Error("section 0 failed");
        return n;
      } finally {
        inFlight--;
      }
    });
    await expect(run).rejects.toThrow("section 0 failed");
    // The sibling's call was still metered into the reading when it rejected.
    expect(inFlight).toBe(0);
    await new Promise((r) => setTimeout(r, 60));
    // No new call was started once one had failed: spend stops with the reading.
    expect(started).toEqual([0, 1]);
  });

  it("rejects with the first failure when several calls fail (#2250)", async () => {
    const run = mapLimited([5, 1], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      throw new Error(`failed after ${n}`);
    });
    await expect(run).rejects.toThrow("failed after 1");
  });

  it("R reads through the production document reader and keeps only requirement-like statements", async () => {
    const { provider, calls } = routedProvider([
      [
        "from beginning to end",
        JSON.stringify({
          statements: [
            {
              section: "S2",
              kind: "requirement",
              statement: "Lock after five failures.",
              quote: "The portal shall lock an account after five failed attempts.",
            },
            {
              section: "S3",
              kind: "business-rule",
              statement: "Two future appointments at most.",
              quote: "A patient shall hold at most two future appointments.",
            },
            {
              section: "S1",
              kind: "background",
              statement: "It is a booking FRD.",
              quote: "Booking FRD heading only here",
            },
          ],
        }),
      ],
      ["combining the statements", JSON.stringify({ duplicates: [], crossReferences: [] })],
      ...LOOP_ROUTES,
    ]);
    const [arm] = buildDocArms(["R"], "claude-sonnet-5-5");
    const out = await arm!.read(ITEM, { provider, concurrency: 1 });
    expect(out.requirements).toEqual([
      {
        text: "Lock after five failures.",
        section: "1. Access",
        quote: "The portal shall lock an account after five failed attempts.",
      },
      {
        text: "Two future appointments at most.",
        section: "2. Booking",
        quote: "A patient shall hold at most two future appointments.",
      },
    ]);
    // #2271 — the first round's question, cited to the paragraph it is about.
    expect(out.questions).toEqual([
      {
        text: "When does a locked account unlock?",
        section: "1. Access",
        quote: "The portal shall lock an account after five failed attempts.",
      },
    ]);
    expect(out.diagnostics).toMatchObject({
      droppedUnverified: 1,
      wholeMode: 1,
      calls: 2,
      sourceStatements: 2,
      structuredRequirements: 1,
      questionsGenerated: 1,
      questionsAsked: 1,
      setAsideUnanswerable: 0,
      setAsideSameOutcome: 0,
      overCap: 0,
    });
    // Two reader calls, then the extraction, then the questions.
    expect(calls).toHaveLength(4);
    expect(readerCalls(calls)).toHaveLength(2);
    expect(calls[2]!.user).toContain("[REQ-002]");
    expect(arm!.configuration.questions).toMatch(/selectQuestionsToAsk/);
  });

  describe("#2319 — R reads through readDocumentOnce with a store", () => {
    const READER_ROUTES: Array<[string, string | ((call: Call) => string)]> = [
      [
        "from beginning to end",
        JSON.stringify({
          statements: [
            {
              section: "S2",
              kind: "requirement",
              statement: "Lock after five failures.",
              quote: "The portal shall lock an account after five failed attempts.",
            },
            {
              section: "S3",
              kind: "business-rule",
              statement: "Two future appointments at most.",
              quote: "A patient shall hold at most two future appointments.",
            },
          ],
        }),
      ],
      ["combining the statements", JSON.stringify({ duplicates: [], crossReferences: [] })],
      ...LOOP_ROUTES,
    ];

    it("by default reads the document again every run, and saves the reading", async () => {
      const store = createEvalReadingStore();
      const { provider, calls } = routedProvider(READER_ROUTES);
      const arm = createArmR("m", { store });
      const first = await arm.read(ITEM, { provider, concurrency: 1 });
      const second = await arm.read(ITEM, { provider, concurrency: 1 });
      expect(readerCalls(calls)).toHaveLength(4);
      expect([first.diagnostics.reused, second.diagnostics.reused]).toEqual([0, 0]);
      expect(second.diagnostics).not.toHaveProperty("identicalToSaved");
      expect(store.readings()).toHaveLength(1);
      expect(store.readings()[0]).toMatchObject({
        projectId: EVAL_READING_PROJECT,
        documentId: documentIdOf(ITEM),
      });
      expect(arm.configuration.savedReadings).toMatch(/read again every run/);
    });

    it("with saved readings, a second run reuses the first's with no reader call, identical", async () => {
      const { provider, calls } = routedProvider(READER_ROUTES);
      const [arm] = buildDocArms(["R"], "m", { reuseSavedReadings: true });
      const first = await arm!.read(ITEM, { provider, concurrency: 1 });
      expect(readerCalls(calls)).toHaveLength(2);
      const second = await arm!.read(ITEM, { provider, concurrency: 1 });
      expect(readerCalls(calls)).toHaveLength(2);
      // #2271 — the reused reading is still extracted from and asked about,
      // as an analysis of a stored document is.
      expect(calls).toHaveLength(6);
      expect(second.questions).toEqual(first.questions);
      expect(second.questions).toHaveLength(1);
      expect(first.diagnostics).toMatchObject({ reused: 0, calls: 2 });
      expect(second.diagnostics).toMatchObject({ reused: 1, calls: 0, identicalToSaved: 1 });
      expect(second.requirements).toEqual(first.requirements);
      expect(arm!.configuration.savedReadings).toMatch(/--saved-readings/);
    });

    it("says when a reused reading is not the one that was saved", async () => {
      const store = createEvalReadingStore();
      const { provider } = routedProvider(READER_ROUTES);
      const arm = createArmR("m", { store, reuseSavedReadings: true });
      await arm.read(ITEM, { provider, concurrency: 1 });
      const row = store.readings()[0]!;
      const saved = JSON.parse(row.reading as string);
      saved.statements[0].statement = "Something else.";
      row.reading = JSON.stringify(saved);
      const again = await arm.read(ITEM, { provider, concurrency: 1 });
      expect(again.diagnostics).toMatchObject({ reused: 1, identicalToSaved: 0 });
    });

    it("fails the read when the store stand-in met a call it does not implement", async () => {
      const store = createEvalReadingStore();
      const { provider } = routedProvider(READER_ROUTES);
      const arm = createArmR("m", { store, reuseSavedReadings: true });
      // readDocumentOnce swallows a failed lookup and reads again; the arm must not.
      await expect(
        (
          store.db as unknown as { savedDocumentReading: { findUnique(): Promise<unknown> } }
        ).savedDocumentReading.findUnique(),
      ).rejects.toThrow();
      await expect(arm.read(ITEM, { provider, concurrency: 1 })).rejects.toThrow(
        /reading store stand-in/,
      );
    });

    it("reads a changed document again: its text is another file", async () => {
      const { provider, calls } = routedProvider(READER_ROUTES);
      const arm = createArmR("m", { reuseSavedReadings: true });
      await arm.read(ITEM, { provider, concurrency: 1 });
      const edited = { ...ITEM, text: `${TEXT}\n` };
      const out = await arm.read(edited, { provider, concurrency: 1 });
      expect(out.diagnostics.reused).toBe(0);
      expect(readerCalls(calls)).toHaveLength(4);
    });
  });

  it("parses arm ids and refuses unknown ones", () => {
    expect(parseDocArmIds(undefined)).toEqual(["A", "B", "C"]);
    expect(parseDocArmIds("r")).toEqual(["R"]);
    expect(parseDocArmIds("b, a,b")).toEqual(["B", "A"]);
    expect(() => parseDocArmIds("A,Z")).toThrow(/unknown arm/);
    expect(() => parseDocArmIds(" , ")).toThrow(/at least one/);
    expect(buildDocArms(["C", "A"], "m").map((a) => [a.id, a.configuration.model])).toEqual([
      ["C", "m"],
      ["A", "m"],
    ]);
  });
});
