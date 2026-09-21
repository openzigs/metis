/**
 * #1114 — the structured-verdict helper: retry once, then degrade to NO SIGNAL.
 *
 * These tests drive the helper through a scripted fake provider so every branch
 * (parse failure, schema failure, provider error, abort, capability probe) is
 * exercised deterministically. Provider PARITY — that the same script produces
 * the same outcome through the real `anthropic` and `copilot` adapters — is
 * asserted separately in `structured-verdict-provider-parity.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AIProvider, ChatMessage, ChatOptions, ChatResponse } from "../ai/types.js";
import {
  MAX_STRUCTURED_VERDICT_ATTEMPTS,
  StructuredVerdictMetrics,
  formatStructuredVerdictReport,
  hasVerdict,
  isNoSignal,
  requestStructuredVerdict,
  resetStructuredVerdictMetrics,
  structuredVerdictMetrics,
  type StructuredVerdictRequest,
} from "./structured-verdict.js";

const verdictSchema = z.object({
  supported: z.boolean(),
  rationale: z.string(),
});
type Verdict = z.infer<typeof verdictSchema>;

const VALID = JSON.stringify({ supported: true, rationale: "cited file backs the claim" });

/**
 * A provider that replays a scripted sequence of chat outcomes. A string is
 * returned as `content`; an Error is thrown from `chat()`.
 */
class ScriptedProvider implements AIProvider {
  readonly key = "offline-stub" as AIProvider["key"];
  readonly model = "test-model";
  readonly offline = true;
  readonly capabilities: AIProvider["capabilities"];
  readonly calls: Array<{ messages: ChatMessage[]; opts?: ChatOptions }> = [];
  private readonly script: Array<string | Error>;

  constructor(script: Array<string | Error>, responseFormat = false) {
    this.script = [...script];
    this.capabilities = { responseFormat, nativeToolCalls: false };
  }

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> {
    this.calls.push({ messages, opts });
    const next = this.script.shift();
    if (next === undefined) throw new Error("ScriptedProvider ran out of scripted responses");
    if (next instanceof Error) throw next;
    return {
      content: next,
      usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
      model: this.model,
      provider: this.key,
    };
  }

  async *stream(): AsyncGenerator<never> {
    throw new Error("not used");
  }
  async embed(): Promise<never> {
    throw new Error("not used");
  }
  async models(): Promise<string[]> {
    return [this.model];
  }
  async ping(): Promise<boolean> {
    return true;
  }
}

const makeRequest = (
  over: Partial<StructuredVerdictRequest<Verdict>> = {},
): StructuredVerdictRequest<Verdict> => ({
  label: "verifier-panel",
  schema: verdictSchema,
  schemaName: "LensVerdict",
  expectedShape: '{ "supported": boolean, "rationale": string }',
  messages: [{ role: "user", content: "Does the cited file back the claim?" }],
  ...over,
});

beforeEach(() => {
  resetStructuredVerdictMetrics();
});

describe("requestStructuredVerdict — happy path", () => {
  it("returns a verdict on the first attempt without re-prompting", async () => {
    const provider = new ScriptedProvider([VALID]);
    const metrics = new StructuredVerdictMetrics();

    const outcome = await requestStructuredVerdict(provider, makeRequest({ metrics }));

    expect(outcome.status).toBe("verdict");
    expect(hasVerdict(outcome)).toBe(true);
    if (!hasVerdict(outcome)) throw new Error("expected a verdict");
    expect(outcome.verdict).toEqual({ supported: true, rationale: "cited file backs the claim" });
    expect(outcome.attempts).toBe(1);
    expect(outcome.retried).toBe(false);
    expect(provider.calls).toHaveLength(1);

    const stats = metrics.snapshot("verifier-panel");
    expect(stats?.calls).toBe(1);
    expect(stats?.malformedAttempts).toBe(0);
    expect(stats?.retries).toBe(0);
    expect(stats?.malformationRate).toBe(0);
  });

  it("parses JSON the model wrapped in a Markdown fence", async () => {
    const provider = new ScriptedProvider(["Here you go:\n```json\n" + VALID + "\n```"]);
    const outcome = await requestStructuredVerdict(provider, makeRequest());
    expect(hasVerdict(outcome)).toBe(true);
  });

  it("sums token usage across attempts", async () => {
    const provider = new ScriptedProvider(["not json", VALID]);
    const outcome = await requestStructuredVerdict(provider, makeRequest());
    expect(outcome.usage.promptTokens).toBe(20);
    expect(outcome.usage.completionTokens).toBe(8);
    expect(outcome.usage.totalTokens).toBe(28);
  });
});

describe("requestStructuredVerdict — retry once", () => {
  it("re-prompts once after unparseable output and recovers", async () => {
    const provider = new ScriptedProvider(["I think it is supported, honestly.", VALID]);
    const metrics = new StructuredVerdictMetrics();

    const outcome = await requestStructuredVerdict(provider, makeRequest({ metrics }));

    expect(hasVerdict(outcome)).toBe(true);
    expect(outcome.attempts).toBe(2);
    expect(outcome.retried).toBe(true);
    expect(provider.calls).toHaveLength(2);

    const stats = metrics.snapshot("verifier-panel");
    expect(stats?.retries).toBe(1);
    expect(stats?.retrySuccesses).toBe(1);
    expect(stats?.malformedAttempts).toBe(1);
    expect(stats?.noSignal).toBe(0);
    expect(stats?.retryRate).toBe(1);
    expect(stats?.malformationRate).toBe(0.5);
  });

  it("re-prompts with the parse error, the expected shape and the model's own output", async () => {
    const provider = new ScriptedProvider(["I think it is supported, honestly.", VALID]);
    await requestStructuredVerdict(provider, makeRequest());

    const retryMessages = provider.calls[1]!.messages;
    // The original turn is preserved…
    expect(retryMessages[0]).toEqual({
      role: "user",
      content: "Does the cited file back the claim?",
    });
    // …followed by the model's own (bad) turn and a repair instruction.
    const assistantTurn = retryMessages.at(-2)!;
    expect(assistantTurn.role).toBe("assistant");
    expect(String(assistantTurn.content)).toContain("I think it is supported, honestly.");

    const repair = String(retryMessages.at(-1)!.content);
    expect(retryMessages.at(-1)!.role).toBe("user");
    expect(repair).toContain("could not be parsed");
    expect(repair).toContain("LensVerdict");
    expect(repair).toContain('{ "supported": boolean, "rationale": string }');
  });

  it("re-prompts when the JSON parses but fails the schema, and recovers", async () => {
    const provider = new ScriptedProvider([JSON.stringify({ supported: "yes" }), VALID]);
    const metrics = new StructuredVerdictMetrics();

    const outcome = await requestStructuredVerdict(provider, makeRequest({ metrics }));

    expect(hasVerdict(outcome)).toBe(true);
    expect(outcome.attempts).toBe(2);
    expect(metrics.snapshot("verifier-panel")?.retrySuccesses).toBe(1);
  });

  it("never re-prompts more than once", async () => {
    const provider = new ScriptedProvider(["nope", "still nope", VALID]);
    const outcome = await requestStructuredVerdict(provider, makeRequest());
    expect(provider.calls).toHaveLength(MAX_STRUCTURED_VERDICT_ATTEMPTS);
    expect(provider.calls).toHaveLength(2);
    expect(isNoSignal(outcome)).toBe(true);
  });

  it("truncates a huge malformed body before echoing it back to the model", async () => {
    const provider = new ScriptedProvider(["x".repeat(10_000), VALID]);
    await requestStructuredVerdict(provider, makeRequest());
    const assistantTurn = String(provider.calls[1]!.messages.at(-2)!.content);
    expect(assistantTurn.length).toBeLessThan(3_000);
    expect(assistantTurn).toContain("truncated");
  });
});

describe("requestStructuredVerdict — degrade to no signal", () => {
  it("returns no-signal (never a negative verdict) after two unparseable attempts", async () => {
    const provider = new ScriptedProvider(["nope", "still nope"]);
    const metrics = new StructuredVerdictMetrics();

    const outcome = await requestStructuredVerdict(provider, makeRequest({ metrics }));

    expect(outcome.status).toBe("no-signal");
    expect(isNoSignal(outcome)).toBe(true);
    expect(hasVerdict(outcome)).toBe(false);
    if (!isNoSignal(outcome)) throw new Error("expected no signal");
    expect(outcome.reason).toBe("unparseable");
    expect(outcome.detail).toBeTruthy();
    expect(outcome.attempts).toBe(2);
    expect(outcome.retried).toBe(true);
    // The degraded outcome carries NO verdict field at all — a consumer cannot
    // read `false` out of it, by construction.
    expect("verdict" in outcome).toBe(false);

    const stats = metrics.snapshot("verifier-panel");
    expect(stats?.noSignal).toBe(1);
    expect(stats?.noSignalRate).toBe(1);
    expect(stats?.retrySuccesses).toBe(0);
    expect(stats?.retrySuccessRate).toBe(0);
  });

  it("reports schema-invalid when both attempts parse but neither validates", async () => {
    const provider = new ScriptedProvider([
      JSON.stringify({ supported: "yes" }),
      JSON.stringify({ rationale: 7 }),
    ]);
    const outcome = await requestStructuredVerdict(provider, makeRequest());
    expect(isNoSignal(outcome)).toBe(true);
    if (!isNoSignal(outcome)) throw new Error("expected no signal");
    expect(outcome.reason).toBe("schema-invalid");
  });

  it("treats an empty response as no signal", async () => {
    const provider = new ScriptedProvider(["", "   "]);
    const outcome = await requestStructuredVerdict(provider, makeRequest());
    expect(isNoSignal(outcome)).toBe(true);
    if (!isNoSignal(outcome)) throw new Error("expected no signal");
    expect(outcome.reason).toBe("empty-response");
  });

  it("degrades on a provider error without re-prompting or failing the run", async () => {
    const provider = new ScriptedProvider([new Error("upstream 503")]);
    const metrics = new StructuredVerdictMetrics();

    const outcome = await requestStructuredVerdict(provider, makeRequest({ metrics }));

    expect(isNoSignal(outcome)).toBe(true);
    if (!isNoSignal(outcome)) throw new Error("expected no signal");
    expect(outcome.reason).toBe("provider-error");
    expect(outcome.detail).toContain("upstream 503");
    expect(outcome.retried).toBe(false);
    expect(provider.calls).toHaveLength(1);

    const stats = metrics.snapshot("verifier-panel");
    expect(stats?.providerErrors).toBe(1);
    expect(stats?.retries).toBe(0);
  });
});

describe("requestStructuredVerdict — cancellation", () => {
  it("rethrows an abort rather than laundering it into a no-signal verdict", async () => {
    const provider = new ScriptedProvider([new DOMException("Aborted", "AbortError")]);
    await expect(requestStructuredVerdict(provider, makeRequest())).rejects.toThrow(/Abort/i);
  });

  it("does not call the provider when the signal is already aborted", async () => {
    const provider = new ScriptedProvider([VALID]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      requestStructuredVerdict(provider, makeRequest({ signal: controller.signal })),
    ).rejects.toThrow();
    expect(provider.calls).toHaveLength(0);
  });
});

describe("requestStructuredVerdict — opportunistic responseFormat", () => {
  const responseFormat = {
    type: "json_schema" as const,
    json_schema: { name: "LensVerdict", schema: { type: "object" } },
  };

  it("forwards responseFormat when the provider declares support", async () => {
    const provider = new ScriptedProvider([VALID], true);
    const outcome = await requestStructuredVerdict(provider, makeRequest({ responseFormat }));
    expect(provider.calls[0]!.opts?.responseFormat).toEqual(responseFormat);
    expect(outcome.usedResponseFormat).toBe(true);
  });

  it("omits responseFormat entirely when the provider does not declare support", async () => {
    const provider = new ScriptedProvider([VALID], false);
    const outcome = await requestStructuredVerdict(provider, makeRequest({ responseFormat }));
    expect(provider.calls[0]!.opts?.responseFormat).toBeUndefined();
    expect(outcome.usedResponseFormat).toBe(false);
  });

  it("omits responseFormat when the caller supplied none, even on a supporting provider", async () => {
    const provider = new ScriptedProvider([VALID], true);
    const outcome = await requestStructuredVerdict(provider, makeRequest());
    expect(provider.calls[0]!.opts?.responseFormat).toBeUndefined();
    expect(outcome.usedResponseFormat).toBe(false);
  });

  it("reads support through the capability probe, so an undeclared provider is unsupported", async () => {
    const provider = new ScriptedProvider([VALID], true);
    // An adapter that declares nothing supports nothing (#1115).
    (provider as { capabilities?: unknown }).capabilities = undefined;
    const outcome = await requestStructuredVerdict(provider, makeRequest({ responseFormat }));
    expect(provider.calls[0]!.opts?.responseFormat).toBeUndefined();
    expect(outcome.usedResponseFormat).toBe(false);
  });

  it("forwards the caller's chat options (model, system message, budget, callType)", async () => {
    const provider = new ScriptedProvider([VALID]);
    await requestStructuredVerdict(
      provider,
      makeRequest({
        model: "claude-haiku-4-5",
        systemMessage: "You are a verifier.",
        maxTokens: 512,
        callType: "grounding",
      }),
    );
    const opts = provider.calls[0]!.opts;
    expect(opts?.model).toBe("claude-haiku-4-5");
    expect(opts?.systemMessage).toBe("You are a verifier.");
    expect(opts?.maxTokens).toBe(512);
    expect(opts?.callType).toBe("grounding");
  });
});

describe("StructuredVerdictMetrics", () => {
  it("keeps labels in separate buckets and returns undefined for an unseen one", async () => {
    const metrics = new StructuredVerdictMetrics();
    await requestStructuredVerdict(
      new ScriptedProvider([VALID]),
      makeRequest({ metrics, label: "reachability" }),
    );
    await requestStructuredVerdict(
      new ScriptedProvider(["bad", "worse"]),
      makeRequest({ metrics, label: "impact" }),
    );

    expect(metrics.snapshot("reachability")?.noSignal).toBe(0);
    expect(metrics.snapshot("impact")?.noSignal).toBe(1);
    expect(metrics.snapshot("defenses")).toBeUndefined();
    expect(metrics.allSnapshots()).toHaveLength(2);
  });

  it("aggregates every label into one total the A5 harness can print", async () => {
    const metrics = new StructuredVerdictMetrics();
    await requestStructuredVerdict(
      new ScriptedProvider([VALID]),
      makeRequest({ metrics, label: "reachability" }),
    );
    await requestStructuredVerdict(
      new ScriptedProvider(["bad", VALID]),
      makeRequest({ metrics, label: "impact" }),
    );
    await requestStructuredVerdict(
      new ScriptedProvider(["bad", "worse"]),
      makeRequest({ metrics, label: "defenses" }),
    );

    const totals = metrics.totals();
    expect(totals.label).toBe("all");
    expect(totals.calls).toBe(3);
    expect(totals.attempts).toBe(5);
    expect(totals.malformedAttempts).toBe(3);
    expect(totals.retries).toBe(2);
    expect(totals.retrySuccesses).toBe(1);
    expect(totals.noSignal).toBe(1);
    expect(totals.malformationRate).toBeCloseTo(3 / 5);
    expect(totals.retryRate).toBeCloseTo(2 / 3);
    expect(totals.retrySuccessRate).toBeCloseTo(0.5);
    expect(totals.noSignalRate).toBeCloseTo(1 / 3);
  });

  it("reports zeroed rates rather than NaN before anything is recorded", () => {
    const totals = new StructuredVerdictMetrics().totals();
    expect(totals.calls).toBe(0);
    expect(totals.malformationRate).toBe(0);
    expect(totals.retryRate).toBe(0);
    expect(totals.retrySuccessRate).toBe(0);
    expect(totals.noSignalRate).toBe(0);
  });

  it("counts responseFormat use so the harness can attribute malformation to the mechanism", async () => {
    const metrics = new StructuredVerdictMetrics();
    const responseFormat = {
      type: "json_schema" as const,
      json_schema: { name: "LensVerdict", schema: { type: "object" } },
    };
    await requestStructuredVerdict(
      new ScriptedProvider([VALID], true),
      makeRequest({ metrics, responseFormat }),
    );
    await requestStructuredVerdict(new ScriptedProvider([VALID], false), makeRequest({ metrics }));
    expect(metrics.snapshot("verifier-panel")?.responseFormatCalls).toBe(1);
    expect(metrics.snapshot("verifier-panel")?.calls).toBe(2);
  });

  it("resets", async () => {
    const metrics = new StructuredVerdictMetrics();
    await requestStructuredVerdict(new ScriptedProvider([VALID]), makeRequest({ metrics }));
    metrics.reset();
    expect(metrics.allSnapshots()).toEqual([]);
    expect(metrics.totals().calls).toBe(0);
  });

  it("defaults to the process-wide singleton when the caller injects none", async () => {
    await requestStructuredVerdict(new ScriptedProvider([VALID]), makeRequest());
    expect(structuredVerdictMetrics.snapshot("verifier-panel")?.calls).toBe(1);
    resetStructuredVerdictMetrics();
    expect(structuredVerdictMetrics.totals().calls).toBe(0);
  });
});

describe("formatStructuredVerdictReport", () => {
  it("renders a per-label table plus a total line", async () => {
    const metrics = new StructuredVerdictMetrics();
    await requestStructuredVerdict(
      new ScriptedProvider(["bad", VALID]),
      makeRequest({ metrics, label: "reachability" }),
    );
    const report = formatStructuredVerdictReport(metrics);
    expect(report).toContain("reachability");
    expect(report).toContain("malformation");
    expect(report).toContain("50.0%");
    expect(report).toContain("all");
  });

  it("says so plainly when no verdict calls were made", () => {
    expect(formatStructuredVerdictReport(new StructuredVerdictMetrics())).toContain(
      "no structured-verdict calls",
    );
  });
});

describe("outcome guards", () => {
  it("hasVerdict and isNoSignal partition the union", async () => {
    const ok = await requestStructuredVerdict(new ScriptedProvider([VALID]), makeRequest());
    const degraded = await requestStructuredVerdict(
      new ScriptedProvider(["a", "b"]),
      makeRequest(),
    );
    for (const outcome of [ok, degraded]) {
      expect(hasVerdict(outcome)).toBe(!isNoSignal(outcome));
    }
  });
});

describe("observability", () => {
  it("logs the retry and the degrade so the rate is visible without metrics wiring", async () => {
    vi.resetModules();
    const warn = vi.fn();
    vi.doMock("../logger.js", () => ({
      createChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }),
    }));
    const mod = await import("./structured-verdict.js");
    await mod.requestStructuredVerdict(
      new ScriptedProvider(["bad", "worse"]) as unknown as AIProvider,
      makeRequest() as never,
    );
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => /re-prompt/i.test(m))).toBe(true);
    expect(messages.some((m) => /no signal/i.test(m))).toBe(true);
    vi.doUnmock("../logger.js");
    vi.resetModules();
  });
});
