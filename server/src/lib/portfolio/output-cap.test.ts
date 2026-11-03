/**
 * #1726 — the OUTPUT cap of a portfolio model call, and the one retry of a
 * reply the cap cut off.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AIProvider, ChatResponse } from "../ai/types.js";
import type { ConfigService } from "../config/config-service.js";
import { JsonLlmParseError } from "../ai/json-llm-client.js";
import {
  DEFAULT_PORTFOLIO_MAX_OUTPUT_TOKENS,
  PORTFOLIO_MAX_OUTPUT_TOKENS_KEY,
  callJsonLlmRetryingCutOff,
  isCutOffReply,
  resolvePortfolioMaxOutputTokens,
  retryMaxOutputTokens,
} from "./output-cap.js";

/** A config holding `values`, with the registry's schema for the knob. */
function config(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string) => values[key],
    getNumber: (key: string, fallback: number) =>
      values[key] === undefined ? fallback : Number(values[key]),
    getKeyDef: (key: string) =>
      key === PORTFOLIO_MAX_OUTPUT_TOKENS_KEY
        ? { schema: z.coerce.number().int().positive() }
        : undefined,
  } as unknown as ConfigService;
}

const openai = { key: "openai", model: "gpt-4.1" } as Pick<AIProvider, "key" | "model">;
const unknownModel = { key: "openai", model: "m" } as Pick<AIProvider, "key" | "model">;

function response(content: string, finishReason?: string): ChatResponse {
  return {
    content,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    model: "m",
    provider: "openai",
    ...(finishReason ? { finishReason } : {}),
  } as ChatResponse;
}

function scripted(...replies: ChatResponse[]) {
  const chat = vi.fn(async () => replies.shift() ?? response("{}"));
  return { provider: { key: "openai", model: "m", chat } as unknown as AIProvider, chat };
}

describe("resolvePortfolioMaxOutputTokens", () => {
  it("defaults to the synthesis call's 21,000, not the old 2,000", () => {
    expect(DEFAULT_PORTFOLIO_MAX_OUTPUT_TOKENS).toBe(21_000);
    expect(resolvePortfolioMaxOutputTokens(unknownModel, config())).toBe(21_000);
  });

  it("an operator's value is used as given", () => {
    const cfg = config({ [PORTFOLIO_MAX_OUTPUT_TOKENS_KEY]: "8000" });
    expect(resolvePortfolioMaxOutputTokens(unknownModel, cfg)).toBe(8_000);
    // Explicit: no reasoning allowance on top, even for a reasoning model.
    expect(resolvePortfolioMaxOutputTokens({ key: "openai", model: "deepseek-flash" }, cfg)).toBe(
      8_000,
    );
  });

  it("an unusable value falls back to the default", () => {
    for (const bad of ["0", "-5", "lots"]) {
      const cfg = config({ [PORTFOLIO_MAX_OUTPUT_TOKENS_KEY]: bad });
      expect(resolvePortfolioMaxOutputTokens(unknownModel, cfg)).toBe(21_000);
    }
  });

  it("a model that reasons by default gets the reasoning allowance on top of the default", () => {
    const cfg = config({ DOCS_GEN_REASONING_ALLOWANCE_TOKENS: "10000" });
    expect(resolvePortfolioMaxOutputTokens({ key: "openai", model: "deepseek-flash" }, cfg)).toBe(
      31_000,
    );
  });

  it("is held at the Anthropic SDK's non-streaming bound on the anthropic provider", () => {
    const cfg = config({ DOCS_GEN_REASONING_ALLOWANCE_TOKENS: "10000" });
    expect(
      resolvePortfolioMaxOutputTokens({ key: "anthropic", model: "deepseek-flash" }, cfg),
    ).toBe(21_333);
  });

  it("is clamped to a known model's output ceiling", () => {
    const cfg = config({ [PORTFOLIO_MAX_OUTPUT_TOKENS_KEY]: "500000" });
    expect(resolvePortfolioMaxOutputTokens(openai, cfg)).toBeLessThan(500_000);
  });
});

describe("retryMaxOutputTokens", () => {
  it("doubles the cap, held at the clamps, and never lowers it", () => {
    expect(retryMaxOutputTokens(21_000, unknownModel)).toBe(42_000);
    expect(retryMaxOutputTokens(21_000, { key: "anthropic", model: "m" })).toBe(21_333);
    expect(retryMaxOutputTokens(21_333, { key: "anthropic", model: "m" })).toBe(21_333);
  });
});

describe("callJsonLlmRetryingCutOff", () => {
  const input = { systemPrompt: "s", userPrompt: "u", maxTokens: 1_000 };

  it("returns a reply that parses, with one call", async () => {
    const { provider, chat } = scripted(response('{"ok":true}'));
    const out = await callJsonLlmRetryingCutOff<{ ok: boolean }>(provider, input);
    expect(out.parsed).toEqual({ ok: true });
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("retries an empty max_tokens reply once, at twice the cap", async () => {
    const { provider, chat } = scripted(response("", "max_tokens"), response('{"ok":true}'));
    const out = await callJsonLlmRetryingCutOff<{ ok: boolean }>(provider, input);
    expect(out.parsed).toEqual({ ok: true });
    expect(chat.mock.calls.map((c) => (c as unknown[])[1])).toEqual([
      expect.objectContaining({ maxTokens: 1_000 }),
      expect.objectContaining({ maxTokens: 2_000 }),
    ]);
  });

  it("does not retry when the clamps leave the cap unchanged: the same call would be charged for nothing", async () => {
    // DeepSeek through the Anthropic-compatible endpoint is provider key "anthropic":
    // the first call already sits at the SDK's non-streaming bound.
    const atBound = scripted(response("", "max_tokens"), response('{"ok":true}'));
    const provider = { ...atBound.provider, key: "anthropic", model: "deepseek-flash" };
    const mayRetry = vi.fn(() => true);
    await expect(
      callJsonLlmRetryingCutOff(provider as AIProvider, { ...input, maxTokens: 21_333 }, mayRetry),
    ).rejects.toBeInstanceOf(JsonLlmParseError);
    expect(atBound.chat).toHaveBeenCalledTimes(1);
    expect(mayRetry).not.toHaveBeenCalled();
  });

  it("a reply cut off mid-JSON (finishReason length) is retried too", async () => {
    const { provider, chat } = scripted(response('{"ok":', "length"), response('{"ok":true}'));
    await callJsonLlmRetryingCutOff(provider, input);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("throws the second failure: one retry, not more", async () => {
    const { provider, chat } = scripted(response("", "max_tokens"), response("", "max_tokens"));
    await expect(callJsonLlmRetryingCutOff(provider, input)).rejects.toBeInstanceOf(
      JsonLlmParseError,
    );
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("does not retry a reply that stopped on its own, or when the caller refuses", async () => {
    const stopped = scripted(response("no json here", "stop"));
    await expect(callJsonLlmRetryingCutOff(stopped.provider, input)).rejects.toThrow();
    expect(stopped.chat).toHaveBeenCalledTimes(1);

    const refused = scripted(response("", "max_tokens"));
    const mayRetry = vi.fn(() => false);
    await expect(callJsonLlmRetryingCutOff(refused.provider, input, mayRetry)).rejects.toThrow();
    expect(mayRetry).toHaveBeenCalledOnce();
    expect(refused.chat).toHaveBeenCalledTimes(1);
  });

  it("does not retry a provider error or an aborted call", async () => {
    const chat = vi.fn(async () => {
      throw new Error("provider 500");
    });
    const failing = { key: "openai", model: "m", chat } as unknown as AIProvider;
    await expect(callJsonLlmRetryingCutOff(failing, input)).rejects.toThrow("provider 500");
    expect(chat).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    controller.abort();
    const aborted = scripted(response("", "max_tokens"));
    await expect(
      callJsonLlmRetryingCutOff(aborted.provider, { ...input, signal: controller.signal }),
    ).rejects.toThrow();
    expect(aborted.chat).toHaveBeenCalledTimes(1);
  });

  it("isCutOffReply reads the finish reason of a parse failure only", () => {
    expect(isCutOffReply(new Error("x"))).toBe(false);
    expect(isCutOffReply(new JsonLlmParseError("x", "", response("", "max_tokens")))).toBe(true);
    expect(isCutOffReply(new JsonLlmParseError("x", "", response("", "stop")))).toBe(false);
  });
});
