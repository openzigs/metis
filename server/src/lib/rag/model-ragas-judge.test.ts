/**
 * Epic #1316 / Issue #1317 — ModelRagasJudge.
 *
 * The three cases the issue names are the three that distinguish this judge from
 * the lexical stub it sits beside:
 *   1. a hallucinated claim is CAUGHT even though no expected keyword mentions it;
 *   2. a correct PARAPHRASE is not penalised for wording;
 *   3. an unverifiable metric is `null`, never a vacuous 1.0.
 *
 * Each is asserted against the STUB as well, so the test states the delta rather
 * than just asserting a number the stub would also produce.
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatResponse } from "../ai/types.js";
import {
  labelDrivenContextScores,
  ModelAnswerRelevancyScorer,
  ModelRagasJudge,
  parseRelevancy,
  ragasJudgeMode,
  resolveRagasJudge,
  resolveRagasJudgeForRun,
} from "./model-ragas-judge.js";
import { StubRagasJudge, type RagasFixture } from "./ragas.js";

/** A provider double that is NOT offline and returns whatever we queue. */
function fakeProvider(reply: string, offline = false): AIProvider {
  return {
    key: "openai",
    model: "test-model",
    offline,
    chat: vi.fn(
      async (): Promise<ChatResponse> => ({
        content: reply,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "test-model",
        provider: "openai",
      }),
    ),
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn(async () => []),
    ping: vi.fn(async () => true),
  } as unknown as AIProvider;
}

/** Claim extractor double: splits on ` | `. */
const extractorFor = (claims: string[]) => ({
  decompose: vi.fn(async () => ({ claims: claims.map((c) => ({ claim: c, sourceIds: [] })) })),
});

/** NLI judge double: supports a claim iff it is in `supported`. */
const judgeFor = (supported: readonly string[]) => ({
  judge: vi.fn(async (claims: string[]) =>
    claims.map((claim) => ({ claim, supported: supported.includes(claim), sourceIds: [] })),
  ),
});

const relevancyFor = (value: number | null) => ({ score: vi.fn(async () => value) });

describe("ragasJudgeMode / resolveRagasJudge", () => {
  it("defaults to the stub with no env at all — CI stays hermetic and free", () => {
    expect(ragasJudgeMode({})).toBe("stub");
    expect(resolveRagasJudge({ env: {} })).toBeInstanceOf(StubRagasJudge);
  });

  it("treats any value other than the exact string 'model' as stub", () => {
    expect(ragasJudgeMode({ RAGAS_JUDGE: "Model" })).toBe("stub");
    expect(ragasJudgeMode({ RAGAS_JUDGE: "1" })).toBe("stub");
    expect(ragasJudgeMode({ RAGAS_JUDGE: "model" })).toBe("model");
  });

  it("falls back to the stub when RAGAS_JUDGE=model but no provider is injected", () => {
    expect(resolveRagasJudge({ env: { RAGAS_JUDGE: "model" } })).toBeInstanceOf(StubRagasJudge);
  });

  it("falls back to the stub when the injected provider is OFFLINE", () => {
    const judge = resolveRagasJudge({
      env: { RAGAS_JUDGE: "model" },
      provider: fakeProvider("{}", true),
    });
    expect(judge).toBeInstanceOf(StubRagasJudge);
  });

  it("returns the model judge only when the flag AND a live provider are present", () => {
    const judge = resolveRagasJudge({
      env: { RAGAS_JUDGE: "model" },
      provider: fakeProvider("{}"),
    });
    expect(judge).toBeInstanceOf(ModelRagasJudge);
  });

  it("honours an explicit mode override without any env", () => {
    expect(resolveRagasJudge({ mode: "model", provider: fakeProvider("{}") })).toBeInstanceOf(
      ModelRagasJudge,
    );
  });
});

describe("resolveRagasJudgeForRun — the flag must be REACHABLE from the runner", () => {
  it("never builds a provider when the flag is unset — a default run reads no credentials", () => {
    const buildProvider = vi.fn(() => fakeProvider("{}"));
    expect(resolveRagasJudgeForRun({ env: {}, buildProvider })).toBeInstanceOf(StubRagasJudge);
    expect(buildProvider).not.toHaveBeenCalled();
  });

  it("RAGAS_JUDGE=model actually YIELDS the model judge — the defect this closes", () => {
    // `rag-eval.ts` used to call `resolveRagasJudge()` with no provider, so this
    // exact env produced a StubRagasJudge: the flag reported success while the
    // lexical stub still did the scoring. Asserting the CLASS is the point.
    const buildProvider = vi.fn(() => fakeProvider("{}"));
    const judge = resolveRagasJudgeForRun({ env: { RAGAS_JUDGE: "model" }, buildProvider });
    expect(judge).toBeInstanceOf(ModelRagasJudge);
    expect(buildProvider).toHaveBeenCalledOnce();
  });

  it("degrades to the stub — not a crash — when the provider cannot be built", () => {
    const judge = resolveRagasJudgeForRun({
      env: { RAGAS_JUDGE: "model" },
      buildProvider: () => {
        throw new Error("ANTHROPIC_API_KEY is not set");
      },
    });
    expect(judge).toBeInstanceOf(StubRagasJudge);
  });

  it("degrades to the stub when the built provider turns out to be the offline stub", () => {
    const judge = resolveRagasJudgeForRun({
      env: { RAGAS_JUDGE: "model" },
      buildProvider: () => fakeProvider("{}", true),
    });
    expect(judge).toBeInstanceOf(StubRagasJudge);
  });
});

describe("ModelRagasJudge — faithfulness", () => {
  it("CATCHES a hallucinated claim the expected-keyword list never mentions", async () => {
    // The answer states two things. Only the first is in the retrieval; the
    // second is invented. Crucially, NEITHER appears in expectedAnswerKeywords,
    // so the lexical stub is structurally blind to the hallucination.
    const f: RagasFixture = {
      id: "hallucination",
      question: "How does METIS store vectors?",
      groundTruthContexts: ["LanceDB"],
      expectedAnswerKeywords: [],
      generatedAnswer: "METIS stores vectors in LanceDB. METIS is SOC2 certified.",
      retrievedChunks: ["METIS stores vectors in LanceDB."],
    };
    const judge = new ModelRagasJudge({
      provider: fakeProvider("{}"),
      extractor: extractorFor(["METIS stores vectors in LanceDB", "METIS is SOC2 certified"]),
      judge: judgeFor(["METIS stores vectors in LanceDB"]),
      relevancyScorer: relevancyFor(1),
    });

    const scores = await judge.scoreFixture(f);
    expect(scores.faithfulness).toBeCloseTo(0.5, 10);

    // The stub cannot see it: with no expected keywords its denominator is zero.
    expect(new StubRagasJudge().scoreFixture(f).faithfulness).toBeNull();
  });

  it("does NOT penalise a correct paraphrase", async () => {
    const f: RagasFixture = {
      id: "paraphrase",
      question: "Where do the embeddings live?",
      groundTruthContexts: ["LanceDB"],
      expectedAnswerKeywords: ["LanceDB", "vector store"],
      // Says the right thing in the wrong words — zero keyword overlap.
      generatedAnswer: "Embeddings are persisted in an on-disk columnar index.",
      retrievedChunks: ["METIS stores vectors in LanceDB, an on-disk columnar index."],
    };
    const judge = new ModelRagasJudge({
      provider: fakeProvider("{}"),
      extractor: extractorFor(["Embeddings are persisted in an on-disk columnar index"]),
      judge: judgeFor(["Embeddings are persisted in an on-disk columnar index"]),
      relevancyScorer: relevancyFor(1),
    });

    expect((await judge.scoreFixture(f)).faithfulness).toBe(1);
    // The stub scores the same paraphrase 0 on relevancy — the lexical penalty.
    expect(new StubRagasJudge().scoreFixture(f).answer_relevancy).toBe(0);
  });

  it("reports null (unverifiable) when the NLI judge declines", async () => {
    const judge = new ModelRagasJudge({
      provider: fakeProvider("{}"),
      extractor: extractorFor(["a claim"]),
      judge: { judge: vi.fn(async () => null) },
      relevancyScorer: relevancyFor(1),
    });
    const scores = await judge.scoreFixture({
      id: "unverifiable",
      question: "q",
      groundTruthContexts: ["x"],
      expectedAnswerKeywords: [],
      generatedAnswer: "a claim",
      retrievedChunks: ["some evidence"],
    });
    expect(scores.faithfulness).toBeNull();
  });

  it("reports null when there is no retrieval to judge against", async () => {
    const nliJudge = judgeFor([]);
    const judge = new ModelRagasJudge({
      provider: fakeProvider("{}"),
      extractor: extractorFor(["a claim"]),
      judge: nliJudge,
      relevancyScorer: relevancyFor(1),
    });
    const scores = await judge.scoreFixture({
      id: "no-retrieval",
      question: "q",
      groundTruthContexts: [],
      expectedAnswerKeywords: [],
      generatedAnswer: "a claim",
      retrievedChunks: [],
    });
    expect(scores.faithfulness).toBeNull();
    expect(nliJudge.judge).not.toHaveBeenCalled();
  });

  it("reports null rather than throwing when the substrate blows up", async () => {
    const judge = new ModelRagasJudge({
      provider: fakeProvider("{}"),
      extractor: {
        decompose: vi.fn(async () => {
          throw new Error("provider exploded");
        }),
      },
      judge: judgeFor([]),
      relevancyScorer: relevancyFor(1),
    });
    const scores = await judge.scoreFixture({
      id: "boom",
      question: "q",
      groundTruthContexts: [],
      expectedAnswerKeywords: [],
      generatedAnswer: "a claim",
      retrievedChunks: ["evidence"],
    });
    expect(scores.faithfulness).toBeNull();
  });
});

describe("ModelRagasJudge — answer_relevancy", () => {
  it("uses the model score, not keyword overlap", async () => {
    const judge = new ModelRagasJudge({
      provider: fakeProvider("{}"),
      extractor: extractorFor([]),
      judge: judgeFor([]),
      relevancyScorer: relevancyFor(0.5),
    });
    const scores = await judge.scoreFixture({
      id: "rel",
      question: "q",
      groundTruthContexts: [],
      expectedAnswerKeywords: ["alpha"],
      generatedAnswer: "beta",
      retrievedChunks: [],
    });
    expect(scores.answer_relevancy).toBe(0.5);
  });

  it("propagates an unparseable relevancy verdict as null", async () => {
    const judge = new ModelRagasJudge({
      provider: fakeProvider("{}"),
      extractor: extractorFor([]),
      judge: judgeFor([]),
      relevancyScorer: relevancyFor(null),
    });
    const scores = await judge.scoreFixture({
      id: "rel-null",
      question: "q",
      groundTruthContexts: [],
      expectedAnswerKeywords: [],
      generatedAnswer: "a",
      retrievedChunks: [],
    });
    expect(scores.answer_relevancy).toBeNull();
  });
});

describe("parseRelevancy", () => {
  it("reads a well-formed verdict", () => {
    expect(parseRelevancy('{"relevancy": 0.5, "reason": "partial"}')).toBe(0.5);
  });

  it("reads a fenced verdict", () => {
    expect(parseRelevancy('```json\n{"relevancy": 1}\n```')).toBe(1);
  });

  it("returns null — never a default — for junk, a missing field, or out of range", () => {
    expect(parseRelevancy("not json")).toBeNull();
    expect(parseRelevancy('{"reason": "nope"}')).toBeNull();
    expect(parseRelevancy('{"relevancy": 7}')).toBeNull();
    expect(parseRelevancy('{"relevancy": "high"}')).toBeNull();
  });
});

describe("ModelAnswerRelevancyScorer", () => {
  it("returns null without calling the provider when offline", async () => {
    const provider = fakeProvider('{"relevancy": 1}', true);
    const scorer = new ModelAnswerRelevancyScorer(provider);
    expect(await scorer.score("q", "a")).toBeNull();
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("frames question and answer as untrusted DATA in the prompt", async () => {
    const provider = fakeProvider('{"relevancy": 1}');
    await new ModelAnswerRelevancyScorer(provider).score("q", "a");
    const [messages] = (provider.chat as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [{ role: string; content: string }[]];
    expect(messages[0]?.content).toContain("UNTRUSTED DATA");
    expect(messages[1]?.content).toContain("=== QUESTION (untrusted data) ===");
    expect(messages[1]?.content).toContain("=== ANSWER TO GRADE (untrusted data) ===");
  });

  it("reports an unparseable provider reply as null, not as a mid-scale guess", async () => {
    const provider = fakeProvider("I think it's pretty relevant, honestly.");
    expect(await new ModelAnswerRelevancyScorer(provider).score("q", "a")).toBeNull();
    expect(provider.chat).toHaveBeenCalledOnce();
  });

  it("returns null without calling the provider for a blank question or answer", async () => {
    const provider = fakeProvider('{"relevancy": 1}');
    const scorer = new ModelAnswerRelevancyScorer(provider);
    expect(await scorer.score("   ", "a")).toBeNull();
    expect(await scorer.score("q", "   ")).toBeNull();
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("returns null rather than throwing when the provider call fails", async () => {
    const provider = fakeProvider("{}");
    (provider.chat as unknown as { mockRejectedValue: (e: Error) => void }).mockRejectedValue(
      new Error("429"),
    );
    expect(await new ModelAnswerRelevancyScorer(provider).score("q", "a")).toBeNull();
  });
});

describe("labelDrivenContextScores", () => {
  it("scores precision and recall from the span labels", () => {
    const s = labelDrivenContextScores({
      id: "x",
      question: "q",
      groundTruthContexts: ["alpha", "gamma"],
      expectedAnswerKeywords: [],
      retrievedChunks: ["... alpha ...", "unrelated"],
    });
    expect(s.context_precision).toBeCloseTo(0.5, 10);
    expect(s.context_recall).toBeCloseTo(0.5, 10);
  });

  it("returns null for a zero denominator instead of the old vacuous 1.0", () => {
    const s = labelDrivenContextScores({
      id: "x",
      question: "q",
      groundTruthContexts: [],
      expectedAnswerKeywords: [],
      retrievedChunks: [],
    });
    expect(s.context_precision).toBeNull();
    expect(s.context_recall).toBeNull();
  });
});
