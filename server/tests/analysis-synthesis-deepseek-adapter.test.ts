/**
 * #751 — the walkthrough configuration, end to end through the REAL adapter.
 *
 * #706 run 3 ran `AI_PROVIDER=anthropic` with
 * `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` and
 * `ANTHROPIC_MODEL=deepseek-flash`. On that path two facts decide the outcome,
 * and a hand-rolled provider double would hide both:
 *
 *   1. `AnthropicProvider.chat()` clamps every request to the SDK's
 *      non-streaming 21,333 (#1257), so no cap setting can make room; and
 *   2. DeepSeek's reply carries a `thinking` block drawn from that same cap and
 *      `stop_reason: "max_tokens"`, which the adapter must surface as
 *      `finishReason` for synthesis to recognise the truncation.
 *
 * So the SDK is mocked and nothing else: the message envelope is the recorded
 * DeepSeek fixture's own (`fixtures/llm/provider-contract/deepseek`), and the
 * content and stop reason come from the thinking-budget simulator. The
 * recorded fixtures are contract-scenario recordings, not synthesis runs, so
 * they supply the wire shape rather than the payload.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createSpy } = vi.hoisted(() => ({ createSpy: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: createSpy, stream: vi.fn() };
    models = { list: vi.fn(async () => ({ data: [] })) };
    constructor(_opts: unknown) {
      /* no network */
    }
  }
  return { default: FakeAnthropic };
});

import { AnthropicProvider } from "../src/lib/ai/providers/anthropic-provider.js";
import { ANTHROPIC_NONSTREAMING_MAX_OUTPUT_TOKENS } from "../src/lib/ai/nonstreaming-output-bound.js";
import { __resetConfigSingleton } from "../src/lib/config/config-service.js";
import { runSynthesis, type FlatFinding } from "../src/lib/analysis/synthesis.js";
import { simulateThinkingReply } from "./helpers/thinking-budget-simulator.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const recorded = JSON.parse(
  readFileSync(
    path.join(here, "fixtures/llm/provider-contract/deepseek/structured-output.json"),
    "utf8",
  ),
) as { exchanges: Array<{ response: { json: Record<string, unknown> } }> };
const ENVELOPE = recorded.exchanges[0]!.response.json;

const textOf = (v: unknown): string =>
  typeof v === "string"
    ? v
    : Array.isArray(v)
      ? v.map((b) => (b as { text?: string }).text ?? "").join("")
      : "";

beforeEach(() => {
  process.env.ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
  delete process.env.ANALYSIS_SYNTHESIS_MAX_OUTPUT_TOKENS;
  __resetConfigSingleton();
  createSpy.mockReset();
  createSpy.mockImplementation(async (params: Record<string, unknown>) => {
    const system = textOf(params.system);
    const user = (params.messages as Array<{ content: unknown }>)
      .map((m) => textOf(m.content))
      .join("\n");
    const r = simulateThinkingReply(system, user, params.max_tokens as number);
    return {
      ...ENVELOPE,
      model: "deepseek-flash",
      content: [
        { type: "thinking", thinking: "…", signature: "" },
        ...(r.content ? [{ type: "text", text: r.content }] : []),
      ],
      stop_reason: r.finishReason,
      usage: {
        ...(ENVELOPE.usage as Record<string, unknown>),
        input_tokens: r.inputTokens,
        output_tokens: r.outputTokens,
      },
    };
  });
});

afterEach(() => {
  delete process.env.ANTHROPIC_BASE_URL;
  __resetConfigSingleton();
});

describe("#751 synthesis on DeepSeek through the real AnthropicProvider", () => {
  it("recovers a 58-finding table that truncates at the SDK-bounded cap", async () => {
    const provider = new AnthropicProvider({
      apiKey: "test",
      baseUrl: "https://api.deepseek.com/anthropic",
      model: "deepseek-flash",
    });
    const findings: FlatFinding[] = Array.from({ length: 58 }, (_, i) => ({
      agentKey: "code",
      category: i % 4 < 2 ? "security" : "functional",
      severity: "medium",
      title: `Miniflux finding ${i}`,
      body: `Body ${i}`,
      tags: [],
      citations: [],
    })) as FlatFinding[];

    const result = await runSynthesis(provider, { projectName: "Miniflux", findings });

    const sent = createSpy.mock.calls.map((c) => (c[0] as { max_tokens: number }).max_tokens);
    expect(sent.length).toBeGreaterThan(1);
    // The grown default for a thinking model is held at the SDK bound — no
    // request the SDK would refuse client-side.
    expect(sent.every((n) => n === ANTHROPIC_NONSTREAMING_MAX_OUTPUT_TOKENS)).toBe(true);
    // The first reply really was cut off by the cap …
    const first = await createSpy.mock.results[0]!.value;
    expect(first.stop_reason).toBe("max_tokens");
    // … and synthesis recovered instead of degrading.
    expect(result.degraded).toBeUndefined();
    const reqs = result.output.requirements;
    expect(new Set(reqs.flatMap((r) => r.evidenceFindingIndexes)).size).toBe(58);
    expect(reqs.filter((r) => r.type === "bug").length).toBeGreaterThan(0);
    expect(reqs.filter((r) => r.type === "feature").length).toBeGreaterThan(0);
    expect(reqs.every((r) => r.acceptanceCriteria.length > 0)).toBe(true);
  });
});
