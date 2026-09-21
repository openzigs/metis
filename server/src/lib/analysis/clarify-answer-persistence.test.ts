/**
 * Issue #1104 finding C — clarify answers accepted, then unreachable.
 *
 * The live symptom: `POST .../clarify` accepted 12 answers and the returned
 * `updatedRequirements` folded them in correctly, but the persisted round state
 * carried no readable answers (`rounds[0].questions` had none), so the UI
 * reported "0 resolved / 12 remaining" and — after reload — hid the whole
 * clarification block. The observed `metadata.structuredRequirements` had
 * `totalAmbiguities: -28`, because the resolution model's `resolvedFields` were
 * pushed unvalidated and undeduped (40 "resolved" entries for 12 real
 * ambiguities) and then subtracted from the original total.
 *
 * These tests assert on what is PERSISTED (the round read back from the store),
 * not on the response body — the response was already correct.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── in-memory dialog store mock (same shape as clarification-dialog.test.ts) ──
const store = new Map<string, unknown>();
vi.mock("./clarification-dialog-store.js", () => ({
  readDialogState: vi.fn(async (id: string) => store.get(id)),
  writeDialogState: vi.fn(async (id: string, state: unknown) => {
    store.set(id, JSON.parse(JSON.stringify(state)));
  }),
  deleteDialogState: vi.fn(async (id: string) => {
    store.delete(id);
  }),
}));

import { ClarificationDialog, _setDialogState } from "./clarification-dialog.js";
import type { AIProvider, ChatResponse } from "../ai/types.js";
import type { ClarificationState, StructuredRequirements } from "./types/requirements.js";

const ANALYSIS_ID = "an_1104c";

const REQUIREMENTS = {
  requirements: [
    {
      id: "r1",
      title: "Inventory decrement",
      description: "Decrement inventory when an order is placed.",
      type: "functional",
      priority: "high",
      ambiguities: [
        { field: "isolationLevel", description: "isolation level unspecified" },
        { field: "oversellPolicy", description: "oversell handling unspecified" },
      ],
      evidenceNeeds: [],
    },
  ],
  totalAmbiguities: 2,
  totalEvidenceNeeds: 0,
} as unknown as StructuredRequirements;

const QUESTIONS_RESPONSE = JSON.stringify({
  questions: [
    {
      requirementId: "r1",
      ambiguityField: "isolationLevel",
      question: "Which isolation level?",
      context: "unspecified",
    },
    {
      requirementId: "r1",
      ambiguityField: "oversellPolicy",
      question: "What happens on oversell?",
      context: "unspecified",
    },
  ],
});

/**
 * The live shape of the resolution response: the model claims MORE resolved
 * fields than the requirement actually has ambiguities, repeats one, and names
 * a field that is not an ambiguity at all. This is what produced -28.
 */
const RESOLUTION_RESPONSE = JSON.stringify({
  resolvedFields: [
    "isolationLevel",
    "isolationLevel",
    "oversellPolicy",
    "retryStrategy",
    "auditTrail",
  ],
  updatedDescription:
    "Decrement inventory at READ COMMITTED isolation level, guaranteed by the conditional UPDATE.",
  remainingUncertainty: 0.1,
});

let lastChat: ReturnType<typeof vi.fn>;

function makeProvider(): AIProvider {
  let call = 0;
  const chat = vi.fn(async (): Promise<ChatResponse> => {
    call += 1;
    return { content: call === 1 ? QUESTIONS_RESPONSE : RESOLUTION_RESPONSE } as ChatResponse;
  });
  lastChat = chat;
  return {
    key: "offline-stub",
    model: "test-model",
    offline: false,
    chat,
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn(),
    ping: vi.fn(),
  } as unknown as AIProvider;
}

async function startAndAnswer(): Promise<{
  persisted: ClarificationState;
  updated: StructuredRequirements;
}> {
  const dialog = new ClarificationDialog({ provider: makeProvider() });
  const started = await dialog.startOrContinue(ANALYSIS_ID, REQUIREMENTS);
  const questions = started.rounds[0]!.questions;
  const result = await dialog.submitAnswers(
    ANALYSIS_ID,
    [
      { questionId: questions[0]!.id, answer: "READ COMMITTED with a conditional UPDATE." },
      { questionId: questions[1]!.id, answer: "Prompt the customer to adjust the item." },
    ],
    REQUIREMENTS,
  );
  return {
    persisted: store.get(ANALYSIS_ID) as ClarificationState,
    updated: result.updatedRequirements,
  };
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe("#1104 C — submitted clarify answers stay readable in the persisted round", () => {
  it("stamps each answer onto its question in the persisted round state", async () => {
    const { persisted } = await startAndAnswer();

    const round = persisted.rounds[0]!;
    expect(round.questions).toHaveLength(2);
    expect(round.questions.map((q) => q.answer)).toEqual([
      "READ COMMITTED with a conditional UPDATE.",
      "Prompt the customer to adjust the item.",
    ]);
  });

  it("keeps the round's answers array as the durable record too", async () => {
    const { persisted } = await startAndAnswer();
    expect(persisted.rounds[0]!.answers).toHaveLength(2);
  });

  it("records only REAL ambiguity keys as resolved, deduped", async () => {
    const { persisted } = await startAndAnswer();

    // `retryStrategy` / `auditTrail` are not ambiguities on r1, and
    // `isolationLevel` was claimed twice.
    expect([...persisted.resolvedAmbiguities].sort()).toEqual([
      "r1:isolationLevel",
      "r1:oversellPolicy",
    ]);
  });

  it("never reports a negative remaining-ambiguity count", async () => {
    const { updated } = await startAndAnswer();
    expect(updated.totalAmbiguities).toBe(0);
    expect(updated.totalAmbiguities).toBeGreaterThanOrEqual(0);
  });

  it("does not spend a resolution call on a requirement nobody answered", async () => {
    const dialog = new ClarificationDialog({ provider: makeProvider() });
    await dialog.startOrContinue(ANALYSIS_ID, REQUIREMENTS);
    const chat = lastChat;
    const callsAfterQuestions = chat.mock.calls.length;

    // A blank answer is not an answer.
    const { updatedRequirements } = await dialog.submitAnswers(
      ANALYSIS_ID,
      [
        {
          questionId: (store.get(ANALYSIS_ID) as ClarificationState).rounds[0]!.questions[0]!.id,
          answer: "   ",
        },
      ],
      REQUIREMENTS,
    );

    expect(chat.mock.calls.length).toBe(callsAfterQuestions);
    expect(updatedRequirements.totalAmbiguities).toBe(2);
    expect((store.get(ANALYSIS_ID) as ClarificationState).resolvedAmbiguities).toEqual([]);
  });

  it("ignores answers for a requirement that is no longer in the set", async () => {
    const dialog = new ClarificationDialog({ provider: makeProvider() });
    const started = await dialog.startOrContinue(ANALYSIS_ID, REQUIREMENTS);
    const q = started.rounds[0]!.questions[0]!;

    const otherRequirements = {
      ...REQUIREMENTS,
      requirements: [{ ...REQUIREMENTS.requirements[0]!, id: "r2" }],
    } as StructuredRequirements;

    const { updatedRequirements } = await dialog.submitAnswers(
      ANALYSIS_ID,
      [{ questionId: q.id, answer: "READ COMMITTED." }],
      otherRequirements,
    );

    // r1's questions can't resolve r2's ambiguities.
    expect(updatedRequirements.totalAmbiguities).toBe(2);
  });

  it("keeps the original description when the model returns no update", async () => {
    const chat = vi.fn(async (): Promise<ChatResponse> => {
      if (chat.mock.calls.length === 1) return { content: QUESTIONS_RESPONSE } as ChatResponse;
      // Unparseable resolution on the first requirement pass.
      return { content: "not json at all" } as ChatResponse;
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

    const dialog = new ClarificationDialog({ provider });
    const started = await dialog.startOrContinue(ANALYSIS_ID, REQUIREMENTS);
    const { updatedRequirements } = await dialog.submitAnswers(
      ANALYSIS_ID,
      [{ questionId: started.rounds[0]!.questions[0]!.id, answer: "READ COMMITTED." }],
      REQUIREMENTS,
    );

    expect(updatedRequirements.requirements[0]!.description).toBe(
      REQUIREMENTS.requirements[0]!.description,
    );
    // Issue #1117 (finding A) — this used to expect 2, on the premise that a
    // useless resolution response means nothing was resolved. The user DID
    // answer `isolationLevel`, and an answered ambiguity is no longer
    // outstanding work for them however the model responded, so 1 remains.
    // The property this test was really written to guard is unchanged: the
    // count is derived from the requirements, so it can never go negative.
    expect(updatedRequirements.totalAmbiguities).toBe(1);
    expect(updatedRequirements.totalAmbiguities).toBeGreaterThanOrEqual(0);
  });

  it("does not re-ask once the dialog is complete", async () => {
    const dialog = new ClarificationDialog({ provider: makeProvider() });
    await dialog.startOrContinue(ANALYSIS_ID, REQUIREMENTS);
    const questions = (store.get(ANALYSIS_ID) as ClarificationState).rounds[0]!.questions;
    await dialog.submitAnswers(
      ANALYSIS_ID,
      questions.map((q) => ({ questionId: q.id, answer: "answered" })),
      REQUIREMENTS,
    );

    const resumed = await dialog.startOrContinue(ANALYSIS_ID, REQUIREMENTS);

    expect(resumed.completed).toBe(true);
    // The answered round is still there to read back.
    expect(resumed.rounds).toHaveLength(1);
    expect(resumed.rounds[0]!.questions.every((q) => q.answer === "answered")).toBe(true);
  });

  it("rejects an answer submission with no dialog at all", async () => {
    const dialog = new ClarificationDialog({ provider: makeProvider() });
    await expect(
      dialog.submitAnswers("an_missing", [{ questionId: "q", answer: "a" }], REQUIREMENTS),
    ).rejects.toThrow(/No clarification dialog/);
  });

  it("rejects an answer submission when the dialog has no round yet", async () => {
    await _setDialogState(ANALYSIS_ID, {
      analysisId: ANALYSIS_ID,
      currentRound: 1,
      maxRounds: 3,
      rounds: [],
      resolvedAmbiguities: [],
      escalatedToSonnet: false,
      completed: false,
    });
    const dialog = new ClarificationDialog({ provider: makeProvider() });

    await expect(
      dialog.submitAnswers(ANALYSIS_ID, [{ questionId: "q", answer: "a" }], REQUIREMENTS),
    ).rejects.toThrow(/No active round/);
  });

  it("counts remaining ambiguities from the requirements, not by subtraction", async () => {
    // Only ONE of the two questions is answered → one ambiguity remains.
    const dialog = new ClarificationDialog({ provider: makeProvider() });
    const started = await dialog.startOrContinue(ANALYSIS_ID, REQUIREMENTS);
    const q = started.rounds[0]!.questions[0]!;
    const { updatedRequirements } = await dialog.submitAnswers(
      ANALYSIS_ID,
      [{ questionId: q.id, answer: "READ COMMITTED." }],
      REQUIREMENTS,
    );

    // The model claims BOTH fields resolved (see RESOLUTION_RESPONSE), but only
    // `isolationLevel` was actually answered — an unanswered ambiguity cannot be
    // resolved by a round that never heard about it.
    const persisted = store.get(ANALYSIS_ID) as ClarificationState;
    expect(persisted.resolvedAmbiguities).toEqual(["r1:isolationLevel"]);
    expect(updatedRequirements.totalAmbiguities).toBe(1);
    expect(persisted.rounds[0]!.questions[0]!.answer).toBe("READ COMMITTED.");
    expect(persisted.rounds[0]!.questions[1]!.answer).toBeUndefined();
  });
});
