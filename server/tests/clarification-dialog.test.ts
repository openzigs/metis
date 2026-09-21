/**
 * Tests for ClarificationDialog (Epic #597 / Issue #624).
 */
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";

// Epic #201 (#210) — dialog state is now durable. We back the store with an
// in-memory Map in tests so these unit tests exercise the dialog logic without
// a real database; the "survives a restart" test below clears the dialog
// module's cache (there is none) and re-reads from this shared store.
const fakeStore = new Map<string, unknown>();
vi.mock("../src/lib/analysis/clarification-dialog-store.js", () => ({
  readDialogState: vi.fn(async (id: string) => {
    const v = fakeStore.get(id);
    return v ? (JSON.parse(JSON.stringify(v)) as unknown) : undefined;
  }),
  writeDialogState: vi.fn(async (id: string, state: unknown) => {
    fakeStore.set(id, JSON.parse(JSON.stringify(state)));
  }),
  deleteDialogState: vi.fn(async (id: string) => {
    fakeStore.delete(id);
  }),
}));

import {
  ClarificationDialog,
  getDialogState,
  clearDialogState,
  _setDialogState,
} from "../src/lib/analysis/clarification-dialog.js";
import type { AIProvider, ChatResponse } from "../src/lib/ai/types.js";
import type {
  StructuredRequirements,
  ClarificationState,
} from "../src/lib/analysis/types/requirements.js";

function mockProvider(content: string): AIProvider {
  return {
    key: "test",
    model: "test-model",
    offline: true,
    chat: vi.fn().mockResolvedValue({
      content,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      model: "test-model",
      provider: "test",
    } as ChatResponse),
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn().mockResolvedValue([]),
    ping: vi.fn().mockResolvedValue(true),
  };
}

function makeRequirements(opts?: { ambiguityCount?: number }): StructuredRequirements {
  const ambiguityCount = opts?.ambiguityCount ?? 2;
  const ambiguities = Array.from({ length: ambiguityCount }, (_, i) => ({
    field: `field-${i}`,
    description: `Ambiguity ${i}`,
    suggestedQuestion: `What about field ${i}?`,
  }));

  return {
    requirements: [
      {
        id: "req-1",
        title: "Test Requirement",
        description: "A test requirement",
        type: "functional" as const,
        stakeholders: ["user"],
        priority: "must-have" as const,
        ambiguities,
        evidenceNeeds: [],
        rawSource: "raw",
      },
    ],
    totalAmbiguities: ambiguityCount,
    totalEvidenceNeeds: 0,
  };
}

describe("ClarificationDialog", () => {
  beforeEach(() => {
    fakeStore.clear();
  });
  afterEach(async () => {
    await clearDialogState("test-analysis");
  });

  describe("startOrContinue", () => {
    it("creates a new dialog state on first call", async () => {
      const questionsJson = JSON.stringify({
        questions: [
          {
            requirementId: "req-1",
            ambiguityField: "field-0",
            question: "What is field-0?",
            context: "Field-0 is ambiguous",
          },
        ],
      });
      const provider = mockProvider(questionsJson);
      const dialog = new ClarificationDialog({ provider });

      const state = await dialog.startOrContinue("test-analysis", makeRequirements());

      expect(state.analysisId).toBe("test-analysis");
      expect(state.currentRound).toBe(1);
      expect(state.maxRounds).toBe(3);
      expect(state.completed).toBe(false);
      expect(state.rounds).toHaveLength(1);
      expect(state.rounds[0]!.questions.length).toBeGreaterThanOrEqual(0);
    });

    it("marks dialog as complete when no unresolved ambiguities", async () => {
      const provider = mockProvider("{}");
      const dialog = new ClarificationDialog({ provider });

      const reqs = makeRequirements({ ambiguityCount: 0 });
      const state = await dialog.startOrContinue("test-analysis", reqs);

      expect(state.completed).toBe(true);
      expect(provider.chat).not.toHaveBeenCalled();
    });

    it("marks dialog as complete when round exceeds max", async () => {
      await _setDialogState("test-analysis", {
        analysisId: "test-analysis",
        currentRound: 4,
        maxRounds: 3,
        rounds: [],
        resolvedAmbiguities: [],
        escalatedToSonnet: false,
        completed: false,
      });

      const provider = mockProvider("{}");
      const dialog = new ClarificationDialog({ provider });

      const state = await dialog.startOrContinue("test-analysis", makeRequirements());
      expect(state.completed).toBe(true);
    });

    it("resumes existing dialog state", async () => {
      const existingState: ClarificationState = {
        analysisId: "test-analysis",
        currentRound: 2,
        maxRounds: 3,
        rounds: [{ round: 1, questions: [], answers: [] }],
        resolvedAmbiguities: [],
        escalatedToSonnet: false,
        completed: false,
      };
      await _setDialogState("test-analysis", existingState);

      const questionsJson = JSON.stringify({
        questions: [
          {
            requirementId: "req-1",
            ambiguityField: "field-0",
            question: "Follow-up question?",
            context: "Still ambiguous",
          },
        ],
      });
      const provider = mockProvider(questionsJson);
      const dialog = new ClarificationDialog({ provider });

      const state = await dialog.startOrContinue("test-analysis", makeRequirements());
      expect(state.currentRound).toBe(2);
      expect(state.rounds).toHaveLength(2);
    });
  });

  describe("submitAnswers", () => {
    it("throws when no dialog state exists", async () => {
      const provider = mockProvider("{}");
      const dialog = new ClarificationDialog({ provider });

      await expect(dialog.submitAnswers("test-analysis", [], makeRequirements())).rejects.toThrow(
        "No clarification dialog found",
      );
    });

    it("throws when no active round exists", async () => {
      await _setDialogState("test-analysis", {
        analysisId: "test-analysis",
        currentRound: 1,
        maxRounds: 3,
        rounds: [],
        resolvedAmbiguities: [],
        escalatedToSonnet: false,
        completed: false,
      });

      const provider = mockProvider("{}");
      const dialog = new ClarificationDialog({ provider });

      await expect(dialog.submitAnswers("test-analysis", [], makeRequirements())).rejects.toThrow(
        "No active round",
      );
    });

    it("processes answers and advances round", async () => {
      const resolutionJson = JSON.stringify({
        resolvedFields: ["field-0"],
        updatedDescription: "Updated description with clarification",
        remainingUncertainty: 0.3,
      });
      const provider = mockProvider(resolutionJson);
      const dialog = new ClarificationDialog({ provider });

      await _setDialogState("test-analysis", {
        analysisId: "test-analysis",
        currentRound: 1,
        maxRounds: 3,
        rounds: [
          {
            round: 1,
            questions: [
              {
                id: "q-1",
                requirementId: "req-1",
                ambiguityField: "field-0",
                question: "What is field-0?",
                context: "Unclear",
              },
            ],
            answers: [],
          },
        ],
        resolvedAmbiguities: [],
        escalatedToSonnet: false,
        completed: false,
      });

      const result = await dialog.submitAnswers(
        "test-analysis",
        [{ questionId: "q-1", answer: "Field-0 means X" }],
        makeRequirements(),
      );

      expect(result.state.currentRound).toBe(2);
      expect(result.state.resolvedAmbiguities).toContain("req-1:field-0");
      expect(result.updatedRequirements.requirements[0]!.description).toBe(
        "Updated description with clarification",
      );
    });

    it("escalates to Sonnet when uncertainty exceeds threshold", async () => {
      // No fields resolved → all ambiguities remain → >60% unresolved
      const resolutionJson = JSON.stringify({
        resolvedFields: [],
        updatedDescription: "Same description",
        remainingUncertainty: 0.8,
      });
      const provider = mockProvider(resolutionJson);
      const dialog = new ClarificationDialog({ provider });

      // 5 ambiguities, none resolved → 100% unresolved > 60% threshold
      const reqs = makeRequirements({ ambiguityCount: 5 });

      await _setDialogState("test-analysis", {
        analysisId: "test-analysis",
        currentRound: 1,
        maxRounds: 3,
        rounds: [
          {
            round: 1,
            questions: [
              {
                id: "q-1",
                requirementId: "req-1",
                ambiguityField: "field-0",
                question: "Q?",
                context: "",
              },
            ],
            answers: [],
          },
        ],
        resolvedAmbiguities: [],
        escalatedToSonnet: false,
        completed: false,
      });

      const result = await dialog.submitAnswers(
        "test-analysis",
        [{ questionId: "q-1", answer: "unclear answer" }],
        reqs,
      );

      expect(result.state.escalatedToSonnet).toBe(true);
    });

    it("marks dialog complete when all ambiguities resolved", async () => {
      const resolutionJson = JSON.stringify({
        resolvedFields: ["field-0"],
        updatedDescription: "Updated",
        remainingUncertainty: 0,
      });
      const provider = mockProvider(resolutionJson);
      const dialog = new ClarificationDialog({ provider });

      const reqs = makeRequirements({ ambiguityCount: 1 });

      await _setDialogState("test-analysis", {
        analysisId: "test-analysis",
        currentRound: 1,
        maxRounds: 3,
        rounds: [
          {
            round: 1,
            questions: [
              {
                id: "q-1",
                requirementId: "req-1",
                ambiguityField: "field-0",
                question: "Q?",
                context: "",
              },
            ],
            answers: [],
          },
        ],
        resolvedAmbiguities: [],
        escalatedToSonnet: false,
        completed: false,
      });

      const result = await dialog.submitAnswers(
        "test-analysis",
        [{ questionId: "q-1", answer: "clear answer" }],
        reqs,
      );

      expect(result.state.completed).toBe(true);
    });
  });

  describe("parseQuestions", () => {
    it("parses valid question JSON", () => {
      const dialog = new ClarificationDialog({ provider: mockProvider("") });
      const questions = dialog.parseQuestions(
        JSON.stringify({
          questions: [
            {
              requirementId: "req-1",
              ambiguityField: "scope",
              question: "What scope?",
              context: "Scope unclear",
            },
          ],
        }),
      );

      expect(questions).toHaveLength(1);
      expect(questions[0]!.question).toBe("What scope?");
      expect(questions[0]!.requirementId).toBe("req-1");
    });

    it("returns empty array for invalid JSON", () => {
      const dialog = new ClarificationDialog({ provider: mockProvider("") });
      const questions = dialog.parseQuestions("not json");
      expect(questions).toEqual([]);
    });

    it("filters out questions without question text or requirementId", () => {
      const dialog = new ClarificationDialog({ provider: mockProvider("") });
      const questions = dialog.parseQuestions(
        JSON.stringify({
          questions: [
            { requirementId: "req-1", question: "" },
            { requirementId: "", question: "Valid question?" },
            { requirementId: "req-1", question: "Good question?" },
          ],
        }),
      );

      expect(questions).toHaveLength(1);
      expect(questions[0]!.question).toBe("Good question?");
    });

    it("strips markdown fences", () => {
      const dialog = new ClarificationDialog({ provider: mockProvider("") });
      const json = JSON.stringify({
        questions: [{ requirementId: "r1", question: "Q?", ambiguityField: "f", context: "c" }],
      });
      const questions = dialog.parseQuestions("```json\n" + json + "\n```");
      expect(questions).toHaveLength(1);
    });
  });

  describe("getDialogState / clearDialogState", () => {
    it("returns undefined for unknown analysis", async () => {
      expect(await getDialogState("unknown")).toBeUndefined();
    });

    it("stores and retrieves state", async () => {
      const state: ClarificationState = {
        analysisId: "test",
        currentRound: 1,
        maxRounds: 3,
        rounds: [],
        resolvedAmbiguities: [],
        escalatedToSonnet: false,
        completed: false,
      };
      await _setDialogState("test", state);
      expect(await getDialogState("test")).toEqual(state);
    });

    it("clears state", async () => {
      await _setDialogState("test", {
        analysisId: "test",
        currentRound: 1,
        maxRounds: 3,
        rounds: [],
        resolvedAmbiguities: [],
        escalatedToSonnet: false,
        completed: false,
      });
      await clearDialogState("test");
      expect(await getDialogState("test")).toBeUndefined();
    });
  });

  // Epic #201 (#210) — durability: a dialog started before a simulated restart
  // is resumable afterward. The fakeStore stands in for the Prisma table; a
  // "restart" is modeled by constructing a fresh ClarificationDialog instance
  // (no in-process state) and re-reading the persisted checkpoint.
  describe("survives a restart (durable state)", () => {
    it("resumes an in-flight dialog from the durable store after restart", async () => {
      const questionsJson = JSON.stringify({
        questions: [
          {
            requirementId: "req-1",
            ambiguityField: "field-0",
            question: "What is field-0?",
            context: "Field-0 is ambiguous",
          },
        ],
      });
      const before = new ClarificationDialog({ provider: mockProvider(questionsJson) });
      const started = await before.startOrContinue("test-analysis", makeRequirements());
      expect(started.rounds).toHaveLength(1);

      // Simulate a restart: brand-new instance, state must come from the store.
      const resumed = await getDialogState("test-analysis");
      expect(resumed).toBeDefined();
      expect(resumed!.currentRound).toBe(1);
      expect(resumed!.rounds).toHaveLength(1);

      // And submitAnswers on a fresh instance still finds the persisted dialog.
      const after = new ClarificationDialog({
        provider: mockProvider(
          JSON.stringify({
            resolvedFields: ["field-0"],
            updatedDescription: "Resolved after restart",
            remainingUncertainty: 0,
          }),
        ),
      });
      const q0 = started.rounds[0]!.questions[0]!;
      const result = await after.submitAnswers(
        "test-analysis",
        [{ questionId: q0.id, answer: "field-0 is X" }],
        makeRequirements(),
      );
      expect(result.state.resolvedAmbiguities).toContain("req-1:field-0");
    });
  });
});
