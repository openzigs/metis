/**
 * Issue #1117 finding A — 14 substantive answers, "1 resolved / 13 remaining".
 *
 * In the reported run the user answered 14 clarifying questions. The resolution
 * model returned exactly ONE `resolvedFields` entry that survived #1104's
 * real-field/answered-field filter, so `resolvedAmbiguities` had length 1 — and
 * because everything user-facing was derived from that array, the panel said
 * "1 resolved / 13 remaining" and re-presented all 14 questions under a Round 2
 * heading. The answers themselves had persisted perfectly.
 *
 * The fix is NOT to loosen #1104's filter, which exists because the model
 * over-claimed 40 resolutions for 12 ambiguities. It is to stop deriving
 * user-facing behaviour from a model's opinion of its own work: what to ask
 * next, when the dialog is finished, and what the panel says now come from
 * `answeredAmbiguities`, which is computed deterministically from the answers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { ClarificationDialog } from "./clarification-dialog.js";
import { addressedAmbiguities } from "./types/requirements.js";
import type { AIProvider, ChatResponse } from "../ai/types.js";
import type { ClarificationState, StructuredRequirements } from "./types/requirements.js";

const ANALYSIS_ID = "an_1117a";

/** Three real ambiguities on one requirement — the shape of the live run. */
const REQUIREMENTS = {
  requirements: [
    {
      id: "r1",
      title: "Guest checkout",
      description: "Allow checkout without a SIGNON account.",
      type: "functional",
      priority: "high",
      ambiguities: [
        { field: "dsaApplicability", description: "DSA applicability unclear" },
        { field: "addressCapture", description: "address capture unspecified" },
        { field: "accountPrompt", description: "post-order account prompt unspecified" },
      ],
      evidenceNeeds: [],
    },
  ],
  totalAmbiguities: 3,
  totalEvidenceNeeds: 0,
} as unknown as StructuredRequirements;

const ALL_FIELDS = ["dsaApplicability", "addressCapture", "accountPrompt"] as const;

/**
 * The reported failure mode: the model confirms ONE field and says nothing
 * about the other two, even though all three were answered.
 */
const STINGY_RESOLUTION = JSON.stringify({
  resolvedFields: ["dsaApplicability"],
  updatedDescription: "Allow checkout without a SIGNON account; the DSA does not apply.",
  remainingUncertainty: 0.4,
});

/**
 * A well-behaved question generator: it asks only about the fields the prompt
 * actually lists as still open. Answering by call index instead would make a
 * second round trivially pass or fail for fixture reasons rather than because
 * the dialog narrowed the ambiguity summary correctly.
 */
function makeProvider(resolution = STINGY_RESOLUTION): AIProvider {
  const chat = vi.fn(async (messages: Array<{ content: string }>): Promise<ChatResponse> => {
    const prompt = messages.map((m) => m.content).join("\n");
    if (!prompt.includes("Generate clarifying questions")) {
      return { content: resolution } as ChatResponse;
    }
    const questions = ALL_FIELDS.filter((f) => prompt.includes(f)).map((field) => ({
      requirementId: "r1",
      ambiguityField: field,
      question: `About ${field}?`,
      context: "",
    }));
    return { content: JSON.stringify({ questions }) } as ChatResponse;
  });
  return { key: "offline-stub", offline: false, chat } as unknown as AIProvider;
}

const ANSWERS: Record<string, string> = {
  dsaApplicability: "The EU Digital Services Act does not apply to this storefront.",
  addressCapture: "Capture email and shipping address on the order row itself.",
  accountPrompt: "Present an optional, dismissible prompt after the order completes.",
};

async function startAndAnswer(
  provider: AIProvider = makeProvider(),
): Promise<{ dialog: ClarificationDialog; state: ClarificationState }> {
  const dialog = new ClarificationDialog({ provider });
  const started = await dialog.startOrContinue(ANALYSIS_ID, REQUIREMENTS);
  const questions = started.rounds[0]!.questions;
  const { state } = await dialog.submitAnswers(
    ANALYSIS_ID,
    questions.map((q) => ({ questionId: q.id, answer: ANSWERS[q.ambiguityField]! })),
    REQUIREMENTS,
  );
  return { dialog, state };
}

beforeEach(() => store.clear());

describe("clarify resolution accounting (#1117 A)", () => {
  it("records every answered ambiguity even when the model confirms only one", async () => {
    const { state } = await startAndAnswer();

    // The model's own tally is untouched — #1104's filter still governs it.
    expect(state.resolvedAmbiguities).toEqual(["r1:dsaApplicability"]);
    // But the user answered all three, and that is now recorded independently.
    expect([...(state.answeredAmbiguities ?? [])].sort()).toEqual([
      "r1:accountPrompt",
      "r1:addressCapture",
      "r1:dsaApplicability",
    ]);
  });

  it("does not re-present questions the user already answered", async () => {
    const { dialog } = await startAndAnswer();

    // Round 2: every ambiguity is addressed, so there is nothing left to ask.
    const next = await dialog.startOrContinue(ANALYSIS_ID, REQUIREMENTS);

    expect(next.completed).toBe(true);
    expect(next.rounds).toHaveLength(1);
  });

  it("completes the dialog on answers, not on the model's confirmations", async () => {
    const { state } = await startAndAnswer();

    expect(state.completed).toBe(true);
  });

  it("reports zero remaining ambiguities once every one is answered", async () => {
    const dialog = new ClarificationDialog({ provider: makeProvider() });
    const started = await dialog.startOrContinue(ANALYSIS_ID, REQUIREMENTS);
    const { updatedRequirements } = await dialog.submitAnswers(
      ANALYSIS_ID,
      started.rounds[0]!.questions.map((q) => ({
        questionId: q.id,
        answer: ANSWERS[q.ambiguityField]!,
      })),
      REQUIREMENTS,
    );

    expect(updatedRequirements.totalAmbiguities).toBe(0);
  });

  it("leaves an unanswered ambiguity open and asks about it again", async () => {
    const dialog = new ClarificationDialog({ provider: makeProvider() });
    const started = await dialog.startOrContinue(ANALYSIS_ID, REQUIREMENTS);
    const questions = started.rounds[0]!.questions;
    // Only two of three answered; the third is left blank.
    const { state } = await dialog.submitAnswers(
      ANALYSIS_ID,
      questions.map((q) => ({
        questionId: q.id,
        answer: q.ambiguityField === "accountPrompt" ? "   " : ANSWERS[q.ambiguityField]!,
      })),
      REQUIREMENTS,
    );

    expect(state.answeredAmbiguities).not.toContain("r1:accountPrompt");
    expect(state.completed).toBe(false);

    const next = await dialog.startOrContinue(ANALYSIS_ID, REQUIREMENTS);
    expect(next.rounds).toHaveLength(2);
    expect(next.rounds[1]!.questions.length).toBeGreaterThan(0);
  });

  it("never credits a field that is not a real ambiguity of the requirement", async () => {
    const dialog = new ClarificationDialog({ provider: makeProvider() });
    const started = await dialog.startOrContinue(ANALYSIS_ID, REQUIREMENTS);
    const round = started.rounds[0]!;
    // Forge a question naming a field the requirement does not carry — the same
    // class of over-claim #1104 guards the model against.
    round.questions.push({
      ...round.questions[0]!,
      id: "q_forged",
      ambiguityField: "retryStrategy",
    });

    const { state } = await dialog.submitAnswers(
      ANALYSIS_ID,
      [{ questionId: "q_forged", answer: "exponential backoff" }],
      REQUIREMENTS,
    );

    expect(state.answeredAmbiguities).not.toContain("r1:retryStrategy");
  });

  it("accumulates answers across rounds rather than replacing them", async () => {
    const dialog = new ClarificationDialog({ provider: makeProvider() });
    const started = await dialog.startOrContinue(ANALYSIS_ID, REQUIREMENTS);
    const first = started.rounds[0]!.questions.find((q) => q.ambiguityField === "addressCapture")!;
    await dialog.submitAnswers(
      ANALYSIS_ID,
      [{ questionId: first.id, answer: ANSWERS.addressCapture! }],
      REQUIREMENTS,
    );

    const second = await dialog.startOrContinue(ANALYSIS_ID, REQUIREMENTS);
    const q2 = second.rounds[1]!.questions[0]!;
    const { state } = await dialog.submitAnswers(
      ANALYSIS_ID,
      [{ questionId: q2.id, answer: ANSWERS[q2.ambiguityField] ?? "an answer" }],
      REQUIREMENTS,
    );

    expect(state.answeredAmbiguities).toContain("r1:addressCapture");
  });
});

describe("addressedAmbiguities", () => {
  it("unions the model's resolutions with the user's answers", () => {
    expect(
      [
        ...addressedAmbiguities({
          resolvedAmbiguities: ["r1:a"],
          answeredAmbiguities: ["r1:b", "r1:a"],
        }),
      ].sort(),
    ).toEqual(["r1:a", "r1:b"]);
  });

  it("tolerates a state persisted before #1117 added the field", () => {
    expect([...addressedAmbiguities({ resolvedAmbiguities: ["r1:a"] })]).toEqual(["r1:a"]);
  });
});
