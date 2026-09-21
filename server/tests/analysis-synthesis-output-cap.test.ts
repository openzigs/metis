/**
 * #1223 — synthesis degraded to its deterministic fallback with
 * `reason: non-json` on essentially every multi-agent run.
 *
 * **The measured cause.** `runSynthesis` called `provider.chat` with no
 * `maxTokens`, so the request inherited the provider's own default. On the
 * configured `anthropic` provider that default is 16,000
 * (`DEFAULT_MAX_TOKENS` in `anthropic-provider.ts`) — a number that *looks*
 * generous and is not, because `claude-sonnet-5` spends a large and highly
 * variable share of the SAME output budget on thinking tokens before it emits
 * a character of JSON. Measured over five live calls on a real 26-finding
 * table (~11.3k input tokens):
 *
 * | run | `stop_reason` | output tokens | of which thinking |
 * |-----|---------------|---------------|-------------------|
 * | 1   | `max_tokens`  | 16,000 (cap)  | —                 |
 * | 2   | `end_turn`    | 10,812        | 5,088             |
 * | 3   | `end_turn`    | 13,504        | 7,708             |
 * | 4   | `end_turn`    | 14,724        | 8,308             |
 * | 5   | `max_tokens`  | 16,000 (cap)  | 9,763             |
 *
 * The JSON itself is only ~5–6k tokens. Thinking ran 5,088–9,763, so the run
 * sits ON the 16,000 boundary and crosses it whenever the model thinks harder —
 * which is why the failure reads as "every run" rather than "an edge case".
 * Two of five truncated outright; the three that survived cleared the cap by as
 * little as 1,276 tokens.
 *
 * **The trap this file exists to avoid.** The stub providers used everywhere
 * else in the suite have no output cap at all, so a missing `maxTokens` passes
 * every behavioural test ever written against them. These tests therefore
 * assert on the ARGUMENT handed to `provider.chat`, never on what comes back.
 */
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetConfigSingleton } from "../src/lib/config/config-service.js";
import type { AIProvider, ChatMessage, ChatOptions, ChatResponse } from "../src/lib/ai/types.js";
import {
  ANTHROPIC_NONSTREAMING_MAX_OUTPUT_TOKENS,
  DEFAULT_SYNTHESIS_MAX_OUTPUT_TOKENS,
  resolveSynthesisMaxOutputTokens,
  runSynthesis,
  type FlatFinding,
} from "../src/lib/analysis/synthesis.js";

const finding = (overrides: Partial<FlatFinding> = {}): FlatFinding => ({
  agentKey: "document",
  category: "other",
  severity: "info",
  title: "Audit log retention",
  body: "Logs are not retained.",
  tags: ["audit"],
  citations: [],
  ...overrides,
});

const response = (content: string, finishReason?: string): ChatResponse => ({
  content,
  usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
  model: "stub",
  provider: "offline-stub",
  ...(finishReason ? { finishReason } : {}),
});

/**
 * A provider that records every `ChatOptions` it is handed. The recording — not
 * the reply — is the subject of every assertion below.
 */
function recordingProvider(reply: (call: number) => ChatResponse): {
  provider: AIProvider;
  calls: ChatOptions[];
} {
  const calls: ChatOptions[] = [];
  const provider = {
    key: "offline-stub",
    model: "stub",
    offline: true,
    chat: vi.fn(async (_messages: ChatMessage[], opts: ChatOptions = {}) => {
      calls.push(opts);
      return reply(calls.length);
    }),
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn(async () => ["stub"]),
    ping: vi.fn(async () => true),
  } as unknown as AIProvider;
  return { provider, calls };
}

// A healthy reply. It must carry at least one requirement: synthesis treats
// "zero requirements from a populated finding set" as its own degradation.
const VALID = JSON.stringify({
  summary: "ok",
  requirements: [
    {
      type: "feature",
      title: "Retain audit logs",
      body: "Retain audit logs for 30 days.",
      priority: "high",
      labels: ["audit"],
      evidenceFindingIndexes: [0],
    },
  ],
});

describe("#1223 synthesis output cap", () => {
  beforeEach(() => {
    delete process.env.ANALYSIS_SYNTHESIS_MAX_OUTPUT_TOKENS;
    __resetConfigSingleton();
  });

  afterEach(() => {
    delete process.env.ANALYSIS_SYNTHESIS_MAX_OUTPUT_TOKENS;
    __resetConfigSingleton();
  });

  it("sends an EXPLICIT maxTokens on every synthesis attempt", async () => {
    // Reply with unparseable text so both attempts run: the cap must be on the
    // retry too, or the retry reproduces the truncation that caused it.
    const { provider, calls } = recordingProvider(() => response("not json at all"));
    await runSynthesis(provider, { projectName: "Acme", findings: [finding()] });

    expect(calls.length).toBe(2);
    for (const opts of calls) {
      expect(
        opts.maxTokens,
        "synthesis inherited the provider's defaultMaxTokens — the #1223 defect",
      ).toBe(resolveSynthesisMaxOutputTokens());
    }
  });

  it("honours ANALYSIS_SYNTHESIS_MAX_OUTPUT_TOKENS so a smaller-ceiling model can be served", async () => {
    process.env.ANALYSIS_SYNTHESIS_MAX_OUTPUT_TOKENS = "8192";
    __resetConfigSingleton();
    const { provider, calls } = recordingProvider(() => response(VALID));
    await runSynthesis(provider, { projectName: "Acme", findings: [finding()] });
    expect(calls[0]!.maxTokens).toBe(8192);
  });

  it("defaults ABOVE the Anthropic provider default that was measured truncating", () => {
    // 16,000 is `DEFAULT_MAX_TOKENS` in `anthropic-provider.ts` — the value
    // synthesis inherited, and the value two of five live runs hit exactly.
    // A default at or below it would leave #1223 unfixed while looking fixed.
    expect(DEFAULT_SYNTHESIS_MAX_OUTPUT_TOKENS).toBeGreaterThan(16_000);
  });

  it("defaults at or below the Anthropic SDK's own non-streaming ceiling", () => {
    // Oracle, not a restatement: ask the installed SDK directly. `chat()` posts
    // a NON-streaming request, and the SDK throws client-side — before any
    // network call — for a `max_tokens` implying over ten minutes of work. Ask
    // for more and synthesis does not merely degrade, it fails outright.
    const client = new Anthropic({ apiKey: "test-key-not-used" });
    expect(() =>
      client.calculateNonstreamingTimeout(DEFAULT_SYNTHESIS_MAX_OUTPUT_TOKENS),
    ).not.toThrow();
    expect(() =>
      client.calculateNonstreamingTimeout(ANTHROPIC_NONSTREAMING_MAX_OUTPUT_TOKENS),
    ).not.toThrow();
    expect(
      () => client.calculateNonstreamingTimeout(ANTHROPIC_NONSTREAMING_MAX_OUTPUT_TOKENS + 1),
      "the SDK's non-streaming ceiling moved — re-derive ANTHROPIC_NONSTREAMING_MAX_OUTPUT_TOKENS",
    ).toThrow(/Streaming is required/);
  });
});

describe("#1223 synthesis degradation is diagnosable", () => {
  beforeEach(() => {
    delete process.env.ANALYSIS_SYNTHESIS_MAX_OUTPUT_TOKENS;
    __resetConfigSingleton();
  });

  it("names an output-cap truncation in the persisted degradation detail", async () => {
    // A payload cut off mid-JSON, exactly as the live 16,000-token runs arrived.
    const truncated = '```json\n{"summary": "ok", "requirements": [{"title": "Audit lo';
    const { provider } = recordingProvider(() => response(truncated, "max_tokens"));
    const result = await runSynthesis(provider, { projectName: "Acme", findings: [finding()] });

    expect(result.degraded?.reason).toBe("non-json");
    expect(result.degraded?.detail).toContain("finishReason=max_tokens");
    expect(result.degraded?.detail).toContain("output-cap truncation");
  });

  it("recognises the OpenAI-compatible spelling of the same stop signal", async () => {
    const { provider } = recordingProvider(() => response("{oops", "length"));
    const result = await runSynthesis(provider, { projectName: "Acme", findings: [finding()] });
    expect(result.degraded?.detail).toContain("finishReason=length");
    expect(result.degraded?.detail).toContain("output-cap truncation");
  });

  it("reports finishReason=unknown rather than claiming truncation without evidence", async () => {
    // A provider that reports no stop signal is absence of evidence, never
    // evidence of absence — and never evidence of a cap hit either.
    const { provider } = recordingProvider(() => response("definitely not json"));
    const result = await runSynthesis(provider, { projectName: "Acme", findings: [finding()] });
    expect(result.degraded?.detail).toContain("finishReason=unknown");
    expect(result.degraded?.detail).not.toContain("output-cap truncation");
  });

  it("keeps the parser's own message in the detail alongside the stop signal", async () => {
    const { provider } = recordingProvider(() => response('{"summary": ', "max_tokens"));
    const result = await runSynthesis(provider, { projectName: "Acme", findings: [finding()] });
    // Both hypotheses stay legible: what the provider said, and what broke.
    expect(result.degraded?.detail).toMatch(/finishReason=max_tokens.*:/s);
    expect(result.degraded?.detail!.length).toBeGreaterThan("finishReason=max_tokens".length + 5);
  });

  it("leaves a healthy run undegraded and still capped", async () => {
    const { provider, calls } = recordingProvider(() => response(VALID));
    const result = await runSynthesis(provider, { projectName: "Acme", findings: [finding()] });
    expect(result.degraded).toBeUndefined();
    expect(calls[0]!.maxTokens).toBe(DEFAULT_SYNTHESIS_MAX_OUTPUT_TOKENS);
  });
});
