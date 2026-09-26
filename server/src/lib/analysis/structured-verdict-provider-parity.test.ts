/**
 * #1114 acceptance criterion: "Works identically on `anthropic` and `copilot`
 * adapters — asserted by test, not assumed." #149 removed the Copilot adapter;
 * the parity is now pinned between the two Anthropic-client configurations —
 * the native endpoint (which honours `responseFormat`, #133) and DeepSeek's
 * Anthropic-compatible endpoint (which does not, so it takes the portable
 * parse-and-retry path).
 *
 * The point of this file is that the parity claim is made against the REAL
 * adapter class, not a hand-rolled double: the Anthropic SDK is `vi.mock`ed,
 * scripted with the same malformed / valid bodies, and driven through the same
 * table of cases.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// The Anthropic SDK is mocked so `new AnthropicProvider(...)` never dials out.
const createSpy = vi.fn();
const streamSpy = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: createSpy, stream: streamSpy };
    models = { list: vi.fn() };
    constructor(_opts: unknown) {
      /* no-op */
    }
  }
  return { default: FakeAnthropic };
});

import { AnthropicProvider } from "../ai/providers/anthropic-provider.js";
import { supportsResponseFormat } from "../ai/capabilities.js";
import type { AIProvider, JsonSchemaResponseFormat } from "../ai/types.js";
import {
  StructuredVerdictMetrics,
  hasVerdict,
  isNoSignal,
  requestStructuredVerdict,
  type StructuredVerdictRequest,
} from "./structured-verdict.js";

const verdictSchema = z.object({ supported: z.boolean(), rationale: z.string() });
type Verdict = z.infer<typeof verdictSchema>;

const VALID = JSON.stringify({ supported: true, rationale: "the cited file backs the claim" });
const PROSE = "Honestly? I'd say it holds up.";
const BAD_SHAPE = JSON.stringify({ supported: "probably" });

const RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: "json_schema",
  json_schema: { name: "LensVerdict", schema: { type: "object" } },
};

const makeRequest = (
  over: Partial<StructuredVerdictRequest<Verdict>> = {},
): StructuredVerdictRequest<Verdict> => ({
  label: "reachability",
  schema: verdictSchema,
  schemaName: "LensVerdict",
  expectedShape: '{ "supported": boolean, "rationale": string }',
  messages: [{ role: "user", content: "Is this finding reachable?" }],
  ...over,
});

// ── Anthropic SDK seam ─────────────────────────────────────────────────────

const scriptAnthropic = (script: string[]): void => {
  createSpy.mockReset();
  for (const body of script) {
    createSpy.mockResolvedValueOnce({
      content: [{ type: "text", text: body }],
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 10, output_tokens: 4 },
    });
  }
};

const makeAnthropic = (script: string[]): AIProvider => {
  scriptAnthropic(script);
  return new AnthropicProvider({ apiKey: "k", model: "claude-sonnet-4-6" });
};

/**
 * #133 — the native Anthropic endpoint now honours `responseFormat` (as
 * `output_config.format`), so the portable-path parity this file pins is run
 * against the Anthropic client configuration that still cannot: DeepSeek's
 * Anthropic-compatible endpoint (it accepts only `effort` in `output_config`).
 * The native endpoint's structured path is pinned separately below.
 */
const makeAnthropicPortable = (script: string[]): AIProvider => {
  scriptAnthropic(script);
  return new AnthropicProvider({
    apiKey: "k",
    model: "deepseek-v4-pro",
    baseUrl: "https://api.deepseek.com/anthropic",
  });
};

const ADAPTERS: Array<{ name: string; build: (script: string[]) => AIProvider }> = [
  { name: "anthropic (DeepSeek endpoint)", build: makeAnthropicPortable },
];

beforeEach(() => {
  createSpy.mockReset();
});

describe.each(ADAPTERS)("$name adapter — structured verdict parity", ({ build }) => {
  it("neither adapter declares responseFormat support, so the portable path is the only path", () => {
    expect(supportsResponseFormat(build([VALID]))).toBe(false);
  });

  it("returns a verdict on the first attempt", async () => {
    const metrics = new StructuredVerdictMetrics();
    const outcome = await requestStructuredVerdict(build([VALID]), makeRequest({ metrics }));

    expect(outcome.status).toBe("verdict");
    if (!hasVerdict(outcome)) throw new Error("expected a verdict");
    expect(outcome.verdict).toEqual({
      supported: true,
      rationale: "the cited file backs the claim",
    });
    expect(outcome.attempts).toBe(1);
    expect(outcome.retried).toBe(false);
    expect(metrics.snapshot("reachability")?.malformationRate).toBe(0);
  });

  it("recovers from prose via exactly one re-prompt", async () => {
    const metrics = new StructuredVerdictMetrics();
    const outcome = await requestStructuredVerdict(build([PROSE, VALID]), makeRequest({ metrics }));

    expect(outcome.status).toBe("verdict");
    expect(outcome.attempts).toBe(2);
    expect(outcome.retried).toBe(true);
    const stats = metrics.snapshot("reachability");
    expect(stats?.retries).toBe(1);
    expect(stats?.retrySuccesses).toBe(1);
    expect(stats?.malformationRate).toBe(0.5);
  });

  it("recovers from a schema violation via exactly one re-prompt", async () => {
    const outcome = await requestStructuredVerdict(build([BAD_SHAPE, VALID]), makeRequest());
    expect(outcome.status).toBe("verdict");
    expect(outcome.attempts).toBe(2);
  });

  it("degrades to no signal — never a negative verdict — after two malformed replies", async () => {
    const metrics = new StructuredVerdictMetrics();
    const outcome = await requestStructuredVerdict(
      build([PROSE, "still not JSON"]),
      makeRequest({ metrics }),
    );

    expect(outcome.status).toBe("no-signal");
    if (!isNoSignal(outcome)) throw new Error("expected no signal");
    expect(outcome.reason).toBe("unparseable");
    expect("verdict" in outcome).toBe(false);
    expect(outcome.attempts).toBe(2);
    expect(metrics.snapshot("reachability")?.noSignalRate).toBe(1);
  });

  it("does not fail the run when the panel makes many calls and some are malformed", async () => {
    const metrics = new StructuredVerdictMetrics();
    const scripts = [[VALID], [PROSE, VALID], [PROSE, "nope"], [VALID]];
    const outcomes = [];
    for (const script of scripts) {
      outcomes.push(await requestStructuredVerdict(build(script), makeRequest({ metrics })));
    }
    expect(outcomes.filter((o) => o.status === "verdict")).toHaveLength(3);
    expect(outcomes.filter((o) => o.status === "no-signal")).toHaveLength(1);
    const stats = metrics.snapshot("reachability");
    expect(stats?.calls).toBe(4);
    expect(stats?.attempts).toBe(6);
    expect(stats?.malformedAttempts).toBe(3);
    expect(stats?.noSignal).toBe(1);
  });

  it("never puts responseFormat on the wire, even when the caller supplies one", async () => {
    const outcome = await requestStructuredVerdict(
      build([VALID]),
      makeRequest({ responseFormat: RESPONSE_FORMAT }),
    );
    expect(outcome.usedResponseFormat).toBe(false);
    expect(outcome.status).toBe("verdict");
  });
});

describe("anthropic adapter (native endpoint) — structured output (#133)", () => {
  it("declares responseFormat support and sends it as output_config.format", async () => {
    const provider = makeAnthropic([VALID]);
    expect(supportsResponseFormat(provider)).toBe(true);
    const outcome = await requestStructuredVerdict(
      provider,
      makeRequest({ responseFormat: RESPONSE_FORMAT }),
    );
    expect(outcome.usedResponseFormat).toBe(true);
    expect(outcome.status).toBe("verdict");
    const body = createSpy.mock.calls[0]![0] as { output_config?: { format?: unknown } };
    expect(body.output_config?.format).toEqual({
      type: "json_schema",
      // Fitted to the Messages API subset by the SDK's transformJSONSchema.
      schema: { type: "object", properties: {}, additionalProperties: false },
    });
  });

  it("still recovers from prose through the parse-and-retry path", async () => {
    const outcome = await requestStructuredVerdict(
      makeAnthropic([PROSE, VALID]),
      makeRequest({ responseFormat: RESPONSE_FORMAT }),
    );
    expect(outcome.status).toBe("verdict");
    expect(outcome.attempts).toBe(2);
  });
});

describe("anthropic adapter — request-level assertions", () => {
  it("sends the repair turns (bad output + parse error + expected shape) on the retry", async () => {
    const provider = makeAnthropic([PROSE, VALID]);
    await requestStructuredVerdict(provider, makeRequest());

    expect(createSpy).toHaveBeenCalledTimes(2);
    const retryBody = createSpy.mock.calls[1]![0] as {
      messages: Array<{ role: string; content: unknown }>;
      response_format?: unknown;
    };
    expect(retryBody.response_format).toBeUndefined();
    const rendered = JSON.stringify(retryBody.messages);
    expect(rendered).toContain(PROSE);
    expect(rendered).toContain("LensVerdict");
    expect(rendered).toContain("could not be parsed");
  });

  it("degrades rather than throwing when the SDK call itself fails", async () => {
    createSpy.mockReset();
    createSpy.mockRejectedValue(new Error("anthropic 529 overloaded"));
    const provider = new AnthropicProvider({ apiKey: "k", model: "claude-sonnet-4-6" });

    const outcome = await requestStructuredVerdict(provider, makeRequest());

    expect(outcome.status).toBe("no-signal");
    if (!isNoSignal(outcome)) throw new Error("expected no signal");
    expect(outcome.reason).toBe("provider-error");
    // One attempt only: a transport failure is not malformation.
    expect(createSpy).toHaveBeenCalledTimes(1);
  });
});

describe("cross-adapter equivalence", () => {
  const CASES: Array<{ name: string; script: string[]; status: string; attempts: number }> = [
    { name: "clean", script: [VALID], status: "verdict", attempts: 1 },
    { name: "prose then valid", script: [PROSE, VALID], status: "verdict", attempts: 2 },
    { name: "bad shape then valid", script: [BAD_SHAPE, VALID], status: "verdict", attempts: 2 },
    { name: "prose twice", script: [PROSE, PROSE], status: "no-signal", attempts: 2 },
    { name: "bad shape twice", script: [BAD_SHAPE, BAD_SHAPE], status: "no-signal", attempts: 2 },
  ];

  it.each(CASES)(
    "$name yields the same outcome on the native and the DeepSeek endpoint",
    async (testCase) => {
      const anthropic = await requestStructuredVerdict(
        makeAnthropic([...testCase.script]),
        makeRequest({ metrics: new StructuredVerdictMetrics() }),
      );
      const portable = await requestStructuredVerdict(
        makeAnthropicPortable([...testCase.script]),
        makeRequest({ metrics: new StructuredVerdictMetrics() }),
      );

      expect(anthropic.status).toBe(testCase.status);
      expect(portable.status).toBe(anthropic.status);
      expect(anthropic.attempts).toBe(testCase.attempts);
      expect(portable.attempts).toBe(anthropic.attempts);
      expect(portable.retried).toBe(anthropic.retried);
      if (isNoSignal(anthropic) && isNoSignal(portable)) {
        expect(portable.reason).toBe(anthropic.reason);
      }
      if (hasVerdict(anthropic) && hasVerdict(portable)) {
        expect(portable.verdict).toEqual(anthropic.verdict);
      }
    },
  );
});
