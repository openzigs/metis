/**
 * #1224 — "reasoning off" on models that cannot take `thinking: {type: "disabled"}`.
 *
 * The SDK is replaced by a fake that ANSWERS like the API: it applies the
 * per-model thinking table from Anthropic's "Troubleshooting thinking" page
 * (https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting,
 * read 2026-10-19) and DeepSeek's documented Anthropic-format toggle
 * (https://api-docs.deepseek.com/guides/thinking_mode), and throws the
 * recorded 400 text for a configuration that model rejects. No network call
 * is made; the fixture rows below are the recorded contract.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { createSpy, logWarnSpy } = vi.hoisted(() => ({
  createSpy: vi.fn(),
  logWarnSpy: vi.fn(),
}));

vi.mock("../../logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logger.js")>();
  return {
    ...actual,
    createChildLogger: (name: string) =>
      name === "ai-anthropic"
        ? { warn: logWarnSpy, debug: vi.fn(), info: vi.fn(), error: vi.fn() }
        : actual.createChildLogger(name),
  };
});

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: createSpy, stream: vi.fn() };
    models = { list: vi.fn() };
    constructor(_opts: unknown) {
      /* no network */
    }
  }
  return { default: FakeAnthropic };
});

import { AnthropicProvider } from "./anthropic-provider.js";
import { resolveReasoningSetting } from "../../docs-gen/docs-gen-reasoning.js";
import type { ConfigService } from "../../config/config-service.js";
import {
  generationFailureMessage,
  GENERATION_FAILED_MESSAGE,
} from "../../docs-gen/generation-failure-message.js";

/** The recorded 400 bodies (verbatim message text from the troubleshooting page). */
const RECORDED_400 = {
  disabledAlwaysOn:
    '"thinking.type.disabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.',
  disabledSonnet55:
    'To turn thinking off on this model, send "thinking": {"type": "between_tools"} instead of {"type": "disabled"}. The model does not think before responding. The short updates it writes between tool calls come back as thinking blocks.',
  betweenTools: '"thinking.type.between_tools" is not supported for this model.',
  enabled:
    '"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.',
};

/** The SDK's `BadRequestError` shape: `status` 400 and `400 {json}` as message. */
function badRequest(message: string): Error {
  const err = new Error(
    `400 ${JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } })}`,
  );
  err.name = "BadRequestError";
  (err as Error & { status: number }).status = 400;
  return err;
}

type Endpoint = "anthropic" | "deepseek";

/** What the endpoint does with one request body — the recorded behaviour. */
function answer(endpoint: Endpoint, body: Record<string, unknown>): unknown {
  const model = String(body.model);
  const thinking = (body.thinking as { type?: string } | undefined)?.type;
  const effort = (body.output_config as { effort?: string } | undefined)?.effort;
  if (endpoint === "deepseek") {
    if (thinking !== undefined && thinking !== "enabled" && thinking !== "disabled") {
      throw badRequest(`thinking.type: unknown variant \`${thinking}\``);
    }
  } else if (model === "claude-sonnet-5-5") {
    if (thinking === "disabled") throw badRequest(RECORDED_400.disabledSonnet55);
    if (thinking === "enabled") throw badRequest(RECORDED_400.enabled);
    if (thinking === "between_tools" && (effort === "xhigh" || effort === "max")) {
      throw badRequest(
        `output_config.effort '${effort}' is not supported when thinking is disabled on this model. Use effort 'high' or below, or enable thinking.`,
      );
    }
  } else if (/^claude-(?:opus-5-5|fable-|mythos-)/.test(model)) {
    if (thinking === "disabled") throw badRequest(RECORDED_400.disabledAlwaysOn);
    if (thinking === "enabled") throw badRequest(RECORDED_400.enabled);
    if (thinking === "between_tools") throw badRequest(RECORDED_400.betweenTools);
  } else if (model === "claude-haiku-5-5") {
    if (thinking === "enabled") throw badRequest(RECORDED_400.enabled);
    if (thinking === "between_tools") throw badRequest(RECORDED_400.betweenTools);
    if (thinking === "disabled" && (effort === "xhigh" || effort === "max")) {
      throw badRequest(
        `output_config.effort '${effort}' is not supported when thinking is disabled on this model. Use effort 'high' or below, or enable thinking.`,
      );
    }
  } else if (thinking === "between_tools") {
    throw badRequest(RECORDED_400.betweenTools);
  }
  return {
    content: [{ type: "text", text: "ok" }],
    model,
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 2 },
  };
}

function providerFor(endpoint: Endpoint, model: string): AnthropicProvider {
  createSpy.mockImplementation(async (body: Record<string, unknown>) => answer(endpoint, body));
  return new AnthropicProvider({
    apiKey: "test-key",
    model,
    ...(endpoint === "deepseek" ? { baseUrl: "https://api.deepseek.com/anthropic" } : {}),
  });
}

/** The docs-gen setting value → the per-call options, through the real resolver. */
function optionsFor(setting: "off" | "provider-default" | "low", model: string) {
  const config = { get: () => setting } as unknown as ConfigService;
  return resolveReasoningSetting("DOCS_GEN_PHASE1_REASONING", model, config, {});
}

function lastBody(): Record<string, unknown> {
  return createSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

const messages = [{ role: "user" as const, content: "extract the facts" }];

beforeEach(() => {
  createSpy.mockReset();
  logWarnSpy.mockReset();
});

describe("reasoning setting x model fixtures (#1224)", () => {
  // [endpoint, model, setting, expected thinking field, expected effort]
  const rows: Array<[Endpoint, string, "off" | "provider-default" | "low", unknown, unknown]> = [
    ["anthropic", "claude-sonnet-5-5", "off", { type: "between_tools" }, undefined],
    ["anthropic", "claude-sonnet-5-5", "provider-default", undefined, undefined],
    ["anthropic", "claude-sonnet-5-5", "low", { type: "adaptive" }, "low"],
    ["anthropic", "claude-haiku-5-5", "off", { type: "disabled" }, undefined],
    ["anthropic", "claude-haiku-5-5", "provider-default", undefined, undefined],
    ["anthropic", "claude-haiku-5-5", "low", { type: "adaptive" }, "low"],
    ["deepseek", "deepseek-v4-pro", "off", { type: "disabled" }, undefined],
    ["deepseek", "deepseek-v4-pro", "provider-default", undefined, undefined],
    ["deepseek", "deepseek-v4-pro", "low", { type: "enabled" }, "low"],
    // Always-on models: no way to turn thinking off — omit it, lowest effort.
    ["anthropic", "claude-opus-5-5", "off", undefined, "low"],
    ["anthropic", "claude-fable-5", "off", undefined, "low"],
    // Models that accept `disabled` keep sending it.
    ["anthropic", "claude-sonnet-5", "off", { type: "disabled" }, undefined],
    ["anthropic", "claude-opus-4-8", "off", { type: "disabled" }, undefined],
  ];

  it.each(rows)(
    "%s %s with reasoning %s is accepted",
    async (endpoint, model, setting, thinking, effort) => {
      const p = providerFor(endpoint, model);
      const res = await p.chat(messages, optionsFor(setting, model));
      expect(res.content).toBe("ok");
      const body = lastBody();
      if (thinking === undefined) expect(body).not.toHaveProperty("thinking");
      else expect(body.thinking).toEqual(thinking);
      expect((body.output_config as { effort?: string } | undefined)?.effort).toBe(effort);
    },
  );

  it("recognises the Sonnet 5.5 id in its regional and dated spellings", async () => {
    for (const model of [
      "us.anthropic.claude-sonnet-5-5",
      "global.anthropic.claude-sonnet-5-5",
      "claude-sonnet-5-5-20261001",
      "claude-sonnet-5-5[1m]",
    ]) {
      createSpy.mockResolvedValue(answer("anthropic", { model: "x" }));
      await new AnthropicProvider({ apiKey: "k", model }).chat(messages, {
        disableThinking: true,
      });
      expect(lastBody().thinking, model).toEqual({ type: "between_tools" });
    }
  });

  it("does not mistake Sonnet 5 for Sonnet 5.5", async () => {
    const p = providerFor("anthropic", "claude-sonnet-5");
    await p.chat(messages, { disableThinking: true });
    expect(lastBody().thinking).toEqual({ type: "disabled" });
  });

  it("logs the adjustment once per model, not once per call", async () => {
    const p = providerFor("anthropic", "claude-sonnet-5-5");
    await p.chat(messages, { disableThinking: true });
    await p.chat(messages, { disableThinking: true });
    await p.chat(messages, { disableThinking: true, model: "claude-opus-5-5" });
    const adjusted = logWarnSpy.mock.calls.filter(([msg]) => String(msg).includes("reasoning off"));
    expect(adjusted).toHaveLength(2);
    expect(adjusted[0][1]).toMatchObject({ model: "claude-sonnet-5-5", sent: "between_tools" });
    expect(adjusted[1][1]).toMatchObject({ model: "claude-opus-5-5", sent: "omitted" });
  });

  it("does not log for a model that takes disabled as sent", async () => {
    const p = providerFor("anthropic", "claude-haiku-5-5");
    await p.chat(messages, { disableThinking: true });
    expect(logWarnSpy.mock.calls.filter(([m]) => String(m).includes("reasoning off"))).toEqual([]);
  });
});

describe("a rejected reasoning setting reads in plain words (#1224)", () => {
  it("names the setting `off` for the recorded Sonnet 5.5 400", async () => {
    // Before the fix this is exactly what every call threw; the classifier
    // must still recognise it (an operator on an older model id, a new model).
    createSpy.mockRejectedValue(badRequest(RECORDED_400.disabledSonnet55));
    const err = await new AnthropicProvider({ apiKey: "k", model: "claude-sonnet-5-5" })
      .chat(messages, {})
      .catch((e: unknown) => e);
    const message = generationFailureMessage(err);
    expect(message).not.toBe(GENERATION_FAILED_MESSAGE);
    expect(message).toContain('rejected the reasoning setting "off"');
    expect(message).toContain("provider-default");
  });

  it("names the setting `off` for the always-on 400", () => {
    const message = generationFailureMessage(badRequest(RECORDED_400.disabledAlwaysOn));
    expect(message).toContain('rejected the reasoning setting "off"');
  });

  it("names the effort for an effort-level 400", () => {
    const message = generationFailureMessage(
      badRequest(
        "output_config.effort 'xhigh' is not supported when thinking is disabled on this model. Use effort 'high' or below, or enable thinking.",
      ),
    );
    expect(message).toContain('rejected the reasoning setting "xhigh"');
  });

  it("is a fixed sentence: re-classifying it returns it unchanged", () => {
    const message = generationFailureMessage(badRequest(RECORDED_400.disabledSonnet55));
    expect(generationFailureMessage(message)).toBe(message);
  });

  it("leaves an unrelated 400 about thinking blocks alone", () => {
    const message = generationFailureMessage(
      badRequest(
        "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.",
      ),
    );
    expect(message).toBe(GENERATION_FAILED_MESSAGE);
  });

  it("does not fire on a non-400 that mentions thinking", () => {
    const err = new Error('"thinking.type.disabled" is not supported for this model.');
    (err as Error & { status: number }).status = 500;
    expect(generationFailureMessage(err)).toBe(GENERATION_FAILED_MESSAGE);
  });
});
