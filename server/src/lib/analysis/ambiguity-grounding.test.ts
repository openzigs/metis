/**
 * Tests for the retrieval-grounded clarifying-question self-resolution pass.
 *
 * Both the retriever and the LLM provider are mocked — no real RAG, no real
 * network. The classifier must be CONSERVATIVE: never return an answer without
 * a citation, and always degrade safely to "open" on offline / no-retrieval /
 * malformed-response / error conditions.
 */
import { describe, it, expect, vi } from "vitest";
import {
  AmbiguityGrounding,
  GROUNDING_CONCURRENCY,
  type GroundingRetriever,
} from "./ambiguity-grounding.js";
import type { AIProvider, ChatMessage, ChatResponse } from "../ai/types.js";
import type { ClarifyingQuestion } from "./types/requirements.js";

const QUESTION: ClarifyingQuestion = {
  id: "q1",
  requirementId: "r1",
  ambiguityField: "authMethod",
  question: "Which authentication method should the API use?",
  context: "The requirement does not specify an auth scheme.",
};

function makeHit(filename: string, text: string, score = 0.9) {
  return {
    chunkId: `chunk-${filename}`,
    documentId: `doc-${filename}`,
    filename,
    text,
    score,
  };
}

/** Build a mock provider whose chat() returns a fixed content string. */
function makeProvider(opts: {
  offline?: boolean;
  content?: string;
  chatImpl?: () => Promise<ChatResponse>;
}): { provider: AIProvider; chat: ReturnType<typeof vi.fn> } {
  const chat = vi.fn(
    opts.chatImpl ?? (async () => ({ content: opts.content ?? "" }) as ChatResponse),
  );
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

/** Build a mock retriever returning the given hits. */
function makeRetriever(hits: ReturnType<typeof makeHit>[]): {
  retriever: GroundingRetriever;
  search: ReturnType<typeof vi.fn>;
} {
  const search = vi.fn(async () => ({ hits }));
  return { retriever: { search } as unknown as GroundingRetriever, search };
}

describe("AmbiguityGrounding.groundQuestion", () => {
  it("marks a question grounded with a suggested answer + citation", async () => {
    const { provider, chat } = makeProvider({
      content: JSON.stringify({
        status: "grounded",
        answer: "Use OAuth2 bearer tokens, as the auth module already implements.",
        citationIndexes: [1],
      }),
    });
    const { retriever } = makeRetriever([
      makeHit("auth.ts", "The auth module uses OAuth2 bearer tokens."),
    ]);

    const g = new AmbiguityGrounding({ provider, retriever });
    const result = await g.groundQuestion("proj-1", QUESTION);

    expect(result.groundingStatus).toBe("grounded");
    expect(result.groundedAnswer).toContain("OAuth2");
    expect(result.groundingCitations).toHaveLength(1);
    expect(result.groundingCitations?.[0]?.source).toBe("auth.ts");
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("returns open (no LLM call) when retrieval is empty", async () => {
    const { provider, chat } = makeProvider({ content: "should-not-be-used" });
    const { retriever, search } = makeRetriever([]);

    const g = new AmbiguityGrounding({ provider, retriever });
    const result = await g.groundQuestion("proj-1", QUESTION);

    expect(result.groundingStatus).toBe("open");
    expect(result.groundedAnswer).toBeUndefined();
    expect(search).toHaveBeenCalledTimes(1);
    expect(chat).not.toHaveBeenCalled();
  });

  it("returns open without touching retriever or provider when offline", async () => {
    const { provider, chat } = makeProvider({ offline: true, content: "x" });
    const { retriever, search } = makeRetriever([makeHit("a.ts", "text")]);

    const g = new AmbiguityGrounding({ provider, retriever });
    const result = await g.groundQuestion("proj-1", QUESTION);

    expect(result.groundingStatus).toBe("open");
    expect(search).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });

  it("marks a question partial with an answer + citation", async () => {
    const { provider } = makeProvider({
      content: JSON.stringify({
        status: "partial",
        answer: "The app uses tokens, but token lifetime is unspecified.",
        citationIndexes: [1],
      }),
    });
    const { retriever } = makeRetriever([makeHit("auth.ts", "Tokens are issued on login.")]);

    const g = new AmbiguityGrounding({ provider, retriever });
    const result = await g.groundQuestion("proj-1", QUESTION);

    expect(result.groundingStatus).toBe("partial");
    expect(result.groundedAnswer).toContain("tokens");
    expect(result.groundingCitations?.length).toBeGreaterThanOrEqual(1);
  });

  it("downgrades grounded → open when no valid citation indexes", async () => {
    const { provider } = makeProvider({
      content: JSON.stringify({
        status: "grounded",
        answer: "Use OAuth2.",
        citationIndexes: [],
      }),
    });
    const { retriever } = makeRetriever([makeHit("auth.ts", "text")]);

    const g = new AmbiguityGrounding({ provider, retriever });
    const result = await g.groundQuestion("proj-1", QUESTION);

    expect(result.groundingStatus).toBe("open");
    expect(result.groundedAnswer).toBeUndefined();
    expect(result.groundingCitations).toBeUndefined();
  });

  it("downgrades grounded → open when the answer is empty/whitespace", async () => {
    const { provider } = makeProvider({
      content: JSON.stringify({
        status: "grounded",
        answer: "   ",
        citationIndexes: [1],
      }),
    });
    const { retriever } = makeRetriever([makeHit("auth.ts", "text")]);

    const g = new AmbiguityGrounding({ provider, retriever });
    const result = await g.groundQuestion("proj-1", QUESTION);

    expect(result.groundingStatus).toBe("open");
    expect(result.groundedAnswer).toBeUndefined();
  });

  it("ignores out-of-range citation indexes and downgrades when none remain", async () => {
    const { provider } = makeProvider({
      content: JSON.stringify({
        status: "grounded",
        answer: "Use OAuth2.",
        citationIndexes: [99],
      }),
    });
    const { retriever } = makeRetriever([makeHit("auth.ts", "text")]);

    const g = new AmbiguityGrounding({ provider, retriever });
    const result = await g.groundQuestion("proj-1", QUESTION);

    expect(result.groundingStatus).toBe("open");
  });

  it("returns open on malformed JSON without throwing", async () => {
    const { provider } = makeProvider({ content: "not json at all {" });
    const { retriever } = makeRetriever([makeHit("auth.ts", "text")]);

    const g = new AmbiguityGrounding({ provider, retriever });
    const result = await g.groundQuestion("proj-1", QUESTION);

    expect(result.groundingStatus).toBe("open");
  });

  it("strips ```json fences before parsing", async () => {
    const { provider } = makeProvider({
      content:
        "```json\n" +
        JSON.stringify({ status: "grounded", answer: "Use OAuth2.", citationIndexes: [1] }) +
        "\n```",
    });
    const { retriever } = makeRetriever([makeHit("auth.ts", "OAuth2 here")]);

    const g = new AmbiguityGrounding({ provider, retriever });
    const result = await g.groundQuestion("proj-1", QUESTION);

    expect(result.groundingStatus).toBe("grounded");
    expect(result.groundingCitations).toHaveLength(1);
  });

  it("returns open when the retriever throws (degrade safe)", async () => {
    const { provider } = makeProvider({ content: "x" });
    const retriever = {
      search: vi.fn(async () => {
        throw new Error("lancedb down");
      }),
    } as unknown as GroundingRetriever;

    const g = new AmbiguityGrounding({ provider, retriever });
    const result = await g.groundQuestion("proj-1", QUESTION);

    expect(result.groundingStatus).toBe("open");
  });

  it("returns open when the provider chat throws (degrade safe)", async () => {
    const { provider } = makeProvider({
      chatImpl: async () => {
        throw new Error("provider exploded");
      },
    });
    const { retriever } = makeRetriever([makeHit("auth.ts", "text")]);

    const g = new AmbiguityGrounding({ provider, retriever });
    const result = await g.groundQuestion("proj-1", QUESTION);

    expect(result.groundingStatus).toBe("open");
  });

  it("uses the configured model override when provided", async () => {
    const { provider, chat } = makeProvider({
      content: JSON.stringify({ status: "open", answer: "", citationIndexes: [] }),
    });
    const { retriever } = makeRetriever([makeHit("a.ts", "text")]);

    const g = new AmbiguityGrounding({ provider, retriever, model: "custom-model" });
    await g.groundQuestion("proj-1", QUESTION);

    expect(chat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ model: "custom-model", disableTools: true }),
    );
  });
});

describe("AmbiguityGrounding.groundQuestions", () => {
  it("enriches each question and preserves original fields", async () => {
    const { provider } = makeProvider({
      content: JSON.stringify({
        status: "grounded",
        answer: "Use OAuth2.",
        citationIndexes: [1],
      }),
    });
    const { retriever } = makeRetriever([makeHit("auth.ts", "OAuth2 module")]);

    const g = new AmbiguityGrounding({ provider, retriever });
    const q2: ClarifyingQuestion = { ...QUESTION, id: "q2" };
    const enriched = await g.groundQuestions("proj-1", [QUESTION, q2]);

    expect(enriched).toHaveLength(2);
    expect(enriched[0]?.id).toBe("q1");
    expect(enriched[0]?.question).toBe(QUESTION.question);
    expect(enriched[0]?.groundingStatus).toBe("grounded");
    expect(enriched[1]?.id).toBe("q2");
    expect(enriched[1]?.groundingStatus).toBe("grounded");
  });

  it("returns all questions as open when offline (no calls)", async () => {
    const { provider, chat } = makeProvider({ offline: true });
    const { retriever, search } = makeRetriever([makeHit("a.ts", "text")]);

    const g = new AmbiguityGrounding({ provider, retriever });
    const enriched = await g.groundQuestions("proj-1", [QUESTION]);

    expect(enriched[0]?.groundingStatus).toBe("open");
    expect(search).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });

  it("gives every question a defined groundingStatus across a realistic mix", async () => {
    // 8 questions: some ground, some are partial, some open. The decision is
    // keyed off the question text so we get a deterministic mix.
    const questions: ClarifyingQuestion[] = Array.from({ length: 8 }, (_, i) => ({
      ...QUESTION,
      id: `q${i}`,
      question: `Question number ${i}?`,
    }));

    const provider = {
      key: "offline-stub",
      model: "test-model",
      offline: false,
      chat: vi.fn(async (messages: ChatMessage[]) => {
        const text = JSON.stringify(messages);
        // Decide based on which question index is embedded in the prompt.
        if (text.includes("number 0") || text.includes("number 1")) {
          return {
            content: JSON.stringify({ status: "grounded", answer: "A", citationIndexes: [1] }),
          } as ChatResponse;
        }
        if (text.includes("number 2") || text.includes("number 3")) {
          return {
            content: JSON.stringify({ status: "partial", answer: "P", citationIndexes: [1] }),
          } as ChatResponse;
        }
        return {
          content: JSON.stringify({ status: "open", answer: "", citationIndexes: [] }),
        } as ChatResponse;
      }),
      stream: vi.fn(),
      embed: vi.fn(),
      models: vi.fn(),
      ping: vi.fn(),
    } as unknown as AIProvider;
    const { retriever } = makeRetriever([makeHit("auth.ts", "snippet")]);

    const g = new AmbiguityGrounding({ provider, retriever });
    const enriched = await g.groundQuestions("proj-1", questions);

    expect(enriched).toHaveLength(8);
    // a. COVERAGE: every returned question carries a DEFINED status.
    for (const q of enriched) {
      expect(q.groundingStatus).toBeDefined();
      expect(["grounded", "partial", "open"]).toContain(q.groundingStatus);
    }
    // Realistic mix: at least one of each verdict.
    const statuses = enriched.map((q) => q.groundingStatus);
    expect(statuses).toContain("grounded");
    expect(statuses).toContain("partial");
    expect(statuses).toContain("open");
  });

  it("isolates a per-question error: that one is open, the others still resolve", async () => {
    const questions: ClarifyingQuestion[] = Array.from({ length: 5 }, (_, i) => ({
      ...QUESTION,
      id: `q${i}`,
      question: `Q index ${i}?`,
    }));

    // The retriever throws ONLY for question index 2; all others return a hit.
    const search = vi.fn(async (_projectId: string, query: string) => {
      if (query.includes("index 2")) throw new Error("retrieval blew up for q2");
      return { hits: [makeHit("auth.ts", "snippet")] };
    });
    const retriever = { search } as unknown as GroundingRetriever;
    const { provider } = makeProvider({
      content: JSON.stringify({ status: "grounded", answer: "A", citationIndexes: [1] }),
    });

    const g = new AmbiguityGrounding({ provider, retriever });
    const enriched = await g.groundQuestions("proj-1", questions);

    expect(enriched).toHaveLength(5);
    // The failing question degrades to open...
    const failing = enriched.find((q) => q.question.includes("index 2"));
    expect(failing?.groundingStatus).toBe("open");
    // ...and every OTHER question still got its grounded verdict (not skipped).
    for (const q of enriched) {
      if (q.question.includes("index 2")) continue;
      expect(q.groundingStatus).toBe("grounded");
    }
  });

  it("preserves output order and caps in-flight work at GROUNDING_CONCURRENCY", async () => {
    const n = 17;
    const questions: ClarifyingQuestion[] = Array.from({ length: n }, (_, i) => ({
      ...QUESTION,
      id: `q${i}`,
      question: `Ordered question ${i}?`,
    }));

    let inFlight = 0;
    let peak = 0;
    // Each chat() is delayed so multiple tasks overlap; track concurrency.
    const provider = {
      key: "offline-stub",
      model: "test-model",
      offline: false,
      chat: vi.fn(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return {
          content: JSON.stringify({ status: "grounded", answer: "A", citationIndexes: [1] }),
        } as ChatResponse;
      }),
      stream: vi.fn(),
      embed: vi.fn(),
      models: vi.fn(),
      ping: vi.fn(),
    } as unknown as AIProvider;
    const { retriever } = makeRetriever([makeHit("auth.ts", "snippet")]);

    const g = new AmbiguityGrounding({ provider, retriever });
    const enriched = await g.groundQuestions("proj-1", questions);

    // d. ORDER: enriched array matches input order exactly.
    expect(enriched.map((q) => q.id)).toEqual(questions.map((q) => q.id));
    // d. CONCURRENCY: never more than GROUNDING_CONCURRENCY in flight.
    expect(peak).toBeGreaterThan(1); // proves it actually ran concurrently
    expect(peak).toBeLessThanOrEqual(GROUNDING_CONCURRENCY);
  });
});
