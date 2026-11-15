/**
 * #2534 — with `ANALYSIS_DOCUMENT_READER` on, a document's extraction holds
 * hundreds of open ambiguities. The round's question call wrote one question
 * for each in one reply, overran the provider's output cap twice, and the
 * round failed (`MODEL_REPLY_UNREADABLE`), to ask at most 8. It now writes
 * questions only for the ambiguities chosen for the round, and every later
 * round chooses again from what is still open.
 *
 * The durable dialog store is the shared in-memory fake; every assertion reads
 * the state back through it, as the route does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, unknown>());
vi.mock("./clarification-dialog-store.js", async () => {
  const { dialogStoreCasFakes } = await import("../../../tests/helpers/dialog-store-cas-fake.js");
  return {
    readDialogState: vi.fn(async (id: string) => store.get(id)),
    writeDialogState: vi.fn(async (id: string, state: unknown) => {
      store.set(id, state);
    }),
    deleteDialogState: vi.fn(async (id: string) => {
      store.delete(id);
    }),
    ...dialogStoreCasFakes(store),
  };
});

import { ClarificationDialog, generateClarifyingQuestions } from "./clarification-dialog.js";
import { MAX_QUESTIONS_PER_ROUND, QUESTION_CANDIDATES_PER_ROUND } from "./question-selection.js";
import { addressedAmbiguities } from "./types/requirements.js";
import type { AIProvider, ChatMessage, ChatResponse } from "../ai/types.js";
import type {
  ClarificationState,
  StructuredRequirement,
  StructuredRequirements,
} from "./types/requirements.js";

const FIELDS = ["a", "b", "c", "d"];

function requirement(i: number): StructuredRequirement {
  return {
    id: `r${i}`,
    title: `Requirement ${i}`,
    description: `Description of ${i}`,
    type: "functional",
    stakeholders: [],
    priority: "should-have",
    ambiguities: FIELDS.map((field) => ({
      field,
      description: `${field} of ${i} is unclear`,
      suggestedQuestion: "",
    })),
    evidenceNeeds: [],
    rawSource: "",
    sources: [
      {
        ref: `REQ-${i}`,
        filename: "frd.docx",
        headingPath: ["2 Booking"],
        quote: `Statement ${i}.`,
      },
    ],
  };
}

/** The clinic-booking FRD's size: 61 requirements, 244 open ambiguities. */
const DOCUMENT: StructuredRequirements = {
  requirements: Array.from({ length: 61 }, (_, i) => requirement(i)),
  totalAmbiguities: 61 * FIELDS.length,
  totalEvidenceNeeds: 0,
};

/** The `requirementId:key` of each ambiguity the question prompt lists. */
function listed(user: string): string[] {
  const out: string[] = [];
  let id = "";
  for (const line of user.split("\n")) {
    const req = /\(id: ([^)]+)\):$/.exec(line);
    if (req) id = req[1]!;
    const amb = /^ {2}- ([^:\s]+): /.exec(line);
    if (amb && id) out.push(`${id}:${amb[1]}`);
  }
  return out;
}

/**
 * Answers a question call with one question per listed ambiguity, graded by
 * `grade`, plus `extra`; any other call is a resolution that resolves nothing.
 */
function documentProvider(
  grade: (key: string, i: number) => Record<string, unknown> = () => ({}),
  extra: unknown[] = [],
  /** Which listed ambiguities the model writes a question for. */
  keep: (key: string, i: number) => boolean = () => true,
) {
  const prompts: string[] = [];
  const chat = vi.fn(async (messages: ChatMessage[]): Promise<ChatResponse> => {
    const system = String(messages[0]!.content);
    const user = String(messages[1]!.content);
    if (!system.includes("clarification session")) {
      return {
        content: JSON.stringify({ resolvedFields: [], updatedDescription: null }),
      } as ChatResponse;
    }
    prompts.push(user);
    const questions = listed(user)
      .filter(keep)
      .map((key, i) => {
        const [requirementId, ambiguityField] = key.split(":");
        return {
          requirementId,
          ambiguityField,
          uncertainty: "ambiguity",
          divergent: true,
          impact: "medium",
          question: `What is meant by ${ambiguityField} in ${requirementId}?`,
          context: "c",
          ...grade(key, i),
        };
      });
    return { content: JSON.stringify({ questions: [...questions, ...extra] }) } as ChatResponse;
  });
  const provider = {
    key: "offline-stub",
    model: "test-model",
    offline: false,
    chat,
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn(),
    ping: vi.fn(),
  } as unknown as AIProvider;
  return { provider, prompts };
}

const keyOf = (q: { requirementId: string; ambiguityField: string }) =>
  `${q.requirementId}:${q.ambiguityField}`;

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe("#2534 — a round's question call over a document's hundreds of ambiguities", () => {
  it("writes questions for at most QUESTION_CANDIDATES_PER_ROUND, and asks at most the round's cap", async () => {
    const { provider, prompts } = documentProvider();
    // Mode decided from the requirements: they carry their source paragraphs.
    const state = await new ClarificationDialog({ provider }).startOrContinue("a1", DOCUMENT);
    expect(prompts).toHaveLength(1);
    const chosen = listed(prompts[0]!);
    expect(chosen).toHaveLength(QUESTION_CANDIDATES_PER_ROUND);
    // One per requirement, before any requirement's second.
    expect(new Set(chosen.map((k) => k.split(":")[0])).size).toBe(QUESTION_CANDIDATES_PER_ROUND);
    // A requirement none of whose ambiguities was chosen is not in the prompt.
    expect(prompts[0]!.match(/\(id: r\d+\):/g)).toHaveLength(QUESTION_CANDIDATES_PER_ROUND);
    expect(prompts[0]).not.toContain("Statement 60.");
    const round = state.rounds[0]!;
    expect(round.questions).toHaveLength(MAX_QUESTIONS_PER_ROUND);
    expect(round.questions.every((q) => chosen.includes(keyOf(q)))).toBe(true);
    // The rest of the chosen were worth asking: over the cap, as before.
    expect(round.notAsked).toBe(QUESTION_CANDIDATES_PER_ROUND - MAX_QUESTIONS_PER_ROUND);
    // Read back through the store, as the route does.
    expect((store.get("a1") as ClarificationState).rounds[0]!.questions).toHaveLength(
      MAX_QUESTIONS_PER_ROUND,
    );
  });

  it("chooses again in each later round, never an answered or set-aside ambiguity", async () => {
    // Every fourth question of a call is unanswerable: set aside, so addressed.
    const { provider, prompts } = documentProvider((_key, i) =>
      i % 4 === 0 ? { uncertainty: "unanswerable" } : {},
    );
    const dialog = new ClarificationDialog({ provider, sourceQuestions: true });
    let state = await dialog.startOrContinue("a1", DOCUMENT);
    for (let round = 1; round <= 3; round++) {
      const addressedBefore = addressedAmbiguities(state);
      const asked = state.rounds[round - 1]!.questions;
      const prompt = listed(prompts[round - 1]!);
      expect(prompt.length).toBeGreaterThan(0);
      expect(prompt.length).toBeLessThanOrEqual(QUESTION_CANDIDATES_PER_ROUND);
      expect(asked.length).toBeGreaterThan(0);
      expect(asked.length).toBeLessThanOrEqual(MAX_QUESTIONS_PER_ROUND);
      if (round > 1) {
        // The answered and the set-aside are neither listed nor asked again.
        const previous = state.rounds.slice(0, round - 1).flatMap((r) => r.questions.map(keyOf));
        const setAsideBefore = (state.setAside ?? []).filter((s) => s.round < round).map(keyOf);
        expect(setAsideBefore.length).toBeGreaterThan(0);
        for (const key of [...previous, ...setAsideBefore]) {
          expect(prompt).not.toContain(key);
        }
        expect(asked.some((q) => previous.includes(keyOf(q)))).toBe(false);
      }
      const answers = asked.map((q) => ({ questionId: q.id, answer: "the account holder" }));
      ({ state } = await dialog.submitAnswers("a1", answers, DOCUMENT));
      expect(addressedAmbiguities(state).size).toBeGreaterThan(addressedBefore.size);
      if (round < 3) state = await dialog.startOrContinue("a1", DOCUMENT);
    }
    expect(prompts).toHaveLength(3);
    expect(state.completed).toBe(true);
  });

  it("does not file a question under an ambiguity left out of the call", async () => {
    // r0 is listed under "a" only; the model also asks about its "b".
    const { provider } = documentProvider(
      () => ({}),
      [
        {
          requirementId: "r0",
          ambiguityField: "b",
          uncertainty: "ambiguity",
          divergent: true,
          impact: "high",
          question: "What does b of 0 cover?",
          context: "c",
        },
      ],
    );
    const generated = await generateClarifyingQuestions(provider, {
      requirements: DOCUMENT.requirements,
      round: 1,
      addressed: new Set(),
      sourceQuestions: true,
    });
    expect(generated).toHaveLength(QUESTION_CANDIDATES_PER_ROUND);
    expect(generated.map(keyOf)).not.toContain("r0:b");
  });

  it("chooses the ticked items' ambiguities first in a dialog started from them (#1129)", async () => {
    const { provider, prompts } = documentProvider();
    const state = await new ClarificationDialog({
      provider,
      askFirst: new Set(["r60"]),
    }).startOrContinue("a1", DOCUMENT);
    // r60 is the document's last: chosen only because it was ticked.
    expect(listed(prompts[0]!)).toContain("r60:a");
    expect(state.rounds[0]!.questions[0]!.requirementId).toBe("r60");
  });

  it("leads the call with the ticked items' ambiguities", async () => {
    const { provider, prompts } = documentProvider();
    await generateClarifyingQuestions(provider, {
      requirements: DOCUMENT.requirements,
      round: 1,
      addressed: new Set(),
      sourceQuestions: true,
      askFirst: new Set(["r60"]),
    });
    expect(listed(prompts[0]!)).toContain("r60:a");
  });

  it("leaves the legacy mode as it was: every open ambiguity in one call", async () => {
    const { provider, prompts } = documentProvider();
    await generateClarifyingQuestions(provider, {
      requirements: DOCUMENT.requirements,
      round: 1,
      addressed: new Set(),
      sourceQuestions: false,
    });
    expect(listed(prompts[0]!)).toHaveLength(61 * FIELDS.length);
  });
});

/** A document with exactly `open` open ambiguities, four to a requirement. */
function documentWith(open: number): StructuredRequirements {
  const requirements = Array.from({ length: Math.ceil(open / FIELDS.length) }, (_, i) =>
    requirement(i),
  );
  const last = requirements.at(-1)!;
  last.ambiguities = last.ambiguities.slice(0, open - (requirements.length - 1) * FIELDS.length);
  return { requirements, totalAmbiguities: open, totalEvidenceNeeds: 0 };
}

describe("#2543 — a round counts the open ambiguities its question call left out", () => {
  const cap = QUESTION_CANDIDATES_PER_ROUND;
  const roundOf = (id: string) => (store.get(id) as ClarificationState).rounds.at(-1)!;

  it("carries the cap's remainder on the round, apart from the questions not asked", async () => {
    const { provider } = documentProvider();
    await new ClarificationDialog({ provider }).startOrContinue("a1", DOCUMENT);
    // Read back through the store, as the route does.
    const round = roundOf("a1");
    expect(round.notConsidered).toBe(DOCUMENT.totalAmbiguities - cap);
    expect(round.notAsked).toBe(cap - MAX_QUESTIONS_PER_ROUND);
  });

  it("counts a chosen ambiguity the model wrote no question for", async () => {
    // 4 of the cap's 24 chosen ambiguities get no question: counted, not lost.
    const { provider } = documentProvider(
      () => ({}),
      [],
      (_key, i) => i >= 4,
    );
    await new ClarificationDialog({ provider, sourceQuestions: true }).startOrContinue(
      "unwritten",
      DOCUMENT,
    );
    expect(roundOf("unwritten").notConsidered).toBe(DOCUMENT.totalAmbiguities - cap + 4);
  });

  it("leaves none out at the cap, and one just past it", async () => {
    const { provider } = documentProvider();
    const dialog = new ClarificationDialog({ provider, sourceQuestions: true });
    await dialog.startOrContinue("at-cap", documentWith(cap));
    expect(roundOf("at-cap").notConsidered).toBeUndefined();
    expect(roundOf("at-cap").notAsked).toBe(cap - MAX_QUESTIONS_PER_ROUND);
    await dialog.startOrContinue("past-cap", documentWith(cap + 1));
    expect(roundOf("past-cap").notConsidered).toBe(1);
    expect(roundOf("past-cap").notAsked).toBe(cap - MAX_QUESTIONS_PER_ROUND);
  });

  it("counts against what is still open in a later round", async () => {
    const { provider } = documentProvider();
    const dialog = new ClarificationDialog({ provider, sourceQuestions: true });
    let state = await dialog.startOrContinue("a1", DOCUMENT);
    const answers = state.rounds[0]!.questions.map((q) => ({ questionId: q.id, answer: "yes" }));
    ({ state } = await dialog.submitAnswers("a1", answers, DOCUMENT));
    const addressed = addressedAmbiguities(state).size;
    expect(addressed).toBeGreaterThanOrEqual(MAX_QUESTIONS_PER_ROUND);
    await dialog.startOrContinue("a1", DOCUMENT);
    expect(roundOf("a1").round).toBe(2);
    expect(roundOf("a1").notConsidered).toBe(DOCUMENT.totalAmbiguities - addressed - cap);
  });

  it("leaves none out of a round that asks the open ambiguities as written", async () => {
    // Every written question builds the same thing whichever way: set aside,
    // so nothing is worth asking and the round falls back to what is open —
    // the one ambiguity the call left out.
    const { provider } = documentProvider(() => ({ divergent: false }));
    await new ClarificationDialog({ provider, sourceQuestions: true }).startOrContinue(
      "a1",
      documentWith(cap + 1),
    );
    const round = roundOf("a1");
    expect(round.questions).toHaveLength(1);
    expect(round.notConsidered).toBeUndefined();
  });

  it("leaves the legacy mode's rounds without the count: it writes every question", async () => {
    const { provider } = documentProvider();
    await new ClarificationDialog({ provider, sourceQuestions: false }).startOrContinue(
      "a1",
      DOCUMENT,
    );
    expect(roundOf("a1").notConsidered).toBeUndefined();
  });
});
