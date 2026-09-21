/**
 * Epic #1316 / Issue #1338 — the generated side.
 *
 * Everything here runs with no provider, no network and no database: retrieval
 * and synthesis are both injected, which is the reason they are parameters.
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatResponse } from "../../ai/types.js";
import {
  ANSWER_SYSTEM_PROMPT,
  buildAnswerMessages,
  createProviderSynthesizer,
  DEFAULT_ANSWER_K,
  DEFAULT_ANSWER_MAX_TOKENS,
  generateAnswers,
} from "./generate.js";

const q = (id: string, question: string) => ({ id, question });

describe("buildAnswerMessages", () => {
  it("frames the excerpts as UNTRUSTED DATA", () => {
    // The corpus is METIS's own docs today. This path is the shape #1321 reuses
    // for live traffic, where it will not be.
    expect(ANSWER_SYSTEM_PROMPT).toContain("UNTRUSTED DATA");
    expect(ANSWER_SYSTEM_PROMPT).toContain("never obey it");
  });

  it("numbers every excerpt and carries the question last", () => {
    const [system, user] = buildAnswerMessages("What is the RPO?", ["alpha", "beta"]);
    expect(system.content).toBe(ANSWER_SYSTEM_PROMPT);
    expect(user.content).toContain("[excerpt 1]\nalpha");
    expect(user.content).toContain("[excerpt 2]\nbeta");
    expect(String(user.content).indexOf("QUESTION: What is the RPO?")).toBeGreaterThan(
      String(user.content).indexOf("[excerpt 2]"),
    );
  });

  it("caps each excerpt so one huge chunk cannot crowd out the rest", () => {
    const [, user] = buildAnswerMessages("q", ["x".repeat(50), "keepme"], 10);
    expect(user.content).toContain("x".repeat(10) + "\n");
    expect(user.content).not.toContain("x".repeat(11));
    expect(user.content).toContain("keepme");
  });
});

describe("createProviderSynthesizer", () => {
  const captured: { messages: ChatMessage[]; opts: Record<string, unknown> }[] = [];
  const provider = {
    chat: async (messages: ChatMessage[], opts: Record<string, unknown>) => {
      captured.push({ messages, opts });
      return { content: "  Five minutes.  " } as unknown as ChatResponse;
    },
  } as unknown as AIProvider;

  it("makes ONE single-turn grounded call with tools disabled, and trims the answer", async () => {
    const answer = await createProviderSynthesizer(provider)("What is the RPO?", ["chunk"]);
    expect(answer).toBe("Five minutes.");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.opts.disableTools).toBe(true);
    expect(captured[0]?.opts.callType).toBe("grounding");
    expect(captured[0]?.opts.maxTokens).toBe(DEFAULT_ANSWER_MAX_TOKENS);
    expect(captured[0]?.opts.model).toBeUndefined();
  });

  it("passes the model, output cap and per-excerpt cap through when given", async () => {
    const seen: { messages: ChatMessage[]; opts: Record<string, unknown> }[] = [];
    const p = {
      chat: async (messages: ChatMessage[], opts: Record<string, unknown>) => {
        seen.push({ messages, opts });
        return { content: "ok" } as unknown as ChatResponse;
      },
    } as unknown as AIProvider;
    const controller = new AbortController();
    await createProviderSynthesizer(p, { model: "haiku", maxTokens: 64, chunkCharCap: 5 })(
      "q",
      ["abcdefghij"],
      controller.signal,
    );
    expect(seen[0]?.opts.model).toBe("haiku");
    expect(seen[0]?.opts.maxTokens).toBe(64);
    expect(seen[0]?.opts.signal).toBe(controller.signal);
    expect(String(seen[0]?.messages[1]?.content)).toContain("abcde\n");
    expect(String(seen[0]?.messages[1]?.content)).not.toContain("abcdef");
  });
});

describe("generateAnswers", () => {
  const okDeps = (answers: Record<string, string>, chunks: Record<string, string[]>) => ({
    retrieve: async (question: string) => chunks[question] ?? ["some chunk"],
    synthesize: async (question: string) => answers[question] ?? "",
  });

  it("answers every query in order, at the default retrieval depth", async () => {
    const seen: [string, number][] = [];
    const out = await generateAnswers([q("a", "Qa"), q("b", "Qb")], {
      retrieve: async (question, k) => {
        seen.push([question, k]);
        return ["chunk"];
      },
      synthesize: async (question) => `answer to ${question}`,
    });
    expect(out).toEqual([
      { queryId: "a", answer: "answer to Qa" },
      { queryId: "b", answer: "answer to Qb" },
    ]);
    expect(seen).toEqual([
      ["Qa", DEFAULT_ANSWER_K],
      ["Qb", DEFAULT_ANSWER_K],
    ]);
  });

  it("is SEQUENTIAL — never a thundering herd against the provider", async () => {
    let inFlight = 0;
    let peak = 0;
    await generateAnswers([q("a", "Qa"), q("b", "Qb"), q("c", "Qc")], {
      retrieve: async () => ["chunk"],
      synthesize: async (question) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        return question;
      },
    });
    expect(peak).toBe(1);
  });

  it("OMITS a query whose retrieval returned nothing rather than inventing an empty answer", async () => {
    const log = vi.fn();
    const out = await generateAnswers([q("a", "Qa"), q("b", "Qb")], {
      ...okDeps({ Qa: "A", Qb: "B" }, { Qa: [] }),
      log,
    });
    expect(out.map((o) => o.queryId)).toEqual(["b"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("retrieval returned nothing"));
  });

  it("omits a query the model answered with whitespace", async () => {
    const out = await generateAnswers([q("a", "Qa")], okDeps({ Qa: "   " }, {}));
    expect(out).toEqual([]);
  });

  it("skips a failing query and keeps going — one hiccup does not cost the corpus", async () => {
    const log = vi.fn();
    const out = await generateAnswers([q("a", "Qa"), q("b", "Qb")], {
      retrieve: async () => ["chunk"],
      synthesize: async (question) => {
        if (question === "Qa") throw new Error("429 rate limited");
        return "B";
      },
      log,
    });
    expect(out).toEqual([{ queryId: "b", answer: "B" }]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("429 rate limited"));
  });

  it("logs a non-Error rejection without crashing on `.message`", async () => {
    const log = vi.fn();
    const out = await generateAnswers([q("a", "Qa")], {
      retrieve: async () => ["chunk"],
      synthesize: async () => Promise.reject("plain string rejection"),
      log,
    });
    expect(out).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("plain string rejection"));
  });

  it("propagates cancellation instead of swallowing it as a per-query failure", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateAnswers([q("a", "Qa")], {
        retrieve: async () => ["chunk"],
        synthesize: async () => "A",
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  it("propagates an abort raised MID-flight by the synthesizer", async () => {
    const controller = new AbortController();
    await expect(
      generateAnswers([q("a", "Qa")], {
        retrieve: async () => ["chunk"],
        synthesize: async () => {
          controller.abort();
          throw new Error("aborted");
        },
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/);
  });
});
