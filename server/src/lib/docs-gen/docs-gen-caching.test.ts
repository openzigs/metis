/**
 * Doc-gen prompt-caching wiring (#anthropic-prompt-caching).
 *
 * Verifies that the docs-gen provider resolution turns prompt caching ON for the
 * native `anthropic` provider (so the generation + claim-extraction +
 * faithfulness-judge calls all request `cache_control`) and leaves it OFF for
 * providers that do not support it. The AI factory + config are mocked so no
 * real provider is constructed and no network call is made.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AIConfig } from "../ai/config.js";
import type { AIProvider } from "../ai/types.js";

// A throwaway provider stub returned by the mocked factory.
const fakeProvider = {
  key: "anthropic",
  model: "claude-sonnet-4-6",
  offline: false,
  chat: vi.fn(),
  stream: vi.fn(),
  embed: vi.fn(),
  models: vi.fn(),
  ping: vi.fn(),
} as unknown as AIProvider;

const buildProviderMock = vi.fn(() => fakeProvider);
const loadAIConfigMock = vi.fn();

vi.mock("../ai/index.js", () => ({
  buildProvider: (...args: unknown[]) => buildProviderMock(...args),
  loadAIConfig: () => loadAIConfigMock(),
}));

// Import AFTER the mock so the module binds to it.
import { buildDocsGenProvider, docsGenTuning } from "./holistic-synthesizer.js";

function configFor(provider: AIConfig["provider"]): AIConfig {
  return {
    provider,
    model: "claude-sonnet-4-6",
    offline: false,
    rateLimit: { windowMs: 1000, max: 1 },
    pingTimeoutMs: 1000,
  };
}

beforeEach(() => {
  buildProviderMock.mockClear();
  loadAIConfigMock.mockReset();
});

describe("docsGenTuning supportsCaching by provider kind", () => {
  it("enables caching for anthropic", () => {
    expect(docsGenTuning("anthropic", "claude-sonnet-4-6").supportsCaching).toBe(true);
  });

  it("enables caching for bedrock", () => {
    expect(docsGenTuning("bedrock", "us.anthropic.claude-sonnet-4-6").supportsCaching).toBe(true);
  });

  it("disables caching for local", () => {
    expect(docsGenTuning("local", "gemma4:12b").supportsCaching).toBe(false);
  });

  it("pins a BARE Claude model id for anthropic (never the Bedrock us.* form)", () => {
    const tuning = docsGenTuning("anthropic", "ignored");
    expect(tuning.phase1Model).toBe("claude-sonnet-4-6");
    expect(tuning.phase2Model).toBe("claude-sonnet-4-6");
    expect(tuning.phase1Model.startsWith("us.")).toBe(false);
  });
});

describe("docsGenTuning claim/judge model routing", () => {
  // These env vars steer model resolution; snapshot + clear so the host
  // environment (a developer's .env) can't leak into the assertions.
  const KEYS = [
    "DOCS_GEN_GROUNDING_MODEL",
    "DOCS_GEN_CLAIM_MODEL",
    "DOCS_GEN_ANTHROPIC_CLAIM_MODEL",
    "DOCS_GEN_ANTHROPIC_JUDGE_MODEL",
    "DOCS_GEN_BEDROCK_CLAIM_MODEL",
    "DOCS_GEN_BEDROCK_JUDGE_MODEL",
    "DOCS_GEN_LOCAL_CLAIM_MODEL",
    "DOCS_GEN_LOCAL_JUDGE_MODEL",
    "DOCS_GEN_LOCAL_PHASE2_MODEL",
    "LOCAL_GEMMA_MODEL",
    "ANTHROPIC_MODEL",
    "BEDROCK_MODEL",
  ] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("anthropic: claim extraction defaults to Haiku, judge STAYS on Sonnet", () => {
    const tuning = docsGenTuning("anthropic", "ignored");
    expect(tuning.claimModel).toBe("claude-haiku-4-5");
    expect(tuning.judgeModel).toBe("claude-sonnet-4-6");
    expect(tuning.judgeModel).toBe(tuning.phase2Model);
  });

  it("anthropic: the shared DOCS_GEN_GROUNDING_MODEL downshifts ONLY claim extraction, never the judge", () => {
    process.env.DOCS_GEN_GROUNDING_MODEL = "claude-haiku-4-5";
    const tuning = docsGenTuning("anthropic", "ignored");
    expect(tuning.claimModel).toBe("claude-haiku-4-5");
    // The judge must remain on Sonnet even when the shared knob is set.
    expect(tuning.judgeModel).toBe("claude-sonnet-4-6");
  });

  it("anthropic: claim + judge each honor their dedicated override", () => {
    process.env.DOCS_GEN_ANTHROPIC_CLAIM_MODEL = "claude-sonnet-4-6";
    process.env.DOCS_GEN_ANTHROPIC_JUDGE_MODEL = "claude-opus-4-8";
    const tuning = docsGenTuning("anthropic", "ignored");
    expect(tuning.claimModel).toBe("claude-sonnet-4-6");
    expect(tuning.judgeModel).toBe("claude-opus-4-8");
  });

  it("#701 anthropic: DOCS_GEN_CLAIM_MODEL flips claim extraction; unset keeps Haiku (default)", () => {
    // Default (key unset) — no behaviour change.
    expect(docsGenTuning("anthropic", "ignored").claimModel).toBe("claude-haiku-4-5");
    // Flip via the cross-provider config key.
    process.env.DOCS_GEN_CLAIM_MODEL = "claude-sonnet-4-6";
    const flipped = docsGenTuning("anthropic", "ignored");
    expect(flipped.claimModel).toBe("claude-sonnet-4-6");
    // Judge is untouched by the flip.
    expect(flipped.judgeModel).toBe("claude-sonnet-4-6");
  });

  it("#701 the provider-specific claim override wins over the cross-provider DOCS_GEN_CLAIM_MODEL", () => {
    process.env.DOCS_GEN_CLAIM_MODEL = "claude-sonnet-4-6";
    process.env.DOCS_GEN_ANTHROPIC_CLAIM_MODEL = "claude-opus-4-8";
    expect(docsGenTuning("anthropic", "ignored").claimModel).toBe("claude-opus-4-8");
  });

  it("#701 bedrock: DOCS_GEN_CLAIM_MODEL flips claim extraction only", () => {
    process.env.DOCS_GEN_CLAIM_MODEL = "us.anthropic.claude-haiku-4-5";
    const tuning = docsGenTuning("bedrock", "us.anthropic.claude-sonnet-4-6");
    expect(tuning.claimModel).toBe("us.anthropic.claude-haiku-4-5");
    expect(tuning.judgeModel).toBe("us.anthropic.claude-sonnet-4-6");
  });

  it("#701 local ignores DOCS_GEN_CLAIM_MODEL (no second model to serve)", () => {
    process.env.DOCS_GEN_CLAIM_MODEL = "claude-sonnet-4-6";
    expect(docsGenTuning("local", "qwen2.5:14b").claimModel).toBe("qwen2.5:14b");
  });

  it("local: both claim + judge reuse the local phase-2 model (no second model to serve)", () => {
    const tuning = docsGenTuning("local", "qwen2.5:14b");
    expect(tuning.claimModel).toBe("qwen2.5:14b");
    expect(tuning.judgeModel).toBe("qwen2.5:14b");
    expect(tuning.judgeModel).toBe(tuning.phase2Model);
  });

  it("bedrock: judge stays on the Bedrock Sonnet model; claim is overridable", () => {
    const tuning = docsGenTuning("bedrock", "us.anthropic.claude-sonnet-4-6");
    expect(tuning.claimModel).toBe("us.anthropic.claude-sonnet-4-6");
    expect(tuning.judgeModel).toBe("us.anthropic.claude-sonnet-4-6");
    process.env.DOCS_GEN_BEDROCK_CLAIM_MODEL = "us.anthropic.claude-haiku-4-5";
    const overridden = docsGenTuning("bedrock", "us.anthropic.claude-sonnet-4-6");
    expect(overridden.claimModel).toBe("us.anthropic.claude-haiku-4-5");
    expect(overridden.judgeModel).toBe("us.anthropic.claude-sonnet-4-6");
  });
});

describe("buildDocsGenProvider — anthropic provider", () => {
  it("resolves supportsCaching=true for the native anthropic provider", () => {
    loadAIConfigMock.mockReturnValue(configFor("anthropic"));
    const resolved = buildDocsGenProvider(2, 8192);
    expect(resolved.supportsCaching).toBe(true);
    expect(resolved.provider).toBe(fakeProvider);
    // The factory was asked to build a provider (the native AnthropicProvider).
    expect(buildProviderMock).toHaveBeenCalledTimes(1);
  });

  it("passes the per-phase model through to the factory config", () => {
    loadAIConfigMock.mockReturnValue(configFor("anthropic"));
    buildDocsGenProvider(1, 4096);
    const arg = buildProviderMock.mock.calls[0][0] as { config: AIConfig };
    expect(arg.config.provider).toBe("anthropic");
    expect(arg.config.model).toBe("claude-sonnet-4-6");
  });
});

describe("buildDocsGenProvider — non-caching fallback", () => {
  it("resolves supportsCaching=false when no gateway is configured (copilot fallback)", () => {
    // A non-anthropic, non-local provider with no Bedrock gateway env falls
    // through to the default buildProvider path with caching OFF.
    const prev = {
      url: process.env.BEDROCK_GATEWAY_URL,
      url2: process.env.BEDROCK_GATEWAY_BASE_URL,
    };
    delete process.env.BEDROCK_GATEWAY_URL;
    delete process.env.BEDROCK_GATEWAY_BASE_URL;
    try {
      loadAIConfigMock.mockReturnValue(configFor("copilot-native"));
      const resolved = buildDocsGenProvider(2, 8192);
      expect(resolved.supportsCaching).toBe(false);
    } finally {
      if (prev.url !== undefined) process.env.BEDROCK_GATEWAY_URL = prev.url;
      if (prev.url2 !== undefined) process.env.BEDROCK_GATEWAY_BASE_URL = prev.url2;
    }
  });
});
