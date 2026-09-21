/**
 * Tests for the clarification dialog's self-resolution wiring.
 *
 * The durable dialog store is mocked with an in-memory map so we avoid a real
 * Prisma/DB dependency. The provider + retriever are mocked. We assert that:
 *   - WITH retriever + projectId, generated questions carry grounding fields
 *     and these persist in the written dialog state.
 *   - WITHOUT a retriever, questions skip retrieval but still always carry a
 *     defined groundingStatus (degrades to "open").
 *   - When the provider is offline, no grounding/retrieval occurs but every
 *     surfaced question still carries groundingStatus === "open".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── in-memory dialog store mock ───────────────────────────────────────────
const store = new Map<string, unknown>();
vi.mock("./clarification-dialog-store.js", () => ({
  readDialogState: vi.fn(async (id: string) => store.get(id)),
  writeDialogState: vi.fn(async (id: string, state: unknown) => {
    store.set(id, state);
  }),
  deleteDialogState: vi.fn(async (id: string) => {
    store.delete(id);
  }),
}));

import { ClarificationDialog } from "./clarification-dialog.js";
import type { GroundingRetriever } from "./ambiguity-grounding.js";
import type { AIProvider, ChatResponse } from "../ai/types.js";
import type { ClarificationState, StructuredRequirements } from "./types/requirements.js";

const REQUIREMENTS: StructuredRequirements = {
  requirements: [
    {
      id: "r1",
      title: "API auth",
      description: "The API needs authentication.",
      type: "functional",
      priority: "high",
      ambiguities: [{ field: "authMethod", description: "auth scheme unspecified" }],
    } as unknown as StructuredRequirements["requirements"][number],
  ],
  totalAmbiguities: 1,
  totalEvidenceNeeds: 0,
} as unknown as StructuredRequirements;

/** Provider that returns one question, then a grounding decision. */
function makeProvider(opts: { offline?: boolean; groundingContent?: string }): {
  provider: AIProvider;
  chat: ReturnType<typeof vi.fn>;
} {
  // First chat() call = question generation; subsequent = grounding decisions.
  let call = 0;
  const chat = vi.fn(async (): Promise<ChatResponse> => {
    call += 1;
    if (call === 1) {
      return {
        content: JSON.stringify({
          questions: [
            {
              requirementId: "r1",
              ambiguityField: "authMethod",
              question: "Which auth method?",
              context: "unspecified",
            },
          ],
        }),
      } as ChatResponse;
    }
    return { content: opts.groundingContent ?? "" } as ChatResponse;
  });
  const provider = {
    key: "offline-stub",
    model: "test-model",
    offline: opts.offline ?? false,
    chat,
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn(),
    ping: vi.fn(),
  } as unknown as AIProvider;
  return { provider, chat };
}

function makeRetriever(): {
  retriever: GroundingRetriever;
  search: ReturnType<typeof vi.fn>;
} {
  const search = vi.fn(async () => ({
    hits: [
      {
        chunkId: "c1",
        documentId: "d1",
        filename: "auth.ts",
        text: "OAuth2 bearer tokens are used.",
        score: 0.95,
      },
    ],
  }));
  return { retriever: { search } as unknown as GroundingRetriever, search };
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe("ClarificationDialog self-resolution wiring", () => {
  it("enriches questions with grounding fields and persists them", async () => {
    const { provider } = makeProvider({
      groundingContent: JSON.stringify({
        status: "grounded",
        answer: "Use OAuth2 bearer tokens.",
        citationIndexes: [1],
      }),
    });
    const { retriever, search } = makeRetriever();

    const dialog = new ClarificationDialog({ provider, retriever, projectId: "proj-1" });
    const state = await dialog.startOrContinue("ana-1", REQUIREMENTS);

    const q = state.rounds[0]?.questions[0];
    expect(q?.groundingStatus).toBe("grounded");
    expect(q?.groundedAnswer).toContain("OAuth2");
    expect(q?.groundingCitations?.[0]?.source).toBe("auth.ts");
    expect(search).toHaveBeenCalledTimes(1);

    // Persisted state carries the enriched question (store mock holds it).
    const persisted = store.get("ana-1") as ClarificationState;
    expect(persisted.rounds[0]?.questions[0]?.groundingStatus).toBe("grounded");
    expect(persisted.rounds[0]?.questions[0]?.groundedAnswer).toContain("OAuth2");
  });

  it("skips retrieval but still stamps groundingStatus 'open' when no retriever", async () => {
    const { provider } = makeProvider({});
    const dialog = new ClarificationDialog({ provider });

    const state = await dialog.startOrContinue("ana-2", REQUIREMENTS);
    const q = state.rounds[0]?.questions[0];

    expect(q?.question).toBe("Which auth method?");
    // Bypass path (no retriever) must still guarantee a defined status.
    expect(q?.groundingStatus).toBe("open");
    expect(q?.groundedAnswer).toBeUndefined();
    // Only the question-generation chat() call happened, no grounding call.
    expect(provider.chat as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it("does not ground when the provider is offline but stamps 'open'", async () => {
    const { provider } = makeProvider({ offline: true });
    const { retriever, search } = makeRetriever();

    const dialog = new ClarificationDialog({ provider, retriever, projectId: "proj-1" });
    const state = await dialog.startOrContinue("ana-3", REQUIREMENTS);

    const q = state.rounds[0]?.questions[0];
    // Offline bypass: no retrieval, but the question must not surface "cold".
    expect(q?.groundingStatus).toBe("open");
    expect(search).not.toHaveBeenCalled();
  });

  it("stamps every question 'open' when the grounding pass throws", async () => {
    // Question generation succeeds, but the retriever throws inside the
    // grounding pass — the catch-block bypass must still stamp 'open'.
    let call = 0;
    const chat = vi.fn(async (): Promise<ChatResponse> => {
      call += 1;
      if (call === 1) {
        return {
          content: JSON.stringify({
            questions: [
              { requirementId: "r1", ambiguityField: "authMethod", question: "Q1?", context: "x" },
              { requirementId: "r1", ambiguityField: "authMethod", question: "Q2?", context: "x" },
            ],
          }),
        } as ChatResponse;
      }
      return { content: "" } as ChatResponse;
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

    // A retriever that throws synchronously at construction-time use would not
    // reach the per-question path; instead make AmbiguityGrounding's batch path
    // throw by giving a retriever whose .search rejects. groundQuestion swallows
    // that to "open", so to exercise the dialog-level catch we make the whole
    // batch throw by handing a retriever that is missing .search.
    const brokenRetriever = {} as unknown as GroundingRetriever;

    const dialog = new ClarificationDialog({
      provider,
      retriever: brokenRetriever,
      projectId: "proj-1",
    });
    const state = await dialog.startOrContinue("ana-4", REQUIREMENTS);

    const questions = state.rounds[0]?.questions ?? [];
    expect(questions.length).toBeGreaterThan(0);
    for (const q of questions) {
      expect(q.groundingStatus).toBe("open");
    }
  });
});
