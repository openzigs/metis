/**
 * #2189 — the models the cost estimate prices are the ones a run would call:
 * resolved through the same provider builders, under the keys usage is
 * recorded under.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIConfig } from "../ai/config.js";
import type { AIProvider } from "../ai/types.js";

const buildProviderMock = vi.fn(
  (args: { config: AIConfig }) =>
    ({
      key: "anthropic",
      model: args.config.model,
      offline: false,
      chat: vi.fn(),
      stream: vi.fn(),
      embed: vi.fn(),
      models: vi.fn(),
      ping: vi.fn(),
    }) as unknown as AIProvider,
);
const loadAIConfigMock = vi.fn();
vi.mock("../ai/index.js", () => ({
  buildProvider: (args: { config: AIConfig }) => buildProviderMock(args),
  loadAIConfig: () => loadAIConfigMock(),
}));

const logged = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logger.js")>()),
  createChildLogger: () => logged,
}));

import { buildDocsGenProvider, resolveDocsGenCostInputs } from "./holistic-synthesizer.js";

const KEYS = [
  "ANTHROPIC_MODEL",
  "DOCS_GEN_ANTHROPIC_PHASE1_MODEL",
  "DOCS_GEN_ANTHROPIC_PHASE2_MODEL",
  "DOCS_GEN_ANTHROPIC_CLAIM_MODEL",
  "DOCS_GEN_ANTHROPIC_JUDGE_MODEL",
  "DOCS_GEN_GROUNDING_MODEL",
  "DOCS_GEN_CLAIM_MODEL",
  "DOCS_GEN_ANTHROPIC_FACTS_CHAR_CAP",
  "DOCS_GEN_HYBRID_ROUTING",
];

beforeEach(() => {
  for (const k of KEYS) vi.stubEnv(k, undefined as unknown as string);
  buildProviderMock.mockClear();
  for (const fn of Object.values(logged)) fn.mockClear();
  loadAIConfigMock.mockReturnValue({
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    offline: false,
    rateLimit: { windowMs: 1000, max: 1 },
    pingTimeoutMs: 1000,
  } satisfies AIConfig);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveDocsGenCostInputs (#2189)", () => {
  it("names each phase's model under the provider usage is recorded under", () => {
    vi.stubEnv("ANTHROPIC_MODEL", "claude-sonnet-5-5");
    vi.stubEnv("DOCS_GEN_ANTHROPIC_PHASE1_MODEL", "claude-haiku-5-5");
    vi.stubEnv("DOCS_GEN_ANTHROPIC_FACTS_CHAR_CAP", "90000");
    const inputs = resolveDocsGenCostInputs();
    expect(inputs.models).toEqual({
      phase1: { provider: "anthropic", model: "claude-haiku-5-5" },
      phase2: { provider: "anthropic", model: "claude-sonnet-5-5" },
      // The claim step defaults to Haiku 4.5; the judge stays on the Phase-2 model.
      claim: { provider: "anthropic", model: "claude-haiku-4-5" },
      judge: { provider: "anthropic", model: "claude-sonnet-5-5" },
    });
    expect(inputs.factsCharCap).toBe(90_000);
    expect(inputs.phase1FactsMaxOutputTokens).toBeGreaterThan(0);
  });

  it("logs the providers it resolves at debug, never as a generation starting (review nit)", () => {
    resolveDocsGenCostInputs();
    const loud = [...logged.info.mock.calls, ...logged.warn.mock.calls].map((c) => String(c[0]));
    expect(loud.filter((m) => /for docs-gen|falling back/.test(m))).toEqual([]);
    expect(logged.debug.mock.calls.map((c) => String(c[0]))).toContain(
      "Using native AnthropicProvider for docs-gen",
    );
    // A real run still says which provider it uses, at info.
    buildDocsGenProvider(1, 1024);
    expect(logged.info.mock.calls.map((c) => String(c[0]))).toContain(
      "Using native AnthropicProvider for docs-gen",
    );
  });
});
