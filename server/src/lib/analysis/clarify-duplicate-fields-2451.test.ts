/**
 * #2451 — the reported run, end to end through the dialog. Every ambiguity of
 * every requirement was on `description`, and the model filed its questions
 * under field names of its own (`delivery_mechanism`), one more question than
 * there were ambiguities. Answering three questions credited none of them: the
 * counts did not move and round 2 asked the answered questions again.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const store = vi.hoisted(() => new Map<string, unknown>());
vi.mock("./clarification-dialog-store.js", async () => {
  const { dialogStoreCasFakes, jsonClone } =
    await import("../../../tests/helpers/dialog-store-cas-fake.js");
  return {
    readDialogState: vi.fn(async (id: string) => store.get(id)),
    writeDialogState: vi.fn(async (id: string, state: unknown) => {
      store.set(id, JSON.parse(JSON.stringify(state)));
    }),
    deleteDialogState: vi.fn(async (id: string) => {
      store.delete(id);
    }),
    ...dialogStoreCasFakes(store, jsonClone),
  };
});

import { ClarificationDialog, buildAmbiguitySummary } from "./clarification-dialog.js";
import { mergeClarifiedList } from "./analysis-service.js";
import { addressedAmbiguities } from "./types/requirements.js";
import type { AIProvider, ChatResponse } from "../ai/types.js";
import type { StructuredRequirements } from "./types/requirements.js";

const ANALYSIS_ID = "an_2451";

const amb = (description: string) => ({ field: "description", description, suggestedQuestion: "" });

const REQUIREMENTS = {
  requirements: [
    {
      id: "req-request",
      title: "Request password reset link from sign-in page",
      description: "A customer can request a reset link from the sign-in page.",
      type: "functional",
      priority: "must-have",
      ambiguities: [
        amb("It is not specified how the reset link is delivered (email, in-app, SMS)."),
        amb("The term 'customer' is not defined: other user types such as admins?"),
      ],
      evidenceNeeds: [],
    },
    {
      id: "req-single",
      title: "Reset link is single-use",
      description: "A reset link can be used once.",
      type: "functional",
      priority: "must-have",
      ambiguities: [
        amb("'Used' is not defined: the link being opened, or the password being saved."),
        amb("Behaviour when a user opens the link but abandons the flow is not defined."),
      ],
      evidenceNeeds: [],
    },
  ],
  totalAmbiguities: 4,
  totalEvidenceNeeds: 0,
} as unknown as StructuredRequirements;

/** Round 1 of the live run: invented field names, and one question too many. */
const ROUND_1 = [
  ["req-request", "delivery_mechanism", "How is the reset link delivered? Email only?"],
  ["req-request", "email_validation", "What happens when a malformed address is typed?"],
  ["req-request", "user_scope", "Which user types may reset, admins included?"],
  ["req-single", "single_use_definition", "When is the link used: opened, or password saved?"],
  ["req-single", "abandoned_flow", "What if a user opens the link and abandons the flow?"],
];

function makeProvider(): { provider: AIProvider; prompts: string[] } {
  const prompts: string[] = [];
  const chat = vi.fn(async (messages: Array<{ content: string }>): Promise<ChatResponse> => {
    const prompt = messages.map((m) => m.content).join("\n");
    if (!prompt.includes("Generate clarifying questions")) {
      return {
        content: JSON.stringify({
          resolvedFields: [],
          updatedDescription: "",
          remainingUncertainty: 1,
        }),
      } as ChatResponse;
    }
    prompts.push(prompt);
    // A model that echoes nothing it was told: the same five questions each round.
    const questions = ROUND_1.map(([requirementId, ambiguityField, question]) => ({
      requirementId,
      ambiguityField,
      question,
      context: "",
    }));
    return { content: JSON.stringify({ questions }) } as ChatResponse;
  });
  return {
    provider: { key: "offline-stub", offline: false, chat } as unknown as AIProvider,
    prompts,
  };
}

beforeEach(() => store.clear());

describe("clarifying questions on a requirement with several ambiguities on one field (#2451)", () => {
  it("asks one question per ambiguity, so the dialog and the Summary count the same", async () => {
    const { provider } = makeProvider();
    const state = await new ClarificationDialog({ provider }).startOrContinue(
      ANALYSIS_ID,
      REQUIREMENTS,
    );
    const round = state.rounds[0]!.questions;
    expect(round).toHaveLength(REQUIREMENTS.totalAmbiguities);
    expect(round.map((q) => `${q.requirementId}:${q.ambiguityField}`)).toEqual([
      "req-request:description",
      "req-request:description#2",
      "req-single:description",
      "req-single:description#2",
    ]);
  });

  it("credits each answer to its own ambiguity, the count falls, and round 2 does not re-ask", async () => {
    const { provider, prompts } = makeProvider();
    const dialog = new ClarificationDialog({ provider });
    const started = await dialog.startOrContinue(ANALYSIS_ID, REQUIREMENTS);
    const byText = (start: string) =>
      started.rounds[0]!.questions.find((q) => q.question.startsWith(start))!;
    const delivery = byText("How is the reset link delivered");
    const used = byText("When is the link used");

    const { state, updatedRequirements } = await dialog.submitAnswers(
      ANALYSIS_ID,
      [
        { questionId: delivery.id, answer: "Email only, to the address on the account." },
        { questionId: used.id, answer: "Used when the new password is successfully saved." },
      ],
      REQUIREMENTS,
    );

    expect([...(state.answeredAmbiguities ?? [])].sort()).toEqual([
      "req-request:description",
      "req-single:description",
    ]);
    // The count every surface shows: 4 open, 2 answered, 2 left.
    expect(updatedRequirements.totalAmbiguities).toBe(2);
    expect(state.completed).toBe(false);

    const next = await dialog.startOrContinue(ANALYSIS_ID, REQUIREMENTS);
    const round2 = next.rounds[1]!.questions;
    expect(round2.map((q) => `${q.requirementId}:${q.ambiguityField}`).sort()).toEqual([
      "req-request:description#2",
      "req-single:description#2",
    ]);
    // The answered ambiguities are not put to the model again.
    expect(prompts[1]).not.toContain("how the reset link is delivered");
    expect(prompts[1]).not.toContain("'Used' is not defined");
    expect(prompts[1]).toContain("description#2:");
  });

  it("lists each ambiguity to the model under its own key", () => {
    const summary = buildAmbiguitySummary(REQUIREMENTS.requirements, ["req-single:description"]);
    expect(summary).toContain("  - description: It is not specified how");
    expect(summary).toContain("  - description#2: The term 'customer'");
    expect(summary).not.toContain("'Used' is not defined");
    expect(summary).toContain("  - description#2: Behaviour when a user opens");
  });

  it("the stored count falls by the ambiguities answered, not by their field", () => {
    const addressed = addressedAmbiguities({
      resolvedAmbiguities: [],
      answeredAmbiguities: ["req-request:description"],
    });
    const merged = mergeClarifiedList(
      REQUIREMENTS,
      undefined,
      REQUIREMENTS,
      REQUIREMENTS,
      addressed,
    );
    expect(merged?.totalAmbiguities).toBe(3);
  });
});
